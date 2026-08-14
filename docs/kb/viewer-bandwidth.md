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

The viewer's store is a cache of replicas. Where the filesystem can punch
holes in a file — a 64-bit build on a normal internal filesystem — the
store stays small by itself:

- **While you watch:** the store holds about **one live window** of media
  per cached feed, plus a small amount of metadata. When a segment leaves
  the live window, the engine clears its blocks from disk automatically.
  This is safe: the broadcaster already cleared those blocks at the
  source, so no peer can fetch them again. On 32-bit Android this clear
  frees no bytes — see below.
- **While a cached feed is idle:** the engine reclaims the blocks of
  feeds that sit in the warm cache but do not play. Only the active feed
  used to be reclaimed. This is a clear, so it lowers disk use on a
  64-bit device and frees no bytes on 32-bit Android. There the warm
  cache is bounded by deletion instead — see below.
- **When a feed leaves the cache:** the engine keeps the last 12 watched
  feeds warm for fast zaps. When it evicts a feed from that cache, it
  deletes the feed's data from disk. A delete removes the files, so it
  frees the bytes on every platform. The engine must dial that channel's
  broadcaster again if you tune the channel later. See "Persistent spinner
  with zero peers" in the playback guide (`docs/kb/playback.md`).
- **After login:** the engine deletes the replicas of feeds that are no
  longer in the catalog (for example, a deleted or re-keyed channel).
- **VOD titles are the exception.** A viewer can seek a VOD title at any
  point, so the engine keeps its replica as a cache and does not clear
  it. It never rotates one either. The store cap does not delete one
  either: a VOD replica is counted as held, never as evictable. A VOD
  replica leaves the disk in only two ways. The 12-feed count bound can
  evict it, or the after-login sweep can delete it once the title leaves
  the catalog.

**32-bit Android is the exception to the first rule.** A clear frees no
bytes there. The app does not ship two native modules on the
`armeabi-v7a` and `x86` ABIs, because they abort the P2P engine at
startup on a 32-bit ABI. One of them, `fs-native-extensions`, supplies
the `trim` call that punches cleared blocks out of the file. Without it
the clear still reports success, but the file keeps its size. So the
active feed grows for the whole watch session — roughly 0.9 GB per hour
at 2 Mbps — on hardware that often has only 2-4 GB of free flash. Many
Android TV boxes are 32-bit.

**A byte budget bounds it instead.** The engine measures each replica's
real size on disk. Two separate bounds use that number:

- **The feed you are watching.** When it passes `reclaimBudgetBytes`
  (default 512 MiB), the engine **rotates** that replica: it deletes the
  feed's files and opens the feed again. A delete frees the bytes
  without `trim`, so it works where a clear does not. Only the feed
  being watched is measured against this budget and only it rotates.
- **The warm cache as a whole.** When the store passes a total cap —
  four times the per-feed budget, so 2 GiB by default — the engine
  deletes idle cached feeds, oldest first. Lowering
  `reclaimBudgetBytes` lowers this cap with it.

  **Three kinds of feed are protected from this cap.** The engine never
  deletes the feed you are watching, a feed a cast has pinned, or a VOD
  title. It counts their bytes as *held*.

  **So the cap is not a hard ceiling, and it is not meant to be.** The
  engine compares only the *evictable* bytes against what is left of the
  cap after the held feeds have taken their share, and it never trims the
  warm cache below one feed's budget. A held feed has no bound of its own,
  so one large VOD title or one long cast can push the store above 2 GiB
  and hold it there for as long as the pin lasts. The engine accepts that
  overshoot on purpose. The alternative is to delete every warm replica
  the viewer has, once a minute, without ever bringing the store under the
  cap. **Size a device for the cap plus the largest feed it may hold, not
  for the cap.** When the floor engages, the engine records a `store-cap`
  breadcrumb that names the held bytes, so a full device is answerable.

Requests park during the swap instead of failing, so a rotation is
**designed** to be invisible. It is not guaranteed. It can cost the
viewer a gap in three different ways.

- **The park expires.** The park is bounded at 2.5 seconds. If the
  re-open does not land in time, the viewer gets the same short black gap
  they would have got before this bound existed, delayed by up to the
  length of the park. A park that can still end in a failure shifts the
  player's retry by its own length, and only not parking at all would
  avoid that.
- **The rotation reports success and the viewer still lost the picture.**
  The delete draws on the park's budget first, and the re-open then keeps
  a floor of 1 second whatever is left. So a delete that runs longer than
  1.5 seconds pushes the re-open past the end of the park. The parked
  requests wake to a feed that is not open yet, take a 404, and the
  player does a full remount. The re-open then succeeds. Nothing throws,
  no recovery starts, and the `feed:rotate` event that follows says the
  rotation went fine. It did, for the disk. On the hardware this budget
  exists for — 32-bit Android on low-end flash, deleting a replica of
  several hundred MB — this is uncommon but routine over a multi-hour
  session, not a corner case.
- **The refill after a clean swap.** Measured on a 32-bit TCL box
  (2026-08-14): the swap itself took 150-662 ms and never came near the
  park bound, but the re-opened replica is empty, and the live window
  re-replicates at about 1x real time while the player drains its ~10 s
  buffer. That race is thin. Across six measured rotations, two froze
  the picture for ~2.5 s — no black screen, no error, playback resumed
  by itself — and four were invisible. For scale, the same session took
  an 8.7 s player remount from ordinary upstream churn with no rotation
  involved. The cost is below a live channel's background noise, and it
  is not zero.

**A device whose filesystem can punch holes does not rotate.** That is
the guarantee, and it is about that capability, not about 64-bit. Two
independent things enforce it.

First, the engine tests the filesystem before it applies the budget. It
writes a scratch file, punches a hole in the middle, and measures the
allocated size again. Where the punch frees bytes the budget is switched
off for that store, so a rotation can never run. This tests the
behaviour, not the platform. A 64-bit device is therefore not exempt for
being 64-bit. If its store sits on exFAT, FAT32 or some network mounts,
the punch fails, the budget stays armed, and that device does rotate.
That is correct: a clear frees no bytes there either.

Second, the ceiling is not a flat number. It is the larger of the
configured budget and three times the **observed** live window, measured
from the playlist the engine is already reading. This matters because an
operator can set a window of up to 1920 seconds. One healthy window at
that size and 2 Mbps holds 458 MiB, which is 90% of the default 512 MiB
budget, and a channel above about 2.24 Mbps passes that budget outright.
A flat ceiling would have rotated a perfectly healthy replica, over and
over. With the window term, a replica holding about one live window
cannot be over budget on either side of the probe. A rotation is also
rate-limited to one per five minutes.

**The probe leaves scratch files, and nothing sweeps them.** Each probe
writes 512 KiB into a `punch-probe-<random>/data` path in the store, then
truncates and deletes it. It runs at most three times per server. A
process killed between the write and the delete strands that file, and no
part of the engine lists the store to clean it up. So an operator who
finds `punch-probe-*` entries while debugging a full disk is looking at
engine scratch data, not at replica data. Deleting them by hand is safe.

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
