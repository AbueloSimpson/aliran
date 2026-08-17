// End-to-end PANEL-COMPACT **CLIENT** test: drives a REAL SDK viewer (sdk/index.js
// createPlayer — the same engine the Android worklet and the desktop app run) across a
// hypercore FORK of the panel's signed Hyperbee, on a LOCAL DHT testnet.
//
// tools/panel-compact.mjs proves the BEE is rebuilt faithfully. This lane asks the only
// question the operator actually has: DOES A VIEWER'S CHANNEL LINEUP SURVIVE? A viewer
// whose TV shows "no channels" for ten minutes after a maintenance window does not care
// that every key round-tripped byte-for-byte.
//
// THE HAZARDS THIS LANE IS SHAPED AROUND (all in sdk/player.js)
//
//   1. _doPushCatalog() loops this._entitled.keys(), does `await this._panelBee.get(
//      'catalog/' + id)`, and pushes ONLY `if (node && node.value)`. A record that reads
//      null is SILENTLY SKIPPED, and the method then emits 'streams' with whatever it
//      collected. A sweep that COMPLETES against a partially-available bee therefore
//      emits a TRUNCATED lineup — which on a television renders as "all my channels
//      vanished". The bound in _pushCatalog() only abandons a TIMED-OUT sweep without
//      emitting; it does nothing about a fast sweep full of nulls. A fork truncates the
//      replica and re-replicates it, so it is a brand-new way to open that window.
//      -> L5 records EVERY 'streams' emission and asserts none ever dropped a channel.
//
//   2. _watchCatalog() runs its `for await` inside a bare run() with NO re-arm loop —
//      contrast repeater/src/index.js:190-207 and epg/src/guide.js:141-158, which wrap
//      the identical watcher in `while (!this._closed)`. If a fork stops that iterator,
//      live catalog push (and _maybeReresolveActiveFeed, which rides the same loop) is
//      dead for the rest of the session.
//      -> L7 edits the catalog AFTER the fork and demands the warm viewer follow it.
//
//   3. sdk/recover.js isCorruptionError() matches EPARTIALREAD and /could not satisfy
//      length/i — TRUNCATION errors. A fork truncates. _watchCatalog pushes inside
//      this._recover(...), and withRecovery responds to a classified error by calling
//      _purge(), which deletes the client's ENTIRE replica store and re-replicates it.
//      Fork -> misclassified as on-disk corruption -> fleet-wide replica purge is a real
//      code path, and it is expensive rather than fatal, so it must be measured BEFORE
//      the procedure is published rather than discovered afterwards.
//      -> L10 counts purges from BOTH routes ('recovered' only fires for the withRecovery
//         path; sdk/player.js:3372 and :7170 call _purge() from serve-handler onError
//         WITHOUT emitting anything, so the method itself is wrapped too).
//
// PRODUCTION GROUND TRUTH this is calibrated against (measured read-only on the live
// SolTV panel core, 2026-08-16): fork 0, length 70137, byteLength 13,729,968,101,
// contiguousLength 70137, ~2,730 live keys — a ~25:1 dead-to-live block ratio. The real
// run therefore rebuilds at fork 1, so this lane exercises the 0 -> 1 transition
// SPECIFICALLY: 0 is falsy in JS and a guard written `if (!fork)` misbehaves exactly
// there and nowhere else.
//
// Deterministic and predicate-driven: local testnet only (never the public DHT), no
// ffmpeg, no fixed sleeps where a predicate will do, no new dependencies. The mini
// "broadcaster" below writes HLS bytes straight into a Hyperdrive, which is all the
// engine's serve path needs and keeps this lane off tools/e2e-sdk-test.mjs's ~125 s
// wall-clock sensitivity.
//
// EVERY LANE RUNS. Lanes record a verdict instead of aborting the process, because "the
// lineup survived but the watcher died" and "the watcher lived but the lineup truncated"
// are completely different operational decisions and the operator needs the whole board.
// Exits 0 only if every lane passed.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import createTestnet from 'hyperdht/testnet.js'
import http from 'http'
import os from 'os'; import fs from 'fs'; import path from 'path'
import { pathToFileURL } from 'url'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT, verifyToken, sessionLive
} from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { createPlayer } from '../sdk/index.js'
import { isCorruptionError } from '../sdk/recover.js'
// Builder A owns tools/panel-compact.mjs; this lane only ever CALLS it. Imported by URL
// so a missing file reports what to do instead of an ERR_MODULE_NOT_FOUND stack, and via
// PANEL_COMPACT_MODULE so the lane can be pointed at a candidate implementation.
// pathToFileURL, not new URL(): on Windows a bare absolute path parses as a 'c:' scheme
// and the ESM loader rejects it, which is exactly what an operator would type.
const compactUrl = process.env.PANEL_COMPACT_MODULE
  ? pathToFileURL(path.resolve(process.env.PANEL_COMPACT_MODULE))
  : new URL('./panel-compact.mjs', import.meta.url)
const { dumpBee, shadowRebuild, verifyShadow, swapCore } = await import(compactUrl.href).catch((err) => {
  console.log('RESULT: FAIL\nERROR: could not load the compaction tool at ' + compactUrl.href + '\n  ' + err.message)
  console.log('  This lane drives tools/panel-compact.mjs; it does not reimplement it.')
  process.exit(1)
})

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(200) }
  throw new Error('TIMEOUT after ' + ms + 'ms: ' + label)
}
function httpGet (port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      const c = []; res.on('data', (x) => c.push(x))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }))
    }).on('error', reject)
  })
}
// Assertion messages in this file all read expectation / observation / implication, because
// the audience for a failure here is an operator deciding whether to publish a procedure
// that touches the only copy of the accounts database.
function must (cond, msg) { if (!cond) throw new Error(typeof msg === 'function' ? msg() : msg) }

