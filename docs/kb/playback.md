# Playback & client runtime

This page covers issues in the Android app and player SDK at runtime. For
build-time problems, see [Android & React Native builds](android-build.md).

## Posters and video silently fail to load (blank tiles, no error anywhere)

- **Cause:** Android API 28+ blocks cleartext HTTP by default. The app serves
  media and art from `http://127.0.0.1:<port>` (the embedded P2P node), so
  image loaders and ExoPlayer fail *silently*.
- **Fix:** the app ships a `network_security_config.xml` that permits
  cleartext, and the manifest references it. The engine only needs
  `127.0.0.1` (plus the emulator host aliases for Metro in dev), and that
  is all a third-party host has to permit. The **shipped** app now permits
  cleartext to every host — a deliberate posture, so that channels a
  provider serves over plain `http://` can play. That traffic is
  unencrypted and can be read or changed on the network path; the config
  file says so in the file itself. See [Client build](../client-build.md).
- **Diagnostic that isolates it:** run `adb forward tcp:<x> tcp:<port>`, then
  `curl` from the host. If that returns 200 while the app shows nothing, this
  is the cause.

## Playback fails with `OPLOG_CORRUPT: Oplog file appears corrupt or out of date`

- **Cause:** the app process died mid-write (a crash or force-kill) and
  corrupted the local Corestore replica cache. Without recovery this is
  permanent until you wipe the app's data.
- **Fix (shipped):** the engine detects corruption codes (`OPLOG_CORRUPT`,
  `INVALID_CHECKSUM`, and others) on open and on read. It purges the whole
  store and retries once (`sdk/recover.js`, exercised by `npm run
  test:corrupt`). The store is a **disposable replica cache** — everything
  re-replicates from peers, and the in-memory session survives. No re-login
  is needed.
- **Manual fallback (always safe):** clear the app's data/storage. The same
  reasoning applies — nothing of value is lost.

## Login spins forever on "not connected to panel" / "Cannot reach the service"

Check these causes in order of likelihood:

1. **The panel is wedged or down.** Verify from another machine with a small
   hyperswarm read of `catalog/*` *before* you blame the client. A wedged
   panel can look alive in the process list while it answers nothing —
   restart it (see [Operating the panel & broadcaster](operator.md)).
2. **The first DHT dial after a fresh install legitimately takes 30–90 s.**
   The login screen retries for about a minute, then gives up. Pressing
   Sign in again restarts the retry loop.
3. **Stale swarm state sits on the device** after the panel restarted, or
   after the app's data was cleared mid-session. Force-stop and relaunch the
   app — retrying inside the app is not enough, because the embedded node
   needs a fresh swarm.
4. Device network says connected but isn't validated. Check with
   `adb shell dumpsys connectivity | grep -i validated`.

## Player shows black + spinner right after opening a channel

