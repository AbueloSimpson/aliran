// End-to-end SDK test: drives @aliran/player-sdk HEADLESS in Node against a real
// panel (login RPC + signed DB) and broadcaster (encrypted live feed) — the same
// engine the Android worklet runs, minus the IPC shell. Validates:
//   connect() -> 'ready'; login() -> display list (no keys leaked) + 'streams' event;
//   wrong password rejected; resolve() -> localhost URL serving valid HLS (ffprobe);
//   assetUrl() shape; 'status' feed:open/feed:ready breadcrumbs; 'peers' ticker;
//   catalog LIVE-PUSH (S1): the panel edits a catalog record while the client is
//   connected -> the SDK re-emits 'streams' with the update, no re-login, no polling;
//   stop().
// Then the HYBRID CDN<->P2P policy (S10b): an entitled but UNSEEDED stream with a tiny
// readyTimeoutMs must fall back to a local "CDN" HLS server ('fallback', source cdn);
// once a broadcaster starts seeding the feed, the SDK must auto-return
// ('source-changed', source p2p) and serve the playlist from the local P2P server.
// Requires ffmpeg/ffprobe on PATH + outbound UDP. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import http from 'http'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { spawnSync } from 'child_process'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT
} from '@aliran/core'
import { startFfmpeg, mirrorDirToDrive } from '../broadcaster/src/hls.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { createPlayer } from '../sdk/index.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) }
  throw new Error('timeout: ' + label)
}
function httpGet (port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

const DIFFICULTY = 8 // low for a fast test
const PASSWORD = 'test123'
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('e2es-panel-'), feed: tmp('e2es-feed-'), feed2: tmp('e2es-feed2-'), cli: tmp('e2es-cli-'), cli2: tmp('e2es-cli2-'), out: tmp('e2es-hls-') }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Broadcaster: encrypted feed =====
  const encKey = hcrypto.randomBytes(32)
  const feedStore = new Corestore(dirs.feed); await feedStore.ready(); cleanups.push(() => feedStore.close())
  const feed = new Hyperdrive(feedStore.namespace('feed'), { encryptionKey: encKey }); await feed.ready()
  const feedSwarm = new Hyperswarm(); cleanups.push(() => feedSwarm.destroy())
  feedSwarm.on('connection', s => feed.replicate(s))
  feedSwarm.join(feed.discoveryKey, { server: true, client: false }); await feedSwarm.flush()
  const ff = startFfmpeg({ input: 'test', hls: { time: 2, listSize: 6 } }, dirs.out); cleanups.push(() => ff.kill())
  const stopMirror = mirrorDirToDrive(dirs.out, feed, { interval: 400 }); cleanups.push(() => stopMirror())
  log('broadcaster: feed key', b4a.toString(feed.key, 'hex').slice(0, 16) + '…')

  // Second encrypted feed for the hybrid case — created (key known) but NOT seeded yet.
  const encKey2 = hcrypto.randomBytes(32)
  const feedStore2 = new Corestore(dirs.feed2); await feedStore2.ready(); cleanups.push(() => feedStore2.close())
  const feed2 = new Hyperdrive(feedStore2.namespace('feed'), { encryptionKey: encKey2 }); await feed2.ready()

  // ===== Panel: keys, enroll alice + stream + grant, serve RPC =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt()
  const kp = userKeyPair()
  const auth = authKeyPair()
  const wk = wrapKeyFrom(rwd)
  await db.put('user/alice', {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(rwd, salt, ARGON2_DEFAULT), 'hex'),
    argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'),
    encPriv: wrap(wk, kp.secretKey),
    authPub: b4a.toString(auth.publicKey, 'hex'),
    authPrivEnc: wrap(wk, auth.secretKey),
    wrapped: { news: sealTo(kp.publicKey, encKey), movies: sealTo(kp.publicKey, encKey2) },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', protection: 'self', feedKey: b4a.toString(feed.key, 'hex'), isLive: true, poster: 'assets/news/poster.png', status: 'live' })
  await db.put('catalog/movies', { title: 'Movies', category: ['movies'], type: 'live', protection: 'self', feedKey: b4a.toString(feed2.key, 'hex'), isLive: true, poster: null, status: 'live' })

  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  const throttle = makeThrottle(1000, 60)
  const panelSwarm = new Hyperswarm(); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle, db, sessionTtlMs: 3600000 }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()
  log('panel: serving login RPC; pubkey', panelPubKey.slice(0, 16) + '…')

  // ===== SDK: the whole client side, headless =====
  const events = { ready: 0, streams: 0, lastStreams: null, status: [], peers: [] }
  const player = createPlayer({ panelPubKey, storeDir: dirs.cli })
  player.on('ready', () => { events.ready++ })
  player.on('streams', (s) => { events.streams++; events.lastStreams = s })
  player.on('status', (s) => { events.status.push(s.state) })
  player.on('peers', (n) => { events.peers.push(n) })
  cleanups.push(() => player.stop())

  await player.connect()
  if (events.ready !== 1) throw new Error("connect() did not emit 'ready'")
  log('sdk: connected; logging in (retrying while the swarm dials)…')

  // Login needs the panel socket + a replicated DB; both race the DHT dial. Retry the
  // transient failures the way the app's login screen does, with gentler pacing so the
  // panel's login throttle is never hit.
  let streams = null
  const deadline = Date.now() + 60000
  while (!streams) {
    if (Date.now() > deadline) throw new Error('timeout: SDK login')
    try {
      const s = await player.login('alice', PASSWORD)
      if (s.length >= 2) streams = s // both catalog records replicated
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streams) await sleep(1500)
  }
  log('sdk: login OK; entitled to', JSON.stringify(streams.map(x => x.id)))
  if (events.streams < 1) throw new Error("login did not emit 'streams'")
  if (player.listStreams() !== streams) throw new Error('listStreams() must return the cached display list')
  const disp = streams.find(x => x.id === 'news')
  if (disp.encryptionKey || disp.feedKey) throw new Error('display list leaked stream keys')
  if (disp.title !== 'News 24' || disp.isLive !== true) throw new Error('display metadata wrong')

  // wrong password must be rejected (and must not clobber the entitled session)
  let rejected = false
  try { await player.login('alice', 'WRONG') } catch { rejected = true }
  if (!rejected) throw new Error('wrong password was NOT rejected')
  log('sdk: wrong password correctly rejected')

  // ===== resolve() -> localhost URL -> valid HLS over P2P =====
  const { localUrl, port, feedKey } = await player.resolve('news')
  if (feedKey !== b4a.toString(feed.key, 'hex')) throw new Error('resolve() feedKey mismatch')
  if (localUrl !== `http://127.0.0.1:${port}/index.m3u8`) throw new Error('resolve() localUrl shape wrong')
  if (!events.status.includes('feed:open') || !events.status.includes('feed:ready')) throw new Error('missing feed:open/feed:ready status events')

  const playlist = await waitFor(async () => { const r = await httpGet(port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') ? r.body.toString() : null }, 40000, 'playback over P2P')
  const segName = (playlist.match(/[^\s]+\.ts/) || [])[0]
  const full = await httpGet(port, '/' + segName)
  const segPath = path.join(os.tmpdir(), 'e2es-seg.ts'); fs.writeFileSync(segPath, full.body)
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', segPath], { encoding: 'utf8' })
  const probeOut = (probe.stdout || '').trim()
  log('sdk: played', full.body.length, 'bytes via', localUrl, '; ffprobe:', JSON.stringify(probeOut))

  // Range request must work (react-native-video relies on it)
  const ranged = await httpGet(port, '/' + segName, { range: 'bytes=0-99' })
  if (ranged.status !== 206 || ranged.body.length !== 100) throw new Error('Range request failed')

  // assetUrl + poster URL shape (assets drive is not seeded in this test — shape only)
  const au = player.assetUrl('assets/news/poster.png')
  if (au !== `http://127.0.0.1:${port}/assets/news/poster.png`) throw new Error('assetUrl shape wrong: ' + au)
  if (disp.poster !== au) throw new Error('display poster should be a localhost URL: ' + disp.poster)

  // peers ticker fires while serving (the broadcaster is the 1 peer)
  await waitFor(async () => events.peers.some(n => n >= 1), 15000, "'peers' ticker")
  log('sdk: peers ticker OK (' + events.peers[events.peers.length - 1] + ' peer)')

  // ===== Catalog live-push (S1) =====
  // The panel edits a catalog record while the client is connected. The SDK watches
  // the replicated catalog/ range and must re-emit 'streams' with the update — login()
  // is never called again (the SDK cannot re-login by itself: it keeps no password),
  // and nothing here polls.
  const pushesBefore = events.streams
  await db.put('catalog/news', { title: 'News 24 Prime', category: ['news'], type: 'live', protection: 'self', feedKey: b4a.toString(feed.key, 'hex'), isLive: false, poster: 'assets/news/poster.png', status: 'live' })
  await waitFor(async () => events.streams > pushesBefore && (events.lastStreams || []).some(s => s.id === 'news' && s.title === 'News 24 Prime'), 30000, "catalog live-push ('streams' re-emit)")
  const pushedNews = events.lastStreams.find(s => s.id === 'news')
  if (pushedNews.isLive !== false) throw new Error('live-push did not carry the isLive change')
  if (pushedNews.encryptionKey || pushedNews.feedKey) throw new Error('live-push leaked stream keys')
  if (pushedNews.poster !== au) throw new Error('live-push poster should stay a localhost URL: ' + pushedNews.poster)
  if (!events.lastStreams.some(s => s.id === 'movies')) throw new Error('live-push dropped an entitled stream')
  if (player.listStreams() !== events.lastStreams) throw new Error('listStreams() must return the pushed display list')
  const livePushed = events.streams - pushesBefore
  log('sdk: catalog live-push OK — record edit reached the connected client without re-login (' + livePushed + ' push)')

  await player.stop()

  // ===== Hybrid CDN<->P2P (S10b) =====
  // Local "CDN": a plain HTTP file server over the ffmpeg HLS dir.
  const cdn = http.createServer((req, res) => {
    try {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\//, '') || 'index.m3u8'
      const data = fs.readFileSync(path.join(dirs.out, rel))
      res.writeHead(200); res.end(data)
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise(r => cdn.listen(0, '127.0.0.1', r)); cleanups.push(() => cdn.close())
  const cdnPort = cdn.address().port
  const cdnUrl = `http://127.0.0.1:${cdnPort}/index.m3u8`

  const ev2 = { fallback: [], sourceChanged: [] }
  const player2 = createPlayer({
    panelPubKey,
    storeDir: dirs.cli2,
    hybrid: { mode: 'hybrid', cdnUrl: () => cdnUrl, readyTimeoutMs: 2000, probeIntervalMs: 700, rebufferMsToFallback: 5000 }
  })
  player2.on('fallback', (e) => ev2.fallback.push(e))
  player2.on('source-changed', (e) => ev2.sourceChanged.push(e))
  cleanups.push(() => player2.stop())

  await player2.connect()
  let streams2 = null
  const deadline2 = Date.now() + 60000
  while (!streams2) {
    if (Date.now() > deadline2) throw new Error('timeout: hybrid SDK login')
    try {
      const s = await player2.login('alice', PASSWORD)
      if (s.length >= 2) streams2 = s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streams2) await sleep(1500)
  }

  // 'movies' is entitled but nobody seeds it -> tiny readyTimeout forces CDN fallback.
  const r2 = await player2.resolve('movies')
  if (r2.source !== 'cdn' || r2.url !== cdnUrl) throw new Error('expected CDN fallback, got ' + JSON.stringify({ source: r2.source, url: r2.url }))
  if (ev2.fallback.length !== 1 || ev2.fallback[0].reason !== 'timeout' || ev2.fallback[0].streamId !== 'movies') throw new Error("missing/wrong 'fallback' event: " + JSON.stringify(ev2.fallback))
  const viaCdn = await httpGet(cdnPort, '/index.m3u8')
  if (viaCdn.status !== 200 || !viaCdn.body.includes('.ts')) throw new Error('CDN source not playable')
  if (player2.source().source !== 'cdn') throw new Error('source() should report cdn')
  log('hybrid: fell back to CDN (reason timeout); CDN playlist serves')

  // "Start the broadcaster" for movies: seed feed2 with the same live HLS dir.
  const feedSwarm2 = new Hyperswarm(); cleanups.push(() => feedSwarm2.destroy())
  feedSwarm2.on('connection', s => feed2.replicate(s))
  feedSwarm2.join(feed2.discoveryKey, { server: true, client: false }); await feedSwarm2.flush()
  const stopMirror2 = mirrorDirToDrive(dirs.out, feed2, { interval: 400 }); cleanups.push(() => stopMirror2())
  log('hybrid: broadcaster for "movies" started; waiting for auto-return to P2P…')

  await waitFor(async () => ev2.sourceChanged.some(e => e.source === 'p2p'), 60000, "'source-changed' back to P2P")
  const sc = ev2.sourceChanged.find(e => e.source === 'p2p')
  if (sc.streamId !== 'movies' || sc.url !== r2.localUrl) throw new Error("wrong 'source-changed' payload: " + JSON.stringify(sc))
  if (player2.source().source !== 'p2p' || player2.source().url !== r2.localUrl) throw new Error('source() should report p2p after recovery')
  const viaP2P = await waitFor(async () => { const r = await httpGet(r2.port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') ? r : null }, 20000, 'P2P playlist after auto-return')
  log('hybrid: auto-returned to P2P; local playlist serves (' + viaP2P.body.length + ' bytes)')
  await player2.stop()

  const pass = !!(streams.length && rejected && full.body.length > 0 && /video/.test(probeOut) &&
    livePushed >= 1 && ev2.fallback.length === 1 && ev2.sourceChanged.some(e => e.source === 'p2p'))
  log('\nRESULT:', pass ? 'PASS ✅  (headless SDK: login → resolve → P2P HLS + catalog live-push + hybrid CDN fallback/auto-return verified)' : 'FAIL ❌')
  await cleanup(); process.exit(pass ? 0 : 1)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
