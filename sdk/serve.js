// Shared localhost media-serving core for Hyperdrive replicas (Node + Bare).
//
// One implementation behind every Aliran media server: the SDK engine's request
// handler (sdk/player.js — also bundled into the Android Bare worklet) and the
// desktop tools' driveHandler (tools/lib/serve-drive.js) both delegate here.
// Runtime-agnostic on purpose: no node:/bare- imports — the handler only touches
// the (req, res) pair the host's http module hands it.
//
// What it does beyond a static file server (all zap-latency levers, 2026-07-16):
//
//   PROGRESSIVE BODIES — segment bytes stream to the player AS BLOCKS REPLICATE
//   (hyperdrive createReadStream resolves block-by-block), so ExoPlayer starts
//   parsing the first 64 KB block while the tail is still in flight. Segments
//   start on a keyframe (the broadcaster forces force_key_frames on hls.time
//   boundaries), so decode can begin from the first bytes. Verified by
//   tools/serve-progressive-test.mjs: first byte lands while the blob is
//   provably incomplete.
//
//   AVAILABILITY WAIT — a media path that is not in the replica YET (cold zap:
//   the playlist replicates for a beat after resolve(); every zap: the mirror
//   puts index.m3u8 BEFORE the segment it references within a tick) used to 404
//   and cost the player a hard error + its 2.5 s retry remount. Instead, poll the
//   drive entry (bounded by waitMs) and serve the moment it lands — a ~100 ms
//   availability gap stays a ~100 ms response, not a 2.5 s quantum. A path still
//   missing after waitMs 404s exactly as before (the player retry ladder is the
//   fallback, not the fast path). Kept short for the HUMAN staring at a black frame,
//   not for a protocol ceiling — the "ExoPlayer 8 s read timeout" this file cites in
//   several places does not exist on the shipped stack (measured; see DEFAULTS).
//
//   REQUEST PARKING — resolveTarget is AWAITED, so a host that cannot answer "which
//   drive serves this path" yet can return a promise and hold the request instead of
//   handing back null. A null target is an INSTANT 404 and a 404 on a media path costs
//   the viewer a hard player error and a ~5.5 s black remount; a request that parks for
//   the ~1 s a feed rotation takes and then succeeds is invisible to the player. Paired
//   with handler.inflight/handler.whenDrained so the host can drain in-flight reads
//   before it purges the drive underneath them. See createDriveHandler.
//
//   LIVE-EDGE READ-AHEAD — serving a playlist fire-and-forgets a parallel blob
//   download of its newest segments, so replication overlaps the player's
//   strictly sequential fetch pattern instead of being demand-paged per segment
//   (a cold zap otherwise pays per-block round trips segment by segment).
//   Superseded downloads (segments that rotated out of the newest set) are
//   destroyed so a cleared blob can't strand a range forever. For LIVE playlists
//   the host can widen the newest-N to the WHOLE window (liveReadAhead, a number
//   or a per-update function): every segment between the playhead and the live
//   edge is then on-device the moment it exists, so losing the upstream peer
//   cannot take away media the viewer is about to play — churn headroom equals
//   the player's live offset instead of its transient buffer. Steady-state
//   bandwidth is unchanged (same 1× bitrate, fetched earlier); the burst cost is
//   one window per zap, which is why the SDK narrows it back to the default on
//   expensive (metered) networks. VOD keeps the small fixed read-ahead — a
//   viewer seeks VOD arbitrarily, so eager whole-file replication is waste.
//
//   EXPIRED-BLOCK RECLAIM (opt-in `reclaim`) — a live replica frees the blob
//   blocks below the served playlist's window, so a viewer's disk holds ~one
//   live window per feed instead of the whole watch history. The cleared blocks
//   are already unfetchable swarm-wide (the broadcaster cleared them at
//   rotation). VOD is never reclaimed. See the Reclaim class. ⚠ clear() frees
//   BYTES only where the storage layer can hole-punch the blocks file; on 32-bit
//   Android ABIs the addon that does the punching is absent and the call is a
//   SILENT no-op, so the pass runs, reports success and frees nothing. That is
//   why the same pass also MEASURES the replica (measureDriveBytes) against
//   reclaimBudgetBytes and calls onOverBudget — on those devices a whole-replica
//   rotation, which only the host can perform, is the only lever left. The
//   budget only exists at all where a MEASURED capability probe (probeHolePunch)
//   proved this store's filesystem cannot punch; where it can, the blob verdict is
//   hard-disabled for the life of the handler and never fires. The METADATA core is
//   the exception on both counts: a punch cannot free a Hyperbee and nothing may
//   clear one in place, so a second, punch-independent flat budget
//   (metaBudgetBytes) rides the same measurement and fires the same callback with
//   trigger: 'meta'. See Reclaim and the paragraph at DEFAULTS.
//
//   STALLED-READ ABORT — the feed is an EPHEMERAL rolling buffer: the broadcaster
//   frees the previous /index.m3u8 blob the instant it writes the next one
//   (broadcaster/src/hls.js mirrorDirToDrive), so each playlist version's blob is
//   fetchable for only ~one segment. A replica that lags the live edge by a
//   rotation resolves the path to a version whose blob has ALREADY been reclaimed
//   everywhere — createReadStream then waits FOREVER for blocks no peer holds. The
//   response never flushes headers (Node holds them until the first body byte) and
//   never ends: a client with no read timeout (or the acceptance harness) hangs
//   indefinitely, and the tune watchdog can't see it (the METADATA replicates fine,
//   so its playlist signature keeps advancing — proven wedge, 2026-07-17 VPS
//   acceptance). A media read that yields NO bytes for `readIdleMs` is therefore
//   aborted, so the client re-requests and re-resolves to the current live version
//   whose blob still exists. Only a fully stalled read trips it — progressive reads
//   reset the idle clock on every block, so a slow-but-advancing fetch is untouched.
//   The feed is not the only rolling blob in the drive: /thumb.jpg is superseded and
//   cleared on every refresh too, so an ancillary target can opt in with `idle: true`
//   without taking on media's availability wait or read-ahead (see resolveTarget).
//
// Every wait is bounded and every stream tolerates client aborts — the player
// aborts in-flight requests routinely, and an unhandled stream error SIGABRTs
// the Bare worklet (the whole app process).

const TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json'
}

export function contentType (p) {
  const i = p.lastIndexOf('.')
  return (i >= 0 && TYPES[p.slice(i).toLowerCase()]) || 'application/octet-stream'
}

// The rolling live thumbnail, at ONE fixed path inside every channel's own feed drive
// (the broadcaster writes it there — see broadcaster/src/hls.js THUMB_FILENAME, which
// tools/e2e-thumbs-test.mjs asserts agrees with this literal, so a rename fails a lane
// instead of silently 404ing every grid cell in production).
//
// It lives HERE, in the shared serving core, rather than in the SDK engine, because both
// halves of this file need it and they need the SAME one: the /feedthumb route serves it,
// and the Reclaim sweep below has to know NOT to free it. Two literals that drifted apart
// would read as "thumbnails are just slow" and be near-impossible to attribute.
export const THUMB_PATH = '/thumb.jpg'

// CORS headers for the LAN-scoped cast server (sdk/player.js startCast). OPT-IN — the
// loopback server leaves `cors` unset, so not one CORS header appears on any response of
// its own. That is the whole of what this option changes. (It is NOT the whole of what the
// cast work changed on loopback: the method gate below is shared and does apply there. The
// precise claim lives with it — "loopback byte-for-byte unchanged" is the overstated form.)
//
// Measured, not assumed (WP0 cast trial against a TCL Terraza, CrKey/1.56.500000
// DeviceType/AndroidTV, on the stock Default Media Receiver CC1AD845): an http:// LAN URL
// plays with no mixed-content block, but WITHOUT Access-Control-Allow-Origin the receiver
// fetched the playlist four times, fetched ZERO segments and went IDLE/ERROR. The receiver
// page's origin is https://www.gstatic.com, so every media fetch is cross-origin: ACAO is
// not a nicety here, it is the difference between playback and a silent failure.
//
// That firmware sent NO OPTIONS preflight and used NO Range header. Both are answered
// anyway. Range is not a CORS-safelisted request header, so any receiver that does seek
// WILL preflight — and `Access-Control-Allow-Headers: Range` is what makes that preflight
// pass.
//
// ⚠ Allow-Methods is NOT what saves it. An earlier version of this comment (and the
// d9332bb commit message) claimed a preflight answered without Allow-Methods "fails
// closed"; that is spec-wrong. Fetch's CORS-preflight check tests the method only when
// it is not CORS-safelisted, and GET/HEAD/POST are — so a preflight with no Allow-Methods
// at all still succeeds for the GET that follows. The header STAYS, for two honest
// reasons: it is the truthful advertisement of what this server serves (the handler
// really does refuse every other method with a 405, see below), and it is the only thing
// that would admit a non-safelisted method if a receiver stack ever used one.
//
// Expose-Headers is what lets a receiver read Content-Range/Content-Length off a 206.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type'
}
const CORS_PREFLIGHT = {
  ...CORS_HEADERS,
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400'
}
const NO_CORS = {}

// Defaults: waitMs under ExoPlayer's 8 s read timeout; pollMs ≈ one segment write;
// readAhead covers the 2–3 segments a player fetches before first frame — hosts widen
// LIVE playlists to the whole window via liveReadAhead (the player passes Infinity,
// narrowed back to 3 on metered networks; see the LIVE-EDGE READ-AHEAD note above).
// readIdleMs (stalled-read abort) sits under ExoPlayer's 8 s read timeout too so OUR
// clean abort drives the retry — a read that yields zero bytes for this long is stuck
// on a blob the broadcaster reclaimed, not merely slow. reclaimIntervalMs throttles
// the per-drive expired-block reclaim (the `reclaim` opt — see Reclaim below); the
// live window rotates every few seconds, so once per 30 s is plenty.
//
// ⚠⚠ THE "ExoPlayer 8 s READ TIMEOUT" CITED ABOVE (and in several other comments in this
// file) DOES NOT APPLY ON THE SHIPPED ANDROID STACK. 8 s is media3's DefaultHttpDataSource
// default — and we never construct one. react-native-video 6.19.2 builds its data source
// from OkHttp instead: DataSourceUtil.kt takes React Native's SHARED client
// (OkHttpClientProvider.getOkHttpClient()) and wraps it in OkHttpDataSource.Factory, and
// RN's provider sets connect/read/write to 0 ms under a literal "No timeouts by default"
// (OkHttpClientProvider.kt). So the player has NO client-side read timeout on media fetches
// at all. Read every "kept under the 8 s timeout" remark here as "kept short because a
// viewer is staring at a black frame", never as a hard ceiling something else enforces.
// The numbers stay where they are — they are still the right latency budget for a human —
// but the absence of that ceiling is precisely what makes PARKING safe: an awaited
// resolveTarget that holds a request open across a feed rotation is not racing a client
// timeout, whereas the instant 404 it replaces cost a hard error and a ~5.5 s remount.
//
// reclaimBudgetBytes (512 MiB) is the per-replica ON-DISK budget the reclaim pass measures
// itself against after every clear — see measureDriveBytes and Reclaim. It is NOT a second
// way to free bytes: clear() is still the only thing in this file that frees anything. It
// exists because on 32-bit Android ABIs clear() frees NOTHING (the hole-punch addon is
// excluded from those .so sets — full story in the Reclaim header) and the replica then
// grows at the full ≈0.9 GB/hour for the whole session with no in-place remedy. The only
// remaining lever is throwing the replica away and re-opening it, which belongs to whoever
// owns the feed cache, not to a request handler — so the handler measures and calls
// onOverBudget(drive, info), and the host decides. 512 MiB ≈ 35 min of a 2 Mbps feed:
// close enough that a device with no-op clears rotates a few times an hour instead of
// filling the disk.
//
// ⚠⚠ AN EARLIER VERSION OF THIS COMMENT ALSO CLAIMED 512 MiB IS "far enough out that a
// WORKING platform never reaches it and the callback is dead code". THAT WAS A BET, AND IT
// LOSES. The budget is a flat number; the live window it is being compared against is
// OPERATOR-SETTABLE — hls_time 1..30 s and hls_list_size 2..64 segments (bounds enforced in
// broadcaster/src/config.js chkInt('HLS_TIME'/'HLS_LIST_SIZE') and again per channel in
// broadcaster/src/channel.js), i.e. a live window of up to 64 × 30 = 1920 SECONDS. At that
// window and 2 Mbit/s, ONE healthy live window is 458 MiB — 90% of the budget — and any
// channel over ≈2.24 Mbit/s (512 MiB × 8 ÷ 1920 s) is over it OUTRIGHT, on hardware with
// nothing whatsoever wrong with it. Worse, Reclaim._last is keyed on the drive object and a
// rotation hands back a NEW drive, so the throttle does not damp it: such a channel would
// rotate once per reclaim tick, forever — a permanent rebuffer loop on a healthy arm64
// phone. "Inert on 64-bit" is therefore NOT a property of this number and must never be
// argued from it again.
//
// SO THIS NUMBER IS A FLOOR, NOT THE BUDGET. What a replica is actually judged against is
//
//     max(reclaimBudgetBytes, RECLAIM_WINDOW_BUDGET_K × the OBSERVED live window)
//
// where the observed window is the summed blob byteLength of every segment the served
// playlist still lists — a number this file already resolves, once per throttled pass, on
// its way to the reclaim floor (reclaimBelowWindow's onWindowBytes sink), extrapolated back
// to the full listing when only part of it resolved and never allowed to FALL on a later pass
// (Reclaim._observeWindow). That last clause is not tidiness: the sink drops a listed segment
// whose entry has not reached this replica, which is routine at the live edge, and an
// under-stated window would collapse this ceiling back onto the flat floor — the one
// direction it must not be able to move in. A healthy replica
// holds ~one window, so it cannot be over budget BY CONSTRUCTION at any hls_time ×
// hls_list_size the broadcaster permits and at any bitrate. That is true on BOTH sides of
// the capability probe, which is what demotes probeHolePunch from a single point of failure
// to defence in depth: if the probe answers wrong, or cannot answer at all, the arithmetic
// still does not fire on a healthy device. A replica that is genuinely LEAKING (nothing
// freed, ~1× bitrate for the session) still grows through k windows and still trips.
// RECLAIM_MIN_ROTATE_MS is the second backstop — a floor on how often this handler may ask
// for a rotation at all, whatever the arithmetic says.
//
// probeHolePunch remains, and remains worth having: where the punch is PROVED to work the
// budget is switched off outright, so the measurement, the callback and any argument about
// window sizes stop existing for that device.
//
// ⚠⚠ EXCEPT FOR THE METADATA CORE, WHICH THE PUNCH CANNOT TOUCH AND THE LATCH THEREFORE
// MUST NOT COVER — that is what metaBudgetBytes (64 MiB) is. A followed live feed's
// Hyperbee appends ~1.5 put/del transactions per second (segment put + expired del +
// playlist put, every hls_time), nothing in this file ever clears the db core (interior
// nodes referenced by CURRENT keys live in old blocks, so clearing it in place breaks
// drive.entry() — the one reset is the host's purge + re-open), and hole punching is
// about the BLOB core: a device that punches perfectly still accumulates metadata for
// the whole session. Measured on an always-on TV with a working punch (10 h soak,
// 2026-08-15): ~2.7 MB/h on the watched channel's db core, ~1.1-1.2 MB/h per warm idle
// feed, +12-17 MB/h store-wide with the blob bound holding a FLAT ~128 MB — i.e. the
// punch-capable path is where this bites, precisely because nothing else there rotates.
// So the meta budget rides the SAME throttled measurement and the SAME onOverBudget, with
// info.trigger = 'meta', and is gated on NEITHER the punch latch NOR the pass having run
// (a clear pass, completed or failed, never touches the metadata core, so the measurement
// is trustworthy on both sides of it). It is a FLAT number, never window-scaled: a fresh
// replica's metadata starts near zero and only ever appends, so there is no healthy floor
// that scales with operator settings the way the blob window does — 64 MiB is ~24 h of
// continuous same-channel watching at the measured rate, and any natural teardown (app
// restart, zap away and back, catalog re-key) resets it to zero for free.
const DEFAULTS = { waitMs: 6000, pollMs: 150, readAhead: 3, readIdleMs: 6000, reclaimIntervalMs: 30000, reclaimBudgetBytes: 512 * 1024 * 1024, metaBudgetBytes: 64 * 1024 * 1024 }

