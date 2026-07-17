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
//   download of its newest few segments, so replication overlaps the player's
//   strictly sequential fetch pattern instead of being demand-paged per segment
//   (a cold zap otherwise pays per-block round trips segment by segment).
//   Superseded downloads (segments that rotated out of the newest set) are
//   destroyed so a cleared blob can't strand a range forever.
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
// readAhead covers the 2–3 segments a player fetches before first frame.
const DEFAULTS = { waitMs: 6000, pollMs: 150, readAhead: 3 }

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
  constructor (limit) {
    this._limit = limit
    this._drives = new WeakMap() // drive -> Map(path -> range)
  }

  // Fire-and-forget: prefetch the newest `limit` segments of this playlist body.
  // Never throws, never blocks the event loop — all awaits are backgrounded.
  update (drive, text) {
    const newest = playlistUris(text).slice(-this._limit)
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
function pump (rs, res, wanted) {
  let sent = 0
  let done = false
  const finish = (abort) => {
    if (done) return
    done = true
    try { rs.destroy() } catch {}
    if (abort) { try { res.destroy() } catch {} } else { try { res.end() } catch {} }
  }
  res.on('error', () => finish(true))
  res.on('close', () => { if (!done) { done = true; try { rs.destroy() } catch {} } })
  rs.on('data', (chunk) => {
    if (done) return
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
}

// Build an async (req, res) handler.
//
//   resolveTarget(pathname) -> { drive, path, media } | null
//     media: true  = feed content — availability wait + read-ahead apply
//            false = ancillary (posters/art) — miss 404s immediately
//
// opts: { waitMs, pollMs, readAhead } — see DEFAULTS; onError(err) is called for
// unexpected failures (the SDK routes corruption errors into store recovery).
export function createDriveHandler (resolveTarget, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const readAhead = cfg.readAhead > 0 ? new ReadAhead(cfg.readAhead) : null
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

      // Read-ahead rides the playlist request: by the time the player asks for the
      // newest segments their blocks are (being) pulled already. Fire-and-forget.
      const prefetchAfter = readAhead && media && p.endsWith('.m3u8')
        ? (text) => { try { readAhead.update(drive, text) } catch {} }
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
        pump(drive.createReadStream(p, { start }), res, wanted)
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
        pump(rs, res, size)
      }
    } catch (err) {
      if (opts.onError) { try { opts.onError(err) } catch {} }
      try { res.writeHead(500); res.end('server error: ' + (err && err.message)) } catch {}
    }
  }
}
