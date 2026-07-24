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

### Sources: per-channel deselect — the exclude list (S27b, verified)
- **Ask:** the import shows what the feed added — the operator wants to UNCHECK some
  of them. New per-source `exclude` list of FEED ids ({id, title} — the label is
  captured at exclusion time so the dialog can name entries that no longer exist in
  the catalog): excluded entries are skipped by `mapFeed` (counted, not an error),
  which routes them through the normal missing→delete path — removed immediately,
  grants included — and keeps them out on every future sync. **An exclusion change
  resets the stored ETag**, otherwise a 304 would skip the apply pass and silently
  mask a fresh deselection.
- **Surface:** Sources tab **channels** button → checkbox dialog (imported entries in
  feed order + excluded ones labeled `(excluded)`; Save + sync applies immediately;
  dialog body scrolls for big lists), "N excluded" chip on the row, new
  `GET /api/sources/:name/channels`, `PATCH {exclude}` and `set-source --exclude
  "id1,id2"` (`""` re-includes all).
- **Verification:** `test:sources` grows group I — exclude removes+purges (catalog,
  secret, grants), the dialog endpoint carries the captured label, the standing
  exclusion holds through 304s with the bee version pinned, re-include re-imports
  and re-seals grants; A–J PASS. Live dashboard round-trip against the REAL feed:
  10 → uncheck Avatar → 9 + "1 excluded" chip + `−1` report → re-check → 10 back
  with `+1`. (Fun catch during the demo: the provider feed lists Avatar LAST —
  it was appended after the alphabetical bulk, which is exactly the kind of feed
  drift the ownership/diff machinery shrugs at.)

