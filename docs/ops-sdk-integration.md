# Operator APIs & the SDK

How the operator control surfaces connect to what a viewer app built on the
[SDK](sdk.md) actually observes. The wire-level reference for every endpoint
(request/response bodies, auth, schemas) is [Reference](reference.md); this page is
the **integration map**: which surface changes what, and when the SDK sees it.

---

## 1. The three control surfaces

| Surface | Transport | Default bind | Auth | Who uses it |
|---|---|---|---|---|
| **Panel admin API + dashboard** | HTTP/JSON | `127.0.0.1:3210` (`ADMIN_ENABLED=1`) | Admin login → panel-signed Bearer token (Argon2id verifiers in panel-private `secrets/admins.json`) | Operators: accounts, grants, catalog curation, publishers, sources, categories |
| **Broadcaster control API + UI** | HTTP/JSON | `127.0.0.1:3310` (`CONTROL_ENABLED=1`) | Control login → broadcaster-local Bearer token | Operators: channels, ingest, transcode, start/stop/rotate, logs, incidents. Plus **unauthenticated `GET /healthz`** for monitoring |
| **Panel RPC** | DHT (Hyperswarm), not TCP/HTTP | reachable by key, worldwide | Proof-of-work + per-method crypto (OPRF login; Ed25519 for `register`) | **The SDK** (`hello`/`login`/`session`) and **broadcasters** (`register`) |

Two deliberate consequences:

- Both HTTP surfaces bind loopback — exposing one is a TLS-fronting decision
  ([public dashboards](kb/public-dashboards.md)), and *neither is ever needed by a
  viewer*: the SDK has no HTTP dependency on your infrastructure at all.
- The SDK's only inbound path is the DHT RPC plus **replication** of two signed
  data structures (next section). Everything an operator does reaches viewers
  *through* those, never directly.

## 2. The data plane the SDK replicates

1. **The signed catalog DB** (Hyperbee) — accounts (verifiers, sealed keys,
   devices), catalog records (`catalog/<streamId>`), category presentation
   (`catmeta/`), assets metadata. Single writer: the panel. Every connected SDK
   replicates it and **watches the `catalog/` range** — this is the push channel
   that makes admin edits live.
2. **The assets drive** (Hyperdrive) — poster/backdrop/logo bytes, served to the
   app from the SDK's localhost server (`assetUrl()`), or passed through verbatim
   when the catalog stores an absolute `https` URL (hybrid art).

Stream media itself travels on per-channel encrypted Hyperdrives (feeds) whose
current `feedKey` lives in the catalog record; the per-user **encryption** keys are
sealed to each user at grant time and unsealed only inside `login()`.

## 3. The three latencies

Every operator action lands in exactly one of these buckets — knowing which is the
whole integration model:

| Bucket | Mechanism | Typical delay |
|---|---|---|
| **Live push** | catalog watch → `streams` event re-emit (or `feed-changed` for the active stream) | ~seconds — no polling, no re-login, no re-tune |
| **Next tune** | value is read at `resolve()` time | whenever the viewer next zaps to the channel |
| **Next login** | value is baked into the login reply (entitlements, sealed keys) | next `login()` call |

## 4. Panel admin API → SDK effects

Endpoint inventory is authoritative in [Reference](reference.md); here mapped to
viewer-visible effect:

### Accounts & entitlements

| Operator action | Endpoint(s) | SDK effect | Bucket |
|---|---|---|---|
| Create user | `POST /api/users` | Account can `login()` | — |
| Grant a stream | `POST /api/users/:u/grants` | Stream appears in the display list **with its sealed key** | **Next login** |
| Revoke a grant | `DELETE /api/users/:u/grants/:streamId` | Stream gone from the next login's list. An already-running session still holds the unsealed key in memory — see [§8](#8-what-revocation-really-means) | Next login |
| Disable / delete user | `POST /api/users/:u/status`, `DELETE /api/users/:u` | Next `login()` rejected; existing offline tokens age out (`checkSession` expiry) | Next login |
| Password / logout-all / max-devices | `POST /api/users/:u/password` · `/logout-all` · `/max-devices` | `tokenVersion` bump → the SDK's **online** check (`sessionLive`) fails → a well-behaved app drops to login | Live-ish (next online check) |
| Revoke ONE device | `DELETE /api/users/:u/devices/:deviceId` | Deliberately does **not** bump `tokenVersion`: only `sessionLive` on that device notices → that device re-logins, others untouched | Live-ish (next online check) |

