# Configuration Reference

All operator-specific values are configuration (env / config files), never hardcoded.
Copy each component's `.env.example` to `.env`.

## Panel (`panel/.env`)

| Key | Default | Description |
|-----|---------|-------------|
| `DATA_DIR` | `./data` | Corestore + keys location (gitignored) |
| `RELAY_ONLY` | `false` | Route via DHT relays to hide origin IP |
| `ARGON2_MEM_KIB` | `262144` | Argon2id memory cost (~256 MB) |
| `ARGON2_TIME` | `3` | Argon2id time cost (iterations) |
| `MAX_DEVICES_DEFAULT` | `2` | Default concurrent devices per user |
| `SESSION_TTL_DAYS` | `30` | Session/token lifetime (long by design) |
| `POW_DIFFICULTY` | `16` | Login proof-of-work difficulty (bits) |
| `LOCKOUT_THRESHOLD` | `10` | Failed attempts before lockout |
| `LOCKOUT_SECONDS` | `900` | Lockout duration |
| `LEGACY_PUBLISHER` | `1` | Accept unnamed registrations signed with the shared `init` publisher key. Set `0` once every broadcaster site is enrolled (`add-publisher`) so only named, scoped identities can register |
| `ADMIN_ENABLED` | `false` | Serve the admin HTTP API from the panel process |
| `ADMIN_HOST` | `127.0.0.1` | Admin API bind address (use TLS in front if not loopback) |
| `ADMIN_PORT` | `3210` | Admin API port |
| `ADMIN_SESSION_TTL_HOURS` | `12` | Admin session token lifetime |
| `SOURCES_SYNC_INTERVAL_MS` | `86400000` | Default per-source pull interval (daily); override per source via `intervalMs` |
| `SOURCES_TICK_MS` | `3600000` | How often the scheduler checks which sources are due (a check, not a fetch) |
| `SOURCES_BOOT_DELAY_MS` | `15000` | Delay before the first due-check after panel boot |
| `SOURCES_FETCH_TIMEOUT_MS` | `30000` | Per-pull HTTP timeout |
| `SOURCES_MAX_BYTES` | `5242880` | Feed size cap (streaming-enforced) |
| `SOURCES_MAX_CHANNELS` | `500` | Entries imported per source beyond which the feed is truncated |
| `SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB` | `2` / `2` | Swarm UDP socket buffers in MB (`0` = OS default). Every client replicates the catalog over this one swarm. **Only takes effect if the host allows it:** clamped to `net.core.{r,w}mem_max` — optional `deploy/sysctl/install.sh` raises it. See [KB](kb/network-tuning.md) |
| `BOOTSTRAP` | *(empty)* | Custom DHT bootstrap nodes (optional) |

## Broadcaster (`broadcaster/.env`)