// The most playlist text the after-serve trigger will ever hold or fetch — the 200 branch's
// stream mirror and the ranged branch's whole-playlist re-read both cap here. A real
// playlist is a few KB; this is not a tuning knob, it is the guard that keeps a mis-typed
// huge file served as .m3u8 from ballooning the worklet heap. ONE constant on purpose:
// two inline literals here would drift exactly the way the THUMB_PATH note above warns.
const PLAYLIST_TEXT_CAP = 262144

// Parse segment/media URIs out of an HLS playlist body (everything that isn't a
// tag or blank), normalized to absolute drive paths. Tiny by design — enough for
// the read-ahead's "newest N segments", not a general M3U8 parser.
export function playlistUris (text) {
  const uris = []
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) continue // absolute URL — not ours to prefetch
    uris.push(line.startsWith('/') ? line : '/' + line)
  }
  return uris
}

// Per-drive read-ahead state: path -> active hypercore download range. Newest-set
// eviction destroys superseded ranges so a segment that rotated out (its blocks
// cleared at the broadcaster) can never strand a download waiting forever.
class ReadAhead {
  constructor (limit, liveLimit) {
    this._limit = limit
    // Live playlists may use a wider (or dynamic) limit than VOD — a number or a
    // function re-evaluated on every playlist serve, so the host can narrow it at
    // runtime (e.g. when the network turns metered) without rebuilding the handler.
    this._liveLimit = liveLimit == null ? limit : liveLimit
    this._drives = new WeakMap() // drive -> Map(path -> range)
  }

  // Fire-and-forget: prefetch the segments the player will read NEXT off this
  // playlist body — the newest (tail) for a live playlist, which is consumed at its
  // moving edge; the FIRST ones for a finished VOD playlist (#EXT-X-ENDLIST, S8a),
  // which is played top-down from the start (prefetching its tail would warm the end
  // credits). Never throws, never blocks the event loop — all awaits are backgrounded.
  update (drive, text) {
    const uris = playlistUris(text)
    const live = !/#EXT-X-ENDLIST/m.test(String(text))
    // Clamped to 32: a 64-segment window must not fire 64 concurrent download chains in the Bare worklet.
    const liveLimit = Math.min(typeof this._liveLimit === 'function' ? this._liveLimit() : this._liveLimit, 32)
    // slice(-N) takes the newest N (Infinity clamps to the 32 newest).
    const newest = live ? uris.slice(-liveLimit) : uris.slice(0, this._limit)
    let ranges = this._drives.get(drive)
    if (!ranges) { ranges = new Map(); this._drives.set(drive, ranges) }
    for (const [path, range] of ranges) {
      if (newest.includes(path)) continue
      if (range) { try { range.destroy() } catch {} }
      ranges.delete(path)
    }
    for (const path of newest) {
      if (ranges.has(path)) continue
      ranges.set(path, null) // reserve synchronously — updates can race
      this._download(drive, path).then((range) => {
        if (!ranges.has(path)) { // evicted while the entry resolved
          if (range) { try { range.destroy() } catch {} }
          return
        }
        if (range) ranges.set(path, range)
        else ranges.delete(path)
      }, () => ranges.delete(path))
    }
  }

  async _download (drive, path) {
    const entry = await drive.entry(path)
    const blob = entry && entry.value && entry.value.blob
    if (!blob || !(blob.blockLength > 0)) return null
    const blobs = await drive.getBlobs()
    // Parallel range download (not linear) — the point is to overlap block
    // round-trips instead of paying them one by one on the read path.
    return blobs.core.download({ start: blob.blockOffset, end: blob.blockOffset + blob.blockLength })
  }
}

// EVERY BLOCKING DRIVE READ ON THE RECLAIM PATH IS RACED AGAINST THIS BOUND.
//
// Nothing on this path is on the critical serve path, which used to be the argument for
// awaiting these reads plainly. It is the wrong argument: a hyperdrive read that needs a
// block no peer holds does not fail, it NEVER SETTLES, and a try/catch cannot catch a
// promise that never rejects. The reclaim path is awaited in a sequential per-drive loop by
// the host's idle sweep (sdk/player.js), so ONE off-air cached feed with a missing block
// wedges that loop — and with it the store cap — for the rest of the session. Same failure
// the serve path aborts out of (see the STALLED-READ ABORT note in the header) and the same
// treatment: waitEntry below has raced drive.entry() against a timer for exactly this
// reason since it was written; these reads simply never got the same care.
//
// 2 s, not the idle sweep's 5 s: these are METADATA reads, and a metadata block is either
// already local (sub-millisecond) or is not going to arrive on any timescale worth blocking
// a sweep for. A pass that times out is retried on the next reclaimIntervalMs tick anyway.
const RECLAIM_READ_MS = 2000

// Returned by bounded() when the read did not land in time — or REJECTED, which is folded
// into the same answer because every caller on this path treats "no answer" the same way.
// It is a distinct object rather than null so a caller can tell it apart from a read that
// legitimately resolved to null (a path that is genuinely not in the drive, or a stat that
// really has no bytes to report). That distinction is load-bearing in probeDriveBytes,
// where null means "this PLATFORM cannot report bytes used" and permanently latches the
// budget off — a timeout must never be mistaken for it.
const TIMED_OUT = { timedOut: true }

// Race a promise that has no bound of its own against a timer. Never rejects.
//
// `guarded` FOLDS A REJECTION INTO A VALUE — that is its whole job, and it is NOT about
// unhandled rejections. Every caller on this path treats "no answer" identically whether the
// read timed out or threw, and without the rejection arm a read that rejects BEFORE the timer
// fires propagates straight out of this function into callers that are awaiting a value and
// have no catch of their own (reclaimBelowWindow's loop, probeDriveBytes, thumbBlockRange).
//
// ⚠ AN EARLIER VERSION OF THIS COMMENT GAVE A DIFFERENT AND FALSE REASON: that the loser of
// the race is "orphaned", so its later rejection would go unhandled and SIGABRT the Bare
// worklet. Promise.race attaches its OWN resolve/reject to EVERY element it is handed
// (PerformPromiseRace calls nextPromise.then(resolve, reject) once per element), so nothing in
// a race is ever orphaned and a loser that rejects afterwards is already handled. MEASURED in
// this tree rather than reasoned about: this exact shape, with the wrapped promise rejecting
// 50 ms after the timer won, raises no unhandledRejection, while a genuinely unattached
// promise rejecting beside it raises one immediately. sdk/player.js _measureFeed records the
// same rule from the same experiment. The SIGABRT rule itself is real and still load-bearing
// where a promise really IS unattached — see the queued truncate in probeHolePunch, which
// nothing races and which therefore does need its own .catch — it simply does not apply here.
//
// ⚠ AND THIS TIMER IS DELIBERATELY *NOT* unref'd, unlike InFlight.whenDrained's. The
// difference is which side the promise fails to. When the wrapped read never settles, this
// TIMER IS THE ONLY THING that can settle the returned promise — unref it and a host whose
// loop is otherwise empty simply never resolves the await, which is the exact wedge this
// function exists to prevent (observed: Node reports "unsettled top-level await" and exits).
// whenDrained's timer can be unref'd because a drain wait is an optimisation for a rotation
// that happens either way. A few seconds of holding the loop open is the correct price here,
// and it is only ever paid on a read that has already gone wrong.
function bounded (promise, ms, onTimeout = TIMED_OUT) {
  let timer = null
  const guarded = Promise.resolve(promise).then((v) => v, () => onTimeout)
  return Promise.race([
    guarded,
    new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms) })
  ]).then((v) => { clearTimeout(timer); return v })
}

// EXPIRED-BLOCK RECLAIM for a LIVE feed replica (the `reclaim` opt). The broadcaster
// clears a segment's blob blocks the moment it rotates out of the playlist
// (broadcaster/src/hls.js clearBlob/reclaimExpiredBlobs), so every block below the
// current window is already unfetchable swarm-wide — but the VIEWER's replica keeps
// its local copies forever: watching accumulates ~1× bitrate of dead blocks
// (≈0.9 GB/hour at 2 Mbps) with nothing ever freeing them. Bound it: when a live
// playlist serves, take the MINIMUM blob blockOffset still referenced by the
// window and `blobs.core.clear(0, min)` — a local hole-punch, exactly the
// broadcaster's own reclaim shape. The merkle tree stays valid and replication of
// the still-live window is untouched; disk settles at ~one live window per feed.
// VOD (#EXT-X-ENDLIST) is NEVER reclaimed — a viewer seeks VOD arbitrarily, so its
// replica is a cache, not a rolling buffer. Throttled per drive (WeakMap, like
// ReadAhead's _drives) and fire-and-forget: reclaim can never throw into a serve.
//
// ⚠⚠ "A LOCAL HOLE-PUNCH" IS A PLATFORM CAPABILITY, NOT A GUARANTEE, AND THE SENTENCE
// "disk settles at ~one live window per feed" IS FALSE ON PART OF THE SHIPPED FLEET.
// clear() drops the bitfield and then asks the storage layer to punch that byte range out
// of the blocks file. random-access-file 4.1.2 does the punching through the OPTIONAL
// native addon fs-native-extensions, and when the addon is missing its _del is
//
//     if (!fsext) return req.callback(null)          random-access-file/index.js:175
//
// — a SILENT SUCCESS that frees ZERO bytes. On 32-bit Android ABIs (armeabi-v7a, x86) the
// addon is deliberately absent: client/android/app/build.gradle EXCLUDES its .so because
// its F_OFD_SETLK path wants struct flock64 and kills the Bare worklet on a 32-bit ABI at
// corestore's first storage open (that exclusion is load-bearing — read the comment there
// before touching it). So on those devices the entire pass below runs, returns cleanly,
// reports nothing wrong, and the replica keeps growing at the full ≈0.9 GB/hour for the
// whole session. Nothing on the clear path can notice: the call succeeded and the bitfield
// really did drop. 64-bit ABIs have the addon and behave exactly as described above.
//
// That is what the BYTE BUDGET is for. After each throttled clear pass this class MEASURES
// the replica's real on-disk size (measureDriveBytes — ALLOCATED bytes off stat(), so a
// punch that did nothing keeps being counted, and the measurement reports the very failure
// it exists to catch without knowing anything about the platform) and, when it exceeds
// cfg.reclaimBudgetBytes, calls the host's onOverBudget(drive, info). It frees nothing
// itself and it is NOT a fallback reclaim — there is no second way to free those bytes IN
// PLACE. The only remaining lever is discarding the replica and re-opening it (purge + a
// fresh open, i.e. a feed ROTATION), which belongs to whoever owns the feed cache, not to
// a request handler. Measurement rides the SAME per-drive throttle as the clear — no
// second timer, so a 300-channel grid cannot turn this into a stat() storm.
//
// ⚠⚠ AND THE BUDGET IS SCALED TO THE OBSERVED LIVE WINDOW, NOT FLAT. The first version of
// this class compared a flat 512 MiB against a window that is OPERATOR-SETTABLE up to
// 64 × 30 s = 1920 s, where ONE healthy window at 2 Mbit/s is 458 MiB and anything over
// ≈2.24 Mbit/s is over budget outright (the arithmetic is spelled out at DEFAULTS). _last is
// keyed on the drive object and a rotation produces a NEW drive, so nothing damped the
// retrigger: a healthy arm64 phone on such a channel would have rotated its replica once per
// reclaim tick for as long as it watched — a permanent rebuffer loop caused entirely by this
// file. The fix is the arithmetic, in _effectiveBudget: the ceiling is
// max(configured, RECLAIM_WINDOW_BUDGET_K × the window this very pass just measured), so a
// replica holding one live window is under budget by construction and a replica holding k
// windows of never-freed blocks is not. RECLAIM_MIN_ROTATE_MS floors the retrigger rate on
// top of that.
//
// ⚠ AND *THEN* IT IS GATED ON A MEASURED CAPABILITY PROBE. Before the budget may fire even
// once, probeHolePunch answers the question the clear path cannot — CAN this store's
// filesystem punch a hole? — by punching one and measuring; and, since the size_t addon
// class was observed in the wild, it refuses to certify the CAN side until a > 4 GiB punch
// has landed too (runWideProbe). If it can, _budgetOff latches
// and onOverBudget is dead for the life of the handler, exactly the way _unmeasurable
// latches. The probe is deliberately platform-AGNOSTIC: it catches exFAT, FAT32 and network
// mounts, where the punch fails for reasons that have nothing to do with the 32-bit ABI
// story above, and it needs no ABI detection to do it. It is DEFENCE IN DEPTH now, not the
// load-bearing member it was when the budget was flat — a probe that answers wrong, or
// never answers, can no longer by itself rotate a healthy replica.

// THE WINDOW MULTIPLIER — see _effectiveBudget and the DEFAULTS note. k = 3 because a
// HEALTHY replica, measured at the moment this class measures it, legitimately holds:
//   1×  the live window itself, every segment the served playlist still lists;
//   +   up to one reclaimIntervalMs of segments that have already rotated out but whose
//       blocks this pass has not freed yet, plus /thumb.jpg, which reclaim deliberately
//       punches AROUND and never frees;
//   +   the METADATA core, which nothing in this file ever clears and which grows for the
//       whole session at ~one Hyperbee entry per segment written;
//   +   whatever the platform's allocation accounting rounds up (measured on NTFS: a
//       4,096-byte bitfield reporting 65,536 — see measureDriveBytes).
// One window for the truth and two for everything above is honest slack, not a guess about
// hardware. It costs nothing in detection power: a replica that is really leaking frees
// NOTHING at all and grows at ~1× bitrate, so it crosses k windows within k window-lengths
// of watching and still trips.
const RECLAIM_WINDOW_BUDGET_K = 3

// FLOOR ON HOW OFTEN THIS HANDLER MAY ASK FOR A ROTATION, whatever the arithmetic says. A
// rotation discards the replica and re-downloads a whole live window — with
// liveReadAhead: Infinity, all of it at once — so a verdict that can re-trip on the next
// tick is a rebuffer loop wearing a disk bound's clothes.
//
// ⚠ INVARIANT: PER HANDLER, DELIBERATELY *NOT* KEYED ON THE DRIVE, unlike _last and unlike
// every other per-drive WeakMap in this file. A rotation hands the host a NEW drive object,
// so a drive-keyed timer resets at precisely the moment it is needed and damps nothing.
// Anything keyed on the drive throttles repeat SERVES; only something outliving the drive
// can backstop repeat ROTATIONS. Do not "fix" this into a WeakMap.
//
// 5 minutes: an order of magnitude above the 30 s reclaim tick, and still far below the
// ~35 min a genuinely leaking 2 Mbit/s replica takes to grow through 512 MiB, so it cannot
// mask a real leak — it only refuses to shout about it twice in the same five minutes.
const RECLAIM_MIN_ROTATE_MS = 5 * 60 * 1000

// How many times an INCONCLUSIVE probe may be re-run before this handler stops asking. A
// MEASURED verdict is never retried; see _budgetApplies for the whole argument.
const PROBE_MAX_TRIES = 3

