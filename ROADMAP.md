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
  memory-cap recycling, auto-resume after restart, honest catalog `isLive`, per-channel
  log ring
- ✅ **Hybrid artwork**: P2P assets drive by default; `https://` art URLs pass through
- ✅ **White-label packaging**: brand dirs build into co-installable branded APKs from
  one codebase (`tools/brand.mjs`; see `docs/white-label.md`)
- ✅ **Docs site** (GitHub Pages) and **CI** (required deterministic lane + best-effort
  real-DHT e2e lane)

Open:

- ⬜ Panel **HA / threshold OPRF** across replicas; documented backup & key-rotation runbooks
- ⬜ Hardening pass + **independent security review** of the crypto paths
- ⬜ Config validation, structured logging, health/metrics endpoints

**Exit criteria:** a new operator can go from clone → live service in under an hour,
following only the docs.

---

## v1.x — Optional modules (opt-in, provider-pluggable)

- ⬜ **VOD**: finished-file Hyperdrives, seek/resume, Continue Watching, live→VOD recording
- ⬜ **Commercial DRM**: CENC/CMAF packaging + BuyDRM/KeyOS, EZDRM, Axinom… via CPIX;
  panel-issued entitlement JWTs; Widevine on Android/TV
- ⬜ **Geo-locking**: MaxMind GeoIP at entitlement time + vendor license geo policy
- ⬜ **GPU transcode pack** (separate package): a dedicated bare-metal deploy pack for
  hardware-encode hosts — NVIDIA driver + NVENC setup (VAAPI/QSV variants), systemd
  units, capability-probe verification recipe; optionally a Docker variant via
  nvidia-container-toolkit. Today GPU encoders work on the bare-metal path with
  vendor drivers installed; this packages it as a first-class, tested offering
- ⬜ **Per-publisher registration keys + channel scopes**: multiple broadcasters can
  already feed one catalog, but they share a single publisher key — one leaked `.env`
  can rewrite any channel in the lineup, unattributed. This enrolls each broadcaster
  (e.g. each carrier downlink site) with its own keypair and admin-assigned channel-id
  scopes: signature checked against that site's key, writes limited to its channels,
  `origin` attribution in the catalog, one-click revocation. Migration-safe — legacy
  shared-key registrations keep working until the operator disables them
- ⬜ Runtime **service-descriptor QR** so one generic APK connects to any operator
- ⬜ Concurrency limits, HDCP/output protection, rental windows, blackout dates

---

## Future / exploratory

- ✅ **Repeater appliance** — a keyless regional super-peer (the Open-Connect analog),
  shipped as first-class `repeater/` (see `docs/repeater.md`): a hosted box mirrors
  chosen channels' **encrypted** feeds and absorbs viewer fan-out while holding no keys
  and unable to watch what it serves. Remaining follow-ups: panel-ASSIGNED repeater
  fleets and locality pinning
- ⬜ iOS / Apple TV client (FairPlay + HLS)
- ⬜ **Web player via an HTTP gateway** — a hosted page that plays the service in any
  browser. Browsers cannot join the Hyperswarm DHT (no UDP), so the honest design is
  a **gateway node** that runs the P2P engine server-side (the existing player SDK,
  headless) and re-serves each feed as plain HLS over HTTPS to `hls.js` in the page,
  with viewer auth via a panel HTTP endpoint. Trade-off to state up front: gateway
  viewers don't re-seed — for them the gateway is a mini-CDN, so it re-centralizes
  bandwidth for exactly that audience. Big synergy: the same gateway unlocks
  **legacy devices below the Android 10 Bare floor** (e.g. Fire OS 7 sticks — see
  [client build](docs/client-build.md)) as CDN-only clients of their own service.
  True in-browser P2P (WebRTC/WebTransport swarm bridge) stays a separate research
  item on top of this.
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