| Key | Default | Description |
|-----|---------|-------------|
| `DATA_DIR` | `./data` | Corestore + drive keys |
| `PANEL_PUBKEY` | *(required)* | Panel to register the stream with |
| `PUBLISHER_KEY` | *(required)* | Publisher secret — signs `register` RPCs. Per-site key from the panel's `add-publisher` (recommended for multi-broadcaster), or the shared legacy key from `init` |
| `PUBLISHER_NAME` | *(empty)* | Enrolled publisher identity matching `PUBLISHER_KEY`. When set, registrations verify against this site's own key and are limited to its admin-assigned channel scopes; the catalog gets `origin:<name>` attribution. Empty = legacy shared-key path |
| `STREAM_ID` | *(optional)* | Catalog id for the legacy env-configured channel (multi-channel setups add channels via the control API/UI instead) |
| `INPUT` | *(with `STREAM_ID`)* | `test`, a file path, a pull URL (`rtsp://`/`rtmp://`/`srt://`/`http…m3u8`), or a push listener: `rtmp` / `srt` / `udp` (typed objects via the control API) |
| `RTMP_PORT` | `1935` | If `INPUT=rtmp`, port for OBS to push to |
| `PUBLIC_HOST` | *(empty)* | Hostname shown in operator-facing push URLs (`rtmp://<PUBLIC_HOST>:<port>/…`) |
| `INGEST_PORT_BASE` / `INGEST_PORT_MAX` | `5000` / `5999` | Auto-allocation range for push-ingest ports (validated unique across channels) |
| `HLS_TIME` | `2` | Segment duration (seconds); shorter = faster time-to-first-frame |
| `HLS_LIST_SIZE` | `8` | Rolling playlist window (segments); deepen to 12–16 for large swarms |
| `FFMPEG_MAX_RSS_MB` | `150` | Recycle a running ffmpeg once its VmRSS+VmSwap crosses this (MB) — bounds the slow demuxer-state accumulation some live-HLS upstreams cause. Same watchdog backoff as a stalled-edge respawn, no feed rotation. `0` disables; Linux-only (reads `/proc`) |
| `FEED_BUFFER` | `disk` | `disk` (stable feed identity, warm DHT topic — faster joins) or `ram` (byte-flat disk, cold discovery each restart). See [KB](kb/feed-buffer.md) |
| `RESUME_PACE` | `true` | Pace the boot auto-resume: between channel starts, wait until the event loop has caught up so the control API + swarm stay responsive during a mass restart (a full-fleet recreate otherwise blacks out `/api` for minutes). Adaptive — barely waits on an idle box, backs off on a loaded one. `false` = old back-to-back resume |
| `RESUME_PACE_TARGET_MS` | `50` | Event-loop lag (ms) the pacer waits to fall below before starting the next channel. Higher = faster resume, less API headroom during it |
| `RESUME_PACE_MAX_MS` | `1000` | Cap on the per-channel wait, so a permanently-busy loop still makes forward progress (bounds total pacing overhead to ~channels × this) |
| `RESUME_PACE_MIN` | `8` | Don't pace fleets smaller than this — a handful of channels has no resume storm |
| `RESUME_CONCURRENCY` | `12` | How many channel starts run concurrently on boot. A start is mostly I/O wait, so overlapping several cuts total recovery time roughly in proportion (measured 83 ch / 4 vCPU: 451 s sequential → 40 s at 12, ramp CPU peak 77%); the adaptive gate still throttles the launch rate under load, so a high value self-limits on a constrained host. `1` = strictly sequential. Lower it to keep the startup burst further from a host's CPU ceiling |
| `SLATE_ENABLED` | `true` | Loop a pre-rendered "SOURCE OFFLINE" slate when a source is dead, so the channel stays live with a message instead of going blank in watchdog backoff. `false` reverts to the blank-during-backoff behaviour. See [KB](kb/offline-slate.md) |
| `SLATE_DIR` | *(image `broadcaster/slate`)* | Where the rendered slate `.ts` files live. They are built into the image at build time; point this at the data volume (e.g. `/data/slate`) to serve operator-supplied files instead |
| `SLATE_AFTER` | `3` | Consecutive failed respawns **per configured source** before a channel gives up and slates (so a channel with fallbacks tries every url first). A slated channel is remuxed with `-c copy` — ~0 CPU, and cheaper than the live pull it replaces |
| `SLATE_RETRY_MS` | `30000` | How often a slated channel drops the slate to re-probe its real source — also how it returns automatically (a working source clears the failure streak and stays; a still-dead one re-slates on the next failure), and the worst-case extra time bars keep showing after the source is already back. Lower = faster recovery; higher = the bars glitch less often during a long outage. Raise it (e.g. `60000`) for smoother bars; below ~20000 is discouraged. See [KB](kb/offline-slate.md) |
| `SWARM_MAX_PEERS` | *(unset)* | Optional **per-channel** swarm connection budget (each channel runs its own swarm; hyperswarm's own default is 64, also per channel). Connections beyond the budget are dropped at accept time. Leave headroom for non-viewer peers (repeaters, the panel's blobsKey probe) |
| `SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB` | `2` / `2` | Swarm UDP socket buffers in MB (`0` = OS default). UDX carries every peer stream over one socket pair, so this is what overflows under fan-out — silently, as kernel packet drops. **Only takes effect if the host allows it:** `setsockopt` is clamped to `net.core.{r,w}mem_max` (212992 on stock Linux) — optional `deploy/sysctl/install.sh` raises it. See [KB](kb/network-tuning.md) |
| `CONTROL_ENABLED` | `false` | Serve the channel control HTTP API |
| `CONTROL_HOST` | `127.0.0.1` | Control API bind address (use TLS in front if not loopback) |
| `CONTROL_PORT` | `3310` | Control API port |
| `CONTROL_SESSION_TTL_HOURS` | `12` | Control session token lifetime |
| `LOCKOUT_THRESHOLD` / `LOCKOUT_SECONDS` | `10` / `900` | Control login lockout |
| `ARGON2_MEM_KIB` / `ARGON2_TIME` | `65536` / `2` | Argon2id cost for control-admin passwords |