const DIFFICULTY = 8 // low: this lane tests catalog continuity, not Argon cost
const PASSWORD = 'test123'
const N_CATALOG = 48 // total catalog records
const N_ENTITLED = 40 // how many alice holds — each one is a bee.get inside every sweep
const CHURN_PUTS = 1000 // rewrites of the fat user record (the prod growth driver)
const CHURN_PAD = 16 * 1024
const SEG_BYTES = 3072
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
// dump/shadow/rollback all live OUTSIDE the panel data dir and on the same filesystem —
// panel-compact.mjs REFUSES otherwise (--out must not sit on the volume being compacted;
// a rollback inside DATA_DIR is deleted by the panel's own start-time core GC).
const dirs = {
  panel: tmp('pcc-panel-'), feed: tmp('pcc-feed-'),
  cli: tmp('pcc-warm-'), cliCold: tmp('pcc-cold-'),
  work: tmp('pcc-work-'), roll: tmp('pcc-roll-')
}
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

// --- lane bookkeeping ----------------------------------------------------------------
const lanes = []
async function runLane (n, name, fn) {
  const rec = { n, name, ok: null, note: '' }
  lanes.push(rec)
  try {
    rec.note = (await fn()) || ''
    rec.ok = true
    log(`\n  PASS  L${n} ${name}` + (rec.note ? '\n        ' + rec.note : ''))
  } catch (err) {
    rec.ok = false
    rec.note = String(err.message)
    log(`\n  FAIL  L${n} ${name}\n        ` + String(err.message).split('\n').join('\n        '))
  }
  return rec
}

// --- deterministic HLS bytes (no ffmpeg) ----------------------------------------------
// A segment's content is a pure function of its number, so the test can recompute what a
// byte it fetched over loopback was SUPPOSED to be instead of trusting a length.
const segBody = (n) => {
  const buf = b4a.alloc(SEG_BYTES)
  for (let i = 0; i < SEG_BYTES; i++) buf[i] = (n * 31 + i * 7) & 0xff
  return buf
}
const playlistFor = (n) => {
  const segs = [n - 2, n - 1, n].filter((x) => x >= 0)
  return b4a.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:' + segs[0] + '\n' +
    segs.map((s) => '#EXTINF:2.000,\nseg' + s + '.ts\n').join(''))
}

let phase = 'setup' // stamped onto every recorded event so a failure is attributable