### Program guide (EPG) — fetched on demand from the same provider JSON (S27, verified)
- **The answer to "how does EPG work remotely with the same JSON?":** the schedule
  never enters the catalog (append-only replicated bee — a day of programs per
  category would grow every client's store forever). Since S27 every imported channel
  carries `epgUrl` (the same feed URL) + `epgId` (its id inside the feed); now the APP
  fetches that JSON over https on demand and renders the guide client-side.
- **SDK** (`sdk/player.js` `_display`, `sdk/login.js`, `sdk/react-native` `Stream`):
  `epgUrl`/`epgId` pass through the display list on both the login and live-push paths
  — public https, exposed like the art URLs (unlike `url`/`redirect`, which stay
  engine-internal). Worklet bundle regenerated (gitignored/local); `test:sdk` asserts
  the pointers reach the display list and that a channel without them doesn't grow them.
- **Client** `src/epg.ts` (`EpgService`): one fetch per feed URL, ETag-revalidated,
  size/timeout-guarded, indexed by `channels[].id`; `getNowNext(url,id)` selects the
  current program (start≤now<stop) + the next few from the cached, start-sorted list.
  Refetch only when the cached schedule no longer covers `now` (or it ages out), min-
  interval throttled, concurrent callers coalesced, failures degrade to an empty guide
  (never throws). A whole category costs ONE fetch (all its channels share the URL).
- **Info panel** (`ChannelInfoPanel`): the old honest placeholder slot now shows a live
  **Now** row (title + local HH:MM–HH:MM + elapsed bar) and an **Up next** list, on a
  30 s refresh so it rolls over while open; channels with no/failed EPG keep "No program
  information" — never fabricated. `useEpg` hook cleans up its interval on unmount.
- **Any channel, not just imports** (`panel/src/ops.js`): `setMeta`/`addStream` accept
  `epgUrl` (https, empty clears) + `epgId`, exposed on `set-meta --epg-url/--epg-id`,
  `PATCH /api/streams`, and the dashboard Edit dialog — point a P2P channel at a
  compatible JSON and the same guide lights up.
- **Cost/trust:** a handful of ~tens-of-KB fetches per active viewer per day (mostly
  304s), zero panel storage / replication / VPS bandwidth; same public-https stance as
  art and redirect URLs (the device fetches the provider host directly).
- **Verification:** client jest +2 suites (7 EpgService cases: parse/now-next, per-URL
  cache, ETag 304 keeps data, coverage-expiry refetch, empty/failure degrade, coalesce;
  3 ChannelInfoPanel cases: now+next render, no-EPG placeholder + no fetch, empty→
  placeholder) → 20/20 client tests, `tsc` clean; `test:sdk` FULL PASS with the new
  passthrough assertions; `test:sources` grows an A0 case (EPG set/clear on a manual
  channel via setMeta + http rejection) → A0–J. On-device install deferred (phone off
  wireless adb).

### Bounded disk metadata — orphaned-generation GC + periodic feed rotation (S28, verified)

The `disk` buffer keeps *segment data* O(window) via blob reclaim, but a hypercore's
append-only **merkle tree / metadata** is never freed by `clear()`. It grows for a feed's
whole lifetime — measured ~1–2 MB/h per channel, and on the production VPS the channel
store climbed 180 MB → 1177 MB over three days (of which `tree_alloc` alone was 823 MB). A
slow disk creep, not a crash, but unbounded. Two contributors, each now bounded:

- **Retired generations.** A source change (or a rotation) bumps `feedGen` → a new
  Corestore namespace → brand-new cores, orphaning the previous generation's cores — tree
  and all — on disk. New `purgeStaleCores()` (`broadcaster/src/hls.js`) deletes every
  retired generation's whole core directory, keeping only the current generation's
  metadata+blobs discovery keys. It runs at every start (a reopened disk store sheds prior
  generations), after each rotation's grace teardown, and periodically. It refuses to run
  without both live discovery keys and only ever touches 64-hex core dirs under `cores/`,
  so a half-open drive can never delete the running feed. Always on, nothing to configure.
- **A single long-lived feed's own tree.** Bounded by opt-in **hot feed rotation**
  (`_rotateFeed`): mint the next generation's drive over a fresh namespace, mirror the same
  live window into it (ffmpeg untouched), announce its topic, swap it in as the served feed,
  then retire the previous generation through a grace window (it keeps replicating +
  announced so in-flight viewers finish following) before tearing it down and purging its
  cores. The encryption key is unchanged (grants survive); only the feedKey moves, which
  watching viewers follow live over the catalog (`_maybeReresolveActiveFeed` → `feed-changed`,
  the same path as a RAM restart or source change). Triggered by `FEED_ROTATE_HOURS` /
  `FEED_ROTATE_TREE_MB` (both off by default — orphan GC is always on) or
  `POST /api/channels/:id/rotate`. Keep rotation infrequent to preserve disk mode's
  warm-topic benefit; `docs/kb/feed-buffer.md` carries a cadence/disk-ceiling tuning table.

The swarm connection handler now replicates the whole store (`store.replicate` — equivalent
to `drive.replicate`), so a retired-but-draining generation and the current one are both
served to peers requesting either discovery key.

**Verified.** `retention-test` scenario D lays down two generations on disk and asserts
`purgeStaleCores` keeps only the current generation's tree (not the accumulated history)
while the live generation survives intact, plus the empty-keep-set safety no-op.
`broadcaster-api` Test F5 hot-rotates a running channel and proves ffmpeg stays live, the
panel catalog **and a fresh viewer** follow the new feedKey, and the retired generation is
purged after grace. **Live on the VPS**: with `FEED_ROTATE_TREE_MB=250`, the watchdog
auto-rotated the two channels over the cap — store 1.3 GB → 889 MB, `tree_alloc` −347 MB in
the duration-test cron — while all six channels kept streaming through it.

### Broadcaster self-heals a corrupt feed store on start; a 4 vCPU / 8 GiB scale bench (verified)

An unclean broadcaster exit — SIGKILL, OOM, power loss, or a `docker stop` that outruns its
grace period while many channels are closing — can truncate a disk feed's core files
mid-write, so the store never reopens (`EPARTIALREAD: Could not satisfy length`, or
`OPLOG_CORRUPT`). This bit a resized production box after a `docker stop`: **all six**
channels' stores were truncated and every one failed to start — and because the boot
reconcile caught `start()`'s error and *swallowed it silently*, the only symptom was "0
ffmpeg" with no reason in the logs.

The fix, three parts plus prevention:

- `start()` now opens the feed drive via `_openFeedDriveSelfHealing()`. On a corruption
  error it rotates **once** to a fresh generation (bump `feedGen` → a new namespace derives
  brand-new, uncorrupted cores), logs it, and continues; the start-time GC then purges the
  corrupt old generation. The encryption key is untouched (grants survive) and viewers
  follow the new feedKey via the catalog. Disk mode only — a `ram` store is fresh every
  start anyway.
- The boot reconcile now **logs any auto-resume failure** (corrupt store, capability gate,
  port clash) instead of failing silently.
- `isStoreCorruption()` recognizes `EPARTIALREAD` / "Could not satisfy length" — the
  truncation error a killed `store.close()` leaves behind, which `sdk/recover.js`'s
  `isCorruptionError` was missing (added there too, for the client's own recovery).
- `docker-compose.yml` sets `stop_grace_period: 60s` so a clean shutdown of a many-channel
  box has time to finish — defence-in-depth on the prevention side.

**Verified.** `retention-test` scenario E truncates a real metadata `tree` file and asserts
the reopen throws `EPARTIALREAD` *and* that `isStoreCorruption` catches it; `broadcaster-api`
Test F6 starts a disk channel, stops it, truncates its store on disk, and asserts `start()`
self-heals to a fresh generation and comes back live. Deployed to the VPS (`StopTimeout=60`
confirmed, clean reopen).

While benchmarking the resized box (**4 vCPU / 8 GiB / 100 GiB NVMe @ 1300 IOPS**) with
`tools/scale-bench.mjs`, a 4→48-channel copy sweep showed **CPU is the binding wall (~80
channels)** — `copy` is not free at density (48 ffmpegs + the mirror ≈ 2.4 cores, ~5 %/ch);
**RAM is ~19 MB/ch** (the tool's summed ffmpeg RSS triple-counts shared libraries — trust
`free -m`, not the summary); and **disk IOPS is a non-issue** (48 channels drove ~62 write
IOPS / 13 MB/s — the page cache absorbs the write-then-delete churn, so more RAM indirectly
buys IOPS headroom). So ~50 copy channels is comfortable on this box. See `docs/kb/scaling.md`.

### Swarm UDP socket buffers — the silent stall under fan-out (verified)

Hyperswarm's transport is UDX, which multiplexes **every** peer stream of a swarm over one UDP
socket pair. Under viewer fan-out the traffic concentrates on that single socket rather than
spreading across per-viewer connections, so the kernel socket buffer runs out first — and when
it does the kernel drops datagrams **silently**. UDX's congestion control only sees a gap,
backs off, and the symptom is stalling throughput with nothing logged anywhere. Measured on the
live box: UDX raises its own receive buffer to 1 MiB but leaves the **send** buffer at the OS
default (212992) — and sending is exactly what a broadcaster or repeater does under fan-out, so
the untuned direction was the one that mattered.

`core/net-tune.js` requests both directions at swarm startup, reads the achieved size back, and
reports clamps — best-effort throughout, so a refused `setsockopt` is logged, never thrown
(tuning can never be why a service fails to boot). Wired into the broadcaster's per-channel
feed swarms + panel link, the panel, and the repeater; `SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB`,
default 2/2 (repeater 4/4). Detecting a clamp needs `/proc`, not a readback: Linux caps the
request at `net.core.{r,w}mem_max` and **then stores double** the capped value, so a request
between the ceiling and twice the ceiling reads back larger than asked even though it was
capped — the ceiling is read from `/proc` and treated as authoritative. A clamped request logs
a warning naming the exact sysctl, deduped process-wide (43 channels must not print 43
warnings).

Raising the ceiling is a **host** action Docker cannot perform (the services run
`network_mode: host`, where Docker refuses `net.*` sysctls), so it ships as an optional
standalone `deploy/sysctl/install.sh` that nothing in the normal deploy calls — idempotent, and
it verifies the value actually took. New `test:nettune` (required CI lane) covers the doubling
trap, `/proc` parsing and its non-Linux fallback, a real bound UDX socket, and the dedupe; it
asserts whichever outcome is correct for the host, so stock-kernel CI exercises clamp detection
against a real undersized ceiling. See `docs/kb/network-tuning.md`.

### Panel control-plane disk: idempotent register + the probe-core leak (S29, verified)

Three fixes to unbounded growth in the panel's own on-disk state, found chasing
`aliran_panel-data` size on the live box.

**Idempotent register.** The register responder rebuilt a catalog record and `put` it
unconditionally, but the broadcaster's PanelLink re-asserts every running stream on a 5-minute
heartbeat, and the signed Hyperbee is append-only with no compaction — so every heartbeat cost
a block forever (43 channels ≈ 12,384 redundant appends/day at ~487 B). It now compares the
rebuilt record against the stored one and skips the put when identical (an exact byte
comparison — `valueEncoding:'json'` stores `JSON.stringify(value)`, and the record is a pure
function of the payload with no timestamps or nonces). Carve-outs still write: feedKey rotation,
`isLive`/status flips, an origin change (attribution the audit trail must keep); the private
secrets file still lands on the skipped path; and the blobsKey enricher is still nudged, since
the heartbeat **is** its retry timer.

**The probe cores were the real leak.** To publish a feed's blobsKey the panel opens that feed's
drive on its own corestore. Those cores are **keyed** (metadata by feedKey, blobs by the key
inside the encrypted bee header), so corestore files them under `cores/<discovery-key>/`
regardless of the `blobs-probe:` namespace — and `drive.close()` only ended the session; the
directories stayed on disk forever. Harmless while feedKeys were stable, but **S28's periodic
rotation mints a fresh feedKey per rotation** and re-enqueues the enricher, so the control plane
grew with rotations × channels, without bound (this was the 2.1 GB). Each probe now `purge()`s
the cores it opened (close every session, unlink storage; corestore's `rmdir` takes the
directory with the last file); teardown is shared with `close()` and idempotent, and probes
register before `ready()` so a failed open is purged too. Not a RAM store, deliberately — a
second corestore replicating on the panel's existing connections would clobber the
`hypercore/alpha` protomux pairing and silently break serving the signed DB by discovery key.

**Reclaiming what older builds stranded.** Purging new probes bounds new growth, but nothing
collects the cores a pre-purge build already wrote. `openStore()` now sweeps them, reusing the
GC the broadcaster has trusted since S28 — which moved to `@aliran/core/store-gc.js` (panel/
cannot import from broadcaster/; both images vendor core/). Two fail-safe guards: all **three**
cores the panel owns must resolve (the signed bee + the assets drive's metadata and blobs
cores) or it deletes nothing, and anything the Corestore currently holds open is kept
regardless. On deploy this logged `reclaimed 191 stray core dir(s), 2188 MB freed`; the panel
volume went **2.1 GB → 18 MB**, core dirs **194 → 3** (the documented steady state — never
hand-delete those; the bee is the single-writer origin of truth with no peer to re-replicate
from). `test:register` plants strays (including a core too corrupt to open) across four
rotations and a permanently-unreachable feed, and asserts they are gone while accounts, catalog
and assets survive — all negative-checked.

### Ops dashboard, shared theme, and backup sources (verified)

The broadcaster dashboard rendered channels as a vertical card stack — fine at 6, unusable at
the 69 the scale test runs. Rebuilt on an operations-dashboard shape: a dense
sortable/filterable table that **sorts by urgency** by default (retrying > waiting > starting >
on air > stopped) so problems surface at the top, plus five KPI tiles all derived from real
control-API values — deliberately **no** CPU/RAM/disk bars, because the control API exposes no
host metrics and inventing them would be a lie. "Peer links", not "peers": the number sums
per-channel swarm connections and one S21 zap-prefetch viewer holds several, so it is not a
viewer count. The uptime column shows how long the **current** ffmpeg has been alive
(`watchdog.lastRestartAt`), not when the operator pressed Start — at ~2.5 respawns/channel/hour
those differ by hours, and only the ffmpeg clock says whether media is actually flowing.

Both dashboards now use the palette from `client/src/theme.ts` — they administer the same
product but looked unrelated (broadcaster warm brown, panel cool cyan); `test:theme` asserts
the shared block stays byte-identical across both stylesheets.

**Backup sources.** A pull input takes `fallbacks` (max 4, same validation as the primary). A
run of consecutive failures fails forward to the next url; return-to-primary is opportunistic —
re-probing on a later respawn rather than interrupting a working backup — so failover is **not**
sticky. The rotation decision is a pure exported `pickSource()`, unit-testable (args groups
J/K). `status()` reports `sourceIndex`/`sourceCount`/`activeSource` and a **BACKUP** badge
surfaces the case that otherwise hides: channel looks healthy, primary is down. The Edit dialog
dropped title/description/category — those are panel-authoritative and editing them here only
changed a local copy viewers never saw.

### Category presentation registry — bulk rename and merge (verified)

Categories could only be edited one channel at a time as a free-text array. With 300+ channels
on two-level rails like `Nacional/Chile` there was no list of which categories exist, no
ordering, no hierarchy, and renaming a rail meant editing every channel by hand. A new
`catmeta/<slug>` keyspace owns **presentation only** — label, parent, order, hidden — while
catalog records keep `category: ['Nacional/Chile']` exactly as before, so the RN app, the SDK
and every existing client are untouched (this is why it was chosen over first-class category
IDs).

Membership and presentation write different keys and therefore cannot fight, which closes the
long-standing "manual edits to mapped fields don't stick" wart: a source feed decides which
channels carry its category and reasserts that on every sync; the operator owns how it looks.
Documented honestly — renaming a **source-owned** rail via catmeta is undone by the next real
re-sync (a 304 sync leaves it alone); rename the source's category instead. Rename cascades to
children and de-duplicates on collision; every put is gated by the S29 idempotency rule so a
no-op costs zero appends. Key ordering was verified before choosing the prefix: catalog scans
are bounded `gt:'catalog/' lt:'catalog0'`, and `catmeta/` sorts above `catalog0`, so the new
keyspace is invisible to them. Surfaced as a Categories tab (tree view, inline edit, rename,
merge, forget) with admin-cli parity. Tests: admin-api group Q and sources group K, both
negative-checked.

### Runtime upload policy + a bounded feed cache (S25, verified)

**Network-adaptive upload.** `uploadPolicy` was fixed at construction and the RN client never
set it, so every viewer re-seeded on every network; the metered gate only suspended prefetch.
`setUploadPolicy()` now flips re-seeding mid-session, wired to the client's NetInfo listener:
cellular **or** expensive → `client-only`, restoring the configured policy when the network is
cheap again (a deployment shipping `client-only` is never silently upgraded to reseed by a
Wi-Fi event). The mechanism is subtle and the test negative-checks it: `swarm.join()` on an
already-joined topic returns a **new**, additive session, so re-joining with `server:false`
changes nothing — the fix is `session.refresh({server, client})`, which mutates the session and
its `_serverSessions` count. Stated honestly in the code: this stops us **announcing**, so no
new peer can discover us, but existing bidirectional connections are not force-closed (the
player cannot tell "a peer I serve" from "a peer serving me", and closing the wrong one stalls
playback) — so upload drops to zero for new peers immediately, overall shortly after.

**Bounded feed cache.** Zapping away kept a neighbour's drive, corestore sessions and swarm
topic open for the whole session — browsing 50 channels left 50 open, each occupying a slot in
that channel's `SWARM_MAX_PEERS` budget, so browsing could crowd out actual viewers. `_feeds`
is now LRU-bound to 12, never evicting the feed being served. Viewer-path socket tuning was
deliberately **not** added (net-tune reads `/proc`, which cannot work on Android, and a phone's
uplink caps throughput long before a 2 MiB buffer does) — recorded in a comment so nobody
repeats the measurement. Tests: `test:sdk` runtime-switch coverage + the LRU bound; worklet
bundle regenerated and verified free of net-tune.

### Correlated incident log for fleet-wide events (verified)

`watchdog.restarts` counted every respawn, but only as a per-channel cumulative total. On flaky
IPTV that counter climbs constantly (~2.5/channel/hour across 69 channels), so a single restart
carries no information — when all 69 channels respawned together at 05:51Z on 2026-07-21,
**nothing recorded it**: each incremented by one, exactly like ordinary churn. It was noticed
only because a 10-minute sampler happened to land in the trough.

The signal is **correlation**, not count, so respawns are deliberately not logged individually
(that would be the same noise with timestamps). `incidents.js` opens **one** fleet-restart
incident when enough **distinct** channels respawn inside a window and extends it while the
burst continues — distinct channels is the test, not event count, so one channel flapping
twenty times is a flaky source, not an outage. Source failover and return-to-primary are
recorded as discrete incidents (rare, and they change which source viewers are served).
Surfaced at `GET /api/incidents` and as a dashboard timeline that explains what a burst means
("upstream or host event, not one flaky source"); ephemeral by design, like the activity ring.

The threshold shipped flat ("5 distinct channels in 2 min") and was corrected within minutes:
the measured baseline is ~2.5 respawns/channel/hour, so a healthy 69-channel box already
produces ~5 distinct-channel restarts every 2 minutes — a flat floor of 5 would have cried wolf
constantly, which is worse than nothing because the one real event then looks like the noise.
It is now `max(minChannels, ceil(running × 0.25))` — ~17 of 69, comfortably above the churn
floor and below the 51-of-68 actually observed — with `minChannels` still the floor for small
deployments where 5 of 6 really is fleet-wide. Tests: args group L, both regimes,
negative-checked.

### Ingest restart rate: drop -re from live pulls, reconnect internally, per-channel demuxer tuning (verified)

Two passes at the 2085-respawns-in-12.1-h restart rate (~2.5/channel/hour), previously treated
as an unavoidable property of flaky IPTV. Part of it was self-inflicted.

**-re was pacing every live stream.** The old rule was ".m3u8 = live, anything else over http =
a VOD file needing realtime pacing" — false for raw mpegts over http, which is what most IPTV
serves (`http://host:81/CHANNEL/mpegts?token=…`, no extension); 69 of 69 running channels took
the `-re` branch. ffmpeg's own docs say `-re` "should not be used with live input streams": it
throttles the reader to 1×, so after any jitter ffmpeg cannot catch up, the server-side buffer
backs up, and many IPTV servers drop a slow client. `-re` is now opt-**in** by VOD file
extension, LIVE the default for an unknown http(s) URL — also the safer way to be wrong, since a
live source read without `-re` is correct while one read *with* it degrades continuously. And
http pulls now reconnect **internally** (`-reconnect_streamed` the load-bearing option) instead
of exiting: an exit-and-respawn restarts ffmpeg's `seg%d` counter from 0, stranding the
previous run's high-numbered segments (the orphan that pinned blob reclaim in the 2026-07-15
disk leak) and leaving a visible gap — an internal reconnect keeps the same process, sequence
and feed. Verified the options exist in the **container's ffmpeg 5.1.9** before shipping, since
an unknown input option makes ffmpeg exit immediately (this dev box runs 8.1.2, and `test:args`
is pure-args, so neither would have caught the skew).

**Per-channel demuxer tuning** for difficult push encoders — the cheap HDMI→RTMP/SRT boxes most
small operations use, not the IPTV pulls above. `probesize`/`analyzeduration` (a sparse or late
PMT makes ffmpeg give up before it has seen every elementary stream — "could not find codec
parameters", or audio silently missing; 10–50 MB / 10–20 s are normal against 5 MB / 5 s
defaults), `thread_queue_size` (a bursty listener overflows the default input queue and drops
packets), and `discardcorrupt` (keep going through the corrupt TS a marginal capture chain
produces). Every field is optional and null means ffmpeg's default, so an untouched channel
emits byte-identical arguments; they are **input** options asserted to land before `-i` (after
it, ffmpeg would apply them to the output). Editable per channel in the dashboard. Tests: args
group M (unit conversion, placement, bounds, partial-update inheritance).

### Offline slate — a dead source loops "SOURCE OFFLINE" instead of going blank (S30, verified in production)

When a channel's source died it sat in watchdog backoff and viewers saw **nothing**. Now the
channel loops a pre-rendered slate (SMPTE bars + "SOURCE OFFLINE / PLEASE STAND BY") so it
stays live with a clear message, and it returns to the real source on its own when the source
recovers.

**Why a file, not live-generated bars.** The slate is remuxed with `-c copy` (input kind
`file`, forced `copy`), so a slated channel costs ~0 CPU and `copy` channels — which have no
encoder configured at all — can slate too. Live `drawtext` would force a re-encode (~0.5–1
core per slated channel; across a 69-channel fleet that is the whole box) plus a runtime font
dependency. **Why a library, not one file.** Slate segments append to the *same* `index.m3u8`
as the channel's pre-failure segments, and a codec or resolution change mid-playlist with no
`EXT-X-DISCONTINUITY` is what breaks players — so the slate matches the dead channel's detected
output on codec first, resolution second. Four variants (720p/1080p × h264/hevc) cover 100% of
the fleet; the fleet's odd rasters (854×480, 852×720, 720×480, 1024×576) are all anamorphic
16:9, so the square-pixel 720p slate is aspect-correct for them (upscaled, never stretched).

**How it rides the watchdog.** `_pickSlate` runs once per respawn, right after `_pickSource`,
so a channel works through every configured fallback URL before it gives up. When slated,
`_spawnFfmpeg` overrides the input with the slate file and forces `copy`; `meta` is never
mutated, so `status()` and a `PATCH` still show what the operator configured (same contract as
the backup-URL swap). Three subtleties: a looped file never exits or stalls, so every
exit-driven watchdog path is dead while slated — the watchdog kills the slate every
`SLATE_RETRY_MS` (default 30 s) purely to re-probe, **which is the return mechanism**; `failures` is
not reset when leaving to probe, so a still-dead source re-slates on its single failed attempt
rather than blanking for another `SLATE_AFTER` window; and profile detection is skipped while
slated, or the channel would learn the *slate's* profile and pin itself to the fallback.

**`discont_start` is now on every spawn**, not just slate ones. A respawn restarts ffmpeg,
which resets its output clock, so with `append_list` the new segments carry a backward
timestamp jump — measured ~6034 s on a channel up 1.7 h, scaling with uptime. That is the
unmarked "visible gap" every respawn (~1.45/channel/hour here) always produced; the tag also
makes the slate's codec/resolution change legal mid-playlist.

**Verified end-to-end.** Timing/monotonicity checked on the **container's ffmpeg 5.1.9** (not
just the 8.1.2 that renders the files): `-stream_loop -1 -c copy` gives zero DTS regressions
and `+genpts` is not needed. The loop wrap is pixel-identical (consecutive-frame luma delta
0.0000). On the **S22 Ultra** (ExoPlayer → hardware MediaCodec) an 854×480 → 1280×720 slate
switch is absorbed cleanly (~2–4 s gap, no stall). In **production**: a test channel's source
was blackholed → it slated after 3 failed respawns with the profile-matched variant (`state`
went `backoff` → `up`) → the source was repaired with **no restart** → it dropped the slate and
reconnected by itself within one poll. A real channel (`espn-east`) slated and self-recovered
during the same window. Media is rendered into the image at build time by
`tools/render-slates.sh`, so it is produced by the exact ffmpeg that later loops it.
Pure functions (`pickSlate` / `pickSlateFile` / `parseVideoProfile`) covered by `test:args`.
Full detail: `docs/kb/offline-slate.md`.

