# Viewer bandwidth & battery

This page covers what an Aliran viewer actually costs on the wire, what
each knob adds, and how the engine protects metered connections. The
numbers below were measured 2026-07-17 against a production panel
(10-channel lineup, 720p feeds, 4 s segments). Treat them as orders of
magnitude — your bitrates dominate everything.

## Download

| State | Standing cost | Where it comes from |
| --- | --- | --- |
| Idle, signed in (`prewarm`) | **≈ 5–6 KB/s** total for a 10-channel lineup | Open DHT topics + sparse metadata sync. This is connections, not media — `prewarm` never downloads segments. |
| Watching a channel | **≈ the stream's bitrate** (~2–3 Mbps for 720p) | Live segments replicating to the local media server. |
| + Smooth zapping (`zapPrefetch`) | **+ ≈ each warmed neighbor's bitrate** while playing | The next/previous channels' newest segment kept warm. `directional: true` (default) warms only the side you're surfing toward — half the cost of both sides. |

So: smooth zapping with one directional neighbor roughly **doubles** the
standing download while a stream plays. That is why it ships **off** and
surfaces in the app as an explicit choice ("Smooth zapping — uses more
data").

## The adaptive gate (why it's safe to leave on)

When you enable it, the engine suspends prefetch — instantly dropping its
downloads while keeping a cheap tick alive to observe recovery — whenever:

- **The network is metered/expensive.** The host app feeds
  `setNetworkProfile({ expensive })` (RN: NetInfo's
  `isConnectionExpensive`). The suspension lifts the moment the network is
  cheap again.
- **Your own stream is struggling.** If the active playlist stops
  advancing for `stallMs` (default 12 s), prefetch stands down rather than
  compete with playback, and only resumes after `resumeMs` (default 60 s)
  of clean advance.
- **The pipe has no headroom.** Each neighbor segment is timed: if it
  downloads slower than `minHeadroom`× realtime (default 3×) twice in a
  row, the connection cannot carry a second stream — the engine suspends,
  and re-measures after the clean-run wait.

Suspensions are observable (`'zap-prefetch'` events with `reason: 'metered'
| 'stall' | 'thin'`), so apps can badge the state if they want.

## Churn headroom (why playback survives a peer that leaves)

A live viewer keeps the **whole live window** of the active stream on the
device: the engine replicates each segment as the broadcaster publishes it,
not when the player asks for it. The player also sits ~10 s behind the live
edge (desktop and Android both pin this offset). Together they form the
survival budget: if the peer you pull from leaves, everything between your
playhead and the live edge is already local, and the engine has seconds to
find another source before the picture can freeze.

Costs, so you can budget them:

- **Steady state: none.** The stream still downloads at 1× bitrate — the
  engine only fetches it earlier.
- **Per zap: one window of data.** At 2 Mbps that is ~4 MB per channel
  change at the 16 s default window, and ~6 MB at the recommended 24 s
  window. On a **metered** network the engine therefore
  keeps the small 3-segment read-ahead instead (same `setNetworkProfile`
  signal that gates smooth zapping) — a metered viewer trades churn
  headroom for data cost.
- **Delay: ~10 s behind true live.** This is the deliberate trade. Zap
  speed does not change — playback starts thin and fills toward the edge.

## Disk

The viewer's store is a cache of replicas. It stays small by itself:

- **While you watch:** the store holds about **one live window** of media
  per cached feed, plus a small amount of metadata. When a segment leaves
  the live window, the engine clears its blocks from disk automatically.
  This is safe: the broadcaster already cleared those blocks at the
  source, so no peer can fetch them again.
- **When a feed leaves the cache:** the engine keeps the last 12 watched
  feeds warm for fast zaps. When it evicts a feed from that cache, it
  deletes the feed's data from disk.
- **After login:** the engine deletes the replicas of feeds that are no
  longer in the catalog (for example, a deleted or re-keyed channel).
- **VOD titles are the exception.** A viewer can seek a VOD title at any
  point, so the engine keeps its replica as a cache and does not clear it.

If the store still grows too large, or becomes corrupt, delete it by
hand. That is always safe — the store holds only replicas. See "The
on-device store is a disposable cache" in the client build guide
(`docs/client-build.md`).

## Upload

A default viewer **re-seeds**: feed topics are joined announced, so blocks
it has already replicated are served to nearby viewers on request. This
upload is opportunistic and demand-driven — roughly bounded by what nearby
viewers actually pull, usually well under one stream's bitrate — and it is
what makes the swarm scale (see the repeater doc for the
infrastructure-grade version).

`uploadPolicy: 'client-only'` turns that off **by construction**: the peer
never announces on feed/assets topics, so other viewers cannot discover or
dial it — practically zero viewer-to-viewer upload. The trade-off is
swarm-wide: every client-only viewer is one fewer re-seeder near other
viewers.

## Battery (phones)

The engine holds DHT topics and peer sockets open while signed in. Radios
on mobile stay in a higher power state while sockets are active, so:

- **Watching** dominates: the screen, decoder, and a full-bitrate stream
  dwarf everything else.
- **Idle signed-in** costs more than a fully idle phone (held sockets keep
  the radio from its deepest sleep), but the traffic itself is trivial
  (~KB/s).
- **Smooth zapping** keeps segment transfers running for as long as a
  stream plays — on battery-sensitive devices, leave it off or rely on the
  metered gate.

## Rules of thumb

- Budget **1× bitrate** per watching viewer; **2×** with smooth zapping on
  (directional, one neighbor).
- A 2 Mbps channel ≈ **0.9 GB/hour** watched; smooth zapping roughly
  doubles that while actively surfing.
- For metered/hotspot viewers: ship NetInfo wiring (the app does) and the
  gate handles it; or set `uploadPolicy: 'client-only'` and leave smooth
  zapping off for the minimum-footprint profile.
