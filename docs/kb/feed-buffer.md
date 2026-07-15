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
blob storage is reclaimed (`hypercore clear()` below the live window). A channel that
streams for days occupies **O(window)** storage in either mode. Set the mode with the
`FEED_BUFFER` env var or a per-channel `buffer` field.

| | **`disk`** (default) | **`ram`** |
|---|---|---|
| Feed identity (`feedKey`) | **Stable** across restarts | **Fresh** every start |
| DHT discovery topic | Stable → returning viewers rejoin a **warm** topic | New every restart → **cold** discovery each time |
| Viewer replica | **Resumable** from on-disk cache | Always cold-synced |
| Broadcaster storage | Window-bounded (tens of MB), touches disk | Byte-flat (memory only) |
| Best for | **Normal operation — fastest time-to-play, healthiest P2P** | Hosts that must keep the disk byte-flat |

In **both** modes the **encryption key persists** (`feed.key` in the channel's store
dir) — user grants seal it, so restarts never invalidate access. Viewers follow a
`feedKey` change (RAM restarts) automatically: the player SDK resolves the CURRENT
`feedKey` from the replicated catalog at play time, so no re-login is needed. A
*re-keyed* stream (new encryption key) still needs a fresh login — that is a
deliberate access-control boundary.

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

**Recommended starting point:** `HLS_TIME=2`, `HLS_LIST_SIZE=8`, `FEED_BUFFER=disk`.
Bump `HLS_LIST_SIZE` as the audience grows.

> **Note — keyframe alignment with `copy`:** the encoder must emit a keyframe every
> `HLS_TIME` seconds (e.g. OBS "keyframe interval") or segments won't cut cleanly.
> For transcoding encoders Aliran forces this automatically.

## Time-to-play expectations (healthy system)

| Scenario | Expected |
|---|---|
| Fresh client store, first ever connect | 30–90 s (cold DHT + cold replica) |
| Returning viewer, **`disk`** broadcaster (warm topic) | ~10 s |
| Returning viewer after a **`ram`** broadcaster restart | 40–55 s (cold DHT again) |
| After the playlist appears | a few seconds of `404`s while the live edge replicates |

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

To make the *first* zap to each channel fast too, **pre-warm**: join all entitled feed
topics at login so discovery + live-edge replication overlaps with what the viewer is
already watching, instead of blocking the switch. (Trade-off: every warmed channel
replicates in the background, so bandwidth grows with channels kept warm — fine for a
bounded TV lineup, worth an LRU cap for large catalogs.)
