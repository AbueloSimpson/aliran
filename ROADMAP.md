# Aliran Roadmap

Aliran is a self-hostable, peer-to-peer OTT streaming platform on the Holepunch/Pear
stack. This roadmap describes the path from scaffold to a production-ready 1.0 and
beyond. It is a living document — dates are directional, not commitments.

Shipped work is kept to one line per feature here; the detailed history (what, why,
and how it was verified) lives in [`CHANGELOG.md`](CHANGELOG.md) and the
[development log](docs/devlog.md).

Legend: ✅ done · 🚧 in progress · ⬜ planned

---

## v0.1 — Alpha: "It streams" ✅

Goal: prove the P2P transport end to end.

- ✅ Repository scaffold (panel / broadcaster / client / core / tools), config loaders, key generation
- ✅ Broadcaster: ffmpeg → live HLS → encrypted Hyperdrive → Hyperswarm seeding
- ✅ Localhost Range media server over a Hyperdrive replica (desktop viewer + the client worklet)
- ✅ Automated e2e transport proof: a fresh peer discovers the feed over the DHT, replicates, and plays

**Exit criteria met:** a live P2P stream plays; peers re-seed each other.

---

## v0.2 — Beta: "It's secure and browsable" ✅

Goal: accounts, encryption, and an OTT UI.

- ✅ Single-writer **signed** account/catalog Hyperbee; **encrypted** feeds; per-user key
  sealing (X25519 grants, private key sealed under the password)
- ✅ **OPRF login** + Argon2id verifiers + proof-of-work + throttling; sessions, device
  limits, and `tokenVersion` revocation
- ✅ Broadcaster ↔ panel auto-registration (publisher-key-signed `register` RPC)
- ✅ Assets Hyperdrive for posters/art; live catalog push to the UI (no polling)
- ✅ OTT GUI on phone **and** Android TV from one codebase: splash auto-auth → menu hub →
  fullscreen live TV with browse/detail overlays, favorites, search, settings —
  fully **white-label** (descriptor-driven theme and branding)

**Exit criteria met:** login validated against the P2P DB; browse a branded catalog on
phone and TV; unauthorized users can't decrypt.

---

## v1.0 — Production: "Operators can run a real service"

Shipped:

- ✅ **Player SDK**: `@aliran/player-sdk` headless engine + the `@aliran/react-native`
  `<AliranVideo>` binding, dogfooded by the app (an early hybrid CDN↔P2P failover engine
  is internal test infrastructure only — redirect channels are the product CDN path)
- ✅ **Redirect channels**: a CDN-link channel class (`redirect: true` + https `url` set
  in the admin panel) beside untouched P2P channels
- ✅ **Deploy pack**: Docker Compose (the supported install), bare-metal systemd
  alternative, Caddy TLS recipe, CI image builds
- ✅ **Proven on a real VPS over the internet**: remote acceptance harness + the Android
  app playing live P2P against it — no localhost anywhere
- ✅ **Complete admin surface**: panel dashboard + API (admins, purge/delete, search,
  observability, curation, device revoke) and broadcaster control API + UI (start/stop,
  ingest config, transcode, logs, push URLs, honest state badges)
- ✅ **Ingest expansion**: RTMP / SRT-with-passphrase / MPEG-TS-over-UDP push and
  HLS/RTSP pull; typed per-channel input config, auto port allocation, ffmpeg
  capability probe
- ✅ **Per-channel transcode incl. GPU**: resolution/fps/bitrate/preset and encoder
  selection (x264, NVENC, QSV, VAAPI, AMF, passthrough `copy`), deep-verified at startup
- ✅ **Rolling feed buffer**: endless live streams occupy O(window) space; stable `disk`
  feed identity by default, byte-flat `ram` mode available
- ✅ **Broadcaster reliability**: ffmpeg watchdog with backoff, stalled-edge and
  memory-cap recycling, backup sources with fail-forward, auto-resume after restart,
  honest catalog `isLive`, per-channel log ring, correlated incident log, and an
  **offline slate** (loops "SOURCE OFFLINE" bars when a source dies, auto-returns on
  recovery) so a dead channel stays live with a message instead of going blank