class Reclaim {
  constructor (enabled, intervalMs, budgetBytes, onOverBudget, metaBudgetBytes) {
    this._enabled = enabled // true, or a function re-evaluated per serve
    this._intervalMs = intervalMs
    this._budgetBytes = budgetBytes > 0 ? budgetBytes : 0
    // The METADATA core's own flat ceiling — the punch-independent second bound. See the
    // metaBudgetBytes paragraph at DEFAULTS; _checkBudget carries the gating differences.
    this._metaBudgetBytes = metaBudgetBytes > 0 ? metaBudgetBytes : 0
    this._onOverBudget = typeof onOverBudget === 'function' ? onOverBudget : null
    this._last = new WeakMap() // drive -> epoch ms of the last reclaim
    // Latched the first time a measurement comes back "this platform cannot report bytes
    // used" (Info.storage -> null, i.e. stat() has no st.blocks). Per HANDLER, not per
    // drive, because measurability is a property of the storage backend and therefore
    // constant for the life of the process — one drive's answer is every drive's answer.
    // Once latched the budget is silently off and the handler behaves exactly as it did
    // before any of this existed. Deliberately NOT latched on a transient failure (a drive
    // closed or purged under the probe): that would let one unlucky race disable the
    // budget forever on the one platform that actually needs it. probeDriveBytes reports
    // the two cases apart precisely so this distinction can be made here.
    this._unmeasurable = false
    // THE KEYSTONE LATCH. Set once probeHolePunch PROVES this store's filesystem frees
    // bytes on a punch — i.e. the whole premise of the budget is absent here and the pass
    // above is already doing its job. From then on nothing is measured and onOverBudget can
    // never be reached. Same scope and same reasoning as _unmeasurable: the filesystem
    // under the store is one filesystem for the life of the handler.
    this._budgetOff = false
    this._punch = null // the probe's verdict, once it has one (see probeHolePunch)
    this._punching = null // the in-flight probe, so N drives share ONE probe, not N
    this._punchTries = 0 // an INCONCLUSIVE probe is retryable, bounded — see _budgetApplies
    // drive -> the byte span of ONE FULL live window on this drive, as well as it has ever
    // been observed. Written by _observeWindow off the sink reclaimBelowWindow calls, which
    // fires BEFORE the budget check chained onto the same pass — so the number the budget
    // scales by is never older than this tick, and never worse than this tick. WeakMap for
    // the same reason _last is one: the entry dies with the drive, so a rotation starts the
    // estimate over on the new one rather than carrying a stale window across.
    this._window = new WeakMap()
    // Epoch ms of the last onOverBudget this handler emitted. Per HANDLER — read the
    // invariant at RECLAIM_MIN_ROTATE_MS before changing the key.
    this._lastOverBudget = 0
  }

  // Called with a LIVE playlist body just served for a media target. Never throws.
  update (drive, text) {
    const on = typeof this._enabled === 'function' ? this._enabled() : this._enabled
    if (!on) return
    const now = Date.now()
    if (now - (this._last.get(drive) || 0) < this._intervalMs) return
    this._last.set(drive, now)
    // The budget check is chained AFTER the clear, never in parallel: on a platform where
    // clear() works, measuring first would read the pre-clear size and report a replica
    // over budget that is about to be well under it.
    //
    // ⚠ AND WHETHER THE PASS RAN IS NOW ONLY *HALF* THE CONDITION — see _checkBudget.
    // Originally this was an unconditional .then(() => this._checkBudget(drive)), which was
    // wrong: reclaimBelowWindow swallows every error, so a clear that THREW handed the host
    // an over-budget verdict derived from a measurement no reclaim had touched. The first
    // correction went too far the other way — `if (ran)` — and is recorded with the new rule
    // in _checkBudget, because that is where the second half of it lives.
    //
    // The sink is how the budget learns how big ONE HEALTHY WINDOW is on this channel. The
    // pass has to resolve every listed entry anyway to find the reclaim floor, so the byte
    // span is already in hand and costs no extra read; it lands in _window BEFORE the chained
    // _checkBudget runs, so the scaling never lags a tick behind the window it is judging.
    // What it does NOT do is take this tick's observation on trust — see _observeWindow.
    reclaimBelowWindow(drive, text, (bytes, listed, resolved) => this._observeWindow(drive, bytes, listed, resolved))
      .then((ran) => this._checkBudget(drive, ran)).catch(() => {})
  }

  // FOLD ONE PASS'S OBSERVATION INTO THE WINDOW THE CEILING IS SCALED BY. Two rules, and both
  // exist for the single purpose of making sure an INCOMPLETE listing can never lower it.
  //
  // (1) EXTRAPOLATE TO THE FULL LISTING. `bytes` is the span of `resolved` segments out of
  // `listed`, not of the window — a listed segment whose metadata entry has not reached this
  // replica contributes nothing (reclaimBelowWindow's `if (!blob) continue`, and the note
  // above it for why that is routine at the live edge rather than exotic). Scale it back up.
  // The estimate assumes the missing segments are about the size of the ones that resolved,
  // which is what a constant hls_time buys you; a COMPLETE listing (resolved === listed) is
  // passed through untouched, so the ordinary case stays a measurement and not an estimate.
  //
  // (2) NEVER LOWER WHAT IS ALREADY STORED. Extrapolating from two resolved segments out of
  // sixty-four is arithmetic wearing a measurement's clothes, so the estimate is only ever
  // allowed to RAISE this drive's window. That is what makes the guarantee structural instead
  // of a bet on how good rule (1) is: no listing, however short, and no extrapolation, however
  // unlucky, can move this ceiling toward the floor. Rule (1) is then what keeps a replica
  // whose listing is ALWAYS short from being stuck at the floor for want of a first good pass.
  //
  // What (2) costs is that a window which legitimately SHRINKS mid-drive — an operator
  // lowering hls_list_size without restarting the feed — keeps the older, larger ceiling until
  // the replica rotates and this entry dies with the drive. That is the safe direction: the
  // handler is merely slower to ask for a rotation. It cannot mask a leak either, because a
  // replica that frees nothing grows without bound and crosses any fixed ceiling regardless.
  _observeWindow (drive, bytes, listed, resolved) {
    if (!(bytes > 0)) return
    // Defensive about the counts rather than about the bytes: a caller that passes only the
    // sum (the old one-argument sink shape) degrades to "no extrapolation", never to a
    // divide-by-zero or a NaN ceiling.
    const est = (resolved > 0 && listed > resolved) ? Math.round(bytes * (listed / resolved)) : bytes
    if (est > (this._window.get(drive) || 0)) this._window.set(drive, est)
  }

  // THE BUDGET THIS REPLICA IS ACTUALLY JUDGED AGAINST: the configured ceiling, or k live
  // windows, whichever is LARGER. Never smaller than the configured number, so this can only
  // make the handler more reluctant to ask for a rotation, never more eager.
  //
  // The window it reads is _observeWindow's, NOT a raw per-pass sum — a pass that resolved
  // only part of its listing is extrapolated to the whole of it and can never lower what is
  // already stored. Read the two rules there before reasoning about this number, and before
  // reading info.windowBytes (the same value) as a literal measurement of one pass.
  //
  // A drive with no observed window at all — every pass so far timed out, or nothing in any
  // playlist resolved — falls back to the configured ceiling alone. That is the pre-existing
  // behaviour and the pre-existing risk, which is exactly what RECLAIM_MIN_ROTATE_MS is
  // underneath it for.
  _effectiveBudget (drive) {
    const scaled = (this._window.get(drive) || 0) * RECLAIM_WINDOW_BUDGET_K
    return scaled > this._budgetBytes ? scaled : this._budgetBytes
  }

  // Measure this replica and hand an over-budget verdict to the host. Never throws, never
  // rejects — it is chained onto a fire-and-forget reclaim, and an unhandled rejection
  // SIGABRTs the Bare worklet (the whole app process).
  //
  // `ran` is reclaimBelowWindow's "the pass completed" boolean.
  //
  // ⚠⚠ TWO BOUNDS SHARE THIS ONE MEASUREMENT, AND THEY ARE GATED DIFFERENTLY ON PURPOSE.
  // The BLOB budget (r.bytes vs the window-scaled ceiling) keeps every gate it has ever
  // had: the punch latch, the probe, and the `ran` rule below. The META budget (r.meta vs
  // the flat _metaBudgetBytes) takes NONE of them, because none of them says anything about
  // the metadata core: hole punching frees blob blocks and can never free the Hyperbee
  // (interior nodes referenced by current keys live in old blocks — clearing the db core in
  // place breaks drive.entry(), which is why no such clear exists anywhere in this file),
  // so a punch-capable device accumulates metadata exactly as fast as a 32-bit one; and the
  // clear pass, completed or failed, never touches the metadata core, so the measurement is
  // trustworthy on both sides of `ran`. The one gate the two DO share is _unmeasurable —
  // both are judged off the same stat()s — plus the RECLAIM_MIN_ROTATE_MS floor at the
  // bottom, shared deliberately: a rotation resets BOTH numbers, so two verdicts in one
  // window could only ever ask for the same rotation twice.
  async _checkBudget (drive, ran) {
    if (!this._onOverBudget || this._unmeasurable) return
    const metaOn = this._metaBudgetBytes > 0
    let blobOn = this._budgetBytes > 0 && !this._budgetOff
    if (blobOn) {
      // THE GATE (blob half only — see the header note above). Nothing of the BLOB budget
      // may run on a filesystem that can hole-punch: where the punch works the reclaim pass
      // is already bounding blobs and a rotation would be pure cost. See the keystone note
      // in the class header. It comes FIRST because the probe's verdict is an input to the
      // very next decision — and it still short-circuits the measurement entirely when the
      // meta budget is off, so a meta-less host pays exactly what it always paid.
      if (!(await this._budgetApplies(drive))) {
        blobOn = false
      } else if (!ran && !this._provedCannotPunch()) {
        // ⚠⚠ MEASURE FOR THE BLOB BUDGET WHEN THE PASS COMPLETED, *OR* WHEN THE PROBE PROVED
        // THIS FILESYSTEM CANNOT PUNCH. Withhold the blob verdict when BOTH are unknown.
        //
        // THE RULE THIS REPLACES WAS `if (ran)` ALONE, and it opened a hole exactly where
        // this change is supposed to close one. Its justification — "do not rotate off a
        // measurement no reclaim touched" — silently assumes reclaim COULD have worked. On
        // exFAT, FAT32 or a network mount the punch does not no-op, it REJECTS
        // (EOPNOTSUPP / ENOTSUP) out of blobs.core.clear(), so reclaimBelowWindow catches,
        // returns false, and under `if (ran)` the budget was never checked — on a device
        // that also cannot reclaim. That is unbounded growth with NO bound at all: a
        // narrower audience than 32-bit Android, the identical outcome, and the outcome
        // this whole file exists to prevent.
        //
        // The probe is what makes the wider rule safe. Once canPunch === false is MEASURED,
        // a failed or wholly no-op pass is the EXPECTED steady state on this filesystem,
        // not a signal that something is unavailable — clear() has already been proved
        // unable to free bytes here, so the measurement is trustworthy whether or not the
        // pass finished, and rotation is the only lever there was ever going to be. Where
        // the probe is INCONCLUSIVE and the pass ALSO failed, nothing is known about either
        // half and the original reasoning stands untouched: withhold, and try again next
        // tick.
        //
        // ⚠ This changes NOTHING on the primary 32-bit Android case. There
        // random-access-file's _del calls back SUCCESS with the addon absent, so the pass
        // completes, `ran` is true, and the budget already fired under the old rule. This
        // clause closes the exFAT-style REJECTING-punch case specifically, and only that.
        blobOn = false
      }
    }
    if (!blobOn && !metaOn) return

    const r = await probeDriveBytes(drive)
    if (!r.ok) {
      if (r.unmeasurable) this._unmeasurable = true // flagged once; see the constructor
      return
    }
    // ⚠ THE BLOB CEILING IS SCALED TO THE WINDOW THIS PASS JUST OBSERVED, not the flat
    // configured number — see _effectiveBudget. This is what makes a healthy replica
    // un-over-budget by construction rather than by an argument about how big operators set
    // hls_list_size. The META ceiling is flat — the argument for that is at DEFAULTS.
    //
    // VERDICT ORDER: blob first. When both are over, the blob verdict is the one that
    // carries the window arithmetic an operator needs to read the numbers, and the rotation
    // it asks for resets the metadata anyway — the two can never need separate rotations.
    const budget = this._effectiveBudget(drive)
    let trigger = null
    if (blobOn && r.bytes > budget) trigger = 'budget'
    else if (metaOn && r.meta > this._metaBudgetBytes) trigger = 'meta'
    if (!trigger) return
    // THE ROTATION FLOOR, checked last so it costs nothing on the overwhelmingly common
    // under-budget path, and so a device that IS over budget still pays the measurement and
    // can be seen in a log. Per handler, not per drive — see RECLAIM_MIN_ROTATE_MS. Shared
    // by both triggers — see the header note.
    const now = Date.now()
    if (now - this._lastOverBudget < RECLAIM_MIN_ROTATE_MS) return
    this._lastOverBudget = now
    // The host's callback, with the numbers it needs to decide and to log: `trigger` names
    // WHICH bound fired (the host's feed:rotate event carries it through to the field), the
    // split between blob and metadata bytes is what tells a rotation apart from a leak, and
    // windowBytes/effectiveBudgetBytes are what tell a real leak from an operator who set a
    // 1920-second window. budgetBytes stays the CONFIGURED number so a host that only ever
    // read that field reads the same thing it always did. windowBytes is by construction the
    // number effectiveBudgetBytes was derived from — _observeWindow's folded estimate of one
    // full window, not one pass's raw sum — so the two can never disagree in a log.
    try {
      this._onOverBudget(drive, {
        trigger,
        bytes: r.bytes,
        blobs: r.blobs,
        meta: r.meta,
        budgetBytes: this._budgetBytes,
        metaBudgetBytes: this._metaBudgetBytes,
        effectiveBudgetBytes: budget,
        windowBytes: this._window.get(drive) || 0
      })
    } catch { /* a host callback must never break a serve */ }
  }

  // "May the budget fire on this store at all?" — run ONCE per handler, memoized. Never
  // throws (probeHolePunch never rejects).
  //
  // Three outcomes, and the INCONCLUSIVE one is the reason this returns a boolean rather
  // than the verdict itself:
  //   proved it CAN punch      -> latch _budgetOff, false. The budget is over for good.
  //   proved it CANNOT punch   -> true. This is the platform the budget exists for.
  //   could not tell           -> true, i.e. fall back to the pre-probe behaviour (budget
  //                               active). Deliberately fail-ACTIVE: an inconclusive probe
  //                               on a device that really cannot punch would otherwise let
  //                               the replica grow ~0.9 GB/hour unbounded, and a rotation
  //                               on a device that can is merely wasteful. The reason is
  //                               kept (see status()) so an operator can see WHICH of the
  //                               three happened instead of inferring it from behaviour.
  //
  // ⚠⚠ A MEASURED VERDICT IS PERMANENT; AN INCONCLUSIVE ONE IS RETRIED, up to
  // PROBE_MAX_TRIES and at most once per reclaim tick (the tick is what calls this, and
  // _punching collapses concurrent drives onto one probe).
  //
  // The rule this replaces was "the probe is not retried: a filesystem does not acquire the
  // ability to punch holes halfway through a session". That sentence is true of the
  // FILESYSTEM and false of the PROBE. A verdict really is a property of the filesystem and
  // really is permanent — nothing here ever re-runs one. But an inconclusive answer is a
  // property of the MOMENT: ENOSPC, EMFILE against a corestore pool that targets ~512 fds
  // while the first feed opens, a store purge racing the probe, an allocation that had not
  // reached the inode yet (see PROBE_ALLOC_WAIT_MS). Every one of those is transient, and
  // latching the fall-back-active answer on one of them is how a healthy device ends up with
  // the budget armed for the rest of the session. Retrying is cheap and bounded: at most
  // PROBE_MAX_TRIES writes of PROBE_BYTES in the life of a handler, spaced a reclaim tick
  // apart, never once per tick as the old comment feared.
  async _budgetApplies (drive) {
    if ((this._punch === null || this._punch.ok !== true) && this._punchTries < PROBE_MAX_TRIES) {
      if (this._punching === null) {
        this._punchTries++
        // probeHolePunch is guarded end to end and does not reject; the rejection arm is
        // here so that if one day it does, the memo CLEARS instead of latching a rejected
        // promise that would throw out of every later budget check for the life of the
        // handler. A cleared memo just re-probes on the next reclaimIntervalMs tick.
        this._punching = probeHolePunch(drive).then(
          (r) => { this._punch = r; this._punching = null; return r },
          () => { this._punching = null; return null }
        )
      }
      await this._punching
    }
    const p = this._punch
    if (p && p.ok && p.canPunch) { this._budgetOff = true; return false }
    return true
  }

