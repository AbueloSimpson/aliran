// Acceptance gate for tools/panel-compact.mjs — the offline rebuild that replaces the
// panel's signed Hyperbee with a compacted core at fork+1 and swaps the core DIRECTORY in.
// Nothing here may be taken on trust: this runs before a 12.8 GB production core is
// rewritten under ~10 live accounts and a fleet of Android TVs that cannot be rolled back.
//
// THE MECHANISM. The bee is append-only, so a churned record's every previous revision is
// still on disk. Compaction dumps the live keys, replays them into a NEW core with the SAME
// keypair at fork = oldFork + 1, and renames that core directory into DATA_DIR. The panel
// public key never changes, so every pinned key and every outstanding session token survives.
// Two library facts are supposed to make this safe. This test measures both rather than
// assuming them, and ONE OF THEM DOES NOT HOLD (see lane 5g):
//
//   1. hypercore/lib/core.js:841-843 — checkConflict returns false immediately when
//      `proof.fork !== this.tree.fork`. Rebuilding at the SAME fork instead produces two
//      valid signatures at one length, and every client calls _closeAllSessions(err) and does
//      not recover. The fork counter is a SIGNED field (hypercore/lib/caps.js:29-37), which
//      is why a client cannot be lied to about it. VERIFIED here — lanes 5 and 8.
//   2. hyperbee/index.js:1573 — the range watcher is supposed to `return await this._yield()`
//      when `this.current.core.fork !== this.previous.core.fork`, skipping the differ across a
//      fork so a watcher cannot wedge walking a vanished historical tree. FALSIFIED here —
//      lane 5g. hypercore's `fork` getter (hypercore/index.js:588-590) reads the LIVE core
//      even on a snapshot session, so by the time the watcher wakes up both sides report the
//      NEW fork, the check never fires, and the differ blocks forever on a block that no
//      longer exists. Every `bee.watch(<range>)` in this repo goes deaf at the swap.
//
// Local DHT testnet only, temp dirs only, no ffmpeg, no fixed sleeps where a predicate will
// do. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import readline from 'readline'
import { fork as forkChild } from 'child_process'
import { fileURLToPath } from 'url'
import createTestnet from 'hyperdht/testnet.js'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, verifyToken, ARGON2_DEFAULT
} from '@aliran/core'
import { panelClient, login } from '../client/backend/login.mjs'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { dumpBee, shadowRebuild, verifyShadow, swapCore, readDumpMeta, coreDirFor } from './panel-compact.mjs'

const SELF = fileURLToPath(import.meta.url)
const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(200) } throw new Error('timeout: ' + label) }
const MiB = 1024 * 1024
const fmt = (n) => (n === null || n === undefined ? 'n/a' : (n / MiB).toFixed(2) + ' MiB')

// =========================================================================================
// CHILD MODE — lane 4 forks THIS FILE so the verification cannot be served by a warm cache.
// =========================================================================================
if (process.argv[2] === '--verify-child') {
  const [, , , dumpPath, storeDir, forkArg, dataDir] = process.argv
  try {
    // 1. the tool's own gate, in a process that has never held any of these cores open. It
    //    writes the receipt that swapCore refuses to run without. `dataDir` is required: the
    //    gate re-walks the LIVE bee and compares it to the shadow, so that a dump which is
    //    self-consistent but SHORT — the one input every other check is measured against —
    //    cannot pass. swapCore refuses a receipt that skipped that compare.
    const v = await verifyShadow({ dumpPath, storeDir, dataDir, expect: { fork: Number(forkArg) } })

    // 2. an INDEPENDENT both-directions comparison. verifyShadow already claims this, and a
    //    gate that only re-reads the implementation's own claim is not a gate.
    const want = new Map()
    const rl = readline.createInterface({ input: fs.createReadStream(dumpPath), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line) continue
      const rec = JSON.parse(line)
      want.set(b4a.toString(b4a.from(rec.k, 'base64'), 'hex'), b4a.toString(b4a.from(rec.v, 'base64'), 'hex'))
    }
    const store = new Corestore(storeDir); await store.ready()
    const core = store.get({ key: b4a.from(v.keyHex, 'hex'), writable: false }); await core.ready()
    const db = new Hyperbee(core, { keyEncoding: 'binary', valueEncoding: 'binary' }); await db.ready()
    let seen = 0; let extra = 0; let differing = 0
    for await (const node of db.createReadStream()) {
      seen++
      const kHex = b4a.toString(node.key, 'hex')
      if (!want.has(kHex)) { extra++; continue }
      if (want.get(kHex) !== b4a.toString(node.value, 'hex')) differing++
      want.delete(kHex)
    }
    const missing = want.size
    await store.close()
    const ok = extra === 0 && differing === 0 && missing === 0 && seen === v.keyCount
    process.stdout.write('CHILD ' + JSON.stringify({
      ok, seen, missing, extra, differing, fork: v.fork, length: v.length, keyHex: v.keyHex, receiptPath: v.receiptPath
    }) + '\n')
    process.exit(ok ? 0 : 1)
  } catch (err) {
    process.stdout.write('CHILD-ERROR ' + (err.stack || err.message) + '\n')
    process.exit(1)
  }
}

// =========================================================================================
// SCALE
// =========================================================================================
// Production ground truth, measured on the SolTV panel bee (2026-08-16):
//   fork 0 · length 70,137 · byteLength 13,729,968,101 · contiguousLength 70,137
//   ~2,730 live keys  ->  ~67,400 dead blocks, ~195.7 KB average block, ratio 25.7:1
// The dead blocks are overwhelmingly FAT ones: deleteStream (panel/src/ops.js:538-559) walks
// every user and rewrites their whole ~455 KB sealed-grant map once per removed channel, so
// the amplification is O(users x ids) at ~455 KB a go.
//
// This test keeps the SHAPE exactly — 2,700 `catalog/*` records of ~700 B, 10 `user/*`
// records each carrying a real ~455 KB sealed-grant map, plus the meta/, catmeta/ and
// svcmeta/ prefixes — and scales only the CHURN COUNT. Reproducing 25.7:1 at the production
// block size means writing 13.7 GB, which no CI lane can afford; SCALE 1 buys ~6:1 for
// ~55 MB in ~20 s, and the warm client below mirrors all of it. Nothing in the mechanism
// under test depends on the exact ratio, only on there being far more blocks than live keys.
// PANEL_COMPACT_TEST_SCALE=4 walks it back toward production (~4x the churn and the bytes).
const SCALE = Math.max(1, Number(process.env.PANEL_COMPACT_TEST_SCALE || 1))
const CATALOG_RECORDS = 2700 // production: ~2,700 catalog/* records
const FAT_USERS = 10 // production: ~10 accounts
const GRANTS_PER_USER = 2700 // one sealed grant per channel -> ~455 KB of JSON per user
const FAT_CHURN_ROUNDS = Math.round(8 * SCALE) // stands in for ~6,740 deleteStream passes
const CATALOG_CHURN_ROUNDS = Math.round(5 * SCALE) // liveness/EN VIVO heartbeats rewriting catalog/*
// Lane 8 is a self-contained fixture and only has to reach a length a stale client can
// compare against, so it runs at a fraction of the above.
const CONFLICT_CATALOG = 300
const CONFLICT_CHURN = 3

