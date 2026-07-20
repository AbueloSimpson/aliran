// Ephemeral feed buffer test — deterministic, local-only (no ffmpeg, no DHT).
//
// The live feed must behave like a rolling buffer, not an append-only archive: the
// m3u8 playlist defines which segments exist; anything that rotates out of the window
// is deleted from the drive AND its blob storage is reclaimed (hypercore clear()), so
// a feed that streams for days occupies O(window) storage, in RAM or on disk.
//
// Two scenarios:
//   A. RAM-backed, clean rotation — the baseline rolling-window contract.
//   B. DISK-backed, with a STUCK low entry (an orphaned segment a crash/respawn stranded
//      in the core) + a broadcaster restart. This reproduces the disk-fill regression that
//      filled a VPS: reclaim that only sweeps below a single low watermark leaks the whole
//      history above a stuck entry. The fix clears each blob AS IT ROTATES and drops the
//      orphan on restart (reconcileStaleEntries), so storage stays O(window) regardless.
import assert from 'assert'
import os from 'os'
import fs from 'fs'
import path from 'path'
import Corestore from 'corestore'
import RAM from 'random-access-memory'
import Hyperdrive from 'hyperdrive'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { mirrorDirToDrive, reclaimExpiredBlobs, feedTreeBytes, isStoreCorruption } from '../broadcaster/src/hls.js'
import { purgeStaleCores } from '@aliran/core/store-gc.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { if (await fn()) return } catch {} await sleep(50) }
  throw new Error('timeout: ' + label)
}

const seg = (n) => Buffer.alloc(96 * 1024, n % 251) // ~96 KiB per fake segment, distinct fill
const playlist = (names) => Buffer.from(
  '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n' + names.map((n) => `#EXTINF:4.0,\n${n}`).join('\n') + '\n'
)

// Count blob blocks the core still has stored locally (bitfield-based → platform-independent,
// unlike on-disk byte allocation which depends on filesystem hole-punch support).
async function storedBlocks (blobs) {
  let n = 0
  for (let i = 0; i < blobs.core.length; i++) if (await blobs.core.has(i)) n++
  return n
}

// Blocks referenced by the current live entries — the O(window) target.
async function liveBlocks (drive) {
  let n = 0
  for await (const entry of drive.list('/')) {
    const b = entry.value && entry.value.blob
    if (b) n += b.blockLength
  }
  return n
}

// Sum of allocated bytes (st.blocks*512) across the store's core `data` files. On a
// hole-punching filesystem this drops as blobs are cleared; where punch isn't observable
// (e.g. non-sparse files on Windows) it tracks logical size — informational only, the hard
// assertions are bitfield-based.
function allocatedBytes (dir) {
  let total = 0
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'data') {
        try { const b = fs.statSync(p).blocks; if (typeof b === 'number') total += b * 512 } catch {}
      }
    }
  }
  walk(dir)
  return total
}

// The leaf core directories corestore lays out at cores/<aa>/<bb>/<discoveryKeyHex>/ — one
// per hypercore (a hyperdrive has two: metadata + blobs). The set of feed-generation cores.
function listCoreDirs (storeDir) {
  const out = new Set()
  const cores = path.join(storeDir, 'cores')
  let l1 = []
  try { l1 = fs.readdirSync(cores) } catch { return out }
  for (const a of l1) {
    let l2 = []
    try { l2 = fs.readdirSync(path.join(cores, a)) } catch { continue }
    for (const b of l2) {
      let leaves = []
      try { leaves = fs.readdirSync(path.join(cores, a, b)) } catch { continue }
      for (const id of leaves) if (/^[0-9a-f]{64}$/.test(id)) out.add(id)
    }
  }
  return out
}