  // "Has the probe MEASURED that this filesystem cannot free bytes on a punch?" — the
  // narrow, positive form, deliberately not `!canPunch`: an inconclusive probe (ok: false)
  // also carries canPunch: false and must NOT satisfy this. Only a real verdict does.
  // Callable only after _budgetApplies has awaited the probe. See _checkBudget for what
  // rides on the distinction.
  _provedCannotPunch () {
    return !!(this._punch && this._punch.ok && this._punch.canPunch === false)
  }

  // What this handler decided about the budget and why — for a host that wants to log it.
  // Reached through handler.reclaimStatus(); see createDriveHandler.
  status () {
    return {
      budgetBytes: this._budgetBytes,
      budgetActive: !!(this._onOverBudget && this._budgetBytes && !this._unmeasurable && !this._budgetOff),
      metaBudgetBytes: this._metaBudgetBytes,
      // The metadata bound is NOT probe-gated — hole punching cannot free the db core, so
      // where the punch works this is the one bound still standing (see _checkBudget).
      // Only "the platform cannot report allocated bytes" switches it off.
      metaBudgetActive: !!(this._onOverBudget && this._metaBudgetBytes && !this._unmeasurable),
      unmeasurable: this._unmeasurable,
      // How many probes this handler has spent. Only an INCONCLUSIVE answer is ever
      // re-probed, so tries > 1 with punch.ok false says "this device kept failing to
      // answer", and tries === PROBE_MAX_TRIES says it has stopped asking.
      punchTries: this._punchTries,
      // wideFreed is undefined until (and unless) the wide stage ran — see runWideProbe.
      // Next to `freed` it is what tells the size_t addon class apart from the addon-less
      // one in a log: the small punch freed, the wide one did not.
      punch: this._punch ? { ok: this._punch.ok, canPunch: this._punch.canPunch, reason: this._punch.reason, freed: this._punch.freed, wideFreed: this._punch.wideFreed } : null
    }
  }
}

// Bytes the capability probe writes, and the hole it then punches out of the middle of
// them. Sized against the COARSEST allocation accounting this has to be unambiguous on:
// NTFS reports sparse-file allocation in 64 KiB units (verified on this host — a 1,024-byte
// file stats as 128 × 512 = 65,536 allocated bytes), so a 512 KiB file with a 256 KiB hole
// punched at offset 128 KiB straddles no boundary in either direction — the hole is four
// full units inside the file with a spare unit of file on each side, and the expected drop
// is exactly 256 KiB. On the POSIX filesystems that matter here the unit is 4 KiB and the
// margin is 64×. One 512 KiB write, at most PROBE_MAX_TRIES times per handler, and only for
// hosts that actually pass onOverBudget.
//
// ⚠ HALVED FROM 1 MiB, deliberately. This file's whole purpose is bounding disk and the
// probe is the one thing in it that WRITES; a process killed between the write and the
// unlink strands the scratch file, and NOTHING sweeps punch-probe-* — this file is
// runtime-agnostic by construction (no node:/bare- imports, see the header) so it cannot
// list a directory even if it wanted to. The kill is likeliest exactly when the probe runs:
// the first playlist serve of the first feed, when Android's LMK is most interested in a
// backgrounded worklet. 512 KiB keeps the NTFS geometry above intact and halves the litter,
// and probeHolePunch TRUNCATES before it unlinks, so a cleanup that only gets half-way
// leaves an EMPTY file rather than half a megabyte. Measured on Windows/NTFS 2026-08-13 at
// this size: 524,288 allocated before, 262,144 after, drop exactly 256 KiB, file and
// directory both gone.
const PROBE_BYTES = 512 * 1024
const PROBE_HOLE_OFFSET = 128 * 1024
const PROBE_HOLE_BYTES = 256 * 1024

// HOW LONG THE PROBE WAITS FOR ITS WRITE TO BE CHARGED TO stat()->blocks, and how often it
// re-reads it. fs.write lands in the page cache; fs.fstat reads the inode. Under DELAYED
// ALLOCATION (ext4, f2fs, XFS — i.e. Linux and Android, the platforms this gate exists for)
// blocks are not charged to the inode until writeback, which can be seconds away. Two ways
// that ruins the measurement if it is not waited out, and they fail in OPPOSITE directions:
//   · `before` reads short (0, even) -> allocation-too-small -> INCONCLUSIVE -> the budget
//     stays armed on a perfectly healthy arm64 device; or
//   · a PARTIAL writeback clears a one-shot guard and then charges MORE blocks between the
//     two stats, so `after` exceeds `before`, freed is negative, and the probe MEASURES a
//     false "cannot punch" — a verdict, latched for the session.
// So: poll until the allocation reaches the written size, THEN take `before` and punch.
//
// ⚠ MEASURED ON: Windows/NTFS only (2026-08-13, corestore 6.18.4 / random-access-file
// 4.1.2), where blocks are charged synchronously and this loop exits on its first read.
// NOT MEASURED ON: Linux/ext4, Android/f2fs, XFS, exFAT, FAT32, or any network mount — i.e.
// not on any platform this gate actually exists for. The version of this comment that stood
// here waved delayed allocation off with "ext4 folds its delalloc reservation into
// stat->blocks"; that is unverified in-tree, it is contradicted by the widely observed
// du-reports-zero-until-writeback behaviour, and the only measurement ever cited for it was
// taken on NTFS. The code no longer rests on the claim in either direction: it waits, and if
// the allocation never arrives it returns INCONCLUSIVE — which is now RETRYABLE (see
// Reclaim._budgetApplies), because that is the only honest thing to do with a non-answer.
const PROBE_ALLOC_WAIT_MS = 2000
const PROBE_ALLOC_POLL_MS = 50

// The probe is a handful of local fs syscalls, but it runs on the reclaim path, and this
// file's rule is that nothing on that path may be awaited without a bound. A wedged open on
// a dying network mount is exactly the case this exists to detect. Must stay comfortably
// above 3 × PROBE_ALLOC_WAIT_MS, which can be spent inside it: the small stage settles its
// allocation once, and the wide stage (runWideProbe) twice — a drain and a charge.
const PROBE_TIMEOUT_MS = 10000

// CAN THIS STORE'S FILESYSTEM ACTUALLY HOLE-PUNCH? Measured, never assumed. Never throws.
//
//   { ok: true,  canPunch: true|false, reason, before, after, freed }   a verdict
//   { ok: false, canPunch: false, reason, ... }                        inconclusive
//   (wideBefore/wideAfter/wideFreed ride along whenever the WIDE stage ran — see
//   runWideProbe. canPunch: true is never granted without that stage.)
//
// WHY THIS EXISTS. `hypercore.clear()` returns success whether or not the storage layer
// freed a single byte (the full account is in the Reclaim header), so no amount of watching
// the clear path can tell the two platforms apart. Everything downstream of that — the byte
// budget, onOverBudget, the host's whole-replica rotation — is only ever correct on the
// platform that CANNOT punch. Guessing which one this is from the ABI would be both fragile
// and wrong: the punch also fails on exFAT and FAT32 (no FALLOC_FL_PUNCH_HOLE, no
// FSCTL_SET_ZERO_DATA) and on most network mounts, on any ABI. So do the only honest thing
// and punch a hole in a scratch file.
//
// HOW, precisely — every step of this is load-bearing:
//   · the scratch file is created through the STORE'S OWN storage factory
//     (corestore.storage, the same `Hypercore.defaultStorage` closure every core's oplog /
//     tree / data / bitfield comes from), so it is the same random-access-file class, in
//     the same directory, on the same filesystem, taking the same _del path the blob core's
//     clear() will take. A probe that used node:fs directly would be testing a different
//     code path and would not see, e.g., a host that swapped the factory out.
//   · its name ends in '/data'. Not cosmetic: defaultStorage sets `sparse: true` only for
//     names ending in data/bitfield/tree, and `sparse` is what makes random-access-file
//     call fsext.sparse(fd) on open. On Windows that sets FILE_ATTRIBUTE_SPARSE_FILE, and
//     WITHOUT it FSCTL_SET_ZERO_DATA writes zeros instead of freeing clusters — an
//     unsparse probe would report "cannot punch" on every NTFS host.
//   · the payload is PRNG-filled, not zeros. A zero-filled block can be stored in nothing at
//     all on a compressing filesystem (btrfs/ZFS compression, an NTFS compressed folder),
//     which would leave `before` too small for the drop to be visible and turn a perfectly
//     punchable filesystem into an inconclusive probe.
//   · allocated size is `st.blocks * 512` off the SAME stat() hypercore's own Info.storage
//     uses (lib/info.js), so the probe and the budget it gates agree on what a byte is, and
//     it is POLLED until the write is charged to it — see PROBE_ALLOC_WAIT_MS.
//   · a small punch that works buys NO verdict by itself: canPunch: true additionally
//     requires a punch LONGER THAN 2^32 bytes to land (runWideProbe). The failure class
//     that stage closes is an addon whose C API took size_t lengths — it punched the
//     256 KiB scratch hole perfectly and truncated hypercore's real below-window clears
//     mod 4 GiB, so a one-stage probe latched the budget OFF on the device that needed it.
//   · the file is TRUNCATED and then unlinked at the end, through RAF's own calls — unlink
//     closes the fd first and, because corestore builds the factory with rmdir:true, removes
//     the probe's directory too. MEASURED on Windows/NTFS 2026-08-13 with the shipped
//     corestore 6.18.4 / random-access-file 4.1.2: 524,288 allocated bytes before, 262,144
//     after, drop exactly 256 KiB, file and directory both gone; and against the addon-less
//     _del the reclaim lane simulates (tools/serve-reclaim-test.mjs noTrimStore), drop 0.
//
// INCONCLUSIVE is a real answer, it is kept distinct from "cannot punch", and it is
// RETRYABLE (Reclaim._budgetApplies re-probes it, bounded). It covers: no corestore on the
// drive, no storage factory, a store already closing, a factory that hands back something
// without write/stat/del/truncate, anything that threw ANYWHERE except the punch itself, a
// stat with no st.blocks (the same platform class _unmeasurable latches on), an allocation
// that never settled, every wide-* step the second stage can fail at (its truncates, its
// write, its stats, its two settle loops), or the whole thing timing out. The caller
// decides what to do with it — Reclaim._budgetApplies falls back to budget-active and
// records the reason.
export async function probeHolePunch (drive) {
  const store = drive && drive.corestore
  if (!store || typeof store.storage !== 'function') return { ok: false, canPunch: false, reason: 'no-storage-factory' }
  // ⚠ THE STORAGE FACTORY IS A PURE CLOSURE WITH NO CLOSED-STATE CHECK. Corestore builds it
  // once in its constructor (Hypercore.defaultStorage) and never revisits it, and
  // random-access-file's _open mkdir -p's the parent — so a probe that starts, or merely has
  // a request still queued, while the host is tearing the store down will RECREATE the store
  // directory after the host deleted it. That is the SDK's _purgeAndRebuild sequence
  // exactly: close the store, then rmSync the directory. Corestore's own closed/closing flags
  // are the only handle this file has on that (it is runtime-agnostic and cannot touch the
  // filesystem itself), so they are checked here and again either side of the write.
  //
  // This NARROWS the window; it cannot close it. A write already queued when close() lands
  // still runs, because corestore does not know this file exists. Closing it properly would
  // mean the host handing the probe a lifecycle, which is cross-module coupling for a case
  // the truncate-then-unlink below already reduces to an empty directory.
  if (store.closed || store.closing) return { ok: false, canPunch: false, reason: 'store-closing' }

  // Randomized, not a fixed name: two handlers can share one store (sdk/player.js runs a
  // loopback server and a cast server off the same corestore) and a fixed name would let
  // them punch and stat each OTHER's file — noise that could latch canPunch the wrong way,
  // which is the one direction that silently disables the budget on a device that needs it.
  // The cost of randomizing is that a process killed inside the probe leaves one stale
  // probe directory in the store root; the store owner's recovery path removes cores/ +
  // primary-key and is unaffected by it. See PROBE_BYTES for what bounds the damage.
  const name = 'punch-probe-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '/data'
  let file = null
  try { file = store.storage(name) } catch { return { ok: false, canPunch: false, reason: 'storage-factory-threw' } }
  if (!file || typeof file.write !== 'function' || typeof file.stat !== 'function' ||
      typeof file.del !== 'function' || typeof file.truncate !== 'function') {
    return { ok: false, canPunch: false, reason: 'storage-not-probeable' }
  }
  const call = (method, ...args) => new Promise((resolve, reject) => {
    try { file[method](...args, (err, v) => (err ? reject(err) : resolve(v))) } catch (err) { reject(err) }
  })
  const closing = () => !!(store.closed || store.closing)

  const result = await bounded(runProbe(call, closing), PROBE_TIMEOUT_MS, { ok: false, canPunch: false, reason: 'probe-timeout' })
  // Cleanup is unconditional and its own failure is not the probe's verdict — a leftover
  // scratch file is litter, a wrong canPunch is a rebuffer loop or an unbounded replica.
  //
  // TRUNCATE FIRST, THEN UNLINK. ftruncate needs no addon on any platform (RAF services
  // truncate through fs.ftruncate, never through fsext) so it works precisely where the
  // punch does not, and it drops the allocation to zero — verified here on NTFS. If the
  // unlink is the call that loses — a Windows sharing violation, the store torn down under
  // us, this bound expiring with the request still queued behind a wedged write — what is
  // stranded is an EMPTY file in an empty directory instead of half a megabyte.
  //
  // The truncate is QUEUED, not awaited, and only the unlink is waited on: both requests go
  // onto the same random-access-storage queue in call order, so truncate still runs first,
  // and not awaiting it keeps this cleanup's worst case at ONE bound rather than two. Its
  // rejection handler is attached explicitly — nothing else will ever look at that promise,
  // and an unhandled rejection SIGABRTs the Bare worklet.
  try { call('truncate', 0).catch(() => {}) } catch {}
  try { await bounded(call('unlink'), PROBE_TIMEOUT_MS) } catch {}
  return result
}

// A probe step that failed for a reason that says NOTHING about hole punching. `step` names
// which one, so an operator reading reclaimStatus() can tell ENOSPC from EMFILE from a purge
// instead of seeing one undifferentiated shrug.
function inconclusive (step, err) {
  const why = err ? step + ': ' + ((err && err.code) || (err && err.message) || 'error') : step
  return { ok: false, canPunch: false, reason: why }
}

const probeDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ONE probe attempt. Never throws.
//
// ⚠⚠ ONLY A REJECTION FROM A PUNCH ITSELF MAY PRODUCE A VERDICT (ok: true) — either
// stage's; runWideProbe holds itself to the same rule. EVERY OTHER THROW IS INCONCLUSIVE.
// That is why this reads as a sequence of individually-guarded steps rather than one try
// block, and the shape must not be collapsed back.
//
// It used to be one try whose catch returned { ok: true, canPunch: false, reason:
// 'punch-threw' } — so ANY throw anywhere latched session-lifetime policy ("this device
// cannot free bytes; arm rotation") out of evidence about something else entirely. ok: true
// means "this is a VERDICT", and a verdict is permanent. Every non-punch statement here has
// a realistic way to throw on hardware that punches perfectly well:
//   · the PROBE_BYTES allocation — RangeError on a memory-pressured Bare worklet;
//   · the write — ENOSPC, i.e. a full disk, which is EXACTLY when reclaim matters and which
//     would have armed rotation permanently on a device that punches fine;
//   · the write or either stat — EMFILE, because random-access-storage routes an OPEN error
//     to every request queued behind it (_maybeOpenError) and the corestore pool targets
//     ~512 fds, while this probe fires on the FIRST playlist serve of the first feed,
//     concurrent with the feed open, the swarm join and the initial whole-window download;
//   · any of them — ENOENT/EBADF from a store purge racing the probe, which would poison the
//     verdict during the very crash that caused the rebuild.
// All of those are transient conditions, all of them are now INCONCLUSIVE, and inconclusive
// is retryable (Reclaim._budgetApplies). Only `del` rejecting is evidence about the
// filesystem, and it is the clearest evidence there is: EOPNOTSUPP on exFAT, ENOTSUP on a
// network mount.
async function runProbe (call, closing = () => false) {
  let data
  try {
    data = new Uint8Array(PROBE_BYTES)
    // Cheap LCG — incompressible enough that a compressing filesystem still has to allocate
    // the payload. Math.random() per byte would do too and costs ~40× more for no gain.
    let s = (Date.now() ^ 0x9e3779b9) >>> 0
    for (let i = 0; i < data.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; data[i] = (s >>> 24) & 0xff }
  } catch (err) { return inconclusive('alloc-threw', err) }

  if (closing()) return inconclusive('store-closing')
  try { await call('write', 0, data) } catch (err) { return inconclusive('write-threw', err) }
  if (closing()) return inconclusive('store-closing')

  // WAIT FOR THE ALLOCATION TO SETTLE BEFORE TAKING `before` — the whole argument, and what
  // was and was not measured, is at PROBE_ALLOC_WAIT_MS. Note this is a loop and not a
  // one-shot guard on purpose: a partial writeback that satisfied a threshold once could go
  // on charging blocks BETWEEN the two stats, and `after` > `before` reads as a MEASURED
  // "cannot punch". Requiring the full written size first means any further writeback has
  // nothing left to charge.
  let before = null
  const deadline = Date.now() + PROBE_ALLOC_WAIT_MS
  while (true) {
    let st
    try { st = await call('stat') } catch (err) { return inconclusive('stat-threw', err) }
    before = allocatedBytes(st)
    // No st.blocks at all — the same platform class _unmeasurable latches on, and not a
    // statement about punching.
    if (before === null) return { ok: false, canPunch: false, reason: 'stat-has-no-blocks' }
    if (before >= PROBE_BYTES) break
    if (Date.now() >= deadline) {
      // Below the written size the drop cannot be trusted in either direction, so "no
      // change" would not mean "cannot punch". Inconclusive, never a verdict — and now
      // retryable, because writeback pressure is a moment, not a filesystem.
      return { ok: false, canPunch: false, reason: 'allocation-not-settled', before }
    }
    await probeDelay(PROBE_ALLOC_POLL_MS)
  }

  // THE ONE STATEMENT IN THIS STAGE WHOSE REJECTION IS A VERDICT. A punch that REJECTS
  // (EOPNOTSUPP on exFAT, ENOTSUP on a network mount) is not an inconclusive probe — it is
  // the clearest possible "cannot punch" there is.
  try {
    await call('del', PROBE_HOLE_OFFSET, PROBE_HOLE_BYTES)
  } catch (err) {
    return { ok: true, canPunch: false, reason: 'punch-threw: ' + ((err && err.code) || (err && err.message) || 'error'), before }
  }

  let after = null
  try { after = allocatedBytes(await call('stat')) } catch (err) { return inconclusive('stat-threw', err) }
  if (after === null) return { ok: false, canPunch: false, reason: 'stat-has-no-blocks', before }
  // ⚠ ALLOCATION THAT WENT *UP* ACROSS THE PUNCH IS NOT A VERDICT. Punching a hole can only
  // lower the allocated size or leave it alone, so an increase means something else was
  // still charging blocks to this inode between the two stats — the delayed-allocation
  // failure the settle loop above exists to prevent, caught a second time here because the
  // cost of missing it is a MEASURED false "cannot punch", latched for the session, on a
  // device that punches perfectly well. Belt and braces on purpose: the loop is the fix,
  // this is the proof that the fix held.
  if (after > before) return { ok: false, canPunch: false, reason: 'allocation-still-growing', before, after }
  const freed = before - after
  // Half the hole, not one byte: on every filesystem that really punches, the drop is the
  // hole minus at most one allocation unit at each end (and it is the WHOLE hole here,
  // since the hole is unit-aligned on both NTFS and 4 KiB POSIX). Requiring a substantial
  // drop keeps an unrelated one-cluster fluctuation from latching canPunch — the failure
  // direction that silently switches the budget off on a device that needs it. And "no
  // change at all" lands squarely on cannot-punch, which is the addon-less case.
  if (!(freed >= PROBE_HOLE_BYTES / 2)) return { ok: true, canPunch: false, reason: 'measured', before, after, freed }

  // A SMALL PUNCH THAT WORKED IS NECESSARY AND NOT SUFFICIENT. The addon class runWideProbe
  // exists for passes this test HONESTLY — its 256 KiB scratch punch really does free
  // 256 KiB — while truncating every length past 2^32 to `len mod 2^32` and freeing none of
  // what hypercore actually clears. canPunch: true is the verdict that LATCHES THE BUDGET
  // OFF for the session, so it is not granted on the small punch alone: a length no 32-bit
  // cast can carry has to land too. The wide stage's refusals and errors speak for
  // themselves (wide-* reasons); its confirmation folds back into the one verdict shape
  // every caller already reads, with the wide numbers alongside for reclaimStatus().
  const wide = await runWideProbe(call, closing)
  if (wide.ok && wide.canPunch) {
    return { ok: true, canPunch: true, reason: 'measured', before, after, freed, wideBefore: wide.wideBefore, wideAfter: wide.wideAfter, wideFreed: wide.wideFreed }
  }
  // A wide REFUSAL (a verdict) or a wide failure (inconclusive) IS the probe's answer. The
  // stage-1 numbers ride along so a log shows the small punch really did pass — which is
  // what tells this addon class apart from the addon-less one at a glance.
  return { ...wide, before, after, freed }
}

// THE WIDE STAGE'S GEOMETRY. One punch, longer than 2^32 bytes, over a file that holds ONE
// allocated block parked ABOVE the 4 GiB line — near-zero real I/O, because on every
// filesystem that can reach this stage the ~5 GiB length is LOGICAL only (see the ordering
// note at runWideProbe).
//
//   the punch, 5 GiB:  a size_t cast on a 32-bit ABI keeps 5 GiB mod 2^32 = 1 GiB of it;
//   the block, at 2^32 + 128 KiB:  above the largest length ANY mod-2^32 punch from offset
//     0 can reach, so the truncating addon must miss it and a healthy one must free it;
//   the file, 5 GiB + 128 KiB long:  the hole stops short of EOF — the same "the hole is
//     interior to the file" discipline PROBE_HOLE_OFFSET buys the small stage.
// The block itself is PROBE_HOLE_BYTES long and 64 KiB-aligned at both ends, so the NTFS
// sparse-unit arithmetic recorded at PROBE_BYTES applies to it unchanged.
const PROBE_WIDE_HOLE = 5 * 1024 * 1024 * 1024
const PROBE_WIDE_DATA_OFFSET = 4 * 1024 * 1024 * 1024 + PROBE_HOLE_OFFSET
const PROBE_WIDE_LEN = PROBE_WIDE_HOLE + PROBE_HOLE_OFFSET

// THE WIDE (SECOND) STAGE: a punch longer than 2^32 bytes, run ONLY after the small punch
// already proved itself. It exists because the small punch can be honestly right while the
// punches that matter are silently wrong — and that is not a hypothetical:
//
// OBSERVED IN THE WILD, 2026-08-13, during the fs-native-extensions android-arm rebuild
// (aliran-ops/fsext-fixed — the README there holds the evidence chain). The addon's C API
// declared punch lengths as size_t, which is 32 BITS on armeabi-v7a. hypercore's
// below-window clear arrives as ONE punch of [0, floor) — 64,792,842,531 bytes on the
// long-lived feed it was measured on — so the length truncated mod 4 GiB and the call
// freed (nearly) nothing while returning success. The probe's own 256 KiB scratch punch
// fits in 32 bits and genuinely worked, so the one-stage probe MEASURED canPunch: true and
// LATCHED THE BUDGET OFF — disarming the rotation safety net on the exact device whose
// real clears freed zero bytes. Strictly worse than no addon at all: addon-less, the small
// punch frees nothing and the budget stays armed. That build (ba823ca8…) was never
// deployed; the fixed one (ccc8e363…, lengths widened to uint64_t) is what ships. This
// stage is what keeps the CLASS from ever being trusted on addon say-so again.
//
// HOW, in near-zero real I/O: truncate the scratch to nothing (stage 1's leftover
// allocation must not be able to masquerade as the high block — see the drain loop), then
// out to ~5 GiB LOGICAL, write ONE PROBE_HOLE_BYTES block above the 4 GiB line, punch
// [0, 5 GiB), re-stat. A healthy addon frees the high block and the allocation drops; a
// length-truncating one punches [0, 1 GiB) — which on this file is hole from end to end —
// and frees nothing.
//
// ⚠⚠ ORDERING IS LOAD-BEARING: THIS RUNS ONLY AFTER THE SMALL PUNCH SUCCEEDED. On exFAT
// and FAT32 there is no sparse support, so the 5 GiB ftruncate would ALLOCATE five real
// GiB (and FAT32 caps files at 4 GiB besides) — write amplification a probe on a DISK
// BOUND must never commit. Those filesystems cannot reach this stage: their small punch
// REJECTS (no FALLOC_FL_PUNCH_HOLE, no FSCTL_SET_ZERO_DATA) and the probe has its verdict
// one stage earlier. Same discipline as stage 1 for everything else: only the punch call
// itself may produce a verdict; every other failure here is INCONCLUSIVE (wide-* reasons,
// so an operator can see WHICH stage could not answer), retryable, and falls back to
// budget-armed — the safe side.
//
// THE REJECTED ALTERNATIVE was reading the punched range back and requiring zeros. It
// discriminates WHERE the punch landed, but a punch can zero without freeing (NTFS
// FSCTL_SET_ZERO_DATA on an unsparse file writes zeros and releases nothing), so "reads
// as zeros" does not mean "the disk went down" — and allocated bytes are the budget's
// whole currency, so the probe stays on the one instrument the thing it gates is measured
// in. Pinning the fixed addon's build id was rejected too: that answers "which build is
// this", and the question is "does THIS storage free bytes at the lengths hypercore
// actually punches".
async function runWideProbe (call, closing = () => false) {
  // PRNG-filled for the same reason stage 1's payload is — a compressing filesystem must
  // really allocate the high block or the drop below would be invisible. Different seed
  // salt, same cheap LCG.
  let data
  try {
    data = new Uint8Array(PROBE_HOLE_BYTES)
    let s = (Date.now() ^ 0x2545f491) >>> 0
    for (let i = 0; i < data.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; data[i] = (s >>> 24) & 0xff }
  } catch (err) { return inconclusive('wide-alloc-threw', err) }

  if (closing()) return inconclusive('wide-store-closing')
  // Truncate to ZERO before truncating out. ftruncate needs no addon on any platform (the
  // cleanup note in probeHolePunch), and it is what evicts stage 1's leftover ~256 KiB:
  // without this, that leftover could satisfy the charge loop below BEFORE the high write
  // is charged, and a punch that then freed only the leftover would read as a healthy
  // drop — a false canPunch, in the one direction this stage must never fail.
  try { await call('truncate', 0) } catch (err) { return inconclusive('wide-truncate-threw', err) }
  try { await call('truncate', PROBE_WIDE_LEN) } catch (err) { return inconclusive('wide-truncate-threw', err) }

  // THE DRAIN LOOP: the baseline must be provably LOW before the high block goes in, for
  // the same reason stage 1's charge loop must reach the full written size — an allocation
  // still moving between the two stats reads as a drop (or a growth) the punch never
  // caused. Half the block rather than zero: platforms round allocation up (NTFS charges
  // sparse files in 64 KiB units) and a stray unit of metadata must not wedge the stage.
  let deadline = Date.now() + PROBE_ALLOC_WAIT_MS
  while (true) {
    let st
    try { st = await call('stat') } catch (err) { return inconclusive('wide-stat-threw', err) }
    const alloc = allocatedBytes(st)
    if (alloc === null) return { ok: false, canPunch: false, reason: 'stat-has-no-blocks' }
    if (alloc < PROBE_HOLE_BYTES / 2) break
    if (Date.now() >= deadline) return { ok: false, canPunch: false, reason: 'wide-baseline-not-settled' }
    await probeDelay(PROBE_ALLOC_POLL_MS)
  }

  if (closing()) return inconclusive('wide-store-closing')
  try { await call('write', PROBE_WIDE_DATA_OFFSET, data) } catch (err) { return inconclusive('wide-write-threw', err) }
  if (closing()) return inconclusive('wide-store-closing')

  // THE CHARGE LOOP — stage 1's, for stage 1's reasons: take wideBefore only once the
  // write is fully charged, so later writeback has nothing left to move between the stats.
  let wideBefore = null
  deadline = Date.now() + PROBE_ALLOC_WAIT_MS
  while (true) {
    let st
    try { st = await call('stat') } catch (err) { return inconclusive('wide-stat-threw', err) }
    wideBefore = allocatedBytes(st)
    if (wideBefore === null) return { ok: false, canPunch: false, reason: 'stat-has-no-blocks' }
    if (wideBefore >= PROBE_HOLE_BYTES) break
    if (Date.now() >= deadline) return { ok: false, canPunch: false, reason: 'wide-allocation-not-settled', wideBefore }
    await probeDelay(PROBE_ALLOC_POLL_MS)
  }

  // THE WIDE PUNCH — the one statement in THIS stage whose rejection is a verdict, exactly
  // as in stage 1. A del that carried 256 KiB and rejects 5 GiB is not a transient:
  // whatever sits under this store cannot punch at the lengths hypercore actually clears,
  // and that is the budget's whole question.
  try {
    await call('del', 0, PROBE_WIDE_HOLE)
  } catch (err) {
    return { ok: true, canPunch: false, reason: 'wide-punch-threw: ' + ((err && err.code) || (err && err.message) || 'error'), wideBefore }
  }

  let wideAfter = null
  try { wideAfter = allocatedBytes(await call('stat')) } catch (err) { return inconclusive('wide-stat-threw', err) }
  if (wideAfter === null) return { ok: false, canPunch: false, reason: 'stat-has-no-blocks', wideBefore }
  // Same belt and braces as stage 1: a punch can only lower the allocation, so growth
  // means something else was still charging blocks and no verdict may be taken from the
  // pair.
  if (wideAfter > wideBefore) return { ok: false, canPunch: false, reason: 'wide-allocation-still-growing', wideBefore, wideAfter }
  const wideFreed = wideBefore - wideAfter
  // Half the high block — the margin stage 1 demands, for stage 1's reasons. A truncating
  // addon lands at wideFreed ≈ 0 here (its [0, 1 GiB) punch crosses nothing allocated),
  // and 'wide-measured' is the reason string that tells an operator WHICH stage refused
  // the verdict — reclaimStatus() surfaces it next to the small stage's freed.
  if (wideFreed >= PROBE_HOLE_BYTES / 2) return { ok: true, canPunch: true, wideBefore, wideAfter, wideFreed }
  return { ok: true, canPunch: false, reason: 'wide-measured', wideBefore, wideAfter, wideFreed }
}

// st.blocks * 512 — the allocated size, in the same units and off the same stat() hypercore's
// own Info.storage reads (lib/info.js:40-52). null when the platform does not report it,
// which is the same platform class measureDriveBytes returns null for.
function allocatedBytes (st) {
  const blocks = st && st.blocks
  return typeof blocks === 'number' && blocks >= 0 ? blocks * 512 : null
}

