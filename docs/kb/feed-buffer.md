# P2P feed buffer & window tuning

How the live feed is delivered over the peer-to-peer network, the two buffer modes
(`disk` vs `ram`), and how to size the HLS segment window for a good streaming
experience. If you're chasing slow time-to-play, start here.

## The transport is Hypercore, not WebRTC

A common misconception: Aliran is **not** "HLS P2P over WebRTC." Two independent
layers are involved:

- **Media format = HLS.** ffmpeg produces plain MPEG-TS segments (`seg0.ts`,
  `seg1.ts`, …) plus an `index.m3u8` playlist, purely so any standard HLS player can
  decode the bytes.
- **P2P transport = Hypercore / Hyperswarm** (the Holepunch/Pear stack). The segments
  are mirrored into an **encrypted Hyperdrive** and replicated over Hyperswarm's DHT
  (UDP hole-punching). There is no `RTCDataChannel` anywhere — tuning WebRTC knobs
  would be chasing a ghost.

The segments are the entire payload that gets shared peer-to-peer. The rolling-buffer
work did **not** remove segments — it stopped the feed *hoarding old ones* (see below).

## Buffer modes: `disk` (default) vs `ram`

The live feed is a **rolling window**, not an archive: the playlist defines which
segments exist, and everything that rotates out is deleted from the drive **and** its
blob storage is reclaimed (`hypercore clear()` frees each segment's blocks *as it rotates
out*). A channel that streams for days occupies **O(window)** storage in either mode. Set
the mode with the `FEED_BUFFER` env var or a per-channel `buffer` field.

| | **`disk`** (default) | **`ram`** |
|---|---|---|
| Feed identity (`feedKey`) | **Stable** across restarts | **Fresh** every start |
| DHT discovery topic | Stable → returning viewers rejoin a **warm** topic | New every restart → **cold** discovery each time |
| Viewer replica | **Resumable** from on-disk cache | Always cold-synced |
| Broadcaster storage | Window-bounded (tens of MB of segment data)† | Byte-flat (memory only) |
| Best for | **Normal operation — fastest time-to-play, healthiest P2P** | Hosts that must keep the disk byte-flat |

In **both** modes the **encryption key persists** (`feed.key` in the channel's store
dir) — user grants seal it, so restarts never invalidate access. Viewers follow a
`feedKey` change (RAM restarts) automatically: the player SDK resolves the CURRENT
`feedKey` from the replicated catalog at play time, so no re-login is needed. A
*re-keyed* stream (new encryption key) still needs a fresh login — that is a
deliberate access-control boundary.

### † Disk growth: O(window), and how it can fail

> **Symptom:** a `disk`-buffer channel's store dir (`DATA_DIR/channels/<id>/`) grows to
> **gigabytes** over a long run — far past the ~tens-of-MB window — and can fill the host
> disk (this once filled a VPS to 100 % and killed the channels).
>
> **Cause:** the feed is a hypercore (append-only). `clear()` frees the blocks of rotated
> segments, but reclaim used to only sweep **below the single lowest offset still
> referenced by a live entry**. If *one* entry gets stuck at a low offset — an **orphaned
> segment** stranded when the ffmpeg watchdog respawns (a fresh ffmpeg resets its `seg%d`
> counter to 0 and abandons the previous run's high-numbered `.ts` files, which stay on
> disk and never rotate out) — that entry **pins the watermark**, and *every* segment
> above it accumulates forever. Disk mode persists the core across restarts, so the pin
> (and the leak) survived reboots.
>
> **Fix (shipped):** the mirror now frees each blob **as its segment rotates out** (and
> when a re-put supersedes it), so reclaim no longer depends on a global watermark a stuck
> entry could pin. On (re)start it also **reconciles** the reopened core against the fresh
> output dir, dropping any orphaned entries a prior run stranded — expect a **large first
> reclaim** on the next start after upgrading. Covered by the orphan-pin scenario in
> `test:retention`.