## Repeater (`repeater/.env`)

The keyless regional super-peer — see the [repeater appliance page](repeater.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `PANEL_PUBKEY` | — (required) | The panel whose public catalog names the channels |
| `CHANNELS` | `all` | `all`, `ch1,ch2`, or `category:news[,sports]` |
| `RETENTION_SECONDS` | `300` | Live window kept per channel (may exceed the origin's HLS window) |
| `SWARM_MAX_PEERS` | `256` | Connection budget (a repeater exists to absorb fan-out) |
| `SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB` | `4` / `4` | Swarm UDP socket buffers in MB (`0` = OS default). Higher than the broadcaster's: absorbing fan-out is this box's entire job, so it is the most likely to hit a buffer wall. Worth pairing with the optional `deploy/sysctl/install.sh` — otherwise the request is silently clamped. See [KB](kb/network-tuning.md) |
| `DATA_DIR` | `./data` | Ciphertext block store (disposable cache) |
| `STATUS_INTERVAL_SECONDS` | `60` | Per-channel status log cadence (0 = off) |
| `BOOTSTRAP` | public DHT | Custom DHT bootstrap nodes |

## Library (`library/.env`) — VOD

The standalone VOD service — see the [VOD library page](vod-library.md)
and the [reference](reference.md#library-control-api-ui-control_enabled1).

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | Titles registry + per-title encryption keys (`secrets/`, 0600) + the encrypted title stores. Disk = the sum of title sizes; reclaimed only by delete-title |
| `PANEL_PUBKEY` | — (required to register) | The panel to register titles with |
| `PUBLISHER_NAME` / `PUBLISHER_KEY` | — | Enrolled publisher identity. ALWAYS enroll the library as its **own** publisher, scoped to its title ids (`add-publisher library1 --scopes 'vod-*'`) — never the live fleet's key |
| `HLS_TIME` | `4` | VOD segment length (s): shorter = finer seek/demand-paging, more per-request overhead. Per-title override in the API |
| `INGEST_CONCURRENCY` | `1` | Parallel ingest jobs. A transcode is 0.5–1 core for the burst; the default queues them strictly one at a time |
| `SWARM_MAX_PEERS` | `256` | Connection budget — one swarm carries every title (seeder economics, like the repeater) |
| `SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB` | `4` / `4` | Swarm UDP socket buffers in MB (`0` = OS default). A seeder is send-dominant — same rationale (and same sysctl pairing) as the repeater's |
| `CONTROL_ENABLED` | `0` | Control API + minimal UI on `CONTROL_HOST:CONTROL_PORT` (`127.0.0.1:3320`) — the only way to add titles. Admins via `library-cli add-admin` |
| `CONTROL_SESSION_TTL_HOURS` | `12` | Control session lifetime |
| `LOCKOUT_THRESHOLD` / `LOCKOUT_SECONDS` | `10` / `900` | Control login rate limit |
| `ARGON2_MEM_KIB` / `ARGON2_TIME` | `65536` / `2` | Control-admin password hashing cost |
| `BOOTSTRAP` | public DHT | Custom DHT bootstrap nodes |

## Client

Build-time config (`client/config`) or runtime **service descriptor**:

| Key | Description |
|-----|-------------|
| `panelPubKey` | The operator's panel public key (pins trust + locates it) |
| `name` / `branding` | App name, logo, color palette |
| `bootstrap` | Optional custom DHT bootstrap nodes |

> A channel that should play a CDN/HLS link is a per-channel **redirect** catalog
> entry set in the admin panel — not client configuration. See
> [content-management.md](content-management.md).

> Secrets (keys in `DATA_DIR`) must never be committed. See `.gitignore`.