// ON-DISK SIZE OF ONE FEED REPLICA in bytes — { bytes, blobs, meta } — or null when there
// is no number to be had. Never throws.
//
// Sums BOTH cores a Hyperdrive is made of: the metadata core (drive.core — the Hyperbee)
// and the blob core ((await drive.getBlobs()).core). Both, because the thing being bounded
// is what the replica costs the viewer's disk, and metadata is not free on a feed that
// writes one entry every ~2 s for hours.
//
// The probe is Hypercore's own: core.info({ storage: true }) returns
// { storage: { oplog, tree, blocks, bitfield } } where every value is BYTES — literally
// st.blocks * 512 off a stat() of each backing file (hypercore 10.38.2 lib/info.js:40-52).
// ALLOCATED bytes, not logical length, which is exactly the number wanted here: a
// successfully hole-punched region stops being counted the moment the filesystem frees it,
// and a punch that silently did nothing keeps being counted. So this measures the real
// outcome of clear() on whatever platform it is running on, with no platform detection.
//
// It is the PLATFORM's allocation accounting, so treat it as a magnitude, not an audit.
// Measured on Windows/NTFS 2026-08-13: a hyperblobs data file 655,360 bytes long reported
// 196,608, while a 4,096-byte bitfield reported 65,536 — it errs in both directions there
// (extending writes not yet committed one way, cluster rounding the other). On the POSIX
// platforms this budget actually exists for, st.blocks IS the true 512-byte allocation
// count and is precisely the thing a hole-punch moves. A budget in the hundreds of MB is
// nowhere near tight enough for that noise to matter either way.
//
// ⚠⚠ WHY info() AND NOT clear(start, end, { diff: true }). A diffing clear reports the
// bytes it freed, which looks like the obvious instrument. It is a TRAP. Core.clear
// computes that diff by calling Info.bytesUsed(this.blocks.storage) DIRECTLY, with no
// guard (hypercore lib/core.js:542), and Info.bytesUsed REJECTS outright when stat()
// yields no st.blocks. It does so AFTER the oplog append and the bitfield drop — so on a
// platform that cannot answer the question, a diffing clear throws out of the middle of an
// otherwise-completed clear, straight into reclaimBelowWindow's catch, silently disabling
// reclaim from then on. On, of all places, the platforms where reclaim is the only part of
// this still working. Info.storage has no such hazard: it wraps all four stats in ONE
// try/catch and returns null (lib/info.js:26-38). It cannot fail into anything but null.
//
// null means "no number available" and covers two cases the CALLER usually wants merged
// but the Reclaim budget must tell apart — see probeDriveBytes.
export async function measureDriveBytes (drive) {
  const r = await probeDriveBytes(drive)
  return r.ok ? { bytes: r.bytes, blobs: r.blobs, meta: r.meta } : null
}

// measureDriveBytes' engine, with the failure discriminated:
//   { ok: true,  bytes, blobs, meta }        measured
//   { ok: false, unmeasurable: true }        the PLATFORM cannot report it (storage: null)
//   { ok: false, unmeasurable: false }       transient — drive closed/purged under us, a
//                                            core not open, anything that threw
// Only the first failure is permanent and only it may latch the budget off. Kept internal
// because the exported measureDriveBytes has exactly one honest answer for a caller that
// just wants a size: null.
async function probeDriveBytes (drive) {
  let meta = null
  let blobs = null
  try {
    // ⚠⚠ EVERY AWAIT HERE IS BOUNDED, AND getBlobs() IS THE REASON.
    //
    // This used to read `await (await drive.getBlobs()).core.info(...)` under a comment
    // asserting that "getBlobs() is a no-op here in practice — the reclaim pass that
    // precedes this one has already resolved drive.blobs, so this is a property read, not
    // an open". That is true for the drive this pass just served and FALSE for the one the
    // host's idle sweep hands over next. On a replica whose metadata HEADER BLOCK never
    // replicated (an off-air feed sitting in a warm cache — the defining state of the feeds
    // the sweep exists for), Hyperdrive parks _openBlobsFromHeader() on getHeader() waiting
    // for block 0, keeps that promise on _openingBlobs, and getBlobs() awaits it: it does
    // not reject, it NEVER SETTLES. ready() resolving proves nothing — _open() kicks the
    // blobs open off to the side precisely so ready() need not wait for it. A try/catch
    // cannot catch a promise that never rejects, and sdk/player.js awaits this inside a
    // sequential loop under a `busy` flag, so ONE such feed used to kill the idle sweep and
    // the store cap for the whole session.
    //
    // A timeout is deliberately reported as TRANSIENT (unmeasurable: false), never as
    // unmeasurable: true — the latter latches the budget off for the life of the handler
    // and one wedged replica must not be allowed to do that. Same reasoning the constructor
    // gives for not latching on a closed drive.
    const mi = await bounded(drive.core.info({ storage: true }), RECLAIM_READ_MS)
    if (mi === TIMED_OUT) return { ok: false, unmeasurable: false }
    meta = sumStorage(mi)
    const bs = await bounded(drive.getBlobs(), RECLAIM_READ_MS)
    if (bs === TIMED_OUT || !bs) return { ok: false, unmeasurable: false }
    const bi = await bounded(bs.core.info({ storage: true }), RECLAIM_READ_MS)
    if (bi === TIMED_OUT) return { ok: false, unmeasurable: false }
    blobs = sumStorage(bi)
  } catch {
    return { ok: false, unmeasurable: false }
  }
  if (meta === null || blobs === null) return { ok: false, unmeasurable: true }
  return { ok: true, bytes: meta + blobs, blobs, meta }
}

// The four backing files of one core, added up. null when Info.storage bailed.
function sumStorage (info) {
  const st = info && info.storage
  if (!st) return null
  return (st.oplog || 0) + (st.tree || 0) + (st.blocks || 0) + (st.bitfield || 0)
}

// ONE reclaim pass over a live feed replica, given the playlist body that defines the
// current window. Exported because reclaim is otherwise only ever reachable from a live
// playlist SERVE, and there are callers that have to run a pass without one: when a cast
// session ends (sdk/player.js stopCast), the feed it pinned has been accumulating dead
// blocks for the whole session and nothing will free them until the viewer happens to
// tune that channel again; and reclaimIdleFeed below, which sweeps the feeds nobody is
// watching. Never throws — a reclaim must never break a serve or a stop.
//
// ⚠ IT FREES BYTES ONLY WHERE THE PLATFORM CAN HOLE-PUNCH. Every clear() below returns
// cleanly whether or not it actually released anything; on 32-bit Android ABIs it releases
// nothing at all (full account in the Reclaim header). The BITFIELD drop is real on every
// platform, so the pass is never WRONG — a cleared block is refetched instead of read
// locally, exactly as intended — it is merely useless there. Nobody may read "the reclaim
// ran" as "the disk went down": measureDriveBytes and reclaimBudgetBytes exist precisely
// because this function cannot tell you which of the two happened.
//
// RETURNS true when the pass RAN TO COMPLETION — including the legitimate "there was
// nothing below the window to free" early return, which is a pass doing its job — and false
// when it did not: a read that did not land, a clear that threw, a drive closing under it.
// The signature and every effect are unchanged (the two shipped callers, sdk/player.js and
// the reclaim lane, await it and ignore the value); the boolean exists because Reclaim must
// not measure a replica off the back of a pass that failed WITHOUT KNOWING WHY it failed.
// It is one of two inputs to that decision, never the whole of it — see Reclaim._checkBudget
// for the other (a probe verdict of "this filesystem cannot punch" makes a failed pass
// expected rather than suspicious, and the bound applies anyway).
//
// onWindowBytes (optional) is a SINK, not a return value: called at most once, as
// onWindowBytes(bytes, listed, resolved) — the summed blob byteLength of the listed entries
// that RESOLVED, and how much of the listing that was. Reclaim scales its byte budget by that
// window (RECLAIM_WINDOW_BUDGET_K) — the pass already had to resolve each entry to find the
// floor, so the span is free. It is a sink rather than part of the return value because the
// two shipped callers await the boolean and must not have to learn a new shape to keep
// working; the counts are extra POSITIONAL arguments for the same reason, so a sink written
// as (bytes) => ... goes on behaving exactly as it did.
//
// ⚠⚠ `listed` AND `resolved` ARE NOT DIAGNOSTICS — THEY ARE WHAT STOPS THIS SINK FROM
// UNDER-STATING THE CEILING, and the comment they replace was wrong in a way worth recording.
// It said the sink fires "only when the whole listing resolved", which quietly conflated a
// read COMPLETING with the entry EXISTING. The TIMED_OUT return below really does cover the
// first — a read that FAILED abandons the pass and can never leak a partial sum — but the
// second is the `if (!blob) continue` a few lines under it, which contributes 0 bytes for a
// listed segment whose metadata entry has not reached this replica and says nothing about it.
//
// The producer makes that routine at the live edge. broadcaster/src/hls.js mirrorDirToDrive
// puts each changed file in its OWN drive.put(), and readdirSync order puts index.m3u8 ahead
// of the segments, so the rewritten playlist lands one core append BEFORE the newest segment
// it already lists: a replica sitting on that version reads a playlist naming an entry that
// genuinely is not there yet. Its own reclaimExpiredBlobs/reconcileStaleEntries del() paths
// do the same from the other end, for a playlist body read a few appends ago.
//
// The DIRECTION of the error is what makes it matter rather than merely be untidy.
// _effectiveBudget is max(configured, k × window), so a short sum can only pull the ceiling
// DOWN, toward the flat floor the whole mechanism exists to escape — the one direction the
// arithmetic must not be able to move in. Publishing the counts lets Reclaim extrapolate to
// the full listing instead of believing a partial one; see _observeWindow for both rules.
export async function reclaimBelowWindow (drive, playlistText, onWindowBytes = null) {
  try {
    // Reclaim floor = the lowest blob offset a playlist entry still references.
    // An entry not replicated yet is skipped: its blocks are not stored locally
    // either, so a clear that overshoots it frees nothing it shouldn't.
    let min = Infinity
    let windowBytes = 0
    let listed = 0
    let resolved = 0
    for (const path of playlistUris(playlistText)) {
      listed++
      const entry = await bounded(drive.entry(path), RECLAIM_READ_MS)
      // ⚠ A READ THAT DID NOT LAND ABANDONS THE WHOLE PASS — it must not be folded into
      // the "not replicated yet, skip it" case above, which is safe only because a missing
      // entry's blocks are missing too. A read that TIMED OUT says nothing about whether
      // that segment's blob is local, and skipping it raises `min` — the floor moves UP and
      // the clear then eats blocks belonging to a segment still IN the window, i.e. the one
      // failure mode with a real cost (a refetch at the live edge, mid-playback). There is
      // no such thing as a partial floor. This was an unbounded await before, so the
      // failure could not arise; bounding it is what makes the distinction necessary.
      if (entry === TIMED_OUT) return false
      const blob = entry && entry.value && entry.value.blob
      if (!blob) continue
      resolved++
      windowBytes += blob.byteLength || 0
      if (blob.blockOffset < min) min = blob.blockOffset
    }
    // THE WINDOW'S BYTE SPAN, WITH THE LISTING IT WAS MEASURED OVER. Published only from
    // HERE — past the TIMED_OUT return above, so a FAILED read can never leak a sum at all,
    // and before the early return below, so a window whose floor is already 0 still reports
    // one. The other kind of gap, a read that succeeded and found nothing, is deliberately
    // NOT resolved here: it is carried out in `resolved` and settled by the sink's owner,
    // because this function has no way to know what a short listing ought to mean. Its own
    // try/catch because a throwing sink must not abandon a reclaim pass that has nothing
    // wrong with it.
    if (onWindowBytes && windowBytes > 0) { try { onWindowBytes(windowBytes, listed, resolved) } catch {} }
    if (min === Infinity || !(min > 0)) return true // nothing resolvable, or nothing below the window
    // Bounded for the same reason probeDriveBytes bounds it: on a replica whose metadata
    // header block never replicated, getBlobs() never settles (full account there).
    const blobs = await bounded(drive.getBlobs(), RECLAIM_READ_MS)
    if (blobs === TIMED_OUT || !blobs) return false
    // ⚠ THE PLAYLIST IS NOT THE WHOLE FEED. /thumb.jpg is a live entry that no playlist
    // ever references, and the broadcaster only refreshes it every ~30 s — so it sits
    // BELOW the window's floor for almost its entire life and a plain clear(0, min) wipes
    // the ACTIVE channel's thumbnail on every single pass. That is not merely a wasted
    // refetch: the /feedthumb route is a warm-cache-only reader, so the next request
    // resolves an entry whose blocks are gone locally and whose superseded blob may
    // already be gone at the broadcaster too — the exact stalled-read shape the idle
    // abort exists for. Punch AROUND it instead: the thumbnail's own blocks are the one
    // thing below the floor that is still wanted.
    const keep = await thumbBlockRange(drive, min)
    // ⚠ AND WHEN THE THUMBNAIL'S OWN BLOCKS COULD NOT BE READ, DO NOTHING AT ALL. This used
    // to fall through to the plain clear(0, min) on any throw — the fallback was written
    // when the only caller was a fire-and-forget serve on the feed the viewer was actively
    // watching, where an unreadable /thumb.jpg entry was near-impossible. reclaimIdleFeed
    // put the same code on ~11 more drives a minute, every one of them a COLD replica whose
    // metadata is exactly the thing most likely not to answer — and over-clearing there
    // wipes /thumb.jpg for a feed a grid cell may be mid-read on, which is not a wasted
    // refetch but the stalled-read hang described above. Skip, and take the floor again on
    // the next tick, when the entry will very likely read.
    if (keep === THUMB_UNKNOWN) return false
    if (!keep) { await blobs.core.clear(0, min); return true }
    if (keep.start > 0) await blobs.core.clear(0, keep.start)
    if (keep.end < min) await blobs.core.clear(keep.end, min)
    return true
  } catch { /* a reclaim is best-effort by construction */ }
  return false
}

// The live playlist at the root of every feed drive — the entry point reclaimIdleFeed
// resolves a window from. It is the same path the handler rewrites '/' to, and the one
// the broadcaster's mirror writes (broadcaster/src/hls.js), which is why an IDLE feed can
// be swept without the host telling this file anything about the feed's shape.
const INDEX_PATH = '/index.m3u8'

// Bound on the one blocking read reclaimIdleFeed does. A sweep runs off the critical path,
// but /index.m3u8 is the ROLLING blob par excellence — the broadcaster frees the previous
// version the instant it writes the next (see the STALLED-READ ABORT note in the header),
// so an idle replica that lagged a rotation resolves an entry whose blob no peer holds and
// a plain drive.get() on it waits FOREVER. That would wedge the caller's sweep, not just
// this pass. Same failure the serve path aborts out of; same treatment here.
const IDLE_READ_MS = 5000