### S32 — SDK productization: npm-ready packages, TypeScript defs, example, docs (verified)
- **All three consumer packages made registry-publishable at 0.1.0** — `@aliran/core`,
  `@aliran/player-sdk`, `@aliran/react-native`: `files` whitelists (tarballs carry
  exactly the runtime + README: 10 / 8 / 7 files, proven by `npm pack --dry-run`),
  `repository`/`homepage`/`bugs`/`keywords`/`engines`, and `publishConfig.access:
  public` (scoped packages default to private). The `@aliran` npm scope was verified
  unclaimed; actually publishing is a maintainer action (create the org, `npm publish`
  in dependency order: core → player-sdk → react-native).
- **The one real blocker was `@aliran/player-sdk`'s `"@aliran/core": "file:../core"`**
  — npm does not rewrite `file:` specs at publish, so the tarball would have been
  uninstallable. Moved to `^0.1.0`; inside the repo nothing changes: the root
  workspace links `core/` (satisfies the range), and `client/backend`'s own
  `file:../../core` dep dedupes the same way for the Android worklet graph — proven
  by regenerating all three lockfiles (root, `client/`, `client/backend/`) and a
  **full `test:sdk` e2e pass** on the new resolution. The `client/` lock regen needs
  `--legacy-peer-deps` (react-native-tvos prerelease alias), as documented.
- **TypeScript definitions** (`sdk/index.d.ts`, hand-maintained): the entire engine
  surface — options (`hybrid`/`tune`/`zapPrefetch`/`swarm`/`uploadPolicy`), a typed
  event map (all 11 events with exact payloads read from `player.js`, not the README),
  methods, and the login/recover helpers — kept deliberately in sync with the
  JSON-safe mirror types in `sdk/react-native/src/backend.ts`. Wired via `types` +
  an `exports` types condition.
