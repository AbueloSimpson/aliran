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
verified on real infrastructure (a VPS over the public DHT, a physical Android
phone + Android TV, and the Windows desktop player).

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
  stays out of the bee; imported records carry `epgUrl`/`epgId` pointers the apps
  fetch on demand (the guide bullet below). P2P channels tagged with the same category share
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
- **Fast, observable boot resume**: the control server starts before the auto-resume (not
  after), which runs bounded-concurrent (`RESUME_CONCURRENCY`, default 12) with adaptive
  event-loop back-pressure so it never starves the API. An unauthenticated `GET /healthz`
  reports `{up, resuming, resumed, total, …}` throughout — point uptime checks there. Measured
  on the live 83-channel box: full recovery 451 s → 40 s, with the API responsive the whole
  time (previously `/api` was dark for the entire ~7 min ramp).
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
- **npm-ready packaging (S32)** for `@aliran/core` / `@aliran/player-sdk` /
  `@aliran/react-native` (0.1.0): registry-publishable metadata (`files`,
  `repository`, `publishConfig`, semver-ranged `@aliran/core` dep — the workspace
  and the app's `file:` graph still resolve it locally), hand-maintained TypeScript
  definitions (`sdk/index.d.ts`) for the whole engine surface, a `@aliran/core`
  README, a runnable headless example (`examples/headless-player.mjs`), and a
  Player SDK page on the docs site. **Published to the npm registry as `0.1.0`**
  (first release, 2026-07-22 UTC; cold-install verified). Two deep-dive docs pages
  followed: **SDK installation & configuration** (every install path, option,
  event, runtime control, and troubleshooting) and **Operator APIs & the SDK**
  (every admin/control/RPC endpoint mapped to the viewer-visible effect and its
  propagation latency — live-push vs next-tune vs next-login).

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
- **Public (keyless) flavor** — one generic APK, phone + TV, that connects to any
  operator's service at runtime (the Android analogue of the desktop player's
  public build): baking the committed keyless `config/service.public.json` routes
  first run to a **Connect screen** (panel public key + username + password — no
  URLs, discovery is the DHT); both persist on the device only after a successful
  sign-in, later launches auto-authorize, and *Settings → Change service…* forgets
  the service + sign-in and reconnects (the engine is swapped wholesale when a
  different panel key arrives). A baked operator key always wins and is never
  changeable at runtime. Viewer guide:
  [docs/android-viewer-guide.md](docs/android-viewer-guide.md).
- **One APK from Android 7 up — the engine gates itself at runtime.** A
  patch-package patch on `react-native-bare-kit` turns its link-time dependency
  on `libbare-kit.so` into a lazy `dlopen`/`dlsym` resolved only on API 29+
  (the engine's floor is physical: ELF TLS, added to Android's libc in 10), so
  the standard build is a single `minSdk 24` APK that installs on Android 7–9
  with the SDK **silently inactive** (`AliranBackend.isSupported()` → `false`,
  every call a safe no-op, a plain unsupported-device notice instead of an
  eternal splash) and boots the full P2P engine on Android 10+ — verified with
  the same APK on an Android 7 emulator (silent) and a modern one (engine
  `ready` through the dlopen path). SDK hosts get the same seam: apply the
  patch, gate on `isSupported()`, mount their own legacy/CDN mode below 10.
  An optional `ALIRAN_LEGACY=1` flavor still builds an engine-less lean APK
  for old-device-only fleets. Android 6 is unreachable on this RN generation —
  RN 0.76+ prebuilds are built for API 24 and the build rejects a lower
  minSdk. Recipe: [docs/sdk-guide.md](docs/sdk-guide.md).
- **`<EngineNotice>`** (`@aliran/react-native`) — ready-made, brandable
  "engine can't run here" screen for the `!isSupported()` branch: honest
  default copy about the Android 10+ floor, per-brand colors/copy/children,
  and an optional D-pad-focusable action button as the host app's seam for
  offering the viewer an alternative method (the SDK ships the notice and the
  switch, never the delivery). The shipped app dogfoods it on its
  unsupported-device screen.

