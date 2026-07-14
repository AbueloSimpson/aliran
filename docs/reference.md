# Reference

## admin-cli commands

| Command | Description |
|---------|-------------|
| `init` | Generate panel signing key + OPRF key (gitignored data dir) |
| `create-user <u>` / `set-password <u>` | Create/rotate a user (Argon2id verifier) |
| `set-status <u> <active\|disabled>` | Disable/re-enable an account (disable revokes sessions) |
| `grant <u> <stream>` / `revoke <u> <stream>` | Entitle / un-entitle a user for a stream |
| `add-stream <id> [--title --category --feed --key]` | Register a stream + gen encryption key |
| `set-meta <id> …` | Update catalog metadata |
| `upload-art <id> <poster\|backdrop\|logo> <file>` | Add art to the assets drive |
| `set-max-devices <u> <n>` | Concurrent device limit |
| `logout-all <u>` | Revoke all of a user's sessions (tokenVersion bump) |
| `list` | List users and streams |
| `add-admin <name>` / `remove-admin <name>` | Manage admin accounts for the HTTP admin API |

CLI and HTTP API share one implementation (`panel/src/ops.js`), so they cannot drift.

## Admin HTTP API + dashboard (`ADMIN_ENABLED=1`)

Served by the panel process (default `127.0.0.1:3210`; put TLS in front if exposed).
Opening the address in a browser loads the **admin dashboard** (`panel/admin-ui/`,
plain HTML/JS): sign in with an admin account to manage users (create, password,
disable, grants, devices, limits) and streams (add — the encryption key is shown
once —, metadata, poster/backdrop/logo upload with preview) plus a status summary.
The dashboard consumes only the API below.
Log in with an admin account (`add-admin`) to get a panel-signed session token, then
send it as `Authorization: Bearer <token>`. Admin credentials are Argon2id verifiers
in the panel-private `DATA_DIR/secrets/admins.json` — never in the replicated DB.
Login attempts are rate-limited (`LOCKOUT_THRESHOLD`/`LOCKOUT_SECONDS`).

| Endpoint | Description |
|----------|-------------|
| `POST /api/login` `{username,password}` | → `{token, expiresAt}` |
| `GET /api/status` | Counts: users, streams, live, admins |
| `GET/POST /api/users` | List / create (`{username,password}`) |
| `GET /api/users/:u` · `GET /api/users/:u/devices` | One user / their devices |
| `POST /api/users/:u/password` | Rotate password (re-seals grants) |
| `POST /api/users/:u/status` `{status}` | `active` \| `disabled` |
| `POST /api/users/:u/logout-all` · `POST /api/users/:u/max-devices` | Session/device controls |
| `POST /api/users/:u/grants` `{streamId}` · `DELETE /api/users/:u/grants/:id` | Grant / revoke |
| `GET/POST /api/streams` | List / add (`add-stream` fields; returns the encryption key once) |
| `PATCH /api/streams/:id` | Update catalog metadata |
| `POST /api/streams/:id/art/:kind` | Upload poster/backdrop/logo (raw image body) |
| `GET /api/assets/:id/:file` | Art bytes from the assets drive (for previews) |

## Broadcaster control API + UI (`CONTROL_ENABLED=1`)

Served by the broadcaster process (default `127.0.0.1:3310`; put TLS in front if
exposed). Opening the address in a browser loads the **control UI**
(`broadcaster/control-ui/`, plain HTML/JS): sign in with a control admin to add/edit
channels, start/stop them, and watch live status (ffmpeg health, peer count, panel
registration, playlist presence). Channel art is a panel admin operation (the
register RPC carries no art) — upload it in the panel dashboard. The UI consumes
only the API below.
Channels are runtime start/stoppable; each has its own persisted feed
identity (feedKey + encryption key). Admins are created with
`node src/control-cli.js add-admin <name>` (Argon2id verifiers in the local
`DATA_DIR/secrets/admins.json`); login returns a session token signed with a
broadcaster-local keypair, and attempts are rate-limited. Starting a channel spawns
its ffmpeg pipeline, seeds the encrypted feed, and auto-registers with the panel
(publisher-key auth — unchanged). The env-configured channel (`STREAM_ID`) keeps the
legacy `DATA_DIR`-root store, so existing feed identities are preserved.

| Endpoint | Description |
|----------|-------------|
| `POST /api/login` `{username,password}` | → `{token, expiresAt}` |
| `GET /api/status` | Channels, running count, panel configured |
| `GET/POST /api/channels` | List (+ live status) / add (`{id,title,category,input,…}`) |
| `GET /api/channels/:id` | Status: running, ffmpegUp, peers, registered, playlist |
| `PATCH /api/channels/:id` | Edit meta/input (applies on next start) |
| `DELETE /api/channels/:id` | Remove from the registry (must be stopped; data kept) |
| `POST /api/channels/:id/start` · `…/stop` | Spawn / tear down the pipeline |

## Panel RPC (over Hyperswarm)

- `login(blindedPassword, username, pow)` → OPRF evaluation (throttled; never returns
  account secrets).
- `refresh(deviceToken)` → new session token (sliding window; device-key auth).
- `entitlement(username, streamId, sessionToken)` → signed JWT for DRM/geo (when enabled).

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
  "order": 0,
  "poster": "assets/<hash>.jpg",
  "backdrop": "assets/<hash>.jpg",
  "logo": "assets/<hash>.png",
  "feedKey": "<hex>",
  "drm": null,                 // or { scheme, licenseServerRef }
  "status": "live"
}
```

> The stream's content **encryption key is not in the catalog**. It is kept in a
> panel-private, non-replicated secrets file (`DATA_DIR/secrets/streams.json`) and
> delivered per-user via `user.wrapped[streamId]`.

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
