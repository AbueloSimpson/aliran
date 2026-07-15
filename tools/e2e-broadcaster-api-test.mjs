// End-to-end test for the broadcaster control API (S12a + S15a ingest engine).
// Requires ffmpeg + ffprobe on PATH and outbound UDP (public DHT).
//
// Boots a real panel (register RPC over Hyperswarm) and a ChannelManager + control
// server in-process, then over real HTTP: admin login (+lockout) → add a channel →
// START it → the channel registers with the panel and produces an encrypted P2P feed
// a fresh viewer replicates and ffprobe-validates → STOP it clean → restart works →
// the control UI (S12b) is served traversal-proof. S15a adds: typed input validation,
// an RTMP push round-trip (a second local ffmpeg is the OBS stand-in), a UDP-TS push,
// and the capability/port gates returning clean 400s. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import http from 'http'
import net from 'net'
import dgram from 'dgram'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { spawn, spawnSync } from 'child_process'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, loadSecrets } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { ChannelManager } from '../broadcaster/src/channel.js'
import { addAdmin } from '../broadcaster/src/control-auth.js'
import { startControlServer } from '../broadcaster/src/control-server.js'
import { driveHandler } from './lib/serve-drive.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(500) } throw new Error('timeout: ' + label) }
async function httpGet (port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

const ADMIN_PASSWORD = 'op-secret-password'
const dirs = {
  panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-panel-')),
  bc: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-bc-')),
  viewer: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-view-')),
  viewer2: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-view2-'))
}
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

// OS-assigned free ports for the push-listener tests (bind 0, read, release).
function freeTcpPort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
}
function freeUdpPort (...avoid) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')
    sock.once('error', reject)
    sock.bind(0, '127.0.0.1', () => {
      const p = sock.address().port
      sock.close(() => avoid.includes(p) ? freeUdpPort(...avoid).then(resolve, reject) : resolve(p))
    })
  })
}