- **`@aliran/react-native` peers tightened where honest** (`react >=18`,
  `react-native-video ^6`, `react-native-bare-kit >=0.13.3`) while `react-native`
  stays `*` **by design**: TV apps alias it to react-native-tvos prereleases, which
  fail any strict semver range (ERESOLVE).
- **New**: `@aliran/core` README (the registry page was blank), absolute links in
  published READMEs (relative repo links break on npmjs.com), a runnable
  `examples/headless-player.mjs` (the quickstart as a program; resolves the SDK
  through the workspace), and a **Player SDK docs-site page** (`docs/sdk.md`) —
  `mkdocs build --strict` green.

### Publishing the dashboards — the exposure pattern, folded back into the repo (verified)
- The S13 deploy pack shipped `deploy/Caddyfile.example` with no auth guidance. The
  pattern that survived contact with a real deployment (the broadcaster dashboard went
  public over TLS on 2026-07-21) now lives in the repo: `basic_auth` **scoped to the
  UI only** (`@ui not path /api/*`), a bcrypt placeholder (`caddy hash-password`,
  cost 14), the broadcaster (:3310) as the worked example with the panel (:3210)
  flagged as the bigger decision (its API creates users and grants channels — own
  credential, if exposed at all), and a commented `remote_ip` allowlist variant.
- Why the scope is load-bearing (this shipped broken on first delivery): HTTP has ONE
  `Authorization` header. The dashboard sends `Bearer <token>` to its own API, which
  replaces the browser's automatic `Basic …`, so an unscoped gate 401s every API call
  and the browser re-prompts on every click. Stated honestly everywhere: the UI gets
  two gates, the API keeps its one rate-limited Bearer gate — no header-based
  mechanism can add a second; an IP allowlist or mTLS can.
- Two lessons that generalise, now in the docs: **verify layered auth with the
  composed request** (each layer in isolation passes while the combination is broken —
  `POST /api/login` through the proxy, then Bearer `GET /api/channels`, must return
  200 with no `www-authenticate`), and **a P2P host is not "outbound only" behind a
  firewall** — a broadcaster holds ~2 UDP sockets per channel on random ephemeral
  ports, and a public IP is addressed directly by peers (no NAT conntrack to mask the
  gap), so a default-deny ufw silently degrades seeding unless the ephemeral UDP range
  is allowed; verified by inbound `/proc/net/snmp` datagram counters climbing with
  `RcvbufErrors` 0.
- Full walkthrough: `docs/kb/public-dashboards.md` (DNS before Caddy, host install,
  credential hygiene, the ACME race — a first `curl` returning 000 after
  `systemctl start caddy` is not a failure). `mkdocs build --strict` green; no `caddy`
  binary on the dev box, so the example is checked by eye and mirrors the production
  config verbatim.


### S33 — viewer-path swarm socket tuning (verified on the S22 over the live VPS)
The deliberately-deferred half of the socket-buffer work (the servers were tuned in
S29): the viewer engine's single Hyperswarm now sizes its UDP buffers too. An earlier
session had tried this and reverted it as "no value on a phone" — that assessment was
half right, and the half matters: a phone's **uplink** does cap first, but that only
disqualifies tuning the *send* side. A viewer is **download-dominant** — every watched
feed's traffic funnels into the receive side of one UDP socket pair while the worklet's
single JS thread is busy with crypto — so the receive buffer is exactly the kernel-side
shock absorber worth sizing. Defaults: **recv 2 MiB, send untouched**; overridable via
the SDK `swarm: { rcvbufMb, sndbufMb }` option (MiB, `0` disables — the server envs'
semantics).
- **The Bare constraint shaped the design.** `core/net-tune.js` imports `node:fs` for
  the `/proc` ceiling read, and an fs edge in the worklet bundle graph becomes a
  `builtin:` ref the 0.13.x runtime cannot load. Split: `core/net-tune-core.js` now
  holds ALL the logic with **zero imports** (a `test:nettune` group asserts that
  property on the file text) and takes `readFile` by injection; `net-tune.js` stays the
  Node entry binding fs, so every server callsite is untouched (suite passes unchanged).
  The engine passes its already-injected `fs` — on Android the `/proc` read is denied
  and the code degrades exactly as designed: the `setsockopt` still applies (needs no
  privileges), only clamp *detection* falls back to the readback comparison.
- **Proof on hardware** (release APK of this tree, Galaxy S22, live VPS): logcat shows
  `{"type":"status","state":"net:tuned","message":"swarm sockets tuned: recv 2 MiB,
  send untouched"}` ~5 s after cold launch — the healthy summary, i.e. the S22's kernel
  granted the 2 MiB receive request. Worklet boots clean (no `builtin:` refs at all in
  the new bundle — the previous shipped bundle carried a stray inert `builtin:fs`, gone
  now), auto-login lands, `espn-east` plays **P2P** (localhost HLS, `peers: 1` ticker),
  and zapping CDN→P2P→P2P→P2P held up with the engine healthy throughout. One lineup
  channel (`espn-1-arg`) sat in "Tuning" with an advancing progress bar while its
  upstream IPTV source limped — the engine kept serving (steady peers, `feed:ready`
  fired) and zapping away was instant, which is the flaky-source profile the scale test
  already documented, not a client regression.
- **Reporting**: the outcome emits as a `status`/`net:tuned` event with the same text
  the servers log (identical clamp warnings deduped — one socket pair, one host). The
  app's debug relay (`adb logcat -s ReactNativeJS`, `[backend]` lines) is the proven
  on-device sink; the worklet also mirrors a `[net]` console line for Bare hosts whose
  console reaches a log.
- **Versions**: `@aliran/core` 0.1.1 (new entry point — published 0.1.0 tarballs are
  immutable and lack the file), `@aliran/player-sdk` 0.1.1 (requires `core ^0.1.1`),
  `@aliran/react-native` 0.1.1 (SwarmConfig mirror). All three lockfiles regenerated;
  publish remains a maintainer action (core → player-sdk → react-native, one at a
  time). Suites: `test:nettune` (new group F), sdk unit (new S33 group), **full
  `test:sdk` e2e**, client `tsc` + jest 10/10.

### S8a — the VOD library: a separate service for on-demand titles (verified)

VOD landed as a **new top-level deployable, `library/`** — an explicit architecture
decision, not an accident of code placement: the broadcaster is a live pipeline
(watchdogs, rolling buffers, feed rotation, boot-resume pacing) and none of that
lifecycle applies to a static seed; ingest is a one-shot transcode burst (0.5–1
core) that a production live box running at ~72% CPU must never absorb; and the
failure domains stay separate. Operators run the library wherever the disk and
spare cores are — beside the stack via the compose `vod` profile, or on entirely
different hardware.

- **A title = a catalog record + one encrypted Hyperdrive.** Ingest: ffprobe the
  input (must have a FINITE duration — a live stream would fill the disk, and is
  refused at probe time), `-c copy` remux when the codecs are already
  HLS-compatible (h264/hevc + aac/mp3/ac3) else transcode h264/aac with keyframes
  forced onto segment boundaries, `#EXT-X-PLAYLIST-TYPE:VOD` + `#EXT-X-ENDLIST`,
  segments imported in order with the playlist LAST, ALL segments kept — disk =
  title size, reclaimed only by delete. Storage is the repeater's model (ONE
  Corestore + ONE Hyperswarm for every title — a seeder needs one socket pair, not
  one per title), per-generation namespaces (`title:<id>:g<n>`) so a re-ingest
  mints a fresh feedKey and purges the old cores, and per-title encryption keys
  minted once and reused across re-ingests so grants survive (the broadcaster's
  feed.key contract). PanelLink + register.js ride as self-contained copies (the
  control-auth convention: separate deployables each ship their own).
- **The panel gained a record CLASS, not a new pipeline**: `type:'vod'` carries
  `durationSec` (payload-owned, like feedKey) and **omits `isLive` entirely** —
  liveness is not a property a title has. The conditional sits exactly in isLive's
  slot in the record builder, so a live record's key order — and therefore its S29
  byte-compare against pre-S8a records — is unchanged (test:register stayed green
  untouched). Grants/sealing, panel-authoritative descriptive metadata, curation
  preservation and blobsKey enrichment (a future keyless title mirror needs it)
  apply to titles verbatim.
- **The SDK branch is mostly about what must NOT run.** Every live self-heal
  mechanism defines health as "the playlist ADVANCES" — and a finished VOD playlist
  never advances, so each would false-fire on a perfectly healthy title: the tune
  watchdog would walk retune → teardown → a false friendly error within 3×
  timeoutMs; the zap-prefetch gate would suspend on a fake 'stall' within 12 s;
  hybrid's stall probe would dump the viewer to CDN on play. resolve() now returns
  `{type, durationSec}` and for vod serves-and-stops; the guards live INSIDE
  `_startTuneWatchdog`/`_startZapPrefetch` too, because `reconnectActiveFeed()` and
  `setZapPrefetch(true)` re-arm mid-play. vod titles keep their curated slot (and
  prewarm still warms their connections) but are never segment-warmed as zap
  neighbors, and a catalog feedKey change is deliberately NOT hot-followed (a
  re-ingest mid-film would yank the playhead; it applies on the next resolve). The
  localhost serving layer needed exactly one change: the playlist read-ahead now
  prefetches the HEAD of an ENDLIST playlist (a viewer starts at the top) instead
  of the tail (the end credits).
