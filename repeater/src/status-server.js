// Opt-in health/metrics endpoint for the repeater (STATUS_PORT). OFF by default:
// a stock repeater opens NO listening sockets — that property is part of its
// keyless co-tenancy story — so monitoring is something an operator deliberately
// turns on, loopback-only unless STATUS_HOST is widened (the endpoints are
// unauthenticated). Everything served here reads repeater.status(), which is
// synchronous and cheap, so a scrape never queues behind mirror I/O.
import http from 'http'

export function startStatusServer (repeater, { host = '127.0.0.1', port } = {}) {
  const startedAt = Date.now()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (req.method !== 'GET') { res.writeHead(405, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'GET only' })) }
    if (path === '/healthz') {
      const s = repeater.status()
      const armed = s.channels.reduce((n, c) => n + Object.values(c.cores).filter((t) => t.armed).length, 0)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        up: true,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        channels: s.channels.length,
        tailsArmed: armed,
        swarmConnections: s.swarm.connections
      }))
    }
    if (path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
      return res.end(renderMetrics(repeater, startedAt))
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found (GET /healthz or /metrics)' }))
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

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')

function renderMetrics (repeater, startedAt) {
  const mem = process.memoryUsage()
  const s = repeater.status()
  const lines = [
    '# HELP aliran_up 1 while the service is serving.', '# TYPE aliran_up gauge', 'aliran_up 1',
    '# HELP aliran_uptime_seconds Seconds since the repeater started.', '# TYPE aliran_uptime_seconds gauge', `aliran_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`,
    '# HELP aliran_process_resident_memory_bytes Node process RSS.', '# TYPE aliran_process_resident_memory_bytes gauge', `aliran_process_resident_memory_bytes ${mem.rss}`,
    '# HELP aliran_process_heap_used_bytes V8 heap used.', '# TYPE aliran_process_heap_used_bytes gauge', `aliran_process_heap_used_bytes ${mem.heapUsed}`,
    '# HELP aliran_repeater_channels Channels currently mirrored.', '# TYPE aliran_repeater_channels gauge', `aliran_repeater_channels ${s.channels.length}`,
    '# HELP aliran_repeater_swarm_connections Connected swarm peers (origins + viewers).', '# TYPE aliran_repeater_swarm_connections gauge', `aliran_repeater_swarm_connections ${s.swarm.connections}`,
    '# HELP aliran_repeater_held_blocks Blocks currently held per mirrored core (the serving window).', '# TYPE aliran_repeater_held_blocks gauge'
  ]
  for (const c of s.channels) {
    for (const [kind, t] of Object.entries(c.cores)) {
      lines.push(`aliran_repeater_held_blocks{stream_id="${esc(c.streamId)}",core="${kind}"} ${t.held}`)
    }
  }
  lines.push('# HELP aliran_repeater_core_peers Peers replicating each mirrored core.', '# TYPE aliran_repeater_core_peers gauge')
  for (const c of s.channels) {
    for (const [kind, t] of Object.entries(c.cores)) {
      lines.push(`aliran_repeater_core_peers{stream_id="${esc(c.streamId)}",core="${kind}"} ${t.peers}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}