- ✅ **Hybrid artwork**: P2P assets drive by default; `https://` art URLs pass through
- ✅ **White-label packaging**: brand dirs build into co-installable branded APKs from
  one codebase (`tools/brand.mjs`; see `docs/white-label.md`)
- ✅ **Docs site** (GitHub Pages) and **CI** (required deterministic lane + best-effort
  real-DHT e2e lane)
- ✅ **Observability & config hygiene**: fail-fast env validation on every service
  (a typo is a boot error naming the variable), opt-in JSON structured logs
  (`LOG_FORMAT=json`), unauthenticated `/healthz` on every HTTP surface (panel
  included) + Prometheus `/metrics`, an opt-in repeater status port
  (`STATUS_PORT` — the stock repeater stays socket-free), and bounded container
  logs in every compose file
- ✅ **Backup, restore & rotation runbooks**: `docs/kb/backup-and-rotation.md`
  (what to back up vs what's disposable, cold-backup + restore incl. the
  restore-freshness fork hazard, warm-standby failover with the never-two-writers
  rule, full credential rotation matrix), `deploy/backup.sh` (cold
  stop→tar→start), and an automated restore drill (`test:backup`) in the required
  CI lane — operational HA only, deployed players/SDKs unaffected
- ✅ **Hardening pass** over the shipped crypto paths — a wire-compatible
  implementation audit (parameters, timing safety, replay, revocation, resource
  exhaustion, key hygiene, legacy sunset, dependencies) with fixes + fail-closed
  regression tests (`test:rpc-hardening`, required CI lane): malformed login-RPC
  payloads now fail closed instead of crashing the panel (was an unauthenticated
  remote kill), the fixed-window login throttle map is bounded, key/secret
  directories are created `0700`, and a boot warning nudges the `LEGACY_PUBLISHER`
  sunset. Guarantees, audited surfaces and an explicit residual-risk register are
  in [docs/security-model.md](docs/security-model.md).

**Exit criteria:** a new operator can go from clone → live service in under an hour,
following only the docs.

---

## v1.x — Optional modules (opt-in, provider-pluggable)

- ✅ **VOD**: the standalone `library/` service — file → HLS-VOD ingest
  (copy/transcode) into per-title encrypted Hyperdrives, `type:'vod'` +
  `durationSec` catalog class, unchanged grants, SDK serves with full seek and no
  live machinery (`test:vod` in the required CI lane) — and the apps play titles
  with a seek/pause transport on the live surface (verified on-device). Later
  options: resume positions / Continue Watching / live→VOD recording
- ✅ **Windows desktop player** (`desktop/`): an Electron app consuming the
  published SDK — the same OTT interface as the Android app, packaged as an NSIS
  installer + portable exe in two flavors (operator build with the descriptor
  baked in, public build with first-run panel-key entry). See
  [docs/desktop-player.md](docs/desktop-player.md)
- ❌ **Commercial DRM & geo-locking — dropped (2026-07), deliberately.** They were
  listed here as provider-pluggable options; the decision is that they don't fit
  the platform's model and won't be built. What stands instead is honest access
  control: encrypted feeds, per-user sealed keys, cooperative sessions, and
  stream-key rotation as the real revocation boundary — with its limits stated
  plainly in [docs/security-model.md](docs/security-model.md). Operators with
  territorial-licensing obligations must satisfy them contractually / at the
  content source rather than expecting the platform to enforce borders
- ⬜ **GPU transcode pack** (separate package): a dedicated bare-metal deploy pack for
  hardware-encode hosts — NVIDIA driver + NVENC setup (VAAPI/QSV variants), systemd
  units, capability-probe verification recipe; optionally a Docker variant via
  nvidia-container-toolkit. Today GPU encoders work on the bare-metal path with
  vendor drivers installed; this packages it as a first-class, tested offering
- ✅ **Per-publisher registration keys + channel scopes**: each broadcaster site
  (e.g. each carrier downlink location) is enrolled with its own keypair and
  admin-assigned channel-id scopes (`add-publisher` / the dashboard's Publishers
  tab) — signatures verified against that site's key, writes limited to its scoped
  channels, `origin` attribution in the catalog + activity feed, one-click
  revoke/re-activate. Migration-safe: legacy shared-key registrations keep working
  until the operator sets `LEGACY_PUBLISHER=0`