!!! note "The window bound is on *segment data*; metadata creeps slowly"
    The **tens of MB** figure is the reclaimed **segment (blob) data** — the acute term.
    A hypercore's **merkle tree and metadata** are append-only and are *not* reclaimed by
    `clear()`; they grow slowly with total runtime (order ~100 MB/day for a 2 s window at a
    few Mbps), independent of window size. A broadcaster **restart does not** reset this
    (disk mode reopens the same core); only a **feed rotation** (a source change bumps
    `feedGen` → a fresh core) or a re-key starts the metadata over. For multi-week 24/7
    channels, budget for this slow creep or rotate the feed periodically — viewers follow a
    `feedKey` change automatically (next section).

    **Where the creep lands depends on the buffer mode.** In `disk` mode it is disk bytes
    (the OS page cache absorbs the reads — node RSS stays flat). In `ram` mode those same
    append-only files are process memory, so node RSS itself creeps (order ~10 MB/h for a
    6-channel box at a 4 s window) and only a restart (which IS a feed rotation in `ram`
    mode) resets it. On a small-RAM host running `ram` buffers 24/7, plan a periodic
    restart/rotation — or use `disk` mode, which keeps RSS flat for free.

!!! note "Fixed: unbounded per-feed metadata caches (the fast RSS leak)"
    Before the fix, each feed's Hyperbee kept two internal caches (decoded btree nodes +
    keys) keyed by the ever-growing append seq — ~1.5 KB of heap retained **per metadata
    append, forever** (~24 MB/h at 6 channels, either buffer mode; this is what re-filled
    a 1 GB box within hours). All channels' cores now share one bounded global cache
    budget (`FEED_CACHE_MAX`, default 8192 entries ≈ 10–15 MB ceiling). Verified by a
    6-channel soak: heap flat after the budget fills. `tools/mem-soak.mjs` reproduces and
    measures both this and the slow creep above.

### Why `ram` is *slower* to join, not faster

> **Symptom:** time-to-play from a fresh client store is ~40–55 s (vs ~10 s expected),
> and it's slow again after **every** broadcaster restart.
>
> **Cause:** the RAM buffer does not just hold data in memory — because a RAM-backed
> Corestore generates a **fresh primary key on every start**, the `feedKey` and its
> `discoveryKey` are brand new after each restart. So every viewer must:
> 1. do a **cold Hyperswarm DHT lookup** on a topic that was only just announced
>    (this is the dominant cost — tens of seconds), and
> 2. **cold-sync the whole current window** from the single broadcaster seed, because
>    no prior replica of *this* keypair exists anywhere.
>
> A ramdisk does **not** fix this — going RAM-backed is precisely what turns "cold DHT
> once" into "cold DHT after every restart."
>
> **Fix:** use `FEED_BUFFER=disk` (the default). A disk Corestore persists its primary
> key, so the `feedKey`/topic stay stable across restarts: returning viewers rejoin a
> warm topic and resume their on-disk replica. Storage still stays window-bounded via
> the same rolling reclaim, so you keep the disk-safety win without the cold-start tax.

### Switching an existing channel

- **Globally:** set `FEED_BUFFER=disk` (or `ram`) in the broadcaster env and restart.
- **Per channel (control API):** `PATCH /api/channels/<id> { "buffer": "disk" }`, then
  stop/start the channel.

Switching from `ram` → `disk` mints one new stable `feedKey` on the next start (a
single cold discovery), after which the identity is fixed. The encryption key is
untouched, so grants stay valid.

!!! tip "Running many channels? IOPS, not space, is the wall"
    Buffer mode above is about *one* feed's storage. When you run **many** channels the constant
    per-segment write churn becomes **disk-IOPS-bound** — the reason traditional streaming uses a
    ramdisk. Turn on the **scale profile** (`HLS_WORK_DIR` on tmpfs + `FEED_BUFFER=ram`) and see
    [Scaling & capacity planning](scaling.md) for per-channel RAM/CPU/IOPS numbers and a hardware
    sizing table.

## Sizing the segment window (`HLS_TIME` / `HLS_LIST_SIZE`)