const dirs = {
  panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2epc-panel-')),
  work: fs.mkdtempSync(path.join(os.tmpdir(), 'e2epc-work-')), // dumps, shadows, rollback — never inside DATA_DIR
  warm: fs.mkdtempSync(path.join(os.tmpdir(), 'e2epc-warm-')),
  cold: fs.mkdtempSync(path.join(os.tmpdir(), 'e2epc-cold-'))
}
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

// --- measurement --------------------------------------------------------------------------

// The `data` file is the whole point of the exercise: it is what `df` filled up. Apparent
// size is exact on every platform; ALLOCATED bytes (st.blocks*512, what core.info({storage})
// reports as storage.blocks) are the truth on a filesystem that can punch holes and are
// quantised nonsense on one that cannot — hence probeAllocationVisible() below.
function dataFile (storeDir, publicKey) {
  const p = path.join(coreDirFor(storeDir, publicKey), 'data')
  try { const st = fs.statSync(p); return { size: st.size, alloc: typeof st.blocks === 'number' ? st.blocks * 512 : null } } catch { return { size: 0, alloc: null } }
}

// Same shape as the EPG reclaim test's probePunch: measure a throwaway core before asserting
// anything about allocation, because a filesystem that cannot show a reclaim cannot show its
// absence either — and lane 9 asserts an ABSENCE.
async function probeAllocationVisible () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2epc-probe-'))
  try {
    const store = new Corestore(dir); await store.ready()
    const core = store.get({ name: 'probe' }); await core.ready()
    for (let i = 0; i < 32; i++) await core.append(b4a.alloc(64 * 1024, i))
    const before = (await core.info({ storage: true })).storage?.blocks ?? null
    await core.clear(0, 16)
    const after = (await core.info({ storage: true })).storage?.blocks ?? null
    await store.close()
    return before !== null && after !== null && after < before
  } catch { return false } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
}

// --- fixtures -----------------------------------------------------------------------------

// A catalog record of the production shape: ~700 B once JSON-encoded.
function catalogRecord (i, rev) {
  return {
    title: `Channel ${String(i).padStart(4, '0')} ` + 'T'.repeat(120),
    description: 'D'.repeat(360),
    category: ['deportes', 'nacional'],
    type: 'live',
    protection: 'self',
    feedKey: b4a.toString(b4a.alloc(32, i % 251), 'hex'),
    isLive: rev % 2 === 0,
    status: rev % 2 === 0 ? 'live' : 'idle',
    order: i,
    restricted: false
  }
}

// The record that makes the amplification matter. `wrapped` is a real sealed-grant map: one
// crypto_box_seal per channel, hex, exactly as panel/src/ops.js:141 writes it.
function fatUser (kp, auth, salt, verifier, wk, sealed, rev) {
  const wrapped = {}
  for (let i = 0; i < GRANTS_PER_USER; i++) wrapped['ch-' + String(i).padStart(4, '0') + '-hd'] = sealed[i]
  return {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(verifier, 'hex'),
    argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'),
    encPriv: wrap(wk, kp.secretKey),
    authPub: b4a.toString(auth.publicKey, 'hex'),
    authPrivEnc: wrap(wk, auth.secretKey),
    wrapped,
    manualGrants: [],
    devices: [],
    tokenVersion: 1,
    maxDevices: 3,
    status: 'active',
    rev
  }
}

const PASSWORD = 'compact-test-123'

