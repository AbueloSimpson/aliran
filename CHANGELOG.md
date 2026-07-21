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
- **Per-publisher keys + channel scopes**: each broadcaster site can be enrolled
  with its **own** registration keypair and admin-assigned streamId-glob scopes
  (`add-publisher` CLI, `/api/publishers`, dashboard Publishers tab; registry in the
  panel-private `secrets/publishers.json`, public keys only). Named registrations
  verify against that site's key and are scope-checked **before any write**
  (rejects: `unknown-publisher` / `revoked` / `out-of-scope`, surfaced in the
  broadcaster control UI), and stamp `origin:<name>` on the catalog record +
  activity feed. Revocation is a per-site status flip; scope edits apply on the
  site's next register. Legacy shared-key registrations keep working until
  `LEGACY_PUBLISHER=0`. Broadcaster side: set `PUBLISHER_NAME` beside the enrolled
  `PUBLISHER_KEY`.
- **Remote channel sources**: pull a provider-prepared channel-list JSON on a
  schedule and materialize it as a **category of redirect channels**
  (`add-source` CLI, `/api/sources`, dashboard Sources tab; registry in
  `DATA_DIR/sources.json`). Feed entries are validated as pure data (https url
  required per entry, art/id rules, size + count caps), records are
  ownership-stamped (`source:<name>`) so a feed can only touch its own namespace,
  the feed wins on mapped fields while curation (`featured`, manual `isLive`)
  sticks, channels that leave the feed are purged, and `autoGrant` seals every
  imported channel to every user — reconciled on each sync and at user creation.
  Unchanged feeds (or ETag 304s) append **nothing** to the replicated catalog. EPG
  stays out of the bee; imported records carry `epgUrl`/`epgId` pointers for a
  future on-demand client fetch. P2P channels tagged with the same category share
  the rail — zero SDK/app changes. Individual entries can be **deselected** per
  source (dashboard channels-dialog checkboxes / `--exclude`): an excluded channel
  is purged and skipped on every sync — exclusion changes reset the ETag so a 304
  can never mask them — and re-checking re-imports and re-grants it.
- **Program guide (EPG) — fetched on demand, never in the catalog**: imported (and
  any manually tagged) channels carry `epgUrl`/`epgId` pointers, and the app fetches
  the provider JSON over https to render a live **Now / Up next** guide in the Info
  panel (elapsed bar + upcoming programs). One ETag-revalidated fetch serves a whole
  category; the schedule never touches the replicated bee (no per-client growth) and
  playback never depends on it. Set `epgUrl`/`epgId` on any P2P channel (`set-meta`
  / `PATCH /api/streams` / dashboard Edit) to light up the same guide; leave unset
  for an honest "No program information" placeholder. SDK exposes the pointers on the
  display list (like art URLs); the schedule data stays client-side.

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
- **Bounded disk metadata + corruption self-heal**: blob reclaim keeps segment data
  O(window), and the append-only merkle tree is bounded by always-on **orphaned-
  generation GC** plus optional **periodic feed rotation** (`FEED_ROTATE_HOURS` /
  `FEED_ROTATE_TREE_MB`, or `POST /api/channels/:id/rotate`) — viewers follow the new
  feedKey live. A store corrupted by an unclean exit (`EPARTIALREAD` / `OPLOG_CORRUPT`)
  **self-heals** on start by rotating to a fresh generation (was: silent boot failure);
  boot-resume errors are now logged, and compose sets `stop_grace_period: 60s` so a
  clean shutdown has time to finish.
- Reliability: ffmpeg watchdog with exponential backoff + stalled-live-edge restart;
  **memory-cap recycle** of a running pull ffmpeg (`FFMPEG_MAX_RSS_MB` — bounds the slow
  demuxer-state accumulation some live-HLS upstreams cause; no feed rotation);
  **backup sources** (per-channel fallback URLs with fail-forward + opportunistic
  return-to-primary); **feed rotation on source change**; **auto-resume on boot**
  (`desiredRunning`); `isLive:false` on stop via one manager-owned, self-healing
  **PanelLink** (serialized registers, boot catch-up, heartbeat, forced DHT re-lookup
  after a panel restart); per-channel ffmpeg log ring; **correlated incident log** for
  fleet-wide events.
- **Offline slate**: when a source stays dead past `SLATE_AFTER` respawns, the channel
  loops a pre-rendered "SOURCE OFFLINE" slate (SMPTE bars + message) instead of going
  blank in backoff, and returns to the source automatically when it recovers. Remuxed
  with `-c copy` (~0 CPU; works on `copy` channels too), profile-matched to the channel's
  output, media rendered into the image at build time. `#EXT-X-DISCONTINUITY` is now
  emitted on every spawn, which also marks the timestamp reset an ordinary respawn
  already caused. See [kb/offline-slate.md](docs/kb/offline-slate.md).
- **Per-channel ingest/demuxer tuning** (`probesize`/`analyzeduration`/`thread_queue_size`/
  `discardcorrupt`) for difficult push encoders, editable in the control UI.
- Control HTTP API + no-build web UI: add/edit/start/stop channels, ingest +
  transcode forms driven by the capability probe, push-URL copy, logs dialog, honest
  state badges (`ON AIR` / `WAITING FOR PUBLISHER` / `RETRYING`; a slated channel is
  `ON AIR` with a `slate` flag in the status API); admin accounts with the same
  hardening as the panel.
