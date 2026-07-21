// End-to-end test for the broadcaster control API (S12a + S15a ingest engine).
// Requires ffmpeg + ffprobe on PATH and outbound UDP (public DHT).
//
// Boots a real panel (register RPC over Hyperswarm) and a ChannelManager + control
// server in-process, then over real HTTP: admin login (+lockout) → add a channel →
// START it → the channel registers with the panel and produces an encrypted P2P feed
// a fresh viewer replicates and ffprobe-validates → STOP it clean → restart works →
// the control UI (S12b) is served traversal-proof. S15a adds: typed input validation,
// an RTMP push round-trip (a second local ffmpeg is the OBS stand-in), a UDP-TS push,
// and the capability/port gates returning clean 400s. S15b adds: the ffmpeg log ring,
// watchdog auto-restart of a killed ffmpeg, the panel catalog flipping isLive:false on
// stop (via the one shared PanelLink), and auto-resume + stale-live catch-up across a
// simulated broadcaster restart (a 2nd ChannelManager over the same dataDir). Test P adds
// the PanelLink reconnect hardening: a panel restart under a NEW swarm identity, with an
// op stranded while it was down, self-heals via the forced topic re-lookup. Exits 0 on PASS.
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
import { makeBlobsKeyEnricher } from '../panel/src/blobs-key.js'
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
  bc2: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-bc2-')), // S15b: "restart" a broadcaster over the same dataDir
  viewer: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-view-')),
  viewer2: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-view2-')),
  viewer3: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-view3-')), // F5 hot-rotation gen0 viewer
  viewer4: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-view4-')), // F5 hot-rotation gen1 viewer
  bc3: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-bc3-')), // S20a: SWARM_MAX_PEERS cap test
  bcR: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-bcr-')), // FFMPEG_MAX_RSS_MB recycle test
  procR: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-proc-')), // fake /proc for the recycle test
  capV1: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-capv1-')),
  capV2: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-capv2-')),
  capV3: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-capv3-')),
  capB1: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-capb1-'))
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
  // S20a blobsKey enrichment, wired exactly like panel/src/index.js does it.
  const enrich = makeBlobsKeyEnricher({ store: panelStore, swarm: panelSwarm, db, dataDir: dirs.panel })
  cleanups.push(() => enrich.close())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: 8, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000, enrich }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()
  log('panel: announced (register RPC live)')

  // ===== Broadcaster: manager + control API (fast Argon2 for the test) =====
  const bcConfig = {
    dataDir: dirs.bc,
    panelPubKey: b4a.toString(keys.signing.publicKey, 'hex'),
    publisherKey: b4a.toString(keys.publisher.secretKey, 'hex'),
    bootstrap: [],
    hls: { time: 2, listSize: 6 },
    feedBuffer: 'disk', // production default; channels below opt into 'ram' explicitly
    // Scheduled rotation OFF (hours/treeMb 0) so the long test never auto-rotates; a SHORT
    // grace so Test F5's manual rotation tears the retired generation down promptly.
    feedRotate: { hours: 0, treeMb: 0, graceMs: 2000 },
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
  let r = await api('POST', '/api/channels', { id: 'api-chan', title: 'API Channel', category: 'demo', input: 'test', buffer: 'ram' }, token)
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
  // S20a: shortly after the register the panel opens the drive with its stored
  // encryptionKey and publishes the REAL blobs-core key (the repeater enabler).
  const realBlobsKey = b4a.toString((await manager.channels.get('api-chan').run.drive.getBlobs()).core.key, 'hex')
  const gotBlobsKey = await waitFor(async () => (await db.get('catalog/api-chan'))?.value?.blobsKey, 90000, 'blobsKey enrichment of api-chan')
  assert.strictEqual(gotBlobsKey, realBlobsKey, "catalog blobsKey equals the running drive's real blobs-core key")
  log('D: panel catalog + private secret written by the register RPC; blobsKey enriched async ✓')

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

  // ===== Test F3: disk buffer (the DEFAULT) keeps a STABLE feed identity =====
  // The mirror image of the RAM session-core contract: a disk-backed feed resolves a
  // deterministic feedKey BEFORE it ever starts and keeps it across restarts, so
  // returning viewers rejoin a warm DHT topic instead of cold-discovering a new one.
  r = await api('POST', '/api/channels', { id: 'disk-chan', title: 'Disk Channel', input: 'test', buffer: 'disk' }, token)
  assert.strictEqual(r.status, 201, 'add disk channel: ' + JSON.stringify(r.body))
  const diskKey = r.body.feedKey
  assert.match(diskKey || '', /^[0-9a-f]{64}$/, 'disk feed key is known before first start (deterministic identity)')
  r = await api('POST', '/api/channels/disk-chan/start', undefined, token)
  assert.strictEqual(r.status, 200, 'start disk channel: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.feedKey, diskKey, 'disk start reuses the pre-resolved feed key')
  await waitFor(async () => {
    const x = (await api('GET', '/api/channels/disk-chan', undefined, token)).body
    return x.running && x.ffmpegUp && x.playlist ? x : null
  }, 90000, 'disk channel running + playlist (disk-backed feed flows end to end)')
  await api('POST', '/api/channels/disk-chan/stop', undefined, token)
  r = await api('POST', '/api/channels/disk-chan/start', undefined, token)
  assert.strictEqual(r.status, 200, 'restart disk channel')
  assert.strictEqual(r.body.feedKey, diskKey, 'disk buffer: feedKey STABLE across restart (warm topic, no re-discovery)')
  assert.strictEqual((await db.get('catalog/disk-chan')).value.feedKey, diskKey, 'panel catalog keeps the stable disk feed key')
  await api('POST', '/api/channels/disk-chan/stop', undefined, token)
  assert.strictEqual((await api('DELETE', '/api/channels/disk-chan', undefined, token)).status, 200, 'cleanup disk-chan')
  log('F3: disk buffer keeps a stable feedKey before start + across restart (warm DHT topic) ✓')

  // ===== Test F4: changing a disk channel's SOURCE rotates its feed identity =====
  // F3 proves a disk feedKey is STABLE across a plain restart (unchanged input). Here the
  // operator PATCHes the input to a NEW source: the feedKey MUST rotate (feedGen bump → a
  // new deterministic key) so viewers drop their cached replica of the old loop. A PATCH
  // that does NOT change the source must not rotate. The encryption key (grants) stays put.
  r = await api('POST', '/api/channels', { id: 'rotate-chan', title: 'Rotate Channel', input: 'test', buffer: 'disk' }, token)
  assert.strictEqual(r.status, 201, 'add rotate channel: ' + JSON.stringify(r.body))
  const rotEncKey = r.body.encryptionKey
  const rotKey1 = r.body.feedKey
  assert.match(rotKey1 || '', /^[0-9a-f]{64}$/, 'disk feed key known before start')
  r = await api('POST', '/api/channels/rotate-chan/start', undefined, token)
  assert.strictEqual(r.body.feedKey, rotKey1, 'first start uses the pre-resolved disk key')
  // S20a: let the register land and the panel enrich blobsKey for the FIRST identity,
  // so the rotation below can prove re-enrichment against a NEW one.
  const rotBlobs1 = await waitFor(async () => {
    const rec = (await db.get('catalog/rotate-chan'))?.value
    return rec && rec.feedKey === rotKey1 ? rec.blobsKey : null
  }, 90000, 'blobsKey enrichment of rotate-chan (pre-rotation)')
  assert.strictEqual(rotBlobs1, b4a.toString((await manager.channels.get('rotate-chan').run.drive.getBlobs()).core.key, 'hex'), 'pre-rotation blobsKey is the real one')
  assert.strictEqual((await api('POST', '/api/channels/rotate-chan/stop', undefined, token)).status, 200, 'stop rotate-chan')
  // a PATCH that does NOT change the source must not churn the feed identity
  r = await api('PATCH', '/api/channels/rotate-chan', { input: 'test', description: 'same source' }, token)
  assert.strictEqual(r.body.feedKey, rotKey1, 'same-source PATCH keeps the feedKey (no gratuitous rotation)')
  assert.strictEqual(manager.channels.get('rotate-chan').meta.feedGen ?? 0, 0, 'feedGen unchanged when the source is unchanged')
  // now CHANGE the source (test → a REAL file input — the rotated feed must also
  // produce content, or the S20a re-enrichment below would have no header to read):
  // the identity must rotate
  const rotateSrc = path.join(os.tmpdir(), `e2eb-rotate-src-${Date.now()}.ts`)
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-f', 'mpegts', rotateSrc])
  cleanups.push(() => { try { fs.rmSync(rotateSrc) } catch {} })
  r = await api('PATCH', '/api/channels/rotate-chan', { input: { kind: 'file', path: rotateSrc } }, token)
  assert.strictEqual(r.status, 200, 'patch input to a new source: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.feedKey, null, 'feed identity forgotten pending the next start (rotation)')
  assert.strictEqual(manager.channels.get('rotate-chan').meta.feedGen, 1, 'feedGen bumped on a real source change')
  r = await api('POST', '/api/channels/rotate-chan/start', undefined, token)
  assert.strictEqual(r.status, 200, 'restart after source change: ' + JSON.stringify(r.body))
  const rotKey2 = r.body.feedKey
  assert.match(rotKey2, /^[0-9a-f]{64}$/, 'rotated feed key minted at start')
  assert.notStrictEqual(rotKey2, rotKey1, 'disk source change ROTATED the feedKey (clients drop the stale replica)')
  assert.strictEqual(manager.channels.get('rotate-chan').encryptionKeyHex(), rotEncKey, 'encryption key stable across the rotation (grants survive)')
  // S20a: the rotation register cleared the stale blobsKey and the panel re-enriched
  // against the NEW drive — the repeater keeps mirroring across source changes.
  const rotBlobs2 = await waitFor(async () => {
    const rec = (await db.get('catalog/rotate-chan'))?.value
    return rec && rec.feedKey === rotKey2 ? rec.blobsKey : null
  }, 90000, 'blobsKey re-enrichment of rotate-chan (post-rotation)')
  assert.notStrictEqual(rotBlobs2, rotBlobs1, 'rotation produced a different blobs core')
  assert.strictEqual(rotBlobs2, b4a.toString((await manager.channels.get('rotate-chan').run.drive.getBlobs()).core.key, 'hex'), "post-rotation blobsKey equals the NEW drive's real blobs-core key")
  assert.strictEqual((await api('POST', '/api/channels/rotate-chan/stop', undefined, token)).status, 200, 'stop rotate-chan again')
  assert.strictEqual((await api('DELETE', '/api/channels/rotate-chan', undefined, token)).status, 200, 'cleanup rotate-chan')
  log('F4: disk source change rotates the feedKey (stale-replica fix); same-source PATCH does not; grants survive; blobsKey cleared + re-enriched ✓')

  // ===== Test F5: HOT feed rotation (disk mode) bounds metadata; viewers follow live =====
  // F4 rotates across a stop/start (source change). Here the feed rotates WHILE RUNNING
  // (POST /rotate): ffmpeg is untouched, a fresh generation is minted + mirrored + announced,
  // the panel catalog follows the new feedKey (so watching viewers re-resolve live), a fresh
  // viewer replicates the ROTATED feed end to end, and after the grace window the retired
  // generation's on-disk cores are PURGED — the whole point: metadata stops accumulating.
  r = await api('POST', '/api/channels', { id: 'hotrot-chan', title: 'Hot Rotate', input: 'test', buffer: 'disk' }, token)
  assert.strictEqual(r.status, 201, 'add hotrot-chan: ' + JSON.stringify(r.body))
  const hotEnc = r.body.encryptionKey
  r = await api('POST', '/api/channels/hotrot-chan/start', undefined, token)
  assert.strictEqual(r.status, 200, 'start hotrot-chan')
  const hotKey1 = r.body.feedKey
  await waitFor(async () => {
    const x = (await api('GET', '/api/channels/hotrot-chan', undefined, token)).body
    return x.running && x.ffmpegUp && x.playlist && x.registered ? x : null
  }, 90000, 'hotrot-chan running + registered (gen 0)')
  assert.strictEqual(manager.channels.get('hotrot-chan').meta.feedGen ?? 0, 0, 'starts at generation 0')
  await ffprobeValidateFeed(hotKey1, hotEnc, dirs.viewer3) // gen0 replicates + ffprobe-validates
  // Where gen 0's metadata core lives on disk (must be gone after the rotation grace).
  const hotStoreDir = manager.channels.get('hotrot-chan').storeDir
  const gen0Disc = b4a.toString(hcrypto.discoveryKey(b4a.from(hotKey1, 'hex')), 'hex')
  const gen0CoreDir = path.join(hotStoreDir, 'cores', gen0Disc.slice(0, 2), gen0Disc.slice(2, 4), gen0Disc)
  assert.ok(fs.existsSync(gen0CoreDir), 'gen 0 metadata core is on disk before rotation')

  // HOT rotate — ffmpeg keeps running.
  r = await api('POST', '/api/channels/hotrot-chan/rotate', undefined, token)
  assert.strictEqual(r.status, 200, 'rotate hotrot-chan: ' + JSON.stringify(r.body))
  const hotKey2 = r.body.feedKey
  assert.match(hotKey2, /^[0-9a-f]{64}$/, 'rotation minted a new feedKey')
  assert.notStrictEqual(hotKey2, hotKey1, 'hot rotation moved the feedKey to a new generation')
  assert.strictEqual(r.body.feedGen, 1, 'feedGen bumped to 1')
  const hotStatus = (await api('GET', '/api/channels/hotrot-chan', undefined, token)).body
  assert.strictEqual(hotStatus.running && hotStatus.ffmpegUp, true, 'ffmpeg kept running across the hot rotation')
  assert.strictEqual(hotStatus.feedKey, hotKey2, 'status reports the rotated feedKey')
  assert.strictEqual(manager.channels.get('hotrot-chan').encryptionKeyHex(), hotEnc, 'encryption key unchanged (grants survive the hot rotation)')
  // The panel catalog follows the new feedKey — this is what makes watching viewers re-resolve.
  await waitFor(async () => (await db.get('catalog/hotrot-chan'))?.value?.feedKey === hotKey2, 30000, 'panel catalog follows the rotated feedKey')
  // A fresh viewer replicates the ROTATED feed end to end (the new generation is a real live feed).
  await ffprobeValidateFeed(hotKey2, hotEnc, dirs.viewer4)
  // After the grace window the retired generation's cores are purged (metadata bounded).
  await waitFor(async () => !fs.existsSync(gen0CoreDir), 30000, 'retired generation 0 cores purged after grace')
  assert.strictEqual((await api('POST', '/api/channels/hotrot-chan/rotate', undefined, token)).status, 200, 'a second hot rotation works too')
  assert.strictEqual((await api('POST', '/api/channels/hotrot-chan/stop', undefined, token)).status, 200, 'stop hotrot-chan')
  assert.strictEqual((await api('DELETE', '/api/channels/hotrot-chan', undefined, token)).status, 200, 'cleanup hotrot-chan')
  log('F5: hot feed rotation keeps ffmpeg live, catalog + a fresh viewer follow the new feedKey, retired generation purged ✓')

  // ===== Test F6: self-heal a CORRUPT feed store on start (unclean-exit recovery) =====
  // An unclean exit (SIGKILL/OOM/power loss/`docker stop` over its grace) can truncate a disk
  // feed's cores mid-write, so the store never reopens (EPARTIALREAD) and the channel would be
  // silently stranded on every boot. The broadcaster must self-heal: on the corruption error,
  // rotate to a fresh generation and come back live. Here we start a disk channel, stop it,
  // TRUNCATE its metadata core on disk (exactly the unclean-exit shape), and start again.
  r = await api('POST', '/api/channels', { id: 'heal-chan', title: 'Heal', input: 'test', buffer: 'disk' }, token)
  assert.strictEqual(r.status, 201, 'add heal-chan')
  const healEnc = r.body.encryptionKey
  r = await api('POST', '/api/channels/heal-chan/start', undefined, token)
  const healKey1 = r.body.feedKey
  await waitFor(async () => {
    const x = (await api('GET', '/api/channels/heal-chan', undefined, token)).body
    return x.running && x.ffmpegUp && x.playlist ? x : null
  }, 90000, 'heal-chan live (gen 0)')
  assert.strictEqual(manager.channels.get('heal-chan').meta.feedGen ?? 0, 0, 'heal-chan starts at generation 0')
  assert.strictEqual((await api('POST', '/api/channels/heal-chan/stop', undefined, token)).status, 200, 'stop heal-chan (store closes clean)')

  // Truncate the (now-closed) metadata core's tree file — an unclean-exit-style truncation.
  const healStore = manager.channels.get('heal-chan').storeDir
  const healDisc = b4a.toString(hcrypto.discoveryKey(b4a.from(healKey1, 'hex')), 'hex')
  const healTree = path.join(healStore, 'cores', healDisc.slice(0, 2), healDisc.slice(2, 4), healDisc, 'tree')
  const healBefore = fs.statSync(healTree).size
  fs.truncateSync(healTree, Math.max(0, Math.floor(healBefore / 3)))
  // Prove the store really is unreadable now: a raw reopen throws a corruption error.
  {
    const s = new Corestore(healStore); const d = new Hyperdrive(s.namespace('feed'), { encryptionKey: b4a.from(healEnc, 'hex') })
    let e = null; try { await d.ready(); await d.getBlobs() } catch (err) { e = err }
    try { await d.close() } catch {}; try { await s.close() } catch {}
    assert.ok(e && /EPARTIALREAD|corrupt|satisfy length/i.test((e.code || '') + ' ' + e.message), 'raw reopen confirms the store is corrupt: ' + (e && (e.code || e.message)))
  }

  // Start again → the broadcaster must SELF-HEAL (rotate to a fresh generation), not throw.
  r = await api('POST', '/api/channels/heal-chan/start', undefined, token)
  assert.strictEqual(r.status, 200, 'start after corruption self-heals (no throw): ' + JSON.stringify(r.body))
  const healKey2 = r.body.feedKey
  assert.match(healKey2, /^[0-9a-f]{64}$/, 'self-heal minted a feedKey')
  assert.notStrictEqual(healKey2, healKey1, 'self-heal rotated to a FRESH feedKey (the corrupt generation is abandoned)')
  assert.strictEqual(manager.channels.get('heal-chan').meta.feedGen, 1, 'self-heal bumped feedGen to a fresh generation')
  await waitFor(async () => {
    const x = (await api('GET', '/api/channels/heal-chan', undefined, token)).body
    return x.running && x.ffmpegUp && x.playlist ? x : null
  }, 90000, 'heal-chan live again on the healed generation')
  assert.strictEqual((await api('POST', '/api/channels/heal-chan/stop', undefined, token)).status, 200, 'stop heal-chan')
  assert.strictEqual((await api('DELETE', '/api/channels/heal-chan', undefined, token)).status, 200, 'cleanup heal-chan')
  log('F6: a corrupt feed store (unclean-exit truncation) self-heals on start → fresh generation, channel live ✓')

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
  // Throttle is keyed on (username | ip). Use a username no other test touches so the
  // count starts fresh here — otherwise this races the 60 s window against how long the
  // earlier tests took (the shared PanelLink registers fast enough that op's earlier
  // attempts can still be in-window). The lock is enforced BEFORE credential checks, so
  // it's creds-independent by construction: threshold (5) attempts pass, the next locks.
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await api('POST', '/api/login', { username: 'lockme', password: 'wrong-' + i })).status, 401, 'still 401 pre-lockout')
  }
  const locked = await api('POST', '/api/login', { username: 'lockme', password: 'wrong-final' })
  assert.strictEqual(locked.status, 429, 'locked after threshold (creds no longer even checked)')
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

  r = await api('POST', '/api/channels', { id: 'push-chan', title: 'Push Channel', input: { kind: 'rtmp' }, buffer: 'ram' }, token)
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

  // ===== Test M: log ring + watchdog auto-restart + isLive:false on stop (S15b) =====
  r = await api('POST', '/api/channels', { id: 'live-chan', title: 'Live Chan', category: 'demo', input: 'test', buffer: 'disk' }, token)
  assert.strictEqual(r.status, 201, 'add live-chan: ' + JSON.stringify(r.body))
  assert.strictEqual((await api('POST', '/api/channels/live-chan/start', undefined, token)).status, 200, 'start live-chan')
  await waitFor(async () => {
    const s = (await api('GET', '/api/channels/live-chan', undefined, token)).body
    return s.running && s.ffmpegUp && s.playlist && s.registered ? s : null
  }, 90000, 'live-chan running + registered via the shared panel link')
  assert.strictEqual((await db.get('catalog/live-chan')).value.isLive, true, 'catalog isLive:true while running')

  // (1) the per-channel log ring captured ffmpeg's stderr as {t,line}
  const liveLogs = manager.logs('live-chan')
  assert.ok(Array.isArray(liveLogs) && liveLogs.length > 0, 'log ring captured ffmpeg stderr lines')
  assert.ok(liveLogs.every((e) => typeof e.t === 'number' && typeof e.line === 'string'), 'log entries are {t,line}')

  // (2) the watchdog respawns a killed ffmpeg and records a restart marker in the ring
  const liveCh = manager.channels.get('live-chan')
  const restarts0 = liveCh.run.watchdog.restarts
  try { liveCh.run.ff.kill('SIGKILL') } catch {}
  await waitFor(async () => {
    const s = (await api('GET', '/api/channels/live-chan', undefined, token)).body
    return s.running && s.watchdog && s.watchdog.restarts > restarts0 ? s : null
  }, 60000, 'watchdog to respawn the killed ffmpeg (restarts++)')
  assert.ok(manager.logs('live-chan').some((e) => /watchdog: ffmpeg restart/.test(e.line)), 'restart marker written to the log ring')

  // (3) STOP flips the catalog to isLive:false through the PanelLink; status stops claiming registered
  assert.strictEqual((await api('POST', '/api/channels/live-chan/stop', undefined, token)).status, 200, 'stop live-chan')
  const idleCat = await waitFor(async () => {
    const v = (await db.get('catalog/live-chan')).value
    return v && v.isLive === false ? v : null
  }, 10000, 'panel catalog to flip isLive:false on stop')
  assert.strictEqual(idleCat.status, 'idle', 'catalog status → idle on stop')
  assert.strictEqual((await api('GET', '/api/channels/live-chan', undefined, token)).body.registered, false, 'status.registered false after stop')
  assert.strictEqual((await api('DELETE', '/api/channels/live-chan', undefined, token)).status, 200, 'cleanup live-chan')
  log('M: ffmpeg log ring + watchdog auto-restart (marker) + stop flips catalog isLive:false ✓')

  // ===== Test N: auto-resume across a broadcaster restart + boot catch-up (S15b) =====
  // A fresh ChannelManager over the SAME dataDir is exactly what a broadcaster process
  // restart looks like: channels.json (desiredRunning) is all that carries across.
  const readReg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'channels.json'), 'utf8'))
  const bc2Config = { ...bcConfig, dataDir: dirs.bc2 }
  const mgrA = new ChannelManager(bc2Config); await mgrA.init()
  // resume-me: started → desiredRunning:true persisted → MUST auto-resume after the "restart".
  await mgrA.add('resume-me', { title: 'Resume Me', input: 'test', buffer: 'disk' })
  await mgrA.start('resume-me')
  await waitFor(() => mgrA.panelLink.isRegistered('resume-me') || null, 60000, 'resume-me to register with the panel')
  assert.strictEqual((await db.get('catalog/resume-me')).value.isLive, true, 'resume-me live before the restart')
  assert.strictEqual(readReg(dirs.bc2)['resume-me'].desiredRunning, true, 'desiredRunning:true persisted to channels.json')
  // heal-me: exists but NOT running (desiredRunning:false). Seed a STALE isLive:true catalog
  // entry (as an unclean crash would leave behind) → boot catch-up must flip it to idle.
  await mgrA.add('heal-me', { title: 'Heal Me', input: 'test', buffer: 'disk' })
  const healFeedKey = await mgrA.channels.get('heal-me').resolveFeedKey()
  await db.put('catalog/heal-me', { title: 'Heal Me', description: '', category: [], type: 'live', protection: 'self', feedKey: healFeedKey, isLive: true, poster: null, backdrop: null, logo: null, order: null, featured: false, status: 'live' })
  assert.strictEqual(readReg(dirs.bc2)['heal-me'].desiredRunning, false, 'heal-me desiredRunning:false persisted')
  await mgrA.close() // the broadcaster process "goes down"

  // "restart": a brand-new manager over the same dataDir
  const mgrB = new ChannelManager(bc2Config); await mgrB.init()
  assert.ok(mgrB.channels.get('resume-me').run, 'resume-me is running after the restart (auto-resume)')
  await waitFor(async () => (await db.get('catalog/resume-me')).value.isLive === true || null, 60000, 'resume-me re-registers isLive:true on boot')
  // heal-me was NOT resumed → boot catch-up healed its stale-live catalog entry
  await waitFor(async () => (await db.get('catalog/heal-me')).value.isLive === false || null, 10000, 'boot catch-up flips stale heal-me to isLive:false')
  assert.ok(!mgrB.channels.get('heal-me').run, 'heal-me stays stopped (desiredRunning:false)')
  // an operator stop on the resumed channel flips it idle too
  await mgrB.stop('resume-me')
  assert.strictEqual((await db.get('catalog/resume-me')).value.isLive, false, 'operator stop flips resume-me idle')
  await mgrB.close()
  log('N: desiredRunning persists → auto-resume on restart; boot catch-up heals stale-live; operator stop → idle ✓')

  // ===== Test O: S15c control surface — capabilities, logs API, state + ingest.pushUrl =====
  r = await api('GET', '/api/capabilities', undefined, token)
  assert.strictEqual(r.status, 200, 'capabilities 200')
  assert.strictEqual(r.body.ffmpeg, true, 'probe found ffmpeg')
  assert.strictEqual(typeof r.body.protocols.udp, 'boolean', 'protocol matrix present')
  assert.ok(r.body.encoders.libx264 && typeof r.body.encoders.libx264.verified === 'boolean', 'encoder matrix present')
  assert.strictEqual((await api('GET', '/api/capabilities')).status, 401, 'capabilities requires auth')

  // status carries the top-level state + operator-facing push ingest info
  s = (await api('GET', '/api/channels/push-chan', undefined, token)).body
  assert.strictEqual(s.state, 'stopped', 'stopped channel state')
  assert.ok(s.ingest && s.ingest.kind === 'rtmp' && s.ingest.port === rtmpPort, 'ingest block on a push channel')
  assert.strictEqual(s.ingest.pushUrl, `rtmp://<this-host>:${rtmpPort}/live/${streamKey}`, 'pushUrl built (no PUBLIC_HOST configured)')
  s = (await api('GET', '/api/channels/api-chan', undefined, token)).body
  assert.strictEqual(s.ingest, null, 'no ingest block on a non-push channel')

  // an idle push listener is honestly 'waiting-input', not broken
  assert.strictEqual((await api('POST', '/api/channels/push-chan/start', undefined, token)).status, 200, 'restart push listener')
  await waitFor(async () => {
    const x = (await api('GET', '/api/channels/push-chan', undefined, token)).body
    return x.state === 'waiting-input' ? x : null
  }, 30000, 'push listener state → waiting-input')

  // the log ring reaches the API, lines=N caps it, unknown channel 404s
  assert.strictEqual((await api('POST', '/api/channels/api-chan/start', undefined, token)).status, 200, 'start api-chan for logs')
  const lg = await waitFor(async () => {
    const x = (await api('GET', '/api/channels/api-chan/logs?lines=5', undefined, token)).body
    return x.lines && x.lines.length > 0 ? x : null
  }, 60000, 'log ring to reach the API')
  assert.ok(lg.lines.length <= 5, 'lines=N respected')
  assert.ok(lg.lines.every((e) => typeof e.t === 'number' && typeof e.line === 'string'), 'log entries are {t,line}')
  assert.strictEqual(lg.running, true, 'logs response carries running')
  assert.strictEqual(typeof lg.restarts, 'number', 'logs response carries restarts')
  assert.ok(['starting', 'up', 'backoff'].includes(lg.state), 'logs response carries state')
  assert.strictEqual((await api('GET', '/api/channels/nope/logs', undefined, token)).status, 404, 'logs of unknown channel 404')
  assert.strictEqual((await api('POST', '/api/channels/api-chan/stop', undefined, token)).status, 200, 'stop api-chan')
  assert.strictEqual((await api('POST', '/api/channels/push-chan/stop', undefined, token)).status, 200, 'stop push-chan')

  // the shipped UI carries the S15c surfaces (static asserts, Test H style)
  const uiJs = await (await fetch(base + '/app.js')).text()
  assert.ok(uiJs.includes('/api/capabilities'), 'UI fetches the capability probe')
  assert.ok(uiJs.includes('logs?lines='), 'UI has the logs fetch')
  // Bind to the STATE KEY, not the badge copy: the label was shortened to fit the channel
  // table (the long wording moved to the badge tooltip) and a copy-only assert made that
  // read as a regression. The state key is the durable contract with the API.
  assert.ok(uiJs.includes("case 'waiting-input'"), 'UI handles the waiting-input state')
  assert.ok(uiJs.includes('WAITING FOR PUBLISHER'), 'UI still explains the push wait somewhere')
  const uiHtml = await (await fetch(base + '/')).text()
  assert.ok(uiHtml.includes('nc-kind'), 'UI add form has the input-kind selector')
  log('O: capabilities endpoint; status state+ingest.pushUrl; logs API (cap, 404); waiting-input; UI statics ✓')

  // ===== Test P: panel restart under a NEW swarm identity — stranded ops self-heal =====
  // The 2026-07-16 VPS incident: panel + broadcaster bounced together, the panel came back
  // under a fresh swarm keypair (its Hyperswarm identity is ephemeral), and the broadcaster's
  // pre-restart topic lookup left every channel registered:false / lastError:null until a
  // manual broadcaster restart. The PanelLink now force-refreshes the topic lookup (5 s → 60 s
  // backoff) while ops are stranded, so this MUST recover with no broadcaster restart.
  assert.strictEqual((await api('POST', '/api/channels/api-chan/start', undefined, token)).status, 200, 'start api-chan (panel-restart test)')
  await waitFor(() => manager.panelLink.isRegistered('api-chan') || null, 60000, 'api-chan registered before the panel restart')
  await panelSwarm.destroy() // the panel "goes down", taking the broadcaster's socket with it
  await waitFor(() => !manager.panelLink.health().connected || null, 30000, 'link notices the panel is gone')
  // An operator stop while the panel is down strands an isLive:false op in the queue
  // (stop() waits ≤5 s for the flush, then proceeds — it must not hang).
  assert.strictEqual((await api('POST', '/api/channels/api-chan/stop', undefined, token)).status, 200, 'stop succeeds while the panel is down')
  assert.strictEqual((await db.get('catalog/api-chan')).value.isLive, true, 'catalog still (stale) live — the op is stranded')
  // Status names the blocker instead of the incident's silent registered:false/lastError:null.
  await waitFor(async () => {
    const x = (await api('GET', '/api/channels/api-chan', undefined, token)).body
    return /no panel connection for \d+s/.test(x.registerError || '') ? x : null
  }, 45000, 'status surfaces "no panel connection for Ns"')
  // The panel returns with the SAME signing keys (same topic) but a NEW swarm identity —
  // exactly what a container restart does.
  const panelSwarm2 = new Hyperswarm(); cleanups.push(() => panelSwarm2.destroy())
  panelSwarm2.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: 8, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000 }) })
  panelSwarm2.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm2.flush()
  // Without the forced re-lookup this waits on hyperswarm's ~10-min topic refresh and times out.
  await waitFor(async () => (await db.get('catalog/api-chan')).value.isLive === false || null, 120000, 'stranded isLive:false lands after the panel returns (no broadcaster restart)')
  await waitFor(async () => {
    const x = (await api('GET', '/api/channels/api-chan', undefined, token)).body
    return x.registerError == null ? x : null
  }, 15000, 'registerError clears once the queue drains')
  log('P: panel restarted under a new swarm identity → stranded ops self-heal via forced topic re-lookup ✓')

  // ===== Test Q: SWARM_MAX_PEERS — per-channel connection budget (S20a) =====
  // Every channel owns its own Hyperswarm, so the budget applies PER CHANNEL (the lib
  // default 64 does too). hyperswarm 4.x only budgets outgoing dials and channel swarms
  // are server-only, so the broadcaster enforces the cap at accept time: with
  // maxPeers=2, a 3rd concurrent viewer on ONE channel is refused while a SECOND
  // channel (its own swarm, its own budget) still accepts.
  const bc3Config = {
    dataDir: dirs.bc3,
    bootstrap: [],
    hls: { time: 2, listSize: 6 },
    feedBuffer: 'ram',
    argon2: { memKiB: 8192, time: 1 },
    swarmMaxPeers: 2 // the knob under test (env SWARM_MAX_PEERS → config.swarmMaxPeers)
  }
  const mgrQ = new ChannelManager(bc3Config); await mgrQ.init(); cleanups.push(() => mgrQ.close())
  const capAEnc = (await mgrQ.add('cap-a', { input: 'test', buffer: 'ram' })).encryptionKey
  const capBEnc = (await mgrQ.add('cap-b', { input: 'test', buffer: 'ram' })).encryptionKey
  const capAKey = (await mgrQ.start('cap-a')).feedKey
  const capBKey = (await mgrQ.start('cap-b')).feedKey
  assert.strictEqual(mgrQ.channels.get('cap-a').run.swarm.maxPeers, 2, 'knob reaches the per-channel Hyperswarm')
  await waitFor(async () => (await mgrQ.get('cap-a')).playlist && (await mgrQ.get('cap-b')).playlist, 90000, 'cap channels producing')

  const capViewer = async (feedKeyHex, encKeyHex, dir) => {
    const store = new Corestore(dir); await store.ready(); cleanups.push(() => store.close())
    const replica = new Hyperdrive(store, b4a.from(feedKeyHex, 'hex'), { encryptionKey: b4a.from(encKeyHex, 'hex') })
    await replica.ready()
    const vswarm = new Hyperswarm(); cleanups.push(() => vswarm.destroy())
    vswarm.on('connection', (s) => replica.replicate(s))
    vswarm.join(replica.discoveryKey, { server: false, client: true })
    return { replica, swarm: vswarm }
  }
  // Bounded playlist read: non-null buf = this viewer really replicates the feed.
  const gotPlaylist = (v) => Promise.race([v.replica.get('/index.m3u8').catch(() => null), sleep(4000).then(() => null)])

  const v1 = await capViewer(capAKey, capAEnc, dirs.capV1)
  const v2 = await capViewer(capAKey, capAEnc, dirs.capV2)
  await waitFor(() => gotPlaylist(v1), 90000, 'viewer 1 replicates cap-a (inside the budget)')
  await waitFor(() => gotPlaylist(v2), 90000, 'viewer 2 replicates cap-a (budget now FULL)')

  // 3rd viewer on the capped channel + 1st viewer on the other channel, concurrently.
  const v3 = await capViewer(capAKey, capAEnc, dirs.capV3)
  const vB = await capViewer(capBKey, capBEnc, dirs.capB1)
  const v3Started = Date.now()
  await waitFor(() => gotPlaylist(vB), 90000, 'cap-b viewer replicates (second channel has its OWN budget)')
  // Give v3 at least as long as vB needed (plus a floor) before calling the refusal.
  await sleep(Math.max(0, 15000 - (Date.now() - v3Started)))
  assert.strictEqual(await gotPlaylist(v3), null, '3rd concurrent viewer on the capped channel gets NO data')
  assert.strictEqual(v3.swarm.connections.size, 0, "3rd viewer's connection was dropped at accept time")
  assert.ok(mgrQ.channels.get('cap-a').run.swarm.connections.size <= 2, 'cap-a swarm never exceeds its budget')
  assert.ok((await gotPlaylist(v1)) && (await gotPlaylist(v2)), 'the two in-budget viewers are unaffected')
  await mgrQ.stop('cap-a'); await mgrQ.stop('cap-b')
  log('Q: SWARM_MAX_PEERS=2 → 3rd viewer refused on that ONE channel, 2nd channel unaffected (per-channel budgets) ✓')

  // ===== Test R: FFMPEG_MAX_RSS_MB — the watchdog recycles a bloated pull ffmpeg =====
  // Long-running live-HLS pulls slowly accumulate demuxer state on some upstreams (SSAI ad
  // churn) and no input flag bounds it, so the watchdog reads VmRSS+VmSwap from
  // <procDir>/<pid>/status on its tick and past the cap recycles the process like a stalled
  // edge (same backoff, restart marker, no feed rotation). procDir is injectable, so this
  // runs on any OS: an over-cap fake status file must get the REAL ffmpeg killed + respawned,
  // and an under-cap one must not.
  const bcRConfig = {
    dataDir: dirs.bcR,
    bootstrap: [],
    hls: { time: 2, listSize: 6 },
    feedBuffer: 'ram',
    argon2: { memKiB: 8192, time: 1 },
    ffmpegMaxRssMb: 64, // the knob under test (env FFMPEG_MAX_RSS_MB → config.ffmpegMaxRssMb)
    procDir: dirs.procR // fake /proc so the sample is deterministic (and Windows-runnable)
  }
  const mgrR = new ChannelManager(bcRConfig); await mgrR.init(); cleanups.push(() => mgrR.close())
  await mgrR.add('mem-chan', { input: 'test', buffer: 'ram' })
  await mgrR.start('mem-chan')
  const memCh = mgrR.channels.get('mem-chan')
  await waitFor(async () => { const x = await mgrR.get('mem-chan'); return x.ffmpegUp && x.playlist ? x : null }, 90000, 'mem-chan producing')
  const memPid = memCh.run.ff.pid
  const memRestarts0 = memCh.run.watchdog.restarts
  const writeStatus = (rssKb, swapKb) => {
    fs.mkdirSync(path.join(dirs.procR, String(memPid)), { recursive: true })
    fs.writeFileSync(path.join(dirs.procR, String(memPid), 'status'), `Name:\tffmpeg\nVmRSS:\t   ${rssKb} kB\nVmSwap:\t   ${swapKb} kB\n`)
  }
  // under the cap: sampled (VmRSS+VmSwap) but NOT recycled
  writeStatus(20480, 1024) // 21 MB < 64 MB
  await waitFor(() => typeof memCh.run.watchdog.memMb === 'number' || null, 30000, 'watchdog samples the fake /proc status')
  assert.ok(Math.abs(memCh.run.watchdog.memMb - 21) < 0.01, 'memMb = VmRSS+VmSwap in MB (got ' + memCh.run.watchdog.memMb + ')')
  assert.strictEqual(memCh.run.watchdog.memRecycles, 0, 'under the cap → no recycle')
  assert.strictEqual(memCh.run.ff.pid, memPid, 'under the cap → ffmpeg untouched')
  // over the cap: recycled through the stall/exit machinery
  writeStatus(102400, 12288) // 112 MB > 64 MB
  const sR = await waitFor(async () => {
    const x = await mgrR.get('mem-chan')
    return x.watchdog && x.watchdog.restarts > memRestarts0 ? x : null
  }, 60000, 'watchdog to recycle the over-cap ffmpeg (restarts++)')
  assert.ok(sR.watchdog.memRecycles >= 1, 'memRecycles counted in status')
  assert.ok(mgrR.logs('mem-chan').some((e) => /watchdog: ffmpeg memory .* FFMPEG_MAX_RSS_MB .* recycling/.test(e.line)), 'memory-recycle marker in the log ring')
  assert.ok(mgrR.logs('mem-chan').some((e) => /watchdog: ffmpeg restart #/.test(e.line)), 'respawn used the standard restart marker/backoff path')
  await waitFor(async () => {
    const x = await mgrR.get('mem-chan')
    return x.ffmpegUp && x.watchdog.state === 'live' && memCh.run.ff.pid !== memPid ? x : null
  }, 60000, 'fresh ffmpeg (new pid) live again after the recycle')
  // the fresh pid has no fake status file → memMb null again, and no further recycles
  const memRecyclesAfter = memCh.run.watchdog.memRecycles
  await sleep(9000) // > 2 watchdog ticks
  assert.strictEqual(memCh.run.watchdog.memRecycles, memRecyclesAfter, 'no recycle churn once memory is back under the cap')
  assert.strictEqual((await mgrR.get('mem-chan')).ffmpegUp, true, 'channel still producing')
  await mgrR.stop('mem-chan')
  log('R: FFMPEG_MAX_RSS_MB → over-cap ffmpeg recycled (marker + backoff path, feed identity kept), under-cap untouched ✓')

  log('\nRESULT: PASS ✅  (control API + typed ingest: RTMP/UDP push round-trips over P2P, capability + port gates, clean stop/restart, S15b reliability: log ring + auto-resume + isLive:false, S15c: capabilities/logs/state/pushUrl surfaced, PanelLink self-heals a panel restart, S20a: blobsKey enrichment + per-channel SWARM_MAX_PEERS, FFMPEG_MAX_RSS_MB memory recycle)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