try {
  const t0 = Date.now()
  const allocVisible = await probeAllocationVisible()
  log(`allocation (st.blocks) observable on this filesystem: ${allocVisible ? 'YES — byte assertions are hard' : 'NO — apparent file size carries the byte lanes, allocation is reported only'}`)

  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap
  log('testnet up:', JSON.stringify(bootstrap))

  // =======================================================================================
  // 1. SEED a synthetic bee of the production SHAPE
  // =======================================================================================
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const panelKeyHex = b4a.toString(keys.signing.publicKey, 'hex')
  let { store: panelStore, db } = await openStore(dirs.panel, keys)
  const topic = hcrypto.hash(keys.signing.publicKey)

  const tSeed = Date.now()
  const catBatch = db.batch()
  for (let i = 0; i < CATALOG_RECORDS; i++) await catBatch.put('catalog/ch-' + String(i).padStart(4, '0') + '-hd', catalogRecord(i, 0))
  await catBatch.flush()

  // Category + service vocabulary, so the key-prefix mix the dump walks is the real one.
  // ORDERING (panel/src/ops.js:1027): 'catalog/' < 'catmeta/' < 'meta/' < 'svcmeta/' < 'user/'.
  const metaBatch = db.batch()
  for (const slug of ['deportes', 'nacional', 'peliculas', 'infantil', 'noticias']) {
    await metaBatch.put('catmeta/' + slug, { label: slug, parent: null, order: null, hidden: false, ownedBy: 'operator' })
  }
  await metaBatch.put('svcmeta/vod', { enabled: true, apiBase: 'https://vod.example', service: 'x', sources: {}, params: {} })
  await metaBatch.flush()

  // 10 accounts, each with a REAL sealed-grant map. The login lane below opens 2,700 of these
  // seals for real, so they are genuine crypto_box_seal output, not filler.
  const accounts = []
  for (let u = 0; u < FAT_USERS; u++) {
    const rwd = evaluateFull(keys.oprf, PASSWORD)
    const salt = randomSalt()
    const kp = userKeyPair(); const auth = authKeyPair(); const wk = wrapKeyFrom(rwd)
    const verifier = deriveVerifier(rwd, salt, ARGON2_DEFAULT)
    const sealed = new Array(GRANTS_PER_USER)
    for (let i = 0; i < GRANTS_PER_USER; i++) sealed[i] = sealTo(kp.publicKey, b4a.alloc(32, i % 251))
    accounts.push({ name: 'u' + u, kp, auth, salt, verifier, wk, sealed })
    await db.put('user/u' + u, fatUser(kp, auth, salt, verifier, wk, sealed, 0))
  }
  const fatBytes = JSON.stringify(fatUser(accounts[0].kp, accounts[0].auth, accounts[0].salt, accounts[0].verifier, accounts[0].wk, accounts[0].sealed, 0)).length
  log(`seeded in ${Date.now() - tSeed} ms: ${CATALOG_RECORDS} catalog/, ${FAT_USERS} user/ (${(fatBytes / 1024).toFixed(0)} KB of sealed grants each), catmeta/, svcmeta/, meta/`)

  // =======================================================================================
  // 2. CHURN — make core.length >> live key count, exactly the way production did
  // =======================================================================================
  const tChurn = Date.now()
  for (let r = 1; r <= FAT_CHURN_ROUNDS; r++) {
    // One deleteStream pass: every account's whole grant map rewritten, ~455 KB each.
    for (const a of accounts) await db.put('user/' + a.name, fatUser(a.kp, a.auth, a.salt, a.verifier, a.wk, a.sealed, r))
  }
  for (let r = 1; r <= CATALOG_CHURN_ROUNDS; r++) {
    for (let i = 0; i < CATALOG_RECORDS; i++) await db.put('catalog/ch-' + String(i).padStart(4, '0') + '-hd', catalogRecord(i, r))
  }
  let liveKeys = 0
  for await (const _ of db.createReadStream()) liveKeys++ // eslint-disable-line
  const preLength = db.core.length
  const preFork = db.core.fork
  const preByteLength = db.core.byteLength
  const preContiguous = db.core.contiguousLength
  const preStorage = (await db.core.info({ storage: true })).storage
  const preData = dataFile(dirs.panel, keys.signing.publicKey)
  log(`churned in ${Date.now() - tChurn} ms: fork ${preFork}, length ${preLength}, byteLength ${fmt(preByteLength)}, data file ${fmt(preData.size)} (alloc ${fmt(preData.alloc)})`)
  log(`  live keys ${liveKeys} -> ${preLength - liveKeys} dead blocks, ratio ${(preLength / liveKeys).toFixed(1)}:1 (production 25.7:1)`)

  assert.ok(preLength > liveKeys * 3,
    `EXPECTED core.length far greater than the live key count (the whole premise of compaction); OBSERVED length ${preLength} vs ${liveKeys} live keys, ratio ${(preLength / liveKeys).toFixed(1)}:1. ` +
    'IMPLICATION: this fixture is not exercising the amplification the tool exists to undo — raise FAT_CHURN_ROUNDS/CATALOG_CHURN_ROUNDS.')
  assert.strictEqual(preFork, 0,
    `EXPECTED a never-forked bee (production is at fork 0); OBSERVED fork ${preFork}. IMPLICATION: the fork+1 arithmetic below is calibrated on this, re-check it.`)
  assert.strictEqual(preContiguous, preLength,
    `EXPECTED the writer's own core to be fully contiguous; OBSERVED contiguousLength ${preContiguous} of length ${preLength}. IMPLICATION: dumpBee refuses a non-contiguous core, and rightly so — this store is damaged.`)

  // =======================================================================================
  // 3. WARM CLIENT — a full mirror of the PRE-rebuild bee, armed before anything moves
  // =======================================================================================
  // Deliberately a full mirror (a repeater, not a sparse TV): only a client that actually
  // holds the old tree can prove it survives the fork — or, in lane 8, detect a conflict.
  // The panel swarm gets a FIXED identity so the client can be told to re-dial exactly it
  // after the restart, instead of waiting on DHT rediscovery (flaky, and not what is
  // under test here).
  const panelSwarmKeyPair = hcrypto.keyPair()
  const throttle = makeThrottle(1000, 60)
  let panelSwarm = null
  const startPanelSwarm = async () => {
    panelSwarm = new Hyperswarm({ bootstrap, keyPair: panelSwarmKeyPair })
    panelSwarm.on('connection', (s) => {
      panelStore.replicate(s)
      attachLoginRpc(s, { keys, difficulty: 8, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000 })
    })
    panelSwarm.join(topic, { server: true, client: false })
    await panelSwarm.flush()
  }
  await startPanelSwarm()
  cleanups.push(() => panelSwarm && panelSwarm.destroy())

  const warmStore = new Corestore(dirs.warm); await warmStore.ready(); cleanups.push(() => warmStore.close())
  const warmCore = warmStore.get({ key: keys.signing.publicKey }); await warmCore.ready()
  const warmDb = new Hyperbee(warmCore, { keyEncoding: 'utf-8', valueEncoding: 'json' }); await warmDb.ready()
  // Stream errors are counted per CONNECTION GENERATION. The pre-swap connection is expected
  // to die — the panel is stopped for the maintenance window, and that is connection churn,
  // not a reorg failure. Only the connection the client reorgs over has to stay clean.
  let panelStopped = false
  const preSwapStreamErrors = []
  const postSwapStreamErrors = []
  let call = null
  const warmSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => warmSwarm.destroy())
  warmSwarm.on('connection', (s) => {
    const bucket = panelStopped ? postSwapStreamErrors : preSwapStreamErrors
    s.on('error', (e) => { bucket.push(e.code || e.message) })
    warmStore.replicate(s)
    if (!call) call = panelClient(s).call
  })
  warmSwarm.join(topic, { client: true, server: false })

  const tWarm = Date.now()
  await waitFor(() => warmDb.get('user/u0'), 60000, 'warm client replicates the pre-rebuild bee')
  await warmCore.update({ wait: true })
  await warmCore.download({ start: 0, end: warmCore.length }).done()
  const warmFatBefore = await warmDb.get('user/u3')
  assert.ok(warmFatBefore && Object.keys(warmFatBefore.value.wrapped).length === GRANTS_PER_USER,
    `EXPECTED the warm client to hold a whole ${(fatBytes / 1024).toFixed(0)} KB user record before the swap; OBSERVED ${warmFatBefore ? Object.keys(warmFatBefore.value.wrapped).length : 'no'} grants. IMPLICATION: it is not warm, so nothing it does across the swap proves anything.`)
  assert.strictEqual(warmCore.contiguousLength, warmCore.length,
    `EXPECTED the warm mirror to hold every block of the pre-rebuild core; OBSERVED contiguousLength ${warmCore.contiguousLength} of length ${warmCore.length}. IMPLICATION: the fork-0 tree it is about to be asked to survive is incomplete.`)
  assert.strictEqual(warmCore.fork, 0, `EXPECTED the warm client at fork 0; OBSERVED ${warmCore.fork}.`)
  log(`warm client: mirrored ${warmCore.length} blocks (${fmt(warmCore.byteLength)}) in ${Date.now() - tWarm} ms, contiguous, fork ${warmCore.fork}`)

  // Arm everything that has to survive the swap BEFORE the swap.
  let conflicts = 0
  warmCore.on('conflict', (len, f) => { conflicts++; log(`  !! warm client conflict at length ${len}, fork ${f}`) })
  const entryWatcher = await warmDb.getAndWatch('catalog/ch-0007-hd')
  let entryUpdates = 0
  entryWatcher.on('update', () => { entryUpdates++ })
  // The differ is instrumented rather than merely watched, so lane 5g reports WHY it wedges
  // (which versions it was handed) instead of only that it did.
  const differCalls = []
  const rangeWatcher = warmDb.watch({ gt: 'catalog/', lt: 'catalog0' }, {
    differ: (current, previous, range) => {
      differCalls.push({ currentVersion: current.version, previousVersion: previous.version, coreLength: current.core.length, currentFork: current.core.fork, previousFork: previous.core.fork })
      return current.createDiffStream(previous, range)
    }
  })
  await rangeWatcher.ready()
  const preArmedRangeNext = rangeWatcher.next().then(() => 'YIELDED').catch((e) => 'REJECTED ' + (e.code || e.message))
  log('armed before the swap: conflict listener, getAndWatch(catalog/ch-0007-hd), watch({gt:catalog/, lt:catalog0})')

  // =======================================================================================
  // 4. DUMP -> SHADOW REBUILD AT fork+1 -> VERIFY IN A SEPARATE PROCESS
  // =======================================================================================
  // The panel stops here, exactly as the runbook requires: swapCore refuses to run against a
  // live panel, and dumpBee must read a core nothing is appending to.
  const tWindow = Date.now()
  panelStopped = true
  await panelSwarm.destroy(); panelSwarm = null
  await panelStore.close()
  call = null

  const dumpPath = path.join(dirs.work, 'panel-bee.ndjson')
  const dump = await dumpBee({ dataDir: dirs.panel, publicKey: panelKeyHex, outPath: dumpPath })
  assert.strictEqual(dump.keyCount, liveKeys,
    `EXPECTED the dump to carry every live key (${liveKeys}); OBSERVED ${dump.keyCount}. IMPLICATION: the rebuilt bee would be missing records — do not swap.`)
  assert.strictEqual(dump.fork, preFork, `EXPECTED the dump to record fork ${preFork}; OBSERVED ${dump.fork}.`)
  assert.strictEqual(dump.rebuildAtFork, preFork + 1,
    `EXPECTED the tool to name fork ${preFork + 1} as the only safe rebuild target; OBSERVED ${dump.rebuildAtFork}. IMPLICATION: the operator would be handed the catastrophic value.`)
  log(`dump: ${dump.keyCount} entries, ${fmt(fs.statSync(dumpPath).size)} of NDJSON, sha256 ${dump.dumpSha256.slice(0, 16)}…`)

  // The guard that makes the whole exercise safe has to exist, so prove it refuses BOTH ways
  // an operator can get --fork wrong: the live fork (the catastrophic one, lane 8) and any
  // value above fork+1 (which would leave a gap no client can reorg across).
  const refuse = async (f, dirName) => {
    try {
      await shadowRebuild({ dumpPath, keyPair: keys.signing, storeDir: path.join(dirs.work, dirName), fork: f })
      return null
    } catch (err) { return err.message }
  }
  const refusedSameFork = await refuse(preFork, 'shadow-same-fork')
  assert.ok(refusedSameFork && refusedSameFork.includes('fork'),
    `EXPECTED shadowRebuild to REFUSE fork ${preFork} (the same fork as the live core); OBSERVED ${refusedSameFork ? 'an error that does not mention the fork: ' + refusedSameFork.slice(0, 120) : 'NO THROW — it built the core'}. ` +
    'IMPLICATION: lane 8 below shows exactly what a same-fork rebuild does to a live client; without this guard one wrong --fork on the CLI does it to the fleet.')
  const refusedFarFork = await refuse(preFork + 2, 'shadow-far-fork')
  assert.ok(refusedFarFork && refusedFarFork.includes(String(preFork + 1)),
    `EXPECTED shadowRebuild to REFUSE fork ${preFork + 2} and name ${preFork + 1} as the only safe value; OBSERVED ${refusedFarFork ? refusedFarFork.slice(0, 120) : 'NO THROW'}. ` +
    'IMPLICATION: the tool would let an operator invent a fork number, and the only correct one is not something to work out at 3am.')
  log(`guard: shadowRebuild refuses fork ${preFork} ("${refusedSameFork.split('.')[0].slice(0, 70)}…") and fork ${preFork + 2}`)

  const shadowDir = path.join(dirs.work, 'shadow')
  const rebuilt = await shadowRebuild({ dumpPath, keyPair: keys.signing, storeDir: shadowDir, fork: preFork + 1 })
  assert.strictEqual(rebuilt.fork, preFork + 1,
    `EXPECTED the shadow at fork ${preFork + 1}; OBSERVED ${rebuilt.fork}. IMPLICATION: at any other value checkConflict (hypercore/lib/core.js:841-843) stops short-circuiting and every client breaks.`)
  assert.strictEqual(rebuilt.keyHex, panelKeyHex,
    `EXPECTED the rebuilt core to carry the UNCHANGED panel public key ${panelKeyHex.slice(0, 16)}…; OBSERVED ${rebuilt.keyHex.slice(0, 16)}…. IMPLICATION: every pinned key and every outstanding session token would be void.`)
  assert.strictEqual(rebuilt.keyCount, liveKeys, `EXPECTED ${liveKeys} entries in the shadow; OBSERVED ${rebuilt.keyCount}.`)
  assert.ok(rebuilt.length < preLength / 3,
    `EXPECTED the rebuilt core to be a small fraction of ${preLength} blocks; OBSERVED ${rebuilt.length}. IMPLICATION: nothing was actually reclaimed.`)
  log(`shadow: fork ${rebuilt.fork}, length ${rebuilt.length} (was ${preLength}), byteLength ${fmt(rebuilt.byteLength)} (was ${fmt(preByteLength)})`)

  // --- lane 4: verification in a process with no warm cache --------------------------------
  const child = await new Promise((resolve) => {
    const c = forkChild(SELF, ['--verify-child', dumpPath, shadowDir, String(preFork + 1), dirs.panel], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { out += d })
    c.on('exit', (code) => resolve({ code, out }))
  })
  assert.strictEqual(child.code, 0,
    `EXPECTED the cold verification child to exit 0; OBSERVED exit ${child.code}. IMPLICATION: the rebuilt core does not match the dump — do NOT swap. Child output:\n${child.out}`)
  const childLine = child.out.split('\n').find((l) => l.startsWith('CHILD '))
  const childResult = JSON.parse(childLine.slice('CHILD '.length))
  assert.ok(childResult.ok && childResult.missing === 0 && childResult.extra === 0 && childResult.differing === 0,
    `EXPECTED a cold reopen to find every key byte-identical in both directions; OBSERVED ${JSON.stringify(childResult)}. IMPLICATION: records were lost, invented or corrupted by the replay.`)
  assert.strictEqual(childResult.seen, liveKeys, `EXPECTED the child to walk ${liveKeys} entries; OBSERVED ${childResult.seen}.`)
  log(`verify (pid-separate, cold store): ${childResult.seen} entries, 0 missing, 0 extra, 0 differing; receipt written`)

  // =======================================================================================
  // 5. SWAP and bring the panel back
  // =======================================================================================
  const rollbackDir = path.join(dirs.work, 'rollback')
  const swap = await swapCore({ dataDir: dirs.panel, shadowStoreDir: shadowDir, rollbackDir, confirm: true })
  assert.strictEqual(swap.fork, preFork + 1, `EXPECTED the installed core at fork ${preFork + 1}; OBSERVED ${swap.fork}.`)
  assert.ok(fs.existsSync(swap.movedLiveTo),
    `EXPECTED the pre-swap core preserved at ${swap.movedLiveTo}; OBSERVED it missing. IMPLICATION: there is no rollback and no peer to restore from.`)

  const reopened = await openStore(dirs.panel, keys)
  panelStore = reopened.store; db = reopened.db
  cleanups.push(() => panelStore.close())
  await startPanelSwarm()
  const postData = dataFile(dirs.panel, keys.signing.publicKey)
  const postStorage = (await db.core.info({ storage: true })).storage
  const windowMs = Date.now() - tWindow
  assert.strictEqual(db.core.fork, preFork + 1, `EXPECTED the panel to come back at fork ${preFork + 1}; OBSERVED ${db.core.fork}.`)
  assert.ok(b4a.equals(db.core.key, keys.signing.publicKey),
    'EXPECTED the panel key unchanged across the swap; OBSERVED a different key. IMPLICATION: every client pin is dead.')
  log(`SWAP done (window ${(windowMs / 1000).toFixed(1)} s): panel at fork ${db.core.fork}, length ${db.core.length}, data file ${fmt(postData.size)} (was ${fmt(preData.size)})`)

  // Deterministic re-dial: the swarm identity survived the restart on purpose (see above).
  warmSwarm.joinPeer(panelSwarmKeyPair.publicKey)

  // --- 5a. it converges, with NO purge and NO store deletion -------------------------------
  await waitFor(() => warmCore.fork === preFork + 1 && warmCore.length === rebuilt.length, 120000,
    'warm client converges to fork+1 with no manual purge')
  const contiguousRightAfterReorg = warmCore.contiguousLength
  assert.strictEqual(warmCore.fork, preFork + 1,
    `EXPECTED the warm client to reorg to fork ${preFork + 1} on its own; OBSERVED fork ${warmCore.fork}. IMPLICATION: a TV that was online across the swap is stuck on a dead tree.`)
  assert.ok(b4a.equals(warmCore.key, keys.signing.publicKey),
    'EXPECTED the warm client to still be on the same key; OBSERVED otherwise.')

  // --- 5b. ZERO conflicts ------------------------------------------------------------------
  assert.strictEqual(conflicts, 0,
    `EXPECTED zero 'conflict' events on a client that held the whole fork-0 tree; OBSERVED ${conflicts}. ` +
    'IMPLICATION: hypercore has closed every session on that client (hypercore/index.js:626-632) and it does not recover — this is the unrecoverable case, do not ship.')

  // --- 5c. the session stayed open and the replication stream did not error -----------------
  assert.strictEqual(warmCore.closed, false,
    'EXPECTED the warm client core still open after the reorg; OBSERVED closed. IMPLICATION: _closeAllSessions ran — the client is dead until the app restarts.')
  assert.strictEqual(warmDb.core.closed, false, 'EXPECTED the warm hyperbee session still open; OBSERVED closed.')
  assert.strictEqual(postSwapStreamErrors.length, 0,
    `EXPECTED the connection the client reorgs over to stay clean; OBSERVED ${postSwapStreamErrors.length} error(s): ${JSON.stringify(postSwapStreamErrors)}. ` +
    'IMPLICATION: the reorg is being carried by connection churn rather than by hypercore reorg path, so a client that keeps its connection would NOT recover.')
  log(`replication streams: ${preSwapStreamErrors.length} error(s) on the pre-swap connection (expected — the panel was stopped: ${JSON.stringify(preSwapStreamErrors)}), ${postSwapStreamErrors.length} on the post-swap one`)

  // --- 5d. every live key reads back correctly ---------------------------------------------
  const tRead = Date.now()
  let mismatches = 0; let missingOnWarm = 0
  const rl = readline.createInterface({ input: fs.createReadStream(dumpPath), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    const rec = JSON.parse(line)
    const key = b4a.toString(b4a.from(rec.k, 'base64'), 'utf-8')
    const node = await warmDb.get(key)
    if (!node) { missingOnWarm++; continue }
    if (b4a.toString(b4a.from(JSON.stringify(node.value)), 'hex') !== b4a.toString(b4a.from(rec.v, 'base64'), 'hex')) mismatches++
  }
  assert.strictEqual(missingOnWarm, 0,
    `EXPECTED all ${liveKeys} live keys readable on the warm client after the fork; OBSERVED ${missingOnWarm} missing. IMPLICATION: channels or accounts vanish for every already-running client.`)
  assert.strictEqual(mismatches, 0,
    `EXPECTED every value byte-identical to the dump; OBSERVED ${mismatches} differing. IMPLICATION: the reorg served stale or corrupted blocks.`)
  log(`warm client: converged to fork ${warmCore.fork}, read all ${liveKeys} keys in ${Date.now() - tRead} ms, 0 conflicts, session open`)

  // --- 5e. contiguity: measured, because a mirror that goes non-contiguous stops seeding ----
  // FINDING: the reorg collapses contiguousLength (hypercore truncates to the shared prefix
  // and re-appends), so a mirror stops advertising the core to cold peers until it refetches.
  // It recovers only when something actually downloads the new blocks.
  assert.ok(contiguousRightAfterReorg < rebuilt.length,
    `EXPECTED (from the measurement this lane locks in) contiguousLength to COLLAPSE at the reorg; OBSERVED ${contiguousRightAfterReorg} of ${rebuilt.length} — i.e. it stayed contiguous. ` +
    'IMPLICATION: good news, but it contradicts what this test was calibrated against; re-read the rollout note about mirrors going quiet before you trust it.')
  await warmCore.download({ start: 0, end: warmCore.length }).done()
  assert.strictEqual(warmCore.contiguousLength, warmCore.length,
    `EXPECTED a mirror to be fully contiguous again once it refetches; OBSERVED contiguousLength ${warmCore.contiguousLength} of length ${warmCore.length}. ` +
    'IMPLICATION: the mirror never starts seeding the compacted core again and cold clients have only the panel to bootstrap from.')
  log(`warm client contiguity: ${contiguousRightAfterReorg}/${rebuilt.length} immediately after the reorg -> ${warmCore.contiguousLength}/${warmCore.length} after refetching`)

  // --- 5f. a pre-armed ENTRY watcher survives the fork --------------------------------------
  const entryBefore = entryUpdates
  await db.put('catalog/ch-0007-hd', { ...catalogRecord(7, 99), title: 'POST-FORK' })
  await waitFor(() => entryUpdates > entryBefore && entryWatcher.node && entryWatcher.node.value.title === 'POST-FORK', 60000,
    'pre-armed getAndWatch sees a post-fork put')
  assert.strictEqual(entryWatcher.node.value.title, 'POST-FORK',
    `EXPECTED the pre-armed entry watcher to deliver the post-fork value; OBSERVED ${JSON.stringify(entryWatcher.node && entryWatcher.node.value.title)}. IMPLICATION: per-record subscriptions go stale across the swap.`)
  log('pre-armed getAndWatch(): survived the fork and delivered a post-fork put')

  // --- 5g. a pre-armed RANGE watcher does NOT survive — the falsified premise ---------------
  // hyperbee/index.js:1573 reads `this.current.core.fork !== this.previous.core.fork` and is
  // meant to skip the differ across a fork. hypercore's fork getter (index.js:588-590) returns
  // `this.core.tree.fork` — the LIVE core — for a snapshot session too, so by the time the
  // watcher is woken by the truncate BOTH sides read the NEW fork, the check never fires, and
  // the differ is entered once against a checkout at the pre-fork version whose blocks no
  // longer exist. next() then never resolves and never rejects. Measured, repeatedly.
  const preArmedRange = await Promise.race([preArmedRangeNext, sleep(20000).then(() => 'WEDGED')])
  assert.strictEqual(preArmedRange, 'WEDGED',
    `EXPECTED (measured, hyperbee 2.27.3 + hypercore 10.38.2) a pre-armed db.watch(range) to WEDGE across the fork — next() neither resolving nor rejecting; OBSERVED "${preArmedRange}". ` +
    'IMPLICATION: if this now yields, the library has been fixed and the rollout no longer needs the restart step — delete this assertion and the warning at the end of this file, deliberately. ' +
    'If it REJECTED instead, the wedge became a throw and every watch() call site needs an error path rather than a restart.')
  assert.strictEqual(differCalls.length, 1,
    `EXPECTED the differ to be entered exactly once and then block (that IS the wedge); OBSERVED ${differCalls.length} call(s): ${JSON.stringify(differCalls)}. ` +
    'IMPLICATION: the failure mode has changed shape — re-derive it before trusting the rollout note at the end of this file.')
  const dc = differCalls[0]
  assert.strictEqual(dc.currentFork, dc.previousFork,
    `EXPECTED both sides of hyperbee's fork check to read the SAME (new) fork, which is why it never fires; OBSERVED current ${dc.currentFork} vs previous ${dc.previousFork}. IMPLICATION: the check CAN see the difference now — re-read hyperbee/index.js:1573.`)
  log(`pre-armed db.watch(range): ${preArmedRange} — differ entered once with previousVersion ${dc.previousVersion} against a core of length ${dc.coreLength}, both sides reading fork ${dc.currentFork}, so hyperbee/index.js:1573 never fired`)

  // The mitigation, and the only reason this is survivable: a watcher armed AFTER the fork is
  // healthy. That is what a client restart — or a re-arm on core.on('truncate') — buys.
  const rearmed = warmDb.watch({ gt: 'catalog/', lt: 'catalog0' })
  await rearmed.ready()
  const rearmedNext = rearmed.next().then(() => 'YIELDED').catch((e) => 'REJECTED ' + (e.code || e.message))
  await sleep(250)
  await db.put('catalog/ch-0008-hd', { ...catalogRecord(8, 99), title: 'POST-FORK-2' })
  const rearmedOutcome = await Promise.race([rearmedNext, sleep(60000).then(() => 'WEDGED')])
  assert.strictEqual(rearmedOutcome, 'YIELDED',
    `EXPECTED a range watcher armed AFTER the fork to yield on a subsequent put; OBSERVED "${rearmedOutcome}". ` +
    'IMPLICATION: the wedge is not recoverable by restarting the watcher either, so the compaction cannot be shipped to clients that use bee.watch(range) at all.')
  log('re-armed db.watch(range) after the fork: yields normally — restarting the watcher is the mitigation')
  await rearmed.close()
  await rangeWatcher.close().catch(() => {})

  // =======================================================================================
  // 6. COLD CLIENT — a brand new empty store bootstraps from the forked panel
  // =======================================================================================
  const coldStore = new Corestore(dirs.cold); await coldStore.ready(); cleanups.push(() => coldStore.close())
  const coldCore = coldStore.get({ key: keys.signing.publicKey }); await coldCore.ready()
  const coldDb = new Hyperbee(coldCore, { keyEncoding: 'utf-8', valueEncoding: 'json' }); await coldDb.ready()
  const coldSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => coldSwarm.destroy())
  coldSwarm.on('connection', (s) => coldStore.replicate(s))
  coldSwarm.join(topic, { client: true, server: false })
  const tCold = Date.now()
  await waitFor(() => coldDb.get('user/u0'), 90000, 'COLD client bootstraps from the forked panel')
  let coldMissing = 0
  const rl2 = readline.createInterface({ input: fs.createReadStream(dumpPath), crlfDelay: Infinity })
  for await (const line of rl2) {
    if (!line) continue
    const key = b4a.toString(b4a.from(JSON.parse(line).k, 'base64'), 'utf-8')
    if (!(await coldDb.get(key))) coldMissing++
  }
  assert.strictEqual(coldCore.fork, preFork + 1,
    `EXPECTED a cold client to land directly on fork ${preFork + 1}; OBSERVED ${coldCore.fork}. IMPLICATION: a fresh install would sync a tree that no longer exists.`)
  assert.strictEqual(coldMissing, 0,
    `EXPECTED a cold bootstrap to read every one of the ${liveKeys} live keys; OBSERVED ${coldMissing} missing. IMPLICATION: a newly installed TV would show an incomplete catalog.`)
  log(`cold client: bootstrapped ${liveKeys} keys at fork ${coldCore.fork} in ${Date.now() - tCold} ms from an empty store`)

  // =======================================================================================
  // 7. LOGIN across the fork — the panel key, and every outstanding token, survive
  // =======================================================================================
  await waitFor(() => call, 60000, 'panel RPC connection after the swap')
  const acct = accounts[0]
  const session = await login(call, warmDb, acct.name, PASSWORD, { deviceId: 'compact-test', deviceLabel: 'compact-test', catalogWaitMs: 120000 })
  assert.ok(session.token, 'EXPECTED a panel-signed session token after the fork; OBSERVED none. IMPLICATION: nobody can log in after the swap.')
  const payload = verifyToken(warmDb.core.key, session.token)
  assert.ok(payload,
    'EXPECTED verifyToken(db.core.key, token) to pass — the replicated core key IS the panel signing key; OBSERVED a rejection. IMPLICATION: the swap changed the signing identity and every device is logged out.')
  assert.strictEqual(payload.userId, acct.name, `EXPECTED the token to name ${acct.name}; OBSERVED ${payload.userId}.`)
  assert.strictEqual(session.streams.length, GRANTS_PER_USER,
    `EXPECTED all ${GRANTS_PER_USER} sealed grants to open and resolve against the compacted catalog; OBSERVED ${session.streams.length}. IMPLICATION: viewers lose channels at the first login after the swap.`)
  // The point of the whole exercise: a token minted BEFORE the rebuild still verifies against
  // the post-rebuild core key, because the key never moved.
  const preSwapToken = session.token
  assert.ok(verifyToken(db.core.key, preSwapToken),
    'EXPECTED the panel\'s own post-swap core key to verify the token; OBSERVED a rejection. IMPLICATION: the fork bumped the signing identity, which it must never do.')
  log(`login: ${acct.name} authenticated after the fork, ${session.streams.length} streams resolved, token verifies against the UNCHANGED panel key`)

  // =======================================================================================
  // 8. DELIBERATE FAILURE LANE — a SAME-fork rebuild really does conflict
  // =======================================================================================
  // Self-contained (own keys, own dirs, a fraction of the scale) so it cannot poison the
  // lanes above — a conflict permanently closes every session on the client it hits. It is
  // built and swapped BY HAND: panel-compact.mjs cannot be made to do this (shadowRebuild
  // refuses the fork, verifyShadow refuses to bless it, swapCore refuses to run without that
  // blessing), and proving the guards are load-bearing means going around all three.
  log('\n--- lane 8: proving the fork bump is NECESSARY ---')
  const cDirs = {
    panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2epc-cfl-panel-')),
    shadow: fs.mkdtempSync(path.join(os.tmpdir(), 'e2epc-cfl-shadow-')),
    cli: fs.mkdtempSync(path.join(os.tmpdir(), 'e2epc-cfl-cli-'))
  }
  for (const d of Object.values(cDirs)) cleanups.push(() => { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} })
  initKeys(cDirs.panel)
  const cKeys = openKeys(cDirs.panel)
  const cTopic = hcrypto.hash(cKeys.signing.publicKey)
  const cSwarmKeyPair = hcrypto.keyPair()
  let { store: cStore, db: cDb } = await openStore(cDirs.panel, cKeys)
  const cSeed = cDb.batch()
  for (let i = 0; i < CONFLICT_CATALOG; i++) await cSeed.put('catalog/c' + String(i).padStart(4, '0'), catalogRecord(i, 0))
  await cSeed.flush()
  for (let r = 1; r <= CONFLICT_CHURN; r++) for (let i = 0; i < CONFLICT_CATALOG; i++) await cDb.put('catalog/c' + String(i).padStart(4, '0'), catalogRecord(i, r))
  const cLive = []
  for await (const n of cDb.createReadStream()) cLive.push([n.key, n.value])
  const cPreLength = cDb.core.length

  let cSwarm = new Hyperswarm({ bootstrap, keyPair: cSwarmKeyPair })
  cSwarm.on('connection', (s) => cStore.replicate(s))
  cSwarm.join(cTopic, { server: true, client: false }); await cSwarm.flush()
  cleanups.push(() => cSwarm && cSwarm.destroy())

  const staleStore = new Corestore(cDirs.cli); await staleStore.ready(); cleanups.push(() => staleStore.close())
  const staleCore = staleStore.get({ key: cKeys.signing.publicKey }); await staleCore.ready()
  const staleDb = new Hyperbee(staleCore, { keyEncoding: 'utf-8', valueEncoding: 'json' }); await staleDb.ready()
  const staleSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => staleSwarm.destroy())
  staleSwarm.on('connection', (s) => staleStore.replicate(s))
  staleSwarm.join(cTopic, { client: true, server: false })
  await waitFor(() => staleDb.get('catalog/c0100'), 60000, 'stale client replicates the fork-0 bee')
  await staleCore.update({ wait: true })
  await staleCore.download({ start: 0, end: staleCore.length }).done()
  assert.strictEqual(staleCore.contiguousLength, staleCore.length,
    `EXPECTED the stale client to hold the whole fork-0 tree before the same-fork swap; OBSERVED ${staleCore.contiguousLength} of ${staleCore.length}. ` +
    'IMPLICATION: it could not detect a divergence it never downloaded, and a negative result below would prove nothing.')
  let staleConflicts = 0; let staleConflictDetail = null
  staleCore.on('conflict', (len, f, proof) => { staleConflicts++; staleConflictDetail = { length: len, fork: f, hasProof: !!proof } })
  log(`lane 8: stale client holds all ${staleCore.length} blocks of the fork-0 core`)

  // The catastrophic build: same keys, same live records, SAME fork.
  const cShadowStore = new Corestore(cDirs.shadow); await cShadowStore.ready()
  const cShadowCore = cShadowStore.get({ keyPair: cKeys.signing }); await cShadowCore.ready()
  const cShadowDb = new Hyperbee(cShadowCore, { keyEncoding: 'utf-8', valueEncoding: 'json' }); await cShadowDb.ready()
  const cShadowBatch = cShadowDb.batch()
  for (const [k, v] of cLive) await cShadowBatch.put(k, v)
  await cShadowBatch.flush()
  const cShadowLength = cShadowCore.length
  const cShadowFork = cShadowCore.fork
  await cShadowStore.close()
  assert.strictEqual(cShadowFork, 0,
    `EXPECTED the deliberately-wrong shadow to sit at fork 0 (the same fork as the live core); OBSERVED ${cShadowFork}. IMPLICATION: this lane is not testing what it claims to.`)

  await cSwarm.destroy(); cSwarm = null
  await cStore.close()
  const cLiveDir = coreDirFor(cDirs.panel, cKeys.signing.publicKey)
  const cShadowDir = coreDirFor(cDirs.shadow, cKeys.signing.publicKey)
  fs.rmSync(cLiveDir, { recursive: true, force: true })
  fs.renameSync(cShadowDir, cLiveDir)
  const cReopened = await openStore(cDirs.panel, cKeys)
  cStore = cReopened.store; cDb = cReopened.db
  cleanups.push(() => cStore.close())
  cSwarm = new Hyperswarm({ bootstrap, keyPair: cSwarmKeyPair })
  cSwarm.on('connection', (s) => cStore.replicate(s))
  cSwarm.join(cTopic, { server: true, client: false }); await cSwarm.flush()
  staleSwarm.joinPeer(cSwarmKeyPair.publicKey)
  log(`lane 8: swapped in a SAME-fork core (fork ${cDb.core.fork}, length ${cDb.core.length}, was ${cPreLength}) and brought the panel back`)

  let conflictFired = true
  try {
    await waitFor(() => staleConflicts > 0 || staleCore.closed, 120000, "stale client emits 'conflict'")
  } catch { conflictFired = false }
  assert.ok(staleConflicts > 0,
    `EXPECTED a stale client holding fork-0 blocks to emit 'conflict' when a SAME-fork core is swapped under it; OBSERVED ${staleConflicts} conflict events after ${conflictFired ? 'a close without one' : '120 s'} (core closed: ${staleCore.closed}). ` +
    'IMPLICATION: the safety property this whole tool is built around COULD NOT BE DEMONSTRATED here. Do not conclude the same-fork rebuild is harmless — conclude that this lane stopped reproducing it, ' +
    'and fix the lane (the stale client must hold the whole old tree, and the swapped-in core must reach a length it can compare against) before anyone is allowed to "simplify" the fork bump away.')
  assert.strictEqual(staleCore.closed, true,
    `EXPECTED the conflict to close the stale client's sessions (hypercore/index.js:626-632 _closeAllSessions); OBSERVED closed=${staleCore.closed}. IMPLICATION: the conflict fired but was survivable, which changes the risk calculus — re-read it before shipping.`)
  let staleReadErr = null
  try { await staleDb.get('catalog/c0100') } catch (e) { staleReadErr = e.code || e.message }
  assert.ok(staleReadErr,
    `EXPECTED reads on the conflicted client to fail outright; OBSERVED a successful read. IMPLICATION: the client is half-dead rather than dead, which is worse to diagnose in the field.`)
  log(`lane 8: CONFLICT fired — ${JSON.stringify(staleConflictDetail)}, sessions closed, reads now fail with ${staleReadErr}`)
  log('lane 8: the fork bump is therefore NECESSARY, not decorative')

  // =======================================================================================
  // 9. REGRESSION LOCK — a bare truncate() is NOT a reclaim
  // =======================================================================================
  // Why this exists: "just truncate the core" is the obvious cheap alternative to a rebuild,
  // and it does not free the disk. hypercore's truncate rewrites the merkle tree and moves
  // the bitfield; the `data` file is append-only storage and is never rewound. Asserted on
  // the APPARENT file size (exact everywhere) and, where the filesystem can show it, on the
  // ALLOCATED bytes core.info({ storage: true }).storage.blocks reports (st.blocks*512,
  // hypercore/lib/info.js:40-52) — which is what `df` sees.
  log('\n--- lane 9: truncate alone frees nothing on the data file ---')
  const tDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2epc-trunc-'))
  cleanups.push(() => { try { fs.rmSync(tDir, { recursive: true, force: true }) } catch {} })
  const tStore = new Corestore(tDir); await tStore.ready()
  const tCore = tStore.get({ name: 'truncate-probe' }); await tCore.ready()
  for (let i = 0; i < 400; i++) await tCore.append(b4a.alloc(16 * 1024, i % 251))
  const tInfoBefore = await tCore.info({ storage: true })
  const tFileBefore = dataFile(tDir, tCore.key)
  assert.deepStrictEqual(Object.keys(tInfoBefore.storage).sort(), ['bitfield', 'blocks', 'oplog', 'tree'],
    `EXPECTED core.info({storage:true}).storage to expose { oplog, tree, blocks, bitfield }; OBSERVED ${JSON.stringify(Object.keys(tInfoBefore.storage))}. IMPLICATION: this build of hypercore reports storage differently and every byte figure in this file is measuring the wrong thing.`)
  await tCore.truncate(50)
  const tInfoAfter = await tCore.info({ storage: true })
  const tFileAfter = dataFile(tDir, tCore.key)
  assert.strictEqual(tCore.length, 50, `EXPECTED the truncate to take effect (length 50); OBSERVED ${tCore.length}.`)
  assert.strictEqual(tFileAfter.size, tFileBefore.size,
    `EXPECTED the data file to keep every byte of the 400 blocks after truncate(50); OBSERVED ${tFileBefore.size} -> ${tFileAfter.size}. ` +
    'IMPLICATION: if truncate DID rewind the data file it would be a cheaper reclaim than this whole tool — verify that claim carefully before acting on it.')
  if (allocVisible) {
    assert.strictEqual(tInfoAfter.storage.blocks, tInfoBefore.storage.blocks,
      `EXPECTED allocated data bytes UNCHANGED by truncate (it frees only the merkle tree); OBSERVED ${tInfoBefore.storage.blocks} -> ${tInfoAfter.storage.blocks}. ` +
      'IMPLICATION: in-place truncate would be a real reclaim after all, and the offline rebuild would not be needed.')
    log(`  truncate(50) of 400 blocks: data file ${tFileBefore.size} -> ${tFileAfter.size} B, allocated blocks ${tInfoBefore.storage.blocks} -> ${tInfoAfter.storage.blocks} B, tree ${tInfoBefore.storage.tree} -> ${tInfoAfter.storage.tree} B`)
  } else {
    log(`  truncate(50) of 400 blocks: data file ${tFileBefore.size} -> ${tFileAfter.size} B (hard). Allocation not observable here; reported only: blocks ${tInfoBefore.storage.blocks} -> ${tInfoAfter.storage.blocks}, tree ${tInfoBefore.storage.tree} -> ${tInfoAfter.storage.tree}`)
  }
  await tStore.close()

  // =======================================================================================
  // 10. THE SIZE COLLAPSE
  // =======================================================================================
  const collapse = preData.size / Math.max(1, postData.size)
  assert.ok(postData.size < preData.size / 3,
    `EXPECTED the compacted data file to be a small fraction of the original; OBSERVED ${preData.size} -> ${postData.size} B (${collapse.toFixed(1)}x). IMPLICATION: the rebuild reclaimed nothing worth a maintenance window.`)
  assert.ok(db.core.byteLength < preByteLength / 3,
    `EXPECTED byteLength to collapse with it; OBSERVED ${preByteLength} -> ${db.core.byteLength}.`)
  log('\n--- size collapse ---')
  log(`  core.length      ${preLength} -> ${db.core.length}   (${liveKeys} live keys)`)
  log(`  core.byteLength  ${preByteLength} B (${fmt(preByteLength)}) -> ${db.core.byteLength} B (${fmt(db.core.byteLength)})`)
  log(`  data file        ${preData.size} B (${fmt(preData.size)}) -> ${postData.size} B (${fmt(postData.size)})   ${collapse.toFixed(1)}x smaller`)
  log(`  storage.blocks   ${preStorage.blocks} -> ${postStorage.blocks}${allocVisible ? '' : '   (allocation not observable on this filesystem — reported only)'}`)
  log(`  rollback kept at ${swap.movedLiveTo}`)

  log('\n⚠  ROLLOUT NOTE, from lane 5g: a RAW hyperbee range watcher WEDGES across the fork, and')
  log('   this lane still proves it — hyperbee/index.js:1573 cannot fire, because')
  log('   hypercore/index.js:588-590 reads `fork` live off the SHARED core, so a watcher\'s two')
  log('   snapshots always report the same new number. getAndWatch() is unaffected.')
  log('   That is why core/bee-watch.js watchRange() exists: it re-arms on the core\'s own')
  log('   `truncate` event. Every range watch in this repo goes through it, so the panel, the')
  log('   repeater, the EPG service and the SDK all survive a swap WITHOUT a restart.')
  log('   Remaining exposure is anything running a build older than that helper — redeploy the')
  log('   server-side components, and expect viewer apps to need a relaunch until they update.')

  log(`\nRESULT: PASS ✅  (${liveKeys} live keys in ${preLength} blocks -> ${db.core.length} at fork ${db.core.fork}; ` +
    `${fmt(preData.size)} -> ${fmt(postData.size)} on disk; warm client reorged with 0 conflicts and its session open; ` +
    'cold client bootstrapped; login + session token verify against the unchanged panel key; ' +
    "a SAME-fork rebuild provably DOES conflict and closes the client; truncate alone reclaims nothing) in " +
    `${((Date.now() - t0) / 1000).toFixed(1)} s`)
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