// Allocated bytes of every append-only `tree` file across the store — the merkle metadata
// blob clear() never frees. This is what grows for a feed's whole lifetime and what
// whole-namespace GC (purgeStaleCores) is here to bound.
function allTreeBytes (storeDir) {
  let total = 0
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'tree') { try { const b = fs.statSync(p).blocks; total += (typeof b === 'number' ? b * 512 : fs.statSync(p).size) } catch {} }
    }
  }
  walk(path.join(storeDir, 'cores'))
  return total
}

// --- Scenario A: RAM-backed clean rotation ----------------------------------------------
async function scenarioRamCleanRotation () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-retention-a-'))
  const store = new Corestore(RAM)
  const drive = new Hyperdrive(store.namespace('feed'), { encryptionKey: crypto.randomBytes(32) })
  await drive.ready()
  const blobs = await drive.getBlobs()
  const stop = mirrorDirToDrive(dir, drive, { interval: 40 })

  // initial window seg0..seg4
  for (let i = 0; i <= 4; i++) fs.writeFileSync(path.join(dir, `seg${i}.ts`), seg(i))
  fs.writeFileSync(path.join(dir, 'index.m3u8'), playlist([0, 1, 2, 3, 4].map((i) => `seg${i}.ts`)))
  await waitFor(async () => !!(await drive.entry('/index.m3u8')) && !!(await drive.entry('/seg4.ts')), 5000, 'initial mirror')
  assert.ok(blobs.core.length > 0, 'blob core received the window')
  log('  ok  initial window mirrored (blob core length', blobs.core.length + ')')

  // roll a 5-segment window up to seg39
  for (let head = 5; head < 40; head++) {
    fs.writeFileSync(path.join(dir, `seg${head}.ts`), seg(head))
    try { fs.unlinkSync(path.join(dir, `seg${head - 5}.ts`)) } catch {}
    fs.writeFileSync(path.join(dir, 'index.m3u8'), playlist([head - 4, head - 3, head - 2, head - 1, head].map((i) => `seg${i}.ts`)))
    await sleep(55)
  }
  await waitFor(async () => !!(await drive.entry('/seg39.ts')) && !(await drive.entry('/seg30.ts')), 5000, 'window rolled to seg35..39')

  assert.strictEqual(await drive.entry('/seg0.ts'), null, 'seg0 rotated out of the drive')
  const live = await drive.get('/seg39.ts')
  assert.ok(live && live.equals(seg(39)), 'newest segment readable and intact')
  const pl = await drive.get('/index.m3u8')
  assert.ok(pl && pl.toString().includes('seg39.ts'), 'playlist is the live one')
  log('  ok  window rolls: old entries deleted, live window readable')

  assert.strictEqual(await blobs.core.has(0), false, 'expired block 0 is cleared from storage')
  assert.strictEqual(blobs.core.contiguousLength, 0, 'no contiguous prefix retained')
  assert.strictEqual(await blobs.core.get(0, { wait: false }), null, 'expired block is gone without waiting for peers')

  const stored = await storedBlocks(blobs)
  const liveB = await liveBlocks(drive)
  assert.ok(stored <= liveB + 4, `stored blocks (${stored}) bounded by the live window (${liveB})`)
  assert.ok(blobs.core.length > stored * 3, 'history is much larger than what is stored (ephemerality)')
  log(`  ok  storage bounded: ${stored} stored of ${blobs.core.length} appended blocks (live window ${liveB})`)

  stop()
  await drive.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