- **`test:vod`** runs the whole chain on a LOCAL DHT testnet (deterministic → the
  REQUIRED CI lane, which now installs ffmpeg): generate a real file → control-API
  ingest (copy remux) → vod record class asserted field-by-field (including S29
  idempotence for the class) → blobsKey enrichment → grant → SDK login/resolve →
  **ffprobe validates the SERVED url** (12.0 s over P2P) → Range read on the LAST
  segment (seek-style random access, no sequential fetch led there) → a 10 s
  quiet-wait past 3× a shortened tune timeout proves the watchdog did NOT arm
  (events + internals) while a synthetic live channel beside it proves it still
  DOES arm and stand down, cleanly across vod↔live zaps → DELETE purges the cores
  from disk and the catalog flips `status:'unavailable'`. One harness gotcha worth
  remembering: **never `spawnSync` a probe against a server hosted by the same
  Node process** — spawnSync blocks the event loop, the server can't answer, and
  ffprobe "times out" against a perfectly healthy stack (async spawn + await).
- **Versions**: `@aliran/player-sdk` 0.1.2, `@aliran/react-native` 0.1.2 (Stream
  gains `type`/`durationSec`/`status`; ResolveResult gains `type`/`durationSec`;
  the RN `port` message declares `recordType`/`durationSec` for the stage-2 app
  work). Core untouched. Publish remains a maintainer action.
- **Suites**: new `test:vod` (required lane) PASS; full `test:sdk` PASS untouched;
  `test:register`/`test:broadcaster-api` PASS (zero broadcaster changes);
  `test:core`/`corrupt`/`args`/`retention`/`nettune`/`sources` PASS. Stage 2 (the
  app: Library rail, seek UI, S22 on-device) is a follow-up card.

### S8a stage 2 — VOD in the app: Library rail, transport UI, live machinery interplay (verified on the S22 over the live VPS)

The app half of the on-demand library. The worklet (`client/backend/backend.mjs`)
now forwards the engine's ResolveResult `type`/`durationSec` as
**`recordType`/`durationSec` on the `port` IPC reply** (named `recordType` because
`type` is the IPC envelope's own discriminant — the RN union already declared the
fields). `<AliranVideo>` keys on it: the live-edge **stall-resync ladder disarms**
while the served record is vod — a paused, seeking, or finished playhead sits
still by design, and a resync remount would yank the title back to 0:00 — and
re-arms the moment a live port reply lands (vod→live zap). The component also
gains a **`seek()` imperative handle** (`AliranVideoHandle`; the internal ref
always points at the CURRENT mount, surviving self-heal remounts) and the
`AliranBackend` singleton mirrors `recordType`/`durationSec` so a re-entered
screen starts disarmed without waiting for a fresh reply.

App-side, titles are deliberately **channel-shaped where it helps and not where
it lies**: the Library rail falls out of the category machinery for free
(`category:['Library']` on the record — zero rail code), rows/detail reuse
ChannelRow/ChannelInfoPanel with a **runtime badge instead of LIVE** (vod records
carry no `isLive`; availability is `status`, and `'unavailable'` grays out), the
EPG slot is omitted (a title has no schedule), and titles take **no channel
number and no place in the CH+/CH- ring** (`zapOrder`/`channelNumbers` are
live-only — adding movies must never renumber the lineup; zapping from a title
lands on channel 001 and re-arms live behavior). The NowPlayingBar grows a
phone-only **transport row**: play/pause, elapsed/runtime (`formatDuration`
h:mm:ss), and a tap-or-drag **seek bar built in pure JS** (PanResponder — no
native slider dependency to autolink); the bar stays up while paused (the play
control must not fade away), and end-of-title parks on ▶ which replays from the
top. TV renders the row display-only — nothing focusable enters the D-pad zap
path (the S7 lesson).

Verified end-to-end against **production infrastructure** (the live VPS panel +
its ~84-channel lineup), first on the emulator and then **on the S22 itself**:
the panel image was updated to the stage-1 code (the vod record class predates
deployment — a pre-update register would have landed in the old responder), a
**library instance on the dev desktop** (the separate-hardware operator model)
enrolled as publisher `library1` scoped `vod-*`, ingested a 3-minute h264/aac
clip with a burnt-in running clock, registered `vod-clock-demo` (`type:'vod'`,
`durationSec:180`, blobsKey enriched) and seeded it over the public DHT. On the
emulator (x86_64 release build): the Library rail + `3:00` badge rendered, the
title played P2P from the desktop seed, and the burnt-in clock made the
transport provable frame-exactly — elapsed `0:58` over frame `00:00:57.000`,
**seek forward** to `00:02:07.840`, **seek back** to `00:00:32.120`, **pause
held 36 s on the identical frame** with zero stall/resync/error lines (the old
ladder would have fired at 12 s), resume from position, and a zap out to a live
channel flipping the reply to `recordType:'live'` with the numbered tuning pill
and no transport row. On the **physical S22** (arm64 release APK, chunked-push
install over a USB link that flapped `authorizing→device→gone` all night — the
detached-`pm install` and one-command-per-window lore carried it): the title
played P2P from the desktop seed, transport elapsed `0:54` over frame
`00:00:54.480`, **seek 0:54→2:27 frame-exact**, a missed tap let the title PLAY
OUT — end-of-title parked on ▶ at `3:00/3:00` on the LAST frame with the bar
held sticky and **no resync restart after 30+ s of a still playhead** (the
strongest possible disarm proof), **replay-from-end** via the seek handle,
**pause held 31 s frozen** + resume, and the logcat chain
`chv-cl recordType:"live"` → `vod-clock-demo recordType:"vod"` → espn-east
playing live — the full live→vod→live interplay on real hardware. Client
suites: jest 11/11 (43 tests, incl. the new `AliranVideoVod` group pinning
disarm/re-arm/seek and the catalog/row/bar vod cases), `tsc` clean, bundle
regenerated and validated (main + 15 linked addons, zero `builtin:` refs). The
test title, its grants, and the session's temp admins were purged from the
production panel afterwards (stop the library BEFORE the purge — its register
heartbeat resurrects a purged record); publisher `library1` stays enrolled for
future library deployments.

### S35 — Windows desktop player: full TV-app parity on Electron (verified against the live VPS)

The roadmap's DRM-hardening and geo items were dropped (2026-07-22) and the effort
moved into a **Windows desktop player** — Electron shell, full parity with the
Android app's S18 experience. New top-level `desktop/` workspace (private, never
published), built in three pushed stages.

**Architecture.** The engine (`@aliran/player-sdk`) runs in the Electron **main
process** — the N-API prebuilds (sodium-native, udx-native, …) that the Node e2e
suites exercise load in Electron unchanged, so the desktop app consumes the
published SDK with zero engine forks. The renderer is a sandboxed React app
(`contextIsolation` on, no `nodeIntegration`) behind a three-call preload bridge
speaking the same line-JSON message protocol as the Android worklet shell — which
made the RN screens port mechanically. hls.js/MSE plays both the engine's
localhost P2P playlists and redirect-channel URLs on one `<video>`. Saved
credentials are `safeStorage` (DPAPI)-wrapped, and the desktop goes one step
further than the phone: the password **never returns to the renderer** — splash
auto-login is fulfilled inside main, and the `prefs` reply carries the username
only. The transient-login retry loop lives main-side, once.

**The `<AliranVideo>` contracts, reimplemented for hls.js** (`HlsVideo`):
engine-confirmed tune lifecycle (one localhost URL serves every channel — the pill
completes only on the `port` reply for *this* channel + an advancing playhead on
the current mount), `feed-changed` remounts behind the same URL, the
frozen-live-edge ladder (12 s still playhead → live-edge reload → second failure
tears the wedged transport via `reconnectActiveFeed()`), fatal-network retry
remounts, one `recoverMediaError()` before a media-error remount, and a **clean
per-channel codec error** instead of a retry loop when the host GPU can't decode a
stream. VOD (S8a) rides the same surface — recordType disarms the ladder and the
bar grows a seek/pause transport (implemented to the same contracts; a live-VPS
vod pass awaits an operator library deployment with granted titles).

