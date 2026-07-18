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
// Then the METADATA-ADVANCING-BUT-UNSERVABLE feed (the 2026-07-17 acceptance wedge):
// a broadcaster that rewrites the playlist while its blob bytes are reclaimed before
// any viewer can fetch them advances the metadata signature with ZERO servable bytes —
// the watchdog must NOT stand down on the advance alone; it must walk its full ladder
// (retune → connection teardown → friendly error) instead of spinning silently.
// Then the SAME pathological feed under HYBRID: the stall watchdog must fall back to
// CDN ('fallback' reason 'stall') despite the advancing signature, and the recovery
// probe must NOT flip the CDN viewer back to the unservable P2P source.
// Then ZAP PREFETCH (zapPrefetch option): playing a stream must warm the curated-order
// neighbors — their newest segment fully replicated locally without ever being served
// over HTTP, following the catalog's CURRENT (rotated) feedKey.
// Then SMOOTH ZAPPING (S21) on the same player: the runtime toggle
// (setZapPrefetch OFF↔ON mid-play, ranges dropped then re-warmed), the adaptive gate
// (metered network suspends immediately and lifts when cheap; an ACTIVE-stream stall
// suspends and a clean advance run resumes), and DIRECTIONAL prefetch (an adjacent
// up-zap warms only the up side; directional:false restores both). Then uploadPolicy:
// a 'client-only' viewer still plays but joins feed topics server:false (never
// announced ⇒ not discoverable ⇒ no viewer-to-viewer serving), while the default
// 'reseed' viewer's feed topic is joined server:true.
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
const dirs = { panel: tmp('e2es-panel-'), feed: tmp('e2es-feed-'), feed2: tmp('e2es-feed2-'), feed3: tmp('e2es-feed3-'), feed4: tmp('e2es-feed4-'), feed5: tmp('e2es-feed5-'), feed6: tmp('e2es-feed6-'), feedR: tmp('e2es-feedR-'), cli: tmp('e2es-cli-'), cli2: tmp('e2es-cli2-'), cli3: tmp('e2es-cli3-'), cli4: tmp('e2es-cli4-'), cli5: tmp('e2es-cli5-'), cli6: tmp('e2es-cli6-'), cliZ: tmp('e2es-cliZ-'), cliU: tmp('e2es-cliU-'), out: tmp('e2es-hls-') }
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

  // Fifth encrypted feed for the metadata-advancing-but-unservable case — created and
  // cataloged now, seeded (pathologically) only in its own scenario below.
  const encKey5 = hcrypto.randomBytes(32)
  const feedStore5 = new Corestore(dirs.feed5); await feedStore5.ready(); cleanups.push(() => feedStore5.close())
  const feed5 = new Hyperdrive(feedStore5.namespace('feed'), { encryptionKey: encKey5 }); await feed5.ready()

  // Sixth encrypted feed for the HYBRID unservable case — same pathological seeding
  // as the fifth, judged by the hybrid stall/recovery probes instead of the tune ladder.
  const encKey6 = hcrypto.randomBytes(32)
  const feedStore6 = new Corestore(dirs.feed6); await feedStore6.ready(); cleanups.push(() => feedStore6.close())
  const feed6 = new Hyperdrive(feedStore6.namespace('feed'), { encryptionKey: encKey6 }); await feed6.ready()

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
    wrapped: { news: sealTo(kp.publicKey, encKey), movies: sealTo(kp.publicKey, encKey2), shopping: sealTo(kp.publicKey, encKey3), sports: sealTo(kp.publicKey, encKey4), radio: sealTo(kp.publicKey, encKey5), talk: sealTo(kp.publicKey, encKey6) },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', protection: 'self', feedKey: b4a.toString(feed.key, 'hex'), isLive: true, poster: 'assets/news/poster.png', status: 'live' })
  await db.put('catalog/movies', { title: 'Movies', category: ['movies'], type: 'live', protection: 'self', feedKey: b4a.toString(feed2.key, 'hex'), isLive: true, poster: null, status: 'live', order: 1, featured: true })
  await db.put('catalog/shopping', { title: 'Shopping', category: ['shopping'], type: 'live', protection: 'self', feedKey: b4a.toString(feed3.key, 'hex'), isLive: true, poster: null, status: 'live' })
  await db.put('catalog/sports', { title: 'Sports', category: ['sports'], type: 'live', protection: 'self', feedKey: b4a.toString(feed4.key, 'hex'), isLive: true, poster: null, status: 'live' })
  await db.put('catalog/radio', { title: 'Radio', category: ['radio'], type: 'live', protection: 'self', feedKey: b4a.toString(feed5.key, 'hex'), isLive: true, poster: null, status: 'live' })
  await db.put('catalog/talk', { title: 'Talk', category: ['talk'], type: 'live', protection: 'self', feedKey: b4a.toString(feed6.key, 'hex'), isLive: true, poster: null, status: 'live' })

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

  // ===== Bee metadata caches bounded (the long-uptime client heap leak) =====
  // Every bee opened on the player's store (panel catalog + each feed's metadata bee)
  // must link into the ONE bounded globalCache — otherwise a viewer retains ~1.5 KB of
  // heap per replicated append forever (~4 MB/h per watched channel). retention-test
  // scenario C proves the eviction mechanics; this guards the SDK wiring against a
  // corestore/hyperbee upgrade silently dropping the link. Both globalSize getters read
  // the SAME shared array when linked (and the reads below are synchronous).
  const beeCache = player._store.globalCache
  if (!beeCache) throw new Error('player store has no globalCache — per-bee caches are unbounded again')
  const feedBeeKeys = player._feedDrive.db._nodeCache.keys
  if (feedBeeKeys.globalSize !== beeCache.globalSize) throw new Error('feed bee caches are not linked into the shared budget')
  if (!(beeCache.globalSize > 0)) throw new Error('shared bee cache budget unused — caches silently unlinked?')
  if (beeCache.globalSize > beeCache.maxSize) throw new Error(`bee cache exceeded its bound (${beeCache.globalSize} > ${beeCache.maxSize})`)
  log('sdk: bee caches share the bounded global budget (globalSize ' + beeCache.globalSize + ' <= ' + beeCache.maxSize + ')')

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
      if (s.length >= 6) streams2 = s // the prewarm-count assert below needs the FULL lineup entitled at login
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streams2) await sleep(1500)
  }

  // ===== Prewarm: login opened the entitled feeds ahead of any play =====
  // With prewarm:true, both entitled feeds ('news' + 'movies') are opened+joined in the
  // background at login, so the first zap to either is a cache hit — no cold feed:open.
  await player2.prewarm() // idempotent; deterministically wait out the background warm
  if (player2._feeds.size !== 6) throw new Error('prewarm should open all six entitled feeds; got ' + player2._feeds.size)
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

  // ===== Metadata-advancing but UNSERVABLE feed (the 2026-07-17 acceptance wedge) =====
  // The playlist SIGNATURE is metadata (the entry's bee seq); media bytes ride the
  // blobs core. A broadcaster that keeps rewriting the playlist while its blob bytes
  // are reclaimed before any viewer can fetch them advances the signature forever with
  // ZERO servable bytes — the advance-only watchdog stood down on the first tick and
  // its whole ladder (retune → teardown → friendly error) never ran. Simulate that
  // broadcaster exactly: put a fresh playlist every 500 ms and clear its blob blocks
  // immediately (the per-rotation reclaim in broadcaster/src/hls.js, made permanent).
  // The viewer must now KEEP the watchdog armed (content probe fails), walk the ladder
  // ('feed:retune', then 'feed:reconnect' — a peer IS attached), and surface the
  // friendly error instead of spinning silently forever.
  const feedSwarm5 = new Hyperswarm(); cleanups.push(() => feedSwarm5.destroy())
  feedSwarm5.on('connection', s => feed5.replicate(s))
  feedSwarm5.join(feed5.discoveryKey, { server: true, client: false }); await feedSwarm5.flush()
  const blobs5 = await feed5.getBlobs()
  let radioSeq = 0
  let radioBusy = false
  const radioTimer = setInterval(async () => {
    if (radioBusy) return
    radioBusy = true
    try {
      radioSeq++
      await feed5.put('/index.m3u8', b4a.from(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${radioSeq}\n#EXTINF:2,\nseg${radioSeq}.ts\n`))
      const cur = await feed5.entry('/index.m3u8')
      const cb = cur && cur.value.blob
      if (cb && cb.blockLength > 0) await blobs5.core.clear(cb.blockOffset, cb.blockOffset + cb.blockLength)
    } catch { /* teardown race at cleanup — fine */ } finally { radioBusy = false }
  }, 500)
  cleanups.push(() => clearInterval(radioTimer))

  const ev5 = { status: [], errors: [] }
  const player5 = createPlayer({
    panelPubKey,
    storeDir: dirs.cli5,
    tune: { timeoutMs: 4000, relookupMinMs: 1000, relookupMaxMs: 4000 }
  })
  player5.on('status', (s) => ev5.status.push(s.state))
  player5.on('error', (e) => ev5.errors.push(String((e && e.message) || e)))
  cleanups.push(() => player5.stop())

  await player5.connect()
  let streams5 = null
  const deadline5 = Date.now() + 60000
  while (!streams5) {
    if (Date.now() > deadline5) throw new Error('timeout: unservable-feed SDK login')
    try {
      const s = await player5.login('alice', PASSWORD)
      if (s.length >= 4) streams5 = s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streams5) await sleep(1500)
  }

  await resolveWithin(player5, 'radio', 20000)
  // Prove the scenario is what it claims: the metadata signature ADVANCES (the very
  // signal that used to stand the watchdog down) while zero content is servable.
  const sigA = await waitFor(() => player5._playlistSig(), 20000, 'unservable: playlist metadata lands')
  await waitFor(async () => { const s = await player5._playlistSig(); return s !== null && s !== sigA }, 15000, 'unservable: metadata signature advances')
  const unservableErr = await waitFor(async () => ev5.errors.find(m => /tune timeout/i.test(m)), 30000, "unservable: friendly 'error' despite an advancing playlist signature (advance-only stand-down regression)")
  if (!/radio/.test(unservableErr)) throw new Error('unservable: the error should name the stream: ' + unservableErr)
  if (!ev5.status.includes('feed:retune')) throw new Error("unservable: expected 'feed:retune' before the error")
  if (!ev5.status.includes('feed:reconnect')) throw new Error("unservable: expected 'feed:reconnect' (a peer IS attached — teardown must run) before the error")
  const unservableProven = !!unservableErr
  log('unservable: metadata advanced, zero bytes servable → retune → reconnect → friendly error ("' + unservableErr.slice(0, 60) + '…") — the watchdog no longer stands down on metadata alone')
  await player5.stop()

  // ===== HYBRID vs the metadata-advancing-but-unservable feed =====
  // Hybrid's stall watchdog and recovery probe judged P2P health by the playlist
  // SIGNATURE alone — the same metadata/blob conflation just proven above for the
  // tune watchdog. Against the pathological seeder the advance-only stall watchdog
  // never fired the CDN fallback (the viewer rebuffered on P2P with a "moving" live
  // edge and zero bytes), and the advance-only recovery probe would flip a CDN viewer
  // BACK to the unplayable feed and strand it there (fallback already spent). Both
  // now gate "healthy" on servable content: starting on P2P against the pathological
  // feed must produce 'fallback' (reason 'stall'), and while the feed stays
  // unservable the viewer must STAY on CDN — no 'source-changed' back to p2p.
  const feedSwarm6 = new Hyperswarm(); cleanups.push(() => feedSwarm6.destroy())
  feedSwarm6.on('connection', s => feed6.replicate(s))
  feedSwarm6.join(feed6.discoveryKey, { server: true, client: false }); await feedSwarm6.flush()
  const blobs6 = await feed6.getBlobs()
  let talkSeq = 0
  let talkBusy = false
  const talkTimer = setInterval(async () => {
    if (talkBusy) return
    talkBusy = true
    try {
      talkSeq++
      await feed6.put('/index.m3u8', b4a.from(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${talkSeq}\n#EXTINF:2,\nseg${talkSeq}.ts\n`))
      const cur = await feed6.entry('/index.m3u8')
      const cb = cur && cur.value.blob
      if (cb && cb.blockLength > 0) await blobs6.core.clear(cb.blockOffset, cb.blockOffset + cb.blockLength)
    } catch { /* teardown race at cleanup — fine */ } finally { talkBusy = false }
  }, 500)
  cleanups.push(() => clearInterval(talkTimer))

  const ev6 = { fallback: [], sourceChanged: [] }
  const player6 = createPlayer({
    panelPubKey,
    storeDir: dirs.cli6,
    prewarm: true, // warm 'talk' at login so the P2P start below is deterministic
    hybrid: { mode: 'hybrid', cdnUrl: () => cdnUrl, readyTimeoutMs: 4000, probeIntervalMs: 700, rebufferMsToFallback: 4000 }
  })
  player6.on('fallback', (e) => ev6.fallback.push(e))
  player6.on('source-changed', (e) => ev6.sourceChanged.push(e))
  cleanups.push(() => player6.stop())

  await player6.connect()
  let streams6 = null
  const deadline6 = Date.now() + 60000
  while (!streams6) {
    if (Date.now() > deadline6) throw new Error('timeout: hybrid-unservable SDK login')
    try {
      const s = await player6.login('alice', PASSWORD)
      if (s.length >= 6) streams6 = s // 'talk' must be entitled before the play below
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streams6) await sleep(1500)
  }

  // Deterministic P2P start: wait until the prewarmed replica holds the playlist
  // METADATA (the pathological seeder replicates it fine — only the bytes are gone),
  // so resolve()'s readiness check passes and hybrid picks p2p, exercising the stall
  // watchdog rather than the readyTimeout fallback.
  await player6.prewarm()
  const talkCacheKey = b4a.toString(feed6.key, 'hex') + ':' + b4a.toString(encKey6, 'hex')
  await waitFor(async () => {
    const f = await player6._feeds.get(talkCacheKey)
    return f && await f.drive.entry('/index.m3u8')
  }, 30000, 'hybrid-unservable: playlist metadata prewarmed')
  const r6 = await resolveWithin(player6, 'talk', 20000)
  if (r6.source !== 'p2p') throw new Error('hybrid-unservable: expected to start on p2p (metadata is present), got ' + r6.source)

  // The signature keeps advancing while zero bytes are servable — the advance-only
  // stall watchdog never fell back (the regression); the servable-gated one must.
  const fb6 = await waitFor(async () => ev6.fallback.find(e => e.streamId === 'talk' && e.reason === 'stall'), 30000, "hybrid-unservable: 'fallback' (reason stall) despite the advancing metadata signature")
  if (fb6.url !== cdnUrl) throw new Error('hybrid-unservable: fallback should carry the CDN url, got ' + fb6.url)
  if (player6.source().source !== 'cdn') throw new Error('hybrid-unservable: source() should report cdn after the stall fallback')
  // On CDN the recovery probe watches the SAME advancing-but-unservable feed — it
  // must NOT return to P2P (pre-fix it flipped within ~2 probes: ~1.4 s). Watch for
  // 8 s ≈ 11 probe intervals.
  await sleep(8000)
  if (ev6.sourceChanged.some(e => e.source === 'p2p')) throw new Error('hybrid-unservable: the recovery probe flipped back to an unservable P2P feed')
  if (player6.source().source !== 'cdn') throw new Error('hybrid-unservable: the viewer must STAY on cdn while the feed is unservable')
  const hybridUnservableProven = ev6.fallback.length >= 1
  log('hybrid-unservable: stall fallback fired despite the advancing signature; no flip-back while unservable — hybrid health now requires servable bytes')
  await player6.stop()

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
  const zapWarmed = !!warmedSeg

  // ===== S21 smooth zapping: runtime toggle + adaptive gate + directional (same player) =====
  // This is exactly what the app's Settings switch drives (setZapPrefetch /
  // setNetworkProfile) — asserted MID-PLAY, no restart anywhere.
  const zapEvents = []
  playerZ.on('zap-prefetch', (e) => zapEvents.push(e))

  // Live OFF mid-play: the warm loop dies and every standing range is dropped.
  playerZ.setZapPrefetch(false)
  if (!zapEvents.some(e => e.enabled === false)) throw new Error('setZapPrefetch(false) must echo {enabled:false}')
  if (playerZ._zapTimer || playerZ._zapRanges.size) throw new Error('OFF mid-play must stop the warm loop and drop the ranges')
  // Live ON mid-play: the loop re-arms against the ACTIVE stream and re-warms.
  playerZ.setZapPrefetch({ neighbors: 1, intervalMs: 700 })
  if (!zapEvents.some(e => e.enabled === true)) throw new Error('setZapPrefetch(cfg) must echo {enabled:true}')
  await waitFor(() => playerZ._zapRanges.has('news'), 25000, 'ON mid-play re-warms the neighbor')
  log('smooth-zap: live OFF↔ON switch mid-play (ranges dropped, then re-warmed)')

  // Metered network: suspend immediately (ranges gone), lift as soon as it is cheap.
  playerZ.setNetworkProfile({ expensive: true })
  if (!zapEvents.some(e => e.state === 'suspended' && e.reason === 'metered')) throw new Error('an expensive network must suspend prefetch')
  if (playerZ._zapRanges.size) throw new Error('the metered suspension must drop the warm ranges')
  playerZ.setNetworkProfile({ expensive: false })
  await waitFor(() => zapEvents.some(e => e.state === 'resumed'), 15000, "metered lift emits 'resumed'")
  await waitFor(() => playerZ._zapRanges.has('news'), 25000, 'post-metered re-warm')
  const meteredGated = true
  log('smooth-zap: metered suspend + immediate lift')

  // Directional: movies -> news is an adjacent UP move, so only the up side is warmed;
  // the seeded down-side neighbor (movies) must stay cold until directional is off.
  await resolveWithin(playerZ, 'news', 20000)
  if (playerZ._zapDir !== 1) throw new Error('an adjacent up-zap must set direction +1, got ' + playerZ._zapDir)
  await sleep(2500) // several warm ticks under the directional config
  if (playerZ._zapRanges.has('movies')) throw new Error('directional prefetch warmed the down-side neighbor')
  if (playerZ._zapRanges.has('news')) throw new Error('the active channel must never be in the warm set')
  playerZ.setZapPrefetch({ neighbors: 1, intervalMs: 700, directional: false, stallMs: 4000, resumeMs: 3000 })
  await waitFor(() => playerZ._zapRanges.has('movies'), 25000, 'directional:false warms both sides (movies)')
  const directionalProven = true
  log('smooth-zap: directional up-zap warms only the up side; directional:false restores both')

  // Stall gate: freeze the ACTIVE (rotated news) mirror — the playlist stops advancing,
  // so prefetch must stand down rather than compete; feeding the mirror again must
  // resume after a clean run (test-tuned stallMs/resumeMs above).
  stopMirrorRot()
  await waitFor(() => zapEvents.some(e => e.state === 'suspended' && e.reason === 'stall'), 30000, 'an active-stream stall suspends prefetch')
  if (playerZ._zapRanges.size) throw new Error('the stall suspension must drop the warm ranges')
  const resumesBeforeRefeed = zapEvents.filter(e => e.state === 'resumed').length
  const stopMirrorRot2 = mirrorDirToDrive(dirs.out, feedRot, { interval: 400 }); cleanups.push(() => stopMirrorRot2())
  await waitFor(() => zapEvents.filter(e => e.state === 'resumed').length > resumesBeforeRefeed, 45000, 'a clean advance run lifts the stall suspension')
  await waitFor(() => playerZ._zapRanges.has('movies'), 25000, 'post-stall re-warm')
  const stallGated = true
  log('smooth-zap: active-stream stall suspends prefetch; a clean run resumes it')

  // Default uploadPolicy really announces (the re-seeding 'client-only' turns off).
  const feedZr = await playerZ._feeds.get(rotKeyHex + ':' + b4a.toString(encKey, 'hex'))
  if (!feedZr || feedZr.discovery.isServer !== true || feedZr.discovery.isClient !== true) throw new Error("default uploadPolicy must join feed topics server:true (re-seed)")
  await playerZ.stop()

  // ===== uploadPolicy 'client-only': plays fine, but never announces on feed topics =====
  // server:false is the hyperswarm mechanism behind "serves nothing to other viewers":
  // an unannounced peer is not discoverable on the topic, so a probing viewer can never
  // dial it — practically zero viewer-to-viewer upload by construction.
  const playerU = createPlayer({ panelPubKey, storeDir: dirs.cliU, uploadPolicy: 'client-only' })
  cleanups.push(() => playerU.stop())
  await playerU.connect()
  let streamsU = null
  const deadlineU = Date.now() + 60000
  while (!streamsU) {
    if (Date.now() > deadlineU) throw new Error('timeout: client-only SDK login')
    try {
      const s = await playerU.login('alice', PASSWORD)
      if (s.length >= 4) streamsU = s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streamsU) await sleep(1500)
  }
  const rU = await resolveWithin(playerU, 'news', 20000)
  await waitFor(async () => { const r = await httpGet(rU.port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') }, 40000, 'client-only viewer still plays over P2P')
  const feedU = await playerU._feeds.get(rotKeyHex + ':' + b4a.toString(encKey, 'hex'))
  if (!feedU || feedU.discovery.isServer !== false || feedU.discovery.isClient !== true) throw new Error('client-only must join feed topics server:false')
  await playerU.stop()
  const clientOnlyProven = true
  log("uploadPolicy: 'client-only' played news but joined its topic UNANNOUNCED (server:false); the default player announced (server:true)")

  const pass = !!(streams.length && rejected && full.body.length > 0 && /video/.test(probeOut) &&
    livePushed >= 1 && rotated && ev2.fallback.length === 1 && ev2.sourceChanged.some(e => e.source === 'p2p') &&
    !ev2.status.includes('feed:open') && tuned && relookups >= 1 && wedgeHealed && unservableProven && hybridUnservableProven && zapWarmed &&
    meteredGated && directionalProven && stallGated && clientOnlyProven)
  log('\nRESULT:', pass ? 'PASS ✅  (headless SDK: login → resolve → P2P HLS + catalog live-push + active-feed rotation-while-watching + hybrid CDN fallback/auto-return + tune self-heal + wedged-connection teardown + unservable-feed escalation (tune + hybrid) + adjacent-channel zap prefetch + S21 smooth-zapping toggle/gate/directional + client-only uploadPolicy verified)' : 'FAIL ❌')
  await cleanup(); process.exit(pass ? 0 : 1)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
