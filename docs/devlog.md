# Development log

The detailed, chronological build history of Aliran — every milestone as it landed,
with its verification narrative (what was proven and how). Oldest first; newest at
the bottom. The concise shipped-feature summary lives in
[CHANGELOG.md](https://github.com/AbueloSimpson/aliran/blob/main/CHANGELOG.md).

### Project scaffold
- Initial project scaffold: `panel/`, `broadcaster/`, `client/` structure.
- Documentation under `docs/` (getting-started, concepts, architecture with sequence
  diagrams, security model, operator guide, configuration, content management, client
  build, user management, reference, FAQ/troubleshooting, legal/compliance) + ADRs.
- `ROADMAP.md` (alpha → 1.0 milestones + optional modules) and a publishable MkDocs
  Material site config (`mkdocs.yml`).
- Repository metadata: README, LICENSE (MIT), SECURITY, CONTRIBUTING, Code of Conduct.

### v0.1 progress — "it streams" (verified)
- Broadcaster: ffmpeg → live HLS → **encrypted** Hyperdrive → Hyperswarm seeding
  (`broadcaster/src/hls.js`, `index.js`); persisted feed encryption key.
- Localhost Range media server over a Hyperdrive replica (`tools/lib/serve-drive.js`),
  ported into the client Bare worklet (`client/backend/backend.mjs`).
- Desktop P2P viewer (`tools/viewer.js`) + automated end-to-end test
  (`tools/e2e-stream-test.mjs`): a fresh peer discovers the feed over the DHT,
  replicates the encrypted feed, serves it locally, and ffprobe confirms valid
  H.264/AAC. **P2P transport proven on desktop.**

### v0.2 progress — secure login (verified)
- `@aliran/core`: OPRF (ristretto255), Argon2id verifiers, X25519 key sealing,
  proof-of-work — 6 unit tests (`npm run test:core`).
- Panel: signed account/catalog control plane (`admin-cli`), and a login RPC with
  proof-of-work + per-(user,peer) throttling + oblivious OPRF evaluation
  (`panel/src/rpc.js`, `panel/src/index.js`).
- Client: runtime-agnostic OPRF login (`client/backend/login.mjs`), wired into the Bare
  worklet; recovers per-user stream keys from the signed DB.
- End-to-end test (`npm run test:login`): panel + broadcaster + client login →
  entitlement → P2P playback (ffprobe-validated); wrong password rejected.

### v0.2 progress — sessions & device limits (verified)
- `@aliran/core`: per-user Ed25519 auth keypair (`authKeyPair`/`authSign`/`authVerify`)
  and panel-signed session tokens (`token.js`); +2 unit tests (8 total).
- Panel: `session` RPC — client proves login by signing the panel's challenge; the panel
  enforces `maxDevices` (evict oldest), issues a signed token, updates the signed record;
  revocation via `tokenVersion`. Enrollment stores `authPub`/`authPrivEnc`.
- Client: `login.mjs` completes the session step and verifies the returned token;
  `checkSession()` for offline validation.
- Tests: `npm run test:session` (device eviction, forged-sig rejection, revocation);
  `test:login` now also asserts a valid session token.

### v0.2 progress — broadcaster auto-registration (verified)
- Panel generates a **publisher keypair** at `init` (secret goes in the broadcaster
  `.env` as `PUBLISHER_KEY`). Broadcaster signs a `register` RPC; the panel verifies,
  writes the public catalog record, and stores the encryption key privately.
- `broadcaster/src/register.js` + wired into `index.js` (auto-registers on start).
- Test: `npm run test:register` (register → private secret, unauthorized rejected,
  grant → login recovers the registered key).

### v0.2 progress — assets pipeline (verified)
- Panel seeds an assets Hyperdrive; its key is advertised in the signed DB
  (`meta/assetsKey`). `admin-cli upload-art <stream> <poster|backdrop|logo> <file>`
  writes art and updates the catalog. Client opens the assets replica and serves
  `/assets/*` over the localhost media server.
- Test: `npm run test:assets` (upload → P2P replication → localhost serve, bytes match).

### Android client progress — Bare backend runs on-device (verified)
- `client/` is a real `react-native-tvos` 0.83 project (`android/` native build, app id
  `com.aliranclient`); `react-native-bare-kit` boots a Bare worklet with JS↔Bare IPC.
- The P2P backend bundles with `npm run bundle-backend` (bare-pack, `--preset android`)
  and the **full Holepunch native addon stack loads on Android** — sodium-native (4.x
  **and** 5.x), udx-native, quickbit/rabin/simdle/crc, fs-native-extensions — packaged
  per-ABI by bare-kit's `bare-link` gradle step from npm prebuilds (no cross-compiling).
- Worklet-runtime gaps shimmed: `node:crypto` → `@aliran/bare-node-crypto`
  (sodium-backed WebCrypto, wired via the bare-pack global imports map),
  TextEncoder/TextDecoder/`globalThis.crypto` polyfills (`client/backend/globals.mjs`),
  and an Android-aware corestore path (worklet cwd is `/`).
- Verified on the emulator: the real `app.bundle` worklet boots and reports
  `{type:'ready'}` (smoke screen in `client/src/WorkletSmokeTest.tsx`).

### Android client progress — OTT UI: login + catalog browse (verified)
- Login screen performs the OPRF login through the worklet (retrying while the DHT
  dials) and navigates Login → Home → Player (react-navigation, screens pinned 4.25.0).
- Home screen: category rails + featured hero + LIVE badges; poster/backdrop art is
  replicated P2P from the panel's assets drive and served by the worklet's localhost
  server, which now starts at login on one persistent port (asset URLs stay valid
  across playbacks) — art fields arrive in `{type:'streams'}` as ready-to-use URLs.
- Android release builds permit cleartext HTTP **only to loopback** via a network
  security config — required for the on-device media/assets server (API 28+ blocks
  cleartext by default; also needed by the S6c video player).
- **Player screen — live P2P playback verified on-device**: tapping a channel sends
  `{streamId}` to the worklet, which replicates the encrypted feed over the DHT,
  re-seeds it, and serves it on the session's localhost port; `react-native-video`
  (6.19.2, ExoPlayer HLS) plays `http://127.0.0.1:<port>/index.m3u8` with LIVE badge,
  peer count, buffering indicator, and auto-retry while the live edge replicates.
  Verified end-to-end on the emulator: origin HLS → desktop broadcaster (ffmpeg →
  encrypted Hyperdrive) → Hyperswarm → phone worklet → ExoPlayer.
- Client backend hardening: the Android store dir is created (not just probed) so a
  fresh install or `pm clear` can't strand the worklet; playback errors now surface
  on the Player screen instead of an endless spinner.
- Client store corruption recovery: the on-device Corestore is a disposable replica
  cache, so if a crash mid-write leaves it unopenable (`OPLOG_CORRUPT` and friends —
  previously permanent until the user wiped app data), the worklet now purges the
  store, rebuilds the panel connection, and retries the open once before surfacing an
  error (`client/backend/recover.mjs`); in-memory entitlements survive, everything
  re-replicates from peers. Test: `npm run test:corrupt` (reproduces the corruption
  locally, asserts detection + purge + clean reopen).
- **Android TV support verified on a TV emulator (remote-only)**: visible D-pad focus
  rings on Login inputs/button and Home hero/cards (transparent border on phone, cyan
  `theme.colors.focus` ring on TV), and each Home rail is a `TVFocusGuideView` with
  focus memory (returning from the Player lands on the card you left). The manifest
  already declared `LEANBACK_LAUNCHER` + `leanback`/`touchscreen` not-required from
  the tvos template. Verified on an Android TV (API 36, 1080p) emulator end-to-end
  with only D-pad key events: focus traversal → sign-in → browse → live P2P playback
  → Back to Home.
- **`@aliran/player-sdk` (new `sdk/` package)** — the player engine extracted from the
  app's Bare worklet into a reusable, runtime-agnostic `AliranPlayer` class
  (`connect`/`login`/`listStreams`/`resolve`/`serveFeed`/`assetUrl`/`stop` + events
  `ready|streams|status|peers|recovered|error`). Runtime modules are injected
  (`node:http`/`node:fs` via the Node entry, `bare-http1`/`bare-fs` in the worklet), so
  one graph runs headless in Node and on-device in Bare. `login.mjs` and `recover.mjs`
  moved into the SDK (canonical home); the old client/backend paths re-export them.
  **`client/backend/backend.mjs` is now a thin IPC shell** over the SDK — the IPC
  protocol and app behavior are unchanged (verified by the full e2e suite and on the
  Android TV emulator). New tests: `sdk/test.mjs` (unit) and `npm run test:sdk`
  (headless e2e: real panel + broadcaster → SDK login → resolve → ffprobe-valid HLS
  over P2P, Range requests, peers ticker). Partial-adoption path: integrators can keep
  their own catalog and use only `login()` + `resolve()` for the video URL.
- **Hybrid CDN↔P2P failover in the player SDK**: `hybrid` config
  (`mode: 'p2p-only'|'hybrid'|'cdn-only'`, `start`, `cdnUrl(streamId)`,
  `readyTimeoutMs`, `rebufferMsToFallback`, `probeIntervalMs`). In hybrid mode
  `resolve()` returns the ACTIVE source URL: P2P if the feed playlist is available in
  time, otherwise the CDN (`fallback` event, reasons `timeout`/`stall`); while on CDN
  the feed keeps replicating with the DHT lookup re-run each probe, and once the
  playlist advances across consecutive probes the source switches back
  (`source-changed` event). Health checks are metadata-only (no blob downloads).
  Default `p2p-only` keeps the app worklet's behavior identical. Verified in
  `test:sdk`: unseeded stream + tiny timeout → CDN fallback (local HLS file server);
  broadcaster starts → auto-return to P2P and the local playlist serves.
- **`@aliran/react-native` (new `sdk/react-native/` package)** — drop-in RN binding:
  `AliranBackend` hosts the engine in the Bare worklet (bundle supplied by the host
  app; caches streams/port/url/source) and `<AliranVideo>` renders the ACTIVE source
  on react-native-video with the proven error-retry remount, switching sources on
  `fallback`/`source-changed`. The worklet IPC gained hybrid pass-through
  (`{panelPubKey, hybrid}` — cdnUrl as a JSON-safe `{streamId}` template) plus
  `fallback`/`source-changed` relays and `url`/`source` in the port reply (additive).
  The app now dogfoods the binding (`client/src/worklet.ts` is a thin wrapper,
  PlayerScreen uses `<AliranVideo>` + a P2P/CDN source badge). Verified on the
  Android TV emulator with a hybrid dev descriptor: live P2P playback through the
  binding → kill the broadcaster → `fallback` (stall) switches playback to the CDN
  (video keeps playing) → restart the broadcaster → `source-changed` returns to P2P.
- **Media-server hardening (found by the on-device hybrid test)**: players abort
  in-flight requests routinely (source switch, seek, teardown), and writing into the
  closed response was an unhandled stream error that killed the whole Bare worklet
  (SIGABRT). The Range handler now tolerates client aborts on both paths, and the
  worklet installs a last-resort `uncaughtException` guard that reports over IPC
  instead of crashing the app.
- **Knowledge base (`docs/kb/`)**: public, field-tested symptom→cause→fix pages —
  playback & client runtime, operating the panel/broadcaster, Android/RN build
  traps, and Bare worklet/bundling lore — wired into the MkDocs nav and linked from
  the README and FAQ.

### Catalog live-push (verified)
- **Panel catalog edits reach connected clients live — no polling, no re-login**: the
  player SDK (`sdk/player.js`) watches the replicated signed DB's `catalog/` range
  (`bee.watch`) and re-emits `streams` with fresh display metadata (title, isLive,
  art URLs) whenever a record changes; the watch re-arms automatically after a
  store-recovery purge. The Bare worklet already relays `streams` over IPC
  (`{type:'streams'}`, same shape) and the app's Home screen already re-renders on
  that message, so updates reach the UI with no app change. Entitlements are
  untouched: a newly granted stream still appears on the next login. Verified in
  `npm run test:sdk`: a catalog record is edited while a headless client is
  connected and the update must arrive as a `streams` re-emit without `login()`
  ever being called again.

### Broadcaster control API (verified)
- **Runtime start/stoppable channels (`broadcaster/src/channel.js`)**: the broadcaster
  is now multi-channel — a `ChannelManager` persists a channel registry
  (`DATA_DIR/channels.json`) and each channel owns its ingest→ffmpeg→encrypted-
  Hyperdrive→Hyperswarm pipeline with a stable per-channel feed identity
  (`channels/<id>/feed.key`). Back-compat: the env-configured stream keeps the legacy
  `DATA_DIR`-root store + `feed.key`, so existing deployments and pre-seeded feed
  keys keep their identity (proven: same feedKey/encKey across the old layout, a
  restart, and an API start).
- **Control HTTP API (`broadcaster/src/control-server.js`)**: opt-in
  (`CONTROL_ENABLED=1`, default `127.0.0.1:3310`), same auth pattern as the panel
  admin API — admins via `control-cli add-admin` (Argon2id, local
  `DATA_DIR/secrets/admins.json`), session tokens signed with an auto-generated
  broadcaster-local keypair, login lockout, equal Argon2 work for unknown names.
  Endpoints: login, status, channels (list with live ffmpeg/peers/registered/playlist
  status, add, edit, remove, **start**, **stop**). Panel registration reuses the
  publisher-key `register` RPC unchanged. Verified by `npm run test:broadcaster-api`:
  add+start a channel over HTTP → registers with a real panel over Hyperswarm + a
  fresh viewer replicates the encrypted feed P2P and ffprobe validates the media →
  clean stop (ffmpeg down) → restart with the same feed key → lockout enforced.

### Broadcaster control UI (verified)
- **Web control UI (`broadcaster/control-ui/`)** served by the control server at `/`
  when `CONTROL_ENABLED=1` — plain HTML/JS/CSS, no build step, consumes only the
  control API (panel/admin-ui sibling: token in sessionStorage, free text escaped,
  any API 401 drops back to the login view). Sign in → status chips (channels /
  running / panel configured), add-channel form (with the feed-encryption-key
  dialog), and per-channel cards with **live status polled every 5 s** — ON AIR
  badge, ffmpeg health (incl. exit code on silent death), peer count, panel
  registration (with the register error on failure), playlist presence, uptime —
  plus start/stop (confirm on stop), metadata/input/HLS editing ("applies on next
  start" when running), and remove (guarded while running; feed identity kept on
  disk). Channel art is deliberately absent: it is a panel admin operation (the
  register RPC carries no art), and the UI says so. Verified in
  `test:broadcaster-api` (control UI static files, `%2e%2e`/backslash/dotfile
  requests 404, non-GET 404) and end-to-end in a browser: a channel added and
  started from the UI registered into a live panel's catalog and a fresh
  `tools/viewer.js` peer replicated and played the encrypted feed (ffprobe-valid
  h264/aac), with the card's peer counter showing the viewer.

### Panel admin dashboard (verified)
- **Web dashboard (`panel/admin-ui/`)** served by the admin server at `/` when
  `ADMIN_ENABLED=1` — plain HTML/JS/CSS, no build step, consumes only the admin API.
  Sign in → status chips (users/streams/live/panel key), user management (create,
  rotate password, disable/enable, device list, device limit, logout-all,
  grant/revoke chips) and stream management (add — with the one-time encryption-key
  dialog —, metadata editor, poster/backdrop/logo upload with live preview). Art
  previews are fetched with the session token via the new authed
  `GET /api/assets/:id/:file` endpoint and rendered as blob URLs; static serving is
  GET-only from a flat directory (traversal-guarded) with a strict CSP. Verified in
  `test:admin-api` (static files, traversal 404, authed assets round-trip) and
  end-to-end in a browser against a live panel: every dashboard action (user,
  stream, grant, metadata, poster) was then received by a real viewer login over
  Hyperswarm, unsealing the exact key the dashboard displayed.

### Panel admin API (verified)
- **Shared ops layer (`panel/src/ops.js`)**: every admin operation (users, streams,
  grants, art, admin accounts) has one implementation used by BOTH the CLI and the
  HTTP API, so the two cannot drift. `create-user` and `add-stream` now refuse to
  overwrite existing records (previously a silent overwrite destroyed grants /
  rotated the stream secret); new `set-status` (disable revokes sessions) and
  `revoke <u> <stream>` commands.
- **Admin HTTP API (`panel/src/admin-server.js`)**: opt-in (`ADMIN_ENABLED=1`,
  default `127.0.0.1:3210`) and served from the panel process — the Corestore is
  single-writer, so a separate admin process would hit ELOCKED. Auth: admin accounts
  (`admin-cli add-admin`, Argon2id verifiers in the panel-private
  `DATA_DIR/secrets/admins.json`, never replicated) → panel-signed session tokens
  (`core/token.js`, `role:'admin'`, revocable via tokenVersion); login shares the
  fixed-window lockout from the login RPC, with equal Argon2 work for unknown names.
  Endpoints: login, status, users (create/password/status/logout-all/max-devices/
  devices/grant/revoke), streams (add/meta/art upload/list). Verified by
  `npm run test:admin-api` (bad creds + lockout rejected; every HTTP write asserted
  in the signed DB/secrets/assets; then a real viewer logs in over Hyperswarm and
  unseals the granted stream key).

### Continuous integration
- **GitHub Actions CI (`.github/workflows/ci.yml`)**: every push to `main` and every
  pull request runs the fast deterministic suites (`test:core`, `test:corrupt`) as the
  required job, plus a best-effort second job for the end-to-end suites that use the
  real Hyperswarm DHT (`test:session` / `test:register` / `test:assets` /
  `test:admin-api`, and — with ffmpeg installed — `test:sdk` /
  `test:broadcaster-api`). Each e2e suite retries once and is time-capped (a peer
  that never connects hangs rather than fails), and the job is `continue-on-error`
  so hosted-runner DHT flakiness can never block a merge.

### Deploy pack (Docker Compose + systemd + TLS recipe)
- **The Docker images build now.** `panel/Dockerfile` and `broadcaster/Dockerfile`
  previously depended on `@aliran/core` as a registry package (it is an unpublished
  workspace) and could never build. They now build from the **repo root context**,
  vendor `core/` into the image, and resolve it via a `file:../core` dependency
  (panel + broadcaster package.json — same pattern the SDK already used). Images
  pinned to `node:24-bookworm-slim` (matches CI); the broadcaster image ships
  Debian's ffmpeg (includes libsrt). A root `.dockerignore` keeps local state,
  secrets, and the React Native tree out of the build context.
- **`docker-compose.yml` uses `network_mode: host`** (deliberate: no double NAT on
  Hyperswarm hole-punching, dashboards keep their loopback-only default binding,
  future push-ingest ports need no compose edits) with named data volumes and
  restart policies; first-run key/admin bootstrap documented inline.
- **systemd units** (`deploy/systemd/aliran-panel.service`, `aliran-broadcaster.service`)
  for the bare-metal path: auto-restart, `EnvironmentFile`, sandboxing
  (`ProtectSystem=strict`, data-dir-only writes), VAAPI note for GPU transcode.
- **TLS for the dashboards**: `deploy/Caddyfile.example` (two-liner reverse proxy,
  automatic HTTPS) and the no-domain SSH-tunnel alternative, both documented in a
  rewritten `docs/operator-guide.md` (Compose + systemd quickstarts, firewall table
  — P2P still needs **no inbound ports**).
- **CI builds the images**: a new non-blocking `docker-build` job builds both
  Dockerfiles on every push and smoke-runs them (`admin-cli init` in a throwaway
  container; ffmpeg `-protocols` must list `srt`).

### Verified on a real VPS over the internet
- **The whole stack now has an internet-grade proof, not a localhost one.** Deployed
  via `docker compose` on a fresh 1 vCPU / 1 GB Ubuntu VPS (keys + admin accounts
  bootstrapped with the documented commands, dashboards enabled), two live channels
  created and started through the control API. From a machine on a different
  network, `tools/acceptance-remote.mjs` (new) logged in as a real viewer **through
  the public DHT** — no IP, no ports, just the panel public key — replicated both
  encrypted feeds **concurrently**, and ffprobe-validated the media (~8–20 s to
  first playable segment). Catalog assertions (`--expect-live`) held; both
  dashboards verified over the documented SSH tunnel; `docker compose restart`
  self-heals (channels currently need a manual Start after a broadcaster restart —
  auto-resume is on the roadmap with the watchdog).
- **`tools/acceptance-remote.mjs`**: reusable remote acceptance harness — one
  `AliranPlayer` per stream (own store = N real concurrent viewers), login retry
  that never trips the panel throttle (pre-connection failures are local),
  per-stream PASS/FAIL table (time-to-play, segment bytes, peers), `--expect-live`
  / `--expect-off` catalog assertions, exit 0 iff everything passed.
- **SDK teardown race fixed (found by the acceptance run):** a swarm connection
  whose handshake was in flight when `stop()` (or a recovery purge) nulled the
  store crashed the process — `sdk/player.js` now drops such late sockets. The same
  class of crash would have taken down the app worklet.
- **Compose hardening:** `DATA_DIR=/data` is pinned via `environment` (wins over
  `env_file`), so a copied bare-metal `.env` (`DATA_DIR=./data`) can no longer
  silently divert container data off the persistent volume.
- Operator guide: sizing notes for small VPSes (swap + `ARGON2_MEM_KIB=65536`,
  ~1 vCPU per two test channels), restart note, tunnel/Caddy verified flows.

### Broadcaster ingest engine + transcode incl. GPU (verified)
- **Push ingest**: a channel's `input` is now a typed object — `{kind:'rtmp', port,
  streamKey}` (OBS-style FLV publish via `-listen 1`; one publisher per port),
  `{kind:'srt', port, passphrase?, latencyMs}` (the passphrase is enforced by the
  libsrt handshake — the recommended authenticated push; an RTMP stream key is
  obscurity, not auth), and `{kind:'udp', port, timeoutMs}` (raw MPEG-TS) — alongside
  `test` / `file` / `pull`. Strings auto-upgrade everywhere (env `INPUT`, pre-existing
  `channels.json`, API bodies), so `INPUT=rtmp` finally implements the documented
  default: an RTMP listener on `RTMP_PORT` with a generated stream key that is
  persisted across restarts and printed as a push URL at startup. Push ports are
  validated 1024–65535, unique across channels, and auto-allocated from
  `INGEST_PORT_BASE`–`INGEST_PORT_MAX` (default 5000–5999) when omitted;
  `channels.json` is written mode 0600 now that it holds stream keys/passphrases.
- **Pull pacing fixed**: `-re` used to be applied to every URL; live sources
  (rtsp/rtmp/srt/udp pulls and live `.m3u8`) pace themselves and now run without it —
  only `test`, local files and plain-http VOD keep `-re`. RTSP pulls get
  `-rtsp_transport tcp`.
- **Per-channel `transcode`** (absent = previous behavior): `encoder`
  `libx264|copy|h264_nvenc|h264_qsv|h264_vaapi|h264_amf`, `resolution`
  (source/1080p/720p/480p/360p), `fps` (source/24/25/30/50/60), `videoBitrateKbps`
  (sets `-b:v -maxrate -bufsize 2×`; null keeps CRF), `audioBitrateKbps`, `preset
  fast|balanced|quality` mapped per encoder (x264 veryfast/medium/slow; nvenc
  p2/p4/p6 + `-tune ll`; amf speed/balanced/quality). Keyframes are segment-aligned
  on every encoder via `-force_key_frames expr:gte(t,n_forced*hls.time)` (replaces
  `-g 60`, which only lined up at 30 fps); `copy` passthrough requires source
  resolution/fps + no bitrate (audio still transcodes to AAC) — the publisher must
  send a keyframe every `hls.time` seconds. VAAPI/QSV get their hardware-device
  init (`-init_hw_device` before `-i`; VAAPI adds the `format=nv12,hwupload` chain).
- **ffmpeg capability probe (`broadcaster/src/capabilities.js`)**, warmed at manager
  init and cached: protocols from `-protocols` (rtsp via `-demuxers` — it is a
  demuxer, not a protocol), h264 encoders from `-encoders`, and every listed **HW
  encoder deep-verified by actually encoding 8 test frames** — "listed" only means
  compiled in. `start()` refuses cleanly (HTTP 400 with the probe's error, no silent
  fallback) when a channel needs an unavailable protocol/encoder, and bind-tests
  push ports first so a taken port is an API error instead of an ffmpeg crash loop.
- Tests: new **`npm run test:args`** (pure argument/validation table, no ffmpeg);
  `test:broadcaster-api` grew an **RTMP push round-trip** (a second local ffmpeg
  publishes → HLS → encrypted P2P feed → ffprobe validates), a **UDP-TS push**,
  typed-input validation over HTTP (auto-alloc, uniqueness, PATCH stream-key
  inheritance) and the capability/port gates. On the dev box the probe deep-verified
  `h264_qsv` (Intel) — a real QSV channel encode produced spec-exact output — and
  rejected nvenc/amf/vaapi with their true driver errors.

### Panel admin completeness (verified)
- **Admin-account management everywhere:** `GET/POST /api/admins`,
  `DELETE /api/admins/:name`, `POST /api/admins/:name/password` on the panel admin
  API **and** the broadcaster control API, plus CLI `set-admin-password` /
  `list-admins` on both. A password rotation bumps the admin's tokenVersion, so
  every session issued under the old password (including the caller's own) dies
  immediately.
- **Stream delete = FULL purge** (`DELETE /api/streams/:id`, CLI `delete-stream`):
  removes the catalog record, the panel-private encryption key, every user's sealed
  grant, and the stream's art from the assets drive. Clients converge on the next
  catalog push. Honest caveat: a client that already unsealed the key may have it
  cached — real revocation of live content is a stream-key rotation — and re-adding
  the same id mints a fresh key. `DELETE /api/users/:u` / `delete-user` removes an
  account record (already-issued tokens ride out their offline validity window).
- **User search + cursor paging:** `GET /api/users?prefix&after&limit` →
  `{users,next}` over a Hyperbee key range (prefix-only by design; substring search
  would scan the whole replicated DB).
- **Observability:** `GET /api/observability` → uptime, memory, swarm
  connections/peers, data-dir size + free disk, and an in-memory ring of the last
  200 events (viewer sessions, broadcaster registers, every admin mutation — feeds
  from `panel/src/activity.js`; cleared on restart by design).
- **Curation fields:** `order` (0–9999, nullable) and `featured` (bool) are typed
  in `setMeta`/`addStream`, and the broadcaster register merge now **preserves
  them** (plus art) so a re-register never erases admin curation.
- **Per-device revoke (cooperative):** `DELETE /api/users/:u/devices/:deviceId` /
  CLI `logout-device` removes one enrollment WITHOUT a tokenVersion bump; new SDK
  `sessionLive(db, payload)` (companion to `checkSession`) notices against the
  replicated record so well-behaved clients drop to login. Documented plainly as
  session hygiene, not content protection.
- Verified end-to-end by `test:admin-api` (admins lifecycle with token revocation,
  purge reflected in bee+secrets+grants+assets, paging, typed curation incl.
  register-merge preservation, device revoke + `sessionLive`, observability shape)
  + a control-API admins section in `test:broadcaster-api`; regressions
  `test:core`/`test:session`/`test:register`/`test:sdk` green.

### Panel dashboard UI for the admin surface (verified)
- The web dashboard (`panel/admin-ui/`, still vanilla no-build HTML/JS) now covers
  the full S16a admin surface:
  - **Admins tab** — add/remove admins and rotate passwords from the browser;
    rotating or removing **your own** account warns explicitly and signs you out
    (the API kills the token server-side; the UI drops to the login view).
  - **Users** — prefix **search box** driving the paged API + a cursor **“Load
    more”** button; a **delete** flow whose confirm dialog states the offline-token
    caveat. The devices dialog lists enrollments with a **revoke ✕** per device and
    explains the cooperative semantics (no token bump; other devices stay in).
  - **Streams** — inline **curation controls** (order 0–9999 number input, featured
    toggle with hero hint; ★ FEATURED badge) and a **permanent purge** flow that
    requires typing the stream id and spells out the key-rotation caveat.
  - **Overview tab** — health chips (uptime, rss/heap, swarm connections/peers,
    data size, disk free) + the last-200 **activity feed**, polling every 10 s
    while the tab is open (and only then).
- Verified by the extended `test:admin-api` static assertions and a **live browser
  session** against a temp panel exercising every flow above end-to-end — finishing
  with a real Hyperswarm viewer login that unsealed the exact key the dashboard
  displayed once, showed up in the devices dialog and the activity feed, and was
  then revoked from the UI.

### SDK/app curation passthrough (verified)
- The SDK display list (login result AND catalog live-pushes) now carries the panel's
  curation hints `order`/`featured` (`sdk/login.js`, `sdk/player.js` `_display`) —
  still metadata-only, stream keys never leave the engine — and the React Native
  `Stream` type declares them.
- The app consumes them via a new shared module (`client/src/catalog.ts`): rails and
  channel lists sort by `(order ?? Infinity, title)`, the hero/wallpaper pick prefers
  the first featured live stream, and channel numbers are derived (1..N over the
  curated sort — never stored).
- `test:sdk` asserts the fields flow through login and live-push, and that uncurated
  records stay bare.

### Android app GUI redesign — live-TV-first, white-label (verified on device)
- **New information architecture** (modeled on a commercial IPTV reference app's
  organization — layout only, no assets):
  `Splash → [Login] → Menu → { Live, Favorites, Search, Settings }`.
- **Splash auto-auth**: the app boots behind a branded splash ("Authorizing device…")
  and signs in with saved credentials; Login is now the exception path. "Remember me"
  credentials + favorites persist in the app-private files dir **beside** the
  disposable store (`aliran-prefs.json` — corruption recovery can't wipe them), via
  new additive worklet IPC (`prefs-get`/`creds-save`/`creds-clear`/`favorites-set`);
  the SDK binding exposes them (`requestPrefs`/`saveCredentials`/`clearCredentials`/
  `toggleFavorite`) and never logs the prefs payload. Sign-out (Settings) clears them.
- **Live TV is ONE fullscreen surface** (`<AliranVideo>` base layer) with overlay
  panels — playback never stops while browsing: a category rail (accent-underline
  focus) + a numbered channel list (derived numbers: curation order → title, 1..N,
  never stored; light row-fill focus; LIVE badges; ★ favorites; now-playing line from
  the catalog description) and a channel-detail panel (art, chips, synopsis, P2P/CDN
  source + peer stats, favorite/watch actions, and an honest **"No program
  information"** placeholder where an EPG lands later — no fake guides). Selecting a
  row switches the stream in place; selecting the playing row collapses to
  fullscreen; D-pad up/down zaps with an auto-hiding number+name OSD; BACK walks
  detail → list → fullscreen → menu. Phone gets the same IA by tap (D7).
- **Menu hub**: horizontal icon bar over the featured stream's backdrop (panel
  curation picks it) with a dark scrim; sections are **descriptor-driven**
  (favorites/search/settings toggles; Exit is TV-only by default; VOD hidden until it
  ships). Old Home/Player screens dissolved into the new surfaces.
- **White-label wiring**: `makeTheme(descriptor)` merges `branding.colors` over
  defaults (full token set incl. overlay/brand-surface/focus-fill/onPrimary); screens
  and components contain **zero** hardcoded brand strings or hex colors (grep-clean —
  tokens live only in `theme.ts`; the brand name renders from `service.json`).
  10-foot sizing follows the Google TV design guidance (type ramp, overscan-safe
  margins, three-part focus grammar).
- SDK: outbound IPC now queues until the worklet starts (a splash asking for prefs
  during boot can't crash the binding).
- Docs: `docs/client-build.md` gains the app-structure map, the prefs/white-label
  contracts, and a gradle gotcha (the release JS-bundle task doesn't track
  `config/*.json` — delete `generated/assets/react` after descriptor swaps).

### Ephemeral feed buffer — live segments stop accumulating (verified)
- **The live feed is now a rolling buffer, not an archive.** The playlist defines
  which segments exist; the drive mirror deletes rotated-out files AND reclaims
  their blob storage (`hypercore clear()` below the live window's low watermark) —
  a channel that streams for days occupies O(window) space. Previously the
  append-only feed grew ~1–2 GB/h/channel and filled a 19 GB VPS disk in a day.
- **Window deepened for P2P delivery: 16 segments × ~4 s (≈64 s)** — new
  `HLS_TIME`/`HLS_LIST_SIZE` defaults (was 6 × 2 s), so peers hold a meaningful
  shareable window to re-seed each other.
- **RAM session feeds by default** (`FEED_BUFFER=ram`, per-channel `buffer` field):
  segment data never touches disk; each channel start mints a fresh session feed
  keypair and re-registers it (re-using a keypair over an emptied store would fork
  the core and break replicas). The persisted **encryption key never rotates** on
  restart, so user grants stay valid. `FEED_BUFFER=disk` keeps a stable feedKey
  across restarts with the same window-bounded storage.
- **The player SDK follows broadcaster restarts without re-login**: `resolve()`
  reads the CURRENT `feedKey` from the replicated catalog at play time (the sealed
  per-user encryption key is unchanged); a re-KEYED stream still requires a fresh
  login, deliberately.
- New deterministic `test:retention` (rolling mirror → entries deleted, expired
  blocks freed, storage bounded across 40 rotations) wired into the required CI
  lane alongside `test:args`; `test:broadcaster-api` updated to the session-core
  contract (restart ⇒ new feedKey, catalog follows, encryption key stable).

### Feed buffer defaults to `disk` — faster time-to-play (verified)
- **`FEED_BUFFER=disk` is now the default** (`ram` stays available per-env or per
  channel). A RAM feed mints a fresh keypair every start, so its `feedKey`/DHT topic
  changes on each restart and viewers re-pay a **cold DHT discovery** every time
  (time-to-play ~40–55 s). Disk keeps a **stable feed identity**: returning viewers
  rejoin a warm topic and resume their on-disk replica (~10 s), while the same rolling
  reclaim keeps storage window-bounded. `ram` remains the choice when the host disk
  must stay byte-flat.
- **HLS window default is now 8 × ~2 s (≈16 s)** (was 16 × ~4 s in code / 6 × 2 s in
  `.env.example` — the two are now consistent). Short segments cut time-to-first-frame;
  `HLS_LIST_SIZE` is the P2P-shareability knob — deepen to 12–16 for large swarms.
  `normalizeMeta`/`ensureLegacy` now inherit the configured HLS default instead of a
  stale hard-coded `2/6`.
- `test:broadcaster-api` adds **Test F3**: a `disk` channel resolves its feedKey before
  first start and keeps it **stable across restart** (RAM's session-core contract is now
  asserted with an explicit `buffer: 'ram'`). New KB page `docs/kb/feed-buffer.md`
  (disk vs ram, the cold-DHT explanation, window sizing; clarifies the transport is
  Hypercore, not WebRTC).

### Fix: channel zap no longer hangs on flip-back (verified)
- **Re-zapping to a channel already opened in the session wedged `resolve()`**:
  `serveFeed` opened a *second* Hyperdrive over the same store namespace and `ready()`
  deadlocked against the still-open first drive (it also leaked a drive + swarm topic on
  every switch). `sdk/player.js` now **caches opened feeds by key and reuses them**;
  `stop()`/recovery-purge close every cached feed. Flip-back is near-instant (the
  replica is warm) instead of hanging.
- Measured warm-session zap over the public DHT: **~1.2 s to a new channel, ~0.3–0.4 s
  back to a watched one** (`resolve()` ~1 ms on reuse) — vs an indefinite hang before.
- `test:sdk` gains a `news → movies → news` zap regression (bounded `resolve()` so a
  future re-zap hang fails fast). KB: zapping sections added to `docs/kb/feed-buffer.md`
  and `docs/kb/playback.md`.

### Feat: pre-warm entitled feeds at login — warm first zap (verified on-device)
- New `prewarm` option (`AliranPlayer` + the `@aliran/react-native` binding `start()`):
  after login, open+join entitled feeds' DHT topics in the background so the cold
  discovery is paid upfront and even the FIRST play/zap to a channel is a cache hit, not
  a cold open. `false` (SDK default) | `true` (all) | integer (cap, lowest curated order
  first). The app enables it (bounded). Bandwidth-cheap: sparse replication warms the
  connection, not a full download.
- `serveFeed` split into `serveFeed` + `_openFeed`; the feed cache is now **single-flight**
  (stores the open PROMISE), so a prewarm and a concurrent zap of the same feed share one
  Hyperdrive — never a second open on the same namespace (the deadlock this guards). Feed
  teardown (`stop`/purge) closes via a shared `_closeFeeds` (fire-and-forget, deadlock-safe
  against an in-flight open whose recovery triggered the purge). Catalog-follow extracted
  to `_currentFeedKey`, shared by `resolve()` and `prewarm()`.
- `test:sdk` asserts prewarm opens all entitled feeds at login and that served feeds are
  then all warm (only `feed:ready`, never `feed:open`). Verified on the emulator (release
  APK): first play of ch1 and first zap to ch2 both `feed:ready` with no `feed:open`.

### Feat: viewers follow a rotated feed WHILE watching — no re-zap (verified headless)
- Completes the broadcaster's auto-rotate-on-source-change (`6e38b90`): the SDK already
  read the catalog `feedKey` at `resolve()` time, but a viewer **already watching** a
  channel kept replicating the OLD feed when the broadcaster rotated it — the new key was
  only picked up on a manual re-zap. `sdk/player.js` now re-resolves the ACTIVE stream off
  the replicated catalog watch: when the watched stream's `feedKey` changes, it opens the
  new feed (single-flight cache), swaps the served drive behind the **unchanged** localhost
  port, and emits a new **`feed-changed`** (`{streamId, feedKey, url}`) event. The per-user
  encryption key is untouched (a re-KEY still needs a fresh login); a zap mid-open never
  clobbers the newer `resolve()`'s drive.
- Relayed end to end: worklet IPC (`client/backend/backend.mjs`) → `@aliran/react-native`
  (`feed-changed` message + `<AliranVideo onFeedChanged>`, which remounts the player onto
  the same URL to flush the stale playlist) → the app's `LiveScreen` (clears any prior
  playback error and shows the spinner while the new feed buffers).
- `test:sdk` gains a rotation-while-watching case: publish a fresh `feedKey` (same sealed
  encryption key) for the stream being served → the SDK emits `feed-changed`, swaps
  `_feedDrive` to the rotated feed, and serves its playlist on the same port, all with no
  `resolve()` call. The client half needs an APK rebuild to verify on-device.

### Live-TV playback polish — immersive, whole-picture fit, cleaner OSD (verified on S22)
- **Landscape lock** (`AndroidManifest` `screenOrientation=sensorLandscape`) and the Menu
  hub's option bar centered — the TV-style UI no longer renders squeezed into portrait.
- **Sticky-immersive chrome** (`MainActivity`): both system bars are hidden so nothing
  distracts from playback; a swipe in from an edge reveals them transiently, then they
  re-hide. Edge-to-edge, transparent bar colors, re-applied on window-focus changes.
- **`LiveScreen` IA rework**: fullscreen is clean — no LIVE/peer/source/buffering chrome
  (diagnostics stay in Settings). A tap/OK peeks a bottom OSD that auto-fades; BACK opens
  the "left menu" (category rail + channel list), which lost its manual close control and
  now auto-hides after inactivity; BACK from the left menu exits to the hub. `AliranVideo`
  uses `resizeMode="contain"` so the whole 16:9 picture and channel bugs stay visible.
- **Enriched OSD**: channel logo (when present) + derived number + title + a live wall
  clock, separated by a divider; no fake HD/now-next until real EPG data exists.
- **Patch react-native-video 6.19.2** (`patches/react-native-video+6.19.2.patch`, wired via
  `patch-package` `postinstall`): its `ExoPlayerView` hard-codes a top-left red "LIVE" badge
  that ignores `controls={false}`; the patch keeps it hidden so `AliranVideo` stays
  chrome-free (its own overlays own all badges).

### Feat: broadcaster reliability — auto-resume, isLive:false on stop, ffmpeg log ring (verified)
- Completes S15b (the ffmpeg **watchdog** and feed-rotation landed earlier in `6e38b90`).
- **Auto-resume on boot.** A started channel now persists its desired state
  (`desiredRunning` in `channels.json`); `ChannelManager.init()` reconciles the registry on
  boot and restarts channels that were running — no more "the broadcaster rebooted and the
  channels are dead." The env/legacy channel stays under `index.js`'s explicit,
  `STREAM_ID`-gated start (so it is never double-started).
- **`isLive:false` on stop — zero panel changes.** The per-channel panel Hyperswarms are
  replaced by ONE manager-owned **`PanelLink`** (`broadcaster/src/panel-link.js`) with a
  per-stream, latest-state-wins op queue. `start()` enqueues the live register; `stop()`
  enqueues `{streamId, feedKey, isLive:false}` and waits ≤5 s for it to land (the S1 catalog
  live-push flips watching clients instantly); a graceful shutdown does the same for running
  channels while keeping them marked for auto-resume. Register cycles are **serialized** —
  the panel keeps one challenge per socket, so interleaved hello→register pairs on a shared
  socket would fail. A **boot catch-up** re-asserts `isLive:false` for every non-resumed
  channel, healing a catalog left stale-LIVE by an unclean crash; a 5-min heartbeat
  idempotently re-asserts running streams. `status.registered`/`registerError` now come from
  the link's per-stream op state (shape unchanged).
- **Per-channel ffmpeg log ring** (`hls.js` `onLine` → a 400-line `{t,line}` ring on the
  Channel): the raw stderr diagnostics for "why won't this source play." It survives ffmpeg
  respawns (a watchdog restart appends a marker line) and clears on an operator start. The
  control-API/UI surface for it lands with S15c.
- `test:broadcaster-api` adds **Test M** (log ring populated; watchdog respawns a killed
  ffmpeg with a restart marker; stop flips the panel catalog to `isLive:false`) and **Test N**
  (a second `ChannelManager` over the same dataDir auto-resumes a `desiredRunning` channel and
  catches up a stale-live entry to idle). `test:core`/`test:register`/`test:sdk` regression-clean.

### Feat: hybrid art — https URLs alongside the P2P assets drive (verified)
- Catalog art fields (`poster`/`backdrop`/`logo`) now accept an absolute **`https://`
  URL** in addition to the `assets/…` drive path. The SDK's URL transforms
  (`_display`→`_artUrl` and `assetUrl`) pass absolute URLs through **unchanged** —
  previously an https poster was mangled into `http://127.0.0.1:<port>/https://…` and
  404'd. Viewers fetch remote art directly from the operator's web host; uploaded art
  keeps replicating P2P. The two forms mix freely per stream and per kind.
- Panel `setMeta` now **validates** art fields (was: any string): `assets/…` path or
  `https://` URL, ≤1024 chars, no line breaks; empty string clears. **https is
  required** for remote art — Android blocks cleartext off-loopback, so `http://`
  would fail silently on devices.
- Dashboard: each art slot gains a **"url" button** (set/clear a remote URL beside the
  upload); remote art renders directly in the card, drive paths keep the
  authed-fetch→blob path.
- `test:assets` extended: validation matrix + the SDK display transform (https
  passthrough, drive path → localhost). `test:sdk` regression-clean.

### Feat: broadcaster control API + UI for ingest/transcode/logs (verified live)
- **API:** `GET /api/capabilities` (the S15a ffmpeg probe: protocols + deep-verified
  encoders); `GET /api/channels/:id/logs?lines=N` → `{lines:[{t,line}], running,
  restarts, state}` (the S15b log ring, ≤400 lines); channel status gains a top-level
  **`state`** (`stopped · starting · up · waiting-input · backoff`) and, for push
  channels, **`ingest.pushUrl`** (rtmp/srt/udp URL built from `PUBLIC_HOST`).
- **Control UI:** add-form ingest-kind selector that hides push protocols the host
  ffmpeg lacks; copy-paste **push URL** on push-channel cards; Edit dialog with
  kind-dependent ingest fields (port/streamKey/passphrase/latency/timeout) and the
  full transcode form (encoder select from capabilities — unverified encoders
  disabled with the probe error as tooltip — resolution/fps/bitrates/preset, hidden
  for `copy`); per-channel **Logs** dialog refreshing every 2 s + the last stderr
  lines inline on an unhealthy card; honest state badges (**ON AIR** / **WAITING FOR
  PUBLISHER** / **RETRYING (exit N)**); "SRT + passphrase = authenticated push" hint.
- `test:broadcaster-api` adds **Test O** (capabilities auth+shape, state + ingest.pushUrl,
  logs API incl. `lines=` cap and 404, `waiting-input` on an idle listener, UI statics).
  Verified in a live browser session: UI-created RTMP channel → WAITING FOR PUBLISHER →
  local ffmpeg push → ON AIR → logs dialog streaming → stop → panel catalog `isLive:false`.

### Feat: live-TV UX — tuning indicator, resume, touch nav, bottom control bar (verified on S22)
- **Channel-change indicator** (`client/src/components/ChannelChangeIndicator.tsx`):
  top-right pill with spinner + channel number/title + a 0→100% progress bar while a
  zap/select (or a fresh entry) tunes. The % is an optimistic ease toward ~90 that
  snaps to 100 on the player's real first-frame signal (`onBuffering(false)` /
  `onReadyForDisplay`) — live HLS has no honest mid-switch %, so only "done" is real.
- **Resume last channel**: leaving Live for the Menu and re-entering resumes the last
  watched channel fullscreen (session-scoped `lastStreamId`; explicit picks from
  Favorites/Search still win; cold boot falls back to the hero + browse list).
- **Touch navigation**: fullscreen tap/OK now OPENS the left browse menu; BACK from the
  menu collapses to fullscreen (was: exit); BACK from fullscreen exits to Menu; BACK
  from channel detail returns to the list. The 6 s browse auto-hide is unchanged.
- **Persistent bottom menu** (`client/src/components/NowPlayingBar.tsx`): replaces the
  fading OSD in fullscreen — channel number/logo/name/LIVE + wall clock, plus phone-only
  ☰ Channels / ⓘ Info / ★ Favorite buttons (`box-none` so stray taps still reach the
  open-menu catcher; TV keeps the identity-only bar clear of the D-pad zap focus path).
- Debug builds: `android/app/src/debug/res/xml/network_security_config.xml` permits
  cleartext (stock RN debug posture) so Metro over LAN works on-device; release keeps
  the strict loopback-only config.
- Verified on the S22 over wireless adb: entry tune 84%→90%, zap 001→002 relabels the
  pill and bar, Channels/Info buttons, menu-open/hide/back chain, and resume-on-002
  after a Menu round-trip (screenshot-driven; tune-to-100% blocked by a VPS feed
  live-edge stall that day — P2P connected at 1 peer, indicator honestly stayed <100).

### Fix: PanelLink self-heals a panel restart — forced topic re-lookup while ops are stranded (verified)
- **The incident (2026-07-16 VPS):** panel + broadcaster restarted together (`docker
  compose up -d --build`); every channel sat at `registered:false` / `lastError:null`
  for 15+ minutes until a manual broadcaster restart. Root cause: the panel's swarm
  identity is ephemeral (`new Hyperswarm()`), so a restarted panel re-announces the
  registration topic under a brand-new keypair — and hyperswarm re-queries a
  client-mode topic only every ~10 min, leaving the broadcaster holding a dead
  pre-restart peer record with queued ops and no delivery attempts.
- **Fix (`broadcaster/src/panel-link.js`):** while ops are pending with no panel
  socket, the link forces `discovery.refresh({client:true})` — a fresh DHT topic
  query — on a 5 s → 60 s backoff, standing down the moment a connection lands. No
  panel changes; a restarted panel is typically re-found in well under a minute.
- **Status stops lying by omission:** once the link has been down ≥10 s with
  undelivered state, `registerError` reads `no panel connection for Ns` (any
  underlying delivery error appended) instead of `null` — surfaces in the existing
  control-UI badge untouched. New `PanelLink.health()` exposes
  `{enabled, connected, disconnectedForMs, pendingOps}`.
- **Tests:** new `test:panel-link` unit suite (no network: late-connection delivery,
  latest-state-wins across an outage, the no-connection message lifecycle, re-lookup
  backoff + stand-down); `test:broadcaster-api` adds **Test P** — the panel swarm is
  destroyed and re-announced under a NEW identity with a stop op stranded meanwhile;
  the stranded `isLive:false` must land with no broadcaster restart.
- KB: `docs/kb/operator.md` gains the symptom→cause→fix entry (older builds:
  restart the broadcaster after a panel restart if `registered` stays false).

### Fix: playback self-heals — tune timeout/evict/re-lookup (SDK) + frozen live edge (client)
Two client-side recovery gaps observed on the S22 against a healthy VPS (2026-07-16):

- **Tune that never completes** (`sdk/player.js`): a zap to a cold feed whose DHT
  records were stale (broadcaster restarted since the last lookup; hyperswarm
  re-queries a client topic only every ~10 min) sat at "90 %" for 10+ minutes with no
  error — and the single-flight open cache handed every retry the same dead open
  until an app restart. Now a **tune watchdog** (p2p-only mode) runs while the active
  feed's playlist hasn't landed: forced `discovery.refresh()` on a 5 s → 60 s backoff
  (the PanelLink self-heal, applied client-side), at `tune.timeoutMs` (default 30 s)
  the cached open is **evicted** and re-opened fresh once (`feed:retune` breadcrumb),
  and a second expiry emits a friendly `tune timeout` **error** the app surfaces.
  `serveFeed()`'s open and the sparse catalog `get` are bounded too, so a wedged open
  can no longer hang `resolve()` or park the catalog watcher; the worklet now relays
  engine `error` events over IPC (previously dropped — no background failure could
  reach the UI). Config: `tune {timeoutMs, relookupMinMs, relookupMaxMs}` through
  `StartOptions.tune`.
- **Frozen live edge** (`sdk/react-native <AliranVideo>`): the live window is short
  (8×2 s = 16 s on the reference deploy), so a network blip longer than the window
  slides it past the playhead and react-native-video fires **no error** — byte-identical
  frames while peers/heartbeats/UI all stay healthy. Once a mount has played, a
  playhead still for `stallTimeoutMs` (default 12 s, not paused) now triggers a
  remount onto a fresh playlist load at the live edge (what the manual zap-away/back
  did) + a new `onStall` callback; `LiveScreen` re-shows the tuning pill until the
  first frame lands.
- **Tests:** `test:sdk` gains the tune self-heal cycle — an entitled, cataloged, but
  UNSEEDED stream must produce forced re-lookups, `feed:retune`, a friendly error
  with the cache evicted, and a plain re-zap must open fresh and play once a
  broadcaster appears (no app restart). KB: both symptoms in `docs/kb/playback.md`.

### Fix: wedged swarm connections are torn down — the self-heal the tune watchdog couldn't reach
On-device verification of the tune self-heal (same S22, same day, 2026-07-16) found a
wedge class it does NOT recover: after a Wi-Fi degrade + off/on cycle, the hyperswarm/
UDX connection to the broadcaster survived at **transport level** while hypercore
replication over it moved **zero bytes** — "P2P — 1 peer" on the phone, `peers=1` on
all 10 feed swarms at the broadcaster, worklet heartbeats healthy, a fresh client
played the same feed in 10 s… and a tune sat at "90 %" for 15+ minutes with **no
error**. Two compounding causes, both fixed in `sdk/player.js`:

- **The watchdog stood down on a STALE playlist.** "Tuned" was "the playlist exists in
  the replica" — but on a warm/prewarmed feed the pre-flap playlist is already there,
  so the watchdog quit on its first tick: no re-lookups, no retune, and the friendly
  error could never fire. "Tuned" now means the playlist **advances** (a live playlist
  rewrites every segment, so a healthy feed passes within seconds).
- **Evict + retune reused the wedged pipe.** Hyperswarm keeps ONE connection per peer
  across all topics, so a fresh open rides the same dead socket — and with prewarm the
  broadcaster is usually the only peer, so one wedged connection starves EVERY channel
  at once. The watchdog now escalates: retune at `tune.timeoutMs`, then **destroy the
  connections serving the feed** at the 2nd expiry (`feed:reconnect` breadcrumb —
  topics stay joined, the swarm dials fresh, corestore re-replicates automatically),
  and only then the friendly error — worst case **≤ 3× `timeoutMs`** (90 s at
  defaults) instead of never. No connected peer to tear down → error at 2× as before.
- **Belt-and-suspenders in the app path:** `AliranPlayer.reconnectActiveFeed()` (new
  public API) exposes the same teardown + re-armed watchdog; the worklet maps it to a
  new `{type:'reconnect'}` IPC message and `AliranBackend.reconnect()`. `<AliranVideo>`'s
  stall ladder escalates to it when a stall **resync remount fails to play** within
  another `stallTimeoutMs` window — a mid-watch wedge now tears the transport down
  instead of remounting onto the same dead replica forever.
- **Tests:** `test:sdk` gains a wedged-connection scenario — the viewer's socket to a
  dedicated seeder is **paused** (probe-verified in-process stand-in for SIGSTOPping a
  seeder: connection stays open, 1 peer attached, live edge frozen — the exact prod
  signature), then a re-zap must produce `feed:retune` → `feed:reconnect` → the wedged
  socket destroyed → the live edge **resumes** with no friendly error and no app
  restart. KB: `docs/kb/playback.md` updated.

### Fix: a login flood can no longer freeze the broadcaster — Argon2id off the event loop
Production incident (2026-07-16 ~20:30, 1 GB VPS ~800 MB into swap): 4-5 `POST
/api/login` attempts against the broadcaster control API blocked the node event loop
for **25+ minutes** — control API dead (HTTP timeouts), swarm replication stalled
(every viewer froze into the friendly tune-timeout error), no self-recovery; the
container had to be restarted. Argon2id verification is memory-hard (64 MiB per
verify at the default cost) and ran **synchronously on the main thread**; the login
throttle counts a fixed window (10/15 min) but doesn't stop attempts queueing, so
each swap-thrashed verify ground for minutes back-to-back. Fixed in
`broadcaster/src/control-auth.js` + `control-server.js`:

- **Worker-thread verify** (`makeAdminVerifier` + new `control-verify-worker.js`):
  the grind runs off the loop — media, replication, and the rest of the control API
  keep answering regardless of Argon2 cost or swap pressure. Unknown usernames still
  cost equal work (timing doesn't confirm admin names).
- **Single-flight with immediate rejection:** one verify in flight, ever; a
  concurrent login gets **`503` now** instead of queueing behind the grind.
- **Verify timeout** (`loginVerifyTimeoutMs`, default 30 s): a verify that outlives
  it fails `503` and its worker is terminated + respawned — a thrashing box keeps
  serving media even while logins are temporarily impossible.
- **Regression test** `npm run test:login-flood` (`tools/e2e-login-flood-test.mjs`):
  floods `/api/login` at incident-scale cost (256 MiB × 6 passes) while a channel
  streams, asserting `/api/status` stays fast throughout (25 ms max observed; the
  pre-fix sync path measured **6.3 s blocked** and zero rejections), the concurrent
  bulk 503s immediately, the channel rides it out, and the timeout path self-heals.
  KB: `docs/kb/operator.md`. Note: the panel's admin login shared the defect —
  ported in the next entry.

### Fix: the panel admin login gets the same hardening — Argon2id off the event loop
The panel's `POST /api/login` had the identical defect the broadcaster was just
fixed for: `panel/src/ops.js verifyAdmin` ran the synchronous memory-hard verify on
the main thread. On the panel the blast radius is worse — its event loop also
drives catalog/assets replication and the viewer login RPC, so a login flood (or a
few attempts on a swapping host) would freeze every fresh app login in the fleet,
not just the dashboard. The user-login OPRF path (`panel/src/rpc.js`) was audited
clean: server-side it does `evaluate` (ristretto255) + Ed25519 `authVerify` only —
the Argon2 grind in that flow runs client-side. Ported one-to-one from
`broadcaster/src/control-auth.js`:

- **Worker-thread verify** (`ops.js makeAdminVerifier` + new
  `panel/src/admin-verify-worker.js`), **single-flight** with an immediate `503`,
  and **`loginVerifyTimeoutMs`** (default 30 s) with worker terminate + respawn —
  same semantics as the broadcaster; equal work for unknown admin names preserved.
- **Regression test** `npm run test:panel-login-flood`
  (`tools/e2e-panel-login-flood-test.mjs`): floods the panel `/api/login` at
  incident-scale cost (256 MiB × 6) with a real Hyperswarm viewer plane connected
  BEFORE the flood — `/api/status` stayed ≤31 ms throughout, a viewer OPRF login
  issued MID-flood completed in 43 ms, the concurrent bulk 503s immediately, and
  the timeout path self-heals. Proven both ways: re-inlining the sync verify makes
  the test fail (2 status samples in 6 s, max **3.7 s**, zero rejections).
  `test:admin-api` A–N green.

### Fix: tuning pill lifecycle — tune-scoped completion, honest self-heal labels, slower ramp
On-device (S22, release of `aa556f6`, 2026-07-16 evening): OAN Plus visibly PLAYING
while the pill still said "Tuning 009 — 90%", the stale state bleeding into the next
zap (pill flashes and dies while the new channel is still tuning), and a slow feed
(hsn: 113 s time-to-play even from a PC) parking at 90% for a minute with no state
change. Root cause: ONE localhost URL serves every P2P channel, so the pill's old
completion signals (`onBuffering(false)`/`onReadyForDisplay`) also fire for the
PREVIOUS channel — which keeps playing under the same URL until the engine flips the
served feed — and the self-heal remounts (`ff05881`) / transport teardowns (`2a5e396`)
re-created `<Video>` mid-switch, orphaning whichever signal the pill was waiting on.
- **`<AliranVideo>` now owns the switch as a TUNE** (`onTune` lifecycle: `start` /
  `retune` / `reconnect` / `playing`, monotonic tune id): `playing` fires on the FIRST
  real playback of the CURRENT tune — the engine must have confirmed the URL serves
  this stream (`port` reply, see below) AND the current mount produced
  progress/first-frame. Completion is mount-scoped (`epoch` shadow of the remount
  counter), so events still held by an outgoing mount are inert, and a mid-tune
  remount simply re-arms the same tune on the fresh mount. A stall resync starts a
  fresh tune id (`onStall` is now log-grade); the engine's `feed:retune`/
  `feed:reconnect` breadcrumbs relay as phases and RE-ARM completion; the friendly
  tune-timeout `error` ends the tune for the host's error UI.
- **The `port` IPC reply now echoes `streamId`** (worklet `backend.mjs` — bundle regen
  required; `AliranBackend.activeStreamId` caches it), so the binding can tell "the
  shared URL just switched channels" (remount to flush the old playlist/buffer —
  zaps no longer depend on ExoPlayer stumbling into the swap via a playlist error)
  from "re-confirmed the channel already playing" (keep the mount; re-entering Live
  stays seamless). Pre-`streamId` bundles degrade to remount-on-every-port.
- **`LiveScreen` drives the pill SOLELY from `onTune`** (no more scattered
  `setSwitching` sites), keyed by tune id so a tune that starts while the previous
  pill is up replaces it atomically at 0%; `ChannelChangeIndicator` grows honest
  phase labels (Tuning / Retuning / Reconnecting — the % hides mid-self-heal instead
  of freezing at 90) and a two-regime ramp (quick attack to ~45%, then a slow crawl
  toward ~85 budgeted ~30 s) so slow-starting feeds don't sit pinned at 90%.
- **Tests:** client jest gains `AliranVideoTune.test.tsx` (stale-mount events can't
  complete or kill a tune; the port reply remounts on a channel switch and not on a
  re-entry; self-heal relabels + re-arms; the friendly error ends the tune; a stall
  resync restarts the tune and completes on the resync mount) and
  `ChannelChangeIndicator.test.tsx` (ramp pacing, phase labels, snap-to-100 + hide);
  `jest.config.js` maps module resolution for the symlinked SDK sources.
- **Error-screen retry honored:** the friendly tune-timeout says "switch to it again
  to retry", but re-selecting the SAME channel was a `play()` no-op — the only way out
  was a trip through the Menu (found live during a real broadcaster outage, S22
  2026-07-16). Re-selecting the erroring channel now clears the error, remounting
  `<AliranVideo>` into a fresh tune.

### Zap latency: shared progressive serving core + availability wait + start-buffer tuning + optional zap prefetch
Real-world zaps against the VPS ran ~3–5 s (and slow-starting pull feeds took 60–113 s
to first play) while LAN zaps were sub-second. Profiling the serve path showed the
byte pipeline was **already block-progressive** (hyperdrive `createReadStream` resolves
64 KB blocks as they replicate — first HTTP byte lands while a 1 MB segment's tail is
still in flight); the real costs were the **404 → 2.5 s player-retry quantization**
while the playlist/first segments replicate, ExoPlayer's **~2.5 s start buffer**, and
**demand-paged segment replication** serialized against the player's sequential fetch
pattern. Four changes (`sdk/serve.js` is new — one serving core for the SDK engine,
the Bare worklet, and the desktop tools via `tools/lib/serve-drive.js`):

- **Availability wait:** a media path not yet in the replica is now *held* (polling,
  bounded at 6 s — under ExoPlayer's 8 s read timeout) and served the moment its entry
  lands, instead of 404ing into the player's 2.5 s retry remount. A genuinely missing
  path still 404s after the bound; poster/art misses (`/assets/*`) 404 immediately.
- **Live-edge read-ahead:** serving a playlist fire-and-forgets a *parallel* blob
  download of its newest 3 segments, overlapping replication with the player's
  sequential requests (and sidestepping per-block round-trips on the read path).
  Superseded downloads are destroyed so rotated-out segments can't strand a range.
- **Start-buffer tuning (`<AliranVideo>`):** ExoPlayer now starts at **1 s** buffered
  (`bufferForPlaybackMs`, was ~2.5 s; 1.5 s after a rebuffer) — every segment starts on
  a keyframe, and the stall-resync → transport-teardown self-heal ladder is the net
  for the slightly higher rebuffer risk. Hosts override via the new `bufferConfig`
  prop (merged over the defaults, delivered as `source.bufferConfig`).
- **Adjacent-channel zap prefetch (`zapPrefetch`, OFF by default):** while a stream
  plays, keep the *newest segment* of the next/previous channels in curated zap order
  replicated locally, so CH+/CH− starts from warm bytes. Unlike `prewarm` (connections
  only, ~free) this costs **standing bandwidth** ≈ each warmed neighbor's bitrate;
  `true` = `{ neighbors: 1, intervalMs: 3000 }`. Plumbed through the worklet IPC and
  the RN binding (`StartOptions.zapPrefetch`); the app keeps it off.
- **Tests:** new `npm run test:serve` (`tools/serve-progressive-test.mjs`) — a
  deterministic byte-budget replication gate proves first bytes serve **while the
  blob tail is provably unreplicated**, the availability wait turns a pre-replication
  GET into a 200 (and misses still 404), Range math is exact (206/416), and a playlist
  GET read-aheads its newest segments with no segment request. `test:sdk`,
  `test:stream`, `test:retention` all green. KB: zap-latency lore in
  `docs/kb/playback.md` + `docs/kb/feed-buffer.md`.

### Scale knobs: per-channel swarm budgets + panel-published blobsKey (the repeater enabler)
Groundwork for the keyless repeater appliance (regional super-peers that mirror
**ciphertext only** — the Open-Connect analog):

- **`SWARM_MAX_PEERS` (broadcaster):** every channel owns its own Hyperswarm, so
  connection budgets are **per channel** (the hyperswarm default of 64 always was).
  The env makes it an operator knob, enforced at accept time on the server-only
  channel swarms (hyperswarm 4.x only budgets outgoing dials): connections beyond
  the budget are dropped before replication starts; the refused viewer's tune
  self-heal finds other peers. Default unchanged when unset.
- **`createPlayer({ swarm: { maxPeers } })` (SDK):** raises the engine's single
  Hyperswarm connection budget for SDK-based seed nodes / the repeater; viewers
  keep the default. Threaded through the worklet IPC and the RN binding
  (`StartOptions.swarm`).
- **`blobsKey` catalog enrichment (panel, "Option B"):** the feed drive's blobs core
  is a *named* core whose key rides inside the **encrypted** drive header — not
  derivable from the public `feedKey`. The panel (which already stores every
  stream's encryption key from register) now opens each registered feed
  asynchronously, reads the blobs-core key from the header, and publishes it in the
  catalog record as `blobsKey` (`panel/src/blobs-key.js`): retried with backoff,
  never blocking the register RPC reply, cleared + re-enriched when a register
  rotates the `feedKey`, swept on panel boot for pre-upgrade records. Publishing it
  is safe — it only enables **encrypted-block** replication; watching still needs a
  per-user sealed grant key. Zero broadcaster changes.
- **Tests:** `test:register` now proves the enrichment round trip against a real
  announced drive (async blobsKey == the drive's real blobs-core key; rotation
  clears + re-enriches; same-key re-register preserves), `test:broadcaster-api`
  asserts enrichment against a live channel (Test D) and across the F4
  source-change rotation, and its new **Test Q** proves the per-channel budget
  (maxPeers=2 → a 3rd concurrent viewer on that one channel is refused while a
  second channel still accepts). SDK unit tests cover the `swarm` option plumbing.

### Repeater appliance — keyless regional super-peer (`repeater/`, S20)
- **New first-class component `repeater/`** — the Open-Connect analog for the
  swarm: a standalone hosted app (operator- or ISP-run) that mirrors chosen
  channels' live windows and serves them to viewers, moving fan-out **off the
  origin broadcaster** (whose per-channel egress drops to ~one stream per
  repeater). Hypercore request hotswapping prefers fast/low-RTT holders, so an
  on-net repeater wins its region with **zero client changes**.
- **Keyless by construction**: config is the panel's *public* key + channel
  selection (`all` / streamId list / `category:` filter) + retention + maxPeers.
  No account, no grants; it never opens a Hyperdrive — it mirrors both drive
  cores RAW at the corestore level (db core by the catalog `feedKey`, blobs core
  by the panel-published `blobsKey`) and stores/serves **ciphertext only**. Its
  package depends on no drive/crypto library at all.
- **Blind block mirror, O(window) storage**: live-downloads the TAIL of both
  cores (`download({ start: length, end: -1 })`), keeps the drive-header block a
  cold viewer needs, and a time-based sweep clears blocks older than
  `RETENTION_SECONDS` (which may be *deeper* than the origin's HLS window — a
  regional blip-recovery buffer). The download range is re-armed from each new
  watermark so cleared blocks are never re-fetched. feedKey rotations re-target
  the mirror through the public catalog watch, unattended, and PURGE the old
  feed's blocks from disk.
- **Deploy pack** (S13 pattern): `repeater/Dockerfile`,
  `deploy/docker-compose.repeater.yml` (standalone box),
  `deploy/systemd/aliran-repeater.service`, `.env.example`, README; new operator
  page `docs/repeater.md` (ISP-hosting model, sizing = pure I/O, security story).
- **SDK**: `createPlayer({ swarm: { bootstrap } })` — custom DHT bootstrap nodes
  for local testnets / private DHTs (used by the new test to drive real viewers).
- **Tests**: new `npm run test:repeater` — origin + panel (with real blobsKey
  enrichment) + repeater + SDK viewers on a **local DHT testnet**: viewer plays
  entirely off the repeater while the origin's only egress is the repeater (byte
  counters both sides); origin killed mid-play → warm AND cold viewers keep
  playing the buffered window; rotation re-points unattended + old cores purged;
  retention stays bounded and cleared blocks stay cleared; the box's store,
  config and status scanned for the encryption key + known plaintext → zero hits.
- **Follow-up (noted, not built)**: panel-assigned repeaters
  (`repeaters/<repeaterPubKey>` records watched from the panel bee) for
  dashboard-managed fleets; locality pinning (panel-published repeater addresses
  as preferred peers).

### Fix: remote acceptance always ends with a verdict — per-channel deadline + fresh-resolve retry (verified live)
- `tools/acceptance-remote.mjs` could hang forever on ONE wedged tune: the localhost
  progressive server holds playlist/segment requests until content exists, and the
  poll loop's clock only ticked *between* polls (the segment fetch had no bound at
  all). Observed twice against the live VPS: 5/6 channels validated in ~15 s, then
  the run sat 25+ minutes on the last one.
- Every per-channel check now runs under a hard deadline (`--deadline`, default
  `min(90, --timeout)` s). On expiry it retries ONCE with a fresh `resolve()` —
  which re-reads the catalog feedKey and re-arms the SDK tune self-heal — then
  reports a per-channel FAIL. `connect()` is bounded too (60 s), and a wedged
  `player.stop()` can no longer hang teardown. Output format and exit codes are
  unchanged (0 iff every expected-live channel validates).
- Each channel's ffprobe sample now lands in its own temp dir (all concurrent
  checks previously wrote `probe.ts` to whichever temp dir was created last).
- Verified against the live VPS: `--deadline 1` forces expiry → retry → per-channel
  FAIL, exit 1, no hang; a default run then hit the real wedge on 3/6 first tunes
  and the fresh-resolve retry recovered ALL three in ~7 s → 6/6 PASS, exit 0.
  A wedge that a fresh resolve clears immediately is more evidence for the
  wedged-connection-reuse theory from the S20 rollout notes.

### Fix: the wedge behind that acceptance hang — a media read committed to a reclaimed blob never ends (fixed in the SDK serving core)
The acceptance deadline+retry above treated the symptom; instrumenting the live VPS
found the real cause, and it is **not** wedged-connection reuse. The feed is an
EPHEMERAL rolling buffer: `broadcaster/src/hls.js` (`mirrorDirToDrive`) frees the
PREVIOUS `/index.m3u8` blob the instant it writes the next (~every 2 s), so each
playlist version's blob is fetchable for only about one segment. A viewer replica
that lags the live edge by a rotation resolves the path to a version whose blob has
ALREADY been reclaimed everywhere — `createReadStream` then waits FOREVER for blocks
no peer holds. Node buffers the 200 response headers until the first body byte, so
the response never flushes headers and never ends; a client with no read timeout
(the acceptance harness's `httpGet`) hangs indefinitely.

- **Proven on the live VPS (2026-07-17):** a single held `/index.m3u8` request stuck
  44 s+ (`never completed`, no response headers) while FRESH reads issued every
  second returned 200 in 2–60 ms — the *current* live version's blob is always
  present; only the committed-to old version is gone. So one HTTP request dies while
  the feed is perfectly healthy, and the harness's unbounded `httpGet` never retries.
- **The tune watchdog cannot see this.** Its health signal is the playlist's METADATA
  signature (`drive.entry().seq`), which advances normally as versions replicate — so
  it stands down ("playlist advanced — tuned") and, even if it stayed armed, its
  remedies (evict / retune / teardown) would not restore a blob the broadcaster
  reclaimed. This is a read-path stall, not a discovery or connection fault: the
  watchdog is the wrong layer, which is why the earlier wedged-connection-reuse theory
  didn't fit (a fresh resolve clears it because a fresh READ re-resolves to the live
  version, not because a new connection is dialed).
- **Fix in `sdk/serve.js`** (the shared progressive core behind the SDK request
  handler, the Bare worklet, and the desktop tools): a media read that yields NO bytes
  for `readIdleMs` (default 6 s, under ExoPlayer's 8 s read timeout) is aborted, so the
  client re-requests and re-resolves to the current live version whose blob still
  exists. The idle clock arms before the first byte (a read that never yields one must
  abort too) and RESETS on every block, so a slow-but-advancing progressive read is
  untouched. In the acceptance harness the abort turns the infinite `httpGet` hang into
  an error its existing `waitFor` loop retries in ~6 s (the external deadline+retry is
  now a rarely-hit backstop); on-device it drives react-native-video's retry sooner and
  cleaner than its own read timeout, so a stuck tuning pill clears instead of parking.
- **Tests:** `npm run test:serve` gains case E — put a segment, replicate its ENTRY,
  then CLEAR its blocks at the writer (the broadcaster's per-rotation reclaim), and a
  GET committed to that blob must ABORT within the idle bound instead of hanging;
  cases A–D (progressive body, availability wait, ranges, read-ahead) are unchanged.
  `npm run test:sdk` (tune self-heal + wedged-connection teardown + hybrid + prewarm +
  zap-prefetch) stays green.
- **Verified live:** the same held request that stuck forever now aborts at ~7 s
  (`readIdleMs` + startup) while fresh reads keep serving in ms; two full
  `tools/acceptance-remote.mjs` runs against the VPS passed 6/6 with every channel
  10–22 s to play — none near the 90 s deadline and no fresh-resolve retry needed
  (before the fix, a wedged channel sat ~97 s = deadline + external retry).

### Fix: the tune watchdog no longer stands down on metadata alone — "tuned" now requires servable bytes
Companion to the stalled-read fix above, closing the other half of the 2026-07-17
wedge: the tune watchdog's "tuned" verdict was **"the playlist signature advances"**,
but that signature is the playlist entry's bee seq — **metadata-core** state — while
the bytes a player needs ride the **blobs core**. The two are separate replication
channels with separate failure modes, so a feed whose metadata replicates while zero
blob bytes are fetchable (broadcaster reclaim outpacing a lagging viewer, or a
starved/wedged blob channel) advanced the signature and stood the watchdog down on
its first tick — after which **nothing at the SDK level ever escalated or surfaced an
error** for a tune that never became playable: no re-lookups, no retune, no
connection teardown, no friendly error, exactly the ladder built for this situation.
The live instrumentation showed all three wedged channels with `watchdog=off` within
seconds while zero media bytes were served for 90 s.

- `sdk/player.js`: the stand-down check now also demand-reads the CURRENT playlist
  **content** (new `_playlistServable` — bounded `drive.get`, must yield bytes that
  reference at least one media URI). It re-resolves to the newest version on every
  call, so it is never pinned to a reclaimed blob; on a healthy feed the blob is
  already local (the serving layer pulled it for the host player) and the probe is a
  cache hit. While content stays unfetchable the watchdog stays armed and walks its
  existing ladder — retune at `timeoutMs`, connection teardown at 2× (the right
  medicine for a wedged blob channel), friendly error by ≤3×.
- **Tests:** `npm run test:sdk` gains the metadata-advancing-but-unservable scenario —
  a pathological seeder rewrites the playlist every 500 ms and clears its blob blocks
  immediately (the broadcaster's per-rotation reclaim, made permanent); the viewer
  must keep the watchdog armed despite the advancing signature, produce
  `feed:retune` → `feed:reconnect`, and surface the friendly error instead of
  spinning silently. Proven both ways: the scenario fails on the previous advance-only
  code (no error ever fires) and passes with the content check.
- Known limitation (noted, not fixed): hybrid mode's stall watchdog / recovery probe
  still judge P2P health by signature advance alone — same conflation, out of scope
  here (hybrid is not in production use). **Closed by the next entry.**

### Fix: hybrid stall/recovery probes require servable bytes — no CDN-fallback miss, no flip-back to an unplayable feed
Closes the known limitation above: hybrid mode's two background probes judged P2P
health by the playlist **signature** alone (the entry's bee seq — metadata-core
state), the same metadata/blobs conflation just fixed in the tune watchdog. Against
a feed whose metadata replicates while its blob bytes are unfetchable (broadcaster
reclaim outpacing the viewer, or a starved/wedged blob channel) that meant two
failure modes: the **stall watchdog** saw an "advancing" playlist and never fired
the CDN fallback (the viewer rebuffered on P2P forever), and the **recovery probe**
could flip a CDN viewer back to the unplayable P2P source and strand it there with
the fallback already spent.

- `sdk/player.js`: both probes now gate their healthy verdict on
  `_playlistServable` (the bounded content read introduced for the tune watchdog)
  **in addition to** signature advance. The stall watchdog only resets its stall
  clock when the advanced playlist's content is fetchable; the recovery probe's
  `healthyStreak` only counts probes whose advance is servable (unservable resets
  the streak). The ≥2-streak anti-flap semantics are unchanged — the stricter
  verdict only makes flips back to P2P *less* eager, so no new CDN↔P2P flapping
  surface. Both probe loops are busy-guarded (the bounded content read can outlast
  the tick interval) and re-check the active play after their awaits.
- **Tests:** `npm run test:sdk` gains the hybrid half of the pathological-seeder
  scenario — the same rewrite-every-500 ms/clear-blobs-immediately feed, played in
  hybrid mode from a prewarmed replica (so the play deterministically starts on
  P2P): the stall watchdog must emit `fallback` (reason `stall`) despite the
  advancing signature, and over an 8 s observation window on CDN the recovery probe
  must never emit `source-changed` back to p2p. Proven both ways: on the advance-only
  code the fallback never fires (the run times out at the new scenario); with the
  servable gate the full suite passes. The existing hybrid scenario keeps proving the
  positive path (a genuinely seeded feed still auto-returns to P2P through the new
  servable gate).

### Smooth zapping — user toggle over adaptive zapPrefetch + viewer-bandwidth docs (S21, verified)
- **The zapPrefetch that shipped OFF in the zap-latency pass is now a product
  feature**: a "Smooth zapping — uses more data" switch in the app's Settings
  (default OFF, persisted beside the other device prefs, applied live mid-play and
  at every boot), backed by an engine that spends bandwidth only when it is safe to.
- **SDK (`sdk/player.js`)**: `setZapPrefetch()` runtime switch (re-arms/clears the
  warm loop mid-play) + an **adaptive gate** that suspends prefetch — dropping every
  standing download while a cheap tick watches for recovery — when (a) the host
  reports a **metered/expensive network** (`setNetworkProfile`, lifts immediately
  when cheap), (b) the **active playlist stops advancing** for `stallMs` (12 s
  default; resumes after `resumeMs` = 60 s of clean advance — prefetch never
  competes with playback), or (c) neighbor segments download **slower than
  `minHeadroom`× realtime** (3× default, two thin samples — the pipe can't carry a
  second stream). **Directional prefetch** (default on): once the viewer's surf
  direction is known, only that side is warmed — half the standing cost for the
  common CH+ CH+ CH+ pattern; menu jumps reset to both sides. Lifecycle is
  observable via new `'zap-prefetch'` events.
- **`uploadPolicy: 'reseed' | 'client-only'`** (boot option): `client-only` joins
  feed/assets topics **unannounced** (`server: false`) — not discoverable, so
  practically zero viewer-to-viewer upload by construction; documented trade-off is
  one fewer re-seeder in the swarm.
- **Worklet/IPC + RN binding**: `zap-prefetch-set` (persists the choice + applies
  live) and `net-info` messages; `AliranBackend.setZapPrefetch()` /
  `.setNetworkProfile()`; prefs reply carries `smoothZapping`; the boot handler
  applies the persisted choice over the compiled default. App wires NetInfo's
  `isConnectionExpensive` down automatically (new `@react-native-community/netinfo`
  dep, defensively optional so stale builds don't crash).
- **Docs**: new `docs/kb/viewer-bandwidth.md` with the measured numbers (idle
  prewarm ≈ 5–6 KB/s per 10-channel lineup; watching ≈ bitrate ~2–3 Mbps; smooth
  zapping ≈ +1 neighbor bitrate, halved by directional; upload = opportunistic
  re-seeding; battery notes), SDK/RN README sections.
- **Tests**: `test:sdk` extends the live harness with the runtime OFF↔ON switch
  mid-play, metered suspend/lift, directional warm-set assertions, the stall
  suspend + clean-run resume (mirror frozen and re-fed), and `client-only` playing
  while joined `server:false` (default player asserted `server:true`) — full suite
  PASS; client jest grows a SmoothZappingToggle suite (10/10 with the existing
  suites), `tsc` clean; worklet bundle re-packs.

### Redirect channels — a CDN-link channel class in the catalog (S23, verified)
- **New channel class**: a catalog record can carry `{ redirect: true, url: 'https://…' }`
  — viewers play the operator's URL **directly** instead of a P2P feed. P2P channels
  are untouched (no CDN backup, no hybrid config needed anywhere).
- **Panel**: `url` (https-only, ≤2048 chars, tokenized query strings verbatim, no
  extension requirement) drives the pair atomically — non-empty ⇒ `redirect: true` +
  live-by-default (explicit `isLive`/`status` in the same request win), empty ⇒
  clears; a redirect entry can never also hold a `feedKey`; a broadcaster re-register
  never erases the class (same admin-owned rule as curation/art). Admin API/UI:
  "Redirect URL" field on Add stream + Edit metadata, ⇢ REDIRECT badge + url line on
  the stream card.
- **SDK**: `resolve()` gains the redirect branch — returns `{ url, source: 'cdn',
  port: undefined }`, opens no feed, joins no swarm, arms no watchdogs; the bounded
  live catalog read now carries `redirect`/`url`, so an admin url edit reaches
  viewers on their **next tune** (no re-login); zap-prefetch / feed-rotation paths
  skip feedless tunes; the display list stays metadata-only (no url). The client app
  needs **zero code changes** — the URL flows through the existing `port` IPC reply
  and remote https playback was already proven by the hybrid path; worklet bundle
  re-packed.
- **Tools**: `acceptance-remote` probes redirect channels with a direct https fetch
  (PASS = HTTP 200 + `#EXTM3U`; segment/ffprobe skipped — tokenized CDNs may sign
  per-URI); `test:sdk` grows a redirect scenario (verbatim URL passthrough incl.
  query string, next-tune url edit, feedless non-redirect still throws, p2p↔redirect
  zap arms/clears the tune watchdog, hybrid machinery untouched); `test:admin-api`
  Test O covers validation, defaulting, class exclusivity, register-preserve and
  purge. Docs: `docs/content-management.md` + SDK README sections.


### Remote channel sources — provider JSON feeds as categories (S27, verified)
- **The idea**: a provider publishes a prepared channel list (id/name/logo/https
  HLS url per entry — e.g. a GitHub-raw `anime-es.json` refreshed daily); the
  operator registers it once as a **source** with a rail label ("Anime") and the
  panel keeps a **category of redirect channels** in sync with it. P2P channels
  tagged with the same category share the rail — category was already ordinary
  catalog metadata end-to-end, so the whole feature is panel-side and needs **zero
  SDK/app changes**.
- **Engine** (`panel/src/sources.js`): registry in `DATA_DIR/sources.json`
  (nothing secret); per-source scheduled pull (daily default, hourly due-check
  tick, boot catch-up, single-flight, manual "Sync now") with ETag revalidation, a
  streaming-enforced byte cap and an entry cap; entries validated as **pure
  data** with the exact admin-input validators (https-only playback url — entry
  skipped otherwise; art rules — bad logo degrades to no art; id charset), then
  diffed against the catalog: create / update-only-if-changed / **delete when the
  entry left the feed** (operator decision — full purge, grants included).
  Unchanged feed or 304 ⇒ **zero Hyperbee appends**. Ownership is explicit:
  imported records are stamped `source:<name>` and a sync can only touch records
  carrying its name — a malicious feed cannot collide into manual channels or
  another source (conflicts are skipped + reported). Fetch failures keep the last
  good state and surface `lastError` in the dashboard.
- **Grants**: `autoGrant` (default on) seals every imported channel to **every**
  user, reconciled on every sync (304s included) so accounts created between pulls
  converge, plus an immediate grant pass at user creation (admin API + CLI). New
  channels reach devices at their next login, the known wrapped-key behavior.
- **EPG**: the feed carries a full-day schedule per channel; it deliberately stays
  **out** of the append-only replicated bee (57 KB/day/category, forever, on every
  client). Imported records instead carry `epgUrl`/`epgId` pointers so a client
  can fetch the schedule over https on demand — planned client follow-up, same
  public-https stance as remote art and redirect urls.
- **Surface**: `add-source` / `list-sources` / `set-source` / `sync-source` /
  `remove-source [--keep-channels]` (registry verbs are file-only and safe beside
  a running panel); `/api/sources` CRUD + `/sync`; dashboard **Sources** tab (add
  auto-syncs, per-row sync now / edit / pause / remove with a keep-channels
  detach option, last-report and error inline) and a ⇣ source chip on imported
  stream cards. Removing a source purges its channels; detaching strips the
  stamp and leaves them as manual redirect channels.
- **Verification**: new `test:sources` e2e (in-process panel + loopback feed
  server — deterministic, added to the REQUIRED core CI lane) covers validation,
  first import (mapping/skips/conflict/grants), 304-and-unchanged frugality
  (bee version pinned), mutation (update/remove/add + curation surviving), the
  create-user hook, autoGrant toggle + reconcile, caps, oversized/unreachable
  feeds failing safe, the scheduler self-syncing a never-synced source, and both
  removal modes. `test:core` + full `test:admin-api` (A–P) stay green. Live
  browser check against the **real** provider feed: 10 anime channels imported
  through the dashboard, real GitHub ETag answering the second sync with
  "not modified", stream cards showing LIVE / ⇢ REDIRECT / ⇣ anime / Anime chips.
