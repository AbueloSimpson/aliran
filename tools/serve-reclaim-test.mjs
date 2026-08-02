// Expired-block reclaim test for the shared media-serving core (sdk/serve.js via
// tools/lib/serve-drive.js — the same handler sdk/player.js serves the app with).
//
// Deterministic (no DHT, no network): one in-process corestore/hyperdrive plays the
// viewer's replica. The broadcaster clears a segment's blocks the moment it rotates
// out of the playlist, so blocks below the live window are unfetchable swarm-wide —
// the `reclaim` opt makes the VIEWER free its local copies too, bounding disk to
// ~one live window per feed. Validates:
//
//   A  LIVE RECLAIM — serving a live playlist through a reclaim-enabled handler
//      clears the blob blocks below the current window after segments rotate out,
//      while every still-listed segment's blocks stay intact.
//   B  VOD NEVER RECLAIMED — a playlist with #EXT-X-ENDLIST never clears anything,
//      even with `reclaim: true` (a viewer seeks VOD arbitrarily).
//   C  OPT-IN ONLY — with `reclaim` unset, nothing is ever cleared.
//   D  THE THUMBNAIL SURVIVES — /thumb.jpg is a live entry no playlist ever references, so
//      the naive floor (lowest playlist blob offset) sits ABOVE it and a plain clear(0,min)
//      wipes the ACTIVE channel's thumbnail on every single pass. Reclaim must punch AROUND
//      it: everything below the window goes except the thumbnail's own blocks.
//
// Exits 0 on PASS.

import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import http from 'http'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { driveHandler } from './lib/serve-drive.js'
import { THUMB_PATH } from '../sdk/serve.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function assert (cond, label) {
  if (!cond) { console.error('  ✗ FAIL:', label); process.exit(1) }
  log('  ✓', label)
}
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(50) }
  throw new Error('timeout: ' + label)
}

