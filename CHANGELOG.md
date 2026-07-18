# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is the **concise summary**. The full chronological build history — every
milestone with its verification narrative — lives in
[docs/devlog.md](docs/devlog.md).

## [Unreleased]

The cumulative pre-1.0 state (no version has been cut yet). Every item below is
implemented, covered by an e2e or unit suite, and — where it touches the runtime —
verified on real infrastructure (a 1 GB VPS over the public DHT, and a physical
Android phone + Android TV).

### Added

**Core crypto (`core/`, `@aliran/core`)**
- OPRF login (ristretto255) with Argon2id verifiers and proof-of-work + throttling —
  the panel never sees passwords; X25519 sealed per-user stream grants; per-user
  Ed25519 auth keys; panel-signed session tokens with device limits, eviction, and
  `tokenVersion` revocation.

**Panel (`panel/`)**
- Single-writer, panel-signed Hyperbee control plane (accounts + catalog) replicated
  to every client over the DHT, plus a panel-seeded assets Hyperdrive; catalog edits
  reach connected clients **live** (`bee.watch` push, no polling, no re-login).
- RPC over Hyperswarm: `hello` (PoW), `login` (blinded OPRF), `session` (device
  enrollment + token), `register` (broadcaster publisher-key auth).
- Admin surface with one shared ops layer behind CLI **and** HTTP API **and** a
  no-build web dashboard: users (create/password/disable/delete, prefix search +
  cursor paging, devices + cooperative per-device revoke), streams (add/meta/art,
  curation `order`/`featured`, full-purge delete), grants, admin accounts, and
  `GET /api/observability` (uptime/memory/swarm/storage + activity ring).
- **Hybrid art**: `poster`/`backdrop`/`logo` accept a P2P assets-drive path or an
  operator-hosted `https://` URL (validated; passed through to clients untouched).
- **Redirect channels**: a catalog record can be `{redirect: true, url}` — viewers
  play the operator's https HLS URL **directly**, no P2P feed behind it; `url`
  drives the class atomically (live-by-default, explicit fields win, feedKey
  mutually exclusive), and broadcaster re-registers never erase it.
- **`blobsKey` enrichment**: the panel opens each registered feed and publishes its
  blobs-core key so keyless repeaters/seed nodes can mirror ciphertext.

**Broadcaster (`broadcaster/`)**
- Multi-channel `ChannelManager`: each channel is ingest → ffmpeg → **encrypted
  Hyperdrive** → its own Hyperswarm, with a persisted registry and runtime
  start/stop; auto-registers with the panel (publisher key).
- Typed ingest: `test` / `file` / pull (RTSP/RTMP/SRT/UDP/HLS URLs, correct `-re`
  pacing) / **push listeners** — RTMP (stream key), SRT (passphrase = real auth),
  UDP-TS — with validated, auto-allocated ports and operator-facing push URLs.
- Per-channel transcode: `copy` passthrough or x264 / NVENC / QSV / VAAPI / AMF with
  segment-aligned keyframes; an ffmpeg **capability probe** deep-verifies hardware
  encoders (by encoding test frames) and gates `start()` with honest errors.
- **Ephemeral rolling feed buffer**: the live window is O(window) storage, not an
  archive (playlist-driven blob reclaim); `disk` default (stable feed identity, warm
  DHT topic) or `ram` (byte-flat disk; fresh session feedKey per start — grants
  survive, the catalog follows).
- Reliability: ffmpeg watchdog with exponential backoff + stalled-live-edge restart;
  **feed rotation on source change**; **auto-resume on boot** (`desiredRunning`);
  `isLive:false` on stop via one manager-owned, self-healing **PanelLink** (serialized
  registers, boot catch-up, heartbeat, forced DHT re-lookup after a panel restart);
  per-channel ffmpeg log ring.
- Control HTTP API + no-build web UI: add/edit/start/stop channels, ingest +
  transcode forms driven by the capability probe, push-URL copy, logs dialog, honest
  state badges (`ON AIR` / `WAITING FOR PUBLISHER` / `RETRYING`); admin accounts with
  the same hardening as the panel.
- `SWARM_MAX_PEERS`: per-channel swarm connection budget for scale-out.

**Player SDK (`sdk/`, `@aliran/player-sdk`)**
- Runtime-agnostic engine (same graph runs headless in Node and inside the app's
  Bare worklet): `connect` / `login` / `resolve` / events. Login unseals per-user
  stream keys; `resolve()` serves the encrypted feed on a localhost progressive HLS
  server and returns the play URL.