The window is `HLS_LIST_SIZE` segments of `HLS_TIME` seconds each. Defaults: **`2` s ×
`8` ≈ 16 s**. These knobs affect live-edge latency, first-frame buffering, compression,
and per-block P2P overhead — they do **not** touch DHT discovery latency (that's the
buffer-mode lever above).

- **`HLS_TIME`** is the main **startup** lever. The host player prebuffers roughly
  `3 × HLS_TIME` before playback begins, all pulled cold from the seed. At ~3 Mbps
  that's ~6 s of media at 2 s segments vs ~12 s at 4 s.
  - **Shorter (2 s):** faster first frame, lower live latency.
  - **Longer (4–6 s):** better compression (fewer forced keyframes), fewer files, less
    metadata churn — but a slower first frame. Don't go below 2 s (keyframe/compression
    cost climbs) or above ~6 s (first-frame latency hurts).
- **`HLS_LIST_SIZE`** is the **P2P-shareability / rebuffer-cushion** lever (window
  depth = `HLS_LIST_SIZE × HLS_TIME`). It barely moves startup (the player starts ~3
  segments back from the live edge regardless).
  - **Small swarm (a few viewers):** `8` (≈16 s) is plenty.
  - **Large swarm (many concurrent viewers):** `12`–`16` — deeper overlap means a
    joiner can pull from more peers and ride out a peer dropping.
  - **Client blip-recovery margin (same lever):** the window is also how long a
    viewer's network may hiccup before the live edge slides past their player and the
    picture freezes. The app self-heals that (the `<AliranVideo>` stall resync — see
    [playback](playback.md#video-freezes-while-everything-looks-healthy-clock-ticks-peers-connected)),
    but a deeper window prevents the freeze instead of recovering from it: at `8×2 s`
    any ~16 s Wi-Fi blip freezes mobile viewers; `12`–`16` (24–32 s) rides most of
    them out. Cost is a proportionally larger per-channel window store — small since
    the reclaim fix.

**Recommended starting point:** `HLS_TIME=2`, `HLS_LIST_SIZE=8`, `FEED_BUFFER=disk`.
Bump `HLS_LIST_SIZE` to `12`+ as the audience grows **or if viewers are on flaky
networks (mobile/Wi-Fi)** — the 2026-07-16 S22 freeze happened at `8×2 s`.

> **Note — keyframe alignment with `copy`:** the encoder must emit a keyframe every
> `HLS_TIME` seconds (e.g. OBS "keyframe interval") or segments won't cut cleanly.
> For transcoding encoders Aliran forces this automatically.

## Time-to-play expectations (healthy system)

| Scenario | Expected |
|---|---|
| Fresh client store, first ever connect | 30–90 s (cold DHT + cold replica) |
| Returning viewer, **`disk`** broadcaster (warm topic) | ~10 s |
| Returning viewer after a **`ram`** broadcaster restart | 40–55 s (cold DHT again) |
| After the playlist appears | a few seconds while the live edge replicates (the server *holds* requests until the content lands — no 404 churn — and streams segment bytes as blocks arrive) |

`1 peer` in broadcaster status means the broadcaster only; each extra viewer is an
extra seeder. See also the latency notes in
[Operating the panel & broadcaster](operator.md).

## Channel zapping (switching in a warm session)

Zapping is **not** the same as cold time-to-play. Once you're logged in, switching
channels skips the panel connect + login entirely — the only cost is the target feed.
Measured over the public DHT against a 2-channel deployment, warm session:

| Switch | What it is | Time to playable |
|---|---|---|
| first channel | cold first-play (already logged in) | ~2.5 s |
| → a **new** channel | cold first-zap | ~1.2 s |
| → **back** to a watched channel | warm re-zap | **~0.3–0.4 s** |

Why the shape:

- Each channel is its **own P2P feed with its own DHT topic**, so the *first* zap to a
  channel this session cold-joins that topic and replicates its window. It's fast
  (~1 s) because the broadcaster peer is already connected — it seeds every channel —
  so there's no fresh DHT bootstrap, just the new feed's first segments.
- The SDK **caches opened feeds and reuses them**, keeping their topics replicating in
  the background, so zapping *back* to a recently-watched channel is near-instant — the
  replica is already warm (`resolve()` returns in ~1 ms; the ~0.3 s is just fetching the
  current playlist + live segment). **Disk mode extends this across sessions**: the feed
  identity is stable, so yesterday's replica resumes instead of cold-syncing.

!!! note "Fixed: re-zap used to hang"
    Before the feed-reuse fix, switching **back** to a channel opened earlier in the
    session wedged `resolve()` — the SDK opened a *second* Hyperdrive over the same
    store namespace and `ready()` deadlocked against the still-open first one. `serveFeed`
    now reuses the cached feed, so flip-back is ~0.3 s. Covered by the `test:sdk`
    zap `news → movies → news` regression.

### Pre-warm: make the *first* zap warm too

The SDK can **pre-warm** entitled feeds right after login — open each channel's replica
and join its DHT topic in the background, so the cold discovery + handshake is paid
upfront (off the play path). Then even the *first* play or zap to a channel is a cache
hit, not a cold open. On-device (release APK, phone), with pre-warm on, the first play
of channel 1 and the first zap to channel 2 both logged `feed:ready` with **no**
`feed:open` — i.e. instant — where before they were cold `feed:open → feed:ready`.

Enable it with the `prewarm` option (`AliranPlayer` / the RN binding's `start()`):

- `false` (SDK default) — off.
- `true` — warm **all** entitled feeds.
- a **positive integer** — cap to that many, warming **lowest curated order first** (the
  channels a viewer is likeliest to reach). The app ships a bounded cap so a large lineup
  doesn't join hundreds of topics at once.

It's **bandwidth-cheap**: replication is sparse, so pre-warm warms the *connection*, not
a full download — segments only transfer when a feed is actually served. Pre-warmed feeds
share the same single-flight cache as played feeds, so a play that races the warm reuses
the one open (never a second Hyperdrive on the same namespace).

### How segment bytes reach the player (progressive serving)

The localhost media server (shared core `sdk/serve.js`, used by the SDK engine, the
Android worklet, and the desktop tools) is tuned for zap latency:

- **Block-progressive bodies:** a segment response streams 64 KB hypercore blocks to
  the player *as they replicate* — ExoPlayer starts parsing the first block while the
  tail is still in flight (every segment starts on a keyframe, so decode can begin
  from the first bytes). `test:serve` proves first-byte-before-full-blob with a gated
  replication pipe.
- **Availability wait:** a playlist/segment that hasn't replicated yet is *held*
  (bounded at 6 s) and served the moment it lands, instead of 404ing the player into
  its 2.5 s retry remount.
- **Live-edge read-ahead:** each playlist request kicks off a *parallel* background
  download of the newest 3 segments, so replication overlaps the player's strictly
  sequential fetch pattern instead of being demand-paged segment by segment.

### Zap prefetch: keep the neighbors' live edge warm (optional)

`zapPrefetch` (SDK option / RN `start()` option; **off by default**) goes one step past
pre-warm: while a channel plays, the SDK keeps the **newest segment** of the
next/previous channels in curated zap order replicated locally (following each
neighbor's *current* catalog `feedKey`), so a CH+/CH− zap starts from warm bytes —
typically shaving the target's first-segment fetch off the switch entirely.

- `true` — one neighbor each way, refreshed every 3 s (`{ neighbors: 1, intervalMs: 3000 }`).
- `{ neighbors, intervalMs }` — widen the warm ring / change the cadence.

**The cost is standing bandwidth, which is why it's off by default:** a live feed
rotates a new segment every `HLS_TIME` seconds, so keeping a neighbor's newest segment
warm downloads ≈ that channel's full bitrate for as long as you're watching — ~2×
your playing channel's bandwidth with `neighbors: 1` (one ahead + one behind). Enable
it for lean-back TV profiles where zap feel beats data budgets; leave it off for
metered/mobile viewers. Covered by the `test:sdk` zap-prefetch section (a neighbor's
newest segment must be fully local without ever being served over HTTP).
