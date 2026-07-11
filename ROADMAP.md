# Aliran Roadmap

Aliran is a self-hostable, peer-to-peer OTT streaming platform on the Holepunch/Pear
stack. This roadmap describes the path from scaffold to a production-ready 1.0 and
beyond. It is a living document — dates are directional, not commitments.

Legend: ✅ done · 🚧 in progress · ⬜ planned

---

## v0.1 — Alpha: "It streams" (foundations)

Goal: a single operator can run a panel + broadcaster and watch a **live, unencrypted**
stream on an Android phone. Proves the P2P transport end to end.

- ✅ Repository scaffold (panel / broadcaster / client), docs, license, CI-less baseline
- ✅ Config loaders, panel key generation (`admin-cli init`)
- ✅ Broadcaster: ffmpeg → live HLS → **encrypted** Hyperdrive → Hyperswarm seeding
- ✅ Localhost Range media server over a Hyperdrive replica (`tools/lib/serve-drive.js`);
  ported into the client Bare worklet (`client/backend/backend.mjs`)
- ✅ Desktop P2P viewer + **automated end-to-end test** (`tools/e2e-stream-test.mjs`):
  fresh peer discovers the feed over the DHT, replicates, serves locally, ffprobe
  confirms valid H.264/AAC — **the transport is proven**
- 🚧 Client app: minimal player screen via `react-native-video` (code in place; needs a
  native Android build to run — see docs/client-build.md)
- ⬜ First successful **phone** playback over the DHT (blocked only on the Android toolchain)

**Exit criteria:** watch a live P2P stream; a second peer re-seeds to a third.
**Status:** ✅ verified on desktop (`node tools/e2e-stream-test.mjs` → PASS). The Android
app reuses the same, already-tested backend logic; only the native build remains.

---

## v0.2 — Beta: "It's secure and browsable"

Goal: accounts, encryption, and an OTT UI.

- ✅ Panel: single-writer **signed** account/catalog Hyperbee (`panel/src/store.js`)
- ✅ **Encrypted** feeds (per-stream `encryptionKey`) + per-user key sealing
  (grant-after-enrollment via X25519 seal; private key sealed under the password)
- ✅ **OPRF login** + Argon2id verifiers + proof-of-work + per-(user,peer) throttling
  (`@aliran/core`, `panel/src/rpc.js`, `client/backend/login.mjs`)
- ✅ Verified end-to-end on desktop (`npm run test:login`): login → entitlement →
  P2P playback, wrong password rejected, recovered key matches
- ✅ Sessions + device limits + `tokenVersion` revocation: per-user Ed25519 auth key
  proves login; panel issues a signed session token; `maxDevices` enforced (evict
  oldest); revocation via `tokenVersion`. Verified (`npm run test:session`).
  Device-sealing into Android Keystore comes with the app build.
- ✅ Broadcaster ↔ panel auto-registration: publisher key at `init`; broadcaster signs
  a `register` RPC; panel writes the public catalog record and stores the encryption key
  privately. Verified (`npm run test:register`).
- ⬜ Catalog `bee.watch()` live push to the UI
- ⬜ OTT GUI: home rails, hero, LIVE badges, channel detail, search
- ⬜ Assets Hyperdrive (posters/art) served over localhost
- ⬜ Android **TV** target (leanback + D-pad focus) from the same APK

**Exit criteria:** username/password login validated against the P2P DB; browse a
branded catalog on phone and TV; unauthorized users can't decrypt.
**Status:** the **security core is done and verified on desktop**; remaining v0.2 work
is sessions/devices, the live catalog push, and the OTT UI (needs the Android build).

---

## v1.0 — Production: "Operators can run a real service"

- ⬜ Panel **HA / threshold OPRF** across replicas; documented backup & key-rotation runbooks
- ⬜ Hardening pass + **independent security review** of the crypto paths
- ⬜ Robust reconnect/resilience (broadcaster restart, peer churn, background service)
- ⬜ Config validation, structured logging, health/metrics endpoints
- ⬜ One-command deploy (Docker Compose) + operator quickstart verified on a fresh VPS
- ⬜ Complete documentation site published (GitHub Pages)
- ⬜ Automated tests (unit + an end-to-end harness) and CI

**Exit criteria:** a new operator can go from clone → live service in under an hour,
following only the docs.

---

## v1.x — Optional modules (opt-in, provider-pluggable)

- ⬜ **VOD**: finished-file Hyperdrives, seek/resume, Continue Watching, live→VOD recording
- ⬜ **Commercial DRM**: CENC/CMAF packaging + BuyDRM/KeyOS, EZDRM, Axinom… via CPIX;
  panel-issued entitlement JWTs; Widevine on Android/TV
- ⬜ **Geo-locking**: MaxMind GeoIP at entitlement time + vendor license geo policy
- ⬜ Runtime **service-descriptor QR** so one generic APK connects to any operator
- ⬜ Concurrency limits, HDCP/output protection, rental windows, blackout dates

---

## Future / exploratory

- ⬜ iOS / Apple TV client (FairPlay + HLS)
- ⬜ Web client (Bare/WebRTC bridge)
- ⬜ Chat / interactivity alongside live streams
- ⬜ Multi-broadcaster / multi-admin (Autobase) catalogs
- ⬜ Adaptive bitrate ladders; low-latency HLS/LL-DASH
- ⬜ Analytics that respect privacy (aggregate, no per-user tracking)

---

## How to contribute

Pick an unchecked item, open an issue to claim it, and see
[`CONTRIBUTING.md`](CONTRIBUTING.md). Security-sensitive items (OPRF, key-wrapping,
tokens) should be discussed in an issue first and prefer vetted libraries.