// --- Scenario B: DISK-backed, stuck orphan entry, + restart -----------------------------
// The regression guard. An orphaned segment stays live at a LOW offset the whole run; the
// live window rolls far above it. Reclaim that only sweeps below the lowest live offset can
// free almost nothing (the orphan pins it), so storage grows without bound. The fix frees
// each blob as it rotates, so storage stays O(window) despite the orphan; the orphan itself
// is dropped on the simulated restart.
async function scenarioDiskOrphanAndRestart () {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-retention-b-store-'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-retention-b-out-'))
  const encryptionKey = crypto.randomBytes(32)

  const store = new Corestore(storeDir)
  const drive = new Hyperdrive(store.namespace('feed'), { encryptionKey })
  await drive.ready()
  const blobs = await drive.getBlobs()
  const stop = mirrorDirToDrive(dir, drive, { interval: 40 })

  // A crash/respawn stranded this segment: it stays on disk and in the drive forever, at a
  // LOW blob offset — exactly the shape that pinned the reclaim watermark on the VPS.
  fs.writeFileSync(path.join(dir, 'seg_orphan.ts'), seg(200))
  fs.writeFileSync(path.join(dir, 'index.m3u8'), playlist(['seg_orphan.ts']))
  await waitFor(async () => !!(await drive.entry('/seg_orphan.ts')), 5000, 'orphan mirrored')

  // Roll a real 5-deep window far past the orphan (100 rotations). WITHOUT rotation-time
  // clearing, ~100 segments' worth of blocks pile up above the pinned orphan.
  const WINDOW = 5
  const ROTATIONS = 100
  for (let head = 0; head < ROTATIONS; head++) {
    fs.writeFileSync(path.join(dir, `seg${head}.ts`), seg(head))
    if (head >= WINDOW) { try { fs.unlinkSync(path.join(dir, `seg${head - WINDOW}.ts`)) } catch {} }
    const names = ['seg_orphan.ts']
    for (let i = Math.max(0, head - WINDOW + 1); i <= head; i++) names.push(`seg${i}.ts`)
    fs.writeFileSync(path.join(dir, 'index.m3u8'), playlist(names))
    await sleep(20)
  }
  await waitFor(async () => !!(await drive.entry(`/seg${ROTATIONS - 1}.ts`)), 5000, 'rolled to last segment')
  await sleep(120) // let the final rotation + reclaim settle

  // The orphan is still live (we never deleted it) — proving the bound below is NOT just
  // "everything got cleared", but real per-entry reclaim around a stuck entry.
  const orphan = await drive.get('/seg_orphan.ts')
  assert.ok(orphan && orphan.equals(seg(200)), 'orphan segment still live and intact')

  const stored = await storedBlocks(blobs)
  const liveB = await liveBlocks(drive)
  const appended = blobs.core.length
  log(`  …  after ${ROTATIONS} rotations over a stuck orphan: ${stored} stored of ${appended} appended (live window ${liveB})`)
  log(`  …  on-disk allocated across core data files: ${(allocatedBytes(storeDir) / 1e6).toFixed(1)} MB`)
  // THE regression assertion: stored blocks track the live window, NOT the whole history.
  // Pre-fix this is ~ROTATIONS blocks (grows with runtime); post-fix it is ~window+orphan.
  assert.ok(stored <= liveB + 4,
    `stored blocks (${stored}) must track the live window (${liveB}), not the ${appended}-block history — a stuck orphan must not pin reclaim`)
  assert.ok(appended > stored * 5, `history (${appended}) is far larger than what is stored (${stored}) — storage is O(window), not O(runtime)`)
  log('  ok  disk stays O(window) despite a permanently-stuck low entry')

  // --- Restart: reopen the SAME on-disk core with a FRESH (empty) output dir. This is a
  // broadcaster restart in disk mode. boot()/reconcileStaleEntries must drop the persisted
  // backlog (orphan included) so a prior run's leak can't survive the restart.
  stop()
  await drive.close()
  await store.close()

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-retention-b-out2-'))
  const store2 = new Corestore(storeDir)
  const drive2 = new Hyperdrive(store2.namespace('feed'), { encryptionKey })
  await drive2.ready()
  assert.ok(!!(await drive2.entry('/seg_orphan.ts')), 'reopened disk core still holds the prior-run entries')
  const blobs2 = await drive2.getBlobs()
  const stop2 = mirrorDirToDrive(dir2, drive2, { interval: 40 })

  // reconcile drops every entry not in the fresh (empty) outDir; then the sweep bulk-frees.
  await waitFor(async () => (await drive2.entry('/seg_orphan.ts')) === null, 5000, 'orphan dropped on restart')
  await sleep(120)
  const storedAfter = await storedBlocks(blobs2)
  log(`  …  after restart reconcile: ${storedAfter} blocks stored (was ${stored})`)
  assert.ok(storedAfter <= 4, `restart reclaimed the backlog (stored ${storedAfter} ≈ 0)`)
  log('  ok  restart drops the stranded backlog (large first reclaim)')

  stop2()
  await drive2.close()
  await store2.close()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(dir2, { recursive: true, force: true })
  fs.rmSync(storeDir, { recursive: true, force: true })
}

