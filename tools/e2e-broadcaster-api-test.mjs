// End-to-end test for the broadcaster control API (S12a). Requires ffmpeg + ffprobe
// on PATH and outbound UDP (public DHT).
//
// Boots a real panel (register RPC over Hyperswarm) and a ChannelManager + control
// server in-process, then over real HTTP: admin login (+lockout) → add a channel →
// START it → the channel registers with the panel and produces an encrypted P2P feed
// a fresh viewer replicates and ffprobe-validates → STOP it clean → restart works.
// Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import http from 'http'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { spawnSync } from 'child_process'
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
  viewer: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-view-'))
}
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

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
  const feedKey = r.body.feedKey
  const encryptionKey = r.body.encryptionKey
  assert.match(feedKey, /^[0-9a-f]{64}$/, 'channel has a feed key')
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
  assert.strictEqual(r.body.feedKey, feedKey, 'feed identity stable across add/start')
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
  const viewStore = new Corestore(dirs.viewer); await viewStore.ready(); cleanups.push(() => viewStore.close())
  const replica = new Hyperdrive(viewStore, b4a.from(feedKey, 'hex'), { encryptionKey: b4a.from(encryptionKey, 'hex') })
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
  const segPath = path.join(os.tmpdir(), 'e2eb-seg.ts')
  fs.writeFileSync(segPath, seg.body)
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', segPath], { encoding: 'utf8' })
  try { fs.rmSync(segPath) } catch {}
  assert.match((probe.stdout || '').trim(), /video/, 'ffprobe sees real video in the replicated segment')
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
  assert.strictEqual(r.body.feedKey, feedKey, 'feed identity stable across restart')
  await waitFor(async () => {
    const x = (await api('GET', '/api/channels/api-chan', undefined, token)).body
    return x.running && x.ffmpegUp && x.playlist ? x : null
  }, 60000, 'channel to come back after restart')
  await api('POST', '/api/channels/api-chan/stop', undefined, token)
  log('F: stop clean (ffmpeg down), double stop 400, restart with the same feed key ✓')

  // ===== Test G: lockout =====
  for (let i = 0; i < 3; i++) {
    assert.strictEqual((await api('POST', '/api/login', { username: 'op', password: 'wrong-' + i })).status, 401, 'still 401 pre-lockout')
  }
  const locked = await api('POST', '/api/login', { username: 'op', password: ADMIN_PASSWORD })
  assert.strictEqual(locked.status, 429, 'locked after threshold (even valid creds)')
  log('G: login lockout after threshold ✓')

  log('\nRESULT: PASS ✅  (channel added+started over HTTP → panel registration + ffprobe-valid P2P feed → clean stop + restart)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
