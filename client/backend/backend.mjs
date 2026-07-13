// Aliran client backend — runs inside the Android app via react-native-bare-kit.
//
// Bundle with:  npm run bundle-backend   (from client/)
//   -> bare-pack --preset android --builtins backend/bare-builtins.cjs --out backend/app.bundle backend/backend.mjs
// (app.bundle is a build artifact, gitignored; regenerate it as part of the app build.)
//
// Streaming (v0.1) and OPRF login (v0.2) are both wired here and verified on desktop
// via the tools/ harnesses (tools/e2e-stream-test.mjs, tools/e2e-login-test.mjs), which
// exercise the SAME login.mjs + serve logic. Session tokens / Keystore sealing are v0.2
// follow-ups (see ROADMAP).
//
// IPC (line-delimited JSON) with React Native:
//   in : { panelPubKey }              -> connect to panel (replicate DB + open RPC)
//        { username, password }       -> OPRF login -> { streams } (display metadata)
//        { streamId }                 -> play an entitled stream -> { port }
//        { feedKey, encryptionKey }   -> dev direct-play (no login)
//   out: { type:'ready' } | { type:'streams', streams } | { type:'port', port }
//        { type:'login-error'|'error', message }

/* global BareKit */
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import http from 'bare-http1'
import b4a from 'b4a'
import { panelClient, login as oprfLogin } from './login.mjs'

const IPC = BareKit.IPC
function send (msg) { IPC.write(b4a.from(JSON.stringify(msg) + '\n')) }

let store, swarm, panelBee, call, server, assetsDrive
const entitled = new Map() // streamId -> { feedKey, encryptionKey }

async function ensureStore () {
  if (store) return
  store = new Corestore('./aliran-store')
  await store.ready()
  swarm = new Hyperswarm()
  // The first connection after boot() is the panel (we join only its topic first); wire
  // the RPC there. Later feed connections are ignored for RPC (call is already set).
  swarm.on('connection', (socket) => {
    store.replicate(socket)
    if (!call && panelBee) call = panelClient(socket).call
  })
}

async function boot (panelPubKey) {
  await ensureStore()
  panelBee = new Hyperbee(store.get({ key: b4a.from(panelPubKey, 'hex') }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await panelBee.ready()
  swarm.join(hcrypto.hash(b4a.from(panelPubKey, 'hex')), { client: true, server: false })
  send({ type: 'ready' })
}

async function login (username, password) {
  if (!call) { send({ type: 'login-error', message: 'not connected to panel' }); return }
  const { streams } = await oprfLogin(call, panelBee, username, password)
  await openAssets()
  entitled.clear()
  const display = streams.map((s) => {
    entitled.set(s.id, { feedKey: s.feedKey, encryptionKey: s.encryptionKey })
    return { id: s.id, title: s.title, description: s.description, category: s.category, isLive: s.isLive, poster: s.poster }
  })
  send({ type: 'streams', streams: display })
}

async function play (streamId) {
  const keys = entitled.get(streamId)
  if (!keys) { send({ type: 'error', message: 'not entitled to ' + streamId }); return }
  await serveFeed(keys.feedKey, keys.encryptionKey)
}

// Open the panel's assets Hyperdrive (posters/art) so the localhost server can serve
// /assets/* for the OTT UI. Key is advertised in the signed DB under meta/assetsKey.
async function openAssets () {
  if (assetsDrive || !panelBee) return
  const meta = await panelBee.get('meta/assetsKey')
  if (!meta || !meta.value.key) return
  assetsDrive = new Hyperdrive(store.namespace('assets-replica'), b4a.from(meta.value.key, 'hex'))
  await assetsDrive.ready()
  swarm.join(assetsDrive.discoveryKey, { client: true, server: true })
}

// Replicate an encrypted feed + serve it on localhost with Range for react-native-video.
async function serveFeed (feedKeyHex, encKeyHex) {
  await ensureStore()
  const drive = new Hyperdrive(store.namespace('replica:' + feedKeyHex), b4a.from(feedKeyHex, 'hex'), { encryptionKey: b4a.from(encKeyHex, 'hex') })
  await drive.ready()
  swarm.join(drive.discoveryKey, { server: true, client: true }) // pull + re-seed
  if (server) { try { server.close() } catch {} }
  server = http.createServer(driveRequest(drive))
  server.listen(0, '127.0.0.1', () => send({ type: 'port', port: server.address().port }))
}

// Range-capable Hyperdrive request handler (mirrors tools/lib/serve-drive.js, verified on desktop).
function driveRequest (drive) {
  const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
  const ctype = (p) => { const i = p.lastIndexOf('.'); return (i >= 0 && TYPES[p.slice(i).toLowerCase()]) || 'application/octet-stream' }
  return async function (req, res) {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]); if (p === '/') p = '/index.m3u8'
      // /assets/* is served from the panel's assets drive (posters/art).
      let target = drive
      if (p.startsWith('/assets/') && assetsDrive) { target = assetsDrive; p = p.slice('/assets'.length) }
      const entry = await target.entry(p)
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
        const rs = target.createReadStream(p, { start })
        let sent = 0
        rs.on('data', (chunk) => { if (sent >= wanted) return; const out = sent + chunk.length > wanted ? chunk.subarray(0, wanted - sent) : chunk; sent += out.length; res.write(out); if (sent >= wanted) { res.end(); rs.destroy() } })
        rs.on('end', () => { if (sent < wanted) res.end() })
        rs.on('error', () => { try { res.destroy() } catch {} })
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': String(size) })
        target.createReadStream(p).pipe(res)
      }
    } catch (err) { res.writeHead(500); res.end('server error: ' + (err && err.message)) }
  }
}

// --- IPC dispatch ---
let buf = ''
IPC.on('data', (data) => {
  buf += b4a.toString(data)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    const fail = (err) => send({ type: 'error', message: String(err && err.message || err) })
    if (msg.feedKey && msg.encryptionKey) serveFeed(msg.feedKey, msg.encryptionKey).catch(fail)
    else if (msg.username) login(msg.username, msg.password).catch((e) => send({ type: 'login-error', message: String(e && e.message || e) }))
    else if (msg.streamId) play(msg.streamId).catch(fail)
    else if (msg.panelPubKey) boot(msg.panelPubKey).catch(fail)
  }
})
