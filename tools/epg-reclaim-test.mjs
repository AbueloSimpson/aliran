// EPG byte-reclamation test — the guide drive must be a sliding WINDOW on disk, not just
// in its listing. Deterministic and local-only (a private DHT testnet, no ffmpeg, no
// public swarm).
//
// The regression this pins: epg/src/guide.js pruneOldDays called drive.del() alone.
// Hyperdrive's del touches the metadata bee and nothing else (node_modules/hyperdrive/
// index.js:311-315), so every day that rotated out of the 7-day window left its blob
// bytes in the blobs core FOREVER. On the SolTV deployment that grew a ~2.9 GB EPG drive
// of which roughly 2 GB was dead — and it filled the disk. putDay had the same hole from
// the other side: a day whose schedule genuinely changed stranded the superseded
// revision. The panel (panel/src/ops.js:626-649) and the broadcaster
// (broadcaster/src/hls.js:848-858) both state the rule; the EPG was the one place that
// missed it.
//
// Entry counts cannot prove any of this — they go to zero either way. So the assertions
// here are on ALLOCATED bytes, read through core.info({ storage: true }) (st.blocks*512,
// hypercore/lib/info.js:40-52). Blob `data` files are SPARSE: their apparent size never
// shrinks, so ls/stat().size lies and only the allocation is truth. A filesystem that
// cannot punch holes cannot show the reclaim at all, so the byte assertions are gated by
// a capability probe that measures a throwaway core first — the same shape as the
// viewer's hole-punch probe.
//
// Also covered: the latent orphan-EPOCH case. _mintEpoch built `prev` from the live epoch
// and DISCARDED whatever was already there, so a purge that failed — or a service down
// across a rotation boundary — left a whole drive on disk that nothing in epoch.json
// named and no code path could ever purge.
//
// Exits 0 on PASS.
import assert from 'assert'
import os from 'os'
import fs from 'fs'
import path from 'path'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import createTestnet from 'hyperdht/testnet.js'
import { GuideManager, canonicalDayJson, utcDay } from '../epg/src/guide.js'

const log = (...a) => console.log(...a)
const KiB = 1024
const MiB = 1024 * KiB
const fmt = (n) => (n === null ? 'n/a' : (n / MiB).toFixed(2) + ' MiB')

let failures = 0
function ok (cond, msg) {
  if (cond) log('  ok  ' + msg)
  else { failures++; log('  FAIL ' + msg) }
}

// --- measurement ------------------------------------------------------------------------

// Allocated bytes of a core's block store. NOT the file size: hypercore's clear() punches
// holes, so `data` keeps its apparent length while its allocation drops.
async function allocatedBlobBytes (drive) {
  const blobs = await drive.getBlobs()
  const info = await blobs.core.info({ storage: true })
  return info.storage ? info.storage.blocks : null
}

// Blocks the core still holds, straight off the bitfield — platform-independent, and the
// fallback assertion where hole-punching is not observable.
async function heldBlocks (drive) {
  const blobs = await drive.getBlobs()
  let n = 0
  for (let i = 0; i < blobs.core.length; i++) if (await blobs.core.has(i)) n++
  return n
}

// Corestore v6 lays each core out at cores/<dk[0:2]>/<dk[2:4]>/<dk>/ keyed by DISCOVERY
// key. drive.purge() removes the directory outright, so this is how an epoch proves it is
// gone rather than merely unreferenced.
function coreDir (dataDir, publicKeyHex) {
  const dk = b4a.toString(hcrypto.discoveryKey(b4a.from(publicKeyHex, 'hex')), 'hex')
  return path.join(dataDir, 'store', 'cores', dk.slice(0, 2), dk.slice(2, 4), dk)
}

// Every core `data` file under a store, by allocation. The whole-store number — what the
// operator's `df` sees.
function storeAllocatedBytes (dataDir) {
  let total = 0
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'data') { try { const b = fs.statSync(p).blocks; if (typeof b === 'number') total += b * 512 } catch {} }
    }
  }
  walk(path.join(dataDir, 'store', 'cores'))
  return total
}