// --- Scenario C: bee metadata caches bounded by the shared global budget ----------------
// The drive's Hyperbee caches decoded nodes + keys per append seq. Unbounded, that is
// ~1.5 KB of heap retained per metadata append FOREVER (the long-uptime RSS leak). The
// broadcaster passes ONE bounded Rache as the corestore globalCache (channel.js); this
// guards the wiring contract: the budget must survive corestore.namespace() and the bee
// must link its caches into it (a corestore/hyperbee upgrade silently dropping that link
// would silently bring the leak back).
async function scenarioBeeCacheBounded () {
  const { default: Rache } = await import('rache')
  const MAX = 256
  const globalCache = new Rache({ maxSize: MAX })
  const store = new Corestore(RAM, { globalCache })
  const drive = new Hyperdrive(store.namespace('feed'), { encryptionKey: crypto.randomBytes(32) })
  await drive.ready()

  // Churn far more appends than the budget: rolling put/del like the mirror produces.
  for (let i = 0; i < 300; i++) {
    await drive.put(`/seg${i}.ts`, seg(i))
    await drive.put('/index.m3u8', playlist([`seg${i}.ts`]))
    if (i >= 5) await drive.del(`/seg${i - 5}.ts`)
  }
  const bee = drive.db
  assert.ok(bee._nodeCache && bee._keyCache, 'bee has its node/key caches')
  assert.ok(bee.core.length > MAX * 2, `appends (${bee.core.length}) far exceed the budget (${MAX})`)
  assert.ok(bee._nodeCache.keys.globalSize <= MAX,
    `bee caches share the bounded global budget (globalSize ${bee._nodeCache.keys.globalSize} <= ${MAX})`)
  assert.ok(bee._nodeCache.keys.globalSize > 0, 'the budget is actually in use (caches are linked, not disabled)')
  const entry = await drive.entry('/index.m3u8')
  assert.ok(entry, 'drive still reads fine with evicted cache entries')
  log(`  ok  bee caches bounded: globalSize ${bee._nodeCache.keys.globalSize} <= ${MAX} after ${bee.core.length} appends`)

  await drive.close()
  await store.close()
}