**Native Android SDK (`sdk/android` — `aliran-kit`, Kotlin)**
- A React-Native-free twin of the RN binding for any Android app, **one APK
  from Android 5.0 (minSdk 21)**: `AliranBackend` hosts the same bare-pack
  engine bundle via BareKit's plain-Java `Worklet`/`IPC` API and speaks the
  identical line-JSON IPC protocol; `AliranPlayerView` (Media3/ExoPlayer)
  ports the `<AliranVideo>` playback contracts — 1 s zap buffer,
  engine-driven tune lifecycle, frozen-live-edge resync ladder with
  `reconnect()` escalation, feed-rotation rebuild, vod transport; and
  `EngineNotice` mirrors the RN component. On Android 10+ the engine runs in
  full; below, it is never even class-loaded (BareKit's `loadLibrary` lives
  in the Worklet static initializer, so the gate is plain Java class-loading
  — no native patch) and the SDK is silently inert. Covers fleets React
  Native itself cannot reach (Android 5/6 STBs, Fire OS 5 sticks). Verified
  with one demo APK on an Android 5.1 emulator (notice + plain-HLS fallback)
  and a modern emulator (full P2P: OPRF login over the DHT against the
  production panel, catalog, live playback). JVM-tested protocol layer;
  `sdk/android/demo/` is the reference host.

**Desktop player (`desktop/`)**
- Windows desktop player (Electron): the engine (`@aliran/player-sdk`) runs in the
  main process on the stock N-API prebuilds; the sandboxed React renderer plays the
  localhost/redirect HLS with hls.js behind a three-call IPC bridge speaking the
  worklet message protocol. Full S18 parity — splash auto-auth (credentials wrapped
  with `safeStorage`/DPAPI, password never re-enters the renderer), menu hub,
  fullscreen live TV with category rail + numbered list + detail panel, the live
  EPG now/next guide (the shared plain-TS data layer from `@aliran/react-native`),
  favorites/search/settings, "Smooth zapping" toggle, subtitle/audio selection
  (flat hls.js indexes), tuning pill, keyboard-first D-pad-style navigation, and a
  vod seek/pause transport. The `<AliranVideo>` playback contracts are
  reimplemented for hls.js: engine-confirmed tune completion, feed-rotation
  remounts, the frozen-live-edge resync ladder with `reconnectActiveFeed()`
  escalation, and a clean per-channel error for codecs the host GPU can't decode
  (HEVC support = platform hardware decode). electron-builder packaging: NSIS
  installer + portable exe on Windows, dmg + zip on macOS (`dist:mac` locally or
  the manual-dispatch `desktop-mac` GitHub Actions workflow — the engine's N-API
  modules all ship darwin prebuilds; unsigned — the SmartScreen/Gatekeeper
  reality is documented), in
  **two flavors from one codebase**: the operator build bakes `service.json` as a
  resource; the public build ships keyless and opens on a **Connect screen**
  (panel public key + account, persisted in the profile, with *Settings → Change
  service…* to forget it). Guide:
  [docs/desktop-player.md](docs/desktop-player.md).

**Repeater (`repeater/`)**
- Keyless regional super-peer (Open-Connect model): mirrors chosen channels' live
  windows **as ciphertext** at the block level (catalog `feedKey` + panel-published
  `blobsKey`), O(window) retention with sweep, follows feed rotations unattended,
  absorbs viewer fan-out off the origin. It holds no grants and cannot watch what it
  serves. Ships with its own deploy pack and testnet-proven e2e.

**Library (`library/`) — VOD (S8a)**
- Standalone VOD service (deliberately NOT the broadcaster — no live-pipeline
  lifecycle applies to a static seed; runs on separate hardware so ingest bursts
  never touch a loaded live box): operator-registered video **files** become
  encrypted, P2P-seeded on-demand **titles**. One-shot ingest (ffprobe → `-c copy`
  remux for HLS-compatible codecs, else h264/aac transcode → finished
  `#EXT-X-PLAYLIST-TYPE:VOD` rendition, ALL segments kept) into a per-title
  encrypted Hyperdrive on one shared Corestore/Hyperswarm (repeater storage model);
  per-title encryption keys survive re-ingest so grants stay valid; re-ingest mints
  the next feed generation and purges the old; delete purges the title from disk.
  Registers over the existing `register` RPC as **`type:'vod'` + `durationSec`**
  under its own enrolled publisher. Own authed control API + minimal UI
  (`127.0.0.1:3320`: titles CRUD, ingest progress, logs, admins) + unauthenticated
  `/healthz`, Dockerfile + compose service behind the `vod` profile, `.env.example`.
