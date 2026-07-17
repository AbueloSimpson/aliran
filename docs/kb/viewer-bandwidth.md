# Viewer bandwidth & battery

What an Aliran viewer actually costs on the wire, what each knob adds, and how the
engine protects metered connections. Numbers below were measured 2026-07-17 against
a production panel (10-channel lineup, 720p feeds, 4 s segments); treat them as
orders of magnitude — your bitrates dominate everything.

## Download

| State | Standing cost | Where it comes from |
| --- | --- | --- |
| Idle, signed in (`prewarm`) | **≈ 5–6 KB/s** total for a 10-channel lineup | Open DHT topics + sparse metadata sync. Connections, not media — `prewarm` never downloads segments. |
| Watching a channel | **≈ the stream's bitrate** (~2–3 Mbps for 720p) | Live segments replicating to the local media server. |
| + Smooth zapping (`zapPrefetch`) | **+ ≈ each warmed neighbor's bitrate** while playing | The next/previous channels' newest segment kept warm. `directional: true` (default) warms only the side you're surfing toward — half the cost of both sides. |

So: smooth zapping with one directional neighbor roughly **doubles** the standing
download while a stream plays. That is why it ships **off** and surfaces in the app
as an explicit choice ("Smooth zapping — uses more data").

## The adaptive gate (why it's safe to leave on)

When enabled, the engine suspends prefetch — instantly dropping its downloads while
keeping a cheap tick alive to observe recovery — whenever:

- **The network is metered/expensive.** The host app feeds
  `setNetworkProfile({ expensive })` (RN: NetInfo's `isConnectionExpensive`);
  the suspension lifts the moment the network is cheap again.
- **Your own stream is struggling.** If the active playlist stops advancing for
  `stallMs` (default 12 s), prefetch stands down rather than compete with playback,
  and only resumes after `resumeMs` (default 60 s) of clean advance.
- **The pipe has no headroom.** Each neighbor segment is timed: if it downloads
  slower than `minHeadroom`× realtime (default 3×) twice in a row, the connection
  cannot carry a second stream — suspend, and re-measure after the clean-run wait.

Suspensions are observable (`'zap-prefetch'` events with
`reason: 'metered' | 'stall' | 'thin'`) so apps can badge the state if they want.

## Upload

A default viewer **re-seeds**: feed topics are joined announced, so blocks it has
already replicated are served to nearby viewers on request. This upload is
opportunistic and demand-driven — roughly bounded by what nearby viewers actually
pull, usually well under one stream's bitrate — and it is what makes the swarm
scale (see the repeater doc for the infrastructure-grade version).

`uploadPolicy: 'client-only'` turns that off **by construction**: the peer never
announces on feed/assets topics, so other viewers cannot discover or dial it —
practically zero viewer-to-viewer upload. The trade-off is swarm-wide: every
client-only viewer is one fewer re-seeder near other viewers.

## Battery (phones)

The engine holds DHT topics and peer sockets open while signed in; radios on mobile
stay in a higher power state while sockets are active, so:

- **Watching** dominates: the screen + decoder + a full-bitrate stream dwarf
  everything else.
- **Idle signed-in** costs more than a fully idle phone (held sockets keep the radio
  from its deepest sleep) but the traffic itself is trivial (~KB/s).
- **Smooth zapping** keeps segment transfers running for as long as a stream plays —
  on battery-sensitive devices, leave it off or rely on the metered gate.

## Rules of thumb

- Budget **1× bitrate** per watching viewer; **2×** with smooth zapping on
  (directional, one neighbor).
- A 2 Mbps channel ≈ **0.9 GB/hour** watched; smooth zapping ≈ doubles that while
  actively surfing.
- Metered/hotspot viewers: ship NetInfo wiring (the app does) and the gate handles
  it; or set `uploadPolicy: 'client-only'` + leave smooth zapping off for the
  minimum-footprint profile.