- `SWARM_MAX_PEERS`: per-channel swarm connection budget for scale-out; swarm UDP
  socket-buffer sizing (`SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB`).

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
- **Redirect-channel passthrough** — the product CDN path: `resolve()` returns the
  catalog URL directly. (An internal, config-driven hybrid CDN↔P2P mode predates it
  and survives as e2e-harness infrastructure; **P2P channels have no CDN failover,
  by design**.)
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
  strings or colors in screens — plus per-brand APK packaging: a brand dir
  (`client/brands/<id>/` — descriptor, launcher icon, splash logo, wallpaper, TV
  banner; credentials rejected) builds through `tools/brand.mjs` into a
  co-installable APK (`applicationId com.aliranclient.<id>`) via a property-gated
  gradle flavor; the default no-flavor build is untouched. Ships the fictional
  `sunburst` example brand; operator guide: [docs/white-label.md](docs/white-label.md).

**Repeater (`repeater/`)**
- Keyless regional super-peer (Open-Connect model): mirrors chosen channels' live
  windows **as ciphertext** at the block level (catalog `feedKey` + panel-published
  `blobsKey`), O(window) retention with sweep, follows feed rotations unattended,
  absorbs viewer fan-out off the origin. It holds no grants and cannot watch what it
  serves. Ships with its own deploy pack and testnet-proven e2e.

**Networking (all components)**
- Swarm UDP socket buffers are sized at startup instead of inherited. UDX multiplexes
  every peer stream of a swarm onto one socket pair, so under viewer fan-out the socket
  buffer overflows first — and the kernel drops those packets **silently**, which
  presents as stalling playback rather than an error. udx raised only the receive side
  (1 MiB) and left the send side at the OS default (~208 KiB); both are now set
  (`SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB`).
- Because `setsockopt` is silently clamped to `net.core.{r,w}mem_max` — and Linux stores
  double what it grants, so a readback cannot detect a partial clamp — the ceiling is
  read from `/proc` and a clamped request logs a warning naming the exact sysctl, once
  per process. Raising the ceiling is a **host** action Docker cannot do for you (`net.*`
  sysctls belong to the host under `network_mode: host`), so it ships as an **optional
  standalone script** — `deploy/sysctl/install.sh` + its drop-in — that nothing in the
  normal deploy calls, documented under "Host network tuning" in the
  [operator guide](docs/operator-guide.md) and the
  [network-tuning KB page](docs/kb/network-tuning.md) (which also covers conntrack and fd
  limits); `test:nettune` in the required CI lane.

**Deploy + CI + tooling**
- Deploy pack: root-context Dockerfiles, host-network Docker Compose, systemd units,
  Caddy TLS recipe, `sysctl` drop-in; CI runs the deterministic suites, best-effort DHT
  e2e, and docker-build smoke on every push.
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
- Panel: **`register` is idempotent** — the rebuilt catalog record is compared against
  the stored one and an unchanged re-register is **not re-put**, the same bee-frugality
  rule the source sync already followed. The broadcaster re-asserts every *running*
  stream on a 5-minute heartbeat, and the signed bee is append-only with no compaction,
  so each of those used to cost a block forever: 43 channels = **12,384 redundant
  appends/day (~5.8 MiB/day measured, monotonic)**. Real changes still write — feedKey
  rotation, `isLive`/`status` flips, and a change of `origin` (a different publisher
  taking over a channel is an attribution change the audit trail must keep). The
  private secrets file is still written on the skipped path, and the `blobsKey`
  enricher is still nudged, because that heartbeat is its retry timer. No-op registers
  also stop flooding the 200-entry activity ring, which they otherwise evicted whole
  every ~20 minutes at 43 channels.
- Panel: the **`blobsKey` enricher no longer leaks a core per probed feed**. Its probe
  drives are keyed, so corestore filed them on the panel's own disk regardless of the
  probe namespace, and `close()` only ended the session — the cores stayed forever.
  Growth tracked *distinct feedKeys ever seen*, so periodic feed rotation made the
  control plane grow with rotations × channels, unbounded. Each probe now purges the
  cores it opened; `test:register` asserts the panel's core set is unchanged across
  repeated feedKey rotations.
- Panel: **stray cores from older builds are reclaimed at start**. Purging probes as they
  run bounds new growth but leaves whatever a pre-fix build already stranded, and hand-
  deleting it is not an option — the panel's bee is the single-writer origin of truth for
  accounts and the catalog, with no peer to re-replicate a wrongly deleted core from.
  `openStore()` now sweeps every core directory the panel cannot account for, reusing the
  broadcaster's retired-generation GC (lifted to `@aliran/core/store-gc.js`). It runs at
  open, before the enricher can start a probe, and refuses to delete anything unless all
  **three** of the panel's own cores resolve — plus everything the store holds open is kept
  regardless, so a future fourth core is safe by default. `test:register` plants strays
  (including an unopenable one), restarts, and asserts they are gone while accounts,
  catalog and assets survive — and that the next start reclaims nothing.
- Ops: live feeds no longer grow unbounded (~1–2 GB/h/channel → O(window));
  orphan-pin disk reclaim; remote acceptance always ends with a verdict.

### To do (see [ROADMAP.md](ROADMAP.md) and per-package READMEs)
- GPU transcode pack — a separately-packaged bare-metal deploy pack (NVIDIA
  drivers + NVENC; VAAPI/QSV variants) for hardware-encode hosts.
- Optional (v1.x): multi-DRM, geo-locking, VOD; panel HA replica set.