- ✅ **Remote channel sources**: a provider-prepared JSON feed pulled on a schedule
  (daily by default, ETag-aware) and materialized as a **category of redirect
  channels** — validated as pure data, ownership-stamped so a feed can only touch
  its own namespace, removed-from-feed = removed-from-catalog, auto-granted to
  every user (reconciled each sync + at user creation), managed via
  `add-source`/`/api/sources`/the dashboard Sources tab; individual channels
  deselectable per source
- ✅ **Program guide (EPG)**: kept out of the replicated catalog — `epgUrl`/`epgId`
  pointers drive an on-demand https client fetch that renders a live Now/Up-next guide
  in the Info panel (one ETag-revalidated fetch per category, works on any channel;
  no per-client store growth, no fabricated data)
- ⬜ Runtime **service-descriptor QR** so one generic APK connects to any operator
  (the desktop player already ships this as the public build's Connect screen)
- ⬜ Concurrency limits, rental windows, blackout dates (entitlement-time features)

---

## Future / exploratory

- ✅ **Repeater appliance** — a keyless regional super-peer (the Open-Connect analog),
  shipped as first-class `repeater/` (see `docs/repeater.md`): a hosted box mirrors
  chosen channels' **encrypted** feeds and absorbs viewer fan-out while holding no keys
  and unable to watch what it serves. Remaining follow-ups: panel-ASSIGNED repeater
  fleets and locality pinning
- ⬜ iOS / Apple TV client (native HLS)
- ⬜ **Web player via an HTTP gateway** — a hosted page that plays the service in any
  browser. Browsers cannot join the Hyperswarm DHT (no UDP), so the honest design is
  a **gateway node** that runs the P2P engine server-side (the existing player SDK,
  headless) and re-serves each feed as plain HLS over HTTPS to `hls.js` in the page,
  with viewer auth via a panel HTTP endpoint. Trade-off to state up front: gateway
  viewers don't re-seed — for them the gateway is a mini-CDN, so it re-centralizes
  bandwidth for exactly that audience. Big synergy: the same gateway unlocks
  **legacy devices below the Android 10 Bare floor** (Android 7–9 boxes, Fire
  OS 7 sticks — the single APK already installs and runs there with the engine
  silent, see [client build](docs/client-build.md)) as CDN-only clients of
  their own service: it is the natural "other method" an app offers when
  `AliranBackend.isSupported()` is false.
  True in-browser P2P (WebRTC/WebTransport swarm bridge) stays a separate research
  item on top of this.
- ✅ **SDK unsupported-device hook** — `@aliran/react-native` exports
  **`<EngineNotice>`**: a brandable "engine can't run here" screen for the
  `!isSupported()` branch of single-APK builds (Android 7–9), with an optional
  D-pad-focusable action button as the host's seam for offering the viewer an
  alternative method (their own CDN/HLS path — or the web gateway above once
  it exists). The SDK stays content-agnostic: it provides the notice and the
  switch, never the delivery. The shipped app dogfoods it
  ([guide](https://abuelosimpson.github.io/aliran/sdk-guide/)).
- ✅ **Native Kotlin SDK (`aliran-kit`)** — the RN binding's twin for any Android
  app without React Native: same engine bundle + IPC protocol via BareKit's
  plain-Java API, `AliranPlayerView` (Media3) with the `<AliranVideo>` playback
  contracts, `EngineNotice` — **one APK from Android 5.0** (P2P active on 10+,
  silently off below), covering fleets RN itself can't reach (Android 5/6 STBs,
  Fire OS 5 sticks). Verified on an Android 5.1 emulator (notice + fallback) and
  a modern one (full P2P against a production panel). `sdk/android/` in-repo;
  Maven publishing is a future item.
- ⬜ Chat / interactivity alongside live streams
- ⬜ **Multi-admin (Autobase) catalogs** — fully independent catalog writers, beyond
  the scoped-publisher model above
- ⬜ Adaptive bitrate ladders; low-latency HLS/LL-DASH
- ⬜ Analytics that respect privacy (aggregate, no per-user tracking)

---

## How to contribute

Pick an unchecked item, open an issue to claim it, and see
[`CONTRIBUTING.md`](CONTRIBUTING.md). Security-sensitive items (OPRF, key-wrapping,
tokens) should be discussed in an issue first and prefer vetted libraries.
