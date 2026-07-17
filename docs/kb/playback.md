# Playback & client runtime

Issues seen in the Android app / player SDK at runtime. For build-time problems see
[Android & React Native builds](android-build.md).

## Posters and video silently fail to load (blank tiles, no error anywhere)

- **Cause:** Android API 28+ blocks cleartext HTTP by default, and the app serves
  media and art from `http://127.0.0.1:<port>` (the embedded P2P node). Image loaders
  and ExoPlayer fail *silently*.
- **Fix:** a `network_security_config.xml` permitting cleartext **only to loopback**
  (plus the emulator host aliases for Metro in dev), referenced from the manifest.
  The app ships this — see [Client build](../client-build.md).
- **Diagnostic that isolates it:** `adb forward tcp:<x> tcp:<port>` + `curl` from the
  host returns 200 while the app shows nothing.

## Playback fails with `OPLOG_CORRUPT: Oplog file appears corrupt or out of date`

- **Cause:** the app process died mid-write (crash, force-kill) and corrupted the
  local Corestore replica cache. Without recovery this is permanent until app data is
  wiped.
- **Fix (shipped):** the engine detects corruption codes (`OPLOG_CORRUPT`,
  `INVALID_CHECKSUM`, …) on open *and* read, purges the whole store, and retries once
  (`sdk/recover.js`, exercised by `npm run test:corrupt`). The store is a **disposable
  replica cache** — everything re-replicates from peers and the in-memory session
  survives, so no re-login is needed.
- **Manual fallback (always safe):** clear the app's data/storage — same reasoning.

## Login spins forever on "not connected to panel" / "Cannot reach the service"

In likelihood order:

1. **The panel is wedged or down.** Verify from another machine with a small
   hyperswarm read of `catalog/*` *before* blaming the client. A wedged panel can
   look alive in the process list while answering nothing — restart it (see
   [Operating the panel & broadcaster](operator.md)).
2. **First DHT dial after a fresh install legitimately takes 30–90 s.** The login
   screen retries for about a minute, then gives up — pressing Sign in again restarts
   the retry loop.
3. **Stale swarm state on the device** after the panel restarted or the app's data
   was cleared mid-session: force-stop and relaunch the app (retrying inside the app
   is not enough — the embedded node needs a fresh swarm).
4. Device network says connected but isn't validated
   (`adb shell dumpsys connectivity | grep -i validated`).

## Player shows black + spinner right after opening a channel