// ONE reclaim pass over a feed NOBODY IS WATCHING. Never throws.
//
// The reason this exists: reclaim is triggered by serving a live .m3u8 for a `media: true`
// target, and only the ACTIVE feed is ever marked media: true — so a viewer with a warm
// feed cache has, at any moment, one feed being reclaimed and N-1 feeds that were left
// exactly as big as they were when the viewer zapped away from them. On a platform where
// clear() works those N-1 are already small (they stopped growing when they stopped
// replicating). On one where it does not, they are however big the session made them, and
// they stay that way until the cache evicts them. A host sweep calls this on each of them.
//
// VOD IS NEVER RECLAIMED — an #EXT-X-ENDLIST playlist returns before touching anything.
// That is the same invariant the serve path enforces (scenario B of the reclaim test
// lane); it is restated here rather than delegated because this entry point does not go
// through the serve path's ENDLIST branch at all, and a viewer seeks VOD arbitrarily, so
// its replica is a cache and freeing "expired" blocks in it would just cost a refetch.
export async function reclaimIdleFeed (drive) {
  try {
    // Raced against a timer, not awaited plainly — see IDLE_READ_MS. bounded() folds a
    // REJECTED read into the same "no answer" as a timed-out one, which is the whole of what
    // this call needs from it; the loser of that race needs no handler of its own (see
    // bounded(), where the reason an earlier comment gave for one is corrected).
    //
    // ⚠ THIS USED TO BE THE ONLY BOUNDED READ IN THE SWEEP. Everything reclaimBelowWindow
    // does after it — one drive.entry() per playlist URI, getBlobs(), the /thumb.jpg entry
    // — was unbounded, which was survivable while reclaim was fire-and-forget off a serve
    // and is not now that this function AWAITS it in the host's sequential sweep loop.
    // They are all bounded at RECLAIM_READ_MS; this one keeps its own, longer bound
    // because it is a BODY read of a rolling blob, not a metadata read.
    const buf = await bounded(drive.get(INDEX_PATH), IDLE_READ_MS)
    if (buf === TIMED_OUT || !buf) return // no playlist in this replica (never tuned, purged, or the read stalled)
    const text = buf.toString()
    if (!text) return
    if (/#EXT-X-ENDLIST/m.test(text)) return // VOD — never reclaimed
    await reclaimBelowWindow(drive, text)
  } catch { /* a sweep is best-effort by construction */ }
}

// Returned when the thumbnail's blocks could not be DETERMINED, as opposed to determined
// to be absent. The two demand opposite actions and merging them is what made the old
// fallback dangerous: "there is no thumbnail here" (null) means a plain clear(0, min) is
// exactly right, while "the entry did not read" means clearing at all may take the live
// thumbnail of a channel a grid cell is reading — see reclaimBelowWindow.
const THUMB_UNKNOWN = { unknown: true }

// The live thumbnail's blob block range, clamped to below the reclaim floor; null when
// there is nothing to protect (no entry, not replicated, already above the floor); or
// THUMB_UNKNOWN when the entry could not be read at all. One extra metadata read per
// THROTTLED pass — the same cost as one more playlist URI, paid at most once per
// reclaimIntervalMs. Never throws: a reclaim must never break a serve.
//
// ⚠ THIS USED TO RETURN null ON A THROW, i.e. an unreadable entry answered "there is no
// thumbnail" and the caller then over-cleared. Bounded and separated now — the read is
// raced like every other read on this path, and both failures land on THUMB_UNKNOWN.
async function thumbBlockRange (drive, min) {
  try {
    const entry = await bounded(drive.entry(THUMB_PATH), RECLAIM_READ_MS)
    if (entry === TIMED_OUT) return THUMB_UNKNOWN
    const blob = entry && entry.value && entry.value.blob
    if (!blob || !(blob.blockLength > 0)) return null
    const start = blob.blockOffset
    if (!(start < min)) return null // already above the floor — the plain clear misses it anyway
    return { start, end: Math.min(start + blob.blockLength, min) }
  } catch { return THUMB_UNKNOWN }
}

// Bounded wait for a drive entry. Each entry() probe is itself raced against a
// short timer: on a flapping peer a sparse metadata read CAN block, and parking
// here would turn the availability wait into the very hang it exists to avoid.
//
// ⚠ THE LOSER OF THIS RACE NEEDS NO REJECTION HANDLER OF ITS OWN, and a `.catch()` was
// briefly added to the probe here on the theory that it did. It did not, and it is gone.
// Promise.race calls .then(resolve, reject) on EVERY element it is handed, so the entry()
// promise is never orphaned: a drive purged mid-wait rejects it AFTER the timer won and that
// rejection is already handled. Measured, not assumed — the experiment and the spec reference
// are at bounded(), and sdk/player.js _measureFeed states the same rule for the same reason.
// Both rejection paths that exist here are covered without help: a rejection that WINS the
// race rejects the race, and the try/catch below turns it into a retry until the deadline.
//
// The internal-consistency check that settles it: if a raced loser really could SIGABRT the
// worklet, then _playlistServable, _boundedSig, _warmNeighbor, _maybeReresolveActiveFeed,
// _openFeedWithin and the rotation's own re-open race would every one of them be a live crash
// on a purged drive. Do not re-add the handler here without first explaining why those are
// safe.
async function waitEntry (drive, path, waitMs, pollMs) {
  const deadline = Date.now() + waitMs
  while (true) {
    let timer
    try {
      const entry = await Promise.race([
        drive.entry(path),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(pollMs * 4, 1000)) })
      ])
      if (entry && entry.value && entry.value.blob) return entry
    } catch { /* transient replica error — retry until the deadline */ } finally {
      clearTimeout(timer)
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

// IN-FLIGHT MEDIA READS PER DRIVE, so a host can DRAIN before it pulls a drive out from
// under them.
//
// The problem this solves: drive.purge() (hyperdrive 11) closes the drive and unlinks both
// cores, and sdk/player.js purges on every feed eviction and every rotation-away. Any
// pump() still piping a segment body out of that drive dies mid-response — the read stream
// errors, the client sees a truncated body on a request that already answered 200, and the
// player takes the hard-error path this whole file exists to keep it off. A rotation that
// waits for the last byte of the last in-flight segment costs a few hundred ms and is
// invisible; one that does not costs a remount.
//
// MEDIA reads only. Ancillary targets (poster art, guide files, /thumb.jpg) are refetchable
// from a warm cache and a truncated one costs a grid cell, not a playback session — making
// a rotation wait on a 300-cell grid refresh would be the wrong trade in the other
// direction. HEADs are not counted either: no body, nothing to truncate.
//
// ⚠ WHAT COUNTS AS "IN FLIGHT" IS THE WHOLE COMMITTED REQUEST, NOT JUST THE PIPE. It used
// to be only the pump — the slot was taken immediately before it — which meant a request
// parked in waitEntry, already bound to this exact drive, counted as zero and the drive
// read as drained while it was there. The full account is at the call site in
// createDriveHandler; the short version is that the drain then purged under a request that
// went on to poll a dead drive for its entire 6 s waitMs and 404, which is strictly worse
// than the instant 404 the park exists to replace.
//
// WeakMap-keyed on the drive object, the same shape ReadAhead._drives and Reclaim._last
// already use: the entry dies with the drive, so nothing here can keep a purged replica
// alive or leak a counter for a drive that will never be seen again.
class InFlight {
  constructor () {
    this._n = new WeakMap() // drive -> count of media requests bound to it and unfinished
    this._waiters = new WeakMap() // drive -> Set(resolve) waiting for that count to reach 0
  }

  count (drive) {
    return (drive && this._n.get(drive)) || 0
  }

  // Returns the leave function, which is IDEMPOTENT. That guard is no longer merely
  // defensive: the release is now reachable from the early 304/404/416 returns, from the
  // outer catch, from pump's onDone and from the response's own 'close' — several of which
  // genuinely fire for the same request (a normal response ends in pump AND then emits
  // 'close'; an aborted one can fire 'close' and 'error'). A double decrement would report
  // a drive drained while a reader is still on it, which is precisely the failure this
  // class exists to prevent, so every one of those paths may call this freely.
  enter (drive) {
    if (!drive) return () => {}
    this._n.set(drive, this.count(drive) + 1)
    let left = false
    return () => {
      if (left) return
      left = true
      const n = this.count(drive) - 1
      this._n.set(drive, n > 0 ? n : 0)
      if (n > 0) return
      const waiters = this._waiters.get(drive)
      if (!waiters) return
      this._waiters.delete(drive)
      for (const resolve of waiters) { try { resolve() } catch {} }
    }
  }

  // Resolves when this drive has no media read in flight, or when timeoutMs elapses.
  // NEVER rejects and never waits forever: a wedged read must DELAY a rotation, not
  // cancel it. Already-resolved in the common case of an idle drive, so a sweep over a
  // warm feed cache costs no timers at all.
  //
  // A non-finite or negative timeoutMs means DO NOT WAIT (0) — deliberately not "wait
  // forever". This promise's only real contract is that it always settles; honouring
  // Infinity would hand a caller a rotation that never happens, which is worse than the
  // truncated response it was trying to avoid.
  whenDrained (drive, timeoutMs) {
    if (!drive || this.count(drive) === 0) return Promise.resolve()
    const ms = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 0
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const done = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        const w = this._waiters.get(drive)
        if (w) { w.delete(done); if (w.size === 0) this._waiters.delete(drive) }
        resolve()
      }
      let waiters = this._waiters.get(drive)
      if (!waiters) { waiters = new Set(); this._waiters.set(drive, waiters) }
      waiters.add(done)
      timer = setTimeout(done, ms)
      // unref'd like every other timer this file arms in the background: a drain wait is
      // an optimisation for a rotation that is going to happen either way, and it must
      // never be the reason a Node host cannot exit. (If the loop really has nothing else
      // pending, the process is leaving and there is no rotation left to delay.) Guarded
      // because Bare's timers do not necessarily carry unref.
      if (timer && typeof timer.unref === 'function') timer.unref()
    })
  }
}

// Pipe a drive read stream into the response with backpressure and abort
// tolerance, emitting exactly `wanted` bytes from stream start (createReadStream
// end-offset semantics differ across versions — cap explicitly). Works for both
// node:http and bare-http1 responses (streamx-compatible write/drain).
//
// idleMs (0 = off): abort the response if no blob byte flows for that long. A read
// that yields zero bytes indefinitely is committed to a reclaimed blob (see the
// STALLED-READ ABORT note in the header) — without this it never flushes headers or
// ends. The clock arms before the first byte (a read that never yields one must
// abort too) and resets on every chunk, so a slow-but-progressing read is untouched.
//
// onDone (optional) fires EXACTLY ONCE, the moment this read stops being in flight, on
// every exit path there is: clean end, byte cap reached, idle abort, response error, and
// client abort. It is the in-flight counter's release (see InFlight), so a path that
// forgot to call it would leave a drive permanently "busy" and make every later drain wait
// out its full timeout. It is no longer the ONLY caller of that release — the slot is now
// taken before the availability wait, so the handler's early returns hold it too — but it
// is still the only one that covers the piping phase, which is the phase a purge truncates.
// Note the two DISTINCT terminal paths below — finish() and the
// bare 'close' handler, which deliberately does NOT call finish() because there is nothing
// left to end or destroy — hence settle() rather than a call inside finish().
function pump (rs, res, wanted, idleMs = 0, onDone = null) {
  let sent = 0
  let done = false
  let idle = null
  const clearIdle = () => { if (idle) { clearTimeout(idle); idle = null } }
  const armIdle = () => { if (!idleMs) return; clearIdle(); idle = setTimeout(() => finish(true), idleMs) }
  const settle = () => {
    if (!onDone) return
    const fn = onDone
    onDone = null // nulled BEFORE the call: a throwing callback must not re-arm itself
    try { fn() } catch {}
  }
  const finish = (abort) => {
    if (done) return
    done = true
    clearIdle()
    try { rs.destroy() } catch {}
    if (abort) { try { res.destroy() } catch {} } else { try { res.end() } catch {} }
    settle()
  }
  res.on('error', () => finish(true))
  res.on('close', () => { if (!done) { done = true; clearIdle(); try { rs.destroy() } catch {} ; settle() } })
  rs.on('data', (chunk) => {
    if (done) return
    armIdle() // progress resets the idle clock; only a fully stalled read trips it
    const out = sent + chunk.length > wanted ? chunk.subarray(0, wanted - sent) : chunk
    sent += out.length
    let ok = true
    try { ok = res.write(out) } catch { finish(true); return }
    if (sent >= wanted) { finish(false); return }
    if (!ok) {
      rs.pause()
      res.once('drain', () => { if (!done) rs.resume() })
    }
  })
  rs.on('end', () => finish(false))
  rs.on('error', () => finish(true))
  armIdle() // a read that never yields a byte (reclaimed blob) must abort, not hang
}