try {
  log('=== panel-compact CLIENT lane: does a viewer survive the bee fork? ===\n')

  // ===== Local DHT testnet — never the public DHT =====
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap

  // ===== A stub provider for the redirect channels =====
  // Redirect entries are a different CLASS from P2P ones (S23): _doPushCatalog and
  // _resolveStream treat them differently, so the catalog below mixes both — a fork that
  // only preserved one class would pass a single-class test.
  const cdn = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2,\nseg0.ts\n')
  })
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const cdnPort = cdn.address().port
  cleanups.push(() => new Promise((resolve) => cdn.close(resolve)))
  const redirectUrl = (id) => `http://127.0.0.1:${cdnPort}/index.m3u8?ch=${id}`

  // ===== A real seeded P2P feed for the one channel this lane actually PLAYS =====
  const encKey0 = hcrypto.randomBytes(32)
  const feedStore = new Corestore(dirs.feed); await feedStore.ready(); cleanups.push(() => feedStore.close())
  const feed0 = new Hyperdrive(feedStore.namespace('feed'), { encryptionKey: encKey0 }); await feed0.ready()
  const feedSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => feedSwarm.destroy())
  feedSwarm.on('connection', (s) => feed0.replicate(s))
  feedSwarm.join(feed0.discoveryKey, { server: true, client: false }); await feedSwarm.flush()
  // A live edge, written straight into the drive. It must keep ADVANCING for the whole
  // run: the engine's tune watchdog treats a frozen playlist as a wedged feed and would
  // surface a friendly 'error', which L6 would then (correctly) report as a failure. The
  // feed swarm is independent of the panel, so this keeps advancing while the panel is
  // stopped — exactly as a real broadcaster does during a panel maintenance window.
  let segNo = 0
  let feedBusy = false
  const feedTimer = setInterval(async () => {
    if (feedBusy) return
    feedBusy = true
    try {
      await feed0.put('/seg' + segNo + '.ts', segBody(segNo))
      await feed0.put('/index.m3u8', playlistFor(segNo))
      segNo++
    } catch { /* teardown race at cleanup */ } finally { feedBusy = false }
  }, 700)
  cleanups.push(() => clearInterval(feedTimer))
  await waitFor(async () => segNo >= 3, 20000, 'the mini-broadcaster produced a live edge')

  // ===== Panel: keys, a realistic mixed catalog, alice + a known grant subset =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const panel = { store: null, db: null, swarm: null }
  cleanups.push(async () => { if (panel.swarm) await panel.swarm.destroy() })
  cleanups.push(async () => { if (panel.store) await panel.store.close() })
  const opened = await openStore(dirs.panel, keys)
  panel.store = opened.store; panel.db = opened.db

  const id = (i) => 'ch' + String(i).padStart(2, '0')
  const P2P_PLAYED = id(0) // seeded, resolved, and kept ACTIVE across the fork
  const REDIRECT_ONE = id(1) // resolved verbatim across the fork
  const encKeys = new Map() // streamId -> encryption key (sealed into alice's record)
  for (let i = 0; i < N_CATALOG; i++) {
    const sid = id(i)
    const enc = i === 0 ? encKey0 : hcrypto.randomBytes(32)
    encKeys.set(sid, enc)
    if (i === 0) {
      await panel.db.put('catalog/' + sid, { title: 'Seeded P2P', category: ['live'], type: 'live', protection: 'self', feedKey: b4a.toString(feed0.key, 'hex'), isLive: true, status: 'live' })
    } else if (i % 2 === 1) {
      await panel.db.put('catalog/' + sid, { title: 'Redirect ' + sid, category: ['events'], type: 'live', protection: 'self', feedKey: null, blobsKey: null, redirect: true, url: redirectUrl(sid), headers: { referer: 'https://provider.example/' + sid + '/' }, isLive: true, status: 'live' })
    } else {
      // Cataloged P2P channels nobody seeds: they belong in the LINEUP (that is the thing
      // under test) and are never resolved, so no tune ladder ever runs for them.
      await panel.db.put('catalog/' + sid, { title: 'P2P ' + sid, category: ['live'], type: 'live', protection: 'self', feedKey: b4a.toString(hcrypto.randomBytes(32), 'hex'), isLive: true, status: 'live' })
    }
  }

  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt()
  const wk = wrapKeyFrom(rwd)
  const kp = userKeyPair()
  const authKp = authKeyPair()
  const wrapped = {}
  const EXPECTED = []
  for (let i = 0; i < N_ENTITLED; i++) { wrapped[id(i)] = sealTo(kp.publicKey, encKeys.get(id(i))); EXPECTED.push(id(i)) }
  const EXPECTED_SET = new Set(EXPECTED)
  await panel.db.put('user/alice', {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(rwd, salt, ARGON2_DEFAULT), 'hex'),
    argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'),
    encPriv: wrap(wk, kp.secretKey),
    authPub: b4a.toString(authKp.publicKey, 'hex'),
    authPrivEnc: wrap(wk, authKp.secretKey),
    wrapped,
    devices: [], tokenVersion: 1, maxDevices: 4, status: 'active'
  })

  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  const topic = hcrypto.hash(keys.signing.publicKey)
  const throttle = makeThrottle(1000, 200)
  const serveRpc = (socket) => { panel.store.replicate(socket); attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle, db: panel.db, dataDir: dirs.panel, sessionTtlMs: 3600000 }) }
  const startPanelSwarm = async () => {
    panel.swarm = new Hyperswarm({ bootstrap })
    panel.swarm.on('connection', serveRpc)
    panel.swarm.join(topic, { server: true, client: false })
    await panel.swarm.flush()
  }
  await startPanelSwarm()
  log(`setup: panel serving ${N_CATALOG} catalog records (${N_ENTITLED} granted to alice), pubkey ${panelPubKey.slice(0, 16)}…`)
  log(`setup: mixed classes — ${EXPECTED.filter((x) => Number(x.slice(2)) % 2 === 1).length} redirect + ${EXPECTED.filter((x) => Number(x.slice(2)) % 2 === 0).length} p2p in the entitled set`)

  // ===== L1/L2: a REAL SDK viewer logs in and receives the full lineup =====
  // Instrumentation is attached BEFORE connect() so nothing that happens during login is
  // invisible. `emissions` is the evidence L5 is decided on.
  const emissions = [] // { t, phase, ids }
  const errors = [] // { t, phase, message, code, wouldBeClassifiedCorrupt }
  const recovered = [] // { t, phase, code, message } — the withRecovery route
  const purges = [] // { t, phase } — EVERY route, including the two silent ones
  const player = createPlayer({ panelPubKey, storeDir: dirs.cli, swarm: { bootstrap } })
  player.on('streams', (s) => emissions.push({ t: Date.now(), phase, ids: (s || []).map((x) => x.id) }))
  player.on('error', (e) => errors.push({ t: Date.now(), phase, message: String((e && e.message) || e), code: e && e.code, wouldBeClassifiedCorrupt: isCorruptionError(e) }))
  player.on('recovered', (e) => recovered.push({ t: Date.now(), phase, code: e && e.code, message: String((e && e.message) || e) }))
  cleanups.push(() => player.stop())
  // _recover() emits 'recovered' before purging, but sdk/player.js:3372 and :7170 call
  // _purge() straight out of a serve handler's onError with no event at all — so the
  // METHOD is the only complete counter. Wrapped rather than spied on the event alone.
  const origPurge = player._purge.bind(player)
  player._purge = (...a) => { purges.push({ t: Date.now(), phase }); return origPurge(...a) }

  await player.connect()
  phase = 'login'
  let streams = null
  const loginDeadline = Date.now() + 90000
  while (!streams) {
    must(Date.now() <= loginDeadline, 'TIMEOUT: the warm viewer never completed a login with the full lineup')
    try {
      const s = await player.login('alice', PASSWORD)
      if (s.length === N_ENTITLED) streams = s // wait for the WHOLE catalog to have replicated
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streams) await sleep(800)
  }
  const loginOkAt = Date.now()
  phase = 'pre-fork'
  const gotIds = new Set(streams.map((x) => x.id))
  must(EXPECTED.every((x) => gotIds.has(x)),
    () => `login lineup is wrong: expected ${N_ENTITLED} ids, got ${gotIds.size}; missing ${EXPECTED.filter((x) => !gotIds.has(x)).join(',')}. ` +
    'Nothing downstream is meaningful if the baseline lineup is already incomplete.')
  log(`\nsetup: warm viewer logged in with the full ${N_ENTITLED}-channel lineup (${EXPECTED[0]}..${EXPECTED[N_ENTITLED - 1]})`)

  // ===== Pre-fork CONTROL for L7 =====
  // L7 asks whether the catalog watcher is alive AFTER the fork. That question is only
  // answerable if it was demonstrably alive BEFORE, on this exact player, with this exact
  // catalog size — otherwise a silent watcher post-fork could just mean the test never
  // wired one up. This control is therefore part of setup, not a lane.
  await panel.db.put('catalog/' + id(2), { title: 'Control Edit', category: ['live'], type: 'live', protection: 'self', feedKey: b4a.toString(hcrypto.randomBytes(32), 'hex'), isLive: true, status: 'live' })
  await waitFor(async () => (player.listStreams() || []).some((s) => s.id === id(2) && s.title === 'Control Edit'), 45000,
    'PRE-fork control: _watchCatalog must push a catalog edit to the warm viewer (if this fails the lane cannot judge the post-fork watcher)')
  const emissionsAtControl = emissions.length
  log('setup: PRE-fork control — the live catalog watcher pushes an edit to the warm viewer')

  // ===== Pre-fork playback, so L8 is a CONTINUITY claim rather than a first attempt =====
  const r0 = await player.resolve(P2P_PLAYED)
  must(r0.feedKey === b4a.toString(feed0.key, 'hex'), 'pre-fork resolve() returned the wrong feedKey — setup is broken')
  const provePlayback = async (label) => {
    const pl = await waitFor(async () => {
      const r = await httpGet(r0.port, '/index.m3u8')
      return r.status === 200 && r.body.includes('.ts') ? r.body.toString() : null
    }, 45000, label + ': the engine must serve the P2P playlist over its loopback server')
    const name = (pl.match(/seg(\d+)\.ts/) || [])[0]
    const num = Number((pl.match(/seg(\d+)\.ts/) || [])[1])
    const seg = await waitFor(async () => {
      const r = await httpGet(r0.port, '/' + name)
      return r.status === 200 && r.body.length === SEG_BYTES ? r : null
    }, 45000, label + ': the engine must serve segment bytes, not just a playlist')
    must(b4a.equals(seg.body, segBody(num)),
      `${label}: segment ${name} served ${seg.body.length} bytes that do NOT match what the broadcaster published. ` +
      'The bytes reaching the player are not the bytes on the feed — this is a replication/decryption fault, not a lineup one.')
    return { name, segs: pl.split('\n').filter((l) => l.trim().endsWith('.ts')).length }
  }
  const prePlay = await provePlayback('pre-fork')
  const rr0 = await player.resolve(REDIRECT_ONE)
  must(rr0.url === redirectUrl(REDIRECT_ONE) && rr0.source === 'cdn' && rr0.port === undefined,
    'pre-fork redirect resolve() has the wrong shape — setup is broken: ' + JSON.stringify(rr0))
  await player.resolve(P2P_PLAYED) // leave the P2P channel ACTIVE across the fork
  log(`setup: pre-fork playback proven — ${prePlay.name} served byte-identical over loopback (${prePlay.segs} segs live)`)

  // ===== L4 (part 1): CHURN, so core.length far exceeds the live key count =====
  // The prod growth driver is deleteStream rewriting a ~455 KB grant map per removed
  // channel, per holder (the 12.35 GB bee). Reproduce its SHAPE: rewrite the one fat user
  // record over and over. The grant SET never changes, so _refreshEntitlements finds no
  // delta and pushes nothing — which is exactly what the real churn does too.
  phase = 'churn'
  const liveKeyCount = N_CATALOG + 1 /* user/alice */ + 2 /* meta/assetsKey, meta/updatesKey */
  const pad = 'x'.repeat(CHURN_PAD)
  for (let i = 0; i < CHURN_PUTS; i++) {
    const cur = (await panel.db.get('user/alice')).value // read-modify-write: never clobber the device login() added
    cur.pad = pad + i
    await panel.db.put('user/alice', cur)
  }
  const beforeLength = panel.db.core.length
  const beforeBytes = panel.db.core.byteLength
  const beforeStorage = (await panel.db.core.info({ storage: true })).storage
  const deadRatio = beforeLength / liveKeyCount
  must(deadRatio >= 15,
    `churn produced only a ${deadRatio.toFixed(1)}:1 block-to-live-key ratio (length ${beforeLength}, ~${liveKeyCount} live keys). ` +
    'Production sits at ~25:1; well below that this lane is not exercising a bee worth compacting and the fork would be trivial.')
  log(`\nchurn: bee at fork ${panel.db.core.fork}, length ${beforeLength}, byteLength ${(beforeBytes / 1e6).toFixed(1)} MB, ` +
    `~${liveKeyCount} live keys (${deadRatio.toFixed(1)}:1 dead-to-live — production is ~25:1)`)

  // ===== L4 (part 2): the REAL procedure, with the panel STOPPED =====
  phase = 'panel-down'
  const downAt = Date.now()
  await panel.swarm.destroy(); panel.swarm = null
  await panel.store.close(); panel.store = null; panel.db = null
  log('fork: panel STOPPED (swarm destroyed, store closed) — all four phases assume no writer')

  const dumpPath = path.join(dirs.work, 'bee.ndjson')
  const shadowDir = path.join(dirs.work, 'shadow')
  const dumped = await dumpBee({ dataDir: dirs.panel, publicKey: panelPubKey, outPath: dumpPath })
  must(dumped.fork === 0,
    `the test bee dumped at fork ${dumped.fork}, expected 0. Production is at fork 0 and rebuilds to 1; ` +
    'this lane must exercise the 0 -> 1 transition specifically, because 0 is falsy and a `if (!fork)` guard misbehaves only there.')
  const NEW_FORK = dumped.fork + 1
  must(NEW_FORK === 1, 'the rebuild target must be fork 1 for this lane to mirror the production run')
  const rebuilt = await shadowRebuild({ dumpPath, keyPair: keys.signing, storeDir: shadowDir, fork: NEW_FORK })
  // dataDir is required: verify re-walks the LIVE bee and compares it to the shadow, so a
  // dump that is self-consistent but short cannot pass. swapCore refuses a receipt without it.
  const verified = await verifyShadow({ dumpPath, storeDir: shadowDir, dataDir: dirs.panel, expect: { fork: NEW_FORK, keyHex: panelPubKey } })
  const swapped = await swapCore({ dataDir: dirs.panel, shadowStoreDir: shadowDir, rollbackDir: dirs.roll, confirm: true })
  must(rebuilt.fork === 1 && verified.fork === 1 && swapped.fork === 1,
    `the swapped-in core must be at fork 1 (rebuild ${rebuilt.fork}, verify ${verified.fork}, swap ${swapped.fork}). ` +
    'A core installed at the SAME fork hands every client a conflicting block at a sequence number it already holds.')
  log(`fork: dump ${dumped.keyCount} keys (${(dumped.byteLength / 1e6).toFixed(1)} MB core) -> rebuild@fork ${rebuilt.fork} ` +
    `(${rebuilt.length} blocks, ${(rebuilt.byteLength / 1e3).toFixed(1)} kB) -> verify ok -> swap`)
  log(`fork: on-disk data file ${(beforeStorage.blocks / 1e6).toFixed(1)} MB -> ` +
    `${((swapped.sizes.after.live.files.data ? swapped.sizes.after.live.files.data.size : 0) / 1e3).toFixed(1)} kB; ` +
    `freed ${(swapped.sizes.freedBytes / 1e6).toFixed(1)} MB; rollback parked at ${swapped.movedLiveTo}`)

  // ===== Panel BACK UP on the same key and the same topic =====
  const reopened = await openStore(dirs.panel, keys)
  panel.store = reopened.store; panel.db = reopened.db
  must(panel.db.core.fork === NEW_FORK,
    `the restarted panel opened its bee at fork ${panel.db.core.fork}, expected ${NEW_FORK} — the swap did not take.`)
  await startPanelSwarm()
  const downMs = Date.now() - downAt
  phase = 'reorg'
  log(`fork: panel BACK UP at fork ${panel.db.core.fork}, length ${panel.db.core.length} (down for ${(downMs / 1000).toFixed(1)}s)\n`)

  // The panel restarted with a FRESH hyperswarm identity — production does the same
  // (panel/src/index.js constructs `new Hyperswarm(...)` and persists no keyPair), so
  // every client must re-LOOKUP the topic to find it again. Pace the engine's OWN
  // accelerator (sdk/player.js _kickPanelDiscovery -> _panelDiscovery.refresh()) rather
  // than waiting out hyperswarm's ordinary refresh cadence in CI. This is the engine's
  // mechanism, not a test-only backdoor: it is what report() does when the RPC is down.
  const reorgAt = Date.now()
  const kicker = setInterval(() => {
    try { const r = player._panelDiscovery && player._panelDiscovery.refresh({ client: true, server: false }); if (r && r.catch) r.catch(() => {}) } catch {}
  }, 2000)
  cleanups.push(() => clearInterval(kicker))
  let reorgMs = null
  try {
    await waitFor(async () => player._panelBee && player._panelBee.core.fork === NEW_FORK, 120000, 'the warm client reorgs to the new fork')
    reorgMs = Date.now() - reorgAt
    log(`reorg: warm client followed the fork in ${(reorgMs / 1000).toFixed(1)}s ` +
      `(fork ${player._panelBee.core.fork}, length ${player._panelBee.core.length})`)
  } catch (err) {
    log('reorg: WARM CLIENT DID NOT REORG — ' + err.message)
  }
  clearInterval(kicker)
  phase = 'post-fork'

  // Give the transition room to do damage before anything is judged. Every 'streams'
  // emission in this window lands in `emissions` and is audited by L5 below.
  await sleep(3000)

  // =====================================================================================
  // LANES
  // =====================================================================================

  // ----- L5: THE KEY ASSERTION ---------------------------------------------------------
  const fmtEmission = (e) => {
    const missing = EXPECTED.filter((x) => !e.ids.includes(x))
    const extra = e.ids.filter((x) => !EXPECTED_SET.has(x))
    return `      +${String(e.t - loginOkAt).padStart(7)}ms [${e.phase}] n=${String(e.ids.length).padStart(3)}` +
      (missing.length ? `  MISSING(${missing.length}): ${missing.slice(0, 12).join(',')}${missing.length > 12 ? ',…' : ''}` : '  (full lineup)') +
      (extra.length ? `  extra: ${extra.join(',')}` : '')
  }
  await runLane(5, 'no truncated lineup — every \'streams\' emission still carries all ' + N_ENTITLED + ' entitled channels', async () => {
    const judged = emissions.filter((e) => e.t >= loginOkAt)
    const truncated = judged.filter((e) => EXPECTED.some((x) => !e.ids.includes(x)))
    must(truncated.length === 0, () =>
      `${truncated.length} of ${judged.length} 'streams' emissions dropped entitled channels. sdk/player.js _doPushCatalog() ` +
      'skips a catalog record that reads null and emits anyway, so a sweep that completed against a partially-available ' +
      'replica told the host those channels are GONE. On a television that renders as an empty or gutted lineup.\n' +
      '      ---- every emission from login onward ----\n' + judged.map(fmtEmission).join('\n') +
      '\n      ---- truncated emissions above are the finding ----')
    const postFork = judged.filter((e) => e.phase !== 'login' && e.phase !== 'pre-fork')
    const base = `${judged.length} emissions audited from login onward (${postFork.length} during/after the fork); ` +
      `smallest lineup emitted was ${Math.min(...judged.map((e) => e.ids.length))} of ${N_ENTITLED}`
    // Honesty about the evidence base. ZERO emissions in the fork window means the lineup
    // was never truncated because it was never RE-EMITTED — which is a pass for this lane
    // and a symptom for L7, not a clean bill of health for _doPushCatalog. Say so, or a
    // reader takes a vacuous pass for a proof.
    if (postFork.length === 0) {
      return base + '\n        NOTE: the lineup survived because NOTHING re-pushed it — 0 emissions in the fork window. ' +
        'This lane is VACUOUS here; read it together with L7.'
    }
    return base
  })

  // ----- L6: the session survives ------------------------------------------------------
  await runLane(6, 'the viewer\'s session survives the fork (token still validates, no \'error\' emitted, no re-login)', async () => {
    must(player._session && player._session.token,
      'the engine no longer holds a session token after the fork; a viewer would be bounced to the login screen.')
    let payload = null
    try { payload = verifyToken(keys.signing.publicKey, player._session.token) } catch (e) { payload = null }
    must(payload && payload.userId === 'alice',
      'the session token no longer verifies against the panel signing key after the fork — the token is signed material ' +
      'independent of the bee, so a failure here means the rebuild disturbed the account identity.')
    const live = await sessionLive(panel.db, payload)
    must(live === true,
      'sessionLive() says the session is dead against the REBUILT bee. The device/tokenVersion/status the panel issued the ' +
      'token against did not survive the rebuild, so every viewer would be forced to log in again after the maintenance window.')
    must(errors.length === 0, () => {
      const lines = [`the engine emitted ${errors.length} 'error' event(s) across the fork:`]
      for (const e of errors) lines.push(`      +${e.t - loginOkAt}ms [${e.phase}] code=${e.code || '-'} corruptionClassified=${e.wouldBeClassifiedCorrupt} :: ${e.message}`)
      // The engine has exactly two `emit('error')` sites that a fork can reach: the catch
      // around _watchCatalog's `for await` and the one around _watchGrants'. A snapshot
      // taken before the truncate is unreadable after it (hypercore/index.js:844 throws
      // SNAPSHOT_NOT_AVAILABLE once index >= _snapshot.compatLength), which is exactly
      // what hyperbee's Watcher holds in `previous`/`current`. So this error IS a watcher
      // dying, and neither watcher is ever re-armed. See L7.
      if (errors.some((e) => e.code === 'SNAPSHOT_NOT_AVAILABLE')) {
        lines.push('      SNAPSHOT_NOT_AVAILABLE is a WATCHER dying, not the session: hyperbee\'s Watcher holds snapshots taken')
        lines.push('      before the truncate, and hypercore/index.js:844 refuses to read one past the truncated length. The only')
        lines.push('      handling in sdk/player.js is `this.emit(\'error\', err)` in _watchCatalog/_watchGrants — neither re-arms.')
        lines.push('      This is the same defect L7 reports; the two lanes see its two faces (it throws, or it parks silently).')
      }
      return lines.join('\n')
    })
    return `token verifies and sessionLive() is true against the rebuilt bee; 0 'error' events; no re-login performed`
  })

  // ----- L10: does the fork trip the corruption classifier? -----------------------------
  await runLane(10, 'the fork is NOT misclassified as store corruption (no replica purge)', async () => {
    must(purges.length === 0 && recovered.length === 0, () => {
      const lines = []
      lines.push(`the client purged its replica ${purges.length} time(s) (${recovered.length} classified through withRecovery).`)
      for (const r of recovered) lines.push(`      +${r.t - loginOkAt}ms [${r.phase}] classified CORRUPT: code=${r.code || '-'} :: ${r.message}`)
      for (const p of purges) lines.push(`      +${p.t - loginOkAt}ms [${p.phase}] _purge() called`)
      lines.push('      A fork TRUNCATES the core, and sdk/recover.js isCorruptionError() matches EPARTIALREAD and')
      lines.push('      /could not satisfy length/i — truncation errors. Every affected client would throw its whole replica')
      lines.push('      store away and re-replicate it. Converged afterwards: ' +
        (player._panelBee && player._panelBee.core.fork === NEW_FORK ? 'YES (expensive, self-healing)' : 'NO (WEDGED — this is the bad case)'))
      return lines.join('\n')
    })
    // Independent witness: a purge replaces the store object wholesale, so an unchanged
    // store identity is evidence no purge slipped past both counters.
    must(player._store && player._panelBee,
      'the engine has no store/bee after the fork — something tore the replica down and did not rebuild it.')
    return '0 purges from either route (\'recovered\' event AND the _purge() method, which sdk/player.js:3372/:7170 call silently); ' +
      'store and panel bee both still open'
  })

  // ----- L7: is the live catalog watcher still alive? -----------------------------------
  await runLane(7, 'the live catalog watcher survives the fork (a post-fork catalog change reaches the warm viewer)', async () => {
    must(player._panelBee && player._panelBee.core.fork === NEW_FORK,
      `the warm client is at fork ${player._panelBee ? player._panelBee.core.fork : 'n/a'}, not ${NEW_FORK} — it never followed the ` +
      'reorg, so this lane cannot attribute a silent watcher to the watcher itself.')
    // (a) the pure _watchCatalog path: EDIT a record the viewer is already entitled to.
    const editAt = Date.now()
    await panel.db.put('catalog/' + id(4), { title: 'Post Fork Edit', category: ['live'], type: 'live', protection: 'self', feedKey: b4a.toString(hcrypto.randomBytes(32), 'hex'), isLive: true, status: 'live' })
    let editMs = null
    try {
      await waitFor(async () => (player.listStreams() || []).some((s) => s.id === id(4) && s.title === 'Post Fork Edit'), 60000, 'post-fork catalog edit reaches the warm viewer')
      editMs = Date.now() - editAt
    } catch (err) {
      // Direct reads still work? Then the replica is fine and the WATCHER is the fault.
      const direct = await player._panelBee.get('catalog/' + id(4))
      const readable = !!(direct && direct.value && direct.value.title === 'Post Fork Edit')
      // Dead forever, or deaf until enough new blocks land? The answer decides what the
      // operator does after the maintenance window: "every app must be restarted" versus
      // "the next source sync heals it".
      //
      // hyperbee's Watcher parks in _waitForChanges() until `current.version <
      // bee.version`, where `current` is a snapshot taken before the truncate. A rebuild
      // makes the log SHORTER, so the version it is comparing against is one the fresh
      // log will not reach again until it has been re-grown past the OLD length. Test
      // that hypothesis directly: re-put a catalog record (the shape of the panel's
      // half-hourly source sync) until the log passes its pre-fork length, and see
      // whether the edit is finally delivered.
      const healAt = Date.now()
      const rec = (await panel.db.get('catalog/' + id(5))).value
      const lenAtFail = panel.db.core.length
      while (panel.db.core.length <= beforeLength + 4) await panel.db.put('catalog/' + id(5), rec)
      const appendsNeeded = panel.db.core.length - lenAtFail
      let healed = null
      try {
        await waitFor(async () => (player.listStreams() || []).some((s) => s.id === id(4) && s.title === 'Post Fork Edit'), 45000, 'catch-up past the pre-fork length')
        healed = Date.now() - healAt
      } catch {}
      must(false,
        'the warm viewer never saw a catalog edit made AFTER the fork.\n' +
        `      The edited record is ${readable ? 'READABLE on the client replica' : 'NOT yet readable on the client replica'}, ` +
        'so the fault is in ' + (readable ? 'the WATCHER, not replication' : 'replication or the watcher') + '.\n' +
        `      RECOVERY: the rebuilt log was re-grown past its pre-fork length (${lenAtFail} -> ${lenAtFail + appendsNeeded} blocks, ` +
        `${appendsNeeded} appends, pre-fork was ${beforeLength}) and the watcher ` +
        (healed === null
          ? 'STILL had not delivered the edit 45s later — treat it as dead for the session.\n'
          : `then delivered the edit, ${(healed / 1000).toFixed(1)}s in.\n` +
            '      So the watcher is DEAF, not dead, and the healing condition is that the REBUILT log must grow past the OLD\n' +
            '      length — hyperbee\'s Watcher parks on a snapshot version captured before the truncate. In production that is\n' +
            `      ~70,137 blocks against a rebuilt core of ~2,731: warm clients stay blind to every catalog change until the\n` +
            '      panel has appended ~67,400 more blocks, which is effectively "until the app is restarted".\n') +
        '      sdk/player.js _watchCatalog() runs its `for await` inside a bare run() with no re-arm loop, unlike\n' +
        '      repeater/src/index.js:190-207 and epg/src/guide.js:141-158 which wrap the identical watcher in\n' +
        '      `while (!this._closed)`. A dead watcher means live catalog push AND _maybeReresolveActiveFeed (which\n' +
        '      rides the same loop, so feedKey rotations stop being followed) are gone for the rest of the session —\n' +
        '      silently, with no error, until the app is restarted.\n' +
        `      Watcher fired ${emissions.length - emissionsAtControl} time(s) since the pre-fork control edit, which DID arrive.\n` +
        '      ' + err.message)
    }
    // (b) the whole live path: a BRAND-NEW redirect channel, cataloged and granted after
    // the fork, must join the lineup with no re-login (sdk/player.js _refreshEntitlements
    // admits redirect grants live; a P2P grant correctly waits for the next login).
    const NEWID = 'postfork01'
    await panel.db.put('catalog/' + NEWID, { title: 'Post Fork Channel', category: ['events'], type: 'live', protection: 'self', feedKey: null, blobsKey: null, redirect: true, url: redirectUrl(NEWID), headers: { referer: 'https://provider.example/postfork/' }, isLive: true, status: 'live' })
    const cur = (await panel.db.get('user/alice')).value
    cur.wrapped[NEWID] = sealTo(kp.publicKey, hcrypto.randomBytes(32))
    await panel.db.put('user/alice', cur)
    await waitFor(async () => (player.listStreams() || []).some((s) => s.id === NEWID), 60000,
      'a channel cataloged AND granted after the fork must reach the warm viewer with no re-login')
    return `a post-fork catalog EDIT arrived in ${editMs}ms and a post-fork channel+grant joined the lineup, both with no re-login`
  })

  // ----- L8: playback-adjacent continuity ----------------------------------------------
  await runLane(8, 'playback continuity — a pre-fork entitlement still resolves and serves real bytes, with no re-login', async () => {
    const rP = await player.resolve(P2P_PLAYED)
    must(rP.feedKey === b4a.toString(feed0.key, 'hex'),
      `resolve('${P2P_PLAYED}') returned feedKey ${rP.feedKey} after the fork, expected the seeded feed. ` +
      'The engine lost the stream keys it unsealed at login, which would force a re-login to watch anything.')
    const post = await provePlayback('post-fork')
    must(post.name !== prePlay.name,
      `the served playlist is frozen at ${prePlay.name} — the live edge stopped advancing across the fork, which is a ` +
      'stalled play from the viewer\'s seat even though the lineup is intact.')
    const rR = await player.resolve(REDIRECT_ONE)
    must(rR.url === redirectUrl(REDIRECT_ONE) && rR.source === 'cdn' && rR.port === undefined,
      `the redirect channel resolved to ${JSON.stringify({ url: rR.url, source: rR.source, port: rR.port })} after the fork; ` +
      'redirect entries must come back VERBATIM from the replicated catalog or the operator\'s events lineup breaks.')
    must(rR.headers && rR.headers.referer === 'https://provider.example/' + REDIRECT_ONE + '/',
      'the redirect channel lost its provider headers across the fork — the upstream would reject the playback request.')
    return `${P2P_PLAYED} re-resolved and served ${post.name} byte-identical over loopback (advanced from ${prePlay.name}); ` +
      `${REDIRECT_ONE} resolved verbatim with headers intact`
  })

  // ----- L9: a COLD viewer -------------------------------------------------------------
  await runLane(9, 'a COLD viewer (fresh store, never saw fork 0) logs in against the forked panel and gets the full lineup', async () => {
    const coldEv = { errors: [], last: null }
    const cold = createPlayer({ panelPubKey, storeDir: dirs.cliCold, swarm: { bootstrap } })
    cold.on('streams', (s) => { coldEv.last = s })
    cold.on('error', (e) => coldEv.errors.push(String((e && e.message) || e)))
    cleanups.push(() => cold.stop())
    await cold.connect()
    let s = null
    const dl = Date.now() + 90000
    while (!s) {
      must(Date.now() <= dl, 'TIMEOUT: a cold viewer could not log in against the forked panel — a fresh install would be broken')
      try { const r = await cold.login('alice', PASSWORD); if (r.length >= N_ENTITLED) s = r } catch (e) {
        if (!/not connected|unknown user/i.test(String(e.message))) throw e
      }
      if (!s) await sleep(800)
    }
    const have = new Set(s.map((x) => x.id))
    const missing = EXPECTED.filter((x) => !have.has(x))
    must(missing.length === 0,
      `a cold viewer logged in but is missing ${missing.length} channel(s): ${missing.slice(0, 12).join(',')}. ` +
      'A fresh install replicates the rebuilt core from block 0, so this is the lineup every NEW device would see.')
    must(coldEv.errors.length === 0, () => 'the cold viewer emitted errors: ' + JSON.stringify(coldEv.errors))
    const rc = await cold.resolve(REDIRECT_ONE)
    must(rc.url === redirectUrl(REDIRECT_ONE), 'the cold viewer resolved a redirect channel to the wrong url: ' + rc.url)
    return `cold login returned ${s.length} channels (all ${N_ENTITLED} expected, plus post-fork additions) and resolved one of them`
  })

  // =====================================================================================
  // SUMMARY
  // =====================================================================================
  log('\n' + '='.repeat(78))
  log('EMISSION LOG (every \'streams\' the warm viewer emitted, from login onward)')
  for (const e of emissions.filter((x) => x.t >= loginOkAt)) log(fmtEmission(e))
  log('='.repeat(78))
  log(`fork transition   : fork ${dumped.fork} -> ${NEW_FORK}; panel down ${(downMs / 1000).toFixed(1)}s; ` +
    `warm client reorg ${reorgMs === null ? 'NEVER' : (reorgMs / 1000).toFixed(1) + 's'}`)
  log(`bee               : ${beforeLength} blocks / ${(beforeBytes / 1e6).toFixed(1)} MB  ->  ` +
    `${rebuilt.length} blocks / ${(rebuilt.byteLength / 1e3).toFixed(1)} kB  (${dumped.keyCount} live keys)`)
  log(`warm viewer       : ${emissions.filter((e) => e.t >= loginOkAt).length} 'streams' emissions, ${errors.length} errors, ` +
    `${purges.length} replica purges, ${recovered.length} corruption classifications`)
  for (const l of lanes) log(`  ${l.ok ? 'PASS' : 'FAIL'}  L${l.n}  ${l.name}`)
  log('='.repeat(78))

  const failed = lanes.filter((l) => !l.ok)
  if (failed.length) {
    log('\nRESULT: FAIL  (' + failed.length + ' of ' + lanes.length + ' lanes: ' + failed.map((l) => 'L' + l.n).join(', ') + ')')
    for (const l of failed) log(`\nL${l.n} ${l.name}\n  ${l.note}`)
    await cleanup(); process.exit(1)
  }
  log('\nRESULT: PASS ✅  (panel bee rebuilt at fork 0->1 under a live SDK viewer: the lineup never truncated, ' +
    'the session and its token survived with no re-login, no replica was purged, the live catalog watcher kept following ' +
    'the catalog, pre-fork entitlements still resolve and serve byte-identical media, and a cold viewer gets the full lineup)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('\nRESULT: FAIL  (setup or harness error — no verdict on the lanes)')
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
