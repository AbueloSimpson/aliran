// HTTP handler that serves files from a Hyperdrive with Range support.
//
// Shared reference implementation for the localhost media server. This Node version
// powers the desktop viewer (tools/viewer.js); the client's Bare worklet mirrors it
// with bare-http1 (same request/response shape).

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

function contentType (p) {
  const i = p.lastIndexOf('.')
  return (i >= 0 && TYPES[p.slice(i).toLowerCase()]) || 'application/octet-stream'
}

// Returns an (req, res) handler bound to `drive`. Optionally maps a URL prefix (e.g.
// '/assets') to a second drive via `mounts`.
export function driveHandler (drive, { mounts = {} } = {}) {
  return async function handler (req, res) {
    try {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0])
      if (urlPath === '/') urlPath = '/index.m3u8'

      // Resolve which drive serves this path (mount prefixes take precedence).
      let target = drive
      for (const [prefix, d] of Object.entries(mounts)) {
        if (urlPath.startsWith(prefix)) { target = d; urlPath = urlPath.slice(prefix.length) || '/'; break }
      }

      const entry = await target.entry(urlPath)
      if (!entry || !entry.value.blob) { res.writeHead(404); return res.end('not found') }

      const size = entry.value.blob.byteLength
      const range = req.headers.range
      const headers = {
        'Content-Type': contentType(urlPath),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      }

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        let start = m && m[1] ? parseInt(m[1], 10) : 0
        let end = m && m[2] ? parseInt(m[2], 10) : size - 1
        if (isNaN(start) || isNaN(end) || start > end || end >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end()
        }
        const wanted = end - start + 1
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`
        headers['Content-Length'] = String(wanted)
        res.writeHead(206, headers)
        if (req.method === 'HEAD') return res.end()
        // Stream from `start` and emit exactly `wanted` bytes, regardless of the
        // underlying createReadStream end-offset semantics.
        const rs = target.createReadStream(urlPath, { start })
        let sent = 0
        rs.on('data', (chunk) => {
          if (sent >= wanted) return
          const out = sent + chunk.length > wanted ? chunk.subarray(0, wanted - sent) : chunk
          sent += out.length
          res.write(out)
          if (sent >= wanted) { res.end(); rs.destroy() }
        })
        rs.on('end', () => { if (sent < wanted) res.end() })
        rs.on('error', () => { try { res.destroy() } catch {} })
      } else {
        headers['Content-Length'] = String(size)
        res.writeHead(200, headers)
        if (req.method === 'HEAD') return res.end()
        target.createReadStream(urlPath).pipe(res)
      }
    } catch (err) {
      res.writeHead(500); res.end('server error: ' + (err && err.message))
    }
  }
}