// --- Scenario D: whole-namespace GC bounds metadata, not just blob data ------------------
// blob clear() (scenarios A/B) reclaims rotated SEGMENT data, keeping the CURRENT feed's
// stored blocks O(window). But a disk channel's Corestore accumulates the cores of every
// feed GENERATION it has run (a source change or a periodic rotation bumps feedGen → a new
// namespace → new cores). Those retired cores' append-only merkle TREES are never freed by
// clear() — the slow metadata creep that fills a disk over weeks. purgeStaleCores drops a
// retired generation's whole core directory. This proves the store's on-disk tree/namespace
// bytes track the CURRENT generation after GC, not the accumulated history, and that the
// live generation survives intact — plus the empty-keep-set safety guard.
async function scenarioNamespaceGc () {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-retention-d-store-'))
  const encryptionKey = crypto.randomBytes(32)
  const store = new Corestore(storeDir)

  // Generation 0 (the retired-to-be feed): grow a real tree with many appends, then clear
  // its blob data (the rolling reclaim). Data shrinks; the merkle tree stays = dead weight.
  const d0 = new Hyperdrive(store.namespace('feed'), { encryptionKey })
  await d0.ready()
  const b0 = await d0.getBlobs()
  for (let i = 0; i < 300; i++) {
    await d0.put(`/seg${i}.ts`, seg(i))
    await d0.put('/index.m3u8', playlist([`seg${i}.ts`]))
  }
  await b0.core.clear(0, b0.core.length) // reclaim ALL blob data — only the tree remains
  const gen0 = [b4a.toString(d0.discoveryKey, 'hex'), b4a.toString(b0.core.discoveryKey, 'hex')]

  // Generation 1 (the current feed): a small live window.
  const d1 = new Hyperdrive(store.namespace('feed-gen-1'), { encryptionKey })
  await d1.ready()
  const b1 = await d1.getBlobs()
  for (let i = 0; i < 5; i++) await d1.put(`/seg${i}.ts`, seg(i))
  await d1.put('/index.m3u8', playlist([0, 1, 2, 3, 4].map((i) => `seg${i}.ts`)))
  const gen1 = [b4a.toString(d1.discoveryKey, 'hex'), b4a.toString(b1.core.discoveryKey, 'hex')]

  const dirsBefore = listCoreDirs(storeDir)
  const gen0TreeBefore = feedTreeBytes(storeDir, gen0)
  const treeBefore = allTreeBytes(storeDir)
  log(`  …  two generations present: ${dirsBefore.size} core dirs, gen0 tree ${(gen0TreeBefore / 1e3).toFixed(1)} kB, store tree total ${(treeBefore / 1e3).toFixed(1)} kB`)
  assert.strictEqual(dirsBefore.size, 4, 'both generations laid down two cores each (4 core dirs)')
  assert.ok(gen0TreeBefore > 0, 'the retired generation has a real, non-empty merkle tree (dead weight blob reclaim cannot touch)')
  assert.ok(feedTreeBytes(storeDir, gen1) > 0, 'the current generation has its tree too')

  // Close everything so the on-disk files are releasable (Windows), like a broadcaster that
  // reopens the store on start and GCs before touching the live feed.
  await d0.close(); await d1.close(); await store.close()

  // GC keeping ONLY the current generation.
  const keep = new Set(gen1)
  const res = purgeStaleCores(storeDir, keep)
  log(`  …  purgeStaleCores removed ${res.removed} retired core dir(s), freed ${(res.bytesFreed / 1e6).toFixed(2)} MB`)
  assert.strictEqual(res.removed, 2, 'exactly the retired generation\'s two cores were purged')
  assert.ok(res.bytesFreed > 0, 'purge reported freed bytes')

  const dirsAfter = listCoreDirs(storeDir)
  assert.deepStrictEqual([...dirsAfter].sort(), [...keep].sort(), 'only the current generation\'s cores remain on disk')
  assert.strictEqual(feedTreeBytes(storeDir, gen0), 0, 'the retired generation\'s tree bytes are gone (namespace removed), not merely its blob data')
  const treeAfter = allTreeBytes(storeDir)
  assert.ok(treeAfter < treeBefore, `store tree bytes dropped after GC (${(treeAfter / 1e3).toFixed(1)} kB < ${(treeBefore / 1e3).toFixed(1)} kB) — metadata is bounded, not just blob data`)
  assert.ok(treeAfter <= feedTreeBytes(storeDir, gen1) + 4096, 'remaining tree bytes track the current generation only')
  log('  ok  metadata bounded: the store keeps only the current generation\'s tree after GC')

  // The current generation survives the purge intact and readable.
  const store2 = new Corestore(storeDir)
  const d1b = new Hyperdrive(store2.namespace('feed-gen-1'), { encryptionKey })
  await d1b.ready()
  assert.ok(!!(await d1b.entry('/index.m3u8')), 'current feed playlist still present after GC')
  const kept = await d1b.get('/seg4.ts')
  assert.ok(kept && kept.equals(seg(4)), 'a current-feed segment is still readable after GC')
  log('  ok  the current generation replicates unharmed by the purge')

  // Safety guard: an empty keep set must be a no-op — never nuke a store because a caller
  // failed to resolve the live discovery keys.
  const res2 = purgeStaleCores(storeDir, new Set())
  assert.strictEqual(res2.removed, 0, 'empty keep set purges nothing')
  assert.deepStrictEqual(listCoreDirs(storeDir), dirsAfter, 'empty keep set left the store untouched')
  log('  ok  empty keep set is a safe no-op (never deletes the running feed)')

  await d1b.close(); await store2.close()
  fs.rmSync(storeDir, { recursive: true, force: true })
}