### Catalog & curation

| Operator action | Endpoint(s) | SDK effect | Bucket |
|---|---|---|---|
| Edit title / description / category | `PATCH /api/streams/:id` | `streams` re-emits with new metadata | **Live push** |
| Curation: `order`, `featured` | `PATCH /api/streams/:id` | `streams` re-emits; rails/hero re-sort (`order` also defines the zap ring + `prewarm` priority) | **Live push** |
| Upload art | `POST /api/streams/:id/art/:kind` | `streams` re-emits with new localhost art URLs (P2P) or the record's absolute URL (hybrid art passthrough) | **Live push** |
| Flip `isLive` | `PATCH /api/streams/:id` (usually done by the broadcaster for you) | `streams` re-emits — live badge | **Live push** |
| Set/clear a **redirect URL** | `PATCH /api/streams/:id` `{url}` | `resolve()` returns the URL verbatim (`source:'cdn'`) — an edit reaches viewers on their **next tune**, entitlement unchanged | **Next tune** |
| Rotate `feedKey` (usually the broadcaster) | `PATCH /api/streams/:id` `{feedKey}` | Non-watched channels: picked up at next tune. **The actively-watched channel: `feed-changed`** — the engine re-resolves behind the same localhost URL; the host just reloads the player | **Live push** (active) / next tune |
| Delete a stream | `DELETE /api/streams/:id` | Full purge (catalog+secret+grants+art): vanishes from the display list | **Live push** |
| Category presentation | `GET/POST/PATCH/DELETE /api/categories` (rename/merge/order/hide) | Rails re-label/re-order live — membership stays on the records | **Live push** |

### Sources (provider-imported lineups)