- Progressive serving core: availability wait (holds a request until the entry
  replicates), block-progressive bodies with Range, live-edge read-ahead, and a
  stalled-read abort so a read committed to a reclaimed blob re-resolves instead of
  hanging.
- Zap machinery: feed cache (re-zaps are warm), `prewarm` (open entitled feeds at
  login), optional `zapPrefetch` with an **adaptive gate** (suspends on metered
  networks, active-stream stalls, or a thin pipe) and **directional** warming;
  `uploadPolicy: 'client-only'` for viewers that must not re-seed.
- Self-heal ladder for tunes: forced DHT re-lookups on backoff → retune (evict +
  fresh open) → **wedged-connection teardown** → a friendly, surfaced error — with
  "tuned/healthy" verdicts requiring the playlist to be advancing **and servable**
  (metadata alone never stands the watchdog down).
- Live follow-ups without re-login: the active stream tracks catalog **feedKey
  rotation** (`feed-changed`) and redirect-channel **url edits** (next tune).
- Hybrid CDN↔P2P failover/auto-return (config-driven, for dev/test harnesses) and
  **redirect-channel passthrough** (`resolve()` returns the catalog URL directly).
- Bounded hyperbee caches across every store (long-uptime heap safety).

**React Native binding (`sdk/react-native/`, `@aliran/react-native`)**
- `AliranBackend` (worklet host, IPC protocol, prefs) + `<AliranVideo>`: tune
  lifecycle (`onTune` with tune ids + `streamId` echo — one localhost URL serves
  every channel), deterministic remounts on channel flips, live-edge stall resync
  ladder, ExoPlayer start-buffer tuning.

**Android app (`client/`)**
- react-native-tvos app (phone + TV, one codebase) running the SDK in a Bare worklet
  with the full Holepunch native stack; splash **auto-auth** with device-local
  "remember me", Menu hub, **fullscreen live TV** with overlay browsing (category
  rail, numbered channel list, detail panel), favorites + search + settings, tuning
  pill with honest self-heal labels, NowPlayingBar, resume-last-channel, D-pad zap
  with OSD, "Smooth zapping" toggle (persisted, applied live), store-corruption
  recovery, strict loopback-only cleartext.
- **White-label**: service-descriptor branding + `makeTheme` — zero hardcoded brand
  strings or colors in screens.

**Repeater (`repeater/`)**
- Keyless regional super-peer (Open-Connect model): mirrors chosen channels' live
  windows **as ciphertext** at the block level (catalog `feedKey` + panel-published
  `blobsKey`), O(window) retention with sweep, follows feed rotations unattended,
  absorbs viewer fan-out off the origin. It holds no grants and cannot watch what it
  serves. Ships with its own deploy pack and testnet-proven e2e.

**Deploy + CI + tooling**
- Deploy pack: root-context Dockerfiles, host-network Docker Compose, systemd units,
  Caddy TLS recipe; CI runs the deterministic suites, best-effort DHT e2e, and
  docker-build smoke on every push.
- e2e suites for every subsystem (`test:core`, `test:sdk`, `test:admin-api`,
  `test:broadcaster-api`, `test:register`, `test:repeater`, `test:serve`,
  `test:retention`, login-flood suites, …) plus `tools/acceptance-remote.mjs` — a
  remote viewer proof over the public DHT with per-channel deadlines and a direct
  https probe for redirect channels.

### Fixed (each proven by a regression test; details in [docs/devlog.md](docs/devlog.md))
- SDK: re-zap deadlock (feed cache), teardown race, media-server abort crash,
  stalled media reads on reclaimed blobs, tune watchdog standing down on stale or
  metadata-only playlists, wedged-connection reuse, hybrid probes trusting
  unservable feeds, tuning-pill lifecycle bleed, erroring-channel retry no-op,
  unbounded per-bee caches.
- Panel/broadcaster: **Argon2id admin verification moved off the event loop**
  (worker thread + single-flight 503 + verify timeout) on both admin APIs — a login
  flood can no longer freeze media or viewer logins; PanelLink re-finds a restarted
  panel (ephemeral swarm identity) instead of stranding registrations; broadcaster
  re-registers preserve admin-owned fields (curation, art, redirect class).
- Ops: live feeds no longer grow unbounded (~1–2 GB/h/channel → O(window));
  orphan-pin disk reclaim; remote acceptance always ends with a verdict.

### To do (see [ROADMAP.md](ROADMAP.md) and per-package READMEs)
- White-label brand packaging (per-brand APKs via gradle flavors + `tools/brand.mjs`).
- Optional (v1.x): multi-DRM, geo-locking, VOD; panel HA replica set.
