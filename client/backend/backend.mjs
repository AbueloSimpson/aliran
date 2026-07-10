// Aliran client backend — runs inside the Android app via react-native-bare-kit.
//
// Bundle with:  npx bare-pack --target android --linked --out backend/app.bundle backend/backend.mjs
//
// v0.1 implements the streaming half (verified on desktop via tools/viewer.js +
// tools/e2e-stream-test.mjs): replicate an encrypted feed over Hyperswarm and serve it
// on a localhost HTTP server with Range support for react-native-video. The account/
// OPRF login + catalog resolution are v0.2 (stubbed below).
//
// IPC (line-delimited JSON) with React Native:
//   in : { panelPubKey }                  -> boot (v0.2 catalog; currently just readies swarm)
//        { username, password }           -> login (v0.2, stubbed)
//        { feedKey, encryptionKey }        -> v0.1 direct play: serve the feed, return { port }
//   out: { type:'ready' } | { type:'port', port } | { type:'streams', streams }
//        { type:'login-error'|'error', message } | { type:'status', peers }

/* global BareKit */
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import http from 'bare-http1'
import b4a from 'b4a'

const IPC = BareKit.IPC
function send (msg) { IPC.write(b4a.from(JSON.stringify(msg) + '\n')) }

let store, swarm, panelBee, server

async function ensureStore () {
  if (store) return
  store = new Corestore('./aliran-store') // Bare app storage
  await store.ready()
  swarm = new Hyperswarm()
  swarm.on('connection', (socket) => store.replicate(socket))
}

// v0.2: open the panel signed DB by pinned key, replicate, watch catalog.
async function boot (panelPubKey) {
  await ensureStore()
  panelBee = new Hyperbee(store.get({ key: b4a.from(panelPubKey, 'hex') }), {
    keyEncoding: 'utf-8', valueEncoding: 'json'
  })
  await panelBee.ready()
  swarm.join(panelBee.core.discoveryKey, { client: true })
  // TODO(v0.2): bee.watch() -> push catalog to RN; OPRF login; unwrap keys.
  send({ type: 'ready' })
}

async function login (/* username, password */) {
  // TODO(v0.2): PoW + blinded OPRF to the panel; derive wrapKey; verify; unwrap keys;
  // seal session in Keystore; then send { type:'streams', streams }.
  send({ type: 'login-error', message: 'login not implemented (v0.2)' })
}

// v0.1 direct play: given a feed's { feedKey, encryptionKey }, replicate + serve locally.
async function serveFeed (feedKeyHex, encKeyHex) {
  await ensureStore()
  const drive = new Hyperdrive(store.namespace('replica:' + feedKeyHex), b4a.from(feedKeyHex, 'hex'), {
    encryptionKey: b4a.from(encKeyHex, 'hex')
  })
  await drive.ready()
  swarm.join(drive.discoveryKey, { server: true, client: true }) // pull + re-seed (mesh)

  if (server) { try { server.close() } catch {} }
  server = http.createServer(driveRequest(drive))
  server.listen(0, '127.0.0.1', () => send({ type: 'port', port: server.address().port }))
}

// Range-capable request handler over a Hyperdrive (mirrors tools/lib/serve-drive.js,
// which is verified on desktop; bare-http1 has the same req/res shape as Node http).
function driveRequest (drive) {
  const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
  const ctype = (p) => { const i = p.lastIndexOf('.'); return (i >= 0 && TYPES[p.slice(i).toLowerCase()]) || 'application/octet-stream' }
  return async function (req, res) {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0])
      if (p === '/') p = '/index.m3u8'
      const entry = await drive.entry(p)
      if (!entry || !entry.value.blob) { res.writeHead(404); return res.end('not found') }
      const size = entry.value.blob.byteLength
      const range = req.headers.range
      const headers = { 'Content-Type': ctype(p), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        const start = m && m[1] ? parseInt(m[1], 10) : 0
        const end = m && m[2] ? parseInt(m[2], 10) : size - 1
        if (isNaN(start) || isNaN(end) || start > end || end >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end() }
        const wanted = end - start + 1
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(wanted) })
        const rs = drive.createReadStream(p, { start })
        let sent = 0
        rs.on('data', (chunk) => {
          if (sent >= wanted) return
          const out = sent + chunk.length > wanted ? chunk.subarray(0, wanted - sent) : chunk
          sent += out.length; res.write(out)
          if (sent >= wanted) { res.end(); rs.destroy() }
        })
        rs.on('end', () => { if (sent < wanted) res.end() })
        rs.on('error', () => { try { res.destroy() } catch {} })
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': String(size) })
        drive.createReadStream(p).pipe(res)
      }
    } catch (err) { res.writeHead(500); res.end('server error: ' + (err && err.message)) }
  }
}

// --- IPC dispatch ------------------------------------------------------------------
let buf = ''
IPC.on('data', (data) => {
  buf += b4a.toString(data)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const fail = (err) => send({ type: 'error', message: String(err && err.message || err) })
    if (msg.feedKey && msg.encryptionKey) serveFeed(msg.feedKey, msg.encryptionKey).catch(fail)
    else if (msg.panelPubKey) boot(msg.panelPubKey).catch(fail)
    else if (msg.username) login(msg.username, msg.password).catch(fail)
  }
})