function httpGet (port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

async function serveOnce (handlerOpts, p) {
  const server = http.createServer(driveHandler(drive, handlerOpts))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const res = await httpGet(server.address().port, p)
  server.close()
  return res
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reclaim-'))
const store = new Corestore(dir)
await store.ready()
const drive = new Hyperdrive(store.namespace('feed'))
await drive.ready()

// Media fixture: 5 segments of 160 KB (3 blocks of 64 KB each), distinct fills.
const seg = (v) => Buffer.alloc(160 * 1024, v)
for (let i = 1; i <= 5; i++) await drive.put(`/seg${i}.ts`, seg(i))
const blobRef = {}
for (let i = 1; i <= 5; i++) blobRef[i] = (await drive.entry(`/seg${i}.ts`)).value.blob
const blobs = await drive.getBlobs()
const stored = async (b) => {
  for (let i = b.blockOffset; i < b.blockOffset + b.blockLength; i++) {
    if (!(await blobs.core.has(i))) return false
  }
  return true
}
const cleared = async (b) => {
  for (let i = b.blockOffset; i < b.blockOffset + b.blockLength; i++) {
    if (await blobs.core.has(i)) return false
  }
  return true
}
const playlist = (names, { end = false } = {}) =>
  '#EXTM3U\n#EXT-X-TARGETDURATION:2\n' +
  names.map((n) => `#EXTINF:2,\n${n}`).join('\n') + '\n' +
  (end ? '#EXT-X-ENDLIST\n' : '')

log('A: live reclaim (blocks below the window are cleared after rotation)')
{
  // One handler for both serves — the second serve must pass the per-drive
  // throttle, so the test overrides reclaimIntervalMs (default 30 s) down.
  const server = http.createServer(driveHandler(drive, { reclaim: true, reclaimIntervalMs: 100 }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  // Window v1 = segs 1-4. The reclaim floor is seg1's offset (0): nothing below it.
  const v1 = playlist(['seg1.ts', 'seg2.ts', 'seg3.ts', 'seg4.ts'])
  await drive.put('/live.m3u8', Buffer.from(v1))
  const r1 = await httpGet(port, '/live.m3u8')
  assert(r1.status === 200 && r1.body.toString() === v1, 'live playlist v1 serves intact (reclaim: true)')
  await sleep(400) // give a (wrong) reclaim time to run
  assert(await stored(blobRef[1]), 'nothing cleared while seg1 is still in the window')

  // Rotation: seg1 leaves the playlist (the broadcaster dels the entry and clears
  // its blocks at the source; the viewer replica keeps its local copies — exactly
  // what reclaim exists to free). Window v2 = segs 2-5.
  await drive.del('/seg1.ts')
  const v2 = playlist(['seg2.ts', 'seg3.ts', 'seg4.ts', 'seg5.ts'])
  await drive.put('/live.m3u8', Buffer.from(v2))
  await sleep(150) // past the (overridden) throttle
  const r2 = await httpGet(port, '/live.m3u8')
  assert(r2.status === 200 && r2.body.toString() === v2, 'live playlist v2 serves intact after rotation')
  await waitFor(() => cleared(blobRef[1]), 10000, 'reclaim of the rotated-out segment')
  assert(await cleared(blobRef[1]), 'seg1 blocks are cleared once it rotates out of the window')
  for (let i = 2; i <= 5; i++) assert(await stored(blobRef[i]), `seg${i} blocks stay intact (still in the window)`)
  server.close()
}

log('B: VOD (#EXT-X-ENDLIST) is never reclaimed, even with reclaim: true')
{
  // Floor would be seg3's offset (> 0): a wrong reclaim would clear seg2's blocks.
  await drive.put('/vod.m3u8', Buffer.from(playlist(['seg3.ts', 'seg4.ts', 'seg5.ts'], { end: true })))
  const res = await serveOnce({ reclaim: true, reclaimIntervalMs: 0 }, '/vod.m3u8')
  assert(res.status === 200, 'vod playlist serves intact (reclaim: true)')
  await sleep(400)
  assert(await stored(blobRef[2]), 'VOD serve cleared nothing (seg2 blocks below the listed set stay intact)')
}

log('C: reclaim unset — a live playlist never clears anything')
{
  // Floor would be seg4's offset (> 0): a wrong reclaim would clear segs 2-3.
  await drive.put('/tail.m3u8', Buffer.from(playlist(['seg4.ts', 'seg5.ts'])))
  const res = await serveOnce({ reclaimIntervalMs: 0 }, '/tail.m3u8')
  assert(res.status === 200, 'live playlist serves intact (reclaim unset)')
  await sleep(400)
  assert((await stored(blobRef[2])) && (await stored(blobRef[3])), 'nothing cleared without the reclaim opt')
}

log('D: the live thumbnail survives a reclaim pass that frees lower segment blobs')
{
  // Layout matters here, so build it explicitly. The thumbnail is put BETWEEN two
  // out-of-window segments, which is the production shape: it is refreshed every ~30 s
  // while segments rotate every ~2 s, so its blob is almost always stranded below the
  // window floor with dead segment blocks on BOTH sides of it. A fix that only clamped
  // the floor down to the thumbnail (rather than punching around it) would leave
  // everything above the thumbnail unreclaimed and would pass a weaker test than this.
  await drive.put('/old1.ts', seg(11)) // dead: below the thumbnail
  await drive.put(THUMB_PATH, Buffer.alloc(64 * 1024 * 2, 0x7a)) // 2 blocks, mid-stack
  await drive.put('/old2.ts', seg(12)) // dead: above the thumbnail, still below the window
  await drive.put('/new1.ts', seg(13)) // in the window
  await drive.put('/new2.ts', seg(14)) // in the window
  const old1 = (await drive.entry('/old1.ts')).value.blob
  const old2 = (await drive.entry('/old2.ts')).value.blob
  const thumb = (await drive.entry(THUMB_PATH)).value.blob
  const new1 = (await drive.entry('/new1.ts')).value.blob
  assert(thumb.blockOffset > old1.blockOffset && thumb.blockOffset < new1.blockOffset,
    'fixture: the thumbnail blob really is stranded below the live window')

  const server = http.createServer(driveHandler(drive, { reclaim: true, reclaimIntervalMs: 0 }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const v = playlist(['new1.ts', 'new2.ts'])
  await drive.put('/win.m3u8', Buffer.from(v))
  const res = await httpGet(server.address().port, '/win.m3u8')
  assert(res.status === 200 && res.body.toString() === v, 'live playlist serves intact')
  await waitFor(() => cleared(old1), 10000, 'reclaim of the segments below the window')
  assert(await cleared(old1), 'dead segment BELOW the thumbnail is freed')
  assert(await cleared(old2), 'dead segment ABOVE the thumbnail (but below the window) is freed too')
  // ⚠ THE POINT OF THIS SECTION. Before the fix these blocks went on every pass, so the
  // grid refetched the picture of the channel the viewer is actually watching every 30 s —
  // and, worse, could resolve an entry the broadcaster had already superseded and hang.
  assert(await stored(thumb), 'the live thumbnail is NOT cleared — reclaim punched around it')
  assert(await stored(new1), 'and the live window is untouched as always')
  // It must still be readable end-to-end, not merely "has blocks".
  const got = await httpGet(server.address().port, THUMB_PATH)
  assert(got.status === 200 && got.body.length === 64 * 1024 * 2, 'the thumbnail still serves in full after the pass')
  server.close()
}

log('\nRESULT: PASS ✅  live reclaim after rotation, VOD untouched, opt-in only, live thumbnail survives')
await drive.close()
await store.close()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
process.exit(0)