- **Normal for a few seconds:** the live edge is replicating from peers. The media
  server *holds* a request for a not-yet-replicated playlist/segment (bounded at 6 s,
  under ExoPlayer's 8 s read timeout) and serves it the moment it lands — so the
  usual cost is the actual replication time, not a 404 → 2.5 s retry-remount cycle.
  Only a path still missing after the bound 404s, and the player's 2.5 s auto-retry
  remains as the fallback ladder behind that.
- **Persistent spinner with `0 peers`:** no seeder is *found* — the broadcaster is
  down, its ffmpeg ingest died while the process kept "seeding" a frozen playlist, or
  the device holds a **stale DHT record** (the broadcaster restarted since the last
  lookup: its feed swarms are ephemeral identities, and hyperswarm re-queries a topic
  only every ~10 min — the same failure PanelLink self-heals on the broadcaster side).
- **Fix (shipped) — tune self-heal:** while a tune is incomplete (the playlist is not
  **advancing** — merely existing is not enough, see the wedge below) the engine forces
  fresh DHT lookups on a 5 s → 60 s backoff; at 30 s it evicts the cached feed open and
  re-opens fresh once (`feed:retune` breadcrumb); at 60 s it **destroys the swarm
  connections serving the feed** and dials fresh (`feed:reconnect`); if that also
  expires it surfaces a friendly `tune timeout` error instead of spinning forever —
  zap to the channel again to retry (worst case ≤ 90 s to the error at defaults).
  Pre-fix builds could sit on the spinner **indefinitely** (S22, 2026-07-16: a zap
  stuck at "90 %" for 10+ min against a healthy VPS; only an app restart — a fresh
  swarm — cleared it, because the cached dead open poisoned every retry). The
  `test:sdk` tune section guards the whole cycle.
- **Persistent spinner with peers connected (`1 peer` showing):** the **wedged
  connection** class — a network flap (Wi-Fi degrade, radio cycle) can leave the
  hyperswarm/UDX connection alive at transport level while replication over it moves
  **zero bytes**. Peer counts look healthy on BOTH ends, no error fires, and because
  hyperswarm keeps one connection per peer across all topics, a retune faithfully
  reuses the same dead pipe — with prewarm, one wedged connection to the broadcaster
  starves **every** channel at once (S22, 2026-07-16: 15+ min stuck at "90 %" with
  "P2P — 1 peer" while a fresh client played the same feed in 10 s). **Fix (shipped):**
  the tune watchdog requires the playlist to *advance* (a stale pre-flap playlist in
  the replica no longer counts as tuned) and tears the wedged connections down on its
  second expiry (`feed:reconnect`) so the swarm dials fresh; `test:sdk`'s
  wedged-connection section reproduces the exact signature with a paused socket.
- With the **hybrid CDN↔P2P** policy configured, this case instead triggers a
  `fallback` to the CDN URL (and auto-returns later) — see the
  [player SDK README](https://github.com/AbueloSimpson/aliran/tree/main/sdk).

## Video freezes while everything looks healthy (clock ticks, peers connected)

- **Symptom:** the picture stops dead mid-watch; peer count and worklet heartbeats
  stay healthy, the UI stays alive, no error fires. Zapping away and back fixes it.
- **Cause:** the HLS live window is short (8×2 s = 16 s on the reference deploy). A
  network blip longer than the window slides it past ExoPlayer's position, and
  react-native-video raises **no error event** for that — the surface just freezes.
- **Fix (shipped):** `<AliranVideo>` watches the playhead; once a mount has played and
  the position sits still for 12 s (`stallTimeoutMs`) while not paused, it remounts
  onto a fresh playlist load at the live edge (the same thing the manual zap did) and
  fires `onStall` plus an `onTune` `start` — the app's tuning pill restarts and stays
  until the resync mount's first real playback (`onTune` `playing`).
- **If the resync remount itself never plays** within another window, the freeze is
  not a slid live window but a **wedged connection** (see the tune section above): the
  stall ladder escalates to `backend.reconnect()`, which tears down the engine's
  connections serving the feed and dials fresh; the engine's re-armed tune watchdog
  then drives the outcome — playback resumes, or a friendly error instead of a
  silently frozen frame.
- **Widen the margin (operators):** deepening the live window (`HLS_LIST_SIZE`
  12–16) gives clients more room to recover from blips — the same lever as the
  rebuffer cushion in [sizing the segment window](feed-buffer.md#sizing-the-segment-window-hls_time--hls_list_size).

## Channel zapping is slow, or flipping back to a channel hangs

- **How long a zap should take:** switching happens inside a warm (logged-in) session,
  so it skips panel connect + login — expect **~1 s to a new channel** and **~0.3 s
  back to a channel you already watched** this session. That's far below the cold
  time-to-play (~10 s+ with login); if a zap takes that long, you're not actually in a
  warm session (the player was torn down between switches).
- **Each channel is a separate P2P feed/DHT topic,** so the *first* zap to a channel
  can't be instant like cable — it joins that feed's topic and pulls its first
  segments. Subsequent visits are near-instant because the SDK keeps opened feeds warm.
- **What a zap costs since the 2026-07-16 latency pass** (all shipped, covered by
  `test:serve` + `test:sdk`):
  1. Segment bytes stream to the player **as blocks replicate** (block-progressive
     bodies — decode starts on the first 64 KB, every segment opens on a keyframe);
  2. requests for a not-yet-replicated playlist/segment are **held and served on
     arrival** (bounded), killing the old 404 → 2.5 s retry quantization;
  3. serving a playlist **read-aheads its newest 3 segments in parallel**, so
     replication overlaps the player's sequential fetches;
  4. ExoPlayer starts at **~1 s buffered** instead of ~2.5 s (`<AliranVideo>`
     `bufferConfig` defaults — the stall-resync/self-heal ladder covers the slightly
     higher rebuffer risk);
  5. optional [`zapPrefetch`](feed-buffer.md#zap-prefetch-keep-the-neighbors-live-edge-warm-optional)
     keeps the adjacent channels' newest segment warm (off by default — standing
     bandwidth).
- **Fixed: flipping *back* to a channel used to hang.** `resolve()` opened a duplicate
  Hyperdrive on the same store namespace and deadlocked. `sdk/player.js serveFeed` now
  reuses the cached feed per `feedKey`; update to a build that includes it (the
  `test:sdk` zap `news → movies → news` regression guards it).
- **First zap also warm (pre-warm):** the SDK opens entitled feeds' topics at login (the
  `prewarm` option; the app enables it), so even the first play/zap to a channel is a
  cache hit — verified on-device as `feed:ready` with no `feed:open`. See
  [P2P feed buffer & tuning](feed-buffer.md#pre-warm-make-the-first-zap-warm-too).

## App dies the moment the player seeks / switches source / closes (worklet SIGABRT)

- **Symptom:** the whole app exits; logcat shows
  `Uncaught StreamError: Writable stream closed` and an abort inside the Bare runtime.
- **Cause:** video players routinely abort in-flight HTTP requests. Writing into the
  closed response was an unhandled stream error — and *any* uncaught exception in the
  embedded worklet aborts the entire app process.
- **Fix (shipped):** the media server tolerates client aborts on every path, and the
  worklet installs a last-resort `uncaughtException` guard that reports the error
  over IPC instead of crashing. If you embed the SDK in your own runtime, keep both.

## Reading the app's own diagnostics (dev builds)

Every backend→UI IPC message is logged: `adb logcat -s ReactNativeJS` shows
`[backend] {"type": ...}` lines, including `feed:open` / `feed:ready` breadcrumbs,
peer-count ticks, `fallback` / `source-changed` events, and `store:reset` (corruption
recovery). Read these before guessing from the screen.
