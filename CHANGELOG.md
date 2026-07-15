# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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

### To do (see ROADMAP.md and per-package READMEs)
- Broadcaster reliability (watchdog, auto-resume, log ring, isLive:false on stop)
  and ingest/transcode/logs surfaced in the control API + UI.
- Hybrid artwork (https URLs alongside the P2P assets drive).
- White-label brand packaging (per-brand APKs via gradle flavors + `tools/brand.mjs`).
- Optional (v1.x): multi-DRM, geo-locking, VOD.
