// Ephemeral feed buffer test — deterministic, local-only (no ffmpeg, no DHT).
//
// The live feed must behave like a rolling buffer, not an append-only archive: the
// m3u8 playlist defines which segments exist; anything that rotates out of the window
// is deleted from the drive AND its blob storage is reclaimed (hypercore clear()), so
// a feed that streams for days occupies O(window) storage, in RAM or on disk.
//
// Drives mirrorDirToDrive + reclaimExpiredBlobs over a temp dir with a RAM-backed
// Hyperdrive, simulating ffmpeg's rolling HLS window (writes, rotations, playlist
// rewrites), then asserts: live entries readable, rotated entries gone, expired blob
// blocks freed (not fetchable locally), storage bounded across many rotations.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-retention-'))
const seg = (n) => Buffer.alloc(96 * 1024, n % 251) // ~96 KiB per fake segment, distinct fill
const playlist = (from, to) => Buffer.from(
  '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:' + from + '\n' +
  Array.from({ length: to - from + 1 }, (_, i) => `#EXTINF:4.0,\nseg${from + i}.ts`).join('\n') + '\n'
)

try {
  const store = new Corestore(RAM)
  const drive = new Hyperdrive(store.namespace('feed'), { encryptionKey: crypto.randomBytes(32) })
  await drive.ready()
  const blobs = await drive.getBlobs()
  const stop = mirrorDirToDrive(dir, drive, { interval: 40 })

  // --- initial window: seg0..seg4 ---
  for (let i = 0; i <= 4; i++) fs.writeFileSync(path.join(dir, `seg${i}.ts`), seg(i))
  fs.writeFileSync(path.join(dir, 'index.m3u8'), playlist(0, 4))
  await waitFor(async () => !!(await drive.entry('/index.m3u8')) && !!(await drive.entry('/seg4.ts')), 5000, 'initial mirror')
  const grownTo = blobs.core.length
  assert.ok(grownTo > 0, 'blob core received the window')
  log('  ok  initial window mirrored (blob core length', grownTo + ')')

  // --- many rotations: keep a 5-segment window rolling up to seg39 ---
  for (let head = 5; head < 40; head++) {
    fs.writeFileSync(path.join(dir, `seg${head}.ts`), seg(head))
    const tail = head - 5
    try { fs.unlinkSync(path.join(dir, `seg${tail}.ts`)) } catch {}
    fs.writeFileSync(path.join(dir, 'index.m3u8'), playlist(tail + 1, head))
    await sleep(55) // let the mirror tick between rotations
  }
  await waitFor(async () => !!(await drive.entry('/seg39.ts')) && !(await drive.entry('/seg30.ts')), 5000, 'window rolled to seg35..39')

  // Rotated-out entries are gone; live ones read back intact.
  assert.strictEqual(await drive.entry('/seg0.ts'), null, 'seg0 rotated out of the drive')
  const live = await drive.get('/seg39.ts')
  assert.ok(live && live.equals(seg(39)), 'newest segment readable and intact')
  const pl = await drive.get('/index.m3u8')
  assert.ok(pl && pl.toString().includes('seg39.ts'), 'playlist is the live one')
  log('  ok  window rolls: old entries deleted, live window readable')

  // Expired blob blocks are actually freed (locally unfetchable), not just unlinked.
  const min = await reclaimExpiredBlobs(drive) // idempotent; returns the low watermark
  assert.ok(min > 0, 'live window sits above a cleared region (min offset ' + min + ')')
  assert.strictEqual(await blobs.core.has(0), false, 'expired block 0 is cleared from storage')
  assert.strictEqual(blobs.core.contiguousLength, 0, 'no contiguous prefix retained')
  assert.strictEqual(await blobs.core.get(0, { wait: false }), null, 'expired block is gone (null without waiting for peers)')

  // Storage stays O(window): stored blocks ≈ live entries' blocks, not 40 segments' worth.
  let liveBlocks = 0
  for await (const entry of drive.list('/')) {
    const b = entry.value && entry.value.blob
    if (b) liveBlocks += b.blockLength
  }
  let storedBlocks = 0
  for (let i = 0; i < blobs.core.length; i++) if (await blobs.core.has(i)) storedBlocks++
  assert.ok(storedBlocks <= liveBlocks + 4, `stored blocks (${storedBlocks}) bounded by the live window (${liveBlocks})`)
  assert.ok(blobs.core.length > storedBlocks * 3, 'history is much larger than what is stored (ephemerality)')
  log(`  ok  storage bounded: ${storedBlocks} stored of ${blobs.core.length} appended blocks (live window ${liveBlocks})`)

  stop()
  await drive.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
  log('\nRESULT: PASS ✅  (rolling window mirrors, expired segments cleared, storage O(window))')
  process.exit(0)
} catch (err) {
  console.error('ERROR:', err.stack || err.message)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  process.exit(1)
}