- **Normal for a few seconds:** the live edge is replicating from peers. The
  media server *holds* a request for a not-yet-replicated playlist or
  segment (bounded at 6 s, under ExoPlayer's 8 s read timeout) and serves it
  the moment it lands. So the usual cost is the actual replication time, not
  a 404-to-retry-remount cycle at 2.5 s. Only a path still missing after the
  6 s bound 404s, and the player's 2.5 s auto-retry stays as the fallback
  behind that.
- **Persistent spinner with `0 peers`:** no seeder is *found*. Either the
  broadcaster is down, its ffmpeg ingest died while the process kept
  "seeding" a frozen playlist, or the device holds a **stale DHT record**.
  The last case happens because the broadcaster restarted since the last
  lookup — its feed swarms are ephemeral identities, and hyperswarm
  re-queries a topic only every ~10 min. The broadcaster side self-heals the
  same failure via PanelLink.
- **Fix (shipped) — tune self-heal:** while a tune is incomplete (the
  playlist is not **advancing** — merely existing is not enough, see the
  wedge below), the engine forces fresh DHT lookups on a 5 s → 60 s backoff.
  At 30 s it evicts the cached feed open and re-opens fresh once (the
  `feed:retune` breadcrumb). At 60 s it **destroys the swarm connections
  serving the feed** and dials fresh (`feed:reconnect`). If that also
  expires, it surfaces a friendly `tune timeout` error instead of spinning
  forever — zap to the channel again to retry. Worst case is ≤ 90 s to the
  error at defaults. Pre-fix builds could sit on the spinner
  **indefinitely** (S22, 2026-07-16: a zap stuck at "90 %" for 10+ min
  against a healthy VPS; only an app restart — a fresh swarm — cleared it,
  because the cached dead open poisoned every retry). The `test:sdk` tune
  section guards the whole cycle.
- **Persistent spinner with peers connected (`1 peer` showing):** this is the
  **wedged connection** class. A network flap (Wi-Fi degrade, radio cycle)
  can leave the hyperswarm/UDX connection alive at transport level while
  replication over it moves **zero bytes**. Peer counts look healthy on both
  ends, no error fires, and because hyperswarm keeps one connection per peer
  across all topics, a retune faithfully reuses the same dead pipe. With
  prewarm, one wedged connection to the broadcaster starves **every**
  channel at once (S22, 2026-07-16: 15+ min stuck at "90 %" with "P2P — 1
  peer" while a fresh client played the same feed in 10 s). **Fix
  (shipped):** the tune watchdog requires the playlist to *advance* (a stale
  pre-flap playlist in the replica no longer counts as tuned), and it tears
  the wedged connections down on its second expiry (`feed:reconnect`) so the
  swarm dials fresh. The `test:sdk` wedged-connection section reproduces the
  exact signature with a paused socket.
- **Persistent spinner with zero peers, on a channel you watched earlier in
  the same session:** this is the **deleted replica** class. The engine keeps
  the last 12 feeds warm. It deletes a feed's data from disk when that feed
  leaves the cache (see `docs/kb/viewer-bandwidth.md`). A feed whose data was
  deleted never replicates again over the connection it was deleted on. One
  connection carries every channel of a broadcaster. A later tune to that
  channel therefore re-opens over the same live connection, and finds no
  peer. The tune self-heal above cannot recover it. Its connection teardown
  step needs a peer to tear down, and this failure has none — so the tune
  ends at the friendly `tune timeout` error. **Fix (shipped):** the engine
  records which connections each deleted feed used. It destroys those
  connections when you tune that channel again, and the swarm dials fresh
  (`feed:reconnect`). The other channels on that connection replicate again
  by themselves. A connection that was already replaced stays up. The
  `test:sdk` evicted-feed section reproduces the failure with one seeder that
  serves two channels over one connection.
- A **redirect channel** never hits this failure class at all — there is no
  P2P feed behind it. The host player fetches the operator's URL directly
  and owns its own errors. (P2P channels have no CDN failover by design —
  the self-heal ladder above is their recovery story.)

## Video freezes while everything looks healthy (clock ticks, peers connected)

- **Symptom:** the picture stops dead mid-watch. Peer count and worklet
  heartbeats stay healthy, the UI stays alive, and no error fires. Zapping
  away and back fixes it.
- **Cause:** the HLS live window is short (the code default is 8×2 s =
  16 s; reference deploys now run 12×2 s = 24 s). A network blip longer
  than the window slides it past
  ExoPlayer's position, and react-native-video raises **no error event**
  for that — the surface just freezes.
- **Fix (shipped):** `<AliranVideo>` watches the playhead. Once a mount has
  played and the position sits still for 12 s (`stallTimeoutMs`) while not
  paused, it remounts onto a fresh playlist load at the live edge — the
  same thing the manual zap did — and fires `onStall` plus an `onTune`
  `start`. The app's tuning pill restarts and stays until the resync
  mount's first real playback (`onTune` `playing`).
- **If the resync remount itself never plays** within another window, the
  freeze is not a slid live window but a **wedged connection** (see the
  tune section above). The stall ladder then escalates to
  `backend.reconnect()`, which tears down the engine's connections serving
  the feed and dials fresh. The engine's re-armed tune watchdog then drives
  the outcome — playback resumes, or a friendly error replaces the silently
  frozen frame.
- **Widen the margin (operators):** the standard `HLS_LIST_SIZE=12` (24 s)
  gives clients room to recover from blips; go to `16` for very flaky
  viewer networks — the same lever as the rebuffer cushion in
  [sizing the segment window](feed-buffer.md#sizing-the-segment-window-hls_time-hls_list_size).

!!! note "The guide can change before the picture does"
    The viewer apps play ~10 s behind the live edge. The programme guide's
    "now playing" label follows the schedule clock, so it can change up to
    ~10 s before the picture does. This is normal, not a fault.

## Channel zapping is slow, or flipping back to a channel hangs

- **How long a zap should take:** switching happens inside a warm
  (logged-in) session, so it skips panel connect and login. Expect **~1 s
  to a new channel** and **~0.3 s back to a channel you already watched**
  this session. That is far below the cold time-to-play (~10 s+ with
  login) — if a zap takes that long, you are not actually in a warm session
  (the player was torn down between switches).
- **Each channel is a separate P2P feed/DHT topic**, so the *first* zap to a
  channel can't be instant like cable — it joins that feed's topic and
  pulls its first segments. Subsequent visits are near-instant, because the
  SDK keeps opened feeds warm.
- **What a zap costs since the 2026-07-16 latency pass** (all shipped,
  covered by `test:serve` + `test:sdk`):
  1. Segment bytes stream to the player **as blocks replicate** (block-progressive
     bodies — decode starts on the first 64 KB, and every segment opens on
     a keyframe).
  2. Requests for a not-yet-replicated playlist or segment are **held and
     served on arrival** (bounded), which kills the old 404-to-2.5 s-retry
     quantization.
  3. Serving a live playlist now **replicates the whole live window in
     parallel** for the active stream (metered networks keep the newest-3
     read-ahead), so replication overlaps the player's sequential fetches.
  4. ExoPlayer starts at **~1 s buffered** instead of ~2.5 s (the
     `<AliranVideo>` `bufferConfig` default). The stall-resync/self-heal
     ladder covers the slightly higher rebuffer risk this creates.
  5. Optional [`zapPrefetch`](feed-buffer.md#zap-prefetch-keep-the-neighbors-live-edge-warm-optional)
     keeps the adjacent channels' newest segment warm (off by default — it
     costs standing bandwidth).
- **Fixed: flipping *back* to a channel used to hang.** `resolve()` opened a
  duplicate Hyperdrive on the same store namespace and deadlocked.
  `sdk/player.js serveFeed` now reuses the cached feed per `feedKey`, so
  make sure your build includes this fix (the `test:sdk` zap `news → movies
  → news` regression guards it).
- **First zap also warm (pre-warm):** the SDK opens entitled feeds' topics
  at login (the `prewarm` option; the app enables it), so even the first
  play/zap to a channel is a cache hit — verified on-device as `feed:ready`
  with no `feed:open`. See
  [P2P feed buffer & tuning](feed-buffer.md#pre-warm-make-the-first-zap-warm-too).

## App dies the moment the player seeks / switches source / closes (worklet SIGABRT)

- **Symptom:** the whole app exits. Logcat shows `Uncaught StreamError:
  Writable stream closed` and an abort inside the Bare runtime.
- **Cause:** video players routinely abort in-flight HTTP requests. Writing
  into the closed response was an unhandled stream error, and *any*
  uncaught exception in the embedded worklet aborts the entire app process.
- **Fix (shipped):** the media server tolerates client aborts on every path.
  The worklet also installs a last-resort `uncaughtException` guard that
  reports the error over IPC instead of crashing. If you embed the SDK in
  your own runtime, keep both.

## Signing a television in from a phone fails

> Nothing in this feature has been seen on a television yet. What follows
> comes from the engine's own behaviour and its test lanes.

- **The phone says it cannot find the television.** Both devices must be on
  a network that reaches the DHT — this rendezvous is derived from the code,
  not from the local network, so the two do not have to be on the same
  Wi-Fi, but each one must reach the internet. Check the code was typed
  exactly as shown: the alphabet leaves out I, L, O and U on purpose, so
  nothing on a television screen can be misread as something else.
- **The code stopped working.** A code lives about three minutes and is
  **spent by any failure** — a wrong PIN, an abandoned attempt, a peer that
  claimed it first. Show a new code on the television; do not retry the old
  one.
- **The four digits do not match.** Stop. A mismatch means something is
  between the two devices. Do **not** try again on the same network. Each
  attempt is an independent chance for a relay, not a better one.
- **The PIN was refused.** There is one attempt, by design. The exchange
  ends and the code is spent.
- **The television is stuck on "enter the digits" and the viewer's phone
  says "busy".** Somebody else claimed that code first — anyone who can see
  the screen can. It costs a new code and never costs key material. If it
  repeats, the screen is visible to somebody who should not see it.

## A television asks to sign in again after every restart

A set that a phone signed in keeps its account material sealed under a key
in the Android Keystore. It erases what it holds **only on proof** that the
material can never work again. So a set that falls back to its sign-in
screen has either been erased on purpose, or never restored.

| What happened | What the set does |
| --- | --- |
| Somebody changed the account password | **Erases.** A password reset mints a fresh keypair, so the stored keys stop matching. This is the lever that really evicts a set. |
| The account was disabled | **Erases.** |
| "Log out all devices", or the one device was revoked | **Keeps.** It takes a fresh token on its next start. |
| The device slots are full | **Keeps.** The slots free themselves, and the same keys then work. |
| The account was **deleted** | **Keeps** — an empty record looks the same as a cold start. The set falls through to its sign-in screen every time and nothing on screen says the account is gone. |
| Somebody used "Change service…", or signed the set out | **Erases**, both halves. |

**Deleting an account and creating the same username again evicts the set
rather than restoring it**: the new account has a new keypair, the stored
key fails, and *that* erases. Change the password before you delete an
account if you want the television cleaned up.

**"Cannot sign in, try again in 15 minutes" on a set nobody is touching**
is the panel's login throttle. A set retrying a credential that cannot work
spends a small budget per start, and the throttle counts per account **and**
per peer. Restarting the app clears it, because the peer half is new for
each app process. The lasting fix is the same one: change the password, or
sign the set out.

## "Play on my TV" shows no devices

- **Both devices must be signed in to the same account.** The rendezvous
  comes from the account key. Different accounts never meet.
- **The television must be the one announcing.** A controller looks up and
  never announces, on purpose, so two phones see each other but two
  televisions never meet.
- **The take-over switch may be off** on that set. It refuses `play` and
  `stop` alike.
- **The list is not the panel's device list.** A device's name and id there
  are its own claim. Use the panel's list when you need to know what is
  really enrolled.
- **Nothing happens after a viewer picks a channel.** A restricted channel
  goes through the television's own parental gate first. If the set cannot
  read the channel's record it refuses the command rather than guessing,
  and the phone sees `unavailable` — retry it; both causes are temporary.

## Casting to a Chromecast or a Google TV

- **The receiver connects and plays nothing.** The most common cause is the
  address. A phone can have several private addresses — Wi-Fi, a VPN, a
  virtual adapter — and the one the app advertised may not be the one the
  television can reach. The session carries every candidate it found; try
  the next one.
- **The picture stops when the phone leaves the network or sleeps.** That
  is inherent. While casting, the phone **is** the server: it replicates,
  decrypts and serves the stream. It has to stay awake and on the network.
- **Storage grows during a long cast.** Block reclaim is off for a channel
  a cast has pinned, because the phone's copy is the only thing that can
  still serve a receiver that fell behind. Expect about the channel bitrate
  per hour (roughly 0.9 GB/hour at 2 Mbit/s). Stopping the cast reclaims it;
  an app killed in the middle of a cast does not, and the space comes back
  when the viewer next tunes that channel.
  **On a 32-bit Android build neither remedy frees a byte.** Both are
  clears, and a clear frees nothing on the `armeabi-v7a` and `x86` ABIs
  (see [viewer bandwidth](viewer-bandwidth.md#disk)). There the space comes
  back only when the replica is deleted — when the feed rotates past its
  byte budget, when the warm cache passes its cap, or when the store is
  deleted by hand. A cast-pinned feed is never rotated, so on those devices
  a long cast is bounded by nothing until the cast ends and the feed goes
  idle.
- **The session ended by itself.** The channel's feed was purged or a
  retune failed. The server is closed and the URL is dead — start again.
- **Who else can watch.** Anyone who can reach the television can read the
  cast URL off it, so on a shared network treat a cast as that one channel
  extended to that network for the length of the session. This was measured
  on a real Google TV. Pin the session to the receiver's address where the
  app offers it, and prefer "play on my TV" on a network you do not trust:
  a handoff sends no video at all.

## Reading the app's own diagnostics (dev builds)

Every backend→UI IPC message is logged. `adb logcat -s ReactNativeJS` shows
`[backend] {"type": ...}` lines, including `feed:open` / `feed:ready`
breadcrumbs, peer-count ticks, `fallback` / `source-changed` events, and
`store:reset` (corruption recovery). Read these before guessing from the
screen.