// --- Scenario E: an unclean-exit-truncated store is detected as corruption -----------------
// A SIGKILL/OOM/power-loss (or a `docker stop` that outran its grace) mid-write truncates a
// disk feed's core files, so the store can never reopen (EPARTIALREAD "Could not satisfy
// length"). The broadcaster must RECOGNIZE that as corruption so it can self-heal (rotate to
// a fresh generation) instead of silently stranding the channel on every boot. This proves
// isStoreCorruption() catches the REAL truncation error, not just a hand-picked code string.
async function scenarioCorruptStoreDetected () {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-retention-e-'))
  const encryptionKey = crypto.randomBytes(32)
  const store = new Corestore(storeDir)
  const drive = new Hyperdrive(store.namespace('feed'), { encryptionKey })
  await drive.ready()
  const disc = b4a.toString(drive.discoveryKey, 'hex')
  for (let i = 0; i < 40; i++) { await drive.put(`/seg${i}.ts`, seg(i)); await drive.put('/index.m3u8', playlist([`seg${i}.ts`])) }
  await drive.close(); await store.close()

  // Truncate the metadata core's tree file to simulate a write cut off by an unclean exit.
  const treePath = path.join(storeDir, 'cores', disc.slice(0, 2), disc.slice(2, 4), disc, 'tree')
  const before = fs.statSync(treePath).size
  fs.truncateSync(treePath, Math.max(0, Math.floor(before / 3)))
  log(`  …  truncated metadata tree ${before} -> ${Math.floor(before / 3)} bytes (simulated unclean-exit corruption)`)

  let caught = null
  const store2 = new Corestore(storeDir)
  const drive2 = new Hyperdrive(store2.namespace('feed'), { encryptionKey })
  try { await drive2.ready(); await drive2.getBlobs(); for await (const _ of drive2.list('/')) break } catch (err) { caught = err } // eslint-disable-line no-unused-vars
  try { await drive2.close() } catch {}
  try { await store2.close() } catch {}
  assert.ok(caught, 'reopening the truncated store throws')
  log(`  …  reopen threw: ${caught.code || ''} ${caught.message}`)
  assert.ok(isStoreCorruption(caught), `isStoreCorruption() recognizes the truncation error (${caught.code || caught.message})`)
  log('  ok  a truncated feed store is detected as corruption (broadcaster self-heals to a fresh generation)')
  fs.rmSync(storeDir, { recursive: true, force: true })
}

try {
  log('scenario A — RAM, clean rotation')
  await scenarioRamCleanRotation()
  log('scenario B — disk, stuck orphan + restart')
  await scenarioDiskOrphanAndRestart()
  log('scenario C — bee metadata caches bounded (globalCache budget)')
  await scenarioBeeCacheBounded()
  log('scenario D — whole-namespace GC bounds metadata (retired feed generations purged)')
  await scenarioNamespaceGc()
  log('scenario E — an unclean-exit-truncated store is detected as corruption (self-heal trigger)')
  await scenarioCorruptStoreDetected()
  log('\nRESULT: PASS ✅  (rolling window mirrors; storage O(window) even with a stuck entry; restart reclaims the backlog; bee caches bounded; retired feed generations purged; a truncated store is detected as corruption so the broadcaster self-heals)')
  process.exit(0)
} catch (err) {
  console.error('ERROR:', err.stack || err.message)
  process.exit(1)
}
