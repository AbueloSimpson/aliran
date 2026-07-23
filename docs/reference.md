# Reference

## admin-cli commands

| Command | Description |
|---------|-------------|
| `init` | Generate panel signing key + OPRF key (gitignored data dir) |
| `create-user <u>` / `set-password <u>` | Create/rotate a user (Argon2id verifier) |
| `set-status <u> <active\|disabled>` | Disable/re-enable an account (disable revokes sessions) |
| `delete-user <u>` | Delete the account record (issued tokens ride out their offline validity) |
| `grant <u> <stream>` / `revoke <u> <stream>` | Entitle / un-entitle a user for a stream |
| `add-stream <id> [--title --category --feed --key]` | Register a stream + gen encryption key |
| `delete-stream <id>` | **Full purge**: catalog + private key + every grant + art (see caveat below) |
| `set-meta <id> [--order <n\|null> --featured … --epg-url <https> --epg-id <id>]` | Update catalog metadata (incl. curation; `--epg-url`/`--epg-id` attach a program guide, `''` clears) |
| `upload-art <id> <poster\|backdrop\|logo> <file>` | Add art to the assets drive |
| `set-max-devices <u> <n>` | Concurrent device limit |
| `list-devices <u>` | Show a user's enrolled devices |
| `logout-device <u> <deviceId>` | Drop one enrollment (cooperative — no tokenVersion bump) |
| `logout-all <u>` | Revoke all of a user's sessions (tokenVersion bump) |
| `list` | List users and streams |
| `add-admin <name>` / `remove-admin <name>` | Manage admin accounts for the HTTP admin API |
| `set-admin-password <name>` / `list-admins` | Rotate an admin password (revokes their sessions) / list admins |
| `add-publisher <name> [--scopes "east-*,espn2"]` | Enroll a broadcaster site: per-site keypair (secret printed **once** → that site's `PUBLISHER_KEY`/`PUBLISHER_NAME`) + streamId-glob channel scopes |
| `list-publishers` / `remove-publisher <name>` | List enrollments / hard-delete one (revoking keeps the audit trail) |
| `set-publisher-scopes <name> <globs>` | Replace a site's channel scopes (comma-separated; live from its next register) |
| `set-publisher-status <name> <active\|revoked>` | Revoke / re-accept a site's key (status flip — no re-keying of other sites) |
| `add-source <name> <url> --category <label> [--prefix --interval-hours --auto-grant false --disabled]` | Register a remote channel feed (provider JSON) imported as a category of redirect channels |
| `list-sources` / `set-source <name> [--url --category … --exclude "id1,id2"]` | List sources + sync state / edit one (registry-only — safe beside a running panel; `--exclude` deselects feed entries, `""` re-includes all) |
| `sync-source <name>` | Pull + diff + grant **now** (needs the store: panel stopped — on a live panel use the dashboard/API) |
| `remove-source <name> [--keep-channels]` | Remove a source; purges its channels unless `--keep-channels` detaches them |

> **Stream deletion caveat:** the purge removes everything the panel can remove, but a
> client that already unsealed the stream key may have it cached — full revocation of
> live content is a stream-key rotation. Re-adding a deleted id mints a **fresh** key.

CLI and HTTP API share one implementation (`panel/src/ops.js`), so they cannot drift.

## Admin HTTP API + dashboard (`ADMIN_ENABLED=1`)

Served by the panel process (default `127.0.0.1:3210`; put TLS in front if exposed).
Opening the address in a browser loads the **admin dashboard** (`panel/admin-ui/`,
plain HTML/JS): sign in with an admin account to manage users (create, prefix
**search** with cursor-paged “Load more”, password, disable, **delete**, grants,
devices — including per-device revoke ✕ —, limits) and streams (add — the encryption
key is shown once —, metadata, **curation**: order + featured hero hint, art upload
with preview, **permanent purge** behind a type-the-id confirmation), plus an
**Admins** tab (add/remove/rotate passwords — rotating your own signs you out), a
**Publishers** tab (enroll broadcaster sites with their own keys + channel scopes,
edit scopes live, revoke/re-activate, remove — the site secret is shown once at
enrollment), a
**Sources** tab (register provider channel feeds imported as categories of redirect
channels — add auto-syncs, per-row sync now / edit / pause / remove-with-detach-option,
last-sync report and error surfaced inline) and an
**Overview** tab (uptime/memory/peers/storage chips + the live activity feed, polled
every 10 s while open). Destructive flows state their caveats inline (key-rotation
for purge, offline-token validity for user delete, cooperative semantics for device
revoke). The dashboard consumes only the API below.
Log in with an admin account (`add-admin`) to get a panel-signed session token, then
send it as `Authorization: Bearer <token>`. Admin credentials are Argon2id verifiers
in the panel-private `DATA_DIR/secrets/admins.json` — never in the replicated DB.
Login attempts are rate-limited (`LOCKOUT_THRESHOLD`/`LOCKOUT_SECONDS`).

| Endpoint | Description |
|----------|-------------|
| `POST /api/login` `{username,password}` | → `{token, expiresAt}` |
| `GET /api/status` | Counts: users, streams, live, admins |
| `GET /api/observability` | Uptime, memory, swarm peers, data size/disk free + last-200 activity ring (in-memory — cleared by a restart) |
| `GET /api/users?prefix&after&limit` | → `{users, next}` — prefix search + cursor paging (`next` is the `after` for the following page) |
| `POST /api/users` | Create (`{username,password}`) |
| `GET /api/users/:u` · `DELETE /api/users/:u` | One user / delete the account record |
| `GET /api/users/:u/devices` | Enrolled devices |
| `DELETE /api/users/:u/devices/:deviceId` | Drop one enrollment (cooperative — no tokenVersion bump) |
| `POST /api/users/:u/password` | Rotate password (re-seals grants) |
| `POST /api/users/:u/status` `{status}` | `active` \| `disabled` |
| `POST /api/users/:u/logout-all` · `POST /api/users/:u/max-devices` | Session/device controls |
| `POST /api/users/:u/grants` `{streamId}` · `DELETE /api/users/:u/grants/:id` | Grant / revoke |
| `GET/POST /api/streams` | List / add (`add-stream` fields + `order`/`featured` + `url` — an https `url` creates a **redirect channel**; returns the encryption key once) |
| `PATCH /api/streams/:id` | Update catalog metadata (incl. `order` 0–9999 \| null, `featured` bool, `url` — https sets / empty clears the redirect class, `epgUrl`/`epgId` — https program-guide pointers the app fetches, empty clears) |
| `DELETE /api/streams/:id` | **Full purge** — catalog + private key + grants + art (see the deletion caveat above) |
| `POST /api/streams/:id/art/:kind` | Upload poster/backdrop/logo (raw image body) |
| `GET /api/assets/:id/:file` | Art bytes from the assets drive (for previews) |
| `GET/POST /api/admins` · `DELETE /api/admins/:name` | Manage admin accounts |
| `POST /api/admins/:name/password` | Rotate an admin password (bumps tokenVersion → their sessions die) |
| `GET/POST /api/publishers` · `DELETE /api/publishers/:name` | Enrolled broadcaster identities: list / enroll (`{name, scopes?}` — returns the site `secretKey` **once**) / hard-delete |
| `POST /api/publishers/:name/status` `{status}` | `active` \| `revoked` — a revoked site's registrations bounce until re-activated |
| `POST /api/publishers/:name/scopes` `{scopes}` | Replace the site's streamId-glob scopes (applies from its next register) |
| `GET/POST /api/sources` | Remote channel sources: list (+ owned-channel counts, last sync/error) / add (`{name,url,category,prefix?,autoGrant?,enabled?,intervalMs?}`) |
| `PATCH /api/sources/:name` | Edit any source field (`enabled:false` pauses the schedule; url or `exclude` change resets the ETag so the next sync applies it) |
| `GET /api/sources/:name/channels` | Imported + excluded entries — the channels-dialog data (`{feedId,id,title,order,excluded}`) |
| `DELETE /api/sources/:name` | Remove a source — **purges its channels** (`?keepChannels=1` detaches them as manual redirect channels instead) |
| `POST /api/sources/:name/sync` | Pull + diff + grant now → the sync report (`added/updated/removed/skipped/conflicts/granted/notModified`) |

## Broadcaster control API + UI (`CONTROL_ENABLED=1`)

Served by the broadcaster process (default `127.0.0.1:3310`; put TLS in front if
exposed). Opening the address in a browser loads the **control UI**
(`broadcaster/control-ui/`, plain HTML/JS): sign in with a control admin to add/edit
channels (ingest kind — push kinds the host ffmpeg lacks are hidden — plus per-channel
transcode with unusable encoders disabled and the probe error as tooltip), start/stop
them, copy the **push URL** for push channels straight off the card, read the ffmpeg
**log ring** (2 s-refreshing dialog; the last lines also appear inline on an unhealthy
card), and watch live status. State badges: **ON AIR** / **WAITING FOR PUBLISHER**
(push listener idle — normal) / **RETRYING (exit N)** (watchdog backoff). A channel
whose source has failed past `SLATE_AFTER` shows the offline slate: it reports **ON AIR**
(it genuinely is — bars are flowing) with `slate.slated` set, so check that flag, not the
state, to tell "showing the source" from "showing bars." See [KB](kb/offline-slate.md). Channel art
is a panel admin operation (the register RPC carries no art) — upload it in the panel
dashboard. The UI consumes only the API below.
Channels are runtime start/stoppable; each has its own persisted feed
identity (feedKey + encryption key). Admins are created with
`node src/control-cli.js add-admin <name>` (Argon2id verifiers in the local
`DATA_DIR/secrets/admins.json`); login returns a session token signed with a
broadcaster-local keypair, and attempts are rate-limited. Starting a channel spawns
its ffmpeg pipeline, seeds the encrypted feed, and auto-registers with the panel
(publisher-key auth; with `PUBLISHER_NAME` set the payload carries the enrolled
identity and is subject to that site's channel scopes). The env-configured channel
(`STREAM_ID`) keeps the legacy `DATA_DIR`-root store, so existing feed identities
are preserved.

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | **Unauthenticated** liveness + boot-resume progress → `{up, uptimeSec, resuming, resumed, total, failed, resumeSec}`. Cheap and served before the auth gate, so monitoring can tell "up, resuming 45/83" from "dead" even while a mass resume keeps the rest of the API busy. Point uptime checks here, not at `/api/status` (which needs a token and does real work) |
| `POST /api/login` `{username,password}` | → `{token, expiresAt}` |
| `GET /api/status` | Channels, running count, panel configured |
| `GET /api/capabilities` | ffmpeg probe: input protocols + deep-verified encoders (`{listed,verified,error?}`) |
| `GET/POST /api/channels` | List (+ live status) / add (`{id,title,category,input,transcode,buffer,…}`) |
| `GET /api/channels/:id` | Status: `state` (`stopped·starting·up·waiting-input·backoff`), running, ffmpegUp, peers, registered, playlist, watchdog, `slate` (`{slated,file,since,failures}` — `slated:true` means viewers see the offline slate, not the source, even though `state` is `up`), `detectedProfile` (`{codec,width,height}` the slate matches against), `ingest.pushUrl` (push kinds; uses `PUBLIC_HOST`) |
| `PATCH /api/channels/:id` | Edit meta/input/transcode (applies on next start; a SOURCE change rotates the feed identity) |
| `DELETE /api/channels/:id` | Remove from the registry (must be stopped; data kept) |
| `POST /api/channels/:id/start` · `…/stop` | Spawn / tear down the pipeline |
| `POST /api/channels/:id/rotate` | Disk mode: mint a fresh feed generation now (bounds merkle-tree growth); ffmpeg keeps running, watching viewers follow the new `feedKey` live, the retired generation's cores are purged after a grace window. See [feed buffer](kb/feed-buffer.md) |
| `GET /api/channels/:id/logs?lines=N` | ffmpeg stderr ring → `{lines:[{t,line}], running, restarts, state}` (≤400; cleared on operator start, survives watchdog respawns) |
| `GET /api/incidents` | Correlated incident log: fleet-wide respawn bursts and per-source outage windows detected across channels (what a lone per-channel restart counter can't show) |
| `GET/POST /api/admins` · `DELETE /api/admins/:name` | Manage control admin accounts |
| `POST /api/admins/:name/password` | Rotate an admin password (revokes their sessions) |

## Library control API + UI (`CONTROL_ENABLED=1`)

Served by the **library** process — the standalone VOD service (default
`127.0.0.1:3320`; put TLS in front if exposed). Opening the address loads the
minimal control UI (`library/control-ui/`): sign in with a control admin (created
with `node src/library-cli.js add-admin <name>` — same auth skeleton as the
broadcaster's) to add titles, watch ingest progress, read logs, re-ingest and
delete. A **title** is a one-shot ingest (probe → `-c copy` remux when the codecs
are HLS-compatible, else h264/aac transcode → a finished HLS **VOD** rendition in
its own encrypted Hyperdrive — all segments kept) that then seeds persistently and
registers with the panel as `type:'vod'` + `durationSec` under the library's own
enrolled publisher. Inputs must have a **finite duration** (files, not live
streams). Disk = the sum of title sizes; reclaimed only by delete.

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | **Unauthenticated** liveness → `{ok, titles, ready, ingesting, queued, error, panelLink:{connected,pendingOps,…}}`. Cheap + synchronous — answers even mid-transcode |
| `POST /api/login` `{username,password}` | → `{token, expiresAt}` |
| `GET /api/status` | Titles summary, publisher, panel key, swarm connections |
| `GET/POST /api/titles` | List (+ ingest progress/peers/registered) / add + queue ingest (`{id, input, title?, description?, category?, protection?, mode?, hlsTime?}` — `mode`: `auto`(default)/`copy`/`transcode`; `input`: a path on the library box or any URL ffmpeg reads) |
| `GET /api/titles/:id` | Registry view: `state` (`queued·ingesting·ready·error`), `ingest:{phase,pct}`, `feedKey`, `durationSec`, `segments`, `bytes`, `peers`, `registered`, `registerError` |
| `PATCH /api/titles/:id` | `input`/`mode`/`hlsTime` only — descriptive metadata is panel-owned after creation |
| `POST /api/titles/:id/ingest` | Re-ingest (optional `{input}`): mints the next feed generation (fresh `feedKey`, old cores purged); viewers pick it up on their next tune |
| `DELETE /api/titles/:id` | Stop seeding + **purge the title's cores and key from this box** (refused mid-ingest). Registers `status:'unavailable'`; remove the catalog record + grants in the panel |
| `GET /api/titles/:id/logs?lines=N` | The ingest's ffmpeg/log ring → `{lines, state, ingest}` |
| `GET/POST /api/admins` · `DELETE /api/admins/:name` · `POST /api/admins/:name/password` | Manage control admins (same shapes as the broadcaster's) |

Env config (`library/.env`): `DATA_DIR`, `PANEL_PUBKEY`, `PUBLISHER_NAME` +
`PUBLISHER_KEY` (enroll the library as its **own** publisher, scoped to its title
ids), `HLS_TIME` (VOD segment length, default 4 s), `INGEST_CONCURRENCY` (default
1 — transcodes are 0.5–1 core each), `SWARM_MAX_PEERS` (default 256),
`SWARM_RCVBUF_MB`/`SWARM_SNDBUF_MB` (default 4/4 — a seeder is send-dominant),
`CONTROL_ENABLED`/`CONTROL_HOST`/`CONTROL_PORT`/`CONTROL_SESSION_TTL_HOURS`,
`LOCKOUT_*`, `ARGON2_*`, `BOOTSTRAP`.

## Reseller panel API

Served by the **reseller** process — the standalone role-hierarchy + credit
panel that fronts the panel admin API (default `127.0.0.1:3330`; put TLS in
front if exposed, and an IP allowlist since it is used by third parties). Opening
the address loads the control UI (`reseller/control-ui/`); sign in as a principal
(the root admin is seeded with `node src/reseller-cli.js add-admin <name>`).
Every account mutation becomes a call to the panel admin API, gated by the
signed-in principal's role and credit balance. Concepts, topologies and the
bootstrap walkthrough are in [Reseller panel](reseller-panel.md).

Roles: `admin` (root, mints, sole co-admin manager) → `co-admin` (admin clone) →
`super` → `reseller`. Errors: `403` capability/scope denial, `402` insufficient
credits, `404`/`409` as the panel, and panel failures surface `PANEL:`-prefixed
(`502` when the panel is unreachable).

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | **Unauthenticated** liveness → `{ok, principals, accounts, panel:{reachable,lastOkAt}, sweep, ledger:{seq,invariantOk}}` |
| `GET /branding.json` · `GET /branding.css` · `GET /branding/logo\|favicon\|login-bg` | **Public** white-label surface: `{name, accent, logo, favicon, loginBg, loginStyle}`, the operator's theme-token overrides (layered after the shared theme block), and the logo/favicon/login-backdrop images (`BRAND_*` env vars incl. `BRAND_LOGIN_BG_FILE` + `BRAND_LOGIN_STYLE` glow\|plain\|grid\|dots\|stripes) — manual: [white-label.md](white-label.md#reseller-panel-dashboard) |
| `POST /api/webhooks/credits` | **HMAC-authenticated** (no Bearer) automated top-up: `{id, to, amount, note?}` signed as `x-topup-signature` = hex HMAC-SHA256(`WEBHOOK_SECRET`, `"<ts>.<raw body>"`) + `x-topup-timestamp` (±300 s). Idempotent by `id` (retry → `{duplicate:true}`); mints a `MINT` line with actor `webhook`; 404 when no secret is configured |
| `POST /api/login` `{username,password}` | → `{token, expiresAt, role}`; rate-limited + single-flight |
| `GET /api/me` · `POST /api/me/password` | Own record + balance + trials-used-today / rotate own password |
| `GET /api/status` | Role-scoped KPIs (balance, active/expiring/trial counts; admins also get principals, outstanding credits, panel reachability, last reconcile) |
| `GET /api/panel/status` · `GET /api/streams` | Passthrough of the panel status / catalog (admins; streams cached 60 s for the grants picker) |
| `GET /api/system` | Admin tiers: operator diagnostics for the **System** section of the UI's Overview — `{service:{node,pid,uptimeSec,rssBytes,heapUsedBytes,dataDir,sweeps,ledger}, host:{hostname,platform,release,arch,cpuModel,cpuCount,loadavg,totalMemBytes,freeMemBytes,uptimeSec,disk:{totalBytes,freeBytes}}, panel:{url,reachable,lastOkAt,lastError,latencyMs,stats:{panelKey,users,streams,live,admins},error}}`. The panel block is a **live timed probe**; a down panel fills `error` instead of failing the request |
| `GET/POST /api/principals` | List (scoped) / create `{username,password,role,maxDevicesLimit?,trialDailyCap?,note?}` (parent = you) |
| `GET/DELETE /api/principals/:name` | View / delete (refused while it has child principals or accounts; remaining balance reclaimed to you) |
| `POST /api/principals/:name/password\|status\|limits` | Rotate password / suspend·resume (`{status, mode:'panel-only'\|'with-accounts'}`) / set `{maxDevicesLimit,trialDailyCap}` — `maxDevicesLimit` is the **admin-set device policy** (admin tiers only; `null` = inherit the parent chain; supers may only tune `trialDailyCap`). Views report the effective value + `maxDevicesLimitInherited` |
| `POST /api/credits/mint\|transfer\|reclaim\|adjust` | Mint (admin tiers) / fund a child / pull back / correction (note required). `402` when a debit exceeds balance |
| `GET /api/ledger?principal&account&type&before&limit` | Append-only credit ledger, newest-first, `before`=seq cursor, scoped to self+subtree for non-admins |
| `GET/POST /api/accounts` | List — server-side query engine built for large registries: `?q` (ci-substring over name **and** owner) `&filter=active\|disabled\|expiring\|trial` `&owner` `&sort=name\|expires\|created\|status\|owner` `&dir` `&offset` `&limit` (default 50, cap 500) → `{items, total, offset, limit}` / activate `{name,password,months,maxDevices?,grants?}` — plain panel username, first come first served; `maxDevices` may only be passed by admin tiers (403 otherwise) — accounts receive the creator's inherited device policy |
| `GET/DELETE /api/accounts/:acct` | View (+ live panel state) / delete (refund `floor(remaining months)` to owner; admin deletes refund nothing) |
| `POST /api/accounts/:acct/renew\|status\|password\|max-devices\|grants\|logout-all` | Renew from `max(now,expiry)` (converts a trial to paid) / suspend·resume / set password / set devices (**admin tiers only** — the per-account policy override) / add a grant / drop all sessions |
| `DELETE /api/accounts/:acct/grants/:streamId` · `GET/DELETE /api/accounts/:acct/devices[/:id]` | Remove a grant / list + revoke devices |
| `POST /api/trials` | `{name,password,maxDevices?}` → a free time-boxed trial (per-reseller daily cap) |
| `POST /api/ops/sweep` · `GET/POST /api/ops/reconcile` | Run the expiry sweep now / read + run the reconcile (admin tiers) |

Env config (`reseller/.env`): `DATA_DIR`, `PANEL_ADMIN_URL` + `PANEL_ADMIN_USER`/
`PANEL_ADMIN_PASS` (the dedicated panel admin) + `PANEL_TIMEOUT_MS`,
`DAYS_PER_MONTH`, `TRIAL_HOURS`, `TRIAL_DAILY_CAP_DEFAULT`,
`MAX_DEVICES_LIMIT_DEFAULT`, `SWEEP_INTERVAL_SEC`, `RECONCILE_INTERVAL_SEC`,
`RECONCILE_REPAIR`, `CONTROL_HOST`/`CONTROL_PORT`/`CONTROL_SESSION_TTL_HOURS`,
`LOCKOUT_*`, `TRUST_PROXY_HEADER` (behind a trusted proxy/tunnel only — e.g.
`cf-connecting-ip` for Cloudflare Tunnel, `x-forwarded-for` for Caddy/nginx —
keys the login lockout on the proxied client IP instead of the proxy's socket),
`BRAND_NAME`/`BRAND_LOGO_FILE`/`BRAND_FAVICON_FILE`/`BRAND_LOGIN_BG_FILE`/
`BRAND_LOGIN_STYLE`/`BRAND_THEME_FILE` (white-label — see
[the manual](white-label.md#reseller-panel-dashboard)),
`WEBHOOK_SECRET` (enables the top-up webhook), `ARGON2_*`.

## Panel RPC (over Hyperswarm)

- `hello` → proof-of-work challenge + difficulty (pre-login).
- `login(username, blinded, powNonce)` → blinded OPRF evaluation (throttled; the
  panel never sees the password or the result).
- `session(username, deviceId, signature, …)` → device enrollment + panel-signed
  session token (enforces `maxDevices`, evicts oldest; revocation via `tokenVersion`).
- `register(payload, sig)` → a broadcaster publishes/updates a catalog record
  (Ed25519 auth; the encryption key is stored panel-private, never in the catalog).
  A payload carrying `publisher: "<name>"` verifies against that **enrolled** site's
  own public key (`add-publisher`) and its `streamId` must match the site's channel
  scopes **before anything is written** — rejects are `unknown-publisher` /
  `revoked` / `out-of-scope` (or `unauthorized` for a bad signature) and surface
  verbatim as the channel's `registerError` in the broadcaster control UI. Accepted
  named registers stamp `origin: "<name>"` on the record. A payload **without**
  `publisher` verifies against the legacy shared key from `init` (implicit scope
  `*`) while `LEGACY_PUBLISHER=1` (the default); set `0` after enrolling every site.
  **Descriptive metadata is panel-authoritative**: a register only sets `feedKey` +
  `isLive` (live) or `feedKey` + `durationSec` (vod) on an existing record; it
  **seeds** `title`/`description`/`category` only when it first creates the record
  and never overwrites them after — the admin owns them (as with art, EPG, curation
  and the redirect class). Rename/recategorize a P2P channel or a title in the
  panel, not the broadcaster/library config.

## Schemas

### Catalog record (`catalog/<streamId>`)
```jsonc
{
  "title": "News 24",
  "description": "...",
  "category": ["news"],
  "type": "live",              // live | vod (record class — see the vod note below)
  "protection": "self",        // reserved — only 'self' exists (no DRM, by design)
  "isLive": true,              // live records ONLY — a vod record omits the field entirely
  "durationSec": null,         // vod records ONLY — title runtime in seconds
  "viewerCount": null,         // derived, not durable
  "order": 0,                  // curation: rail sort 0-9999, or null (unordered)
  "featured": false,           // curation: hero-pick hint for client UIs
  "poster": "assets/<hash>.jpg",
  "backdrop": "assets/<hash>.jpg",
  "logo": "assets/<hash>.png",
  "feedKey": "<hex>",
  "blobsKey": "<hex>",         // the feed drive's blobs-core key (or null) — see below
  "redirect": false,           // redirect channel class — see below
  "url": null,                 // redirect channels: https HLS the client plays directly
  "origin": null,              // enrolled publisher that made the LAST register (audit), or null
  "source": "anime",           // imported by this channel source, absent on manual channels
  "epgUrl": "https://…",       // source imports: the feed URL carrying this channel's schedule
  "epgId": "plutotv.es.629…",  // source imports: this channel's id INSIDE that feed
  "status": "live"
}
```

> **VOD titles**: a record with `type:'vod'` is a **library** title — a finished
> HLS VOD rendition in its own encrypted drive, registered over the same `register`
> RPC with `durationSec` in the payload. The class differs in exactly two fields:
> `durationSec` (payload-owned, like `feedKey` — the library measures it at ingest)
> and **no `isLive`** (liveness is not a property a title has; clients must not read
> liveness into vod records). `status` vocabulary: `'available'` (seeding) /
> `'unavailable'` (the library deleted the title; the record is admin-owned and
> stays until removed in the panel). Grants, sealing, blobsKey enrichment, art,
> curation and categories work identically for both classes.

> **Redirect channels**: a record with `{redirect: true, url: "https://…"}` is a
> different *class* of entry — viewers play the operator's URL **directly** instead of
> a P2P feed (`feedKey` stays `null`; the panel rejects mixing the two). Set or clear
> it via the `url` field on `POST`/`PATCH /api/streams` or the dashboard's "Redirect
> URL" input (the CLI does not expose it); a broadcaster re-register never erases the
> class. Details: [content-management.md](content-management.md).

> **`source` / `epgUrl` / `epgId`**: stamped on records imported by a remote
> channel source. `source` is the ownership mark — a sync may only touch records
> carrying **its** name, and detaching/removing the source strips or purges them.
> The epg fields point back to the feed so a client can fetch the schedule over
> https on demand — the apps render it as the Info panel's Now/Next guide (the
> shared EPG layer in `@aliran/react-native`). Registry (nothing secret) lives
> in `DATA_DIR/sources.json`; see [content-management.md](content-management.md).

> The stream's content **encryption key is not in the catalog**. It is kept in a
> panel-private, non-replicated secrets file (`DATA_DIR/secrets/streams.json`) and
> delivered per-user via `user.wrapped[streamId]`.

> **`origin`**: which enrolled publisher's key signed the record's most recent
> register — the audit trail behind the origin chip in the panel dashboard. A legacy
> (shared-key) register writes `null`: attribution never guesses. Clients ignore the
> field. Publisher enrollments themselves live panel-private in
> `DATA_DIR/secrets/publishers.json` (public keys + scopes only — the site keeps its
> secret); see [security-model.md](security-model.md).

> **`blobsKey`**: the feed drive's blobs-core key, published so keyless
> repeater/seed nodes can mirror the **encrypted** video blocks (the blobs core is a
> named core whose key lives inside the drive's encrypted header, so it is not
> derivable from `feedKey` alone). The panel fills it **asynchronously** after a
> register: it opens the drive with its stored encryption key, reads the header, and
> writes the key back (`panel/src/blobs-key.js`) — the register RPC never waits on
> this. It is cleared and re-filled whenever a register rotates `feedKey`. Publishing
> it is safe: it only enables ciphertext replication; watching still requires a
> per-user sealed grant key.

### User record (`user/<username>`)
```jsonc
{
  "salt": "<hex>",
  "verifier": "<hex>",         // Argon2id(rwd, salt); rwd = OPRF output
  "argon": { "opslimit": 2, "memlimit": 67108864 },
  "pub": "<hex>",              // user X25519 public key
  "encPriv": "<nonce||cipher hex>",   // private key sealed under a key derived from rwd
  "wrapped": { "<streamId>": "<stream key sealed to pub, hex>" },
  "devices": [ { "deviceId": "<pubkey>", "label": "Pixel 8", "expiresAt": 0, "tokenVersion": 1, "status": "active" } ],
  "tokenVersion": 1,
  "maxDevices": 2,
  "status": "active"
}
```
