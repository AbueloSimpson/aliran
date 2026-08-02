// Opt-in health endpoint (STATUS_PORT), repeater-style: OFF by default — a stock
// EPG service opens no listening sockets; loopback-only unless STATUS_HOST is
// widened (the endpoints are unauthenticated). Everything here reads synchronous,
// cheap state — a scrape never queues behind drive I/O.
import http from 'http'

export function startStatusServer ({ guide, ingest, link }, { host = '127.0.0.1', port } = {}) {
  const startedAt = Date.now()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (req.method !== 'GET') { res.writeHead(405, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'GET only' })) }
    if (path === '/healthz') {
      const g = guide.status()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        up: true,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        epoch: g.epoch,
        mappedChannels: g.mappedChannels,
        swarmConnections: g.swarmConnections,
        panelPointerDelivered: link ? link.delivered() : null
      }))
    }
    if (path === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        guide: guide.status(),
        providers: ingest ? ingest.status() : {},
        panelLink: link ? link.status() : null
      }, null, 2))
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found (GET /healthz or /status)' }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve({
      server,
      host,
      port: server.address().port,
      close: () => new Promise((r) => server.close(r))
    }))
  })
}