- Panel: the catalog gains the **vod record class** — `durationSec`
  (payload-owned, like `feedKey`), **no `isLive`** (liveness is not a property a
  title has), status `'available'`/`'unavailable'` — additively beside `'live'`
  (byte-identical live records, so S29 idempotence is unaffected); grants/sealing,
  panel-authoritative metadata and blobsKey enrichment apply to titles unchanged.
- SDK: `resolve()` returns `type`/`durationSec` and for vod arms **none** of the
  live machinery (tune watchdog, zap-prefetch gate, hybrid probes, `feed-changed`
  follow — all key on the playlist ADVANCING, which a finished playlist never
  does); vod titles are never segment-warmed as zap neighbors; the localhost
  read-ahead prefetches a VOD playlist's **head** (a live one's tail); display list
  + RN mirror types carry `type`/`durationSec`/`status`. New required-lane
  **`test:vod`** e2e proves the whole chain on a local testnet, including that the
  watchdog provably does NOT arm for vod and DOES for live across zaps.
- **App VOD playback (S8a stage 2)**: the worklet forwards the engine's
  `type`/`durationSec` as **`recordType`/`durationSec` on the `port` IPC reply**;
  `<AliranVideo>` disarms its live-edge stall-resync ladder while the served
  record is vod (a paused/seeking/finished playhead is by design — a resync would
  yank the title back to 0:00) and re-arms it on the next live serve, and gains an
  imperative **`seek()` handle** (`AliranVideoHandle`). In the app, titles ride
  the same surfaces as channels: a **Library rail** straight from the category
  machinery, rows/info showing a **runtime badge instead of LIVE** (no channel
  number — numbers and the CH+/CH- zap ring are live-only, so adding movies never
  renumbers the lineup), `status:'unavailable'` graying, no EPG slot, and the
  NowPlayingBar grows a phone **transport row** — play/pause, elapsed/runtime,
  tap-or-drag seek bar (pure JS, no native slider dep) that stays up while
  paused; end-of-title parks on ▶ and replays from the top. Zapping out of a
  title lands on channel 001 with every live behavior re-armed.

**Reseller panel (`reseller/`)**
- Standalone service that fronts the panel admin API with a **role hierarchy**
  and a **credit ledger**, so third-party resellers can activate and manage
  viewer accounts without holding real admin power. Deliberately a pure HTTP
  service (no P2P, no ffmpeg) that can run on the panel host or a different box;
  it authenticates to the panel as **one** dedicated admin. Two things it owns
  that the panel does not: the hierarchy (**admin → co-admin → super reseller →
  reseller**; the panel has no admin roles) and the **subscription clock** (the
  panel has no account expiry).