try {
  // ===== Real panel: signed store + register RPC over Hyperswarm =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const throttle = makeThrottle(1000, 60)
  const panelSwarm = new Hyperswarm(); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: 8, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000 }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()
  log('panel: announced (register RPC live)')

  // ===== Broadcaster: manager + control API (fast Argon2 for the test) =====
  const bcConfig = {
    dataDir: dirs.bc,
    panelPubKey: b4a.toString(keys.signing.publicKey, 'hex'),
    publisherKey: b4a.toString(keys.publisher.secretKey, 'hex'),
    bootstrap: [],
    hls: { time: 2, listSize: 6 },
    argon2: { memKiB: 8192, time: 1 }
  }
  const manager = new ChannelManager(bcConfig); await manager.init(); cleanups.push(() => manager.close())

  assert.throws(() => addAdmin({ config: bcConfig, dataDir: dirs.bc }, 'op', 'short'), /8 characters/, 'weak admin password rejected')
  addAdmin({ config: bcConfig, dataDir: dirs.bc }, 'op', ADMIN_PASSWORD)

  const { port, close } = await startControlServer({ config: bcConfig, manager, dataDir: dirs.bc }, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 5, seconds: 60 } })
  cleanups.push(close)
  const base = `http://127.0.0.1:${port}`
  const api = async (method, p, body, token) => {
    const headers = {}
    if (token) headers.authorization = 'Bearer ' + token
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  log('control API listening on', base)

  // ===== Test A: auth =====
  assert.strictEqual((await api('POST', '/api/login', { username: 'op', password: 'wrong-password' })).status, 401, 'bad creds 401')
  assert.strictEqual((await api('GET', '/api/channels')).status, 401, 'missing token 401')
  const login = await api('POST', '/api/login', { username: 'op', password: ADMIN_PASSWORD })
  assert.strictEqual(login.status, 200, 'valid login')
  const token = login.body.token
  log('A: bad creds/missing token 401; valid login -> token ✓')

  // ===== Test B: channel CRUD over HTTP =====
  let r = await api('POST', '/api/channels', { id: 'api-chan', title: 'API Channel', category: 'demo', input: 'test' }, token)
  assert.strictEqual(r.status, 201, 'add channel: ' + JSON.stringify(r.body))
  const encryptionKey = r.body.encryptionKey
  // Ephemeral (RAM) feeds are session cores: no feedKey exists until the channel
  // starts — only the persisted encryption key (what user grants seal) is known.
  assert.strictEqual(r.body.feedKey, null, 'ephemeral channel has no feed key before start')
  assert.match(encryptionKey, /^[0-9a-f]{64}$/, 'channel has an encryption key')
  assert.strictEqual((await api('POST', '/api/channels', { id: 'api-chan' }, token)).status, 409, 'duplicate 409')
  assert.strictEqual((await api('POST', '/api/channels/nope/start', undefined, token)).status, 404, 'start unknown 404')

  r = await api('PATCH', '/api/channels/api-chan', { description: 'Colour bars over P2P' }, token)
  assert.strictEqual(r.status, 200, 'patch meta')

  r = await api('POST', '/api/channels', { id: 'temp-chan' }, token)
  assert.strictEqual(r.status, 201)
  r = await api('DELETE', '/api/channels/temp-chan', undefined, token)
  assert.strictEqual(r.status, 200, 'remove stopped channel')
  r = await api('GET', '/api/channels', undefined, token)
  assert.ok(!r.body.find((c) => c.id === 'temp-chan'), 'removed channel gone from the registry')
  assert.ok(r.body.find((c) => c.id === 'api-chan' && c.running === false), 'api-chan listed, stopped')
  log('B: add/patch/list/remove; duplicate 409; unknown 404 ✓')

  // ===== Test C: START over HTTP → ffmpeg + feed + panel registration =====
  r = await api('POST', '/api/channels/api-chan/start', undefined, token)
  assert.strictEqual(r.status, 200, 'start: ' + JSON.stringify(r.body))
  const feedKey = r.body.feedKey // the session feed key, minted at start
  assert.match(feedKey, /^[0-9a-f]{64}$/, 'start mints a session feed key')
  assert.strictEqual((await api('POST', '/api/channels/api-chan/start', undefined, token)).status, 400, 'double start 400')

  const st = await waitFor(async () => {
    const s = (await api('GET', '/api/channels/api-chan', undefined, token)).body
    return s.running && s.ffmpegUp && s.playlist && s.registered ? s : null
  }, 90000, 'channel running + playlist + registered with the panel')
  log('C: started over HTTP; status:', JSON.stringify({ ffmpegUp: st.ffmpegUp, playlist: st.playlist, registered: st.registered }))

  // ===== Test D: the panel reflects the registration =====
  const cat = (await db.get('catalog/api-chan')).value
  assert.strictEqual(cat.feedKey, feedKey, 'panel catalog has the feed key')
  assert.strictEqual(cat.title, 'API Channel')
  assert.strictEqual(cat.isLive, true)
  assert.strictEqual(loadSecrets(dirs.panel)['api-chan'], encryptionKey, 'panel stored the encryption key privately')
  log('D: panel catalog + private secret written by the register RPC ✓')

  // ===== Test E: a fresh viewer replicates and ffprobe-validates the feed =====
  // (helper — reused by the S15a RTMP push case in Test J)
  async function ffprobeValidateFeed (feedKeyHex, encKeyHex, storeDir) {
    const viewStore = new Corestore(storeDir); await viewStore.ready(); cleanups.push(() => viewStore.close())
    const replica = new Hyperdrive(viewStore, b4a.from(feedKeyHex, 'hex'), { encryptionKey: b4a.from(encKeyHex, 'hex') })
    await replica.ready()
    const viewSwarm = new Hyperswarm(); cleanups.push(() => viewSwarm.destroy())
    viewSwarm.on('connection', (s) => replica.replicate(s))
    viewSwarm.join(replica.discoveryKey, { server: false, client: true })

    const media = http.createServer(driveHandler(replica))
    await new Promise((res) => media.listen(0, '127.0.0.1', res)); cleanups.push(() => new Promise((res) => media.close(res)))
    const mediaPort = media.address().port

    const playlist = await waitFor(async () => {
      const g = await httpGet(mediaPort, '/index.m3u8')
      return g.status === 200 && g.body.includes('.ts') ? g.body.toString() : null
    }, 60000, 'viewer to serve the replicated playlist')
    const segName = (playlist.match(/[^\s]+\.ts/) || [])[0]
    const seg = await httpGet(mediaPort, '/' + segName)
    const segPath = path.join(os.tmpdir(), `e2eb-seg-${Date.now()}.ts`)
    fs.writeFileSync(segPath, seg.body)
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', segPath], { encoding: 'utf8' })
    try { fs.rmSync(segPath) } catch {}
    assert.match((probe.stdout || '').trim(), /video/, 'ffprobe sees real video in the replicated segment')
  }
  await ffprobeValidateFeed(feedKey, encryptionKey, dirs.viewer)
  const peers = (await api('GET', '/api/channels/api-chan', undefined, token)).body.peers
  assert.ok(peers >= 1, 'broadcaster status reports the viewer peer')
  log(`E: viewer replicated the encrypted feed P2P; ffprobe OK; broadcaster sees ${peers} peer(s) ✓`)

  // ===== Test F: STOP clean, then restart =====
  r = await api('POST', '/api/channels/api-chan/stop', undefined, token)
  assert.strictEqual(r.status, 200, 'stop')
  let s = (await api('GET', '/api/channels/api-chan', undefined, token)).body
  assert.strictEqual(s.running, false, 'stopped')
  assert.strictEqual(s.ffmpegUp, false, 'ffmpeg down')
  assert.strictEqual((await api('POST', '/api/channels/api-chan/stop', undefined, token)).status, 400, 'double stop 400')

  r = await api('POST', '/api/channels/api-chan/start', undefined, token)
  assert.strictEqual(r.status, 200, 'restart')
  const feedKey2 = r.body.feedKey
  assert.match(feedKey2, /^[0-9a-f]{64}$/, 'restart mints a session feed key')
  assert.notStrictEqual(feedKey2, feedKey, 'ephemeral buffer: a restart is a NEW session core (no fork of the old one)')
  await waitFor(async () => {
    const x = (await api('GET', '/api/channels/api-chan', undefined, token)).body
    return x.running && x.ffmpegUp && x.playlist && x.registered ? x : null
  }, 60000, 'channel to come back after restart (incl. re-registration)')
  // The catalog follows the session key; the encryption key (what grants seal)
  // never rotates on restart — existing viewers keep decrypting.
  assert.strictEqual((await db.get('catalog/api-chan')).value.feedKey, feedKey2, 'panel catalog follows the new session feed key')
  assert.strictEqual(loadSecrets(dirs.panel)['api-chan'], encryptionKey, 'encryption key stable across restarts (grants stay valid)')
  await api('POST', '/api/channels/api-chan/stop', undefined, token)
  log('F: stop clean (ffmpeg down), double stop 400, restart = new session feedKey + catalog follows ✓')

  // ===== Test F2: admins management (S16a — parity with the panel admin API) =====
  r = await api('GET', '/api/admins', undefined, token)
  assert.strictEqual(r.status, 200)
  assert.ok(r.body.find((a) => a.name === 'op'), 'admin list shows op')
  assert.strictEqual(JSON.stringify(r.body).includes('verifier'), false, 'admin list must not leak verifiers')
  assert.strictEqual((await api('POST', '/api/admins', { username: 'op2', password: 'short' }, token)).status, 400, 'weak admin password 400')
  assert.strictEqual((await api('POST', '/api/admins', { username: 'op2', password: 'op2-password-1' }, token)).status, 201, 'admin created')
  assert.strictEqual((await api('POST', '/api/admins', { username: 'op2', password: 'op2-password-1' }, token)).status, 409, 'duplicate admin 409')
  const tokOp2 = (await api('POST', '/api/login', { username: 'op2', password: 'op2-password-1' })).body.token
  assert.ok(tokOp2, 'op2 logs in')
  assert.strictEqual((await api('POST', '/api/admins/op2/password', { password: 'op2-password-2' }, token)).status, 200, 'password rotated')
  assert.strictEqual((await api('GET', '/api/status', undefined, tokOp2)).status, 401, 'old op2 token dead after rotation')
  const tokOp2b = (await api('POST', '/api/login', { username: 'op2', password: 'op2-password-2' })).body.token
  assert.ok(tokOp2b, 'op2 logs in with the new password')
  assert.strictEqual((await api('GET', '/api/status', undefined, tokOp2b)).status, 200, 'new op2 token works')
  assert.strictEqual((await api('DELETE', '/api/admins/op2', undefined, token)).status, 200, 'admin removed')
  assert.strictEqual((await api('GET', '/api/status', undefined, tokOp2b)).status, 401, 'removed admin token dead')
  assert.strictEqual((await api('DELETE', '/api/admins/op2', undefined, token)).status, 404, 'missing admin 404')
  log('F2: control admins list/create/rotate/delete with token revocation ✓')

  // ===== Test G: lockout =====
  // Send a full threshold (5) of bad attempts back-to-back so the test doesn't
  // depend on earlier tests' attempts still being inside the 60 s throttle window.
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await api('POST', '/api/login', { username: 'op', password: 'wrong-' + i })).status, 401, 'still 401 pre-lockout')
  }
  const locked = await api('POST', '/api/login', { username: 'op', password: ADMIN_PASSWORD })
  assert.strictEqual(locked.status, 429, 'locked after threshold (even valid creds)')
  log('G: login lockout after threshold ✓')

  // ===== Test H: control UI static files (S12b; mirrors the panel's Test G) =====
  const home = await fetch(base + '/')
  assert.strictEqual(home.status, 200, 'control UI index served')
  assert.match(home.headers.get('content-type'), /text\/html/)
  assert.match(await home.text(), /Aliran/, 'index looks like the control UI')
  for (const [f, type] of [['app.js', /javascript/], ['style.css', /text\/css/]]) {
    const fr = await fetch(base + '/' + f)
    assert.strictEqual(fr.status, 200, f + ' served')
    assert.match(fr.headers.get('content-type'), type, f + ' content-type')
  }
  for (const p of ['/%2e%2e/package.json', '/..%5Cpackage.json', '/.env']) {
    assert.strictEqual((await fetch(base + p)).status, 404, p + ' must be 404')
  }
  assert.strictEqual((await fetch(base + '/index.html', { method: 'POST' })).status, 404, 'non-GET static must be 404')
  log('H: control UI static files served; traversal/backslash/dotfile guarded ✓')

  // ===== Test I: typed inputs + transcode validation over HTTP (S15a) =====
  assert.strictEqual((await api('POST', '/api/channels', { id: 'bad1', input: { kind: 'pull', url: 'file:///etc/passwd' } }, token)).status, 400, 'file: pull scheme rejected')
  assert.strictEqual((await api('POST', '/api/channels', { id: 'bad2', transcode: { encoder: 'h264_bogus' } }, token)).status, 400, 'unknown encoder rejected')
  assert.strictEqual((await api('POST', '/api/channels', { id: 'bad3', transcode: { encoder: 'copy', resolution: '720p' } }, token)).status, 400, 'copy+scale rejected')

  r = await api('POST', '/api/channels', { id: 'push-chan', title: 'Push Channel', input: { kind: 'rtmp' } }, token)
  assert.strictEqual(r.status, 201, 'rtmp push channel added: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.input.kind, 'rtmp')
  assert.strictEqual(r.body.input.port, 5000, 'auto-allocated the first ingest-range port')
  assert.match(r.body.input.streamKey, /^[A-Za-z0-9]{22}$/, 'stream key generated')
  const pushEncKey = r.body.encryptionKey
  const streamKey = r.body.input.streamKey
  assert.strictEqual(r.body.feedKey, null, 'ephemeral push channel also has no feed key before start')

  assert.strictEqual((await api('POST', '/api/channels', { id: 'clash', input: { kind: 'udp', port: 5000 } }, token)).status, 400, 'push-port uniqueness across channels')

  const rtmpPort = await freeTcpPort()
  r = await api('PATCH', '/api/channels/push-chan', { input: { kind: 'rtmp', port: rtmpPort } }, token)
  assert.strictEqual(r.status, 200, 'patch input to an explicit port')
  assert.strictEqual(r.body.input.port, rtmpPort)
  assert.strictEqual(r.body.input.streamKey, streamKey, 'PATCH inherits the stream key (kind unchanged)')
  log('I: typed input validation; auto port alloc; port uniqueness; PATCH key inheritance ✓')

  // ===== Test J: RTMP push round-trip (a 2nd local ffmpeg is the OBS stand-in) =====
  r = await api('POST', '/api/channels/push-chan/start', undefined, token)
  assert.strictEqual(r.status, 200, 'start rtmp listener: ' + JSON.stringify(r.body))
  const pushFeedKey = r.body.feedKey // session key, minted at start
  assert.match(pushFeedKey, /^[0-9a-f]{64}$/, 'push channel start mints a session feed key')
  const preState = (await api('GET', '/api/channels/push-chan', undefined, token)).body
  assert.strictEqual(preState.running, true)
  assert.strictEqual(preState.playlist, false, 'no playlist before a publisher connects')

  const pubArgs = ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '150',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-f', 'flv', `rtmp://127.0.0.1:${rtmpPort}/live/${streamKey}`]
  let pub = null
  let pubSpawns = 0
  const ensurePublisher = () => { // respawn if it raced the listener and got refused
    if (pub && pub.exitCode === null) return
    if (pubSpawns >= 4) return
    pubSpawns++
    pub = spawn('ffmpeg', pubArgs, { stdio: 'ignore' })
  }
  cleanups.push(() => { try { if (pub) pub.kill('SIGKILL') } catch {} })
  await waitFor(async () => {
    ensurePublisher()
    const s = (await api('GET', '/api/channels/push-chan', undefined, token)).body
    return s.playlist && s.registered ? s : null
  }, 90000, 'pushed stream to reach the drive + register with the panel')
  await ffprobeValidateFeed(pushFeedKey, pushEncKey, dirs.viewer2)
  assert.strictEqual((await db.get('catalog/push-chan')).value.feedKey, pushFeedKey, 'panel catalog has the push channel')
  assert.strictEqual((await api('POST', '/api/channels/push-chan/stop', undefined, token)).status, 200, 'stop push channel')
  try { if (pub) pub.kill('SIGKILL') } catch {}
  log(`J: RTMP push → HLS → encrypted P2P feed → ffprobe OK (publisher spawns: ${pubSpawns}) ✓`)

  // ===== Test K: UDP-TS push =====
  const udpPort = await freeUdpPort(rtmpPort)
  r = await api('POST', '/api/channels', { id: 'udp-chan', input: { kind: 'udp', port: udpPort, timeoutMs: 30000 } }, token)
  assert.strictEqual(r.status, 201, 'udp channel added')
  assert.strictEqual((await api('POST', '/api/channels/udp-chan/start', undefined, token)).status, 200, 'start udp listener')
  const udpPub = spawn('ffmpeg', ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '90',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-pix_fmt', 'yuv420p', '-an',
    '-f', 'mpegts', `udp://127.0.0.1:${udpPort}?pkt_size=1316`], { stdio: 'ignore' })
  cleanups.push(() => { try { udpPub.kill('SIGKILL') } catch {} })
  await waitFor(async () => {
    const s = (await api('GET', '/api/channels/udp-chan', undefined, token)).body
    return s.playlist ? s : null
  }, 60000, 'udp-ts push to reach the drive')
  assert.strictEqual((await api('POST', '/api/channels/udp-chan/stop', undefined, token)).status, 200, 'stop udp channel')
  try { udpPub.kill('SIGKILL') } catch {}
  log('K: UDP-TS push → listener demuxed → playlist in the drive ✓')

  // ===== Test L: capability gate + port pre-flight are clean 400s, no crash loops =====
  r = await api('POST', '/api/channels', { id: 'gpu-chan', input: 'test', transcode: { encoder: 'h264_nvenc' } }, token)
  assert.strictEqual(r.status, 201, 'transcode VALUES accepted at add-time (availability is a start-time check)')
  const realCaps = await manager.capabilities()
  manager._caps = Promise.resolve({ // deterministic regardless of the host's GPUs
    ...realCaps,
    protocols: { ...realCaps.protocols, srt: false },
    encoders: { ...realCaps.encoders, h264_nvenc: { listed: true, verified: false, error: 'no NVIDIA driver (stubbed)' } }
  })
  r = await api('POST', '/api/channels/gpu-chan/start', undefined, token)
  assert.strictEqual(r.status, 400, 'unverified encoder start → 400')
  assert.match(r.body.error, /h264_nvenc/)
  assert.match(r.body.error, /stubbed/, 'probe error surfaced to the operator')

  r = await api('POST', '/api/channels', { id: 'srt-chan', input: { kind: 'srt', port: await freeUdpPort(rtmpPort, udpPort), passphrase: 'super.secret_1' } }, token)
  assert.strictEqual(r.status, 201)
  r = await api('POST', '/api/channels/srt-chan/start', undefined, token)
  assert.strictEqual(r.status, 400, 'missing protocol start → 400')
  assert.match(r.body.error, /srt/)
  manager._caps = Promise.resolve(realCaps)

  const blocker = net.createServer()
  await new Promise((res) => blocker.listen(0, '0.0.0.0', res))
  const busyPort = blocker.address().port
  r = await api('POST', '/api/channels', { id: 'busy-chan', input: { kind: 'rtmp', port: busyPort } }, token)
  assert.strictEqual(r.status, 201)
  r = await api('POST', '/api/channels/busy-chan/start', undefined, token)
  assert.strictEqual(r.status, 400, 'unbindable port start → 400')
  assert.match(r.body.error, /not bindable/)
  await new Promise((res) => blocker.close(res))
  for (const id of ['gpu-chan', 'srt-chan', 'busy-chan', 'udp-chan']) {
    assert.strictEqual((await api('DELETE', '/api/channels/' + id, undefined, token)).status, 200, 'cleanup ' + id)
  }
  log('L: capability gate (encoder + protocol) and port pre-flight → clean 400s ✓')

  log('\nRESULT: PASS ✅  (control API + typed ingest: RTMP/UDP push round-trips over P2P, capability + port gates, clean stop/restart)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