// Can this filesystem show a reclaim at all? Write a core, clear half, look at the
// allocation. Where the answer is no (no hole-punch support), the byte assertions below
// are reported instead of asserted and the bitfield ones carry the test.
async function probePunch () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epgreclaim-probe-'))
  try {
    const store = new Corestore(path.join(dir, 'store'))
    await store.ready()
    const core = store.get({ name: 'probe' })
    await core.ready()
    for (let i = 0; i < 32; i++) await core.append(Buffer.alloc(64 * KiB, i))
    const before = (await core.info({ storage: true })).storage?.blocks ?? null
    await core.clear(0, 16)
    const after = (await core.info({ storage: true })).storage?.blocks ?? null
    await store.close()
    return before !== null && after !== null && after < before
  } catch { return false } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
}

// --- fixtures ---------------------------------------------------------------------------

// A day-file big enough to span many hyperblobs blocks, so a reclaim is measurable rather
// than lost in rounding. ~500 KiB per day at the defaults below.
function fatDay (baseMs, { tag = 'A', n = 240 } = {}) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({
      title: `Program ${i}`,
      start: new Date(baseMs + i * 6 * 60000).toISOString(),
      stop: new Date(baseMs + (i + 1) * 6 * 60000).toISOString(),
      desc: tag.repeat(2 * KiB)
    })
  }
  return out
}

const dirs = []
function mkdir (prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d }
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

function guideConfig (dataDir, bootstrap, over = {}) {
  return {
    dataDir,
    panelPubKey: null, // no catalog replica: this lane is about bytes, not mapping
    epochDays: 9999, // rotation here is always explicit, never time-driven
    graceHours: 1,
    guideDays: 7,
    swarmMaxPeers: 8,
    swarmRcvBuf: 4 * MiB,
    swarmSndBuf: 4 * MiB,
    bootstrap,
    ...over
  }
}

