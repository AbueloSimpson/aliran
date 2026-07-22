// End-to-end VOD test (S8a) on a LOCAL DHT testnet (never the public DHT — CI-required
// lane, so it must be deterministic). The whole chain, headless:
//
//   ffmpeg generates a small h264/aac file
//     → the LIBRARY service (control API) ingests it: probe → `-c copy` remux to HLS
//       VOD → encrypted Hyperdrive → seeds + registers `type:'vod'` + durationSec with
//       the panel under its OWN enrolled publisher (S26 scopes)
//     → the panel writes the vod record class (no isLive, status 'available', secret
//       stored privately, blobsKey enriched asynchronously — all grant machinery
//       UNCHANGED) and an unchanged re-register appends NOTHING (S29 idempotence)
//     → a granted user logs in over the SDK, resolve() serves the title on localhost:
//       ffprobe validates the SERVED VOD end-to-end, a Range read on a late segment
//       proves seek-style random access, and — the heart of the S8a SDK branch — the
//       LIVE machinery must NOT arm: no tune watchdog (a finished playlist never
//       "advances", so an armed watchdog would walk its ladder to a false error), no
//       zap-prefetch loop (instant false 'stall'), no vod segment-warming as a zap
//       neighbor, and reconnectActiveFeed() must redial WITHOUT re-arming the ladder.
//       Zapping vod↔live must arm/stand-down the live machinery cleanly on the live
//       side only.
//     → DELETE /api/titles/:id purges the title's cores from the library's disk and
//       flips the catalog record to status 'unavailable'.
//
// Requires ffmpeg + ffprobe on PATH. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Hyperbee from 'hyperbee'
import createTestnet from 'hyperdht/testnet.js'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import http from 'http'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { spawn, spawnSync } from 'child_process'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT
} from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, loadSecrets } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { makeBlobsKeyEnricher } from '../panel/src/blobs-key.js'
import { addPublisher } from '../panel/src/ops.js'
import { panelClient as pubRpc, registerWithPanel } from '../library/src/register.js'
import { startLibrary } from '../library/src/index.js'
import { addAdmin } from '../library/src/control-auth.js'
import { createPlayer } from '../sdk/index.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) }
  throw new Error('timeout: ' + label)
}
function httpReq (method, port, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (body !== undefined) req.end(JSON.stringify(body)); else req.end()
  })
}
const jbody = (r) => { try { return JSON.parse(r.body.toString('utf8')) } catch { return {} } }
// ASYNC spawn for anything that talks to a server hosted by THIS process: spawnSync
// blocks the event loop, so the localhost server could never answer — a self-deadlock
// (ffprobe would hang until its timeout against a perfectly healthy server).
function runProc (cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = ''; let err = ''
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs)
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { err += d })
    proc.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, stdout: out, stderr: String(e) }) })
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, stdout: out, stderr: err }) })
  })
}
// Count corestore core dirs (cores/<id02>/<id24>/<id64>) — how we prove delete PURGES.
function coreDirs (root) {
  const out = []
  const walk = (d, depth) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      if (depth === 2) { if (/^[0-9a-f]{64}$/.test(e.name)) out.push(e.name) } else walk(path.join(d, e.name), depth + 1)
    }
  }
  walk(path.join(root, 'cores'), 0)
  return out
}

