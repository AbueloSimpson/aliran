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

### To do (see ROADMAP.md and per-package READMEs)
- Sessions (long-TTL tokens, device sealing/Keystore), device-limit enforcement.
- Catalog `bee.watch()` live push; OTT UI; assets Hyperdrive.
- Client app: native Android build (phone + TV).
- Optional (v1.x): multi-DRM, geo-locking, VOD.