try {
  const punch = await probePunch()
  log(`hole-punch reclaim observable on this filesystem: ${punch ? 'YES — byte assertions are hard' : 'NO — byte figures reported, bitfield assertions carry the lane'}`)

  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap

  const dirA = mkdir('epgreclaim-a-')
  const guide = await new GuideManager(guideConfig(dirA, bootstrap)).init()
  cleanups.push(() => guide.close())

  // ===== A. pruneOldDays frees the bytes, not just the entries =========================
  log('\nA. the sliding window slides on DISK — pruneOldDays()')
  const today = utcDay()
  const yesterday = utcDay(Date.now() - 24 * 3600 * 1000)
  const t0 = Date.parse(today)

  // Ten days that are unambiguously past the floor, plus the two the window keeps.
  const oldDays = []
  for (let i = 1; i <= 10; i++) oldDays.push(`2020-01-${String(i).padStart(2, '0')}`)
  let prunedPayload = 0
  for (const d of oldDays) {
    const programs = fatDay(Date.parse(d + 'T00:00:00.000Z'), { tag: 'A' })
    prunedPayload += canonicalDayJson(programs).length
    assert.strictEqual(await guide.putDay('news', d, programs), 'put')
  }
  for (const d of [yesterday, today]) {
    assert.strictEqual(await guide.putDay('news', d, fatDay(Date.parse(d + 'T00:00:00.000Z'), { tag: 'K' })), 'put')
  }
  const keptToday = await guide._drive.get(`/v1/news/${today}.json`)

  const beforeBytes = await allocatedBlobBytes(guide._drive)
  const beforeHeld = await heldBlocks(guide._drive)
  log(`  …  12 day-files written (${fmt(prunedPayload)} of it older than the window); blobs core allocated ${fmt(beforeBytes)}, ${beforeHeld} blocks held`)

  const dropped = await guide.pruneOldDays()
  const afterBytes = await allocatedBlobBytes(guide._drive)
  const afterHeld = await heldBlocks(guide._drive)
  const freed = beforeBytes === null ? null : beforeBytes - afterBytes
  log(`  …  pruned ${dropped} day-file(s); blobs core allocated ${fmt(afterBytes)}, ${afterHeld} blocks held  ->  FREED ${fmt(freed)}`)

  ok(dropped === oldDays.length, `every day older than ${yesterday} was dropped (${dropped})`)
  let stillListed = 0
  for await (const e of guide._drive.list('/v1', { recursive: true })) stillListed++
  ok(stillListed === 2, `only the window remains in the listing (${stillListed} entries)`)
  ok(afterHeld < beforeHeld && afterHeld > 0, `the blobs core released blocks (${beforeHeld} -> ${afterHeld})`)
  // THE regression assertion. Under the old del()-only code both of these were equal.
  if (punch) {
    ok(afterBytes < beforeBytes, `allocated bytes actually SHRANK (${fmt(beforeBytes)} -> ${fmt(afterBytes)}) — del() alone left them all`)
    ok(freed >= prunedPayload * 0.75, `the reclaim is the pruned payload, not a rounding artefact (freed ${fmt(freed)} of ${fmt(prunedPayload)} pruned)`)
  } else {
    log(`  …  (byte assertions skipped: no observable hole-punch; measured ${fmt(beforeBytes)} -> ${fmt(afterBytes)})`)
  }
  // Reclaim must not cost the served window a single byte.
  const keptAfter = await guide._drive.get(`/v1/news/${today}.json`)
  ok(keptAfter && b4a.equals(keptAfter, keptToday), 'the days still inside the window read back byte-identical')
  ok((await guide._drive.entry(`/v1/news/${oldDays[0]}.json`)) === null, 'a pruned day no longer resolves')

  // ===== B. a CHANGED day does not strand its previous revision ========================
  log('\nB. a revised day supersedes its blob — putDay()')
  const revDay = today
  const baseline = await allocatedBlobBytes(guide._drive)
  const revA = fatDay(t0, { tag: 'R' })
  assert.strictEqual(await guide.putDay('sports', revDay, revA), 'put')
  const oneRevision = (await allocatedBlobBytes(guide._drive)) - baseline
  const putsAfterFirst = guide.status().puts
  const skipsAfterFirst = guide.status().skips

  // The frugality rule the fix must not break: an unchanged day appends NOTHING.
  const quiet = await guide.putDay('sports', revDay, revA)
  const afterQuiet = await allocatedBlobBytes(guide._drive)
  ok(quiet === 'skip', 'an unchanged re-put still short-circuits to "skip"')
  ok(guide.status().puts === putsAfterFirst, 'a quiet cycle appends nothing (put counter unmoved)')
  ok(guide.status().skips === skipsAfterFirst + 1, 'a quiet cycle counts as a byte-compare skip')
  if (punch) ok(afterQuiet === baseline + oneRevision, 'a quiet cycle costs zero bytes')

  // A genuine change: the new revision lands, the old one is freed.
  const revB = fatDay(t0, { tag: 'S' })
  assert.strictEqual(await guide.putDay('sports', revDay, revB), 'put')
  const afterRevision = await allocatedBlobBytes(guide._drive)
  const growth = afterRevision - (baseline + oneRevision)
  log(`  …  one revision costs ${fmt(oneRevision)}; rewriting it grew the core by ${fmt(growth)}`)
  const served = await guide._drive.get(`/v1/sports/${revDay}.json`)
  ok(b4a.equals(served, canonicalDayJson(revB)), 'the drive serves the NEW revision')
  if (punch) {
    // Old behaviour: growth ≈ oneRevision (both copies resident). Fixed: growth ≈ 0.
    ok(growth <= oneRevision * 0.25, `the superseded revision was freed (grew ${fmt(growth)}, a stranded copy would be ~${fmt(oneRevision)})`)
  }

  // ===== C. an epoch minted out of service is never forgotten ==========================
  log('\nC. every retired epoch stays on the purge list — _mintEpoch()')
  const dirC = mkdir('epgreclaim-c-')
  let g2 = await new GuideManager(guideConfig(dirC, bootstrap)).init()
  cleanups.push(() => g2.close())
  for (const d of [yesterday, today]) await g2.putDay('news', d, fatDay(Date.parse(d + 'T00:00:00.000Z'), { tag: 'E' }))
  const e1Key = g2.driveInfo().key

  await g2.rotate() // epoch 1 -> 2; epoch 1 now grace-served
  const e2Key = g2.driveInfo().key
  ok(g2.status().prev?.epoch === 1, 'after one rotation the predecessor is epoch 1')
  ok(g2.status().pendingPurge === 1, 'one epoch is owed a purge')

  // A legacy state file (single `prev` object) must survive the upgrade — an operator who
  // restarts into this build cannot be made to forget the epoch they were grace-serving.
  // And the file must stay readable by the build being rolled BACK to, which knows only
  // `prev` and would announce an `epg-undefined` drive if handed a list.
  await g2.close()
  const statePath = path.join(dirC, 'epoch.json')
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  ok(Array.isArray(persisted.pending), 'epoch.json persists the pending list')
  ok(!!persisted.prev && !Array.isArray(persisted.prev) && persisted.prev.epoch === 1,
    'epoch.json ALSO carries `prev` as the object an older build expects (rollback stays survivable)')
  const { pending: _drop, ...legacyShape } = persisted // exactly what an older build wrote
  fs.writeFileSync(statePath, JSON.stringify(legacyShape))
  g2 = await new GuideManager(guideConfig(dirC, bootstrap)).init()
  cleanups.push(() => g2.close())
  ok(g2.status().pendingPurge === 1 && g2.status().prev?.epoch === 1, 'a single-slot `prev` from an older build migrates into the list')
  ok(g2.status().prev?.driveKey === e1Key, 'the migrated entry still names epoch 1\'s drive')

  // THE latent bug: rotate again while epoch 1 is still inside its grace window. The old
  // code overwrote `prev` here and epoch 1 became unreachable — on disk, referenced by
  // nothing, purgeable by no code path.
  const storeBeforeSecondRotation = storeAllocatedBytes(dirC)
  await g2.rotate() // epoch 2 -> 3, with epoch 1 STILL pending
  ok(g2.status().pendingPurge === 2, `both retired epochs are queued (pendingPurge ${g2.status().pendingPurge})`)
  const queued = g2._state.pending.map((p) => p.epoch)
  ok(queued.join(',') === '1,2', `the queue is oldest-first and complete (${queued.join(',')})`)
  ok(g2.status().prev?.epoch === 2, 'status still reports the grace-served predecessor under `prev`')
  ok(fs.existsSync(coreDir(dirC, e1Key)), 'epoch 1 is still on disk at this point (it is inside the grace window rules)')

  // Grace elapses for both, one maintenance tick drains the queue.
  for (const p of g2._state.pending) p.purgeAt = Date.now() - 1000
  await g2._maintain()
  const storeAfterDrain = storeAllocatedBytes(dirC)
  log(`  …  store allocated ${fmt(storeBeforeSecondRotation)} before the second rotation, ${fmt(storeAfterDrain)} after the drain`)
  ok(g2._state.pending.length === 0, 'the purge queue is empty')
  ok(g2.status().pendingPurge === 0 && g2.status().prev === null, 'status reports nothing pending')
  // Under the old code this one failed: epoch 1 had been dropped from the state at the
  // second rotation, so nothing ever purged it.
  ok(!fs.existsSync(coreDir(dirC, e1Key)), 'epoch 1 — the one a single `prev` slot used to discard — is GONE from disk')
  ok(!fs.existsSync(coreDir(dirC, e2Key)), 'epoch 2 is gone from disk')
  ok(fs.existsSync(coreDir(dirC, g2.driveInfo().key)), 'the live epoch is untouched')
  const liveDay = await g2._drive.get(`/v1/news/${today}.json`)
  ok(!!liveDay && JSON.parse(b4a.toString(liveDay)).length === 240, 'the live epoch still serves the copied guide')

  // A purge that FAILS must stay queued rather than be forgotten at the next rotation.
  // Failure shape 1: the namespace throws, i.e. BEFORE the drive is constructed.
  g2._state.pending = [{ epoch: 999, driveKey: null, purgeAt: Date.now() - 1000 }]
  const realNamespace = g2._store.namespace.bind(g2._store)
  g2._store.namespace = (n) => { if (n === 'epg-999') throw new Error('simulated purge failure'); return realNamespace(n) }
  await g2._maintain()
  g2._store.namespace = realNamespace
  ok(g2._state.pending.length === 1 && g2._state.pending[0].epoch === 999, 'a purge that throws before construction stays on the queue')

  // Failure shape 2 — the one that leaks. ready() throws with the Hyperdrive ALREADY
  // constructed, and because the entry stays queued this runs again every hour: without a
  // finally that closes it, each tick strands a drive, its corestore session and its open
  // cores, for ever. (Only drives that are not yet open are failed, so the live epoch's
  // own prune pass in the same tick is untouched.)
  const realReady = Hyperdrive.prototype.ready
  const realClose = Hyperdrive.prototype.close
  const closedDrives = []
  let failReady = false
  Hyperdrive.prototype.close = function (...a) { closedDrives.push(this); return realClose.apply(this, a) }
  Hyperdrive.prototype.ready = function (...a) {
    if (failReady && !this.opened) return Promise.reject(new Error('simulated ready failure'))
    return realReady.apply(this, a)
  }
  try {
    failReady = true
    const closedBefore = closedDrives.length
    await g2._maintain()
    ok(g2._state.pending.length === 1 && g2._state.pending[0].epoch === 999, 'a purge whose ready() throws also stays on the queue')
    ok(closedDrives.length > closedBefore, `the half-opened drive was closed rather than leaked (${closedDrives.length - closedBefore} closed)`)
  } finally {
    failReady = false
    Hyperdrive.prototype.ready = realReady
    Hyperdrive.prototype.close = realClose
  }
  g2._state.pending = []

  // ===== D. a rotation landing mid-putDay must not touch the NEW epoch =================
  log('\nD. putDay pins its drive against a concurrent rotate()')
  // putDay runs on ingest's per-provider interval, rotate() on _maintain's hourly one, and
  // nothing serialises them. If putDay re-read this._drive across its awaits, the blob
  // descriptor read from the OLD epoch would be cleared against the NEW one — freeing live
  // blocks of the drive just minted, with no peer to refetch them from.
  const dirD = mkdir('epgreclaim-d-')
  const g3 = await new GuideManager(guideConfig(dirD, bootstrap)).init()
  cleanups.push(() => g3.close())
  const raceDays = ['2030-01-01', '2030-01-02', '2030-01-03']
  for (const d of raceDays) await g3.putDay('news', d, fatDay(Date.parse(d + 'T00:00:00.000Z'), { tag: 'W' }))

  const raced = g3._drive
  const staleBefore = (await raced.entry(`/v1/news/${raceDays[1]}.json`)).value.blob
  const clearsOnNewEpoch = []
  const realEntry = raced.entry.bind(raced)
  let entryCalls = 0
  raced.entry = async (...args) => {
    const node = await realEntry(...args)
    // putDay looks this drive's entry up exactly twice before it writes: once inside get()
    // for the byte-compare, then again for the descriptor it is about to supersede. Firing
    // here is the precise window — stale descriptor in hand, put not yet made. The flag is
    // set before the await, so rotate()'s own lookups pass straight through.
    if (++entryCalls !== 2) return node
    await g3.rotate()
    const nb = await g3._drive.getBlobs()
    const realClear = nb.core.clear.bind(nb.core)
    nb.core.clear = (s, e, o) => { clearsOnNewEpoch.push([s, e]); return realClear(s, e, o) }
    return node
  }
  const verdict = await g3.putDay('news', raceDays[1], fatDay(Date.parse(raceDays[1] + 'T00:00:00.000Z'), { tag: 'X' }))
  raced.entry = realEntry

  const newBlobs = await g3._drive.getBlobs()
  let missing = 0
  for (let i = 0; i < newBlobs.core.length; i++) if (!(await newBlobs.core.has(i))) missing++
  ok(g3.status().epoch === 2, 'the rotation really did land in the middle of the write')
  ok(verdict === 'put', 'the write still completed')
  ok(clearsOnNewEpoch.length === 0, `the freshly minted epoch's blobs core was never cleared (${clearsOnNewEpoch.length} clear call(s))`)
  ok(missing === 0, `the new epoch still holds every block it wrote (${missing} missing of ${newBlobs.core.length})`)
  // …and the reclaim still happened, on the drive that actually held the superseded bytes.
  const racedBlobs = await raced.getBlobs()
  let staleHeld = 0
  for (let i = staleBefore.blockOffset; i < staleBefore.blockOffset + staleBefore.blockLength; i++) {
    if (await racedBlobs.core.has(i)) staleHeld++
  }
  ok(staleHeld === 0, `the superseded revision was freed on the drive that held it (${staleHeld} of ${staleBefore.blockLength} blocks left)`)

  // ===== E. the drain writes back against the LIVE queue ===============================
  log('\nE. a rotation landing during the purge drain is not discarded')
  // _maintain waits on multi-GB filesystem deletes and a network write. Anything appended
  // to the queue while it waits must survive the write-back: a keep-list computed before
  // those awaits would overwrite the fresh queue and silently drop the epoch just retired
  // — the exact orphan the queue exists to prevent, reintroduced by the fix for it.
  // Injecting the append from inside purge() reproduces that interleave deterministically.
  g3._state.pending[0].purgeAt = Date.now() - 1000
  const purgedEpoch = g3._state.pending[0].epoch
  const realPurge = Hyperdrive.prototype.purge
  let injected = false
  Hyperdrive.prototype.purge = async function (...a) {
    if (!injected) { // stand in for a concurrent _mintEpoch retiring another epoch
      injected = true
      g3._state.pending = [...g3._state.pending, { epoch: 42, driveKey: null, purgeAt: Date.now() + 3600 * 1000 }]
    }
    return realPurge.apply(this, a)
  }
  try { await g3._maintain() } finally { Hyperdrive.prototype.purge = realPurge }
  const survivors = g3._state.pending.map((p) => p.epoch)
  ok(injected, 'the injection ran (a purge really was in flight)')
  ok(!survivors.includes(purgedEpoch), `the epoch that was actually purged left the queue (epoch ${purgedEpoch})`)
  ok(survivors.includes(42), `the epoch queued mid-drain survived the write-back (queue now [${survivors.join(',')}])`)
  g3._state.pending = []

  // ===== F. a corrupt epoch.json fails closed ==========================================
  log('\nF. an unreadable epoch.json refuses to mint over an existing store')
  // Returning null here would mint epoch 1 on a store that already holds epochs 1..n —
  // reopening a months-old namespace as "fresh" and orphaning everything above it, which
  // is the same unreachable-drive outcome reached from the other side.
  const dirE = mkdir('epgreclaim-e-')
  const g4 = await new GuideManager(guideConfig(dirE, bootstrap)).init()
  cleanups.push(() => g4.close())
  const e4Epoch = g4.status().epoch
  await g4.close()
  fs.writeFileSync(path.join(dirE, 'epoch.json'), '{ this is not json')
  const g5 = new GuideManager(guideConfig(dirE, bootstrap))
  cleanups.push(() => g5.close())
  let refused = null
  try { await g5.init() } catch (e) { refused = e }
  ok(!!refused && /unparseable/.test(refused.message), `a corrupt epoch.json is refused, not ignored (${refused ? refused.message.slice(0, 48) + '…' : 'NO THROW'})`)
  ok(e4Epoch === 1 && fs.existsSync(path.join(dirE, 'store')), 'the store it refused to overwrite is still there for the operator')

  log('')
  if (failures) { log(`RESULT: FAIL ❌  (${failures} failing check${failures === 1 ? '' : 's'})`); await cleanup(); process.exit(1) }
  log('RESULT: PASS ✅  (pruned days free their blob bytes; a revised day frees the superseded revision; a quiet cycle still costs nothing; every retired epoch stays on the purge queue until it is actually gone)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