const DIFFICULTY = 8
const PASSWORD = 'test123'
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('e2ev-panel-'), lib: tmp('e2ev-lib-'), live: tmp('e2ev-live-'), cli: tmp('e2ev-cli-'), media: tmp('e2ev-media-') }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== A small real video file (h264/aac → the ingest's auto mode picks `copy`) =====
  const movieFile = path.join(dirs.media, 'movie.mp4')
  // -g 50 (a 2 s GOP @ 25 fps): a `-c copy` remux can only split segments on the
  // source's OWN keyframes, and x264's default 250-frame GOP would make one 10 s
  // segment out of a 12 s file. Real content has a sane keyframe cadence; so does this.
  const gen = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-c:a', 'aac', '-shortest', movieFile], { encoding: 'utf8' })
  assert.strictEqual(gen.status, 0, 'ffmpeg generated the source file: ' + (gen.stderr || gen.error))
  log('media: 12s h264/aac source file generated')

  // ===== Local DHT testnet =====
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap

  // ===== Panel: keys + store + register RPC + blobsKey enrichment =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
  const enrich = makeBlobsKeyEnricher({ store: panelStore, swarm: panelSwarm, db, dataDir: dirs.panel })
  cleanups.push(() => enrich.close())
  const throttle = makeThrottle(1000, 60)
  panelSwarm.on('connection', (s) => { panelStore.replicate(s); attachLoginRpc(s, { keys, difficulty: DIFFICULTY, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000, enrich }) })
  const panelTopic = hcrypto.hash(keys.signing.publicKey)
  panelSwarm.join(panelTopic, { server: true, client: false }); await panelSwarm.flush()
  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  log('panel: announced on the testnet')

  // The library runs as its OWN enrolled publisher (S26), scoped to its title ids —
  // its register must verify against THIS key and stamp origin:'lib1'.
  const lib1 = addPublisher({ dataDir: dirs.panel }, 'lib1', { scopes: 'movie-*' })

  // ===== Library service (control API on an ephemeral port) =====
  addAdmin({ config: { argon2: { memKiB: 8192, time: 1 } }, dataDir: dirs.lib }, 'op', 'password123')
  const lib = await startLibrary({
    dataDir: dirs.lib,
    panelPubKey,
    publisherName: 'lib1',
    publisherKey: lib1.secretKey,
    hls: { time: 2 },
    ingestConcurrency: 1,
    swarmMaxPeers: 64,
    swarmRcvBuf: 0,
    swarmSndBuf: 0,
    bootstrap,
    control: { enabled: true, host: '127.0.0.1', port: 0, sessionTtlHours: 1 },
    lockout: { threshold: 100, seconds: 60 },
    argon2: { memKiB: 8192, time: 1 }
  })
  cleanups.push(() => lib.close())
  const cport = lib.control.port
  log('library: up, control API on', cport)

  // /healthz is unauthenticated liveness; everything else under /api needs the token.
  const hz = await httpReq('GET', cport, '/healthz')
  assert.strictEqual(hz.status, 200, '/healthz answers')
  assert.strictEqual(jbody(hz).ok, true, '/healthz ok')
  assert.strictEqual((await httpReq('GET', cport, '/api/titles')).status, 401, 'unauthenticated /api rejected')
  const login = await httpReq('POST', cport, '/api/login', { body: { username: 'op', password: 'password123' } })
  assert.strictEqual(login.status, 200, 'control login')
  const auth = { authorization: 'Bearer ' + jbody(login).token, 'content-type': 'application/json' }
  log('library: /healthz unauthenticated, /api gated, login OK ✓')

  // ===== Ingest a title over the control API =====
  const add = await httpReq('POST', cport, '/api/titles', { headers: auth, body: { id: 'movie-1', input: movieFile, title: 'Test Movie', description: 'A test film', category: ['Movies'] } })
  assert.strictEqual(add.status, 201, 'POST /api/titles: ' + add.body)
  // Duplicate id refused while the first exists.
  assert.strictEqual((await httpReq('POST', cport, '/api/titles', { headers: auth, body: { id: 'movie-1', input: movieFile } })).status, 409, 'duplicate id → 409')

  const ready = await waitFor(async () => {
    const r = jbody(await httpReq('GET', cport, '/api/titles/movie-1', { headers: auth }))
    if (r.state === 'error') throw new Error('ingest failed: ' + r.error)
    return r.state === 'ready' ? r : null
  }, 120000, 'ingest → ready')
  assert.ok(ready.feedKey && /^[0-9a-f]{64}$/.test(ready.feedKey), 'ready title has a feedKey')
  assert.ok(ready.durationSec >= 11 && ready.durationSec <= 13, 'durationSec ≈ 12 (got ' + ready.durationSec + ')')
  assert.ok(ready.segments >= 4, 'segmented (got ' + ready.segments + ')')
  assert.ok(ready.bytes > 100000, 'has real bytes')
  const logs = jbody(await httpReq('GET', cport, '/api/titles/movie-1/logs?lines=50', { headers: auth }))
  assert.ok(logs.lines.some((l) => /→ copy/.test(l)), 'auto mode picked `copy` for h264/aac (logs show the probe decision)')
  log(`library: ingested ${ready.segments} segments, ${ready.durationSec}s, ${(ready.bytes / 1e6).toFixed(1)} MB (copy remux) ✓`)

  // ===== Panel record: the vod class =====
  const cat = await waitFor(async () => (await db.get('catalog/movie-1'))?.value, 30000, 'catalog record')
  assert.strictEqual(cat.type, 'vod', 'record class is vod')
  assert.strictEqual(cat.durationSec, ready.durationSec, 'durationSec rides the record')
  assert.ok(!('isLive' in cat), 'vod record OMITS isLive entirely (liveness is not a property a title has)')
  assert.strictEqual(cat.status, 'available', 'vod status defaults to available')
  assert.strictEqual(cat.origin, 'lib1', 'origin stamped from the enrolled publisher')
  assert.strictEqual(cat.feedKey, ready.feedKey, 'catalog follows the title feedKey')
  assert.strictEqual(cat.encryptionKey, undefined, 'catalog must NOT contain the encryptionKey')
  assert.strictEqual(cat.title, 'Test Movie', 'library seeded the descriptive metadata')
  const secret = loadSecrets(dirs.panel)['movie-1']
  assert.ok(/^[0-9a-f]{64}$/.test(secret || ''), 'panel stored the private encryption key (grant machinery unchanged)')
  await waitFor(async () => lib.manager.get('movie-1').registered, 30000, 'library sees registered')
  log('panel: vod record class correct (type/durationSec/no-isLive/status/origin; secret stored privately) ✓')

  // blobsKey enrichment applies to vod drives exactly like live feeds (repeater enabler).
  const enriched = await waitFor(async () => (await db.get('catalog/movie-1'))?.value?.blobsKey, 90000, 'vod blobsKey enrichment')
  assert.match(enriched, /^[0-9a-f]{64}$/, 'vod record enriched with the blobs-core key')
  assert.notStrictEqual(enriched, cat.feedKey, 'blobsKey is a distinct core key')
  log('panel: vod drive blobsKey-enriched (async) ✓')

  // S29 idempotence holds for the vod class: an unchanged re-register (the library's
  // 5-min heartbeat) must append NOTHING to the append-only bee. Same payload the
  // library sends, signed with its enrolled key over a fresh connection.
  const libPayload = {
    publisher: 'lib1',
    streamId: 'movie-1',
    type: 'vod',
    feedKey: ready.feedKey,
    encryptionKey: secret,
    durationSec: ready.durationSec,
    title: 'Test Movie',
    description: 'A test film',
    category: ['Movies'],
    protection: 'self',
    status: 'available'
  }
  const regSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => regSwarm.destroy())
  let pcall = null
  regSwarm.on('connection', (s) => { if (!pcall) pcall = pubRpc(s).call })
  regSwarm.join(panelTopic, { client: true, server: false })
  await waitFor(() => pcall, 30000, 'test→panel register connection')
  await registerWithPanel(pcall, lib1.secretKey, libPayload) // may or may not append (blobsKey preservation) …
  const beeLen = db.core.length
  await registerWithPanel(pcall, lib1.secretKey, libPayload) // … but the SECOND identical one must not
  assert.strictEqual(db.core.length, beeLen, 'unchanged vod re-register appends NOTHING (S29 idempotence holds for the class)')
  log('panel: vod re-register idempotent ✓')

  // ===== A live channel beside it (synthetic ticking feed) for the interplay test =====
  const liveEnc = hcrypto.randomBytes(32)
  const liveStore = new Corestore(dirs.live); await liveStore.ready(); cleanups.push(() => liveStore.close())
  const liveDrive = new Hyperdrive(liveStore.namespace('feed'), { encryptionKey: liveEnc }); await liveDrive.ready()
  const liveSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => liveSwarm.destroy())
  liveSwarm.on('connection', (s) => liveStore.replicate(s))
  liveSwarm.join(liveDrive.discoveryKey, { server: true, client: false }); await liveSwarm.flush()
  let seq = 0
  async function tickLive () {
    const i = seq++
    const seg = Buffer.alloc(24000); seg.fill(`LIVE#${i}|`)
    await liveDrive.put(`/seg${i}.ts`, seg)
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${Math.max(0, i - 5)}`]
    for (let k = Math.max(0, i - 5); k <= i; k++) lines.push('#EXTINF:0.4,', `seg${k}.ts`)
    await liveDrive.put('/index.m3u8', b4a.from(lines.join('\n') + '\n'))
    if (i - 8 >= 0) { try { await liveDrive.del(`/seg${i - 8}.ts`) } catch {} }
  }
  await tickLive(); await tickLive(); await tickLive()
  let tickBusy = false
  const ticker = setInterval(() => { if (tickBusy) return; tickBusy = true; tickLive().catch(() => {}).then(() => { tickBusy = false }) }, 400)
  cleanups.push(() => clearInterval(ticker))
  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'ch-live', feedKey: b4a.toString(liveDrive.key, 'hex'), encryptionKey: b4a.toString(liveEnc, 'hex'), title: 'Live One', category: ['news'], isLive: true
  })
  log('live: synthetic ticking channel registered beside the title')

  // ===== Grant both to alice (UNCHANGED machinery: per-user sealed keys) =====
  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt(); const kp = userKeyPair(); const authKp = authKeyPair(); const wk = wrapKeyFrom(rwd)
  const secretsNow = loadSecrets(dirs.panel)
  await db.put('user/alice', {
    salt: b4a.toString(salt, 'hex'), verifier: b4a.toString(deriveVerifier(rwd, salt, ARGON2_DEFAULT), 'hex'), argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'), encPriv: wrap(wk, kp.secretKey),
    authPub: b4a.toString(authKp.publicKey, 'hex'), authPrivEnc: wrap(wk, authKp.secretKey),
    wrapped: {
      'movie-1': sealTo(kp.publicKey, b4a.from(secretsNow['movie-1'], 'hex')),
      'ch-live': sealTo(kp.publicKey, b4a.from(secretsNow['ch-live'], 'hex'))
    },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })

  // ===== SDK: headless viewer. zapPrefetch ON + a SHORT tune timeout on purpose: =====
  // if the vod branch ever let the live machinery arm, the watchdog ladder would emit
  // feed:retune within 3 s and a friendly 'error' within ~9 s of a vod play — the
  // quiet-period assert below would catch it deterministically.
  const events = { errors: [], status: [], feedChanged: [] }
  const player = createPlayer({
    panelPubKey,
    storeDir: dirs.cli,
    swarm: { bootstrap, rcvbufMb: 0 },
    tune: { timeoutMs: 3000, relookupMinMs: 500, relookupMaxMs: 1000 },
    zapPrefetch: { intervalMs: 500 }
  })
  player.on('error', (e) => events.errors.push(String(e.message)))
  player.on('status', (s) => events.status.push(s.state))
  player.on('feed-changed', (e) => events.feedChanged.push(e))
  cleanups.push(() => player.stop())
  await player.connect()
  let streams = null
  const deadline = Date.now() + 60000
  while (!streams) {
    if (Date.now() > deadline) throw new Error('timeout: SDK login')
    try {
      const s = await player.login('alice', PASSWORD)
      if (s.length >= 2) streams = s
    } catch (e) { if (!/not connected|unknown user/i.test(String(e.message))) throw e }
    if (!streams) await sleep(1200)
  }
  const dispVod = streams.find((s) => s.id === 'movie-1')
  const dispLive = streams.find((s) => s.id === 'ch-live')
  assert.strictEqual(dispVod.type, 'vod', 'display: vod class')
  assert.strictEqual(dispVod.durationSec, ready.durationSec, 'display: durationSec')
  assert.strictEqual(dispVod.status, 'available', 'display: status')
  assert.strictEqual(dispVod.isLive, undefined, 'display: vod has NO isLive')
  assert.ok(!dispVod.encryptionKey && !dispVod.feedKey, 'display leaked no keys')
  assert.strictEqual(dispLive.type, 'live', 'display: live class')
  assert.strictEqual(dispLive.isLive, true, 'display: live isLive')
  log('sdk: login OK; display carries type/durationSec/status, no keys ✓')

  // ===== resolve() the title: served VOD + seek + NO live machinery =====
  const res = await player.resolve('movie-1')
  assert.strictEqual(res.type, 'vod', 'resolve: type vod')
  assert.strictEqual(res.durationSec, ready.durationSec, 'resolve: durationSec')
  assert.strictEqual(res.source, 'p2p', 'resolve: p2p source')
  assert.ok(res.url === `http://127.0.0.1:${res.port}/index.m3u8`, 'resolve: localhost url')

  const playlist = await waitFor(async () => {
    const r = await httpReq('GET', res.port, '/index.m3u8')
    return r.status === 200 && /#EXT-X-ENDLIST/.test(r.body.toString()) ? r.body.toString() : null
  }, 60000, 'VOD playlist over P2P')
  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/, 'playlist is a VOD playlist')
  const segNames = playlist.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.ts'))
  assert.strictEqual(segNames.length, ready.segments, 'playlist lists every segment (no rolling window)')

  // Every segment must be fully servable over P2P (each is a demand-paged blob fetch).
  for (const s of segNames) {
    const t0 = Date.now()
    const r = await httpReq('GET', res.port, '/' + s)
    assert.strictEqual(r.status, 200, 'segment ' + s)
    log(`  fetched ${s}: ${r.body.length} bytes in ${Date.now() - t0} ms`)
  }

  // ffprobe the SERVED url end-to-end: the whole rendition is readable via P2P.
  // (async spawn — see runProc: the serving process is THIS one.)
  const probe = await runProc('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', res.url], 90000)
  assert.strictEqual(probe.status, 0, 'ffprobe read the served VOD: ' + (probe.stderr || '').trim())
  const served = parseFloat(probe.stdout)
  assert.ok(Math.abs(served - ready.durationSec) <= 2, `served duration ≈ registered (${served} vs ${ready.durationSec})`)

  // Seek-style random access: a Range read on the LAST segment — no sequential fetch
  // led here, so this is the demand-paged jump a seek bar does.
  const lastSeg = segNames[segNames.length - 1]
  const ranged = await waitFor(async () => {
    const r = await httpReq('GET', res.port, '/' + lastSeg, { headers: { range: 'bytes=0-99' } })
    return r.status === 206 && r.body.length === 100 ? r : null
  }, 60000, 'Range read on the last segment')
  assert.match(String(ranged.headers['content-range']), /^bytes 0-99\//, 'Content-Range shape')
  // …and a middle segment fully fetched is real video.
  const midSeg = segNames[Math.floor(segNames.length / 2)]
  const mid = await waitFor(async () => { const r = await httpReq('GET', res.port, '/' + midSeg); return r.status === 200 ? r : null }, 60000, 'middle segment fetch')
  const segPath = path.join(dirs.media, 'seg-check.ts'); fs.writeFileSync(segPath, mid.body)
  const segProbe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', segPath], { encoding: 'utf8' })
  assert.match(segProbe.stdout, /video/, 'mid-film segment holds real video')
  log(`sdk: served VOD validated (ffprobe ${served.toFixed(1)}s over P2P); Range/seek reads OK ✓`)

  // The heart of the branch: the live machinery must NOT have armed. Quiet-wait past
  // 3× the (shortened) tune timeout: an armed watchdog would have emitted feed:retune
  // by now and a friendly 'error' before the wait ends; an armed zap loop would exist
  // as _zapTimer. Internals are belt-and-suspenders beside the behavioral asserts.
  await sleep(10000)
  assert.strictEqual(player._tuneTimer, null, 'tune watchdog NOT armed for vod')
  assert.strictEqual(player._zapTimer, null, 'zap-prefetch loop NOT armed for vod')
  assert.ok(!events.status.includes('feed:retune') && !events.status.includes('feed:reconnect'), 'no retune/reconnect fired for a healthy title')
  assert.deepStrictEqual(events.errors, [], 'no false tune error surfaced for vod (got: ' + events.errors.join(' | ') + ')')
  // Runtime toggle mid-vod must not arm the loop either (its own a.vod guard).
  player.setZapPrefetch(true)
  assert.strictEqual(player._zapTimer, null, 'setZapPrefetch(true) mid-vod stays unarmed')
  // Host-driven redial is allowed for a starving vod download — but must not bring
  // the live watchdog with it.
  player.reconnectActiveFeed()
  assert.strictEqual(player._tuneTimer, null, 'reconnectActiveFeed() during vod does not arm the ladder')
  log('sdk: live machinery provably NOT armed for vod (behavior + internals) ✓')

  // ===== Interplay: zap to the live channel — the machinery arms THERE — and back =====
  const resLive = await player.resolve('ch-live')
  assert.strictEqual(resLive.type, 'live', 'live resolve: type live')
  assert.ok(player._tuneTimer !== null, 'tune watchdog armed for the live channel')
  // The ticking feed advances + serves, so the watchdog must stand down (tuned) —
  // proving the vod guards did not lobotomize the live path.
  await waitFor(async () => player._tuneTimer === null, 20000, 'live watchdog stands down on a healthy feed')
  assert.deepStrictEqual(events.errors, [], 'no error on the healthy live channel')
  // zapPrefetch armed for live — but its only curated neighbor is the vod title,
  // which must never be segment-warmed.
  assert.ok(player._zapTimer !== null, 'zap-prefetch loop armed for live')
  await sleep(2500)
  assert.strictEqual(player._zapRanges.size, 0, 'vod neighbor NOT segment-warmed (curated slot kept, bandwidth not spent)')

  const resBack = await player.resolve('movie-1')
  assert.strictEqual(resBack.type, 'vod', 're-zap to vod')
  assert.strictEqual(resBack.port, res.port, 'localhost port stable across zaps')
  assert.strictEqual(player._tuneTimer, null, 'zapping back to vod cleared the live watchdog')
  assert.strictEqual(player._zapTimer, null, 'zapping back to vod cleared the zap loop (no zombie interval)')
  log('sdk: vod↔live zap arms/clears the live machinery on the live side only ✓')

  // ===== Delete: purge from the library box + catalog flips 'unavailable' =====
  const libStoreDir = path.join(dirs.lib, 'store')
  const coresBefore = coreDirs(libStoreDir).length
  assert.ok(coresBefore >= 2, 'title cores exist on the library store (metadata + blobs)')
  const del = await httpReq('DELETE', cport, '/api/titles/movie-1', { headers: auth })
  assert.strictEqual(del.status, 200, 'DELETE /api/titles/movie-1')
  assert.strictEqual(jbody(await httpReq('GET', cport, '/api/titles', { headers: auth })).length, 0, 'registry empty after delete')
  assert.strictEqual((await httpReq('GET', cport, '/api/titles/movie-1', { headers: auth })).status, 404, 'deleted title 404s')
  const coresAfter = coreDirs(libStoreDir).length
  assert.ok(coresAfter <= coresBefore - 2, `delete PURGED the title's cores from disk (${coresBefore} → ${coresAfter})`)
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dirs.lib, 'secrets', 'titles.json'), 'utf8'))['movie-1'], undefined, 'title encryption key dropped from the library secrets')
  const gone = await waitFor(async () => {
    const v = (await db.get('catalog/movie-1'))?.value
    return v && v.status === 'unavailable' ? v : null
  }, 30000, "catalog status flips 'unavailable'")
  assert.strictEqual(gone.type, 'vod', 'record class survives the flip (admin removes the record + grants in the panel)')
  log('library: delete purged cores + secret; catalog honestly unavailable ✓')

  log('\nRESULT: PASS ✅  (file → library ingest (copy remux, control API) → vod record class (type/durationSec/no-isLive/status/origin, secret private, blobsKey enriched, S29-idempotent) → grant → SDK login/resolve → ffprobe-validated served VOD + Range/seek → live machinery provably unarmed for vod, armed for live, cleanly across zaps → delete purges + catalog flips unavailable)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