// Build an async (req, res) handler.
//
//   resolveTarget(pathname, req) -> { drive, path, media, idle?, etag?, reclaim? } | null
//                                 | Promise<same>
//     req is the live request, ONLY so a target can decide on something the path cannot
//     carry — today that is exactly one thing: the cast handler's optional receiver pin
//     reads req.socket.remoteAddress (sdk/player.js). Do not read the body or attach
//     listeners here.
//
//     ⚠ THE RETURN VALUE IS AWAITED. This used to be "synchronous by contract" and several
//     comments in sdk/player.js still assert that createDriveHandler never awaits it —
//     they are stale and are being corrected separately. For every resolver that returns a
//     plain object (all of them, historically) awaiting changes nothing but the microtask
//     the handler was already going to spend on waitEntry; those resolvers stay valid and
//     need no edit. What it BUYS is the ability to return a promise and PARK the request:
//     a null target is an instant 404, and an instant 404 on a media path is the single
//     most expensive answer this server can give — the player treats it as a hard error
//     and pays a ~5.5 s black remount, where a request held open for the ~1 s a feed
//     rotation takes and then answered 200 is invisible. Parking is safe here because the
//     shipped player has NO client-side read timeout at all (the "ExoPlayer 8 s" figure
//     this file used to lean on is not real on this stack — see DEFAULTS). A resolver that
//     parks still owns its own bound: this handler will wait as long as the promise takes.
//     media: true  = feed content — availability wait + read-ahead apply
//            false = ancillary (posters/art, guide files) — miss 404s immediately
//     idle:  opt IN to the STALLED-READ ABORT on a non-media target. media:true carries
//            it implicitly; this exists for the ancillary targets that are ALSO rolling
//            blobs — /thumb.jpg, which the broadcaster supersedes and clearBlob's every
//            refresh. Resolving the superseded entry then commits the read to blocks no
//            peer holds: headers flush, the body never ends, the request hangs FOREVER
//            (reproduced 2026-08-02 — 200 + headers sent, zero body bytes, no timeout).
//            The abort is the whole fix and it is deliberately separate from `media`:
//            these targets must NOT get the availability wait or the read-ahead (a grid
//            cell must 404 instantly on a cold feed, not park a request for waitMs).
//     etag:  optional cache validator (any stable string — the SDK passes the EPG
//            drive's version). Sent as a strong ETag; a matching If-None-Match
//            answers 304 with no body, so a poll of an unchanged guide costs
//            nothing — the same economy the https EPG path gets from its 304s.
//     reclaim: false opts THIS target's drive OUT of the handler's expired-block reclaim
//            (no effect when the handler never had `reclaim` on). Per TARGET, not per
//            handler, because the decision belongs to the drive being served and can
//            change at runtime: while a cast session pins a feed for a TV receiver
//            (sdk/player.js startCast), the loopback handler must not free that feed's
//            below-window blocks — the receiver buffers deeper than the phone and those
//            blocks are already unfetchable swarm-wide, so the local copy is the only
//            one left. Deciding it HERE, where the exact drive is in hand, rather than
//            through the handler-wide `reclaim` function, is what pairs the decision with
//            the drive it was made about: the handler awaits between resolveTarget and
//            the reclaim call, and a zap can swap the served drive in that window, so a
//            handler-wide predicate would apply this request's answer to a different
//            drive. It does NOT make the decision FRESH. A cast that starts after
//            resolveTarget ran and before the playlist body finishes still gets one
//            reclaim pass on the drive it just pinned, because this request already
//            answered "reclaim allowed" for it. That costs the receiver the blocks below
//            a window it has not reached yet; the opt-out holds from the next serve on.
//
// opts: { waitMs, pollMs, readAhead, liveReadAhead, reclaim, reclaimIntervalMs,
// readIdleMs, cors } — see DEFAULTS; liveReadAhead (number or function -> number, default = readAhead)
// widens the live-playlist read-ahead — Infinity replicates the whole live window
// on-device (churn headroom); a function is re-evaluated per playlist serve so the
// host can narrow it at runtime (metered network). reclaim (true, or a function ->
// boolean re-evaluated per serve; default off) clears blob blocks below the live
// window after a LIVE playlist serves for a media target — see Reclaim above; VOD
// and non-media targets are never reclaimed. readIdleMs overrides the stalled-read abort
// window per handler (the default is tuned to ExoPlayer; a cast receiver's read timeout is
// a different, longer number — see CAST_READ_IDLE_MS in sdk/player.js). cors (default OFF)
// adds the CORS headers above to every response and answers OPTIONS 204 BEFORE any drive
// read — only the LAN-scoped cast server turns it on. onError(err) is called for
// unexpected failures (the SDK routes corruption errors into store recovery).
// onOverBudget(drive, info) is called when a reclaim pass leaves a replica bigger than a
// budget — info is { trigger, bytes, blobs, meta, budgetBytes, metaBudgetBytes,
// effectiveBudgetBytes, windowBytes }, where `trigger` names which bound fired: 'budget'
// (the whole replica passed the window-scaled blob ceiling) or 'meta' (the METADATA core
// alone passed the flat metaBudgetBytes — see the paragraph at DEFAULTS; that bound is
// punch-independent, because a hole punch cannot free a Hyperbee).
// Requires `reclaim` (it is the reclaim pass that measures). It is ADVISORY: the handler
// frees nothing extra and does nothing else with the verdict. Freeing those bytes means
// discarding and re-opening the replica, which only the owner of the feed cache can do — see
// the Reclaim header for why there is no in-place remedy on the platforms where this fires.
//   ⚠ THE BUDGET IS NOT THE FLAT reclaimBudgetBytes. `budgetBytes` in info is the CONFIGURED
//   number and is unchanged, but the comparison is against `effectiveBudgetBytes` =
//   max(budgetBytes, 3 × windowBytes), where windowBytes is the byte span of the live window
//   this very pass observed. A live window is operator-settable up to 1920 s, so a flat
//   ceiling put a HEALTHY replica over budget on a fast channel; scaling to the observed
//   window makes that impossible by construction while a replica that frees nothing still
//   grows past it. Full argument at DEFAULTS and in the Reclaim header.
//   ⚠ RATE. At most once per reclaimIntervalMs per drive (it rides the reclaim throttle),
//   AND at most once per RECLAIM_MIN_ROTATE_MS (5 min) per HANDLER — the second floor is not
//   keyed on the drive because a rotation hands back a new drive and a drive-keyed timer
//   would reset exactly when it is needed.
//   ⚠ AND THE BLOB HALF CANNOT FIRE AT ALL until a capability probe has proved this store's
//   filesystem cannot hole-punch (probeHolePunch, run only when this callback is set and
//   reclaimBudgetBytes is non-zero — a host that passes no onOverBudget pays nothing for
//   any of it). Where the punch works, the reclaim pass is already doing its job and a
//   rotation would be pure cost, so the blob verdict is hard-disabled for the life of the
//   handler. A MEASURED verdict is permanent; an INCONCLUSIVE probe is re-run up to 3
//   times, at most once per reclaim tick, because its causes (ENOSPC, EMFILE, a purge
//   racing it, writeback lag) are transient. It is also skipped after a reclaim pass that
//   FAILED — unless the probe has already MEASURED that this filesystem cannot punch, in
//   which case a failed pass is the expected state and the bound still applies (that clause
//   is what covers exFAT/FAT32/network mounts, where the punch rejects rather than
//   no-ops). And it is silently disabled if the platform cannot report allocated bytes at
//   all. handler.reclaimStatus() reports which of those happened.
//   ⚠ NONE OF THAT GATES THE 'meta' TRIGGER except the last clause (unmeasurable): the
//   metadata bound exists precisely for the store the punch latch switches the blob half
//   off on, and a clear pass cannot invalidate a metadata measurement. It shares the
//   5-minute floor and the reclaim throttle, nothing else.
//
// The returned handler carries two methods for that owner, so a rotation can drain before
// it purges (drive.purge() kills in-flight reads mid-body — see InFlight):
//
//   handler.inflight(drive) -> number
//     MEDIA requests bound to that drive and not finished: everything from the moment a
//     media target is resolved (so the availability WAIT counts, see below) to the moment
//     the response ends, aborts or errors. Ancillary reads (art, guide, /thumb.jpg) and
//     HEADs are not counted.
//   handler.whenDrained(drive, timeoutMs) -> Promise<void>
//     Resolves when that count reaches 0 or timeoutMs elapses, whichever is first. Never
//     rejects — a wedged read delays a rotation, it does not cancel it. timeoutMs defaults
//     to cfg.readIdleMs, this file's own "a read that is not progressing is dead" number,
//     which is the longest a media read should ever plausibly be worth waiting on.
//
// And one for observability:
//
//   handler.reclaimStatus() -> { budgetBytes, budgetActive, metaBudgetBytes,
//                                metaBudgetActive, unmeasurable, punchTries, punch }
//     null when this handler has no `reclaim`. `punch` is probeHolePunch's answer once it has
//     one (null before that, and it never runs unless onOverBudget is set) and `punchTries`
//     is how many attempts it took — together they are the answer to "why did / didn't this
//     device ever rotate a replica", which is otherwise invisible from outside. Note
//     budgetBytes here is the CONFIGURED floor; the ceiling actually applied is scaled per
//     drive to the observed live window and is reported in the onOverBudget info instead.
//     See the Reclaim header.
export function createDriveHandler (resolveTarget, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const readAhead = cfg.readAhead > 0 ? new ReadAhead(cfg.readAhead, cfg.liveReadAhead) : null
  const reclaim = cfg.reclaim ? new Reclaim(cfg.reclaim, cfg.reclaimIntervalMs, cfg.reclaimBudgetBytes, cfg.onOverBudget, cfg.metaBudgetBytes) : null
  const inflight = new InFlight()
  const cors = cfg.cors ? CORS_HEADERS : NO_CORS

  async function handler (req, res) {
    // Declared out here so the catch below can release it — see the in-flight note further
    // down. null until a MEDIA target is bound; idempotent once it is.
    let release = null
    try {
      // Preflight: answered before resolveTarget, so it never touches a drive and never
      // depends on the cast token being right. Gating it on the token would only turn a
      // plain 404 into an opaque CORS error in the receiver's console — no more private
      // (the GET that follows still 404s) and much harder to diagnose from a TV.
      if (cfg.cors && req.method === 'OPTIONS') { res.writeHead(204, CORS_PREFLIGHT); return res.end() }

      // GET/HEAD only (plus OPTIONS above, when cors is on). A drive handler has no write
      // path, so answering POST/DELETE/TRACE with a 200 and the full body mutated nothing
      // — but it contradicted the Allow-Methods this same server advertises, and a media
      // server that answers every verb is surface with no reason to exist. RFC 9110
      // requires the Allow header on a 405, and it is the same list the preflight sends.
      //
      // ⚠ THIS GATE IS SHARED and it sits BEFORE resolveTarget, so it applies to every
      // consumer of this factory — the SDK's LOOPBACK media server and the tools/lane drive
      // server (tools/lib/serve-drive.js), not just the cast server it was added for. On
      // loopback that is the one thing the cast work changed. Precisely: GET/HEAD responses
      // are unchanged; a POST/DELETE/TRACE that used to fall through and be served as a GET
      // now answers 405. (The repeater is NOT a consumer — its opt-in status server is a
      // separate http.createServer carrying a GET-only gate of its own.) Inert for
      // everything that ships — every non-GET verb in this repo is aimed at a panel /
      // broadcaster / reseller admin API, the RN, Android, desktop and client trees issue
      // GET only (no HttpURLConnection or OkHttp anywhere in the Android sources), and the
      // serve, reclaim, epg-p2p and assets lanes pass. But inert is not "byte-for-byte
      // unchanged", and the sentence above is the version that is true.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { ...cors, Allow: cfg.cors ? 'GET, HEAD, OPTIONS' : 'GET, HEAD' })
        return res.end('method not allowed')
      }

      let urlPath = decodeURIComponent((req.url || '/').split('?')[0])
      if (urlPath === '/') urlPath = INDEX_PATH

      // AWAITED — see the resolveTarget contract above. A resolver that returns a plain
      // object costs one microtask; a resolver that returns a promise PARKS this request
      // until it settles, which is how a rotation stops costing a 404 and a remount.
      const target = await resolveTarget(urlPath, req)
      if (!target || !target.drive) { res.writeHead(404, cors); return res.end('not found') }
      const { drive, path: p, media, idle, etag } = target
      // Stalled-read abort: implicit for media, opt-in for a rolling ancillary blob.
      const idleMs = (media || idle) ? cfg.readIdleMs : 0

      // ⚠⚠ THE IN-FLIGHT SLOT IS TAKEN HERE — THE MOMENT A MEDIA TARGET IS BOUND, BEFORE
      // waitEntry — AND NOT, AS IT USED TO BE, IMMEDIATELY BEFORE pump.
      //
      // The old comment (kept below, corrected) argued for taking it "as LATE as possible …
      // so pump's onDone is the ONE and ONLY exit path the counter can take". That reasoning
      // is about bookkeeping tidiness and it lost the drain its actual job. A request that
      // has returned from resolveTarget and is sitting in waitEntry has ALREADY COMMITTED to
      // this drive — it holds a hard reference to it and will read from it and nothing else
      // — yet it counted as ZERO in flight. So whenDrained() resolved instantly, the host
      // rotated and purged the drive underneath it, drive.entry() then rejected, waitEntry's
      // catch swallowed that as a transient replica error, and the request went on polling a
      // dead drive until its full 6000 ms waitMs ran out and it 404'd. SIX SECONDS, where the
      // instant 404 this whole park/drain mechanism replaced took none — and the state that
      // puts a request in waitEntry, "the segment is not replicated at the live edge yet", is
      // the DEFINING state of the platform the drain was built for.
      //
      // The guarantees the counter already had are unchanged and are all preserved here:
      //   · HEAD is never counted — it sends no body, so a purge cannot truncate it.
      //   · ancillary (media: false) targets are never counted — a truncated poster costs a
      //     grid cell, and making a rotation wait on a 300-cell grid refresh is the wrong
      //     trade in the other direction.
      //   · enter() hands back an IDEMPOTENT release, so the ordinary case (pump's onDone)
      //     and the safety nets below cannot double-decrement and report a drive drained
      //     while a reader is still on it.
      //   · every exit path releases: the 304 and 404 returns just below, the 416 return,
      //     the outer catch, pump's onDone on all five of ITS exits (clean end, byte cap,
      //     idle abort, response error, client abort) — and, as a backstop for all of them,
      //     'close' on the response, which is what covers a client that vanishes DURING
      //     waitEntry (nothing else fires there, and the slot would otherwise be held for
      //     the full waitMs). On a normal response 'close' arrives after pump has already
      //     released, where it is a no-op.
      release = track(drive, media, req.method)
      if (release) res.on('close', release)

      // Validator short-circuit BEFORE the drive read: an unchanged guide poll
      // must not touch blocks at all.
      const etagValue = etag ? `"${etag}"` : null
      if (etagValue && req.headers['if-none-match'] === etagValue) {
        if (release) release()
        res.writeHead(304, { ...cors, ETag: etagValue }); return res.end()
      }

      let entry = await waitEntry(drive, p, media ? cfg.waitMs : 0, cfg.pollMs)
      if (!entry) {
        if (release) release()
        res.writeHead(404, cors); return res.end('not found')
      }

      const size = entry.value.blob.byteLength
      const range = req.headers.range
      const headers = {
        ...cors,
        'Content-Type': contentType(p),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        ...(etagValue ? { ETag: etagValue } : {})
      }

      // Read-ahead (and reclaim) ride the playlist request: by the time the player
      // asks for the newest segments their blocks are (being) pulled already, and
      // blocks that rotated OUT of a live window get freed. Fire-and-forget.
      // target.reclaim === false opts THIS drive out (a cast-pinned feed — see the
      // resolveTarget contract above); the read-ahead is unaffected either way.
      const mayReclaim = reclaim && target.reclaim !== false
      const prefetchAfter = (readAhead || mayReclaim) && media && p.endsWith('.m3u8')
        ? (text) => {
            if (readAhead) { try { readAhead.update(drive, text) } catch {} }
            // LIVE playlists only — the ENDLIST (VOD) branch must never reclaim.
            if (mayReclaim && !/#EXT-X-ENDLIST/m.test(String(text))) { try { reclaim.update(drive, text) } catch {} }
          }
        : null

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        const start = m && m[1] ? parseInt(m[1], 10) : 0
        const end = m && m[2] ? parseInt(m[2], 10) : size - 1
        if (isNaN(start) || isNaN(end) || start > end || end >= size) {
          if (release) release()
          res.writeHead(416, { ...cors, 'Content-Range': `bytes */${size}` }); return res.end()
        }
        const wanted = end - start + 1
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(wanted) })
        if (req.method === 'HEAD') return res.end() // never counted — track() returned null for it
        if (prefetchAfter && size <= PLAYLIST_TEXT_CAP) {
          // THE TRIGGER MUST NOT DEPEND ON THE CLIENT NOT SENDING Range. This branch used to
          // serve its 206 and fire nothing — so a player that Ranges its manifests got NO
          // read-ahead, NO reclaim, NO budget check and NO capability probe: the entire disk
          // bound quietly did not exist for it, on any ABI. ExoPlayer does not Range
          // manifests (measured on-device — the only reason production never hit this), but
          // the bound has to be a property of the SERVER, not of client politeness.
          //
          // ⚠⚠ AND THE SLICED BODY MUST NEVER BE WHAT FIRES IT. reclaimBelowWindow's floor
          // is the MINIMUM blob offset over the URIs it can see, and playlistUris over a
          // slice has lost lines. Lose the OLDEST listed line and the floor RISES — the
          // clear then eats blocks a still-listed segment owns: a refetch at the live edge,
          // mid-playback. (The TIMED_OUT abandon inside reclaimBelowWindow is no help
          // there — it protects against a READ that failed, not against a line that was
          // never in the text.) So the rejected alternative — mirror the response stream
          // exactly as the 200 branch below does — is rejected precisely because here the
          // mirror IS the slice. The trigger re-reads the WHOLE playlist from the drive
          // instead: a few KB whose blocks this very request just proved mostly warm.
          // Fire-and-forget, and BOUNDED like the one other body read of a rolling blob
          // (reclaimIdleFeed's — see IDLE_READ_MS): a superseded playlist blob's get()
          // never settles, and TIMED_OUT is truthy, so it is checked by identity like every
          // other bounded() caller. Skipped past PLAYLIST_TEXT_CAP for the same worklet-heap
          // reason the 200 branch caps its mirror; skipped for HEAD by position (the return
          // above), as the 200 branch skips it by never creating the stream.
          bounded(drive.get(p), IDLE_READ_MS)
            .then((buf) => { if (buf && buf !== TIMED_OUT) prefetchAfter(buf.toString()) })
            // Nothing else will ever look at this promise, and an unhandled rejection
            // SIGABRTs the Bare worklet — same rule as the queued truncate in
            // probeHolePunch. bounded() never rejects and prefetchAfter guards both its
            // arms, so this arm is a backstop, not a code path.
            .catch(() => {})
        }
        // pump's onDone IS this request's release, so the slot taken before waitEntry is
        // handed to the exit path that owns the rest of the request's life. (It is the same
        // idempotent function; the earlier returns above call it directly.)
        pump(drive.createReadStream(p, { start }), res, wanted, idleMs, release)
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': String(size) })
        if (req.method === 'HEAD') return res.end() // never counted — track() returned null for it
        const rs = drive.createReadStream(p)
        if (prefetchAfter) {
          // Playlists are small (a few KB) — mirror the body while piping and hand
          // it to the read-ahead once done. 'close' as well as 'end': the pump
          // destroys the read stream the moment the last byte is out, and an
          // aborted playlist still yields useful (prefix) segment names. Capped so
          // a mis-typed huge file can't balloon the worklet heap.
          let text = ''
          let fired = false
          const fire = () => { if (!fired) { fired = true; prefetchAfter(text) } }
          rs.on('data', (c) => { if (text.length < PLAYLIST_TEXT_CAP) text += c.toString() })
          rs.on('end', fire)
          rs.on('close', fire)
        }
        pump(rs, res, size, idleMs, release)
      }
    } catch (err) {
      // A media request that threw between taking its slot and handing it to pump would
      // otherwise hold the drive "busy" until whenDrained timed out on every later rotation.
      if (release) { try { release() } catch {} }
      if (opts.onError) { try { opts.onError(err) } catch {} }
      try { res.writeHead(500, cors); res.end('server error: ' + (err && err.message)) } catch {}
    }
  }

  // Take an in-flight slot for a MEDIA request and hand back its (idempotent) release, or
  // null for anything a purge cannot truncate. Called the moment the target is bound, so
  // the availability wait is inside the slot — see the long note at the call site for what
  // went wrong when it was not.
  //
  // HEAD is decided HERE rather than at the response, because that is the only place the
  // request is known before waitEntry runs. It answers with no body at all, so a purge
  // underneath it can truncate nothing.
  function track (drive, media, method) {
    if (!media || method === 'HEAD') return null
    return inflight.enter(drive)
  }

  // Drain surface for the owner of the drive — see the createDriveHandler doc above.
  // Hung on the handler function rather than returned alongside it because every existing
  // consumer (sdk/player.js, tools/lib/serve-drive.js) passes this straight to
  // http.createServer and would have to be restructured to unpack a pair.
  handler.inflight = (drive) => inflight.count(drive)
  handler.whenDrained = (drive, timeoutMs) => inflight.whenDrained(drive, timeoutMs === undefined ? cfg.readIdleMs : timeoutMs)
  // Why this handler does or does not have a byte budget — see the createDriveHandler doc.
  handler.reclaimStatus = () => (reclaim ? reclaim.status() : null)
  return handler
}
