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
| `GET/POST /api/admins` · `DELETE /api/admins/:name` | Manage control admin accounts |
| `POST /api/admins/:name/password` | Rotate an admin password (revokes their sessions) |

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
  `isLive` on an existing channel; it **seeds** `title`/`description`/`category` only
  when it first creates the record and never overwrites them after — the admin owns
  them (as with art, EPG, curation and the redirect class). Rename/recategorize a P2P
  channel in the panel, not the broadcaster config.

## Schemas

### Catalog record (`catalog/<streamId>`)
```jsonc
{
  "title": "News 24",
  "description": "...",
  "category": ["news"],
  "type": "live",              // live | vod
  "protection": "self",        // self | drm
  "allowedRegions": null,      // or ["US","CA"]
  "isLive": true,
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
  "source": "anime",           // imported by this channel source (S27), absent on manual channels
  "epgUrl": "https://…",       // source imports: the feed URL carrying this channel's schedule
  "epgId": "plutotv.es.629…",  // source imports: this channel's id INSIDE that feed
  "drm": null,                 // or { scheme, licenseServerRef }
  "status": "live"
}
```

> **Redirect channels** (S23): a record with `{redirect: true, url: "https://…"}` is a
> different *class* of entry — viewers play the operator's URL **directly** instead of
> a P2P feed (`feedKey` stays `null`; the panel rejects mixing the two). Set or clear
> it via the `url` field on `POST`/`PATCH /api/streams` or the dashboard's "Redirect
> URL" input (the CLI does not expose it); a broadcaster re-register never erases the
> class. Details: [content-management.md](content-management.md).

> **`source` / `epgUrl` / `epgId`** (S27): stamped on records imported by a remote
> channel source. `source` is the ownership mark — a sync may only touch records
> carrying **its** name, and detaching/removing the source strips or purges them.
> The epg fields point back to the feed so a client can fetch the schedule over
> https on demand (clients currently ignore them). Registry (nothing secret) lives
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

> **`blobsKey`** (S20a): the feed drive's blobs-core key, published so keyless
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
