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
import { mirrorDirToDrive, reclaimExpiredBlobs } from '../broadcaster/src/hls.js'

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

try {
  log('scenario A — RAM, clean rotation')
  await scenarioRamCleanRotation()
  log('scenario B — disk, stuck orphan + restart')
  await scenarioDiskOrphanAndRestart()
  log('\nRESULT: PASS ✅  (rolling window mirrors; storage O(window) even with a stuck entry; restart reclaims the backlog)')
  process.exit(0)
} catch (err) {
  console.error('ERROR:', err.stack || err.message)
  process.exit(1)
}
