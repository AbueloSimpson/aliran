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
// Then RE-ZAP TO AN EVICTED CHANNEL: the feed-cache LRU PURGES the replica it drops, and
// a purged core never re-attaches to an already-established protomux — so re-opening it
// over the still-live broadcaster connection (one socket carries every channel of a peer)
// used to hand back a replica with ZERO peers, which the tune ladder cannot rescue
// because its teardown rung is skipped for exactly that symptom. The re-open must destroy
// that connection and dial fresh; the other channel cached on the socket recovers by itself.
// Then REDIRECT channels (S23): a catalog entry {redirect:true, url} is a different
// CLASS — viewers play the operator's https URL directly. resolve() must return it
// VERBATIM (source 'cdn', no port, no feed open, no watchdog), a url edit must reach
// the very next tune (live catalog read, no re-login), a feedless NON-redirect entry
// must still throw 'not broadcasting', and zapping p2p↔redirect must arm/clear the
// tune watchdog cleanly with the hybrid machinery untouched.
// Then LIVE ENTITLEMENT (S57): the SDK watches the viewer's own panel-signed
// `user/<name>` record, so a channel cataloged AND granted mid-session becomes playable
// with NO re-login, a revoked one leaves the lineup and can no longer be resolved
// (without tearing down the active play), and a newly granted P2P channel is correctly
// held back until the next login — the engine keeps no private key to unseal it. Removal
// is symmetric with admission, so a P2P grant survives the panel's two-put
// revoke->reconcile. tools/e2e-live-entitlement-test.mjs covers the same ground on a
// LOCAL testnet (deterministic) — keep the two in step.
// Then the VIEWER-DISK ROTATION of the ACTIVE feed — a different thing entirely from the
// broadcaster feedKey rotation above (that is a CATALOG event; this is a DISK bound). Where
// hypercore's clear() frees zero bytes — 32-bit Android, where `fs-native-extensions` is
// excluded and random-access-file's `_del` reports success and frees nothing — unlink is the
// only reclaim there is, so the engine purges the ACTIVE replica and re-opens it empty under
// the live play. The section drives it through _onFeedOverBudget, the callback sdk/serve.js's
// Reclaim really invokes, and proves the whole contract: the swap is invisible (same port,
// same source(), no 'feed-changed', playlist advancing again, and the replica genuinely
// UNLINKED rather than closed); a media request fired mid-swap PARKS and then serves 200
// instead of taking the instant 404 that costs a ~5.5 s remount; the rotation is single-flight
// and releases its mutex on success, on refusal, on failure and on stop(); _evictFeed and
// _retuneActive both stand down on the cache slot it owns; a cast-pinned feed is refused
// before the mutex is even taken AND again after the drain; a re-open that misses its bound
// recovers; and stop() mid-rotation rebuilds no store, swarm or server behind itself.
// Runs on a LOCAL DHT testnet (never the public DHT), like every other e2e lane here.
// Requires ffmpeg/ffprobe on PATH. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
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
// A call that MUST reject, with a message matching `re`. Resolving is as much a failure
// as the wrong error — an entitlement gate that quietly succeeds is the bug being tested.
async function assertRejects (fn, re, label) {
  let msg = null
  try { await fn() } catch (e) { msg = String(e.message) }
  if (msg === null) throw new Error(label + ' must reject, but it resolved')
  if (!re.test(msg)) throw new Error(label + ' rejected with the wrong error: ' + msg)
}
function httpGet (port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}
// waitFor's 300 ms poll is right for waiting on the NETWORK. It is wrong for a window this
// test opened on purpose and is going to close itself — a feed rotation's park budget is
// 2500 ms in total, so a 300 ms poll can burn a third of it just noticing the window is open.
async function spinFor (fn, ms, label) {
  const t = Date.now()
  for (;;) {
    try { const v = fn(); if (v) return v } catch {}
    if (Date.now() - t >= ms) throw new Error('timeout: ' + label)
    await sleep(10)
  }
}
// The synchronous sibling of assertRejects, for construction-time refusals.
function assertThrows (fn, re, label) {
  let msg = null
  try { fn() } catch (e) { msg = String(e.message) }
  if (msg === null) throw new Error(label + ' must throw, but it returned')
  if (!re.test(msg)) throw new Error(label + ' threw the wrong error: ' + msg)
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
const dirs = { panel: tmp('e2es-panel-'), feed: tmp('e2es-feed-'), feed2: tmp('e2es-feed2-'), feed3: tmp('e2es-feed3-'), feed4: tmp('e2es-feed4-'), feed5: tmp('e2es-feed5-'), feed6: tmp('e2es-feed6-'), feedR: tmp('e2es-feedR-'), feedE: tmp('e2es-feedE-'), cli: tmp('e2es-cli-'), cli2: tmp('e2es-cli2-'), cli3: tmp('e2es-cli3-'), cli4: tmp('e2es-cli4-'), cli5: tmp('e2es-cli5-'), cli6: tmp('e2es-cli6-'), cliZ: tmp('e2es-cliZ-'), cliU: tmp('e2es-cliU-'), cliC: tmp('e2es-cliC-'), cliD: tmp('e2es-cliD-'), cliE: tmp('e2es-cliE-'), out: tmp('e2es-hls-') }
// corestore 6 keeps every core at cores/<id[0:2]>/<id[2:4]>/<id> (id = discovery key hex),
// and hypercore's purge UNLINKS the four storage files, sometimes leaving the empty
// directory behind — so "still on disk" means "still has files in it".
const corePath = (storeDir, discoveryKey) => {
  const id = b4a.toString(discoveryKey, 'hex')
  return path.join(storeDir, 'cores', id.slice(0, 2), id.slice(2, 4), id)
}
const coreOnDisk = (p) => { try { return fs.readdirSync(p).length > 0 } catch { return false } }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Local DHT testnet =====
  // Every swarm and player below is pinned to it. This lane used to ride the PUBLIC DHT
  // — alone among the e2e lanes — which made it flaky to the point of uselessness: five
  // consecutive runs failed at five DIFFERENT sections, and a run on unmodified main
  // failed earliest of all, at the first login. Nothing here needs the real DHT: the
  // tune self-heal exercises re-LOOKUPS, which a testnet performs just as well.
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap

  // ===== Broadcaster: encrypted feed =====
  const encKey = hcrypto.randomBytes(32)
  const feedStore = new Corestore(dirs.feed); await feedStore.ready(); cleanups.push(() => feedStore.close())
  const feed = new Hyperdrive(feedStore.namespace('feed'), { encryptionKey: encKey }); await feed.ready()
  const feedSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => feedSwarm.destroy())
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
  const feedSwarm4 = new Hyperswarm({ bootstrap }); cleanups.push(() => feedSwarm4.destroy())
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
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', protection: 'self', feedKey: b4a.toString(feed.key, 'hex'), isLive: true, poster: 'assets/news/poster.png', status: 'live', epgUrl: 'https://epg.example.com/news.json', epgId: 'news-24' })
  await db.put('catalog/movies', { title: 'Movies', category: ['movies'], type: 'live', protection: 'self', feedKey: b4a.toString(feed2.key, 'hex'), isLive: true, poster: null, status: 'live', order: 1, featured: true, restricted: true })
  await db.put('catalog/shopping', { title: 'Shopping', category: ['shopping'], type: 'live', protection: 'self', feedKey: b4a.toString(feed3.key, 'hex'), isLive: true, poster: null, status: 'live' })
  await db.put('catalog/sports', { title: 'Sports', category: ['sports'], type: 'live', protection: 'self', feedKey: b4a.toString(feed4.key, 'hex'), isLive: true, poster: null, status: 'live' })
  await db.put('catalog/radio', { title: 'Radio', category: ['radio'], type: 'live', protection: 'self', feedKey: b4a.toString(feed5.key, 'hex'), isLive: true, poster: null, status: 'live' })
  await db.put('catalog/talk', { title: 'Talk', category: ['talk'], type: 'live', protection: 'self', feedKey: b4a.toString(feed6.key, 'hex'), isLive: true, poster: null, status: 'live' })

  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  const throttle = makeThrottle(1000, 60)
  const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle, db, sessionTtlMs: 3600000 }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()
  log('panel: serving login RPC; pubkey', panelPubKey.slice(0, 16) + '…')

  // ===== SDK: the whole client side, headless =====
  const events = { ready: 0, streams: 0, lastStreams: null, status: [], peers: [], feedChanged: [] }
  const player = createPlayer({ panelPubKey, storeDir: dirs.cli, swarm: { bootstrap } })
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
  // EPG pointers (S27) pass through the display list (public https, like art URLs).
  if (disp.epgUrl !== 'https://epg.example.com/news.json' || disp.epgId !== 'news-24') throw new Error('EPG pointers missing from login display list: ' + JSON.stringify({ epgUrl: disp.epgUrl, epgId: disp.epgId }))
  // Curation passthrough (S16c): order/featured reach the display list untouched.
  const dispMovies = streams.find(x => x.id === 'movies')
  if (dispMovies.order !== 1 || dispMovies.featured !== true) throw new Error('curation fields missing from login display list: ' + JSON.stringify({ order: dispMovies.order, featured: dispMovies.featured }))
  // Access control passthrough: restricted reaches the display list (parental PIN gating
  // is the HOST's job — the flag must arrive); unflagged channels read false, not absent.
  if (dispMovies.restricted !== true) throw new Error('restricted missing from login display list')
  if (disp.restricted !== false) throw new Error('unflagged channel must carry restricted:false')
  if (dispMovies.epgUrl !== undefined || dispMovies.epgId !== undefined) throw new Error('a channel with no EPG must not grow epg pointers')
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
  const rotSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => rotSwarm.destroy())
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
    swarm: { bootstrap },
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
  const feedSwarm2 = new Hyperswarm({ bootstrap }); cleanups.push(() => feedSwarm2.destroy())
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
    swarm: { bootstrap },
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
  const feedSwarm3 = new Hyperswarm({ bootstrap }); cleanups.push(() => feedSwarm3.destroy())
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
    swarm: { bootstrap },
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
  const feedSwarm5 = new Hyperswarm({ bootstrap }); cleanups.push(() => feedSwarm5.destroy())
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
    swarm: { bootstrap },
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
  const feedSwarm6 = new Hyperswarm({ bootstrap }); cleanups.push(() => feedSwarm6.destroy())
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
    swarm: { bootstrap },
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
  const playerZ = createPlayer({ panelPubKey, storeDir: dirs.cliZ, swarm: { bootstrap }, zapPrefetch: { neighbors: 1, intervalMs: 700 } })
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
  const playerU = createPlayer({ panelPubKey, storeDir: dirs.cliU, swarm: { bootstrap }, uploadPolicy: 'client-only' })
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
  const cacheKeyU = rotKeyHex + ':' + b4a.toString(encKey, 'hex')
  const feedU = await playerU._feeds.get(cacheKeyU)
  if (!feedU || feedU.discovery.isServer !== false || feedU.discovery.isClient !== true) throw new Error('client-only must join feed topics server:false')

  // ===== S25: setUploadPolicy flips re-seeding at RUNTIME, mid-playback =====
  // The point of the feature: a viewer who walks from Wi-Fi onto cellular must stop
  // uploading NOW, not at the next app start. `client` must stay true throughout or the
  // switch would interrupt their own playback — which is the one thing it may not do.
  const stillPlaying = async () => {
    const r = await httpGet(rU.port, '/index.m3u8')
    return r.status === 200 && r.body.includes('.ts')
  }
  const upEvents = []
  playerU.on('upload-policy', (e) => upEvents.push(e))

  let sw = await playerU.setUploadPolicy('reseed')
  if (!sw.changed || sw.rejoined < 1) throw new Error('setUploadPolicy(reseed) should have re-joined at least the open feed')
  const feedOn = await playerU._feeds.get(cacheKeyU)
  if (feedOn.discovery.isServer !== true) throw new Error('runtime switch to reseed must announce (server:true)')
  if (feedOn.discovery.isClient !== true) throw new Error('runtime switch must KEEP client:true — playback must not blip')
  if (!(await stillPlaying())) throw new Error('playback broke when upload policy switched to reseed')

  sw = await playerU.setUploadPolicy('client-only')
  if (!sw.changed) throw new Error('setUploadPolicy(client-only) should report changed')
  const feedOff = await playerU._feeds.get(cacheKeyU)
  if (feedOff.discovery.isServer !== false) throw new Error('runtime switch to client-only must stop announcing (server:false)')
  if (feedOff.discovery.isClient !== true) throw new Error('client:true must survive the switch back')
  if (!(await stillPlaying())) throw new Error('playback broke when upload policy switched to client-only')

  // idempotent: re-applying the same policy is a no-op, not another round of re-joins
  const same = await playerU.setUploadPolicy('client-only')
  if (same.changed !== false || same.rejoined !== 0) throw new Error('re-applying the same uploadPolicy must be a no-op')
  if (playerU.uploadPolicy !== 'client-only') throw new Error('uploadPolicy getter must reflect the live policy')
  if (upEvents.length !== 2) throw new Error(`expected 2 upload-policy events, got ${upEvents.length}`)
  log('S25: setUploadPolicy flipped announce on/off mid-playback (client:true kept, stream never broke), and is idempotent')

  // ===== feed-cache LRU: browsing must not leave every visited feed open =====
  // Before this bound, zapping away destroyed the download range but kept the drive and
  // its swarm topic open for the whole session — measured on a live broadcaster as six
  // channels holding a peer link each with no decay over 25 minutes. Each lingering topic
  // eats a slot in that channel's SWARM_MAX_PEERS budget.
  const limit = playerU._feedLimit
  if (!Number.isInteger(limit) || limit < 2) throw new Error('_feedLimit must be a sane integer')
  for (let i = 0; i < limit + 6; i++) {
    // distinct, never-resolvable keys: we only care that the CACHE is bounded
    const fake = hcrypto.randomBytes(32).toString('hex')
    playerU._feeds.set(fake + ':x', Promise.resolve({ drive: { discoveryKey: hcrypto.randomBytes(32), close: async () => {} }, discovery: {} }))
  }
  playerU._trimFeeds()
  if (playerU._feeds.size > limit) throw new Error(`feed cache unbounded: ${playerU._feeds.size} > ${limit}`)
  if (!playerU._feeds.has(playerU._activeFeedKey)) throw new Error('LRU evicted the ACTIVE feed — playback would break')
  if (!(await stillPlaying())) throw new Error('playback broke after the feed cache was trimmed')
  log(`feed-cache LRU: bounded at ${limit} feeds, active feed never evicted, playback unaffected`)

  await playerU.stop()
  const clientOnlyProven = true
  log("uploadPolicy: 'client-only' played news but joined its topic UNANNOUNCED (server:false); the default player announced (server:true)")

  // ===== Re-zap to an EVICTED channel: a purged replica needs a FRESH DIAL =====
  // The LRU above does not merely close the feed it drops — it PURGES the replica's
  // storage, and a hypercore whose storage was purged NEVER re-attaches to an
  // already-established protomux (measured on the bare stack: close+re-open resumes at
  // once, purge+re-open never does — at any delay, under any namespace — and only
  // destroying the connection so hyperswarm re-dials recovers it). One socket carries
  // every channel of a peer, so the re-zap back to a trimmed channel re-opens over the
  // SAME broadcaster connection the rest of the lineup is still replicating over, and
  // comes back with ZERO peers. The tune ladder cannot rescue that: its 'feed:reconnect'
  // rung is skipped precisely BECAUSE the symptom is zero peers, so pre-fix the channel
  // died with a friendly 'tune timeout' and stayed dead for the whole session.
  // Reproduced in the PRODUCTION SHAPE — one seeder serving TWO channels over ONE socket
  // (hyperswarm keeps one connection per peer) — so the trimmed channel's re-open is
  // proven to land on a connection the other channel is still demonstrably using.
  const encKeyE1 = hcrypto.randomBytes(32)
  const encKeyE2 = hcrypto.randomBytes(32)
  const storeE = new Corestore(dirs.feedE); await storeE.ready(); cleanups.push(() => storeE.close())
  const feedE1 = new Hyperdrive(storeE.namespace('e1'), { encryptionKey: encKeyE1 }); await feedE1.ready()
  const feedE2 = new Hyperdrive(storeE.namespace('e2'), { encryptionKey: encKeyE2 }); await feedE2.ready()
  const evictSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => evictSwarm.destroy())
  evictSwarm.on('connection', (s) => { feedE1.replicate(s); feedE2.replicate(s) })
  evictSwarm.join(feedE1.discoveryKey, { server: true, client: false })
  evictSwarm.join(feedE2.discoveryKey, { server: true, client: false })
  await evictSwarm.flush()
  const stopMirrorE1 = mirrorDirToDrive(dirs.out, feedE1, { interval: 400 }); cleanups.push(() => stopMirrorE1())
  const stopMirrorE2 = mirrorDirToDrive(dirs.out, feedE2, { interval: 400 }); cleanups.push(() => stopMirrorE2())

  // Own user + channels: every count gate above stays untouched (the cdnuser pattern).
  const kpE = userKeyPair()
  const authE = authKeyPair()
  const saltE = randomSalt()
  await db.put('user/evictuser', {
    salt: b4a.toString(saltE, 'hex'),
    verifier: b4a.toString(deriveVerifier(rwd, saltE, ARGON2_DEFAULT), 'hex'),
    argon: ARGON2_DEFAULT,
    pub: b4a.toString(kpE.publicKey, 'hex'),
    encPriv: wrap(wk, kpE.secretKey),
    authPub: b4a.toString(authE.publicKey, 'hex'),
    authPrivEnc: wrap(wk, authE.secretKey),
    wrapped: { evicta: sealTo(kpE.publicKey, encKeyE1), evictb: sealTo(kpE.publicKey, encKeyE2) },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })
  await db.put('catalog/evicta', { title: 'Evict A', category: ['misc'], type: 'live', protection: 'self', feedKey: b4a.toString(feedE1.key, 'hex'), isLive: true, poster: null, status: 'live' })
  await db.put('catalog/evictb', { title: 'Evict B', category: ['misc'], type: 'live', protection: 'self', feedKey: b4a.toString(feedE2.key, 'hex'), isLive: true, poster: null, status: 'live' })

  // Short tune ladder so a pre-fix run reaches its friendly error quickly (retune at 9 s,
  // reconnect-or-give-up at 18 s) instead of stretching this lane out.
  const evE = { status: [], errors: [] }
  const playerE = createPlayer({
    panelPubKey,
    storeDir: dirs.cliE,
    swarm: { bootstrap },
    tune: { timeoutMs: 9000, relookupMinMs: 1000, relookupMaxMs: 9000 }
  })
  playerE.on('status', (s) => evE.status.push(s.state))
  playerE.on('error', (e) => evE.errors.push(String((e && e.message) || e)))
  cleanups.push(() => playerE.stop())
  await playerE.connect()
  let streamsE = null
  const deadlineE = Date.now() + 60000
  while (!streamsE) {
    if (Date.now() > deadlineE) throw new Error('timeout: evict-reopen SDK login')
    try {
      const s = await playerE.login('evictuser', PASSWORD)
      if (s.length >= 2) streamsE = s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streamsE) await sleep(1500)
  }

  const rE1 = await resolveWithin(playerE, 'evicta', 20000)
  await waitFor(async () => { const r = await httpGet(rE1.port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') }, 40000, 'evicta plays over P2P')
  const eKeyA = b4a.toString(feedE1.key, 'hex') + ':' + b4a.toString(encKeyE1, 'hex')
  const driveEA = (await playerE._feeds.get(eKeyA)).drive
  const coreEA = corePath(dirs.cliE, driveEA.discoveryKey)
  if (!coreOnDisk(coreEA)) throw new Error("evict-reopen: could not find the replica's core on disk: " + coreEA)

  // Zap to the OTHER channel of the same seeder: A stays warm in the cache, B is served.
  const rE2 = await resolveWithin(playerE, 'evictb', 20000)
  await waitFor(async () => { const r = await httpGet(rE2.port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') }, 40000, 'evictb plays over P2P')
  const driveEB = playerE._feedDrive
  const socketsOf = (d) => [...new Set([...d.core.peers].map((p) => p.stream))]
  const seederSock = [...playerE._swarm.connections].find((s) => b4a.equals(s.remotePublicKey, evictSwarm.keyPair.publicKey))
  if (!seederSock) throw new Error('evict-reopen: no connection to the two-channel seeder')
  const socksA = socketsOf(driveEA)
  const socksB = socketsOf(driveEB)
  if (socksA.length !== 1 || socksB.length !== 1 || socksA[0] !== socksB[0] || socksA[0] !== seederSock) {
    throw new Error(`evict-reopen: both channels must ride ONE socket (the production shape); A=${socksA.length} B=${socksB.length} shared=${socksA[0] === socksB[0]}`)
  }
  log('evict-reopen: both channels replicating from one seeder over ONE connection')

  // EVICT through the real LRU path — _trimFeeds keeps only the feed being served.
  const limitE = playerE._feedLimit
  playerE._feedLimit = 1
  playerE._trimFeeds()
  playerE._feedLimit = limitE
  if (playerE._feeds.has(eKeyA)) throw new Error('evict-reopen: the LRU should have dropped the warm (non-active) feed')
  // …and the eviction really PURGED it. If purge() had degraded to its plain-close
  // fallback the replica would still hold every block, the re-open below would serve from
  // local storage with no peer at all, and this whole lane would pass for the wrong reason.
  await waitFor(async () => !coreOnDisk(coreEA), 20000, "the evicted replica's storage is purged from disk")

  // The precondition the defect needs: nothing re-dialled the seeder in between. The
  // socket is the same object, and the other channel is still moving bytes over it.
  if (seederSock.destroyed || !playerE._swarm.connections.has(seederSock)) throw new Error('evict-reopen: the seeder connection should still be ESTABLISHED after the purge')
  const beforePl = (await httpGet(rE2.port, '/index.m3u8')).body.toString()
  await waitFor(async () => { const r = await httpGet(rE2.port, '/index.m3u8'); return r.status === 200 && r.body.toString() !== beforePl }, 20000, 'the surviving channel keeps advancing over that same socket')
  log('evict-reopen: purged the trimmed replica; the seeder connection is untouched and still carrying the other channel')

  // THE RE-ZAP. Pre-fix this replica comes back with zero peers and never serves a byte:
  // 'feed:retune' at 9 s (a close+re-open — the connection is already poisoned), then the
  // 'feed:reconnect' rung SKIPPED for want of a peer to tear down, then the friendly error.
  const markE = evE.status.length
  const rE3 = await resolveWithin(playerE, 'evicta', 20000)
  if (b4a.toString(playerE._feedDrive.key, 'hex') !== b4a.toString(feedE1.key, 'hex')) throw new Error('evict-reopen: the re-zap must serve the evicted feed again')
  let healedPlE = null
  try {
    healedPlE = await waitFor(async () => {
      const r = await httpGet(rE3.port, '/index.m3u8')
      return r.status === 200 && r.body.includes('.ts') ? r.body.toString() : null
    }, 30000, 're-zap to the evicted channel replicates again (purged replica + established connection = dead channel)')
  } catch (err) {
    // The whole point of this lane is WHICH way it fails, so say so rather than leaving a
    // bare timeout: zero peers on a connection that is alive and carrying the neighbour is
    // the purged-protomux signature, and a ladder that retunes but never reconnects is it
    // being skipped for want of a peer to tear down.
    const peers = playerE._feedDrive ? playerE._feedDrive.core.peers.length : 'no drive'
    throw new Error(`${err.message} — peers=${peers}, seeder socket destroyed=${seederSock.destroyed}, ladder=${JSON.stringify(evE.status.slice(markE))}, errors=${JSON.stringify(evE.errors)}`)
  }
  if (evE.errors.some((m) => /tune timeout/i.test(m))) throw new Error('evict-reopen: the channel died with the friendly tune error: ' + JSON.stringify(evE.errors))
  if (playerE._feedDrive.core.peers.length < 1) throw new Error('evict-reopen: the re-opened replica must have a peer')
  // Mechanism, not just outcome: only a FRESH DIAL clears a purged core's protomux state.
  if (!seederSock.destroyed) throw new Error('evict-reopen: the poisoned connection must be destroyed so hyperswarm re-dials')
  // Bounded collateral: that teardown took the whole socket, so the OTHER channel cached
  // on it must re-replicate by itself on the fresh connection.
  await waitFor(async () => driveEB.core.peers.length >= 1, 25000, 'the other channel on that socket re-replicates on the fresh connection')
  const healedSegsE = healedPlE.split('\n').filter((l) => l.trim().endsWith('.ts')).length
  log('evict-reopen: re-zap to the trimmed channel dialled fresh and plays (' + healedSegsE + ' segs); the neighbour on that socket recovered too')

  // The mirror image, and the reason the teardown is per-SOCKET-OBJECT rather than per
  // peer: a replica purged on a connection that has ALREADY gone needs no hang-up at all,
  // because whatever replaced it never carried the purged core. Getting that wrong the
  // other way would spend a reconnect on the whole lineup every time a channel came back.
  await resolveWithin(playerE, 'evictb', 20000) // B served again, A warm behind it
  // Read the live connection off the SERVED drive rather than scanning swarm.connections:
  // this is the socket the feeds actually ride, and it survives hyperswarm churning a
  // duplicate dial straight after the teardown above.
  const sockHealed = (await waitFor(async () => {
    const s = socketsOf(playerE._feedDrive)
    return s.length === 1 && !s[0].destroyed && s[0] !== seederSock ? s[0] : null
  }, 30000, 'the re-dialled seeder connection settles and carries the served channel'))
  playerE._feedLimit = 1
  playerE._trimFeeds()
  playerE._feedLimit = limitE
  await waitFor(async () => !coreOnDisk(coreEA), 20000, 'the second trim purges that replica again')
  const recorded = playerE._purgedFeeds.get(b4a.toString(feedE1.key, 'hex')) || []
  if (!recorded.some((p) => p.socket === sockHealed)) throw new Error('evict-reopen: the second purge must be recorded against the connection it happened on')
  sockHealed.destroy() // stand-in for anything that replaces a connection: a flap, the ladder's own rung, a rotation
  const sockFlapped = await waitFor(async () => {
    const s = socketsOf(playerE._feedDrive)
    return s.length === 1 && s[0] !== sockHealed && !s[0].destroyed ? s[0] : null
  }, 30000, 'hyperswarm re-dials the seeder after the flap')
  const rE4 = await resolveWithin(playerE, 'evicta', 20000)
  await waitFor(async () => { const r = await httpGet(rE4.port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') }, 30000, 'the twice-purged channel plays over the connection that replaced the one it was purged on')
  if (sockFlapped.destroyed) throw new Error('evict-reopen: a purge whose connection already died must NOT cost the lineup a second hang-up')
  const evictReopenProven = !!healedPlE
  log('evict-reopen: a replica purged on a connection that has since been replaced plays with no second hang-up')

  // ----- The METADATA bound's IDLE half rides this same eviction machinery -----
  // An idle warm feed's hyperbee follows the broadcaster's head for as long as the feed
  // stays cached (~1.1-1.2 MB/h measured on the vc10 soak), a hole punch cannot free any
  // of it, and the bytes are pure history — so past _metaIdleEvictBytes the maintenance
  // pass (_trimFeedBytes) EVICTS the feed outright, through the very _evictFeed +
  // purged-feed-ledger path this lane has just proven twice. evicta is ACTIVE (rE4);
  // evictb is the idle one. The threshold is injected at 1 byte so any real bee is over
  // it — which also makes the ACTIVE feed's survival a live assertion on the pinned set,
  // not on its size.
  const eKeyB = b4a.toString(feedE2.key, 'hex') + ':' + b4a.toString(encKeyE2, 'hex')
  if (!playerE._feeds.has(eKeyB)) throw new Error('idle-meta: expected evictb to be warm in the cache')
  const idleDriveB = (await playerE._feeds.get(eKeyB)).drive
  const coreEB = corePath(dirs.cliE, idleDriveB.discoveryKey)
  if (!coreOnDisk(coreEB)) throw new Error('idle-meta: could not find the idle replica on disk: ' + coreEB)
  const activeDriveBefore = playerE._feedDrive
  const savedIdleThreshold = playerE._metaIdleEvictBytes
  if (!(savedIdleThreshold === 16 * 1024 * 1024)) throw new Error('idle-meta: the default idle threshold should be a quarter of the 64 MiB meta budget, got ' + savedIdleThreshold)
  playerE._metaIdleEvictBytes = 1
  await waitFor(async () => { await playerE._trimFeedBytes(); return !playerE._feeds.has(eKeyB) }, 20000, 'idle-meta: the maintenance pass evicts the meta-bloated idle feed')
  playerE._metaIdleEvictBytes = savedIdleThreshold
  if (!playerE._feeds.has(eKeyA)) throw new Error('idle-meta: the ACTIVE feed was evicted by the idle meta threshold — the pinned set must protect it')
  if (playerE._feedDrive !== activeDriveBefore) throw new Error('idle-meta: the served drive moved across an idle eviction')
  await waitFor(async () => !coreOnDisk(coreEB), 20000, 'idle-meta: the evicted replica is purged from disk')
  if (!(playerE._purgedFeeds.get(b4a.toString(feedE2.key, 'hex')) || []).length) throw new Error('idle-meta: the eviction must land in the purged-feed ledger so the next tune dials fresh')
  const metaCrumb = playerE._eventRing.find((e) => e.type === 'meta-evict')
  if (!metaCrumb || !metaCrumb.detail.includes(eKeyB.slice(0, 8))) throw new Error('idle-meta: no meta-evict breadcrumb naming the feed: ' + JSON.stringify(metaCrumb || null))
  // …and the re-zap takes the ledger path this lane proved: hang up, dial fresh, play.
  const rE5 = await resolveWithin(playerE, 'evictb', 20000)
  await waitFor(async () => { const r = await httpGet(rE5.port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') }, 30000, 'idle-meta: the meta-evicted channel plays again on a fresh dial')
  log('idle-meta: the maintenance pass evicted the meta-bloated IDLE feed (breadcrumb + purged-feed ledger recorded), the active feed survived on the pinned set, and the re-zap dialled fresh and plays')
  await playerE.stop()

  // ===== S23 redirect channels: catalog {redirect:true, url} plays the URL, no P2P =====
  // A redirect channel is a different CLASS of catalog entry: no broadcaster, no feed —
  // the record carries an operator-set https URL and resolve() hands it to the host
  // verbatim (source 'cdn', no port) with the P2P machinery fully dormant. Run under
  // the app's DEFAULT p2p-only mode (no hybrid config) — the production shape. A fresh
  // user keeps every count gate above untouched.
  const kpC = userKeyPair()
  const authC = authKeyPair()
  const saltC = randomSalt()
  await db.put('user/cdnuser', {
    salt: b4a.toString(saltC, 'hex'),
    verifier: b4a.toString(deriveVerifier(rwd, saltC, ARGON2_DEFAULT), 'hex'),
    argon: ARGON2_DEFAULT,
    pub: b4a.toString(kpC.publicKey, 'hex'),
    encPriv: wrap(wk, kpC.secretKey),
    authPub: b4a.toString(authC.publicKey, 'hex'),
    authPrivEnc: wrap(wk, authC.secretKey),
    // promo/void secrets are minted like any stream's but never used for playback
    wrapped: { news: sealTo(kpC.publicKey, encKey), promo: sealTo(kpC.publicKey, hcrypto.randomBytes(32)), void: sealTo(kpC.publicKey, hcrypto.randomBytes(32)) },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })
  // Query string must survive verbatim (tokenized-CDN shape); the stub ignores it.
  const promoUrl = `http://127.0.0.1:${cdnPort}/index.m3u8?src=promo`
  // Playback headers ride WITH the url: a hotlink-protected provider serves the token
  // URL only when the player repeats its Referer/Origin/User-Agent. The engine never
  // sends them itself — it hands them to the host player through resolve() — so what
  // this section proves is the carry, verbatim and redirect-only.
  const promoHeaders = { referer: 'https://provider.example/live/', origin: 'https://provider.example', 'user-agent': 'AliranTest/1.0' }
  const hsig = (h) => h == null ? '<none>' : Object.keys(h).sort().map((k) => k + '=' + h[k]).join('&')
  await db.put('catalog/promo', { title: 'Promo', category: ['promo'], type: 'live', protection: 'self', feedKey: null, blobsKey: null, redirect: true, url: promoUrl, headers: promoHeaders, isLive: true, status: 'live' })
  await db.put('catalog/void', { title: 'Void', category: ['misc'], type: 'live', protection: 'self', feedKey: null, blobsKey: null, isLive: false, status: 'idle' })

  const evC = { fallback: 0, sourceChanged: 0, status: [], lastStreams: null }
  const playerC = createPlayer({ panelPubKey, storeDir: dirs.cliC, swarm: { bootstrap } }) // default p2p-only — NO hybrid config anywhere
  playerC.on('fallback', () => { evC.fallback++ })
  playerC.on('source-changed', () => { evC.sourceChanged++ })
  playerC.on('status', (s) => evC.status.push(s.state))
  playerC.on('streams', (s) => { evC.lastStreams = s })
  cleanups.push(() => playerC.stop())
  await playerC.connect()
  let streamsC = null
  const deadlineC = Date.now() + 60000
  while (!streamsC) {
    if (Date.now() > deadlineC) throw new Error('timeout: redirect SDK login')
    try {
      const s = await playerC.login('cdnuser', PASSWORD)
      if (s.length >= 3) streamsC = s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streamsC) await sleep(1500)
  }
  const dispPromo = streamsC.find(s => s.id === 'promo')
  if (!dispPromo || dispPromo.isLive !== true) throw new Error('redirect channel missing from the display list or not live')
  // headers are engine-internal exactly like url/redirect: they are a playback secret of
  // sorts (the provider's own hotlink check) and belong in resolve(), never in the list a
  // host renders and logs.
  if (dispPromo.url !== undefined || dispPromo.redirect !== undefined || dispPromo.headers !== undefined || dispPromo.encryptionKey || dispPromo.feedKey) throw new Error('display list must stay metadata-only (leaked url/redirect/headers/keys)')

  // (a) resolve() hands the operator URL over verbatim — no feed, no watchdogs.
  const rP = await resolveWithin(playerC, 'promo', 20000)
  if (rP.url !== promoUrl) throw new Error('redirect resolve must return the catalog url verbatim, got ' + rP.url)
  if (hsig(rP.headers) !== hsig(promoHeaders)) throw new Error('redirect resolve must return the catalog headers verbatim, got ' + hsig(rP.headers))
  if (rP.source !== 'cdn' || rP.port !== undefined || rP.localUrl !== undefined || rP.feedKey !== null) throw new Error('redirect resolve shape wrong: ' + JSON.stringify(rP))
  if (evC.status.includes('feed:open')) throw new Error('a redirect tune must not open any feed')
  if (playerC._tuneTimer) throw new Error('a redirect tune must not arm the tune watchdog')
  const srcP = playerC.source()
  if (!srcP || srcP.source !== 'cdn' || srcP.url !== promoUrl) throw new Error('source() must report the redirect URL: ' + JSON.stringify(srcP))
  const gotP = await httpGet(cdnPort, '/index.m3u8?src=promo')
  if (gotP.status !== 200 || !gotP.body.toString().includes('#EXTM3U')) throw new Error('the redirect URL itself must serve HLS (stub sanity)')
  log('redirect: promo resolved to the operator URL verbatim (source cdn, no port, no feed, no watchdog)')

  // (b) admin edits the url in the catalog → the NEXT tune returns the new one (live
  // catalog read at resolve() — no re-login, no push round-trip required). The headers
  // move with it: this pair IS the property a half-hourly source refresh depends on —
  // rotated token URL plus whatever headers the provider now wants, reaching a
  // logged-in viewer on the next tune.
  const promoUrl2 = `http://127.0.0.1:${cdnPort}/index.m3u8?src=promo2`
  const promoHeaders2 = { referer: 'https://provider.example/live2/', 'user-agent': 'AliranTest/2.0' }
  await db.put('catalog/promo', { title: 'Promo', category: ['promo'], type: 'live', protection: 'self', feedKey: null, blobsKey: null, redirect: true, url: promoUrl2, headers: promoHeaders2, isLive: true, status: 'live' })
  await waitFor(async () => {
    const r = await resolveWithin(playerC, 'promo', 20000)
    return r.url === promoUrl2 && hsig(r.headers) === hsig(promoHeaders2)
  }, 40000, 'a re-tune returns the EDITED redirect url AND its edited headers')
  log('redirect: url + headers edit reached the viewer on the next tune (no re-login)')

  // (c) a feedless entry WITHOUT the redirect class still fails honestly.
  let voidRejected = false
  try { await playerC.resolve('void') } catch (e) { voidRejected = /not broadcasting/.test(String(e.message)) }
  if (!voidRejected) throw new Error("a feedless non-redirect entry must still throw 'not broadcasting'")

  // (d) zap across classes: p2p news (tune watchdog armed) ↔ redirect promo (cleared).
  const rN = await resolveWithin(playerC, 'news', 20000)
  if (rN.source !== 'p2p' || !rN.port) throw new Error('news must still tune over P2P for the redirect-user')
  if (!playerC._tuneTimer) throw new Error('the p2p tune must arm the tune watchdog')
  await waitFor(async () => { const r = await httpGet(rN.port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') }, 40000, 'p2p playback beside redirect channels')
  const rP2 = await resolveWithin(playerC, 'promo', 20000)
  if (rP2.url !== promoUrl2) throw new Error('zap back to the redirect must return the (edited) url')
  if (hsig(rP2.headers) !== hsig(promoHeaders2)) throw new Error('zap back to the redirect must return the (edited) headers')
  if (rN.headers !== undefined) throw new Error('a P2P tune must carry NO headers (they belong to a provider url, not to localhost)')
  if (playerC._tuneTimer) throw new Error('zapping p2p→redirect must clear the p2p tune watchdog')
  if (evC.fallback !== 0 || evC.sourceChanged !== 0) throw new Error('redirect playback must not touch the hybrid machinery (fallback/source-changed fired)')

  // (e) the provider stops checking (or an admin clears the fields): a record with no
  // headers resolves with none. The live record is authoritative with NO fallback to the
  // login snapshot, so the old headers must not linger for the session.
  await db.put('catalog/promo', { title: 'Promo', category: ['promo'], type: 'live', protection: 'self', feedKey: null, blobsKey: null, redirect: true, url: promoUrl2, headers: null, isLive: true, status: 'live' })
  await waitFor(async () => (await resolveWithin(playerC, 'promo', 20000)).headers === undefined, 40000, 'cleared headers resolve to undefined')
  log('redirect: cleared headers stop reaching the viewer (no stale snapshot fallback)')

  // ===== (f) LIVE ENTITLEMENT (S57): grants followed mid-session, no re-login =====
  // The operator's m3u source re-syncs every 30 min and adds/prunes channels all day. A
  // viewer who signed in that morning used to be stuck with the morning lineup until a
  // full app RESTART, because _pushCatalog only ever re-read ids captured at login. The
  // SDK now watches its OWN `user/<name>` record — the panel-signed grant map login()
  // already reads — and follows it. login() is NOT called again anywhere below.
  const grantRec = async (mutate) => {
    const cur = (await db.get('user/cdnuser')).value
    mutate(cur.wrapped)
    await db.put('user/cdnuser', cur)
  }
  const inList = (id) => (evC.lastStreams || []).some((s) => s.id === id)

  // (f1) a BRAND-NEW redirect channel, cataloged and granted while the client is live.
  const lateUrl = `http://127.0.0.1:${cdnPort}/index.m3u8?src=late`
  const lateHeaders = { referer: 'https://provider.example/late/', 'user-agent': 'AliranTest/3.0' }
  await db.put('catalog/late', { title: 'Late Addition', category: ['events'], type: 'live', protection: 'self', feedKey: null, blobsKey: null, redirect: true, url: lateUrl, headers: lateHeaders, isLive: true, status: 'live' })
  await grantRec((w) => { w.late = sealTo(kpC.publicKey, hcrypto.randomBytes(32)) })
  await waitFor(async () => inList('late'), 40000, 'a mid-session grant reaches the display list without re-login')
  const rLate = await resolveWithin(playerC, 'late', 20000)
  if (rLate.url !== lateUrl) throw new Error('a mid-session-granted redirect must resolve to its url, got ' + rLate.url)
  if (hsig(rLate.headers) !== hsig(lateHeaders)) throw new Error('a mid-session-granted redirect must carry its headers, got ' + hsig(rLate.headers))
  if (rLate.source !== 'cdn' || rLate.port !== undefined) throw new Error('a mid-session-granted redirect must resolve as cdn with no port: ' + JSON.stringify(rLate))
  log('live-entitlement: a channel added AND granted mid-session became playable with no re-login')

  // (f2) the P2P boundary holds. A newly granted NON-redirect channel carries a key
  // sealed to the account public key, and the engine deliberately keeps no private key
  // after login — so it must NOT be admitted. Silently playing it is impossible (no
  // encryptionKey), so the failure mode this guards against is a broken-looking channel
  // appearing in the lineup. Same boundary a re-KEYED stream already sits behind.
  await db.put('catalog/p2plate', { title: 'P2P Late', category: ['misc'], type: 'live', protection: 'self', feedKey: b4a.toString(feed.key, 'hex'), blobsKey: null, isLive: true, status: 'live' })
  await grantRec((w) => { w.p2plate = sealTo(kpC.publicKey, encKey) })
  // The watcher fires within milliseconds of the append; this is generous room for it to
  // WRONGLY admit the channel. _entitled is asserted directly as well as the display
  // list: a correct run emits no push at all here (nothing changed), so the list alone
  // would still read clean if the id had in fact been admitted.
  await sleep(5000)
  if (inList('p2plate') || playerC._entitled.has('p2plate')) throw new Error('a mid-session-granted P2P channel must NOT be admitted (no private key after login)')
  await assertRejects(() => playerC.resolve('p2plate'), /not entitled/, 'resolve() of an unadmitted P2P grant')
  log('live-entitlement: a mid-session-granted P2P channel correctly waits for the next login')

  // (f3) revocation is followed too — the id leaves _entitled, so it can no longer be
  // resolved. The resolve() below makes 'promo' the ACTIVE play again (f1 tuned 'late'
  // after section (e) left promo active), because the policy under test is deliberate:
  // drop the channel from the lineup but NEVER tear down _active.
  // revoke() + the package reconcile that follows it are two separate puts whose
  // intermediate state is grant-less, and yanking a viewer mid-watch over a state that
  // lives for milliseconds is worse than letting the play finish.
  await resolveWithin(playerC, 'promo', 20000) // make promo unambiguously the active play
  if (!playerC._active || playerC._active.streamId !== 'promo') throw new Error('test setup: promo should be the active play before the revoke')
  await grantRec((w) => { delete w.promo })
  await waitFor(async () => !inList('promo'), 40000, 'a revoked grant leaves the display list')
  await assertRejects(() => playerC.resolve('promo'), /not entitled/, 'resolve() of a revoked grant')
  if (!playerC._active || playerC._active.streamId !== 'promo') throw new Error('a revoke must NOT tear down the active play')
  if (!inList('late') || !inList('news')) throw new Error('a revoke must not disturb the surviving grants')
  log('live-entitlement: revoke removed the channel and blocked re-resolve, active play untouched')

  // (f4) removal is SYMMETRIC with admission: only what can be re-admitted may be
  // dropped. 'news' is a P2P grant this user holds. The panel's ORDINARY revoke is TWO
  // puts — admin-server.js/admin-cli.js call ops.revoke() and THEN reconcilePackages()
  // — and the intermediate record is grant-less. Dropping a P2P id on that intermediate
  // state would be a ONE-WAY DOOR: nothing can re-seal it without the account private
  // key, so a package-covered channel would stay gone for the whole session even though
  // the panel's END state still grants it.
  const newsSealed = (await db.get('user/cdnuser')).value.wrapped.news
  await grantRec((w) => { delete w.news }) // put 1: ops.revoke()
  await sleep(2500)
  await grantRec((w) => { w.news = newsSealed }) // put 2: reconcilePackages() re-seals
  await sleep(2500)
  if (!playerC._entitled.has('news')) throw new Error('a P2P grant must SURVIVE the panel revoke->reconcile two-put (removal must be symmetric with admission)')
  const rNewsAfter = await resolveWithin(playerC, 'news', 20000)
  if (rNewsAfter.source !== 'p2p') throw new Error('the surviving P2P grant must still resolve over P2P')
  const liveEntitlementProven = true
  log('live-entitlement: P2P grant survived the panel two-put revoke->reconcile')

  await playerC.stop()
  const redirectProven = true
  log('redirect: zap p2p↔redirect clean — watchdog armed on news, cleared on promo; hybrid machinery untouched')

  // ===== VIEWER-DISK ROTATION of the ACTIVE feed (the 32-bit reclaim path) =====
  // Not to be confused with the broadcaster feedKey rotation above: that one is a CATALOG
  // event (a new feed identity to follow). This one is a DISK bound. On 32-bit Android ABIs
  // `fs-native-extensions` is excluded from the build, so random-access-file's `_del` reports
  // success and frees ZERO bytes — hypercore's clear() runs, says it worked, and the replica
  // keeps growing at ~1× bitrate for the whole session. Unlink is the only operation that
  // returns the bytes there, so the engine PURGES the active replica and re-opens it empty
  // behind a request park (sdk/player.js _rotateActiveFeed).
  //
  // HOW IT IS TRIGGERED HERE, and why not by real growth. The trigger is sdk/serve.js's
  // Reclaim, which hard-disables the budget for the life of the handler the moment its
  // capability probe (probeHolePunch) proves the filesystem CAN hole-punch — which is every
  // CI box and every dev machine this lane runs on. Waiting for real bytes would therefore
  // wait forever, and the floor under reclaimBudgetBytes (64 MiB) is far above anything a
  // 2-minute test replica reaches anyway. _onFeedOverBudget IS the callback Reclaim invokes,
  // with the same info payload, so calling it is the deepest honest entry point on a 64-bit
  // host; everything past it is the real path, end to end. tools/serve-reclaim-test.mjs owns
  // the other half — that the probe, the arithmetic and the callback fire correctly.
  //
  // TWO WINDOWS ARE HELD OPEN DELIBERATELY, because the interesting states are ~20 ms long:
  //   the DRAIN (step 1) is held with a REAL in-flight media read — the serving core takes its
  //     in-flight slot at target bind, so a request for a segment that will never exist keeps
  //     handler.inflight() at 1 and the rotation's own drain waits on exactly that;
  //   the PURGE (step 4) is held by wrapping drive.purge(), which is a slow unlink — the
  //     routine case on the low-end 32-bit flash this whole feature exists for, not a
  //     contrivance.
  const MiB = 1024 * 1024
  const holdPurge = (drive) => {
    const real = drive.purge.bind(drive)
    let release = null; const gate = new Promise((r) => { release = r })
    let entered = false
    drive.purge = () => { entered = true; return gate.then(() => real()) }
    return { release: () => release(), get entered () { return entered }, restore: () => { delete drive.purge } }
  }
  const holdDrain = (port, p) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => { res.resume() })
    req.on('error', () => {})
    return { release: () => { try { req.destroy() } catch {} } }
  }
  // A request whose settlement TIME is observable — a park is only a park if the request is
  // still open when the assertion runs.
  const pendingGet = (port, p) => {
    const st = { done: false, status: null, body: null, startedAt: Date.now(), ms: null }
    st.promise = httpGet(port, p).then(
      (r) => { st.done = true; st.status = r.status; st.body = r.body.toString(); st.ms = Date.now() - st.startedAt; return r },
      (e) => { st.done = true; st.status = 'ERR ' + e.message; st.ms = Date.now() - st.startedAt })
    return st
  }
  const playableAt = async (port) => { const r = await httpGet(port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') ? r.body.toString() : null }
  const driveUsable = async (d) => { if (!d) return false; try { await d.entry('/index.m3u8'); return true } catch { return false } }

  // The budget is a byte COUNT with a hard floor, and a misconfiguration has to surface at
  // construction. `Number('512')` is 512, so a string used to be accepted as a 512-BYTE budget
  // — a stream that swaps its own drive out from under the player continuously, which reaches
  // the field as unexplained rebuffering rather than as a smaller disk.
  assertThrows(() => createPlayer({ panelPubKey, storeDir: dirs.cliD, reclaimBudgetBytes: '536870912' }), /non-negative NUMBER/, 'a STRING reclaimBudgetBytes')
  assertThrows(() => createPlayer({ panelPubKey, storeDir: dirs.cliD, reclaimBudgetBytes: true }), /non-negative NUMBER/, 'a BOOLEAN reclaimBudgetBytes')
  assertThrows(() => createPlayer({ panelPubKey, storeDir: dirs.cliD, reclaimBudgetBytes: 8 * MiB }), /at least/, 'a reclaimBudgetBytes under the floor')

  const evD = { status: [], rotate: [], errors: [], feedChanged: [], swapVersion: [] }
  // ⚠ THE ZERO-PEER RESCAN IS DISABLED FOR THIS PLAYER (tune.rescanMs: 0), and that is the
  // point of the section rather than a convenience. A purged replica does not re-attach to the
  // connection that was carrying it — the rotation has to hang up on the feed's peers and get a
  // FRESH dial, and the question this section has to be able to answer is whether that dial
  // takes ON ITS OWN. It could not answer it before: _checkFeedPeers force-relookups after
  // tune.rescanMs of zero peers, so a rotation whose dial never took still came back ~10 s later
  // and the lane went green. That is a false pass worth naming — 10 s is four times the park
  // budget, i.e. the viewer sits on a black screen through a swap the event stream called a
  // success. With the rescan off, nothing downstream can rescue the dial inside the bounds
  // asserted below (the tune watchdog's first rung is 30 s away), so the assertions measure the
  // dial itself.
  const playerD = createPlayer({ panelPubKey, storeDir: dirs.cliD, swarm: { bootstrap }, reclaimBudgetBytes: 64 * MiB, tune: { rescanMs: 0 } })
  playerD.on('status', (s) => {
    evD.status.push(s.state)
    if (s.state !== 'feed:rotate') return
    evD.rotate.push(s)
    // The swapped-in replica's version, sampled INSIDE the success emit — the only instant at
    // which "the rotation handed back an EMPTY replica" is still observable. A second later it
    // has re-replicated and a purge is indistinguishable from a close.
    if (s.durationMs != null) evD.swapVersion.push(playerD._feedDrive ? playerD._feedDrive.version : null)
  })
  playerD.on('error', (e) => evD.errors.push(String((e && e.message) || e)))
  playerD.on('feed-changed', (e) => evD.feedChanged.push(e))
  cleanups.push(() => playerD.stop())
  if (playerD._feedBudgetBytes !== 64 * MiB) throw new Error('reclaimBudgetBytes did not reach the engine: ' + playerD._feedBudgetBytes)

  await playerD.connect()
  let streamsD = null
  const deadlineD = Date.now() + 60000
  while (!streamsD) {
    if (Date.now() > deadlineD) throw new Error('timeout: disk-rotation SDK login')
    try {
      const s = await playerD.login('alice', PASSWORD)
      if (s.length >= 4) streamsD = s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streamsD) await sleep(1500)
  }
  const rDsk = await resolveWithin(playerD, 'news', 20000)
  const portD = rDsk.port
  await waitFor(() => playableAt(portD), 40000, 'disk-rotation: news playback before any rotation')
  const cacheKeyD = playerD._activeFeedKey
  const feedKeyD = cacheKeyD.slice(0, cacheKeyD.indexOf(':'))
  if (feedKeyD !== rotKeyHex) throw new Error('disk-rotation: expected news to be on the rotated feed by now, got ' + feedKeyD.slice(0, 16))
  const rotOk = () => evD.rotate.filter((e) => e.durationMs != null)
  const rotSkipped = () => evD.rotate.filter((e) => e.skipped === 'cast-pinned')
  const rotFailed = () => evD.rotate.filter((e) => e.failed)

  // ----- (1) A rotation while watching is INVISIBLE -----
  // The feature's whole promise: the replica is thrown away and rebuilt under a live play and
  // the host player is never told anything happened. Same port, same source(), no
  // 'feed-changed' (that event means the CATALOG re-keyed the channel — conflating the two
  // would make a host re-zap on every disk bound), no error, no 'feed:retune'.
  const driveD1 = playerD._feedDrive
  const plD1 = await playableAt(portD)
  const verD1 = driveD1.version
  const fcD1 = evD.feedChanged.length
  const stD1 = evD.status.length
  playerD._onFeedOverBudget(driveD1, { bytes: 700 * MiB, blobs: 690 * MiB, meta: 10 * MiB, budgetBytes: 64 * MiB })
  const rotEv1 = await waitFor(() => rotOk()[0], 20000, "disk-rotation: 'feed:rotate' success event")
  if (rotEv1.streamId !== 'news') throw new Error('the rotation event named the wrong stream: ' + rotEv1.streamId)
  if (rotEv1.bytes !== 700 * MiB) throw new Error("the trigger's measured bytes did not reach the event: " + rotEv1.bytes)
  if (rotEv1.trigger !== 'budget') throw new Error("a blob-budget rotation must name its trigger ('budget'), got: " + rotEv1.trigger)
  if (rotEv1.meta !== 10 * MiB) throw new Error("the trigger's metadata share did not reach the event: " + rotEv1.meta)
  if (!Number.isFinite(rotEv1.durationMs)) throw new Error('the rotation event carries no durationMs — a rotation nobody can attribute')
  if (!playerD._feedDrive) throw new Error('the rotation left the engine with no served drive')
  if (playerD._feedDrive === driveD1) throw new Error('nothing was rotated: _feedDrive is still the over-budget replica')
  if (b4a.toString(playerD._feedDrive.key, 'hex') !== feedKeyD) throw new Error('the rotation re-opened a DIFFERENT feed')
  if (playerD._activeFeedKey !== cacheKeyD) throw new Error('the rotation moved the active cache key')
  if (playerD.source().url !== rDsk.localUrl || playerD.source().source !== 'p2p') throw new Error('source() moved across the rotation: ' + JSON.stringify(playerD.source()))
  if (playerD._server.address().port !== portD) throw new Error('the served port changed across the rotation')
  if (evD.feedChanged.length !== fcD1) throw new Error("a DISK rotation must not emit 'feed-changed' — that event means the catalog re-keyed the channel")
  if (evD.errors.length) throw new Error('a healthy rotation must not surface an error: ' + JSON.stringify(evD.errors))
  if (evD.status.slice(stD1).includes('feed:retune')) throw new Error('a healthy rotation must not look like a tune failure')
  if (playerD._feedRotate !== null) throw new Error('the mutex survived a completed rotation — no channel could rotate again for the life of the process')
  if (await driveUsable(driveD1)) throw new Error('the over-budget replica was never purged (the old drive still answers)')
  // …and it was UNLINKED, not merely closed. A close re-opens onto the same storage and frees
  // nothing, which on the platform this exists for is the entire failure being fixed; the only
  // way to tell them apart from outside is that a purge hands back an EMPTY replica.
  if (!(verD1 > 1)) throw new Error('test setup: the pre-rotation replica should be well past version 1, got ' + verD1)
  if (!(evD.swapVersion[0] < verD1)) throw new Error(`the re-opened replica is not EMPTY (version ${evD.swapVersion[0]} vs ${verD1} before) — the storage was closed, not unlinked, so no bytes came back`)
  const t0D = Date.now()
  // THE ASSERTION THE WHOLE FEATURE IS FOR, in two halves, because "playback came back" is not
  // the same claim as "the rotation's own recovery worked" and conflating them is what let a
  // broken swap pass.
  //
  // HALF ONE — THE RE-OPENED REPLICA MUST GAIN A PEER, PROMPTLY AND BY ITSELF. A purged core
  // never re-attaches to the connection that was carrying it, so the rotation hangs up on the
  // feed's peers and forces a fresh dial; this is the only assertion that says whether that dial
  // TOOK. It is bounded far under tune.rescanMs — which is disabled for this player anyway (see
  // createPlayer above) — so a run that limps back on some later recovery FAILS here instead of
  // going green. Measured: a fire-and-forget dial recovered in tens of ms most runs and then
  // took 10078 ms on one, which is exactly rescanMs: the dial had not taken at all and the
  // zero-peer rescan was what rescued the channel, four times the park budget later. The old
  // 30 s playback-only bound could not tell those two runs apart.
  const REDIAL_BUDGET_MS = 3000
  let peerMsD1
  try {
    peerMsD1 = await waitFor(async () => {
      const d = playerD._feedDrive
      return (d && d.core && d.core.peers.length > 0) ? Date.now() - t0D : null
    }, REDIAL_BUDGET_MS, 'disk-rotation: the re-opened replica gains a peer')
  } catch (e) {
    const connsD1 = playerD._swarm ? playerD._swarm.connections.size : 0
    throw new Error(`${e.message} within ${REDIAL_BUDGET_MS} ms — ZERO peers across ${connsD1} LIVE connection(s). ` +
      'The rotation hung up on this feed’s peers and dialled back, and the dial did not take. A core whose storage ' +
      'was purged does NOT re-attach to an ALREADY-ESTABLISHED protomux (close()+re-open resumes at once; ' +
      'purge()+re-open never does, at any delay and under any namespace), so a fresh connection is the only ' +
      'recovery — and nothing else can supply one here: the zero-peer rescan is disabled for this player and the ' +
      "tune watchdog's first rung is 30 s away. Do not raise this bound to make it pass: a rotation that needs " +
      'seconds to re-dial is a rotation the viewer watches as a black screen.')
  }
  // …and it must not have been a recovery in disguise. Both of these fire on the paths that
  // would otherwise mask a dead dial.
  if (evD.status.slice(stD1).includes('feed:rescan')) throw new Error('the replica was rescued by the zero-peer rescan, not by the rotation’s own re-dial')
  if (evD.status.slice(stD1).includes('feed:retune')) throw new Error('the replica was rescued by the tune ladder, not by the rotation’s own re-dial')
  // HALF TWO — and the viewer actually has a picture again. Bounded generously on purpose: once
  // the replica has a peer this is the broadcaster's playlist-rewrite interval, not the SDK's.
  let plD1b
  try {
    plD1b = await waitFor(async () => { const pl = await playableAt(portD); return pl && pl !== plD1 ? pl : null }, 20000, 'disk-rotation: the live edge advances again on the fresh replica')
  } catch (e) {
    const peersD1 = playerD._feedDrive ? playerD._feedDrive.core.peers.length : '(no drive)'
    const connsD1 = playerD._swarm ? playerD._swarm.connections.size : 0
    throw new Error(`${e.message} — the re-opened replica has ${peersD1} peer(s) across ${connsD1} LIVE connection(s). ` +
      'A core whose storage was purged does NOT re-attach to an ALREADY-ESTABLISHED protomux. Measured on plain ' +
      'corestore/hyperdrive/hyperswarm with no SDK involved: close()+re-open over the same namespace resumes ' +
      'replication immediately; purge()+re-open never resumes, with or without a delay, and re-opening under a ' +
      'different namespace does not help either (the discovery key, and so the channel, is the same); destroying ' +
      "the connection so the swarm re-dials recovers it at once. Step 7's comment — \"a freshly opened replica has " +
      'ZERO peers by construction UNTIL corestore re-adds the core on the existing swarm connections" — is the ' +
      'assumption that does not hold, and the tune ladder cannot save it: the rung that would (feed:reconnect, ' +
      'destroy the wedged connection) is skipped precisely because the symptom is zero peers, so the play dies with ' +
      "a 'tune timeout' ~60 s later and never returns.")
  }
  // The re-dial number is reported, not just asserted, because it is the number the design hangs
  // on — and it is a LOCAL-TESTNET FLOOR, not a prediction. There is no real DHT lookup and no
  // holepunch here; a phone on a carrier NAT pays for both. Read it as "the mechanism takes on
  // its own", never as "the swap is invisible on a device".
  log(`disk-rotate: over-budget → purge + re-open swapped the replica in ${rotEv1.durationMs} ms; same port, same source(), no feed-changed; re-dial took ${peerMsD1} ms to put a peer back on the fresh replica (testnet FLOOR — no DHT lookup, no holepunch); live edge advancing again ${Date.now() - t0D} ms later (${plD1b.split('\n').filter(l => l.trim().endsWith('.ts')).length} segs)`)

  // ----- (2) A media request PARKS across the swap, and is never instantly 404'd -----
  // This one behaviour is the difference between an invisible rotation and a ~5.5 s black
  // remount: the serving core answers a NULL target with an instant 404, and ExoPlayer turns
  // that into 3 retries, an onError and a remount. The same window is where _evictFeed must
  // refuse the slot — eviction PURGES whatever a cache slot settles to, and during a rotation
  // that is the replica it has just OPENED, not the one it threw away. Three blind callers can
  // land here (the tune ladder's last rung, _openFeedWithin's timeout, _trimFeeds after a zap).
  const driveD2 = playerD._feedDrive
  const gateD2 = holdPurge(driveD2)
  playerD._onFeedOverBudget(driveD2, { bytes: 800 * MiB, budgetBytes: 64 * MiB })
  await spinFor(() => gateD2.entered && playerD._feedSwap && playerD._feedDrive === null, 15000, 'disk-rotation: the purge window (handles dropped, park armed)')
  const slotD2 = playerD._feeds.get(cacheKeyD)
  if (!slotD2) throw new Error('the rotation left no cache entry under its key — a concurrent open would build a SECOND drive over a namespace being purged')
  if (slotD2.settled !== undefined) throw new Error('the rotation must park a promise every synchronous reader sees as COLD')
  if (playerD._thumbTarget('news') !== null) throw new Error('a synchronous reader resolved a target while the replica was purged')
  playerD._evictFeed(cacheKeyD)
  if (playerD._feeds.get(cacheKeyD) !== slotD2) throw new Error('_evictFeed took the slot the rotation owns — it would orphan and unlink the replica the rotation is opening')
  const parkedD2 = pendingGet(portD, '/index.m3u8')
  await sleep(400)
  if (parkedD2.done) throw new Error(`a media request did not park during the swap (status ${parkedD2.status} after ${parkedD2.ms} ms) — this is the instant 404 the park exists to replace`)
  if (!playerD._feedSwap) throw new Error('the park gate was released while the replica was still purged')
  gateD2.release()
  await parkedD2.promise
  gateD2.restore()
  if (parkedD2.status !== 200 || !/\.ts/.test(parkedD2.body || '')) throw new Error('the parked request did not succeed on the other side of the swap: ' + parkedD2.status)
  if (!(parkedD2.ms >= 400)) throw new Error('the request was answered before the swap finished — it never parked at all')
  await spinFor(() => playerD._feedSwap === null && playerD._feedRotate === null, 10000, 'disk-rotation: the park and the mutex are both released')
  if (rotOk().length !== 2) throw new Error('expected exactly 2 successful rotations by now, got ' + rotOk().length)
  log(`disk-rotate: a media request fired while the replica was purged PARKED ${parkedD2.ms} ms and then served 200 — no 404, no remount; _evictFeed refused the claimed slot`)

  // ----- (3) Single-flight, and the mutex is released on every exit -----
  // The over-budget callback fires once per throttled reclaim pass while the replica is over
  // budget, so a second one arriving mid-rotation is the ordinary case rather than a race to
  // imagine. The observable window is the DRAIN, because _feedDrive is still published there —
  // a request arriving during it is served the real drive, and the park is armed later on
  // purpose — so a second rotation that got past the mutex would have everything it needs.
  const driveD3 = playerD._feedDrive
  const probeD3 = holdDrain(portD, '/never-lands-' + Date.now() + '.ts')
  await spinFor(() => playerD._handler.inflight(driveD3) >= 1, 10000, 'disk-rotation: the drain probe holds an in-flight read')
  playerD._onFeedOverBudget(driveD3, { bytes: 900 * MiB, budgetBytes: 64 * MiB })
  const rotTokD3 = playerD._feedRotate
  if (!rotTokD3) throw new Error('the rotation did not take the mutex before its first await')
  if (playerD._feedDrive !== driveD3) throw new Error('the drain must run in FRONT of the swap — requests arriving during it are served the real drive')
  if (playerD._feedSwap) throw new Error('the park must not be armed across the drain: a 6 s drain would spend the whole 2.5 s park budget before the only phase that needs it')
  const secondD3 = await playerD._rotateActiveFeed(playerD._active, { bytes: 950 * MiB })
  if (secondD3 !== false) throw new Error('a second rotation started while one was in flight')
  if (playerD._feedRotate !== rotTokD3) throw new Error('a second rotation took the mutex from the one in flight')
  playerD._onFeedOverBudget(driveD3, { bytes: 950 * MiB, budgetBytes: 64 * MiB }) // …and again through the real hook
  await sleep(150)
  if (playerD._feedRotate !== rotTokD3) throw new Error('a second over-budget callback displaced the in-flight rotation')
  if (playerD._feedDrive !== driveD3) throw new Error('a second rotation purged the drive out from under the first')
  probeD3.release()
  await waitFor(() => rotOk().length === 3, 20000, 'disk-rotation: the drained rotation completes')
  await sleep(300)
  if (rotOk().length !== 3) throw new Error('the refused rotations ran after all: ' + rotOk().length)
  if (playerD._feedRotate !== null) throw new Error('the mutex survived a completed rotation')
  await waitFor(() => playableAt(portD), 30000, 'disk-rotation: playback after the drained rotation')
  log('disk-rotate: single-flight held across the drain (2 further triggers refused, mutex kept), and released on completion')

  // ----- (4) A cast-pinned feed is never rotated -----
  // Purging the replica a receiver is reading deletes the only copy of every block below the
  // live window — they are unfetchable swarm-wide, the broadcaster cleared them at rotation —
  // so the refusal is checked TWICE: once up front, and again after the drain, because
  // _doStartCast can resolve this very drive and publish its session inside that window.
  const driveD4 = playerD._feedDrive
  playerD._castFeedKey = cacheKeyD // what _doStartCast pins, before it publishes _cast
  // Called, not awaited: everything up to the first await has already run by the time this
  // returns, which is what makes "was the mutex taken?" answerable. The up-front refusal has to
  // be FREE — a pinned channel that takes the mutex and the cache-slot claim first blocks every
  // other rotation, and makes its slot un-evictable, for the length of a drain (up to 6 s) on a
  // rotation that was always going to refuse. The re-check after the drain does not cover that.
  const refusingD4 = playerD._rotateActiveFeed(playerD._active, { bytes: 900 * MiB })
  const mutexTakenD4 = playerD._feedRotate !== null
  const refusedD4 = await refusingD4
  playerD._castFeedKey = null
  if (refusedD4 !== false) throw new Error('a cast-pinned feed was rotated')
  if (mutexTakenD4) throw new Error('a cast-pinned feed must be refused BEFORE the mutex is taken, not after the drain')
  if (rotSkipped().length !== 1) throw new Error('the refusal left no breadcrumb — "why did this device fill up?" becomes unanswerable')
  if (playerD._feedDrive !== driveD4) throw new Error('the pinned replica was swapped anyway')
  if (playerD._feedRotate !== null) throw new Error('the up-front refusal leaked the mutex')
  // …and the same pin arriving DURING the drain, which is the one the up-front check cannot see.
  const probeD4 = holdDrain(portD, '/never-lands-cast-' + Date.now() + '.ts')
  await spinFor(() => playerD._handler.inflight(driveD4) >= 1, 10000, 'disk-rotation: the cast-window drain probe')
  playerD._onFeedOverBudget(driveD4, { bytes: 900 * MiB, budgetBytes: 64 * MiB })
  if (!playerD._feedRotate) throw new Error('the rotation did not start')
  playerD._castFeedKey = cacheKeyD // a session appears while the rotation drains
  probeD4.release()
  await waitFor(() => rotSkipped().length === 2, 20000, 'disk-rotation: the mid-drain pin is caught by the re-check')
  playerD._castFeedKey = null
  if (playerD._feedDrive !== driveD4) throw new Error('the rotation purged a replica a cast session had just pinned')
  if (!(await driveUsable(driveD4))) throw new Error('the pinned replica was purged despite the refusal')
  if (playerD._feedRotate !== null) throw new Error('the mid-drain refusal leaked the mutex')
  if (rotOk().length !== 3) throw new Error('a refused rotation reported success')
  if (!(await playableAt(portD))) throw new Error('the refused rotation disturbed playback')
  log('disk-rotate: a cast pin refuses the rotation both up front and after the drain — the pinned replica survives, mutex released on both')

  // ----- (5) A retune overlapping a rotation must not publish a CLOSED drive -----
  // _retuneActive's whole method is delete → await → close → re-open, and the value it would
  // await during a rotation is the drive the rotation is a microtask away from publishing:
  // closing it makes _feedDrive a closed handle and every media request for the rest of the
  // play resolves to it. Reachable in production rather than synthetic — the tune ladder fires
  // this on a schedule, and the rotation restarts that very watchdog in its step 7.
  const driveD5 = playerD._feedDrive
  const gateD5 = holdPurge(driveD5)
  playerD._onFeedOverBudget(driveD5, { bytes: 900 * MiB, budgetBytes: 64 * MiB })
  await spinFor(() => gateD5.entered && playerD._feedDrive === null, 15000, 'disk-rotation: the purge window (retune overlap)')
  const retuneD5 = playerD._retuneActive(playerD._active).catch(() => {})
  gateD5.release()
  await retuneD5
  gateD5.restore()
  await spinFor(() => playerD._feedRotate === null, 15000, 'disk-rotation: the overlapped rotation finishes')
  await sleep(500)
  if (!playerD._feedDrive) throw new Error('the overlap left the engine with no served drive')
  if (!(await driveUsable(playerD._feedDrive))) throw new Error('_retuneActive published a CLOSED drive as _feedDrive — every media request errors from here')
  await waitFor(() => playableAt(portD), 30000, 'disk-rotation: playback survives a retune overlapping a rotation')
  log('disk-rotate: a retune landing inside a rotation stood down — a LIVE drive stayed published and playback kept serving')

  // ----- (6) A rotation whose re-open FAILS recovers -----
  // The old replica is already unlinked when the re-open misses its bound, so without the
  // recovery every media request 404s until the tune ladder's first rung 30 s later — and on a
  // hybrid build nothing arms at all. One re-open is starved (it never settles, so the bound is
  // what ends it, which is the common shape on a slow device) and the very next one is real.
  const driveD6 = playerD._feedDrive
  const realOpenD6 = playerD._openFeed
  let starveD6 = true
  playerD._openFeed = function (fk, ek) {
    if (starveD6) { starveD6 = false; return new Promise(() => {}) }
    return realOpenD6.call(this, fk, ek)
  }
  const failedD6 = rotFailed().length
  playerD._onFeedOverBudget(driveD6, { bytes: 900 * MiB, budgetBytes: 64 * MiB })
  await waitFor(() => rotFailed().length > failedD6, 20000, 'disk-rotation: the failed rotation says so')
  const failEvD6 = rotFailed().pop()
  if (!/re-opening/.test(String(failEvD6.message))) throw new Error('the failure breadcrumb does not promise a re-open: ' + failEvD6.message)
  await spinFor(() => playerD._feedRotate === null, 10000, 'disk-rotation: the mutex is released on the FAILURE path')
  await spinFor(() => playerD._feedSwap === null, 10000, 'disk-rotation: the park is released on the FAILURE path')
  await waitFor(() => playerD._feedDrive && playerD._feedDrive !== driveD6, 20000, 'disk-rotation: the recovery re-opened the replica')
  if (rotFailed().some((e) => /recovery failed/.test(String(e.message)))) throw new Error('the recovery itself failed: ' + JSON.stringify(rotFailed().map((e) => e.message)))
  await waitFor(() => playableAt(portD), 30000, 'disk-rotation: playback returns after a failed rotation')
  playerD._openFeed = realOpenD6
  // …and the disk bound is not permanently off afterwards. A mutex stuck by a failure is
  // rotation switched off for the life of the process, i.e. on a 32-bit build no disk bound at
  // all — which is exactly the state this whole feature exists to prevent.
  //
  // This post-failure rotation is fired with trigger: 'meta' — the METADATA bound's shape
  // (the serving core sends it when the hyperbee metadata core alone crosses
  // metaBudgetBytes; the punch latch does not gate it, so on punch-capable hardware this is
  // the ONE rotation trigger there is). It must run the SAME proven path — purge, re-open,
  // fresh dial, playback back — and the event must say which bound asked, or a daily meta
  // rotation on an always-on box is indistinguishable in the field from a blob bound that
  // is failing.
  const okBeforeD6 = rotOk().length
  playerD._onFeedOverBudget(playerD._feedDrive, { trigger: 'meta', bytes: 200 * MiB, blobs: 110 * MiB, meta: 90 * MiB, budgetBytes: 64 * MiB, metaBudgetBytes: 64 * MiB })
  await waitFor(() => rotOk().length > okBeforeD6, 20000, 'disk-rotation: a META-triggered rotation after a failed one still runs')
  const metaEvD6 = rotOk()[rotOk().length - 1]
  if (metaEvD6.trigger !== 'meta') throw new Error("a metadata-budget rotation must name its trigger ('meta'), got: " + metaEvD6.trigger)
  if (metaEvD6.meta !== 90 * MiB) throw new Error("the meta trigger's metadata share did not reach the event: " + metaEvD6.meta)
  if (!/metadata core at 90 MiB/.test(String(metaEvD6.message))) throw new Error('the breadcrumb message does not attribute the rotation to the metadata core: ' + metaEvD6.message)
  await waitFor(() => playableAt(portD), 30000, 'disk-rotation: playback after the post-failure META rotation')
  log('disk-rotate: a re-open that missed its bound recovered (playback returned) and left the mutex free — and a later META-triggered rotation ran the same path, with trigger+meta on its event')

  // ----- (7) stop() during a rotation leaves nothing behind -----
  // A rotation is the longest-lived piece of work in the engine and it holds a store, a swarm
  // and a joined topic. Resuming past a teardown is how a Corestore gets rebuilt over a
  // directory that is being deleted, and how a topic stays announced on a destroyed swarm.
  const driveD7 = playerD._feedDrive
  const gateD7 = holdPurge(driveD7)
  playerD._onFeedOverBudget(driveD7, { bytes: 900 * MiB, budgetBytes: 64 * MiB })
  await spinFor(() => gateD7.entered && playerD._feedSwap && playerD._feedDrive === null, 15000, 'disk-rotation: the purge window (stop overlap)')
  await playerD.stop()
  if (playerD._feedRotate !== null) throw new Error('stop() left the rotation mutex set — a resumed rotation would clear it, but one wedged behind a purge never does, and rotation is then off for the life of the process')
  if (playerD._feedSwap !== null) throw new Error('stop() left media requests parked on a socket that is already going away')
  gateD7.release()
  await sleep(2500)
  gateD7.restore()
  if (playerD._store !== null) throw new Error('the rotation rebuilt a Corestore after stop() returned')
  if (playerD._swarm !== null) throw new Error('the rotation rebuilt a Hyperswarm (and joined a topic) after stop() returned')
  if (playerD._server !== null) throw new Error('a listening server outlived stop()')
  if (playerD._feeds.size !== 0) throw new Error('the rotation re-populated the feed cache after stop(): ' + playerD._feeds.size)
  let connRefusedD7 = false
  try { await httpGet(portD, '/index.m3u8') } catch { connRefusedD7 = true }
  if (!connRefusedD7) throw new Error('the localhost server is still accepting connections after stop()')
  const diskRotationProven = true
  log('disk-rotate: stop() inside a rotation released the mutex and the park, and nothing was rebuilt behind it')

  // ----- Login dial-wait + discovery kick + post-login stagger (login-screen fixes) -----
  // A login issued the instant connect() returns must ride the dial on its OWN: the
  // engine kicks the topic discovery and waits through the RPC arm (_awaitPanelRpc)
  // instead of bouncing 'not connected to panel' to an app-side retry ladder. The ONLY
  // retry this loop tolerates is the bare replication gap ('unknown user' — the bee's
  // length can land a beat after the RPC socket): seeing 'not connected' here IS the
  // regression this scene exists to catch.
  const dirL = tmp('e2es-cliL-')
  cleanups.push(() => { try { fs.rmSync(dirL, { recursive: true, force: true }) } catch {} })
  const playerL = createPlayer({ panelPubKey, storeDir: dirL, swarm: { bootstrap } })
  cleanups.push(() => playerL.stop())
  const peerEventsL = [] // 'panel-peer' payloads — the key a host would persist for the next boot's direct dial
  playerL.on('panel-peer', (k) => peerEventsL.push(k))
  await playerL.connect()
  let sL = null
  for (let i = 0; i < 10 && !sL; i++) {
    try { sL = await playerL.login('alice', PASSWORD) } catch (e) {
      if (!/unknown user/.test(String(e.message))) throw new Error('login bounced instead of riding the dial: ' + e.message)
      await sleep(500)
    }
  }
  if (!sL || sL.length < 4) throw new Error('dial-wait login did not deliver the lineup')
  const marksL = playerL.bootTrace().map((m) => m.name + (m.detail ? ' ' + m.detail : ''))
  if (!marksL.some((m) => m.startsWith('login-rpc-wait') && m.endsWith('armed'))) throw new Error('the first login did not wait through the RPC arm: ' + marksL.join(' | '))
  log('login-wait: the FIRST login() rode the dial inside the engine —', marksL.find((m) => m.startsWith('login-rpc-wait')))

  // Post-login stagger: nothing heavy may have started inline with the streams emit,
  // and a stop() inside the delay window must starve the pending timers (epoch guard).
  if (playerL._replicaSweep !== null) throw new Error('the stale-replica sweep ran inline with login (stagger regression)')
  if (playerL._feeds.size !== 0) throw new Error('feeds opened inline with login (stagger regression)')
  const panelPeerL = playerL._panelPeerKey // captured before stop() nulls it — the key the next scene dials
  await playerL.stop()
  await sleep(3500) // across PREWARM_DELAY_MS — a fired timer must find the epoch moved
  if (playerL._store !== null || playerL._swarm !== null) throw new Error('a staggered post-login task rebuilt engine state after stop()')

  // ----- Remembered panel peer: the rescue dial ALONE arms the RPC (panel-reachability) -----
  // A warm boot hands the engine last session's validated peer key (`panelPeer`) and
  // _openPanel arms a DELAYED joinPeer to it — the rescue for a boot whose topic lookup
  // delivers nothing. That is exactly the scene staged here: the topic join is STUBBED to
  // a dead discovery, leaving the rescue dial as the ONLY way this player can reach the
  // panel. An armed RPC and a delivered lineup are then the rescue path alone. The delay
  // is shrunk like _rpcProbeMs — what is under test is the dial, not the stand-down window.
  if (peerEventsL.length !== 1 || peerEventsL[0] !== panelPeerL || !/^[0-9a-f]{64}$/.test(String(peerEventsL[0]))) {
    throw new Error('panel-peer must deliver the validated key exactly once: ' + JSON.stringify(peerEventsL) + ' vs ' + panelPeerL)
  }
  const dirM = tmp('e2es-cliM-')
  cleanups.push(() => { try { fs.rmSync(dirM, { recursive: true, force: true }) } catch {} })
  const playerM = createPlayer({ panelPubKey, storeDir: dirM, swarm: { bootstrap }, panelPeer: peerEventsL[0] })
  cleanups.push(() => playerM.stop())
  playerM._panelDialDelayMs = 25
  const realEnsureM = Object.getPrototypeOf(playerM)._ensureStore
  playerM._ensureStore = async function () {
    await realEnsureM.call(this)
    // Kill topic lookups AFTER the swarm exists: every join answers a dead discovery
    // (refresh/flushed are what the engine touches), so a socket can only come from the
    // panelPeer dial. joinPeer is untouched — it does not go through join().
    this._swarm.join = () => ({ refresh () {}, destroy () {}, async flushed () {} })
  }
  await playerM.connect()
  let sM = null
  for (let i = 0; i < 10 && !sM; i++) {
    try { sM = await playerM.login('alice', PASSWORD) } catch (e) {
      if (!/unknown user/.test(String(e.message))) throw new Error('the direct-dial login failed outside the replication gap: ' + e.message)
      await sleep(500)
    }
  }
  if (!sM || sM.length < 4) throw new Error('the direct dial alone did not deliver the lineup')
  const marksM = playerM.bootTrace().map((m) => m.name + (m.detail ? ' ' + m.detail : ''))
  if (!marksM.includes('panel-joinpeer')) throw new Error('no panel-joinpeer mark — the rescue never dialled: ' + marksM.join(' | '))
  if (!marksM.some((m) => m.startsWith('rpc-armed'))) throw new Error('the RPC never armed on the rescue dial: ' + marksM.join(' | '))
  await playerM.stop()
  log('panel-peer: with the topic lookup DISABLED, the persisted key alone dialled the panel and logged in —', marksM.filter((m) => m === 'panel-joinpeer' || m.startsWith('rpc-armed')).join(', '))

  // …and a STALE hint costs nothing even when it fires: the delay is shrunk to (near)
  // zero so the bogus dial is IN FLIGHT while the lookup proceeds — the worst case — and
  // the probe never validates it, so the ordinary path logs in around it. The trust
  // boundary is asserted too — a hint must never appear in _panelPeerKey, which is the
  // field the instant no-probe re-arm path trusts.
  const dirN = tmp('e2es-cliN-')
  cleanups.push(() => { try { fs.rmSync(dirN, { recursive: true, force: true }) } catch {} })
  const stalePeer = b4a.toString(hcrypto.randomBytes(32), 'hex')
  const playerN = createPlayer({ panelPubKey, storeDir: dirN, swarm: { bootstrap }, panelPeer: stalePeer })
  cleanups.push(() => playerN.stop())
  playerN._panelDialDelayMs = 1
  await playerN.connect()
  let sN = null
  for (let i = 0; i < 10 && !sN; i++) {
    try { sN = await playerN.login('alice', PASSWORD) } catch (e) {
      if (!/unknown user|not connected to panel/.test(String(e.message))) throw new Error('a stale hint broke the lookup login: ' + e.message)
      await sleep(500)
    }
  }
  if (!sN || sN.length < 4) throw new Error('a stale panelPeer hint cost the ordinary login its lineup')
  if (playerN._panelPeerKey === stalePeer) throw new Error('the stale hint was TRUSTED — _panelPeerKey may only ever hold a probed key')
  await playerN.stop()
  const panelPeerProven = true
  log('panel-peer: a stale hint was refused by the probe and cost nothing — the lookup path logged in around it')

  // Discovery kick cadence, no network: the stub proves the rate limit and the offline
  // verdict without waiting on a real DHT.
  let kicksL = 0
  const kickFn = Object.getPrototypeOf(playerL)._kickPanelDiscovery
  const fakeL = { _panelDiscovery: { refresh: () => { kicksL++ } }, _panelRefreshAt: 0 }
  if (kickFn.call(fakeL) !== true || kicksL !== 1) throw new Error('first kick did not refresh the discovery')
  if (kickFn.call(fakeL) !== true || kicksL !== 1) throw new Error('a second kick inside the window must not fire another DHT query')
  fakeL._panelRefreshAt = Date.now() - 6000
  kickFn.call(fakeL)
  if (kicksL !== 2) throw new Error('a kick past the window must refresh again')
  if (kickFn.call({ _panelDiscovery: null }) !== false) throw new Error('no discovery must answer false (genuinely offline)')
  const loginWaitProven = true
  log('login-wait: discovery kick rate-limited + offline verdict correct; post-login stagger held across stop()')

  const pass = !!(loginWaitProven && panelPeerProven && streams.length && rejected && full.body.length > 0 && /video/.test(probeOut) &&
    livePushed >= 1 && rotated && ev2.fallback.length === 1 && ev2.sourceChanged.some(e => e.source === 'p2p') &&
    !ev2.status.includes('feed:open') && tuned && relookups >= 1 && wedgeHealed && unservableProven && hybridUnservableProven && zapWarmed &&
    meteredGated && directionalProven && stallGated && clientOnlyProven && evictReopenProven && redirectProven && liveEntitlementProven && diskRotationProven)
  log('\nRESULT:', pass ? 'PASS ✅  (headless SDK: login → resolve → P2P HLS + catalog live-push + active-feed rotation-while-watching + hybrid CDN fallback/auto-return + tune self-heal + wedged-connection teardown + unservable-feed escalation (tune + hybrid) + adjacent-channel zap prefetch + S21 smooth-zapping toggle/gate/directional + client-only uploadPolicy + evicted-feed re-open fresh dial + S23 redirect channels + S57 live entitlement (mid-session grant/revoke, no re-login) + VIEWER-DISK rotation of the active feed (invisible swap, request park, single-flight, cast pin, retune overlap, failed re-open, stop() overlap) + remembered-panel-peer rescue dial (arms with the topic lookup disabled; stale hint refused) verified)' : 'FAIL ❌')
  await cleanup(); process.exit(pass ? 0 : 1)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