**Parity surface.** Menu hub (icon bar over the featured wallpaper, sections
data-driven from the descriptor), category rail with the two-level drill,
numbered channel list with per-row EPG now-lines, detail panel with the live
now/next guide — the **plain-TS EPG data layer is imported from
`@aliran/react-native` source unchanged** (one cached fetch covers every row
sharing a feed URL), favorites (device-local), search, settings with the
"Smooth zapping" toggle (persisted + applied live), subtitle/audio TrackMenu
(flat hls.js indexes — the ExoPlayer group-index pitfall doesn't exist here),
tuning pill with honest self-heal labels, NowPlayingBar with clock + EPG-now,
resume-last-channel, and keyboard-first navigation mirroring the D-pad model
(rail/list panes, Esc unwind, `f`/`i`/`c` shortcuts).

**Packaging** (electron-builder 26): NSIS one-click installer + portable exe,
`asarUnpack` for the native modules, the operator `service.json` baked as a
resource (per-deployment builds, like the phone APK), a brand-palette icon.
electron-builder's workspace support collected the symlinked `@aliran/{core,
player-sdk}` into the asar correctly. Builds are **unsigned** — the SmartScreen
"unknown publisher" reality is documented rather than hidden. Per-brand desktop
packaging is noted as a follow-up.

**Verification — against the production VPS (~84 live P2P channels + ~238
redirects), on the PACKAGED portable/unpacked build,** with a throwaway user
(`s35test`, deleted after): sign-out → login → the 244-channel lineup; P2P
playback with the peers badge (espn-east, `P2P · 1 peer`); a zap chain
P2P→P2P→P2P→redirect wrapping the numbered ring (241→…→001) with the tuning
pill; the EPG guide rendering now/next with the elapsed bar (Pluto feeds); track
selection flipping an English subtitle track to `showing`; the Smooth-zapping
toggle persisting + echoing; and the **HEVC verdict: the HEVC 1080p channels
(`cos-pa`, `telemetro-pa`) play at full 1920×1080** on this box (platform
hardware decode; `MediaSource.isTypeSupported('hvc1')` true) — on hosts without
it the player surfaces the clean codec error. Screenshots:
`aliran-ops/s35-screenshots/01…12`. The engine logged the S33 socket tuning
(`recv 2 MiB`) on desktop too. `tsc` clean, `node --check` clean,
`mkdocs build --strict` green. Docs: `docs/desktop-player.md` + nav/README/
CHANGELOG. Gotchas kept for the next session: electron postinstall's zip
extraction silently produced only `locales/` on this box (manual
`Expand-Archive` + `path.txt` fixed it); electron-builder needs `electronVersion`
pinned when electron is hoisted to the workspace root; the packaged and dev apps
share `%APPDATA%\aliran-desktop` (userData follows package.json `name`), so the
single-instance lock spans them — close one before launching the other.

### S35 follow-up — the PUBLIC flavor: runtime panel-key entry (verified)

Same-day user decision: the baked-descriptor build is the *operator* ("aliran
ops") flavor; the public distribution must let anyone running their own
panel+broadcaster enter **their** panel public key + account in the app itself.
Implemented as the desktop version of the phone app's documented
runtime-descriptor path, one codebase: descriptor resolution is now baked
(resource/dev config, always wins) → runtime (`aliran-service.json` in userData,
persisted by the new **Connect screen**) → none (the Connect screen: panel key +
username + password — the exact three artifacts §2 of the SDK guide says an
operator hands out). `set-service` validates the key (64 hex), persists, boots
the engine, and the normal main-side retried login takes over; *Settings →
Change service…* (runtime flavor only) forgets the key + credentials and
relaunches clean. Packaging tolerates the missing `service.json` via the
directory+filter `extraResources` form — `npm run dist` with the file = operator
build, without = public build. Verified in dev and on the packaged build:
first-run Connect → key+creds → live playback; relaunch → auto-authorize
straight to live; Change service → clean Connect with both files gone; the
operator build untouched (boots to sign-in, never shows Connect). Screenshot 13
(public Connect screen) added to `aliran-ops/s35-screenshots/`; both flavors'
installers + portables staged in `aliran-ops/s35-build/`. One diagnosis from the
earlier session upgraded: the portable exe's "instant exit" was the
single-instance lock against the still-running dev app (shared userData), not a
packaging fault.

### S36 — public Android APK: runtime service descriptor, phone + TV (verified)

The Android analogue of the desktop player's public flavor: one keyless APK
(phone + Android TV — the manifest has declared both since S7) that connects to
any operator's service at runtime. `config/service.json` still decides the
flavor at build time; the new committed keyless `config/service.public.json`
(`panelPubKey: ""` as the deliberate marker — `REPLACE_` still throws) routes
first run to a **Connect screen**: panel public key (64 hex) + username +
password, the exact three artifacts an operator hands out, no URLs. Both persist
in the worklet prefs (beside credentials/favorites, surviving store purges)
**only after a successful sign-in** — a typo'd key or password never sticks, and
retry happens in place. Later launches auto-authorize through Splash; *Settings
→ Change service…* (keyless flavor only) forgets service + sign-in and returns
to Connect. A baked key always wins, ignores any persisted service, and is
never changeable at runtime.

**Engine/worklet:** prefs grew a validated `service` field
(`service-save`/`service-clear`), and the `{panelPubKey}` connect dispatch now
swaps the engine wholesale (`player.stop()` → fresh player) when a different
key arrives — a wrong-key retry or a service switch never reuses the old
panel's swarm/bee/feeds. The RN binding got optional `StartOptions.panelPubKey`
(boot idle, read prefs first), `connect()`, `saveService()`/`clearService()`
and a `service` mirror; the ConnectScreen waits for the fresh `{type:'ready'}`
before logging in so nothing races a teardown. Bundle regenerated and
validated: main + 15 addons, **zero `builtin:` refs**.

**Verification — the public x86_64 release APK against a LOCAL rights-clean
demo stack** (offline admin-cli init/user/grants/set-meta, control-API channels
on the built-in colour-bars `test` input, the committed `docs/demo/epg.json`
re-centered and fetched from its raw.githubusercontent URL). On the Pixel 8 Pro
AVD (phone) and an Android TV AVD, each from a fresh install: Connect (the
64-hex validation caught a genuinely truncated key mid-test), connect → ready →
login, Menu, category rails with live EPG now-lines, **P2P colour-bars playback**
(`P2P · 1-2 peers` in diagnostics; the second peer was a host-side headless-SDK
viewer), D-pad zap + channel list + program guide on TV (leanback IME entry,
focus traversal to every control), force-stop → relaunch auto-authorize, and
*Change service…* → clean Connect on both (with the cleared state surviving
another force-stop). Client jest 12 suites / 55 tests green, tsc clean,
`mkdocs build --strict` green. Docs: `docs/android-viewer-guide.md` (install/
"unknown sources", Connect, separate phone and TV/D-pad sections, honest
privacy/bandwidth incl. the S25 cellular no-reseed behavior, troubleshooting)
with rights-clean captures in `docs/img/android/`.

Two emulator-lab gotchas worth keeping: QEMU's user-mode NAT + router hairpin
makes the FIRST DHT holepunch to host-local peers slow (~1–3 min) — the
Connect screen's in-place retry absorbs it (the guide says "press Connect
again") — and bulk P2P segment flow through that relayed path only sustains
low bitrates, so the demo channels were patched to 300 kbps for the video
verification (real devices on a LAN or against a remote host don't hit
either; the S22 + VPS combination never has).

### Desktop player on macOS — configuration-only packaging, built on hosted CI

An Apple-platform feasibility audit of the installed dependency tree settled
three questions at once. **macOS: yes, with zero engine work** — every native
module the engine loads in the Electron main process (both sodium-native
majors, udx-native, fs-native-extensions, crc/quickbit/rabin/simdle) already
ships darwin arm64 + x64 N-API prebuilds, and the app code was already
platform-clean (`safeStorage` is Keychain on macOS, DPAPI on Windows; the
build script is plain esbuild). **Apple TV: no** — the Bare runtime and its
addon toolchain have no tvOS targets at all (no `tvos-*` prebuilds anywhere,
no tvOS slice in the bare-kit xcframework, and the linker rejects tvOS hosts),
so a tvOS app could only be a CDN-only shell and is not pursued. **iOS: the
engine is fully portable** (bare-kit ships an iOS xcframework and all twenty
runtime addons carry complete `ios-*` prebuilds) — but iPhone distribution is
App-Store-only with its own review and account costs, and the project decided
not to pursue it for now.

The macOS half shipped immediately because it is configuration only:
`electron-builder.yml` gained a mac block (dmg + zip targets, the video app
category, the `.icns` derived from the existing 512-px icon) with
`identity: null` — there is no Apple Developer certificate, so builds carry
only the ad-hoc signature arm64 requires and Gatekeeper blocks the first
launch (*right-click → Open*), the macOS analogue of the SmartScreen note.
A `dist:mac` script covers Macs locally, and a new manual-dispatch
**`desktop-mac` workflow** builds on a hosted macOS runner — the repo carries
no `config/service.json`, so CI artifacts are always the keyless **public**
flavor by construction. First dispatch ran green end to end: root `npm ci`
resolved the workspace SDK and every darwin prebuild with nothing compiling,
and the runner produced all four artifacts (`Aliran-0.1.0-arm64.dmg`,
`Aliran-0.1.0.dmg`, and the matching `-mac.zip` pair) with checksums in the
run log. Honest scope note: the artifacts are CI-built and the packaging path
is proven, but a first-launch pass on physical Apple hardware (Gatekeeper
flow, login, P2P playback) is still pending access to a Mac.

### Legacy Android builds — the SDK goes silent below the engine floor (verified on an Android 7 emulator)

Operators still run Android 6–9 set-top boxes, and the app hard-capped at
`minSdk 29` — the engine's `libbare-kit.so` needs ELF TLS, a libc feature
Android added in 10, so the floor is physical. The decided contract: the SDK
must work in every build and simply be **silent** where the engine can't
exist; the host app detects that and mounts its own legacy/CDN mode.

Two build-system discoveries shaped the implementation. First, bare-kit is a
C++ TurboModule **statically linked into `libappmodules.so`** — on an old
device the dlopen failure hits at React init, before any JS, so no JS gate
can save an APK that still links it. The legacy flavor (`ALIRAN_LEGACY=1`)
therefore **excludes** `react-native-bare-kit` from autolinking
(`client/react-native.config.js`) and drops `minSdk`; `settings.gradle`
dirties the autolinking cache when the mode flips, because that cache keys on
lock-file hashes and would otherwise silently reuse the other mode's module
set. Second, the obvious JS gate — "does `require('react-native-bare-kit')`
throw?" — is defeated by Metro's release-mode **inline requires**, which
defer the package's native-spec require (and its "TurboModule missing" throw)
from package load into the `Worklet` constructor; the first on-emulator run
crashed exactly there. `AliranBackend.isSupported()` now checks
`TurboModuleRegistry.get('BareKit')` directly (authoritative on-device) with
a construct-a-Worklet probe as the fallback for mocked test environments —
on an engine-less device the deferred throw lands inside the caught probe,
before `NativeBareKit.init`, so it has no native side effects. When the
verdict is "absent", `start()` flips the backend inactive: every method is a
safe no-op, nothing queues, no listener ever fires.

The plan's Android 6 hope died honestly: RN 0.76+ prebuilds are **built for
API 24**, and gradle rejects `minSdk 23` at configure time (prefab:
*"library was built for 24"*) — so the legacy floor is **Android 7**, and
Android 6 boxes cannot run any current-RN app at all. Verified: 54 client
jest tests green (incl. new engineless-contract tests), the legacy APK
carries zero `bare`/`sodium`/`udx` libraries and `sdkVersion 24`
(`libappmodules.so` readelf shows no bare-kit `DT_NEEDED`), it boots on an
Android 7 emulator to the branded "this device can't run the P2P engine"
notice with zero exceptions over a sustained window, and the rebuilt modern
flavor still boots the engine to `{"type":"ready"}` against the production
panel (the lazy Worklet construction is the only shared-path change). A
physical pass on the old Fire OS 7 stick is pending it being reachable over
adb.

### One APK for all of it — bare-kit behind a runtime dlopen (verified: same APK silent on Android 7, full engine on 16)

The two-flavor answer didn't survive contact with the requirement: operators
want **one APK** that installs on everything from Android 7 and simply runs
legacy mode below 10. The blocker was a single link edge — bare-kit is a C++
TurboModule statically linked into `libappmodules.so`, so `libbare-kit.so`
was a `DT_NEEDED` resolved at React init on every device. The fix is a
patch-package patch on `react-native-bare-kit`
(`client/patches/react-native-bare-kit+0.13.3.patch`): the module's 22
`bare_*` calls now go through a `dlopen("libbare-kit.so",
RTLD_NOW|RTLD_GLOBAL)`/`dlsym` table resolved at first worklet init and only
when `android_get_device_api_level() >= 29`; the package CMake drops the
imported link (killing the `DT_NEEDED`); the package `minSdk` falls to 24.
Packaging is untouched — the engine still ships via `jniLibs`; `RTLD_GLOBAL`
keeps bare symbols visible to the runtime's addon dlopens exactly as before.
Two belts back it up: `BareKitModule::init` throws a clean JSError where the
table is unavailable, and the SDK now refuses by `Platform.Version < 29`
before ever consulting — or constructing — the native module. The client
builds one `minSdk 24` APK by default; `ALIRAN_LEGACY=1` remains as an
optional engine-less lean flavor.

Verified with the SAME 300 MB universal APK: structure (sdkVersion 24,
`libbare-kit.so` aboard in all four ABIs, readelf shows no bare-kit `NEEDED`
in `libappmodules.so`), an Android 7 emulator (installs — previously
impossible with the engine aboard — runs silent to the branded notice, zero
linker errors), and an Android 16 emulator (engine boots through the dlopen
path to `{"type":"ready"}` against the production panel — the full dlsym
table exercised live: worklet alloc/init/start plus IPC both directions).
Tooling note for the KB: patch-package could not GENERATE the patch on
Windows (silent crash on the package's `.cxx`/`build` junk; `--include`
never matches, its internal paths are backslashed) — the patch was hand-rolled
from an `npm pack` pristine tree with `git diff --no-index`, and the apply
path verified by restoring pristine files and re-applying.

### aliran-kit — the native Kotlin SDK: one APK from Android 5.0, P2P self-activating on 10+ (verified on 5.1 + a modern emulator)

The question that started it: with pure Java/Kotlin, how far down does Android
go — and does the P2P floor move? Verified from the binaries: the floor does
NOT move (the 32-bit `libbare-kit.so` carries the same `__tls_get_addr@LIBC_Q`
import — Android 10, framework-independent), but the APP floor drops to
**Android 5.0**, because Holepunch ships BareKit as a **plain Java API**
(`to.holepunch.bare.kit.Worklet`/`IPC` — the RN package merely wraps it) and
nothing else in a Kotlin stack imposes React Native's API-24 prebuild floor.
Best discovery: `System.loadLibrary("bare-kit")` sits in the Worklet class's
STATIC INITIALIZER, and Java classes initialize on first active use — so in
Kotlin the Android-10 gate is simply "don't touch the class below API 29".
**No native patch at all**, where the RN edition needed the dlopen rewrite.

`sdk/android/` is a standalone Gradle project: `:aliran-kit` (library, minSdk
21) + `:demo` (the reference host). The library vendors the engine from the RN
package's checkout (bare-kit prebuilds + the linked addon set + `classes.jar`),
adds `libc++_shared.so` from the NDK (the one packaging item RN did implicitly
— its absence was the only crash of the bring-up), and converts
`client/backend/app.bundle.js` into a binary asset at build time — the SAME
engine bundle the RN app runs. `AliranBackend.kt` ports backend.ts (line-JSON
IPC over BareKit's poll-and-drain reads and direct-buffer writes; caches;
main-thread dispatch; the silent-inert contract below 29, JVM-tested).
`AliranPlayerView` ports the `<AliranVideo>` contracts onto Media3.

Verified with ONE demo APK (81 MB, sdkVersion 21, engine aboard ×4 ABIs):
an **Android 5.1 emulator** installs and runs it — EngineNotice + the
"watch demo stream" fallback playing plain HLS via ExoPlayer, zero linker
errors, an OS no Aliran build has ever touched — and a **modern emulator**
runs the FULL P2P path: worklet boot, OPRF login over the public DHT against
the production panel (after teaching the demo the S5b lesson: `ready` precedes
the panel link, so login retries on "not connected"), the real catalog, and a
live channel rendering through the ported player. Lore for the KB: the old
Android 5.1 default emulator image balloons its AVD to ~4.3 GB regardless of
`disk.dataPartition.size`, and the fallback-CDN TLS caveat stands (below
Android 7.1.1 there is no Let's Encrypt root — the Mux test stream's classic
chain worked on 5.1).

### `<EngineNotice>` — the unsupported-device screen becomes an SDK export (verified)

With single APKs installing on Android 7–9, every embedding app faces the
same moment: `isSupported()` is false and the viewer needs to be told
something — ideally with a way out. The SDK now exports **`EngineNotice`**, a
purely presentational, brandable screen (title/message/colors/children) whose
optional action button is the host's fallback seam: wire `onAction` to your
own alternative method (your CDN/HLS playback, a help flow) and the button
renders D-pad-focusable for TV; omit it and the screen is informational. The
component is deliberately content-agnostic — per the project's standing rule
the SDK ships the notice and the switch, never the delivery. The shipped app
dogfoods it (its `EngineUnavailable` now just brands `EngineNotice` from the
service theme), the SDK guide's single-APK recipe shows the pattern, and four
new jest tests pin the contract (default copy, branding, seam-only-with-
handler, default action label). Verified on the Android 7 emulator: the
single APK renders the SDK-exported notice identically to the previous
inline screen.

### Reseller panel — role hierarchy + credit ledger fronting the panel admin API

Operators reselling access needed a way to hand out account-management power
without handing out real admin power. The panel makes that awkward for two
deliberate reasons: every panel admin is all-powerful (there is no scoped
"reseller" role), and panel accounts have no expiry (nothing ends a lapsed
subscription). Rather than complicate the panel, this is a new standalone
`reseller/` service that supplies both on top — a pure HTTP service (no P2P, no
ffmpeg) that fronts the panel admin API and can run on the panel host or a
different box, authenticating as **one** dedicated panel admin.

**The hierarchy lives here.** Four roles — admin → co-admin → super reseller →
reseller — as a central capability map (`roles.js`), never scattered role-string
checks. The seeded root admin is the only one that can create or delete
co-admins and is itself undeletable; a co-admin is otherwise a full admin clone
(including minting) so a second all-powers login gets its own audit trail; supers
and resellers act only within their own subtree, walking parent pointers with a
cycle guard. The role is never trusted from the session token — the live
principal record is re-read on every request, so a suspension or role change
bites on the target's very next call.

**Credits are months, tracked as a ledger.** 1 credit = 1 month, flat (device cap
is a per-account setting, not priced). The ledger is an append-only JSONL file —
the durable audit trail, since the panel's own activity feed is in-memory — with
one global monotonic sequence (appends serialized by the service's single mutex,
so no per-user id races) and balances always derived from a boot scan, never
persisted, so they cannot drift; `/healthz` asserts the sum invariant, and a torn
final line from a crash mid-append is truncated on boot while corruption anywhere
else refuses to start. Only admins and co-admins mint (from nothing); even an
admin's *transfer* debits their own balance, so the ledger always shows where a
credit originated. Supers fund their resellers from their own balance; delete
refunds `floor(remaining months)` to the account's owner; admin account
operations are free and write no ledger line.

**The subscription clock is the account registry.** Because the panel has no
expiry, `accounts.json` is authoritative for it. Every account operation is
fail-closed — the panel is called first and the ledger + registry commit only on
its OK, so a rejected activation (out of credits, name taken, panel down) leaves
nothing behind — and runs inside the process mutex so a balance check and its
debit can't interleave. Accounts are namespaced
`<globalPrefix>.<resellerPrefix>.<name>`, which makes ownership unspoofable and
keeps a reseller's view to its own namespace. Two background loops keep the two
sides aligned: an **expiry sweep** that disables lapsed accounts on the panel
(its work list re-derived from expiry each tick, so an unreachable panel just
means a retry next tick, backing off to 15-minute checks meanwhile), and a
**reconcile sweep** that pages the panel's users under the prefix and reports —
or, with `RECONCILE_REPAIR=1`, repairs — divergences, always letting the local
clock win (an orphaned panel account is disabled, never deleted). The panel
client caches its Bearer token to disk so a crash-loop never burns the panel's
login throttle, and transparently re-logins once on a 401.

**Trials** are free time-boxed accounts (default 24 h, per-reseller daily cap
enforced by counting zero-value TRIAL ledger lines in the current UTC day);
renewing a trial converts it to paid with the same credentials — the upsell path.

The login path reuses the worker-thread single-flight Argon2id verifier from the
2026-07-16 flood lesson. The dashboard is the usual no-build four-view page
(overview / accounts / resellers / ledger / settings) on the shared theme, with
nav and controls filtered by role — the theme block's byte-identical guard now
covers three sheets and its test compares each to the first rather than pairwise.

**Verification.** Unit suite (`test:reseller-unit`) covers the capability map,
subtree walk with cycle guard, the ledger (seq monotonicity, torn-tail
truncation, mid-file-corruption refusal, derived-balance invariant, scoped
listing), the store mutex + atomic writes, and principal validation.
End-to-end (`test:reseller`, required lane) boots a **real** panel admin server
in-process (loopback HTTP, no DHT) and drives the whole story through it: auth
and lockout, the co-admin root-only guardrail, credits with role gates,
fail-closed activation asserted against the panel store itself (a 402 leaves no
panel user), renew/suspend/passthroughs, the trial cap and conversion, refund
rules, a suspension biting live tokens and bulk-disabling accounts, delete-block
rules, a panel outage returning 502 with nothing spent then recovering on the
same port, the tokenVersion-bump transparent re-login, and the expiry + reconcile
sweeps. The four-role dashboard was also driven live in a browser against an
in-process demo stack — a reseller login showing role-correct nav and a renew
round-tripping through to the admin's hierarchy view. Docker image builds from
the repo root behind the `reseller` compose profile and smokes via
`reseller-cli list-principals` in CI.

**Follow-up (same day): account-name prefixes removed.** The
`<global>.<prefix>.<name>` namespacing above was dropped by decision — resellers'
viewer accounts get **plain panel usernames** (a global first-come-first-served
space; a clash with an existing panel user surfaces as the panel's own error).
Nothing about safety depended on the name: ownership and scoping always came
from the registry's `owner` field, and that stays. The one job the prefix really
did — recognizing OUR orphaned panel user after a crash between the panel create
and the local commit — moved to an **intent journal**: the intent is written
before the panel call and cleared after the commit, and the reconcile sweep
chases stale intents (panel user exists + no registry entry = our orphan →
disabled and reported; no panel user = the create never landed, intent cleared).
Reconcile itself became registry-driven (per-account panel GETs instead of
prefix-paged listing), which also means operator-created panel users are now
completely invisible to the reseller service — the e2e asserts exactly that
(`operator-joe` with no intent survives a repair-mode reconcile untouched).
Principals lost their prefix field; the create form, docs, env (`GLOBAL_PREFIX`
gone) and reference followed. Both suites re-run green end to end.

**Follow-up (same day): the accounts list scaled for density.** The dashboard
fetched a single 500-row snapshot and filtered client-side — past 500 accounts,
rows were invisible and search silently lied. `list()` is now a server-side query
engine over the in-memory registry (a full filter → sort → slice pass costs a few
milliseconds even at ~100k accounts, so no index — just a real query surface):
case-insensitive search across account name AND owner, status filters
(active/disabled/expiring/trial — expiring shares the KPI's 7-day window),
name/expires/owner sorting with a name tiebreak, and offset paging returning
`{items, total, offset, limit}` so the UI can say "Showing X of Y" (the old name
cursor is gone; offset composes with every sort, and the tiny page drift a
concurrent write can cause between two Load-More clicks is fine for an ops
table). The dashboard is now fully server-driven: 100-row pages behind a
*Load more* button (the ledger table's idiom), a count chip, 250 ms-debounced
search, header sorting, and a click-any-owner drill-down chip for admins and
supers. Verified by a 5,000-account synthetic-registry unit section (envelope,
ci-search on both fields, every filter and sort, an offset walk covering the
whole set exactly once, junk-param rejections, scope) plus new e2e paging/
filter/owner-search assertions — and in the browser against a 394-account demo:
"Showing 100 of 334" → Load More → 300, a needle name deep past page one found
by server search, lapsed rows first under expires-sort, and the admin drilling
into one reseller's 60 accounts via the owner chip.

**Follow-up (same day): numbered pagination + more sorts + phone layout.** The
Load-more/auto-scroll list was replaced with real pagination on user request:
**50 per page** with prev/next and a jump-to-page `<select>` ("Page 4 of 8"),
plus a range count ("151–200 of 394"). Sorting gained **created** and **status**
keys (so: name, expiring soonest/latest, newest/oldest created, active-first/
inactive-first) — surfaced both as clickable headers and a toolbar sort dropdown
kept in sync with the header arrows. A subtle correctness fix landed here: page
loads are now **latest-wins** (each carries a sequence token; only the newest
response renders) instead of a busy-flag that silently *dropped* a rapid second
action — verified that hammering Next three times advances exactly three pages
with the combo and count agreeing. On phones (≤700 px) the table reflows into
**stacked cards**: headers hidden, each row a block, `data-l` cells self-label
("expires: 25d", "devices: 2"), and the redundant Owner-dupe and Created columns
drop out — no horizontal scroll at 375 px, the wide 7-column table returns at
desktop widths. Server default limit is now 50 (cap unchanged at 500). Unit +
e2e cover the new sorts and the 50 default; browser-verified both widths on the
394-account demo.

### Repeater field validation — production worked example (verified)
A production shakedown of the repeater appliance on a deliberately awkward box: a
16-core Ubuntu 18.04 VM (kernel 4.15) already running unrelated Apache/MySQL/
memcached. Docker CE installed fresh (bionic's glibc can't run modern Node bare, so
the container path is also the *only* path on hosts this old), repo cloned,
`repeater/.env` scoped to three production channels, stock compose deploy —
contained as designed: zero listening sockets, co-tenant services untouched. The
socket-buffer story was captured live in both states for the KB: startup on stock
ceilings logged the documented clamp warnings (0.2 MiB granted vs 4 MiB asked)
while mirroring worked anyway — the silent trap — then `deploy/sysctl/install.sh` +
restart produced the clean `swarm sockets tuned: recv 4 MiB, send 4 MiB` line, and
the kernel UDP-error counter never moved through the whole test. Serving proven
with a stock SDK viewer (real login, no repeater config of any kind): over a
3-minute session its per-connection byte counters split **46 % repeater / 54 %
origin** — hotswap treating the mirror as just another fast holder — with the
repeater's watched channel showing `peers 2` for exactly the session and the
unwatched channels staying at 1. Retention held: block counts flat under climbing
feed lengths, store plateaued at ~161 MB for 3 channels (the bitrate × retention
formula on the nose), load average 0.13 on 16 cores. The destructive scenarios
(origin-kill, slots-full lockout, rotation purge) stayed in `npm run
test:repeater`, which passed beforehand. Everything captured (anonymized) in the
new KB page `docs/kb/repeater-production-example.md`, linked from the repeater page
and the network-tuning KB. The box was fully reverted afterwards — this deployment
was a test rig, not a standing repeater.

### Observability & config hygiene (verified)
The last v1.0 ops checkbox: **config validation, structured logging, health/
metrics** across all five services, with zero wire-protocol changes. Config
first: every `config.js` now ends in a fail-fast validation pass — a typo'd env
var (bad integer, out-of-range port, malformed hex key/URL, `FEED_BUFFER=rma`)
throws at import with an error naming the exact variable, and every problem in
the file is reported in one shot. The NaN class this kills was real: `parseInt`
garbage previously flowed into timeouts and ports and surfaced as unrelated
failures. Deliberately preserved permissiveness: socket-buffer MBs still degrade
to "off" (tuning must never stop boot) and branding stays graceful. Logging:
`LOG_FORMAT=json` patches console once at startup and emits one
`{ts,level,svc,msg}` object per line (errors keep stderr); default output is
byte-identical, proven by the test. Endpoints: the panel admin API — previously
the only surface without one — gained unauthenticated `/healthz` (served before
the auth gate, same "answers while a login flood chews the API" contract as the
broadcaster's), and every control/admin server gained Prometheus-text
`GET /metrics` built strictly from the same cheap synchronous sources as its
healthz (channel + boot-resume + incident gauges on the broadcaster; title
states + panel-link on the library; principals/accounts/panel-reachability/
ledger-invariant on the reseller). The repeater keeps its no-listening-sockets
property: `STATUS_PORT` (default 0/off) opt-ins a loopback status server with
the same two endpoints, including per-core `held_blocks`/`peers` series labeled
by streamId. Verified by the new `test:config` (subprocess probes: 10 bad-env
rejections naming their variable, 5 clean-env boots, JSON-line shape + default-
untouched proof) added to the REQUIRED CI lane, plus new assertions in the
reseller e2e (reseller + in-process REAL panel healthz/metrics), the vod e2e
(library metrics), the repeater e2e (status server against a live mirror), and
the broadcaster-api e2e (metrics before login).

### Backup, restore & key rotation runbooks + bounded logs (verified)
The second of the two remaining v1.0 ops items. The runbook page
(`docs/kb/backup-and-rotation.md`) is organized around one model: every byte is
identity (panel `keys/` — signing + OPRF + shared publisher; not rotatable, only
protectable), data (panel store, reseller ledger.jsonl, library titles, admin
secrets), or cache (broadcaster feed stores, the whole repeater — never backed
up; a restored broadcaster re-mints feeds and viewers follow the catalog). Cold
backups only (a corestore copied mid-write can tear): `deploy/backup.sh` does
stop→tar→start per compose volume with the panel's stop window costing only new
logins. The restore section documents the sharp edge honestly — the store is an
append-only signed log, so restoring a stale snapshot forks any client that
replicated past it (recovery: clear client storage; mitigation: hourly cron +
restore-the-newest); failover is a warm standby holding the latest snapshot
under the NEVER-two-writers rule (two panels signing under one key = permanent
fork, strictly worse than downtime — the drill instructions even point the
scratch panel at a black-hole bootstrap). The rotation matrix covers every
credential with its exact endpoint/CLI and blast radius, all wire-compatible.
Verified: new `test:backup` (required CI lane) proves a cold DATA_DIR copy
reopens as the same deployment — same signing identity, same admin verifiers,
same accounts/grants/catalog over a real admin server, healthz answering.
Alongside: every compose file now bounds container logs (json-file 20 MB × 5 per
service) — Docker's default driver is unbounded and the eternal-log disk-fill is
exactly the failure an untended co-tenant box hits first; the operator guide's
Monitoring section documents the journald/daemon.json equivalents. Stale
threshold-OPRF promises removed from architecture.md and the operator guide
(rescoped out of the roadmap earlier the same day).
