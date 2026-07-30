# Configuration Reference

Every operator-specific value lives in configuration — an env file or a config
file. Nothing is hardcoded. Copy each component's `.env.example` to `.env` to
start.

Every service shares two behaviors:

- **Fail-fast validation.** A typo'd value — a bad integer, an out-of-range
  port, a malformed key or URL — produces a startup error. The error names the
  exact variable; the service never falls back silently. If a service exits
  right after a config change, read its first log lines. Before you restart,
  dry-run the change with check-config mode. This mode prints the same problem
  list and exits 0 or 1, without booting anything. (The [MCP's](mcp.md)
  `server_set_env` tool runs this check for you before every restart.)

    ```sh
    docker compose run --rm panel node src/config.js --check
    ```

- **`LOG_FORMAT=json`.** This opts in to structured logs: one `{ts, level,
  svc, msg}` JSON object per line, for log shippers like Loki, ELK, or
  CloudWatch. Leave it unset to keep the normal human-readable log lines.

## Panel (`panel/.env`)

| Key | Default | Description |
|-----|---------|-------------|
| `DATA_DIR` | `./data` | Where the panel stores its Corestore and keys. Gitignored. |
| `RELAY_ONLY` | `false` | Route traffic through DHT relays to hide the panel's origin IP. |
| `SERVICE_NAME` | `Aliran` | Your service name. The app shows it while a viewer pairs with the [service pairing code](operator-guide.md#the-service-pairing-code), before the viewer signs in. Public display text only. |
| `ARGON2_MEM_KIB` | `262144` | Argon2id memory cost, in KiB (about 256 MB). |
| `ARGON2_TIME` | `3` | Argon2id time cost, in iterations. |
| `MAX_DEVICES_DEFAULT` | `2` | Default number of concurrent devices allowed per user. |
| `SESSION_TTL_DAYS` | `30` | Session and token lifetime, in days. Long by design. |
| `POW_DIFFICULTY` | `16` | Login proof-of-work difficulty, in bits. |
| `LOCKOUT_THRESHOLD` | `10` | Failed login attempts allowed before lockout. |
| `LOCKOUT_SECONDS` | `900` | Lockout duration, in seconds. |
| `LEGACY_PUBLISHER` | `1` | Accept unnamed broadcaster registrations signed with the shared `init` publisher key. Set this to `0` once every broadcaster site is enrolled with `add-publisher`. This restricts registration to named, scoped identities only. |
| `ADMIN_ENABLED` | `false` | Serve the admin HTTP API from the panel process. |
| `ADMIN_HOST` | `127.0.0.1` | Admin API bind address. Put TLS in front if this isn't loopback. |
| `ADMIN_PORT` | `3210` | Admin API port. |
| `ADMIN_SESSION_TTL_HOURS` | `12` | Admin session token lifetime, in hours. |
| `ESCROW_EXPORT` | `0` | Serve `POST /api/identity/escrow`, which exports the panel keys encrypted. **Off by default**: it lowers identity theft from "shell access on the box" to "an admin session plus a password". The route answers 404 while this is off. The CLI export (`admin-cli export-escrow`) needs shell access, so it always works. See [key escrow](kb/backup-and-rotation.md#get-the-identity-off-the-box-key-escrow). |
| `ESCROW_ARGON2_MEM_MIB` / `ESCROW_ARGON2_OPS` | `256` / `3` | Argon2id cost for an **exported escrow file**. That file lives outside every control this box has, and the passphrase is its only protection — raise this if the box can take it. You pay the cost once per export, in a worker thread. The values travel inside each file, so an older file always opens with its own. |
| `ANALYTICS_RETENTION_DAYS` | `90` | How many days of [aggregate-only analytics](analytics.md) rollups the panel keeps, under `DATA_DIR/analytics/`. **Set this to `0` to disable collection entirely** — the panel writes no files, and its endpoints answer empty. |
| `REPORTS_RETENTION_DAYS` | `30` | How many days of [viewer problem reports](reports.md) the panel keeps, under `DATA_DIR/reports/`. **Set this to `0` to disable the feature entirely** — the panel writes no files, and it stops serving the `report` RPC method. |
| `REPORTS_MAX_PER_WINDOW` / `REPORTS_WINDOW_SECONDS` | `5` / `600` | How many reports one reporter can send in the given window, in seconds. |
| `REPORTS_ALERT_COUNT` / `REPORTS_ALERT_WINDOW_MIN` | `3` / `10` | How many distinct reporters on one channel, within the given window in minutes, open a correlation alert. |
| `REPORTS_STORM_SAMPLE` | `20` | How many full report records the panel stores once an alert is open for a channel. Reports after that only increment a tally. |
| `REPORTS_GLOBAL_PER_MIN` | `120` | Panel-wide ingest limit. Past this rate, the panel acknowledges reports, counts them as `shed`, and drops them. |
| `REPORTS_WEBHOOK_URL` | *(empty)* | Webhook for ops notifications. One request body works for ntfy, Slack, and Discord. **This is a secret** — the credential lives in the URL path. Set it on the box by hand; never set it through the MCP. See [recipes](reports.md#enabling-notifications). |
| `REPORTS_TELEGRAM_BOT_TOKEN` / `REPORTS_TELEGRAM_CHAT_ID` | *(empty)* | Telegram bot target. Set both, or neither. **The token is a secret.** |
| `SOURCES_SYNC_INTERVAL_MS` | `86400000` | Default pull interval per source, in milliseconds (one day). Override per source with `intervalMs`. |
| `SOURCES_TICK_MS` | `3600000` | How often the scheduler checks which sources are due for a pull. This is a check, not a fetch. |
| `SOURCES_BOOT_DELAY_MS` | `15000` | Delay before the first due-check after the panel boots. |
| `SOURCES_FETCH_TIMEOUT_MS` | `30000` | HTTP timeout for one source pull. |
| `SOURCES_MAX_BYTES` | `5242880` | Maximum feed size the panel accepts. Enforced while streaming the download. |
| `SOURCES_MAX_CHANNELS` | `500` | Maximum entries the panel imports from one source. The panel truncates the feed beyond this. |
| `SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB` | `2` / `2` | Swarm UDP socket buffers, in MB (`0` uses the OS default). Every client replicates the catalog over this one swarm. **This only takes effect if the host allows it** — the OS clamps it to `net.core.{r,w}mem_max`. The optional `deploy/sysctl/install.sh` script raises that ceiling. See the [KB](kb/network-tuning.md). |
| `BOOTSTRAP` | *(empty)* | Custom DHT bootstrap nodes. Optional. |
| `BACKUP_DIR` | `./backups` | Where the dashboard's Backup page looks for [recovery archives](kb/backup-and-rotation.md#four-files-four-jobs). The shipped compose file mounts the host `./backups` here **read-only** and sets this to `/backups` — leave it unset there. The page can only list: a cold backup stops the service, so archives are made on the box with `deploy/backup.sh`. |
| `CONFIG_SNAPSHOT_KEEP` | `20` | How many on-box [config snapshots](kb/backup-and-rotation.md#four-files-four-jobs) the service keeps under `DATA_DIR/config-snapshots/`. It takes one by itself before a destructive change and before every restore or import; the oldest past the cap are removed. |

## Broadcaster (`broadcaster/.env`)

| Key | Default | Description |
|-----|---------|-------------|
| `DATA_DIR` | `./data` | Where the broadcaster stores its Corestore and drive keys. |
| `PANEL_PUBKEY` | *(required)* | The panel to register the stream with. |
| `PUBLISHER_KEY` | *(required)* | The publisher secret that signs `register` RPCs. Use a per-site key from the panel's `add-publisher` command — recommended when you run more than one broadcaster — or the shared legacy key from `init`. |
| `PUBLISHER_NAME` | *(empty)* | The enrolled publisher identity that matches `PUBLISHER_KEY`. When you set this, registrations verify against this site's own key and are limited to its admin-assigned channel scopes; the catalog also gets `origin:<name>` attribution. Leave it empty to use the legacy shared-key path. |
| `STREAM_ID` | *(optional)* | The catalog id for the legacy env-configured channel. In a multi-channel setup, add channels through the control API or UI instead. |
| `INPUT` | *(with `STREAM_ID`)* | One of: `test`, a file path, a pull URL (`rtsp://`, `rtmp://`, `srt://`, or `http…m3u8`), or a push listener type (`rtmp`, `srt`, or `udp`). The control API accepts these as typed objects. |
| `RTMP_PORT` | `1935` | When `INPUT=rtmp`, the port OBS pushes to. |
| `PUBLIC_HOST` | *(empty)* | The hostname shown in operator-facing push URLs (`rtmp://<PUBLIC_HOST>:<port>/…`). |
| `INGEST_PORT_BASE` / `INGEST_PORT_MAX` | `5000` / `5999` | The port range the broadcaster auto-allocates for push ingest. Each channel gets a validated, unique port in this range. |
| `HLS_TIME` | `2` | Segment duration, in seconds. Shorter means a faster time to first frame. |
| `HLS_LIST_SIZE` | `8` | Rolling playlist window, in segments. Use 12–16 for large swarms. |
| `FFMPEG_MAX_RSS_MB` | `150` | Memory threshold, in MB, that recycles a running ffmpeg process. The broadcaster restarts ffmpeg once its VmRSS plus VmSwap crosses this. This bounds a slow memory buildup that some live-HLS upstreams cause in the demuxer. It uses the same watchdog backoff as a stalled-edge respawn, and does not rotate the feed. `0` disables this check. Linux only — it reads `/proc`. |
| `FEED_BUFFER` | `disk` | `disk` gives the feed a stable identity and a warm DHT topic, so joins are faster. `ram` keeps the disk byte-flat, but discovery starts cold on every restart. See the [KB](kb/feed-buffer.md). |
| `RESUME_PACE` | `true` | Paces the boot auto-resume. Between channel starts, the broadcaster waits until its event loop catches up, so the control API and swarm stay responsive during a mass restart. Without this, recreating the whole fleet blacks out `/api` for minutes. The pace is adaptive: it barely waits on an idle box, and backs off on a loaded one. Set `false` for the old back-to-back resume. |
| `RESUME_PACE_TARGET_MS` | `50` | The event-loop lag, in ms, the pacer waits to fall below before starting the next channel. A higher value resumes faster, but leaves less API headroom during the resume. |
| `RESUME_PACE_MAX_MS` | `1000` | The cap on the per-channel wait. This keeps a permanently busy loop making forward progress. It bounds the total pacing overhead to roughly channels × this value. |
| `RESUME_PACE_MIN` | `8` | Below this channel count, the broadcaster does not pace at all — a handful of channels has no resume storm to manage. |
| `RESUME_CONCURRENCY` | `12` | How many channel starts run at once during boot. A channel start is mostly I/O wait, so running several at once cuts total recovery time roughly in proportion. Measured on 83 channels / 4 vCPU: 451 s sequential versus 40 s at concurrency 12, with a CPU peak of 77%. The adaptive pace still throttles the launch rate under load, so a high value self-limits on a constrained host. Set `1` for strictly sequential starts. Lower this value to keep the startup burst further from the host's CPU ceiling. |
| `SLATE_ENABLED` | `true` | Loops a pre-rendered "SOURCE OFFLINE" slate when a source is dead. This keeps the channel live with a message, instead of going blank during watchdog backoff. Set `false` to revert to the blank-during-backoff behavior. See the [KB](kb/offline-slate.md). |
| `SLATE_DIR` | *(image `broadcaster/slate`)* | Where the rendered slate `.ts` files live. The image builds these in at build time. Point this at the data volume instead — for example, `/data/slate` — to serve your own files. |
| `SLATE_AFTER` | `3` | Consecutive failed respawns, per configured source, before a channel gives up and shows the slate. A channel with fallback sources tries every URL first. A slated channel is remuxed with `-c copy`, which costs close to 0 CPU — cheaper than the live pull it replaces. |
| `SLATE_RETRY_MS` | `30000` | How often a slated channel drops the slate to re-probe its real source. This is also how the channel returns automatically: a working source clears the failure streak and stays; a still-dead source re-slates on the next failure. A lower value recovers faster. A higher value glitches the slate bars less often during a long outage, at the cost of the bars showing a little longer after the source is already back. Raise it — for example, to `60000` — for smoother bars. Values below about `20000` are discouraged. See the [KB](kb/offline-slate.md). |
| `SWARM_MAX_PEERS` | *(unset)* | An optional connection budget, per channel (each channel runs its own swarm; hyperswarm's own default is also 64, per channel). Connections beyond this budget are dropped at accept time. Leave headroom for non-viewer peers, such as repeaters and the panel's blobsKey probe. |
| `SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB` | `2` / `2` | Swarm UDP socket buffers, in MB (`0` uses the OS default). UDX carries every peer stream over one socket pair, so this buffer is what overflows under fan-out — silently, as kernel packet drops. **This only takes effect if the host allows it** — `setsockopt` clamps it to `net.core.{r,w}mem_max` (212992 on stock Linux). The optional `deploy/sysctl/install.sh` script raises that ceiling. See the [KB](kb/network-tuning.md). |
| `CONTROL_ENABLED` | `false` | Serve the channel control HTTP API. |
| `CONTROL_HOST` | `127.0.0.1` | Control API bind address. Put TLS in front if this isn't loopback. |
| `CONTROL_PORT` | `3310` | Control API port. |
| `CONTROL_SESSION_TTL_HOURS` | `12` | Control session token lifetime, in hours. |
| `LOCKOUT_THRESHOLD` / `LOCKOUT_SECONDS` | `10` / `900` | Control login lockout threshold and duration. |
| `ANALYTICS_RETENTION_DAYS` | `90` | How many days of [aggregate-only analytics](analytics.md) rollups — per-channel peers, egress, and respawns — the broadcaster keeps, under `DATA_DIR/analytics/`. **Set this to `0` to disable collection entirely.** |
| `ARGON2_MEM_KIB` / `ARGON2_TIME` | `65536` / `2` | Argon2id cost for control-admin passwords. |
| `BACKUP_DIR` | `./backups` | Where the dashboard's Backup page looks for [recovery archives](kb/backup-and-rotation.md#four-files-four-jobs). The shipped compose file mounts the host `./backups` here **read-only** and sets this to `/backups` — leave it unset there. The page can only list: a cold backup stops the service, so archives are made on the box with `deploy/backup.sh`. |
| `CONFIG_SNAPSHOT_KEEP` | `20` | How many on-box [config snapshots](kb/backup-and-rotation.md#four-files-four-jobs) the service keeps under `DATA_DIR/config-snapshots/`. It takes one by itself before a destructive change and before every restore or import; the oldest past the cap are removed. |

## Repeater (`repeater/.env`)

The repeater is a keyless regional relay appliance — see the
[repeater appliance page](repeater.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `PANEL_PUBKEY` | — (required) | The panel whose public catalog names the channels. |
| `CHANNELS` | `all` | `all`, an explicit list (`ch1,ch2`), or a category filter (`category:news[,sports]`). |
| `RETENTION_SECONDS` | `300` | The live window the repeater keeps per channel. This may exceed the origin's own HLS window. |
| `SWARM_MAX_PEERS` | `256` | Connection budget. A repeater exists to absorb fan-out, so this is set high. |
| `SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB` | `4` / `4` | Swarm UDP socket buffers, in MB (`0` uses the OS default). This is higher than the broadcaster's default, because absorbing fan-out is this box's entire job — it is the most likely service to hit a buffer wall. Pair this with the optional `deploy/sysctl/install.sh` script; otherwise the OS silently clamps the request. See the [KB](kb/network-tuning.md). |
| `DATA_DIR` | `./data` | Ciphertext block store. This is a disposable cache. |
| `STATUS_INTERVAL_SECONDS` | `60` | Per-channel status log cadence. `0` turns it off. |
| `STATUS_PORT` | `0` (off) | An opt-in health and metrics HTTP server: `GET /healthz` plus a Prometheus `GET /metrics`. Off by default — a stock repeater opens **no listening sockets at all**. |
| `STATUS_HOST` | `127.0.0.1` | Status-server bind address. Its endpoints are unauthenticated — widen this beyond loopback only on a network you control. |
| `BOOTSTRAP` | public DHT | Custom DHT bootstrap nodes. |

## Library (`library/.env`) — VOD

The library is the standalone VOD service — see the
[VOD library page](vod-library.md) and the
[reference](reference.md#library-control-api-ui-control_enabled1).

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | The titles registry, per-title encryption keys (under `secrets/`, mode 0600), and the encrypted title stores. Disk use equals the sum of title sizes; only `delete-title` reclaims it. |
| `PANEL_PUBKEY` | — (required to register) | The panel to register titles with. |
| `PUBLISHER_NAME` / `PUBLISHER_KEY` | — | The library's enrolled publisher identity. **Always enroll the library as its own publisher**, scoped to its title ids — for example, `add-publisher library1 --scopes 'vod-*'`. Never reuse the live fleet's key. |
| `HLS_TIME` | `4` | VOD segment length, in seconds. A shorter value gives finer seek and demand-paging, at the cost of more per-request overhead. Override this per title in the API. |
| `INGEST_CONCURRENCY` | `1` | Parallel ingest jobs. A transcode burst uses 0.5–1 core; the default runs jobs strictly one at a time. |
| `SWARM_MAX_PEERS` | `256` | Connection budget. One swarm carries every title — the same seeder economics as the repeater. |
| `SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB` | `4` / `4` | Swarm UDP socket buffers, in MB (`0` uses the OS default). A seeder is send-dominant, so the same rationale — and the same sysctl pairing — applies as for the repeater. |
| `CONTROL_ENABLED` | `0` | The control API and a minimal UI on `CONTROL_HOST:CONTROL_PORT` (`127.0.0.1:3320`). This is the only way to add titles. Manage admins with `library-cli add-admin`. |
| `CONTROL_SESSION_TTL_HOURS` | `12` | Control session lifetime, in hours. |
| `LOCKOUT_THRESHOLD` / `LOCKOUT_SECONDS` | `10` / `900` | Control login rate limit. |
| `ARGON2_MEM_KIB` / `ARGON2_TIME` | `65536` / `2` | Control-admin password hashing cost. |
| `BOOTSTRAP` | public DHT | Custom DHT bootstrap nodes. |
| `BACKUP_DIR` | `./backups` | Where the dashboard's Backup page looks for [recovery archives](kb/backup-and-rotation.md#four-files-four-jobs). The shipped compose file mounts the host `./backups` here **read-only** and sets this to `/backups` — leave it unset there. The page can only list: a cold backup stops the service, so archives are made on the box with `deploy/backup.sh`. |
| `CONFIG_SNAPSHOT_KEEP` | `20` | How many on-box [config snapshots](kb/backup-and-rotation.md#four-files-four-jobs) the service keeps under `DATA_DIR/config-snapshots/`. It takes one by itself before a destructive change and before every restore or import; the oldest past the cap are removed. |

## Client

The client reads build-time config from `client/config`, or a runtime
**service descriptor**:

| Key | Description |
|-----|-------------|
| `panelPubKey` | The operator's panel public key. This pins trust and locates the service. |
| `name` / `branding` | The app name, logo, and color palette. |
| `bootstrap` | Custom DHT bootstrap nodes. Optional. |

!!! note "CDN channels are catalog config, not client config"
    To make a channel play a CDN/HLS link, add a per-channel **redirect**
    entry in the admin panel. Do not configure this on the client. See
    [content-management.md](content-management.md).

!!! danger "Never commit secrets"
    Keys under `DATA_DIR` must never be committed. See `.gitignore`.
