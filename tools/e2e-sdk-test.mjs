// End-to-end SDK test: drives @aliran/player-sdk HEADLESS in Node against a real
// panel (login RPC + signed DB) and broadcaster (encrypted live feed) — the same
// engine the Android worklet runs, minus the IPC shell. Validates:
//   connect() -> 'ready'; login() -> display list (no keys leaked) + 'streams' event;
//   wrong password rejected; resolve() -> localhost URL serving valid HLS (ffprobe);
//   assetUrl() shape; 'status' feed:open/feed:ready breadcrumbs; 'peers' ticker;
//   catalog LIVE-PUSH (S1): the panel edits a catalog record while the client is
//   connected -> the SDK re-emits 'streams' with the update, no re-login, no polling;
//   active-feed ROTATION while watching: the broadcaster publishes a NEW feedKey (same
//   sealed encryption key) for the stream being watched -> the SDK catalog-follows it,
//   swaps the served feed on the SAME localhost port and emits 'feed-changed' with no
//   re-zap / re-login / manual resolve(); stop().
// Then the HYBRID CDN<->P2P policy (S10b): an entitled but UNSEEDED stream with a tiny
// readyTimeoutMs must fall back to a local "CDN" HLS server ('fallback', source cdn);
// once a broadcaster starts seeding the feed, the SDK must auto-return
// ('source-changed', source p2p) and serve the playlist from the local P2P server.
// Then the TUNE SELF-HEAL (p2p-only; the S22 stuck-at-90% zap): resolving an entitled
// stream NOBODY seeds must force DHT re-lookups while tuning, retune once at
// tune.timeoutMs ('feed:retune' + cached open EVICTED + fresh open), then surface a
// friendly 'error' instead of spinning forever; once a broadcaster appears, a plain
// re-resolve must open FRESH and play — no app restart (the poison-pill regression).
// Then the WEDGED-CONNECTION self-heal (the 2nd S22 2026-07-16 incident): a paused
// socket leaves the connection transport-ALIVE but replication-DEAD ("1 peer", frozen
// live edge, no error) — a re-zap must retune, then DESTROY the wedged connection
// ('feed:reconnect') so the swarm dials fresh, and playback must resume with no
// friendly error and no app restart.
// Then ZAP PREFETCH (zapPrefetch option): playing a stream must warm the curated-order
// neighbors — their newest segment fully replicated locally without ever being served
// over HTTP, following the catalog's CURRENT (rotated) feedKey.
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
// resolve() must always return promptly — a hang here is the re-zap regression (opening
// a duplicate Hyperdrive over a still-open store namespace), so bound it rather than
// letting a stall wedge the whole test.
async function resolveWithin (p, id, ms) {
  return Promise.race([
    p.resolve(id),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`resolve('${id}') did not return within ${ms}ms — re-zap hang regression`)), ms))
  ])
}