- **Credits are months** (1 credit = 1 month, flat; devices are not priced —
  the device count is an **admin-set policy inherited down the hierarchy**:
  accounts receive their creator's effective `maxDevicesLimit`, resolved live up
  the parent chain (`null` = inherit, root fallback = the env default); supers
  and resellers cannot set it, and only admin tiers hold a per-account
  override). Append-only JSONL ledger (the durable audit trail —
  the panel's activity feed is in-memory) with a global monotonic sequence and
  balances always **derived**, never stored: only admins/co-admins mint (even an
  admin's transfer debits their own balance), supers fund their resellers from
  their own balance, activation/renewal costs `months` credits, delete refunds
  `floor(remaining)` to the owner (admin ops are free + refundless).
- **Trials**: free time-boxed accounts (`TRIAL_HOURS`, per-reseller daily cap);
  renewing a trial converts it to paid with the same credentials.
- **Fail-closed** account ops (panel first, local ledger + registry only on OK —
  a rejected activation leaves nothing behind) run under one process mutex.
  Account names are **plain panel usernames** (first come, first served — a
  clash surfaces as the panel's own error); ownership lives in the registry,
  never in the name, and creates are bracketed by an **intent journal** so a
  crash between the panel create and the local commit is found later. The
  **expiry sweep** disables lapsed accounts on the panel (backs off while the
  panel is unreachable; the work list re-derives each tick), and a **reconcile
  sweep** checks every registered account (and stale intents) against the panel,
  reporting (and, with `RECONCILE_REPAIR=1`, repairing) divergences with the
  local clock winning — operator-created panel users stay invisible to it.
- Own worker-thread single-flight Argon2id login (the 2026-07-16 flood lesson),
  role never trusted from the token (the live record is re-read each request, so
  a suspension bites immediately), a no-build four-role dashboard on the shared
  theme, a bootstrap CLI, `.env.example`, Dockerfile + compose service behind
  the `reseller` profile, and the required-lane `test:reseller-unit` +
  `test:reseller` (the latter drives a real in-process panel admin server).
  Docs: [reseller panel guide](docs/reseller-panel.md) + reference API section.
- **Built for large account lists**: the accounts query runs server-side over
  the in-memory registry — case-insensitive search across name *and* owner,
  status filters (active/disabled/expiring/trial), sorting by name / expiry /
  created date / status / owner (asc or desc), offset paging with a `total`.
  The dashboard shows **50 per page** with prev/next + a jump-to-page selector
  and a sort dropdown, debounced search, click-an-owner drill-down for
  admins/supers, and **reflows into stacked cards on phones** (the wide table on
  desktop). Verified against a synthetic 5,000-account registry (unit) and a
  394-account live demo at both desktop and mobile widths (browser).
- **Ops dashboard on login**: the Overview shows the business KPIs and, for
  admin tiers, a **System** section fed by `GET /api/system` — host stats
  (cpu/load/memory/uptime + data-dir disk), the service process (node, memory,
  ledger/sweep health) and a **live timed probe** of the panel admin API
  relaying its user/stream/admin counts; polls every 5 s while the view is
  open, and a panel outage becomes data on screen instead of an error.
- **Cloudflare Tunnel deployment option** for boxes behind NAT/CGNAT or a
  closed firewall: `deploy/cloudflared.compose.example.yml` publishes the
  loopback-bound dashboard through Cloudflare's edge (their TLS/CDN/WAF,
  outbound-only — no inbound port), and `TRUST_PROXY_HEADER` (e.g.
  `cf-connecting-ip`, or `x-forwarded-for` behind Caddy/nginx) keys the login
  lockout on the proxied client IP instead of the proxy's shared socket — set
  only when the port is reachable exclusively through the proxy.

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
- The **viewer engine now tunes its swarm too** (S33) — asymmetrically: 2 MiB receive
  (a viewer's whole download funnels into one socket pair while the worklet thread is
  busy decrypting), send left at the OS/udx default (reseed upload is opportunistic).
  SDK option `swarm: { rcvbufMb, sndbufMb }` overrides, mirroring the server envs. The
  tuning logic split into runtime-agnostic `core/net-tune-core.js` (no `node:fs` in
  the Bare worklet bundle graph — the `/proc` ceiling read uses the engine's injected
  `fs` and degrades gracefully where `/proc` is unreadable, e.g. Android) with
  `core/net-tune.js` as the Node binding; outcome surfaces as a `status`/`net:tuned`
  event and a `[net] swarm sockets tuned: …` worklet log line. Packages bumped to
  0.1.1 (`@aliran/core` gains the new entry point; `@aliran/player-sdk` requires it).

**Deploy + CI + tooling**
- Deploy pack: root-context Dockerfiles, host-network Docker Compose, systemd units,
  Caddy TLS recipe, `sysctl` drop-in; CI runs the deterministic suites, best-effort DHT
  e2e, and docker-build smoke on every push.
- Publishing the dashboards, hardened by a real deployment: `deploy/Caddyfile.example`
  now ships the **scoped** `basic_auth` pattern (`@ui not path /api/*` — the dashboards
  send `Authorization: Bearer` to their own APIs and HTTP has one `Authorization`
  header, so an unscoped gate 401s every API call and the browser re-prompts on every
  click), states the resulting posture honestly (UI gets two gates, the API keeps its
  one rate-limited Bearer gate; a `remote_ip` allowlist is the real second layer), and
  links the full walkthrough `docs/kb/public-dashboards.md` — DNS-first ordering,
  credential hygiene, the verification that actually catches the header collision, and
  the ufw ephemeral-UDP rule without which a default-deny firewall silently degrades
  P2P seeding.
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
- Panel HA replica set; the pre-1.0 hardening/security-review pass.
- (DRM and geo-locking were dropped from the roadmap in 2026-07 — deliberately
  not built; see the security model's no-DRM stance.)