| Operator action | Endpoint(s) | SDK effect | Bucket |
|---|---|---|---|
| Add/sync a source | `POST /api/sources`, `POST /api/sources/:name/sync` | Imported channels appear as **redirect channels** (records: live push). With `autoGrant`, grants reconcile at sync and at user-create — the *keys* still ride the **next login** | Live push / next login |
| Deselect channels | `PATCH /api/sources/:name` `{exclude}` | Excluded channels purge from the catalog | **Live push** |
| Remove source | `DELETE /api/sources/:name` (`?keepChannels=1` detaches) | Its channels purge (or detach and stay) | **Live push** |
| EPG pointers | carried per-record (`epgUrl`/`epgId`) from the source feed | The app fetches the schedule **directly over https** — never through the panel ([guide](sdk-guide.md#epg-program-guide)) | Next fetch |

### Publishers (multi-broadcaster security — S26)

| Operator action | Endpoint(s) | SDK effect |
|---|---|---|
| Enroll / scope / revoke a publisher | `POST /api/publishers`, `POST /api/publishers/:name/scopes`, `/status` | **None directly** — this gates which broadcaster can `register` which `streamId`. A rejected register (`out-of-scope`/`revoked`) means the catalog stops updating for that channel: viewers simply keep seeing the last-accepted state. Attribution (`origin`) rides the record; the SDK ignores fields it doesn't know. |

## 5. Broadcaster control API → SDK effects

The broadcaster never talks to viewers. Every effect flows **broadcaster →
`register` RPC → panel catalog → replication**:

| Operator action | Endpoint(s) | What happens | SDK effect |
|---|---|---|---|
| Start a channel | `POST /api/channels/:id/start` | ffmpeg ingest → encrypted feed → `register` (`feedKey`, `isLive:true`) | `streams` live-push (badge); tune-able ≈ seconds later |
| Stop a channel | `POST /api/channels/:id/stop` | `isLive:false` via the panel link | `streams` live-push; a tune now yields "not broadcasting" |
| Change input / transcode | `PATCH /api/channels/:id` (+ restart) | A restart with a **changed input** mints a fresh feed generation → new `feedKey` registered | Watching viewers: **`feed-changed`**, auto-follow. Others: next tune |
| Rotate | `POST /api/channels/:id/rotate` | Fresh feed generation on demand (bounds merkle growth) | Same as above — watching viewers follow live |
| Watchdog / **offline slate** | (automatic) | Dead source → profile-matched "SOURCE OFFLINE" loop keeps the feed flowing; auto-returns on recovery | Viewers keep playing (they see the slate). Status reads `state:'up'` with `slate.slated:true` — monitoring must check the flag, not the state |
| Registration outcome | `GET /api/channels` (`registered`, `registerError`) | Surfaces panel rejects (`out-of-scope`, `revoked`, …) verbatim | If rejected: catalog frozen for that channel (viewers keep last state) |
| Diagnostics | `GET /api/status`, `/api/capabilities`, `/api/channels/:id/logs`, `GET /api/incidents` (fleet-wide correlated respawn bursts) | Ops-only | None |
| Liveness | **`GET /healthz` (unauthenticated)** — `{up, resuming, resumed, total, …}` | Point uptime checks here | None (but during a boot resume, channels come live in waves — viewers see `isLive` flips as each registers) |

## 6. Panel RPC → the SDK's own calls

What the SDK does under the hood (you never call these directly — `login()` does):

1. `hello` → proof-of-work challenge (rate-limits account probing).
2. `login(username, blinded, powNonce)` → blinded OPRF evaluation. The panel
   **cannot** see the password; the client **cannot** learn the OPRF key.
3. `session(username, deviceId, signature, …)` → device enrollment (evicting the
   oldest past `maxDevices`) + the panel-signed session token.
4. Entitlements are then read from the **replicated DB**: sealed stream keys
   unseal client-side only.

Broadcasters use the same RPC surface for `register` — that's the entire coupling
between the two server components ([details](reference.md#panel-rpc-over-hyperswarm)).

## 7. End-to-end flows

**Onboard a viewer app** — operator: `init` (panel key printed) → add-user →
grants. App: `createPlayer({ panelPubKey })` → `connect()` → `login()` →
`resolve()`. Nothing else crosses the boundary — no URLs, no API keys in the app.

**Broadcaster box restarts** — boot resume re-registers channels (watch
`/healthz`); each `register` updates `feedKey`/`isLive` → watching viewers get
`feed-changed` and auto-follow; idle viewers see badges flip. No client action, no
re-login.

**Provider lineup import** — `POST /api/sources` (+ scheduled sync) → redirect
channels materialize in a category, `autoGrant` reconciles grants → users see the
category after their next login; record edits/removals afterwards are live-push.

## 8. What revocation really means

Layered, weakest to strongest:

1. **Device revoke** (`DELETE …/devices/:id`) — cooperative: that device's
   `sessionLive` fails; a well-behaved client logs out. A hostile client keeps its
   cached token *and keys*.
2. **tokenVersion bump** (password / logout-all) — all devices drop at their next
   online check. Same caveat.
3. **Grant revoke** — gone from the next login. The current session still holds
   unsealed keys in memory.
4. **The real boundary: rotate the stream's encryption key** (re-key the channel).
   Old keys stop decrypting new segments for everyone, entitled users re-login and
   unseal the new key. This is the only content-protection-grade cut — the others
   are session hygiene. (A feedKey rotation alone is *not* revocation: the
   encryption key is unchanged by design, so grants survive it.)

## 9. Security boundaries worth knowing when integrating

- **Viewer apps hold no secrets.** The panel key is public; accounts are the only
  credential and the OPRF keeps passwords off the wire. Ship nothing else.
- **Stream encryption keys never leave the engine.** The display list carries
  metadata + localhost/absolute art URLs only; `resolve()` returns URLs, not keys.
- **Admin/control tokens are operator-local** (loopback HTTP) and unrelated to
  viewer sessions — never embed them in an app.
- **The SDK's HTTP server binds 127.0.0.1** with a per-session random port: media
  is reachable only on-device.
- The catalog is **panel-signed end to end** — a viewer can't be fed a forged
  lineup by a peer; broadcasters are authenticated (and, with publishers enrolled,
  scoped) writers via `register` only.
