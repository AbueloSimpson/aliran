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

### To do (see ROADMAP.md and per-package READMEs)
- Catalog `bee.watch()` live push to the UI.
- OTT UI + client app: native Android build (phone + TV), Keystore session sealing.
- Optional (v1.x): multi-DRM, geo-locking, VOD.
