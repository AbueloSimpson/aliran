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
- ✅ Assets Hyperdrive (posters/art): panel seeds it, key advertised in the signed DB
  (`meta/assetsKey`), `admin-cli upload-art`, client serves `/assets/*` over localhost.
  Verified (`npm run test:assets`).
- ✅ Catalog `bee.watch()` live push to the UI: the player SDK watches the replicated
  `catalog/` range and re-emits `streams` with fresh display metadata on every edit
  (no polling, no re-login; verified in `npm run test:sdk`)
- ✅ OTT GUI (redesigned to the reference IA): splash auto-auth ("remember me" saved
  device-local; login is the exception path), menu hub over the featured stream's
  wallpaper, **Live TV as one fullscreen surface with browse/detail overlay panels**
  (category rail, numbered channel list, channel-detail panel with an honest no-EPG
  placeholder; playback never stops while browsing; D-pad zap), favorites
  (device-local), search, settings — all on-device; **white-label**: every color and
  brand string flows from the service descriptor via `makeTheme()`
- ✅ Android **TV** target (leanback + D-pad focus) from the same APK: focus rings +
  rail focus memory (`TVFocusGuideView`), verified remote-only on an Android TV
  emulator (login → browse → live P2P playback → back)

**Exit criteria:** username/password login validated against the P2P DB; browse a
branded catalog on phone and TV; unauthorized users can't decrypt.
**Status:** **done end-to-end** — security core verified on desktop; the app
auto-authorizes, browses live TV under overlay panels, and plays live P2P on phone
**and** TV emulators; catalog edits push live.

---

## v1.0 — Production: "Operators can run a real service"

- ✅ **Player SDK track**: `@aliran/player-sdk` headless engine extracted from the app
  worklet (e2e-tested via `test:sdk`; the worklet is a thin shell over it), hybrid
  CDN↔P2P failover/auto-return, and the `@aliran/react-native` `<AliranVideo>`
  binding — dogfooded by the app on the TV emulator (P2P + observable CDN fallback)
- ✅ **Deploy pack**: working Docker images + Compose (host networking for the DHT),
  systemd units, Caddy TLS recipe for the dashboards, firewall guidance — and a CI
  job that builds the images on every push
- ✅ **Verified on a real VPS over the internet**: `tools/acceptance-remote.mjs`
  (headless SDK login → resolve → ffprobe from another machine) passed for two
  concurrent streams against a fresh 1 vCPU/1 GB VPS, and the Android app logged
  in and played live P2P against the VPS panel — no localhost anywhere
- ✅ **Complete admin surface (ops + API + CLI)**: admins CRUD + password rotation
  (panel **and** broadcaster control API), stream delete = full purge / user delete,
  user prefix-search + cursor pagination, `GET /api/observability` (uptime, memory,
  swarm peers, storage, last-200 activity ring), typed catalog curation
  (`order`/`featured`, preserved across broadcaster re-register), cooperative
  per-device revoke + SDK `sessionLive` online check — verified by the extended
  `test:admin-api` / `test:broadcaster-api`
- ✅ **Admin dashboard UI for the above**: Admins tab (incl. self-rotation with
  sign-out), typed-confirmation stream purge + user delete flows, user search +
  cursor “Load more”, Overview tab (health chips + 10 s-polled activity feed),
  inline curation controls (order/featured + ★ badge), per-device revoke ✕ —
  verified by a live browser session ending in a real P2P viewer login
- ✅ **Broadcaster ingest expansion**: push ingest — RTMP (OBS), SRT with passphrase
  (authenticated), MPEG-TS over UDP — plus correct HLS/RTSP pull; typed per-channel
  input config with auto port allocation and an ffmpeg capability probe (verified:
  RTMP + UDP-TS push round-trips to a P2P viewer in `test:broadcaster-api`)
- ✅ **Per-channel transcode controls incl. GPU**: resolution/fps/bitrate/preset,
  encoder selection (x264, NVENC, QSV, VAAPI, AMF, passthrough `copy`) with
  deep verification at startup so only encoders that really work are accepted
  (QSV proven on real hardware; control-UI selectors land with the ingest UI)
- ✅ **Rolling feed buffer**: live segments are a rolling window (8 × ~2 s by default),
  expired blob storage reclaimed — streaming for days occupies O(window) space.
  **`disk` buffer is the default** (stable feed identity → warm DHT topic → fast
  time-to-play); `ram` session feeds stay available (byte-flat disk) with the SDK
  following restarts via the catalog without re-login. Verified by `test:retention` +
  `test:broadcaster-api` (RAM session-core contract **and** disk stable-identity F3).
  Tuning rationale in `docs/kb/feed-buffer.md`.
- ⬜ **Broadcaster reliability**: ffmpeg watchdog (auto-restart with backoff,
  re-listen after publisher disconnect), per-channel log capture in the control UI,
  `isLive:false` pushed to the catalog on stop/crash
- ⬜ **Hybrid artwork**: P2P assets drive stays the default; `https://` art URLs pass
  through for CDN/web hosting
- ✅ **Android app GUI redesign** to the reference organization (phone + TV, one
  codebase): splash/auto-auth → menu hub → live-TV overlay browsing, plus the
  previously missing channel-detail and search screens; the GUI is white-label-able
  (descriptor-driven theme + sections — per-brand APK packaging is its own upcoming
  segment)
- ⬜ Panel **HA / threshold OPRF** across replicas; documented backup & key-rotation runbooks
- ⬜ Hardening pass + **independent security review** of the crypto paths
- ⬜ Config validation, structured logging, health/metrics endpoints
- ✅ Complete documentation site published (GitHub Pages — https://abuelosimpson.github.io/aliran/)
- ✅ Automated tests (unit + e2e harnesses) and CI (GitHub Actions: a required fast
  deterministic lane + a best-effort real-DHT e2e lane that never blocks merges)

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