const DIFFICULTY = 8 // low for a fast test
const PASSWORD = 'test123'
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('e2es-panel-'), feed: tmp('e2es-feed-'), feed2: tmp('e2es-feed2-'), feed3: tmp('e2es-feed3-'), feed4: tmp('e2es-feed4-'), feedR: tmp('e2es-feedR-'), cli: tmp('e2es-cli-'), cli2: tmp('e2es-cli2-'), cli3: tmp('e2es-cli3-'), cli4: tmp('e2es-cli4-'), cliZ: tmp('e2es-cliZ-'), out: tmp('e2es-hls-') }
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

  // Third encrypted feed for the tune self-heal case — cataloged as live but nobody
  // seeds it until the very end (the cold/unreachable-feed zap).
  const encKey3 = hcrypto.randomBytes(32)
  const feedStore3 = new Corestore(dirs.feed3); await feedStore3.ready(); cleanups.push(() => feedStore3.close())
  const feed3 = new Hyperdrive(feedStore3.namespace('feed'), { encryptionKey: encKey3 }); await feed3.ready()

  // Fourth encrypted feed for the wedged-connection case — seeded from the start by a
  // DEDICATED swarm so the test can identify (and wedge) exactly that connection.
  const encKey4 = hcrypto.randomBytes(32)
  const feedStore4 = new Corestore(dirs.feed4); await feedStore4.ready(); cleanups.push(() => feedStore4.close())
  const feed4 = new Hyperdrive(feedStore4.namespace('feed'), { encryptionKey: encKey4 }); await feed4.ready()
  const feedSwarm4 = new Hyperswarm(); cleanups.push(() => feedSwarm4.destroy())
  feedSwarm4.on('connection', s => feed4.replicate(s))
  feedSwarm4.join(feed4.discoveryKey, { server: true, client: false }); await feedSwarm4.flush()
  const stopMirror4 = mirrorDirToDrive(dirs.out, feed4, { interval: 400 }); cleanups.push(() => stopMirror4())

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
    wrapped: { news: sealTo(kp.publicKey, encKey), movies: sealTo(kp.publicKey, encKey2), shopping: sealTo(kp.publicKey, encKey3), sports: sealTo(kp.publicKey, encKey4) },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', protection: 'self', feedKey: b4a.toString(feed.key, 'hex'), isLive: true, poster: 'assets/news/poster.png', status: 'live' })
  await db.put('catalog/movies', { title: 'Movies', category: ['movies'], type: 'live', protection: 'self', feedKey: b4a.toString(feed2.key, 'hex'), isLive: true, poster: null, status: 'live', order: 1, featured: true })
  await db.put('catalog/shopping', { title: 'Shopping', category: ['shopping'], type: 'live', protection: 'self', feedKey: b4a.toString(feed3.key, 'hex'), isLive: true, poster: null, status: 'live' })
  await db.put('catalog/sports', { title: 'Sports', category: ['sports'], type: 'live', protection: 'self', feedKey: b4a.toString(feed4.key, 'hex'), isLive: true, poster: null, status: 'live' })

  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  const throttle = makeThrottle(1000, 60)
  const panelSwarm = new Hyperswarm(); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle, db, sessionTtlMs: 3600000 }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()
  log('panel: serving login RPC; pubkey', panelPubKey.slice(0, 16) + '…')

  // ===== SDK: the whole client side, headless =====
  const events = { ready: 0, streams: 0, lastStreams: null, status: [], peers: [], feedChanged: [] }
  const player = createPlayer({ panelPubKey, storeDir: dirs.cli })
  player.on('ready', () => { events.ready++ })
  player.on('streams', (s) => { events.streams++; events.lastStreams = s })
  player.on('status', (s) => { events.status.push(s.state) })
  player.on('peers', (n) => { events.peers.push(n) })
  player.on('feed-changed', (e) => { events.feedChanged.push(e) })
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
      if (s.length >= 4) streams = s // all four catalog records replicated
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
  // Curation passthrough (S16c): order/featured reach the display list untouched.
  const dispMovies = streams.find(x => x.id === 'movies')
  if (dispMovies.order !== 1 || dispMovies.featured !== true) throw new Error('curation fields missing from login display list: ' + JSON.stringify({ order: dispMovies.order, featured: dispMovies.featured }))
  if (disp.order != null || disp.featured) throw new Error('uncurated stream must not grow curation values')

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

  // ===== Channel zapping: re-resolve a served feed must reuse it, not hang =====
  // Zap news → movies → news. Switching BACK to 'news' (already served above) must
  // reuse the warm feed drive; the pre-fix code opened a second Hyperdrive on the same
  // store namespace and deadlocked on ready(). The port must stay stable across
  // switches, and the warm re-zap must serve the news playlist again immediately.
  const zapAway = await resolveWithin(player, 'movies', 20000) // different feed (unseeded is fine — we only need resolve() to return)
  if (zapAway.port !== port) throw new Error('zap: localhost server port must stay stable across switches')
  const zapBack = await resolveWithin(player, 'news', 20000) // RE-OPEN news — must reuse, not wedge
  if (zapBack.port !== port) throw new Error('zap: port must stay stable on re-zap')
  if (zapBack.feedKey !== b4a.toString(feed.key, 'hex')) throw new Error('zap: re-resolve news feedKey mismatch')
  const zapPlaylist = await waitFor(async () => { const r = await httpGet(port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') ? r.body.toString() : null }, 20000, 're-zap to news serves the warm playlist')
  const zapSegs = zapPlaylist.split('\n').filter(l => l.trim().endsWith('.ts')).length
  log('sdk: zap news→movies→news OK — re-resolve reused the warm feed, no hang (' + zapSegs + ' segs live)')

  // ===== Catalog live-push (S1) =====
  // The panel edits a catalog record while the client is connected. The SDK watches
  // the replicated catalog/ range and must re-emit 'streams' with the update — login()
  // is never called again (the SDK cannot re-login by itself: it keeps no password),
  // and nothing here polls.
  const pushesBefore = events.streams
  await db.put('catalog/news', { title: 'News 24 Prime', category: ['news'], type: 'live', protection: 'self', feedKey: b4a.toString(feed.key, 'hex'), isLive: false, poster: 'assets/news/poster.png', status: 'live', order: 5, featured: true })
  await waitFor(async () => events.streams > pushesBefore && (events.lastStreams || []).some(s => s.id === 'news' && s.title === 'News 24 Prime'), 30000, "catalog live-push ('streams' re-emit)")
  const pushedNews = events.lastStreams.find(s => s.id === 'news')
  if (pushedNews.isLive !== false) throw new Error('live-push did not carry the isLive change')
  if (pushedNews.order !== 5 || pushedNews.featured !== true) throw new Error('live-push did not carry the curation change: ' + JSON.stringify({ order: pushedNews.order, featured: pushedNews.featured }))
  if (pushedNews.encryptionKey || pushedNews.feedKey) throw new Error('live-push leaked stream keys')
  if (pushedNews.poster !== au) throw new Error('live-push poster should stay a localhost URL: ' + pushedNews.poster)
  if (!events.lastStreams.some(s => s.id === 'movies')) throw new Error('live-push dropped an entitled stream')
  if (player.listStreams() !== events.lastStreams) throw new Error('listStreams() must return the pushed display list')
  const livePushed = events.streams - pushesBefore
  log('sdk: catalog live-push OK — record edit reached the connected client without re-login (' + livePushed + ' push)')

  // ===== Active-feed rotation WHILE watching (client follow-up to broadcaster 6e38b90) =====
  // The broadcaster auto-rotates a channel's feed identity on a source change: a NEW feedKey
  // under the SAME sealed encryption key is published to the catalog. A viewer ALREADY
  // watching 'news' (feed A, resolved+served above) must catalog-FOLLOW to the rotated feed
  // and emit 'feed-changed' with NO re-zap / re-login / manual resolve() — the localhost port
  // is unchanged, the host just reloads the player. This closes the gap the broadcaster's
  // auto-rotate left open (a mid-watch viewer used to keep replicating the dead feed).
  if (events.feedChanged.length !== 0) throw new Error('unexpected feed-changed before any rotation (the isLive-only live-push must NOT rotate the feed)')
  const rotStore = new Corestore(dirs.feedR); await rotStore.ready(); cleanups.push(() => rotStore.close())
  const feedRot = new Hyperdrive(rotStore.namespace('feed'), { encryptionKey: encKey }); await feedRot.ready() // SAME encKey → fresh feedKey
  const rotKeyHex = b4a.toString(feedRot.key, 'hex')
  if (rotKeyHex === b4a.toString(feed.key, 'hex')) throw new Error('rotated feed must carry a fresh key')
  const rotSwarm = new Hyperswarm(); cleanups.push(() => rotSwarm.destroy())
  rotSwarm.on('connection', s => feedRot.replicate(s))
  rotSwarm.join(feedRot.discoveryKey, { server: true, client: false }); await rotSwarm.flush()
  const stopMirrorRot = mirrorDirToDrive(dirs.out, feedRot, { interval: 400 }); cleanups.push(() => stopMirrorRot())
  log('rotate: seeding rotated news feed', rotKeyHex.slice(0, 16) + '… (encryption key unchanged)')

  // Publish the rotated feedKey — the ONLY trigger. No resolve() call follows.
  await db.put('catalog/news', { title: 'News 24 Prime', category: ['news'], type: 'live', protection: 'self', feedKey: rotKeyHex, isLive: true, poster: 'assets/news/poster.png', status: 'live', order: 5, featured: true })
  const fc = await waitFor(async () => events.feedChanged.find(e => e.streamId === 'news' && e.feedKey === rotKeyHex), 40000, "'feed-changed' after the broadcaster rotated the ACTIVE feed")
  if (fc.url !== localUrl) throw new Error("'feed-changed' url must be the stable localhost URL, got " + fc.url)
  if (player.source().url !== localUrl || player.source().source !== 'p2p') throw new Error('source() should still report the p2p localhost URL after rotation')
  // Direct proof the served drive swapped to the rotated feed (not just an event fired).
  if (b4a.toString(player._feedDrive.key, 'hex') !== rotKeyHex) throw new Error('SDK did not swap _feedDrive to the rotated feed')
  // The unchanged localhost port now serves the ROTATED feed's live playlist.
  const rotPlaylist = await waitFor(async () => { const r = await httpGet(port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') ? r.body.toString() : null }, 30000, 'rotated feed playlist over the unchanged port')
  const rotSegs = rotPlaylist.split('\n').filter(l => l.trim().endsWith('.ts')).length
  const rotated = !!fc
  log('rotate: SDK re-resolved the ACTIVE stream to the rotated feed + emitted feed-changed with no re-zap; same port serves it (' + rotSegs + ' segs)')

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

  const ev2 = { fallback: [], sourceChanged: [], status: [] }
  const player2 = createPlayer({
    panelPubKey,
    storeDir: dirs.cli2,
    prewarm: true, // open entitled feeds at login so the FIRST zap is warm
    hybrid: { mode: 'hybrid', cdnUrl: () => cdnUrl, readyTimeoutMs: 2000, probeIntervalMs: 700, rebufferMsToFallback: 5000 }
  })
  player2.on('fallback', (e) => ev2.fallback.push(e))
  player2.on('source-changed', (e) => ev2.sourceChanged.push(e))
  player2.on('status', (s) => ev2.status.push(s.state))
  cleanups.push(() => player2.stop())

  await player2.connect()
  let streams2 = null
  const deadline2 = Date.now() + 60000
  while (!streams2) {
    if (Date.now() > deadline2) throw new Error('timeout: hybrid SDK login')
    try {
      const s = await player2.login('alice', PASSWORD)
      if (s.length >= 4) streams2 = s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streams2) await sleep(1500)
  }

  // ===== Prewarm: login opened the entitled feeds ahead of any play =====
  // With prewarm:true, both entitled feeds ('news' + 'movies') are opened+joined in the
  // background at login, so the first zap to either is a cache hit — no cold feed:open.
  await player2.prewarm() // idempotent; deterministically wait out the background warm
  if (player2._feeds.size !== 4) throw new Error('prewarm should open all four entitled feeds; got ' + player2._feeds.size)
  log('prewarm: opened ' + player2._feeds.size + ' entitled feeds at login (warm first-zap)')

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
  // Prewarm proof: because both feeds were opened at login, no feed was ever COLD-opened
  // on the play path — serveFeed only ever emitted feed:ready, never feed:open.
  if (ev2.status.includes('feed:open')) throw new Error('prewarm: no feed should be cold-opened after prewarm, but got feed:open')
  if (!ev2.status.includes('feed:ready')) throw new Error('prewarm: expected feed:ready on serve')
  log('prewarm: served feeds were all warm (feed:ready, no feed:open)')
  await player2.stop()

  // ===== Tune self-heal (p2p-only): timeout → retune → friendly error → clean retry =====
  // 'shopping' is entitled and cataloged as live but NOBODY seeds it — the S22
  // stuck-at-90% zap (cold feed / stale DHT record; 2026-07-16). With a tiny tune
  // config the SDK must: force DHT re-lookups while the tune is incomplete, retune
  // ONCE at tune.timeoutMs ('feed:retune' breadcrumb — cached open EVICTED + fresh
  // open), then surface a friendly 'error' instead of spinning forever. The eviction
  // is the poison-pill regression: pre-fix, the single-flight cache handed every
  // retry the same dead open until an app restart.
  const ev3 = { status: [], errors: [] }
  const player3 = createPlayer({
    panelPubKey,
    storeDir: dirs.cli3,
    tune: { timeoutMs: 4000, relookupMinMs: 1000, relookupMaxMs: 4000 }
  })
  player3.on('status', (s) => ev3.status.push(s.state))
  player3.on('error', (e) => ev3.errors.push(String((e && e.message) || e)))
  cleanups.push(() => player3.stop())

  await player3.connect()
  let streams3 = null
  const deadline3 = Date.now() + 60000
  while (!streams3) {
    if (Date.now() > deadline3) throw new Error('timeout: tune SDK login')
    try {
      const s = await player3.login('alice', PASSWORD)
      if (s.length >= 4) streams3 = s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streams3) await sleep(1500)
  }

  const shopKeyHex = b4a.toString(feed3.key, 'hex')
  const shopCacheKey = shopKeyHex + ':' + b4a.toString(encKey3, 'hex')
  const r3 = await resolveWithin(player3, 'shopping', 20000) // the OPEN is local — must return promptly even unseeded
  if (r3.feedKey !== shopKeyHex) throw new Error('tune: resolve() feedKey mismatch')
  // Count the forced DHT re-lookups (the PanelLink-style self-heal) while tuning.
  let relookups = 0
  const disc3 = player3._feedDiscovery
  const origRefresh = disc3.refresh.bind(disc3)
  disc3.refresh = (...args) => { relookups++; return origRefresh(...args) }

  const tuneErr = await waitFor(async () => ev3.errors.find(m => /tune timeout/i.test(m)), 30000, "friendly 'error' after the tune timed out (incl. one retune)")
  if (!/shopping/.test(tuneErr)) throw new Error('tune: the error should name the stream: ' + tuneErr)
  if (!ev3.status.includes('feed:retune')) throw new Error("tune: expected a 'feed:retune' breadcrumb (evict + fresh open) before the error")
  if (relookups < 1) throw new Error('tune: expected forced discovery re-lookups while tuning, got ' + relookups)
  if (player3._feeds.has(shopCacheKey)) throw new Error('tune: the dead open must be EVICTED from the feed cache')
  log('tune: unseeded zap → ' + relookups + ' forced re-lookup(s) → feed:retune → friendly error, cache evicted ("' + tuneErr.slice(0, 60) + '…")')

  // The broadcaster for 'shopping' finally starts. The app path after the error is a
  // plain re-zap: it must do a FRESH open (no app restart) and play. Emulate the
  // viewer: if another tune window expires before the public-DHT lookup + replication
  // catch up, re-zap again — each attempt must be a fresh open, never the dead one.
  const feedSwarm3 = new Hyperswarm(); cleanups.push(() => feedSwarm3.destroy())
  feedSwarm3.on('connection', s => feed3.replicate(s))
  feedSwarm3.join(feed3.discoveryKey, { server: true, client: false }); await feedSwarm3.flush()
  const stopMirror3 = mirrorDirToDrive(dirs.out, feed3, { interval: 400 }); cleanups.push(() => stopMirror3())
  let errSeen = ev3.errors.length
  const r3b = await resolveWithin(player3, 'shopping', 20000)
  if (r3b.port !== r3.port) throw new Error('tune: localhost port must stay stable across the retry')
  const shopPlaylist = await waitFor(async () => {
    if (ev3.errors.length > errSeen) { errSeen = ev3.errors.length; await resolveWithin(player3, 'shopping', 20000) } // viewer re-zaps
    const r = await httpGet(r3.port, '/index.m3u8')
    return r.status === 200 && r.body.includes('.ts') ? r.body.toString() : null
  }, 60000, 'post-seed re-zap serves the playlist (fresh open after eviction — no app restart)')
  const shopSegs = shopPlaylist.split('\n').filter(l => l.trim().endsWith('.ts')).length
  const tuned = !!shopPlaylist
  log('tune: post-seed re-zap opened fresh and plays (' + shopSegs + ' segs) — the dead open no longer poisons retries')
  await player3.stop()

  // ===== Wedged-connection self-heal (the 2nd S22 2026-07-16 incident) =====
  // A network flap can leave the hyperswarm/UDX connection transport-ALIVE but
  // replication-DEAD: the peer stays connected on every topic ("P2P — 1 peer"), the
  // stale playlist already sits in the local replica, and an evict+retune reuses the
  // same wedged pipe (hyperswarm keeps one connection per peer) — pre-fix the viewer
  // spun for 15+ min with NO error; only an app restart (fresh swarm identity)
  // recovered. Simulate the wedge from the viewer's side by PAUSING its socket to the
  // seeder (probe-verified: the connection stays open, drive.core.peers stays 1, zero
  // bytes move — the exact prod signature; the in-process stand-in for SIGSTOPping a
  // seeder process, which Windows lacks). Then re-zap: the tune watchdog must see a
  // playlist that EXISTS but never ADVANCES, retune at timeoutMs, DESTROY the wedged
  // connection at 2× ('feed:reconnect'), and the fresh dial must resume the live edge
  // with NO friendly error and NO app restart.
  const ev4 = { status: [], errors: [] }
  const player4 = createPlayer({
    panelPubKey,
    storeDir: dirs.cli4,
    tune: { timeoutMs: 9000, relookupMinMs: 1000, relookupMaxMs: 9000 }
  })
  player4.on('status', (s) => ev4.status.push(s.state))
  player4.on('error', (e) => ev4.errors.push(String((e && e.message) || e)))
  cleanups.push(() => player4.stop())

  await player4.connect()
  let streams4 = null
  const deadline4 = Date.now() + 60000
  while (!streams4) {
    if (Date.now() > deadline4) throw new Error('timeout: wedge SDK login')
    try {
      const s = await player4.login('alice', PASSWORD)
      if (s.length >= 4) streams4 = s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streams4) await sleep(1500)
  }

  const r4 = await resolveWithin(player4, 'sports', 20000)
  const basePl = await waitFor(async () => { const r = await httpGet(r4.port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') ? r.body.toString() : null }, 40000, 'sports playback over P2P (pre-wedge)')
  await waitFor(async () => { const r = await httpGet(r4.port, '/index.m3u8'); const b = r.body.toString(); return r.status === 200 && b !== basePl ? b : null }, 20000, 'sports live edge advances (pre-wedge health)')

  // WEDGE: pause the viewer's socket to the sports seeder. No announcements or blocks
  // arrive anymore, but the transport (and the replication peer) stays attached.
  const wedgedSock = [...player4._swarm.connections].find(s => b4a.equals(s.remotePublicKey, feedSwarm4.keyPair.publicKey))
  if (!wedgedSock) throw new Error('wedge: no connection to the sports seeder found')
  wedgedSock.pause()
  await sleep(1500) // let in-flight buffered data drain so the frozen check is honest
  const frozenPl = (await httpGet(r4.port, '/index.m3u8')).body.toString()
  await sleep(4000) // 2× the segment cadence — a healthy feed would have advanced
  const stillPl = (await httpGet(r4.port, '/index.m3u8')).body.toString()
  if (stillPl !== frozenPl) throw new Error('wedge: expected the live edge to freeze under the paused connection')
  if (wedgedSock.destroyed) throw new Error('wedge: the paused connection must stay transport-alive')
  if (player4._feedDrive.core.peers.length < 1) throw new Error('wedge: the peer must still look connected (the prod "1 peer" signature)')
  log('wedge: live edge frozen, connection alive, ' + player4._feedDrive.core.peers.length + ' peer attached — the S22 signature reproduced')

  // The viewer re-zaps into the wedge (exactly what the phone did after the blip).
  const statusMark = ev4.status.length
  await resolveWithin(player4, 'sports', 20000)
  await waitFor(async () => ev4.status.slice(statusMark).includes('feed:retune'), 25000, "wedge cycle 1: 'feed:retune' (evict + fresh open still rides the wedged pipe)")
  await waitFor(async () => ev4.status.slice(statusMark).includes('feed:reconnect'), 25000, "wedge cycle 2: 'feed:reconnect' (wedged connection destroyed, fresh dial)")
  await waitFor(async () => wedgedSock.destroyed, 5000, 'the wedged socket is actually destroyed')
  const healedPl = await waitFor(async () => {
    const r = await httpGet(r4.port, '/index.m3u8')
    const b = r.body.toString()
    return r.status === 200 && b.includes('.ts') && b !== frozenPl ? b : null
  }, 30000, 'live edge resumes after the fresh dial (no app restart)')
  if (ev4.errors.some(m => /tune timeout/i.test(m))) throw new Error('wedge: the teardown should recover BEFORE the friendly error fires: ' + JSON.stringify(ev4.errors))
  const wedgeHealed = !!healedPl
  const healedSegs = healedPl.split('\n').filter(l => l.trim().endsWith('.ts')).length
  log('wedge: retune → reconnect (teardown) → fresh dial resumed the live edge (' + healedSegs + ' segs) — no error, no app restart')
  await player4.stop()

  // ===== zapPrefetch: the adjacent channel's newest segment replicates while watching =====
  // With zapPrefetch on, playing a stream must keep the curated-order NEIGHBORS' newest
  // segment warm in the local replica — without those feeds ever being served over HTTP.
  // Curated order here is [movies(order 1), news(order 5), shopping, sports], so playing
  // 'movies' must warm 'news' — which by now lives on the ROTATED feed (rotKeyHex),
  // proving the prefetch also follows the catalog's current feedKey.
  const playerZ = createPlayer({ panelPubKey, storeDir: dirs.cliZ, zapPrefetch: { neighbors: 1, intervalMs: 700 } })
  cleanups.push(() => playerZ.stop())
  await playerZ.connect()
  let streamsZ = null
  const deadlineZ = Date.now() + 60000
  while (!streamsZ) {
    if (Date.now() > deadlineZ) throw new Error('timeout: zap-prefetch SDK login')
    try {
      const s = await playerZ.login('alice', PASSWORD)
      if (s.length >= 4) streamsZ = s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streamsZ) await sleep(1500)
  }
  const rZ = await resolveWithin(playerZ, 'movies', 20000)
  await waitFor(async () => { const r = await httpGet(rZ.port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') }, 40000, 'movies playback (zap-prefetch baseline)')
  const warmedSeg = await waitFor(async () => {
    const s = playerZ._zapRanges.get('news')
    if (!s || !s.path) return null
    const feedZ = await playerZ._feeds.get(rotKeyHex + ':' + b4a.toString(encKey, 'hex'))
    if (!feedZ) return null
    const entryZ = await feedZ.drive.entry(s.path)
    const bZ = entryZ && entryZ.value.blob
    if (!bZ || !(bZ.blockLength > 0)) return null
    const blobsZ = await feedZ.drive.getBlobs()
    for (let i = bZ.blockOffset; i < bZ.blockOffset + bZ.blockLength; i++) {
      if (!(await blobsZ.core.has(i))) return null
    }
    return s.path
  }, 30000, "zap-prefetch: neighbor 'news' newest segment replicated")
  log("zapPrefetch: playing movies warmed neighbor news' newest segment (" + warmedSeg + ') — fully local, never served over HTTP')
  await playerZ.stop()
  const zapWarmed = !!warmedSeg

  const pass = !!(streams.length && rejected && full.body.length > 0 && /video/.test(probeOut) &&
    livePushed >= 1 && rotated && ev2.fallback.length === 1 && ev2.sourceChanged.some(e => e.source === 'p2p') &&
    !ev2.status.includes('feed:open') && tuned && relookups >= 1 && wedgeHealed && zapWarmed)
  log('\nRESULT:', pass ? 'PASS ✅  (headless SDK: login → resolve → P2P HLS + catalog live-push + active-feed rotation-while-watching + hybrid CDN fallback/auto-return + tune self-heal + wedged-connection teardown + adjacent-channel zap prefetch verified)' : 'FAIL ❌')
  await cleanup(); process.exit(pass ? 0 : 1)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
