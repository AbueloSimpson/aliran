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
| `ADMIN_ENABLED` | `false` | Serve the admin HTTP API from the panel process |
| `ADMIN_HOST` | `127.0.0.1` | Admin API bind address (use TLS in front if not loopback) |
| `ADMIN_PORT` | `3210` | Admin API port |
| `ADMIN_SESSION_TTL_HOURS` | `12` | Admin session token lifetime |
| `BOOTSTRAP` | *(empty)* | Custom DHT bootstrap nodes (optional) |
| `GEOIP_DB` | *(empty)* | Path to MaxMind GeoLite2 mmdb (enables geo) |
| `DRM_PROVIDER` | *(empty)* | `keyos` \| `ezdrm` \| `axinom` … (enables DRM) |
| `DRM_LICENSE_URL` | *(empty)* | Vendor license server URL |
| `DRM_API_KEY` | *(empty)* | Vendor API/CPIX credential (secret) |

## Broadcaster (`broadcaster/.env`)

| Key | Default | Description |
|-----|---------|-------------|
| `DATA_DIR` | `./data` | Corestore + drive keys |
| `PANEL_PUBKEY` | *(required)* | Panel to register the stream with |
| `STREAM_ID` | `default` | Catalog id for this stream |
| `INPUT` | *(required)* | `rtmp` (OBS listener), or an `rtsp://`/`http…m3u8`/file path |
| `RTMP_PORT` | `1935` | If `INPUT=rtmp`, port for OBS to push to |
| `HLS_TIME` | `2` | Segment duration (seconds) |
| `HLS_LIST_SIZE` | `6` | Rolling playlist window |
| `PROTECTION` | `self` | `self` (encrypted Hyperdrive) or `drm` (CENC via packager) |

## Client

Build-time config (`client/config`) or runtime **service descriptor**:

| Key | Description |
|-----|-------------|
| `panelPubKey` | The operator's panel public key (pins trust + locates it) |
| `name` / `branding` | App name, logo, color palette |
| `bootstrap` | Optional custom DHT bootstrap nodes |

> Secrets (`DRM_API_KEY`, keys in `DATA_DIR`) must never be committed. See `.gitignore`.
