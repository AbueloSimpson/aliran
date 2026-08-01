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
//   fallback, not the fast path). Kept UNDER ExoPlayer's 8 s default read timeout.
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
//   rotation). VOD is never reclaimed. See the Reclaim class.
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
  '.webp': 'image/webp'
}

export function contentType (p) {
  const i = p.lastIndexOf('.')
  return (i >= 0 && TYPES[p.slice(i).toLowerCase()]) || 'application/octet-stream'
}

// Defaults: waitMs under ExoPlayer's 8 s read timeout; pollMs ≈ one segment write;
// readAhead covers the 2–3 segments a player fetches before first frame — hosts widen
// LIVE playlists to the whole window via liveReadAhead (the player passes Infinity,
// narrowed back to 3 on metered networks; see the LIVE-EDGE READ-AHEAD note above).
// readIdleMs (stalled-read abort) sits under ExoPlayer's 8 s read timeout too so OUR
// clean abort drives the retry — a read that yields zero bytes for this long is stuck
// on a blob the broadcaster reclaimed, not merely slow. reclaimIntervalMs throttles
// the per-drive expired-block reclaim (the `reclaim` opt — see Reclaim below); the
// live window rotates every few seconds, so once per 30 s is plenty.
const DEFAULTS = { waitMs: 6000, pollMs: 150, readAhead: 3, readIdleMs: 6000, reclaimIntervalMs: 30000 }

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
class Reclaim {
  constructor (enabled, intervalMs) {
    this._enabled = enabled // true, or a function re-evaluated per serve
    this._intervalMs = intervalMs
    this._last = new WeakMap() // drive -> epoch ms of the last reclaim
  }

  // Called with a LIVE playlist body just served for a media target. Never throws.
  update (drive, text) {
    const on = typeof this._enabled === 'function' ? this._enabled() : this._enabled
    if (!on) return
    const now = Date.now()
    if (now - (this._last.get(drive) || 0) < this._intervalMs) return
    this._last.set(drive, now)
    this._run(drive, playlistUris(text)).catch(() => {})
  }

  async _run (drive, uris) {
    // Reclaim floor = the lowest blob offset a playlist entry still references.
    // An entry not replicated yet is skipped: its blocks are not stored locally
    // either, so a clear that overshoots it frees nothing it shouldn't.
    let min = Infinity
    for (const path of uris) {
      const entry = await drive.entry(path)
      const blob = entry && entry.value && entry.value.blob
      if (!blob) continue
      if (blob.blockOffset < min) min = blob.blockOffset
    }
    if (min === Infinity || !(min > 0)) return // nothing resolvable, or nothing below the window
    const blobs = await drive.getBlobs()
    await blobs.core.clear(0, min)
  }
}

// Bounded wait for a drive entry. Each entry() probe is itself raced against a
// short timer: on a flapping peer a sparse metadata read CAN block, and parking
// here would turn the availability wait into the very hang it exists to avoid.
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
function pump (rs, res, wanted, idleMs = 0) {
  let sent = 0
  let done = false
  let idle = null
  const clearIdle = () => { if (idle) { clearTimeout(idle); idle = null } }
  const armIdle = () => { if (!idleMs) return; clearIdle(); idle = setTimeout(() => finish(true), idleMs) }
  const finish = (abort) => {
    if (done) return
    done = true
    clearIdle()
    try { rs.destroy() } catch {}
    if (abort) { try { res.destroy() } catch {} } else { try { res.end() } catch {} }
  }
  res.on('error', () => finish(true))
  res.on('close', () => { if (!done) { done = true; clearIdle(); try { rs.destroy() } catch {} } })
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
//   resolveTarget(pathname) -> { drive, path, media } | null
//     media: true  = feed content — availability wait + read-ahead apply
//            false = ancillary (posters/art) — miss 404s immediately
//
// opts: { waitMs, pollMs, readAhead, liveReadAhead, reclaim, reclaimIntervalMs } —
// see DEFAULTS; liveReadAhead (number or function -> number, default = readAhead)
// widens the live-playlist read-ahead — Infinity replicates the whole live window
// on-device (churn headroom); a function is re-evaluated per playlist serve so the
// host can narrow it at runtime (metered network). reclaim (true, or a function ->
// boolean re-evaluated per serve; default off) clears blob blocks below the live
// window after a LIVE playlist serves for a media target — see Reclaim above; VOD
// and non-media targets are never reclaimed. onError(err) is called for
// unexpected failures (the SDK routes corruption errors into store recovery).
export function createDriveHandler (resolveTarget, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const readAhead = cfg.readAhead > 0 ? new ReadAhead(cfg.readAhead, cfg.liveReadAhead) : null
  const reclaim = cfg.reclaim ? new Reclaim(cfg.reclaim, cfg.reclaimIntervalMs) : null
  return async function handler (req, res) {
    try {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0])
      if (urlPath === '/') urlPath = '/index.m3u8'

      const target = resolveTarget(urlPath)
      if (!target || !target.drive) { res.writeHead(404); return res.end('not found') }
      const { drive, path: p, media } = target

      let entry = await waitEntry(drive, p, media ? cfg.waitMs : 0, cfg.pollMs)
      if (!entry) { res.writeHead(404); return res.end('not found') }

      const size = entry.value.blob.byteLength
      const range = req.headers.range
      const headers = {
        'Content-Type': contentType(p),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      }

      // Read-ahead (and reclaim) ride the playlist request: by the time the player
      // asks for the newest segments their blocks are (being) pulled already, and
      // blocks that rotated OUT of a live window get freed. Fire-and-forget.
      const prefetchAfter = (readAhead || reclaim) && media && p.endsWith('.m3u8')
        ? (text) => {
            if (readAhead) { try { readAhead.update(drive, text) } catch {} }
            // LIVE playlists only — the ENDLIST (VOD) branch must never reclaim.
            if (reclaim && !/#EXT-X-ENDLIST/m.test(String(text))) { try { reclaim.update(drive, text) } catch {} }
          }
        : null

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        const start = m && m[1] ? parseInt(m[1], 10) : 0
        const end = m && m[2] ? parseInt(m[2], 10) : size - 1
        if (isNaN(start) || isNaN(end) || start > end || end >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end()
        }
        const wanted = end - start + 1
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(wanted) })
        if (req.method === 'HEAD') return res.end()
        pump(drive.createReadStream(p, { start }), res, wanted, media ? cfg.readIdleMs : 0)
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': String(size) })
        if (req.method === 'HEAD') return res.end()
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
          rs.on('data', (c) => { if (text.length < 262144) text += c.toString() })
          rs.on('end', fire)
          rs.on('close', fire)
        }
        pump(rs, res, size, media ? cfg.readIdleMs : 0)
      }
    } catch (err) {
      if (opts.onError) { try { opts.onError(err) } catch {} }
      try { res.writeHead(500); res.end('server error: ' + (err && err.message)) } catch {}
    }
  }
}
