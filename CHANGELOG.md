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

### To do (see ROADMAP.md and per-package READMEs)
- Catalog `bee.watch()` live push to the UI.
- OTT UI + client app: native Android build (phone + TV), Keystore session sealing.
- Optional (v1.x): multi-DRM, geo-locking, VOD.
