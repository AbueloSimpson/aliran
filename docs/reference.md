# Reference

## admin-cli commands

| Command | Description |
|---------|-------------|
| `init` | Generates the panel's signing key and OPRF key. Stores them in the gitignored data directory. Prints the panel public key and the [service pairing code](operator-guide.md#the-service-pairing-code). |
| `export-escrow [--out <file>]` | Exports `DATA_DIR/keys/` **encrypted** under a passphrase you type. This is the supported way to move the identity off the box. The file verifies itself before it is written. See [key escrow](kb/backup-and-rotation.md#get-the-identity-off-the-box-key-escrow). |
| `verify-escrow <file> [--restore-to <empty-dir>]` | Proves an escrow file decrypts and holds the identity its fingerprint names. Needs **no panel** and no `DATA_DIR` — run it wherever the copy lives. `--restore-to` extracts the key files into an empty directory. Only one panel may ever run with an identity, so you move them from there by hand. |
| `create-user <u>` / `set-password <u>` | Creates a user, or rotates a password. Stores an Argon2id verifier. |
| `set-status <u> <active\|disabled>` | Disables or re-enables an account. Disabling also revokes the account's sessions. |
| `delete-user <u>` | Deletes the account record. Tokens already issued keep working offline until they expire. |
| `grant <u> <stream>` / `revoke <u> <stream>` | Grants or revokes a user's access to a stream. |
| `add-stream <id> [--title --category --feed --key]` | Registers a stream and generates its encryption key. |
| `delete-stream <id>` | **Full purge**: removes the catalog entry, the private key, every grant, and the art. See the caveat below. |
| `set-meta <id> [--order <n\|null> --featured … --epg-url <https> --epg-id <id>]` | Updates catalog metadata, including curation fields. `--epg-url`/`--epg-id` attach a program guide; an empty value (`''`) clears it. |
| `upload-art <id> <poster\|backdrop\|logo> <file>` | Adds art to the assets drive. |
| `set-max-devices <u> <n>` | Sets the concurrent device limit. |
| `list-devices <u>` | Shows a user's enrolled devices. |
| `logout-device <u> <deviceId>` | Drops one device enrollment. This is cooperative — it does not bump `tokenVersion`. |
| `logout-all <u>` | Revokes all of a user's sessions by bumping `tokenVersion`. |
| `list` | Lists users and streams. |
| `add-admin <name>` / `remove-admin <name>` | Adds or removes an admin account for the HTTP admin API. |
| `set-admin-password <name>` / `list-admins` | Rotates an admin password, which revokes their sessions, or lists admins. |
| `add-publisher <name> [--scopes "east-*,sports-1"]` | Enrolls a broadcaster site: generates a per-site keypair — the secret prints once, and becomes that site's `PUBLISHER_KEY`/`PUBLISHER_NAME` — plus streamId-glob channel scopes. |
| `list-publishers` / `remove-publisher <name>` | Lists enrollments, or hard-deletes one. Revoking a publisher instead keeps the audit trail. |
| `set-publisher-scopes <name> <globs>` | Replaces a site's channel scopes (comma-separated). Takes effect from its next register. |
| `set-publisher-status <name> <active\|revoked>` | Revokes or re-accepts a site's key. This flips its status only — it does not re-key other sites. |
| `add-source <name> <url> --category <label> [--prefix --interval-hours --auto-grant false --disabled]` | Registers a remote channel feed (provider JSON). Imports it as a category of redirect channels. |
| `list-sources` / `set-source <name> [--url --category … --exclude "id1,id2"]` | Lists sources with their sync state, or edits one. This only touches the registry, so it's safe beside a running panel. `--exclude` deselects feed entries; an empty value (`""`) re-includes all of them. |
| `sync-source <name>` | Pulls, diffs, and grants now. Needs direct store access — stop the panel first, or use the dashboard/API on a live panel. |
| `vod-config` / `vod-config-set [--enabled --api-base --service --movies-source --series-source --params "hm=1,hs=2" --param hs=2]` | Shows or configures the external VOD provider that the **apps** call directly. `--params` replaces the whole parameter map; `--param` merges in one key. Each `--*-source` flag merges its own kind of source, and an empty value (`""`) clears it — no series source means the apps show movies only. Needs direct store access: stop the panel first, or use the dashboard/API. |
| `remove-source <name> [--keep-channels]` | Removes a source. This purges its channels, unless `--keep-channels` detaches them instead. |
| `add-package <name> [--label L --members "news-24,sports-*,category:Deportes,source:anime" --default]` | Defines a channel package (bouquet). Members can be stream ids, id globs, or `category:`/`source:` selectors, resolved at reconcile time. `--default` auto-assigns the package to new users. |
| `set-package <name> [--label --members "…" --default true\|false]` / `remove-package <name>` | Edits a package — member edits apply immediately to every holder, and an empty value (`""`) clears the members — or removes it. Removing a package removes only the grants it covered. |
| `list-packages` / `show-package <name>` | Lists packages with their resolved-channel and holder counts, or shows one package with the channels it resolves to right now. |
| `set-user-packages <u> <p1,p2\|"">` | Replaces a user's package list. Seals or removes grants immediately. Needs direct store access: stop the panel first, or use the dashboard/API. |
| `list-reports [--status --channel --category --limit]` | Lists [viewer problem reports](reports.md). Reporters are 16-hex pseudonyms — no username or device id is stored anywhere. |
| `ack-report <id>` / `resolve-report <id> [note]` | Acknowledges or closes one report. |
| `list-alerts [--status open\|ack\|resolved]` | Lists correlation alerts. **Read-only here** — a running panel holds alerts in memory and flushes them lazily, so acknowledge or resolve them in the dashboard/API instead. |
| `test-notify` | Sends a synthetic ops notification through the configured webhook or Telegram targets. Needs the panel's `REPORTS_*` env in the current shell. |

> The report commands only touch `DATA_DIR/reports/`, re-read on every operation, so
> they work **beside a running panel** — triaging reports never means stopping the
> service. The knobs, the ntfy/Slack/Discord/Telegram recipes, and the pseudonymity
> limits are in [Viewer problem reports](reports.md).


> **Stream deletion caveat:** the purge removes everything the panel can remove. But
> a client that already unsealed the stream key may have it cached — full
> revocation of live content needs a stream-key rotation. Re-adding a deleted id
> mints a **fresh** key.

CLI and HTTP API share one implementation (`panel/src/ops.js`), so they cannot drift.

## Admin HTTP API + dashboard (`ADMIN_ENABLED=1`)

The panel process serves this API (default `127.0.0.1:3210`). Put TLS in front of
it if you expose it beyond loopback.

Opening the address in a browser loads the **admin dashboard** (`panel/admin-ui/`,
plain HTML/JS). Sign in with an admin account to manage:

- **Users** — create, prefix-search with cursor-paged "Load more", set password,
  disable, delete, manage grants and devices (including a per-device revoke ✕),
  and set device limits. The grants cell splits **package chips**, manual chips,
  and source auto-grant chips, so you can see where each grant comes from. The
  grant dialog offers whole packages alongside single streams.
- **Streams** — add a stream (the encryption key shows once), edit metadata, set
  curation (order and the featured hero hint), upload art with a preview, and run
  a permanent purge behind a type-the-id confirmation.
- **Packages** tab — define bouquets of channels (members, a resolved-channel
  preview, holder counts). A package grants as one unit and materializes into
  per-user sealed keys.
- **Admins** tab — add, remove, and rotate admin passwords. Rotating your own
  password signs you out.
- **Publishers** tab — enroll broadcaster sites with their own keys and channel
  scopes, edit scopes live, revoke or re-activate a site, and remove one. The
  site secret shows once, at enrollment.
- **Sources** tab — register provider channel feeds, imported as categories of
  redirect channels. Adding a source auto-syncs it; each row also offers sync
  now, edit, pause, and remove (with an option to detach its channels instead of
  purging them). The last-sync report and any error show inline.
- **Overview** tab — uptime, memory, peers, and storage chips, plus the live
  activity feed, polled every 10 seconds while the tab is open.

Destructive flows state their caveats inline: key rotation for a purge,
offline-token validity for a user delete, and cooperative semantics for a device
revoke. The dashboard consumes only the API below.

Log in with an admin account (`add-admin`) to get a panel-signed session token.
Send it as `Authorization: Bearer <token>`. Admin credentials are Argon2id
verifiers stored in the panel-private `DATA_DIR/secrets/admins.json`, never in
the replicated database. Login attempts are rate-limited
(`LOCKOUT_THRESHOLD`/`LOCKOUT_SECONDS`).

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | **Unauthenticated** liveness check → `{up, uptimeSec, swarmConnections}`. It's cheap and synchronous, and served before the auth gate. Point uptime checks here. |
| `GET /metrics` | **Unauthenticated** Prometheus text: uptime, RSS/heap, swarm connections, plus [analytics](analytics.md) counters (`aliran_panel_logins_{ok,failed}_total`, `aliran_panel_sessions_issued_total`, `aliran_panel_catalog_channels{class}`). |
| `POST /api/login` `{username,password}` | → `{token, expiresAt}` |
| `GET /api/status` | Counts: users, streams, live, admins. Also `panelKey`, `serviceName`, and `pairingCode` — the [service pairing code](operator-guide.md#the-service-pairing-code) the panel derived at boot (`null` when the panel started without one) — plus `escrowExport`, which says whether the route below exists. |
| `POST /api/identity/escrow` `{password,passphrase}` | Exports the panel identity, **encrypted server-side** → `{filename, fingerprint, kdf, verified, escrow}`. `escrow` is the sealed envelope; no key material crosses the wire in the clear. The route **does not exist unless `ESCROW_EXPORT=1`** — it lowers identity theft from "shell access on the box" to "an admin session", so it is off by default. It re-checks the caller's password, permits 3 attempts per hour, records every attempt in the activity ring as a `security` event, and decrypts and verifies its own output before answering. See [key escrow](kb/backup-and-rotation.md#get-the-identity-off-the-box-key-escrow). |
| `GET /api/observability` | Uptime, memory, swarm peers, data size and disk free, plus the last-200 activity ring. The ring is in-memory, so a restart clears it. |
| `GET /api/analytics?days=N` | [Aggregate-only analytics](analytics.md) → `{enabled, retentionDays, days:[{date, hours:{H:{logins:{ok,failed}, sessions, onlineApps:{min,max,mean,samples}, catalog?}}, day:{uniqueViewers}}], current}`. UTC day rollups, default 7 and capped at the retention setting, plus the reduced in-progress hour. Counts only — never an identity. |
| `GET /api/reports?status&channel&category&since&limit` | [Pseudonymous viewer problem reports](reports.md) → `{enabled, reports:[{id, at, lastAt, count, reporter, category, text, channel, appVersion, platform, peers, events, status, ackAt, resolvedAt, note}]}`. `reporter` is a 16-hex HMAC pseudonym. It is **never** a username or device id. |
| `GET /api/reports/summary` | Badge and chart source → `{enabled, retentionDays, total, new, ack, resolved, openAlerts, shed, collapsed, byChannel, byCategory, byHour[24]}`. Counts only. |
| `POST /api/reports/:id/ack` · `POST /api/reports/:id/resolve` `{note?}` | Acknowledges or closes one report. The note is operator text; the panel strips control characters from it and caps its length. |
| `POST /api/reports/test-notify` | Sends a synthetic notification through the **real** configured targets → `{enabled, targets, results:[{target, ok, status?, attempts, error?}]}`. |
| `GET /api/alerts?status` | Correlation alerts → `{enabled, alerts:[{id, kind:'channel'\|'login', channel, categories, reporters, openedAt, lastAt, status, shedCount, sampled}]}`. The panel keeps one alert per channel per window, and extends it rather than firing a new one. |
| `POST /api/alerts/:id/ack` · `POST /api/alerts/:id/resolve` | Acknowledges or closes an alert. Resolving lets the next storm on that channel open a new alert. |
| `GET /api/users?prefix&after&limit` | → `{users, next}`. Supports prefix search and cursor paging — `next` is the `after` value for the following page. |
| `POST /api/users` | Creates a user (`{username,password}`). |
| `GET /api/users/:u` · `DELETE /api/users/:u` | Gets one user, or deletes the account record. |
| `GET /api/users/:u/devices` | Enrolled devices |
| `DELETE /api/users/:u/devices/:deviceId` | Drops one device enrollment. This is cooperative — it does not bump `tokenVersion`. |
| `POST /api/users/:u/password` | Rotates the password. This re-seals the user's grants. |
| `POST /api/users/:u/status` `{status}` | `active` or `disabled` |
| `POST /api/users/:u/logout-all` · `POST /api/users/:u/max-devices` | Session/device controls |
| `POST /api/users/:u/grants` `{streamId}` · `DELETE /api/users/:u/grants/:id` | Grants or revokes access. A revoke removes the manual grant only — if a package still covers the same stream id, the panel re-seals it in the same request. |
| `POST /api/users/:u/packages` `{packages:['basic',…]}` | Replaces the user's package list. Materializes sealed grants immediately. User summaries carry `packages` and `manualGrants` as provenance fields. |
| `GET/POST /api/streams` | Lists streams, or adds one. Add takes the `add-stream` fields plus `order`/`featured` and `url` — an https `url` creates a **redirect channel**. The response returns the encryption key once. |
| `PATCH /api/streams/:id` | Updates catalog metadata: `order` (0–9999 or `null`), `featured` (bool), `url` (an https value sets the redirect class, an empty value clears it), and `epgUrl`/`epgId` (https program-guide pointers the app fetches; empty clears them). |
| `DELETE /api/streams/:id` | **Full purge**: removes the catalog entry, the private key, every grant, and the art. See the deletion caveat above. |
| `POST /api/streams/:id/art/:kind` | Upload poster/backdrop/logo (raw image body) |
| `GET /api/assets/:id/:file` | Art bytes from the assets drive (for previews) |
| `GET/POST /api/admins` · `DELETE /api/admins/:name` | Manage admin accounts |
| `POST /api/admins/:name/password` | Rotates an admin password. This bumps `tokenVersion`, so their sessions end. |
| `GET/POST /api/publishers` · `DELETE /api/publishers/:name` | Enrolled broadcaster identities: list, enroll (`{name, scopes?}` — returns the site's `secretKey` once), or hard-delete. |
| `POST /api/publishers/:name/status` `{status}` | `active` or `revoked`. A revoked site's registrations bounce until it is re-activated. |
| `POST /api/publishers/:name/scopes` `{scopes}` | Replaces the site's streamId-glob scopes. Applies from its next register. |
| `GET/POST /api/sources` | Remote channel sources: list (with owned-channel counts and the last sync or error), or add (`{name,url,category,prefix?,autoGrant?,enabled?,intervalMs?}`). |
| `PATCH /api/sources/:name` | Edits any source field. `enabled:false` pauses the schedule. Changing `url` or `exclude` resets the ETag, so the next sync applies the change. |
| `GET /api/sources/:name/channels` | Imported and excluded entries — the channels-dialog data (`{feedId,id,title,order,excluded}`). |
| `DELETE /api/sources/:name` | Removes a source. Purges its channels, unless `?keepChannels=1` detaches them instead as manual redirect channels. |
| `POST /api/sources/:name/sync` | Pulls, diffs, and grants now → the sync report (`added/updated/removed/skipped/conflicts/granted/notModified`). |
| `GET/PATCH /api/vod-config` | External VOD provider: gets the replicated `svcmeta/vod` record (`null` when never configured), or partially merges `{enabled,apiBase,service,sources,params}`. `apiBase` must be https, with no query string and no embedded credentials. `sources` (`movies` and/or `series`) and `params` each replace their whole map. Setting `enabled:true` is refused unless `apiBase` and `service` are also set. Viewers pick up a change at their **next login**. |
| `GET/POST /api/packages` | Channel packages (bouquets): list (with resolved-channel and holder counts), or add (`{name,label?,members?,default?}` — members can be stream ids, id globs, `category:<slug>`, or `source:<name>`). |
| `GET /api/packages/:name` · `PATCH /api/packages/:name` | Gets one package with the ids it resolves to right now, or edits its label, members, or default flag. Member edits materialize immediately for every holder. |
| `DELETE /api/packages/:name` | Removes a package and strips it from users. Only the grants it covered are removed — manual grants and auto-grant source channels survive. |

## Broadcaster control API + UI (`CONTROL_ENABLED=1`)

The broadcaster process serves this API (default `127.0.0.1:3310`). Put TLS in
front of it if you expose it beyond loopback.

Opening the address in a browser loads the **control UI**
(`broadcaster/control-ui/`, plain HTML/JS). Sign in with a control admin to:

- Add or edit channels. The ingest-kind picker hides push kinds the host ffmpeg
  lacks. Per-channel transcode disables unusable encoders and shows the probe
  error as a tooltip.
- Start or stop a channel.
- Copy the **push URL** for a push channel straight off its card.
- Read the ffmpeg **log ring** in a dialog that refreshes every 2 seconds. The
  last lines also show inline on an unhealthy card.
- Watch live status.

State badges: **ON AIR**, **WAITING FOR PUBLISHER** (the push listener is idle —
normal), or **RETRYING (exit N)** (watchdog backoff). A channel whose source has
failed past `SLATE_AFTER` shows the offline slate. It still reports **ON AIR** —
it genuinely is, since the slate bars are flowing — but sets `slate.slated`.
Check that flag, not the state, to tell "showing the source" from "showing
bars." See [KB](kb/offline-slate.md).

Channel art is a panel admin operation, since the register RPC carries no art.
Upload it in the panel dashboard instead. The UI consumes only the API below.

Channels can be started and stopped at runtime; each has its own persisted feed
identity (`feedKey` plus an encryption key). Create admins with `node
src/control-cli.js add-admin <name>` — this stores Argon2id verifiers in the
local `DATA_DIR/secrets/admins.json`. Login returns a session token signed with
a broadcaster-local keypair, and login attempts are rate-limited. Starting a
channel spawns its ffmpeg pipeline, seeds the encrypted feed, and
auto-registers with the panel using publisher-key auth. When `PUBLISHER_NAME`
is set, the payload carries the enrolled identity and is subject to that site's
channel scopes. The env-configured channel (`STREAM_ID`) keeps the legacy
`DATA_DIR`-root store, so its existing feed identity is preserved.

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | **Unauthenticated** liveness and boot-resume progress → `{up, uptimeSec, resuming, resumed, total, failed, resumeSec}`. It's cheap and served before the auth gate, so monitoring can tell "up, resuming 45/83" from "dead" even while a mass resume keeps the rest of the API busy. Point uptime checks here, not at `/api/status`, which needs a token and does real work. |
| `POST /api/login` `{username,password}` | → `{token, expiresAt}` |
| `GET /metrics` | **Unauthenticated** Prometheus text: process stats, channel count, boot-resume progress, an incidents gauge, plus per-channel [analytics](analytics.md) lines from the last 5-minute sample — `aliran_broadcaster_channel_peers{stream_id}` (a **lower bound** on audience) and `aliran_broadcaster_channel_egress_bytes_total{stream_id}`. |
| `GET /api/status` | Channels, running count, panel configured |
| `GET /api/analytics?days=N` | [Aggregate-only analytics](analytics.md) → `{enabled, retentionDays, days:[{date, hours:{H:{channels:{id:{peers:{min,max,mean,samples}, egressBytes, respawns}}, incidents}}}], current}`. Per-channel UTC day rollups plus the in-progress hour. Stream ids and counts only — never a peer key or IP. |
| `GET /api/capabilities` | ffmpeg probe: input protocols plus deep-verified encoders (`{listed,verified,error?}`). |
| `GET/POST /api/channels` | Lists channels with live status, or adds one (`{id,title,category,input,transcode,buffer,…}`). |
| `GET /api/channels/:id` | Status: `state` (`stopped·starting·up·waiting-input·backoff`), `running`, `ffmpegUp`, `peers`, `registered`, `playlist`, `watchdog`, and `slate` (`{slated,file,since,failures}` — `slated:true` means viewers see the offline slate, not the source, even when `state` is `up`). Also `detectedProfile` (`{codec,width,height}`, the profile the slate matches against) and `ingest.pushUrl` (push kinds; uses `PUBLIC_HOST`). |
| `PATCH /api/channels/:id` | Edits metadata, input, or transcode settings. Changes apply on the next start; a source change also rotates the feed identity. |
| `DELETE /api/channels/:id` | Removes the channel from the registry. It must be stopped first; its data is kept. |
| `POST /api/channels/:id/start` · `…/stop` | Spawn / tear down the pipeline |
| `POST /api/channels/:id/rotate` | Disk mode only: mints a fresh feed generation now, which bounds merkle-tree growth. ffmpeg keeps running, watching viewers follow the new `feedKey` live, and the retired generation's cores are purged after a grace window. See [feed buffer](kb/feed-buffer.md). |
| `GET /api/channels/:id/logs?lines=N` | ffmpeg stderr ring → `{lines:[{t,line}], running, restarts, state}` (at most 400 lines). An operator start clears the ring; watchdog respawns don't. |
| `GET /api/incidents` | Correlated incident log: fleet-wide respawn bursts and per-source outage windows detected across channels — the pattern a lone per-channel restart counter can't show. |
| `GET/POST /api/admins` · `DELETE /api/admins/:name` | Manage control admin accounts |
| `POST /api/admins/:name/password` | Rotates an admin password. This revokes their sessions. |

## Library control API + UI (`CONTROL_ENABLED=1`)

The **library** process — the standalone VOD service — serves this API (default
`127.0.0.1:3320`). Put TLS in front of it if you expose it beyond loopback.

Opening the address loads the minimal control UI (`library/control-ui/`). Sign
in with a control admin — created with `node src/library-cli.js add-admin
<name>`, the same auth skeleton as the broadcaster's — to add titles, watch
ingest progress, read logs, re-ingest, and delete.

A **title** is a one-shot ingest. The library probes the input, then either
remuxes it with `-c copy` when the codecs are HLS-compatible, or transcodes it
to h264/aac. The result is a finished HLS VOD rendition in its own encrypted
Hyperdrive, with all segments kept. The title then seeds persistently and
registers with the panel as `type:'vod'` plus `durationSec`, under the
library's own enrolled publisher.

Inputs must have a **finite duration** — files, not live streams. Disk use
equals the sum of title sizes, and only a delete reclaims it.

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | **Unauthenticated** liveness → `{ok, titles, ready, ingesting, queued, error, panelLink:{connected,pendingOps,…}}`. It's cheap and synchronous, and answers even mid-transcode. |
| `POST /api/login` `{username,password}` | → `{token, expiresAt}` |
| `GET /metrics` | **Unauthenticated** Prometheus text: process stats, title-state counters, panel-link connected/pending. |
| `GET /api/status` | Titles summary, publisher, panel key, swarm connections |
| `GET/POST /api/titles` | Lists titles (with ingest progress, peers, and registered status), or adds one and queues its ingest (`{id, input, title?, description?, category?, protection?, mode?, hlsTime?}`). `mode` is `auto` (default), `copy`, or `transcode`. `input` is a path on the library box, or any URL ffmpeg can read. |
| `GET /api/titles/:id` | Registry view: `state` (`queued·ingesting·ready·error`), `ingest:{phase,pct}`, `feedKey`, `durationSec`, `segments`, `bytes`, `peers`, `registered`, `registerError`. |
| `PATCH /api/titles/:id` | Edits `input`, `mode`, or `hlsTime` only. Descriptive metadata is panel-owned after creation. |
| `POST /api/titles/:id/ingest` | Re-ingests the title (optional `{input}`). Mints the next feed generation — a fresh `feedKey`, with old cores purged — and viewers pick it up at their next tune-in. |
| `DELETE /api/titles/:id` | Stops seeding and purges the title's cores and key from this box. Refused mid-ingest. Registers `status:'unavailable'` — remove the catalog record and grants in the panel separately. |
| `GET /api/titles/:id/logs?lines=N` | The ingest's ffmpeg/log ring → `{lines, state, ingest}`. |
| `GET/POST /api/admins` · `DELETE /api/admins/:name` · `POST /api/admins/:name/password` | Manage control admins (same shapes as the broadcaster's) |

Env config (`library/.env`): `DATA_DIR`, `PANEL_PUBKEY`, `PUBLISHER_NAME` +
`PUBLISHER_KEY` (enroll the library as its own publisher, scoped to its title
ids), `HLS_TIME` (VOD segment length, default 4 s), `INGEST_CONCURRENCY`
(default 1 — transcodes are 0.5–1 core each), `SWARM_MAX_PEERS` (default 256),
`SWARM_RCVBUF_MB`/`SWARM_SNDBUF_MB` (default 4/4 — a seeder is send-dominant),
`CONTROL_ENABLED`/`CONTROL_HOST`/`CONTROL_PORT`/`CONTROL_SESSION_TTL_HOURS`,
`LOCKOUT_*`, `ARGON2_*`, `BOOTSTRAP`.

## Reseller panel API

The **reseller** process — the standalone role-hierarchy and credit panel that
fronts the panel admin API — serves this API (default `127.0.0.1:3330`). Put
TLS in front of it if you expose it, and add an IP allowlist, since third
parties use this service.

Opening the address loads the control UI (`reseller/control-ui/`). Sign in as a
principal — the root admin is seeded with `node src/reseller-cli.js add-admin
<name>`. Every account mutation becomes a call to the panel admin API, gated by
the signed-in principal's role and credit balance. Concepts, topologies, and
the bootstrap walkthrough are in [Reseller panel](reseller-panel.md).

Roles, from highest to lowest: `admin` (root — mints credits, the sole
co-admin manager), `co-admin` (an admin clone), `super`, `reseller`. Errors:
`403` for a capability or scope denial, `402` for insufficient credits,
`404`/`409` as the panel returns them, and panel failures surface with a
`PANEL:` prefix (`502` when the panel is unreachable).

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | **Unauthenticated** liveness → `{ok, principals, accounts, panel:{reachable,lastOkAt}, sweep, ledger:{seq,invariantOk}}`. |
| `GET /branding.json` · `GET /branding.css` · `GET /branding/logo\|favicon\|login-bg` | **Public** white-label surface: `{name, accent, logo, favicon, loginBg, loginStyle}`, the operator's theme-token overrides (layered after the shared theme block), and the logo/favicon/login-backdrop images. Configured with `BRAND_*` env vars, including `BRAND_LOGIN_BG_FILE` and `BRAND_LOGIN_STYLE` (`glow`, `plain`, `grid`, `dots`, or `stripes`). See the [manual](white-label.md#reseller-panel-dashboard). |
| `POST /api/webhooks/credits` | **HMAC-authenticated** (no Bearer token) automated top-up: `{id, to, amount, note?}`. Sign it as `x-topup-signature` = hex HMAC-SHA256(`WEBHOOK_SECRET`, `"<ts>.<raw body>"`), plus `x-topup-timestamp` (within ±300 seconds). It's idempotent by `id` — a retry returns `{duplicate:true}`. A successful call mints a `MINT` ledger line with actor `webhook`. Returns `404` when no secret is configured. |
| `POST /api/login` `{username,password}` | → `{token, expiresAt, role}`. Rate-limited, and single-flight. |
| `GET /api/me` · `POST /api/me/password` | Gets your own record, balance, and trials used today, or rotates your own password. |
| `GET /metrics` | **Unauthenticated** Prometheus text: process stats, principals/accounts, panel reachability, and a ledger seq plus invariant gauge. |
| `GET /api/status` | Role-scoped KPIs: balance, and active/expiring/trial counts. Admins also get principals, outstanding credits, panel reachability, and the last reconcile. |
| `GET /api/panel/status` · `GET /api/streams` · `GET /api/packages` | Passthrough of the panel status (admins only), the catalog, or channel packages, including resolved-channel and holder counts. Any authenticated role can call these; the catalog and packages responses are cached for 60 seconds, for the activate pickers. |
| `GET /api/system` | **Admin tiers only.** Operator diagnostics for the System section of the UI's Overview: `{service:{node,pid,uptimeSec,rssBytes,heapUsedBytes,dataDir,sweeps,ledger}, host:{hostname,platform,release,arch,cpuModel,cpuCount,loadavg,totalMemBytes,freeMemBytes,uptimeSec,disk:{totalBytes,freeBytes}}, panel:{url,reachable,lastOkAt,lastError,latencyMs,stats:{panelKey,users,streams,live,admins},error}}`. The panel block is a **live timed probe** — when the panel is down, it fills `error` instead of failing the whole request. |
| `GET/POST /api/principals` | Lists principals (scoped to what you can see), or creates one (`{username,password,role,maxDevicesLimit?,trialDailyCap?,note?}`). The new principal's parent is you. |
| `GET/DELETE /api/principals/:name` | Views or deletes a principal. Delete is refused while the principal still has child principals or accounts. Its remaining balance is reclaimed to you. |
| `POST /api/principals/:name/password\|status\|limits` | Rotates a principal's password; suspends or resumes it (`{status, mode:'panel-only'\|'with-accounts'}`); or sets its limits (`{maxDevicesLimit,trialDailyCap}`). `maxDevicesLimit` is the **admin-set device policy** — only admin tiers can set it, `null` means inherit the parent chain, and supers may only tune `trialDailyCap`. Views report the effective value plus `maxDevicesLimitInherited`. |
| `POST /api/credits/mint\|transfer\|reclaim\|adjust` | Mints credits (admin tiers only), funds a child principal, pulls credits back, or makes a correction (a note is required). Returns `402` when a debit would exceed the balance. |
| `GET /api/ledger?principal&account&type&before&limit` | Append-only credit ledger, newest first. `before` is a seq cursor. Non-admins see only themselves and their subtree. |
| `GET/POST /api/accounts` | Lists accounts, using a server-side query engine built for large registries: `?q` (case-insensitive substring over name and owner), `&filter=active\|disabled\|expiring\|trial`, `&owner`, `&sort=name\|expires\|created\|status\|owner`, `&dir`, `&offset`, `&limit` (default 50, capped at 500) → `{items, total, offset, limit}`. Or activates an account (`{name,password,months,maxDevices?,grants?,packages?}`) — a plain panel username, first come first served. Only admin tiers may pass `maxDevices` (`403` otherwise); accounts receive the creator's inherited device policy. `packages` (bouquet names, no credit impact) **replace** the panel's `default` packages when passed. |
| `GET/DELETE /api/accounts/:acct` | Views an account (with live panel state, including `packages` and `manualGrants` provenance), or deletes one. Deleting refunds `floor(remaining months)` to the owner — unless an admin deletes it, which refunds nothing. |
| `POST /api/accounts/:acct/renew\|status\|password\|max-devices\|grants\|packages\|logout-all` | Renews an account from `max(now,expiry)`, which converts a trial to paid; suspends or resumes it; sets its password; sets its device limit (admin tiers only — a per-account policy override); adds a grant; replaces its bouquets (`{packages:[names]}`, panel-validated, and re-asserted by the reconcile sweep if it drifts); or drops all its sessions. |
| `DELETE /api/accounts/:acct/grants/:streamId` · `GET/DELETE /api/accounts/:acct/devices[/:id]` | Removes a one-off grant — the response carries `stillGranted: true` when a covering package re-seals the channel in the same request — or lists and revokes devices. |
| `POST /api/trials` | `{name,password,maxDevices?}` → a free, time-boxed trial, subject to a per-reseller daily cap. |
| `POST /api/ops/sweep` · `GET/POST /api/ops/reconcile` | Runs the expiry sweep now, or reads/runs the reconcile (admin tiers only). |

Env config (`reseller/.env`): `DATA_DIR`, `PANEL_ADMIN_URL` + `PANEL_ADMIN_USER`/
`PANEL_ADMIN_PASS` (the dedicated panel admin) + `PANEL_TIMEOUT_MS`,
`DAYS_PER_MONTH`, `TRIAL_HOURS`, `TRIAL_DAILY_CAP_DEFAULT`,
`MAX_DEVICES_LIMIT_DEFAULT`, `SWEEP_INTERVAL_SEC`, `RECONCILE_INTERVAL_SEC`,
`RECONCILE_REPAIR`, `CONTROL_HOST`/`CONTROL_PORT`/`CONTROL_SESSION_TTL_HOURS`,
`LOCKOUT_*`, `TRUST_PROXY_HEADER` (use only behind a trusted proxy or tunnel —
for example `cf-connecting-ip` for Cloudflare Tunnel, or `x-forwarded-for` for
Caddy/nginx. This keys the login lockout on the proxied client IP instead of
the proxy's own socket), `BRAND_NAME`/`BRAND_LOGO_FILE`/`BRAND_FAVICON_FILE`/
`BRAND_LOGIN_BG_FILE`/`BRAND_LOGIN_STYLE`/`BRAND_THEME_FILE` (white-label — see
[the manual](white-label.md#reseller-panel-dashboard)),
`WEBHOOK_SECRET` (enables the top-up webhook), `ARGON2_*`.

## MCP server tool catalog

The [MCP server](mcp.md) (`@aliran/mcp`, local stdio) registers one tool per
admin operation. `R` marks `readOnlyHint`; `D` marks `destructiveHint` — a
well-behaved client confirms with you before running a `D` tool. Only the
groups whose backend the config enables get registered.

| Group | Tools |
|---|---|
| `panel_*` (reads, `R`) | `panel_status`, `panel_observability`, `panel_analytics`, `panel_list_users`, `panel_get_user`, `panel_list_devices`, `panel_list_streams`, `panel_list_packages`, `panel_get_package`, `panel_list_sources`, `panel_source_channels`, `panel_list_categories`, `panel_vod_config`, `panel_list_publishers`, `panel_list_reports`, `panel_list_alerts`, `panel_list_admins` |
| `panel_*` (writes) | `panel_create_user`, `panel_set_user_password`, `panel_set_user_status`, `panel_set_max_devices`, `panel_logout_all`, `panel_grant`, `panel_set_user_packages`, `panel_add_stream`, `panel_set_stream_meta`, `panel_set_stream_art`, `panel_add_package`, `panel_set_package`, `panel_add_source`, `panel_set_source`, `panel_sync_source`, `panel_set_category`, `panel_rename_category`, `panel_set_vod_config`, `panel_add_publisher`, `panel_set_publisher_scopes`, `panel_set_publisher_status`, `panel_ack_report`, `panel_resolve_report`, `panel_test_notify`, `panel_add_admin`, `panel_set_admin_password` |
| `panel_*` (purges, `D`) | `panel_delete_user`, `panel_revoke_device`, `panel_revoke_grant`, `panel_delete_stream`, `panel_delete_package`, `panel_delete_source`, `panel_merge_categories`, `panel_delete_category`, `panel_remove_publisher`, `panel_remove_admin` |
| `broadcaster_*` | `broadcaster_health` `R`, `broadcaster_status` `R`, `broadcaster_capabilities` `R`, `broadcaster_list_channels` `R`, `broadcaster_get_channel` `R`, `broadcaster_channel_logs` `R`, `broadcaster_incidents` `R`, `broadcaster_analytics` `R`, `broadcaster_list_admins` `R`, `broadcaster_add_channel`, `broadcaster_update_channel`, `broadcaster_start_channel`, `broadcaster_add_admin`, `broadcaster_set_admin_password`, `broadcaster_stop_channel` `D`, `broadcaster_rotate_channel` `D`, `broadcaster_remove_channel` `D`, `broadcaster_remove_admin` `D` |
| `reseller_*` (optional) | `reseller_status` `R`, `reseller_system` `R`, `reseller_list_principals` `R`, `reseller_get_principal` `R`, `reseller_ledger` `R`, `reseller_list_accounts` `R`, `reseller_get_account` `R`, `reseller_trials` `R`, `reseller_ops_status` `R`, `reseller_add_principal`, `reseller_set_principal_password`, `reseller_set_principal_limits`, `reseller_grant_credits`, `reseller_set_principal_status` `D` |
| `library_*` (optional) | `library_status` `R`, `library_list_titles` `R`, `library_get_title` `R`, `library_title_logs` `R`, `library_add_title`, `library_set_title`, `library_reingest_title` `D`, `library_delete_title` `D` |
| `server_*` (SSH executor) | `server_preflight` `R`, `server_status` `R`, `server_logs` `R`, `server_disk` `R`, `server_list_backups` `R`, `server_backup`, `server_set_env` `D`, `server_restart` `D`, `server_restore` `D`, `server_sysctl` `D`, `server_update` `D` (`dryRun:true` previews), `server_install` — every tool (except `server_install`) takes `host:"<name>"` for a box named in `ssh.hosts` |
| `repeater_*` | `repeater_status` `R` — SSH-shaped (the repeater has no admin API by design): compose state + logs + the opt-in loopback `/metrics` when `STATUS_PORT` is set on the box |
| `diagnose_*` | `diagnose_healthz` `R`, `diagnose_symptom` `R` |
| resources | `docs_search` `R` + every `docs/`+`docs/kb/` file as `mcp://aliran/docs/<path>`, plus `mcp://aliran/guide` |

The server also registers **MCP prompts** — guided runbooks that name the exact
tools for a multi-step job:

| Prompt | Runbook |
|---|---|
| `new-site-install` | preflight → install → verify → first channel → first viewer |
| `onboard-a-reseller` | enroll a principal → mint credits → verify the ledger → the oversight boundary |
| `migrate-a-channel-source` | remote-source path (add → curate → sync → verify) and broadcaster-pull path (update → stop/start → verify) |
| `monthly-maintenance` | update dry-run → backup → update → disk + analytics review → admin hygiene → viewer-report triage + a notification test |
| `incident-triage` | healthz sweep → what viewers reported → localize (logs/incidents) → symptom → KB → fix or escalate (takes an optional `symptom` argument) |
| `expose-dashboards` | publish the dashboards behind Caddy TLS per the KB, then repoint the MCP config at the https urls |

The control API is off unless `CONTROL_ENABLED=1`. A `broadcaster_*` tool that
can't reach it says so (`server_install` sets this flag for you). Secrets
minted server-side, such as `PUBLISHER_KEY`, are written into the box's `.env`
file and never returned to the model.

`server_set_env` only upserts documented, allowlisted env knobs. It refuses
secret or identity keys — `PUBLISHER_KEY`, `PANEL_PUBKEY`, `WEBHOOK_SECRET`,
`REPORTS_TELEGRAM_BOT_TOKEN`, and `REPORTS_WEBHOOK_URL` (an ntfy/Slack/Discord
webhook url carries its credential in the path, so it counts as a secret too —
see [Viewer problem reports](reports.md#enabling-notifications)). Before
anything restarts, the tool dry-runs the new `.env` through `node
src/config.js --check` in the built image, since every service config is
fail-fast at boot. A validation failure reverts the file and surfaces the
exact problem list. On success, the change applies via a plain `docker compose
up -d <service>` — a compose `restart` does not re-read env files, which is
also why `server_restart` (the `server_sysctl` follow-up) documents itself as a
process bounce only. `server_restore` wraps `deploy/restore.sh`: it refuses a
non-empty volume or a name-mismatched archive unless you pass `force`, and it
echoes exactly what it overwrote and from which archive. Rotating or removing
the admin account the MCP itself logs in with requires updating the operator's
local mcp config afterward.

Multi-host and ergonomics behaviors worth knowing: **multi-host** — `ssh.hosts` names extra boxes
(repeaters, scale-out broadcasters; each entry may carry its own `keyPath`/
`port`/`repoDir`), the `host` parameter routes a tool there, and
`panel_add_publisher {host}` writes the minted `PUBLISHER_KEY` into **that**
box's `broadcaster/.env` (the key still never transits the model). **List
ergonomics** — `panel_list_streams` gained client-side `category`/`prefix`/
`idsOnly`/`limit` filters (the no-argument call still returns the raw
catalog), and every user-shaped result summarizes grant lists longer than 12
ids to `{count, sample}`, with `full:true` restoring every id
(`panel_revoke_grant` additionally reports `stillGranted` when a package
re-sealed the stream). **Schema gaps closed** — `broadcaster_add_channel`/
`_update_channel` take `hlsTime` (1-30) / `hlsListSize` (2-60); `panel_add_stream`
takes `feedKey` + `key` for pre-seeded feeds (a **supplied** `key` is stored
panel-side and redacted from the result; an omitted one is generated and
returned once), and `panel_set_stream_meta` takes `feedKey`.

Content-curation behaviors worth knowing: `panel_rename_category` / `panel_merge_categories`
rewrite the category tag across every catalog record (a package's `category:`
member selector is a string, re-resolved after the move — update it to the new
slug), and `panel_delete_category` drops only the registry entry, keeping
membership. `panel_set_source`'s `exclude` change resets the source ETag so
the next sync re-diffs the full feed. `panel_set_stream_art` reads the image
from the **operator's machine** and posts raw bytes (at most 10 MiB, image
extensions only) — never base64 through the model. `reseller_grant_credits`
echoes the ledger line it appended (seq/actor/principal/amount/new balance);
reseller **daily driving** (activate/renew) is deliberately unwrapped — that
lives in the resellers' own panel. `library_add_title`'s `input` is a path
**on the library box**; `library_delete_title` purges the box but only marks
the panel record `unavailable` (purge that separately with
`panel_delete_stream`).

`broadcaster_add_channel` / `broadcaster_update_channel` take `input` as either
a shorthand string (`"test"`, `"rtmp"`, a pull url, a file path) or a typed
object (`{kind:"pull",url,fallbacks?}`, `{kind:"file",path}`, `{kind:"test"}`,
`{kind:"rtmp"|"srt"|"udp",port?,…}`). They take `transcode` as an object, or
`null` to clear it. Pass both as real objects, not as quoted JSON strings: a
stringified object is parsed back where possible, and rejected with a `400`
where it can't be — it is never stored as a literal file path (that fallback
used to leave a channel with no working source behind an HTTP 200).

## Panel RPC (over Hyperswarm)

- `hello` → a proof-of-work challenge plus its difficulty (pre-login).
- `login(username, blinded, powNonce)` → a blinded OPRF evaluation. This is
  throttled; the panel never sees the password or the result.
- `session(username, deviceId, signature, …)` → device enrollment plus a
  panel-signed session token. This enforces `maxDevices` and evicts the oldest
  device when needed; revocation happens via `tokenVersion`.
- `register(payload, sig)` → a broadcaster publishes or updates a catalog
  record, authenticated with Ed25519. The encryption key is stored
  panel-private — never in the catalog. A payload carrying `publisher:
  "<name>"` verifies against that enrolled site's own public key
  (`add-publisher`), and its `streamId` must match the site's channel scopes
  before anything is written. Rejections are `unknown-publisher`, `revoked`,
  or `out-of-scope` (or `unauthorized` for a bad signature), and they surface
  verbatim as the channel's `registerError` in the broadcaster control UI. An
  accepted named register stamps `origin: "<name>"` on the record. A payload
  without `publisher` verifies instead against the legacy shared key from
  `init` (implicit scope `*`), as long as `LEGACY_PUBLISHER=1` (the default) —
  set it to `0` once every site is enrolled. **Descriptive metadata is
  panel-authoritative**: a register only sets `feedKey` plus `isLive` (live)
  or `feedKey` plus `durationSec` (vod) on an existing record. It seeds
  `title`/`description`/`category` only when it first creates the record, and
  never overwrites them after — the admin owns them, the same as art, EPG,
  curation, and the redirect class. To rename or recategorize a P2P channel or
  a title, edit it in the panel, not the broadcaster/library config.

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
  "epgId": "demotv.es.629…",   // source imports: this channel's id INSIDE that feed
  "status": "live"
}
```

> **VOD titles**: a record with `type:'vod'` is a **library** title — a
> finished HLS VOD rendition in its own encrypted drive, registered over the
> same `register` RPC with `durationSec` in the payload. The class differs in
> exactly two fields: `durationSec` (payload-owned, like `feedKey` — the
> library measures it at ingest), and no `isLive` (liveness is not a property
> a title has; clients must not read liveness into vod records). The `status`
> vocabulary is `'available'` (seeding) or `'unavailable'` (the library
> deleted the title; the record stays admin-owned until removed in the
> panel). Grants, sealing, `blobsKey` enrichment, art, curation, and
> categories work identically for both classes.

> **Redirect channels**: a record with `{redirect: true, url: "https://…"}` is
> a different *class* of entry. Viewers play the operator's URL **directly**,
> instead of a P2P feed — `feedKey` stays `null`, and the panel rejects mixing
> the two. Set or clear it via the `url` field on `POST`/`PATCH /api/streams`,
> or the dashboard's "Redirect URL" input (the CLI does not expose it). A
> broadcaster re-register never erases the class. Details:
> [content-management.md](content-management.md).

> **`source` / `epgUrl` / `epgId`**: stamped on records imported by a remote
> channel source. `source` is the ownership mark — a sync may only touch
> records carrying **its** name, and detaching or removing the source strips
> or purges them. The epg fields point back to the feed, so a client can
> fetch the schedule over https on demand. The apps render it as the Info
> panel's Now/Next guide, using the shared EPG layer in
> `@aliran/react-native`. The registry (nothing secret) lives in
> `DATA_DIR/sources.json`; see [content-management.md](content-management.md).

> The stream's content **encryption key is not in the catalog**. It is kept
> in a panel-private, non-replicated secrets file
> (`DATA_DIR/secrets/streams.json`), and delivered per-user via
> `user.wrapped[streamId]`.

> **`origin`**: which enrolled publisher's key signed the record's most
> recent register — the audit trail behind the origin chip in the panel
> dashboard. A legacy (shared-key) register writes `null`, since attribution
> never guesses. Clients ignore the field. Publisher enrollments themselves
> live panel-private, in `DATA_DIR/secrets/publishers.json` (public keys and
> scopes only — the site keeps its own secret). See
> [security-model.md](security-model.md).

> **`blobsKey`**: the feed drive's blobs-core key, published so keyless
> repeater or seed nodes can mirror the **encrypted** video blocks. The blobs
> core is a named core whose key lives inside the drive's encrypted header,
> so it is not derivable from `feedKey` alone. The panel fills this field
> **asynchronously** after a register: it opens the drive with its stored
> encryption key, reads the header, and writes the key back
> (`panel/src/blobs-key.js`) — the register RPC never waits on this. The
> field is cleared and re-filled whenever a register rotates `feedKey`.
> Publishing it is safe: it only enables ciphertext replication, and watching
> still requires a per-user sealed grant key.

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
