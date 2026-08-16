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
//   E  A STORAGE LAYER THAT CANNOT HOLE-PUNCH — the 32-bit Android ABI, where
//      fs-native-extensions is absent and random-access-file's _del is a SILENT SUCCESS.
//      clear() runs, drops the bitfield, reports success and frees ZERO bytes; the byte
//      budget is the only thing that can notice, and it must call onOverBudget.
//   F  THE 64-BIT CONTROL — the same pass on a replica comfortably under the shipped
//      512 MiB budget must NEVER call onOverBudget. The callback is dead code on a working
//      platform and a host that rotated a healthy replica would be worse than the leak.
//   G  reclaimIdleFeed — the sweep for a feed nobody is watching, all three branches:
//      no /index.m3u8 (no-op), #EXT-X-ENDLIST (no-op, the same invariant B guards on the
//      serve path), and a live playlist (frees the blocks below the window).
//   H  DRAIN SURFACE — handler.inflight counts MEDIA reads only (never a HEAD, never an
//      ancillary target), and handler.whenDrained resolves both ways it is allowed to:
//      when the last read finishes, and on its timeout with a read still wedged. A
//      rotation that waits forever is worse than the truncated response it avoids.
//   I  THE WINDOW-SCALED BUDGET — the ceiling a replica is judged against is
//      max(configured, 3 × the OBSERVED live window), not the flat configured number. A
//      crippled replica many times over the CONFIGURED budget must still not trip while it
//      is holding one healthy live window (operators may set a 1920-second window, where one
//      window is 458 MiB and a flat 512 MiB put HEALTHY hardware over budget outright); and
//      where the scaled term IS the larger one, it must be the ceiling that fires and the
//      one info reports.
//   J  THE PUNCH GATE — on a store whose storage CAN hole-punch, a replica provably over the
//      effective budget must NEVER call onOverBudget: the budget is switched off for the life
//      of the handler. E only ever proves the no-punch side, and F never crosses its budget
//      at all, so neither of them can observe this latch.
//   K  PROBE VERDICT CLASSIFICATION — only the punch itself may produce a VERDICT. A del that
//      silently succeeds and a del that REJECTS are both MEASURED "cannot punch"; a write or
//      stat that fails (ENOSPC, EMFILE) is INCONCLUSIVE and must never latch one, because a
//      false verdict arms whole-replica rotation for the session on healthy hardware.
//   L  PROBE RETRY ACCOUNTING — an inconclusive probe is re-run, bounded by PROBE_MAX_TRIES
//      and at most once per reclaim tick, and falls back to budget-ACTIVE meanwhile; a
//      measured verdict is never re-run at all. Read off reclaimStatus().punchTries.
//   M  THE TRIGGER RIDES RANGED SERVES — a playlist requested with a Range header still
//      fires read-ahead, reclaim, the budget and the probe (the 206 branch used to fire
//      NOTHING, so the whole disk bound depended on clients not Ranging manifests). And the
//      reclaim floor comes from the WHOLE playlist re-read out of the drive, never from the
//      served slice: a suffix slice that lost the oldest listed line must not raise the
//      floor and eat a still-listed segment's blocks.
//   N  THE WIDE-PUNCH STAGE — an addon that truncates punch lengths mod 2^32 (size_t on a
//      32-bit ABI, observed in the wild) passes the small punch honestly, so a one-stage
//      probe latched the budget OFF while real below-window clears freed nothing. The
//      second stage punches > 4 GiB across a block parked above 2^32 and must refuse the
//      verdict: MEASURED cannot-punch, budget stays armed.
//   O  THE METADATA BUDGET — the hyperbee metadata core grows on EVERY platform (a hole
//      punch cannot free a bee, and nothing may clear the db core in place), so it is the
//      one growth the punch latch must NOT cover: a store the probe MEASURES as punchable,
//      blob budget latched OFF, must still fire onOverBudget with trigger: 'meta' when the
//      metadata core alone crosses metaBudgetBytes — and the crossing happens AFTER the
//      latch is set, because that is the field order and the order a latch-gated meta
//      check silently survives the other way round. Flat (never window-scaled), compared
//      against info.meta only, indifferent to the `ran` rule, sharing the 5-minute floor;
//      it also fires with the blob budget armed-but-under and with reclaimBudgetBytes: 0 —
//      and in that last shape the capability probe must never run at all (the 512 KiB
//      scratch write belongs to the blob half). VOD serves reach neither trigger.
//      metaBudgetBytes: 0 switches it off on the same fixture that just fired (the pair of
//      zeros is the real "never rotate"), and effectiveBudgetBytes — the BLOB ceiling — is
//      NULL on a meta verdict rather than a number the decision never used.
//
// Exits 0 on PASS.

import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import http from 'http'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { driveHandler } from './lib/serve-drive.js'
import { THUMB_PATH, measureDriveBytes, probeHolePunch, reclaimBelowWindow, reclaimIdleFeed } from '../sdk/serve.js'

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

// The same GET with a Range header — scenario M serves playlists exclusively through the
// 206 branch, which is the branch the trigger chain was once absent from.
function httpGetRange (port, p, range) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Range: range }, agent: false }, (res) => {
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

// A GET whose body is deliberately NOT consumed: resolves as soon as the response
// headers land, leaving the read stalled on TCP backpressure so it stays in flight for
// as long as the caller wants it there (scenario H). Consume it with drain().
function httpHold (port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => { res.pause(); resolve(res) })
    req.on('error', reject)
  })
}
function drain (res) {
  return new Promise((resolve) => {
    let n = 0
    res.on('data', (c) => { n += c.length })
    res.on('end', () => resolve(n))
    res.resume()
  })
}
function httpHead (port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'HEAD', agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
}

// THE 32-BIT ANDROID ABI, SIMULATED AT THE LAYER IT ACTUALLY BREAKS AT.
//
// random-access-file 4.1.2 hole-punches through the OPTIONAL native addon
// fs-native-extensions, and when the addon is missing its _del is
//
//     if (!fsext) return req.callback(null)            random-access-file/index.js:175
//
// — a SILENT SUCCESS that frees zero bytes. client/android/app/build.gradle EXCLUDES that
// .so on armeabi-v7a and x86, so this is the shipped behaviour on a real part of the fleet.
//
// ⚠ THIS DELIBERATELY DOES NOT STUB hypercore's clear(). The whole failure mode is that
// clear() runs to completion, drops the bitfield and reports SUCCESS while the blocks file
// keeps every byte — a stub one layer up would test a fiction and would hide exactly the
// thing measureDriveBytes exists to catch. Corestore builds each backing file through a
// storage factory it keeps on the instance (Hypercore.defaultStorage), so replacing that
// factory wraps the REAL random-access-file instances and changes precisely one thing.
//
// Safe to patch after construction: the only file corestore opens synchronously in its
// constructor is primary-key (Corestore._open, before its first await), and nothing ever
// trims that — every core's oplog/tree/data/bitfield is created later, from this factory.
function noTrimStore (store) {
  const raw = store.storage
  store.storage = (name) => {
    const file = raw(name)
    const del = file._del
    file._del = function (req) {
      // req.size === Infinity is ftruncate, not a punch — RAF services that without the
      // addon on every platform, so leave it real.
      if (req.size === Infinity) return del.call(this, req)
      req.callback(null)
    }
    return file
  }
  return store
}

// THE SAME TRICK, AIMED AT THE CAPABILITY PROBE'S OWN SCRATCH FILE AND AT NOTHING ELSE.
//
// probeHolePunch builds its scratch file through the store's storage factory under the name
// 'punch-probe-<random>/data' (sdk/serve.js), so a factory wrapper keyed on that prefix
// reaches exactly the file the probe writes, stats and punches — and leaves every core's real
// oplog/tree/data/bitfield, and therefore the reclaim pass's own clear(), completely alone.
//
// That separation is the whole point. Scenarios J-L are about what the PROBE concludes and
// what the handler then does with the conclusion; a wrapper that also crippled the blob core
// would be moving two things at once and neither result would mean anything.
function probeStore (store, patch) {
  const raw = store.storage
  store.storage = (name) => {
    const file = raw(name)
    if (name.startsWith('punch-probe-')) patch(file)
    return file
  }
  return store
}

// An errno the way random-access-storage delivers one — through the request callback, with a
// .code, which is the field probeHolePunch lifts into its `reason` string.
const errno = (code) => Object.assign(new Error(code), { code })

// The five storage behaviours the probe has to tell apart, each imposed at random-access-file's
// own request handlers so the probe takes its real code path into them:
//   silentPunch  the 32-bit Android ABI — del succeeds, frees nothing   -> MEASURED cannot punch
//   rejectPunch  exFAT / FAT32 / a network mount — del REJECTS          -> MEASURED cannot punch
//   failWrite    ENOSPC, a full disk (when reclaim matters most)        -> INCONCLUSIVE
//   failStat     EMFILE, the corestore fd pool mid feed-open            -> INCONCLUSIVE
//   truncPunch   a filesystem that really does free the bytes           -> MEASURED can punch
const silentPunch = () => (file) => {
  const del = file._del
  file._del = function (req) { if (req.size === Infinity) return del.call(this, req); req.callback(null) }
}
const rejectPunch = (code) => (file) => {
  const del = file._del
  file._del = function (req) { if (req.size === Infinity) return del.call(this, req); req.callback(errno(code)) }
}
const failWrite = (code) => (file) => { file._write = (req) => req.callback(errno(code)) }
const failStat = (code) => (file) => { file._stat = (req) => req.callback(errno(code)) }

// ⚠ WHY THE PUNCHABLE SIDE IS SIMULATED TOO, RATHER THAN JUST "USE A PLAIN CORESTORE".
// Whether a real store can punch depends on an OPTIONAL native addon (fs-native-extensions)
// AND on the filesystem under it, so a scenario built on a plain store would be asserting a
// property of the HOST, not of this repo: green here, red on a box that lacks the addon or
// runs the temp dir off exFAT or a network mount. This is the exact mirror of noTrimStore, at
// the same layer — a del of a finite range that really does drop the allocation. It truncates
// AT the hole offset, so it frees MORE than a punch would (the tail goes with it), which the
// probe does not care about in the slightest: it requires a drop of at least half the hole and
// refuses an allocation that GREW, and both hold. Scenario K probes this host's real storage
// alongside and REPORTS its verdict, so a host that cannot punch is still visible to whoever
// runs the lane.
//
// ⚠ ONE NARROWING since the wide probe stage (sdk/serve.js runWideProbe): a SIMULATED confirm
// still runs that stage's truncates and its above-4-GiB write against the REAL filesystem
// under the temp dir. On POSIX that costs nothing anywhere (files are sparse by nature); on
// Windows it additionally needs random-access-file's sparse flag, i.e. fs-native-extensions
// present — without it an NTFS ftruncate to ~5 GiB allocates five real GiB and the stage
// reads inconclusive, failing J/K(5)/N here. Every Windows box this lane targets has the
// addon (it is RAF's own optional dep, and the measured punch numbers quoted in sdk/serve.js
// were taken with it); production is unaffected either way, because without a WORKING small
// punch the wide stage is unreachable by construction.
const truncPunch = () => (file) => {
  const del = file._del
  file._del = function (req) { if (req.size === Infinity) return del.call(this, req); return this._truncate(req) }
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
// Block-level predicates over any blob core (the later scenarios each own a drive);
// stored/cleared are the fixture drive's, exactly as A-D have always used them.
const hasAll = async (core, b) => {
  for (let i = b.blockOffset; i < b.blockOffset + b.blockLength; i++) {
    if (!(await core.has(i))) return false
  }
  return true
}
const hasNone = async (core, b) => {
  for (let i = b.blockOffset; i < b.blockOffset + b.blockLength; i++) {
    if (await core.has(i)) return false
  }
  return true
}
const stored = (b) => hasAll(blobs.core, b)
const cleared = (b) => hasNone(blobs.core, b)
const playlist = (names, { end = false } = {}) =>
  '#EXTM3U\n#EXT-X-TARGETDURATION:2\n' +
  names.map((n) => `#EXTINF:2,\n${n}`).join('\n') + '\n' +
  (end ? '#EXT-X-ENDLIST\n' : '')

// ONE PROBE AGAINST ONE THROWAWAY STORE — the harness scenarios K and N read verdicts
// through. A real core is put through the real factory first, as in production; `litter` is
// whatever the probe left in the store root. The probe TRUNCATES and then unlinks, and
// corestore builds the factory with rmdir:true, so its directory goes with it. Nothing in
// this repo sweeps punch-probe-*, and the file is 512 KiB (~5 GiB LOGICAL once the wide
// stage has run), so litter here is a real (if small) disk leak on the platform least able
// to afford one.
const probeCase = async (patch) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reclaim-probe-'))
  let s = new Corestore(d)
  if (patch) s = probeStore(s, patch)
  await s.ready()
  const dr = new Hyperdrive(s.namespace('feed'))
  await dr.ready()
  await dr.put('/seg1.ts', seg(1)) // a real core through the real factory, as in production
  const r = await probeHolePunch(dr)
  const litter = fs.readdirSync(d).filter((n) => n.startsWith('punch-probe-'))
  await dr.close()
  await s.close()
  try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  return { r, litter }
}

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

log('E: a storage layer that cannot hole-punch — clear() succeeds and frees NOTHING')
{
  // THE 32-BIT ABI. Everything below runs against a corestore whose random-access-file
  // instances take the addon-less _del branch (see noTrimStore): the pass runs, the
  // bitfield drops, clear() returns cleanly and not one byte is released.
  //
  // The BASELINE first, on normal storage — the same fixture through the same pass — so
  // the flat line below is measured against something rather than asserted into the void.
  // ⚠ fs-native-extensions is an OPTIONAL dependency: a host that lacks it cannot punch
  // either, and there the contrast is UNOBSERVABLE, not failed. So it is reported, never
  // asserted, and none of E's assertions depend on it.
  const punchDrive = new Hyperdrive(store.namespace('punch'))
  await punchDrive.ready()
  for (let i = 1; i <= 11; i++) await punchDrive.put(`/seg${i}.ts`, seg(i))
  await punchDrive.put('/seg12.ts', Buffer.alloc(8 * 1024, 12)) // the small live window — see below
  const punchWin = playlist(['seg12.ts'])
  await punchDrive.put('/live.m3u8', Buffer.from(punchWin))
  const punchBefore = await measureDriveBytes(punchDrive)
  await reclaimBelowWindow(punchDrive, punchWin)
  const punchAfter = await measureDriveBytes(punchDrive)
  log(punchBefore && punchAfter && punchAfter.blobs < punchBefore.blobs
    ? `  · baseline: on THIS host a working trim frees ${punchBefore.blobs - punchAfter.blobs} blob bytes on the same fixture (${punchBefore.blobs} -> ${punchAfter.blobs})`
    : '  · baseline: THIS host cannot hole-punch either (no fs-native-extensions) — the simulation below is faithful but its contrast is unobservable here')
  await punchDrive.close()

  const eDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reclaim-notrim-'))
  const eStore = noTrimStore(new Corestore(eDir))
  await eStore.ready()
  const eDrive = new Hyperdrive(eStore.namespace('feed'))
  await eDrive.ready()

  // ⚠⚠ THE LIVE WINDOW HERE IS ONE 8 KiB SEGMENT ON PURPOSE. DO NOT "TIDY" IT BACK INTO TWO
  // FULL-SIZE ONES — that silently disables this entire scenario, and it disables it QUIETLY:
  // every assertion below simply stops being reached and the lane hangs on the onOverBudget
  // wait rather than telling you why.
  //
  // A replica is NOT judged against reclaimBudgetBytes. It is judged against
  // max(reclaimBudgetBytes, RECLAIM_WINDOW_BUDGET_K × the live window this pass observed),
  // k = 3 (sdk/serve.js _effectiveBudget). With a window of 2 × 160 KB the ceiling would be
  // max(65536, 3 × 327,680) = 983,040 bytes and this replica — 548,864 measured bytes, see
  // below — never crosses it. One 8 KiB segment puts the scaled term at 3 × 8,192 = 24,576,
  // comfortably UNDER the 64 KiB floor, so the configured BUDGET is the ceiling that actually
  // applies and info.budgetBytes === info.effectiveBudgetBytes. That is what keeps this
  // section testing the thing it is named for — a measurement catching a no-op trim — instead
  // of accidentally testing the window arithmetic, which has a scenario of its own (I).
  //
  // ⚠⚠ AND GROWING THE FIXTURE IS THE WRONG LEVER, FOR A REASON WORTH WRITING DOWN ONCE.
  // On Windows/NTFS measureDriveBytes LAGS the writes: st.blocks is charged for the
  // hyperblobs data file's extending writes by the lazy writer, not at write() time. Measured
  // 2026-08-13 on a fixture of 160 KB segments, immediately after the puts and again four
  // seconds later, with NO write in between:
  //
  //     12 segments (1.9 MiB logical)   548,864 -> 2,318,336 bytes
  //     40 segments (6.3 MiB logical)   548,864 -> 6,905,856 bytes
  //     80 segments (12.5 MiB logical)  548,864 -> 13,459,456 bytes
  //
  // Read only the left column and the measurement looks FLAT — magnificently indifferent to
  // how much media is in the drive — and it is tempting to conclude that st.blocks simply does
  // not track these writes here. It does. That reading is an artefact of taking the number
  // INSIDE the lag: it is not flat, it is LATE, by up to about a second, and it settles on the
  // truth. The consequence is what matters: any assertion whose threshold falls between those
  // two columns fires or does not fire depending on how long the scenario's own setup happened
  // to take. This lane had exactly that flake — about one run in six, in scenario I — before
  // the fixtures were given a structural margin instead of a tuned threshold.
  //
  // Shrinking the WINDOW has no such hazard: windowBytes is a sum of blob byteLengths, a
  // logical number the filesystem has no opinion about at any moment. That is why it is the
  // lever this scenario pulls.
  for (let i = 1; i <= 11; i++) await eDrive.put(`/seg${i}.ts`, seg(i))
  await eDrive.put('/seg12.ts', Buffer.alloc(8 * 1024, 12))
  const eRef = {}
  for (let i = 1; i <= 12; i++) eRef[i] = (await eDrive.entry(`/seg${i}.ts`)).value.blob
  const eBlobs = await eDrive.getBlobs()
  const win = playlist(['seg12.ts'])
  await eDrive.put('/live.m3u8', Buffer.from(win))

  // Every write is done BEFORE this reading, so the ONLY thing that happens between the two
  // measurements is the reclaim pass itself — no fixture growth can mask a missing drop.
  const before = await measureDriveBytes(eDrive)
  assert(before !== null, 'the replica is measurable on this platform (measureDriveBytes)')

  // Tens of KB, not the shipped 512 MiB: the budget has to be crossed by a fixture that
  // writes in a blink. The interval is long enough that the second serve below is
  // PROVABLY inside the throttle window.
  const BUDGET = 64 * 1024
  const calls = []
  const handler = driveHandler(eDrive, {
    reclaim: true,
    reclaimIntervalMs: 5000,
    reclaimBudgetBytes: BUDGET,
    onOverBudget: (d, info) => calls.push({ drive: d, info })
  })
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const r = await httpGet(port, '/live.m3u8')
  assert(r.status === 200 && r.body.toString() === win, 'live playlist serves intact on the crippled replica')
  await waitFor(() => hasNone(eBlobs.core, eRef[1]), 10000, 'the reclaim pass to run')
  assert(await hasNone(eBlobs.core, eRef[1]), 'clear() reported SUCCESS — the bitfield below the window really did drop')
  assert(await hasAll(eBlobs.core, eRef[12]), 'and the live window is untouched, exactly as on a working platform')

  // ⚠ THE POINT OF THIS SECTION. Nothing on the clear path can tell these two platforms
  // apart: the call succeeded and the bitfield dropped on both. Only the MEASUREMENT can.
  await waitFor(() => calls.length > 0, 10000, 'onOverBudget')
  const after = await measureDriveBytes(eDrive)
  assert(after.blobs >= before.blobs,
    `the footprint did NOT drop (${before.blobs} -> ${after.blobs} blob bytes) — the pass freed nothing`)
  assert(calls.length === 1, 'onOverBudget fired once the measured replica crossed the budget')

  // The verdict rides the SAME per-drive throttle as the clear — there is no second timer,
  // so a 300-cell grid cannot turn this into a callback storm (or a stat() storm).
  const r2 = await httpGet(port, '/live.m3u8')
  assert(r2.status === 200, 'live playlist serves again, well inside reclaimIntervalMs')
  await sleep(400)
  assert(calls.length === 1, 'and onOverBudget did NOT fire again — at most once per interval per drive')

  const { drive: d, info } = calls[0]
  assert(d === eDrive, 'the callback names the drive that is over budget')
  assert(info.budgetBytes === BUDGET, 'info.budgetBytes is the configured budget')
  assert(info.bytes > BUDGET, `info.bytes (${info.bytes}) is over it — that is why it fired`)
  assert(info.bytes === info.blobs + info.meta, 'info splits the total into blobs + meta (what tells a rotation from a leak)')
  assert(info.blobs > 0 && info.meta > 0, 'both cores are counted — metadata is not free on a feed that writes every ~2 s')
  // The trigger discriminator the metadata budget added (scenario O owns the 'meta' side).
  assert(info.trigger === 'budget', `a blob-ceiling verdict names itself (trigger "${info.trigger}")`)
  assert(info.metaBudgetBytes === 64 * 1024 * 1024, 'info carries the metadata budget too — the shipped 64 MiB default here, far above this fixture\'s bee')
  // The two fields the window scaling added. Here the window is deliberately tiny, so the
  // configured floor wins and the effective ceiling IS the configured one — which is the
  // whole reason the fixture above is shaped the way it is. Scenario I takes the other branch.
  assert(info.windowBytes === 8 * 1024, `info.windowBytes is the live window this pass observed (${info.windowBytes})`)
  assert(info.effectiveBudgetBytes === BUDGET,
    'and info.effectiveBudgetBytes is the configured floor — 3 × this window (24,576) is below it')

  // ⚠ AND IT ONLY GOT THIS FAR BECAUSE A MEASURED PROBE SAID IT COULD. The budget is gated on
  // probeHolePunch: unless this store's filesystem has been PROVED unable to free bytes on a
  // punch, onOverBudget is unreachable. noTrimStore's addon-less _del is exactly that proof.
  const est = handler.reclaimStatus()
  assert(est.punch && est.punch.ok === true && est.punch.canPunch === false,
    'the capability probe MEASURED that this storage cannot punch (that is what armed the budget)')
  assert(est.punch.reason === 'measured' && est.punch.freed === 0,
    `by punching a hole and watching nothing happen (freed ${est.punch.freed} bytes)`)
  assert(est.budgetActive === true && est.budgetBytes === BUDGET,
    'so reclaimStatus() reports the budget armed, at the configured number')
  assert(est.punchTries === 1, 'and one probe was enough — a MEASURED verdict is never re-run')
  server.close()
  await eDrive.close()
  await eStore.close()
  try { fs.rmSync(eDir, { recursive: true, force: true }) } catch {}
}

log('F: the 64-bit control — a replica under budget never calls onOverBudget')
{
  // The non-regression half of E, and it carries the same weight. onOverBudget is the
  // trigger for a WHOLE-REPLICA rotation (purge + reopen), which costs the viewer a refetch
  // of the live window. Where clear() works the replica settles at ~one window and this
  // callback is dead code; a budget that fires on a healthy device is worse than the leak
  // it exists to bound. No reclaimBudgetBytes is passed on purpose — this asserts the
  // SHIPPED default (512 MiB).
  const fDrive = new Hyperdrive(store.namespace('control'))
  await fDrive.ready()
  for (let i = 1; i <= 4; i++) await fDrive.put(`/seg${i}.ts`, seg(i))
  const fRef = {}
  for (let i = 1; i <= 4; i++) fRef[i] = (await fDrive.entry(`/seg${i}.ts`)).value.blob
  const fBlobs = await fDrive.getBlobs()
  const calls = []
  const server = http.createServer(driveHandler(fDrive, {
    reclaim: true, reclaimIntervalMs: 0, onOverBudget: (d, info) => calls.push(info)
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const win = playlist(['seg3.ts', 'seg4.ts'])
  await fDrive.put('/live.m3u8', Buffer.from(win))
  const res = await httpGet(server.address().port, '/live.m3u8')
  assert(res.status === 200, 'live playlist serves intact (reclaim: true, default budget)')

  // Witness that the pass RAN. Without this, "the callback never fired" would assert
  // nothing whatsoever — the budget check is chained onto this very clear.
  await waitFor(() => hasNone(fBlobs.core, fRef[1]), 10000, 'the reclaim pass to run')
  assert(await hasNone(fBlobs.core, fRef[1]), 'the pass ran — blocks below the window are cleared')
  const m = await measureDriveBytes(fDrive)
  assert(m !== null, 'and the replica is measurable, so the budget was really evaluated')
  assert(m.bytes < 512 * 1024 * 1024, `with a footprint far under the shipped budget (${m.bytes} bytes)`)
  await sleep(400)
  assert(calls.length === 0, 'onOverBudget was NEVER called — it stays dead code on a healthy replica')
  server.close()
  await fDrive.close()
}

log('G: reclaimIdleFeed — the sweep over a feed nobody is watching')
{
  // Reclaim is otherwise only reachable from a live playlist SERVE, and only the ACTIVE
  // feed is ever served — so a warm feed cache has one feed shrinking and N-1 frozen at
  // whatever size the session left them. This is the entry point that sweeps those N-1,
  // and it derives its own window from the drive's own /index.m3u8.
  const gDrive = new Hyperdrive(store.namespace('idle'))
  await gDrive.ready()
  for (let i = 1; i <= 3; i++) await gDrive.put(`/seg${i}.ts`, seg(i))
  const gRef = {}
  for (let i = 1; i <= 3; i++) gRef[i] = (await gDrive.entry(`/seg${i}.ts`)).value.blob
  const gBlobs = await gDrive.getBlobs()

  // (1) NO PLAYLIST — a feed the viewer never tuned, or one already purged. It must return,
  // and return PROMPTLY: /index.m3u8 is the rolling blob par excellence and a plain get()
  // on a superseded one waits forever, which is why the read is raced against a 5 s bound
  // instead of awaited. A sweep that wedges here takes the caller's whole pass with it.
  const t = Date.now()
  await reclaimIdleFeed(gDrive)
  assert(Date.now() - t < 5000, 'no /index.m3u8 — the sweep returns without reaching its 5 s read bound')
  assert(await hasAll(gBlobs.core, gRef[1]), 'and it touched nothing (there is no window to take a floor from)')

  // (2) VOD — the same invariant scenario B guards on the serve path, restated because this
  // entry point never goes through the serve path's ENDLIST branch at all. seg1 sits below
  // the listed set, so a wrong sweep would take it.
  await gDrive.put('/index.m3u8', Buffer.from(playlist(['seg2.ts', 'seg3.ts'], { end: true })))
  await reclaimIdleFeed(gDrive)
  assert(await hasAll(gBlobs.core, gRef[1]), '#EXT-X-ENDLIST — the sweep never reclaims VOD (seg1 survives below the listed set)')

  // (3) LIVE — same window, no ENDLIST: now the floor is seg2's offset and everything under
  // it goes, exactly as the serve path would have freed it.
  await gDrive.put('/index.m3u8', Buffer.from(playlist(['seg2.ts', 'seg3.ts'])))
  await reclaimIdleFeed(gDrive)
  assert(await hasNone(gBlobs.core, gRef[1]), 'a live /index.m3u8 — the sweep frees the blocks below the window')
  assert((await hasAll(gBlobs.core, gRef[2])) && (await hasAll(gBlobs.core, gRef[3])), 'and leaves the window itself intact')
  await gDrive.close()
}

log('H: inflight / whenDrained — the drain surface a rotation purges behind')
{
  // drive.purge() closes the drive and unlinks both cores, and the player purges on every
  // eviction and every rotation-away. A pump still piping a segment out of that drive dies
  // mid-response: the client sees a truncated body on a request that already answered 200,
  // and the player takes the hard-error path. These two methods are how a host waits.
  const hDrive = new Hyperdrive(store.namespace('drain'))
  await hDrive.ready()
  const BIG = 4 * 1024 * 1024
  await hDrive.put('/big.ts', Buffer.alloc(BIG, 0x5b))
  // readIdleMs is put far out of the way on purpose: this scenario STALLS a read (by never
  // reading the response) and the stalled-read abort would otherwise tear it down
  // mid-assertion. whenDrained's default timeout is that same number, so every wait below
  // passes its own explicit one. The mount is an ANCILLARY view of the same drive
  // (media: false) — poster art and guide files reach the handler exactly that way.
  const handler = driveHandler(hDrive, { readIdleMs: 60000, mounts: { '/assets': hDrive } })
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  assert(handler.inflight(hDrive) === 0, 'an idle drive has nothing in flight')
  let t = Date.now()
  await handler.whenDrained(hDrive, 5000)
  assert(Date.now() - t < 1000, 'whenDrained on an idle drive resolves at once — a sweep over a warm cache costs no timers')

  // A HEAD sends no body, so a purge cannot truncate it; it must never hold a rotation up.
  assert((await httpHead(port, '/big.ts')) === 200, 'HEAD /big.ts answers 200')
  assert(handler.inflight(hDrive) === 0, 'a HEAD is never counted in flight')

  // Hold a media read open. The response is never read, so TCP backpressure parks the pump
  // mid-body — the read stays genuinely in flight for as long as this section needs it.
  // The counter is taken before pump writes the first byte, so by the time these headers
  // land the read is already registered; nothing here has to poll for it.
  const held = await httpHold(port, '/big.ts')
  assert(held.statusCode === 200, 'a media read is answered 200 and starts piping')
  assert(handler.inflight(hDrive) === 1, 'a media read in progress IS counted in flight')

  // Ancillary reads are deliberately not counted: a truncated poster costs a grid cell, and
  // making a rotation wait on a 300-cell grid refresh is the wrong trade in the other
  // direction. Its headers have landed, so its pump is demonstrably running.
  const anc = await httpHold(port, '/assets/big.ts')
  assert(anc.statusCode === 200, 'the mounted (ancillary) read is answered 200 too')
  assert(handler.inflight(hDrive) === 1, 'an ancillary (media: false) read is NOT counted, even mid-body')
  await drain(anc)

  // THE TIMEOUT PATH. A wedged read must DELAY a rotation, not cancel it — so this settles
  // rather than waiting on a read that may never end.
  t = Date.now()
  await handler.whenDrained(hDrive, 200)
  const waited = Date.now() - t
  assert(waited >= 150 && waited < 3000, `whenDrained RESOLVES on its timeout (${waited} ms) with a read still wedged`)
  assert(handler.inflight(hDrive) === 1, 'and it resolved by timing out, not because the read had finished')

  // A non-finite timeout means DO NOT WAIT — deliberately not "wait forever", which would
  // hand a caller a rotation that never happens.
  t = Date.now()
  await handler.whenDrained(hDrive, Infinity)
  assert(Date.now() - t < 1000 && handler.inflight(hDrive) === 1, 'a non-finite timeout means do not wait, not wait forever')

  // THE DRAIN PATH: let the held read finish and the wait must settle on its own, nowhere
  // near the timeout it was given.
  t = Date.now()
  const drained = handler.whenDrained(hDrive, 15000)
  const body = drain(held)
  await drained
  const settled = Date.now() - t
  assert(settled < 10000, `whenDrained resolves the moment the last read finishes (${settled} ms, not its 15 s timeout)`)
  assert(handler.inflight(hDrive) === 0, 'with the in-flight count back to zero')
  assert((await body) === BIG, 'and the drained read delivered its whole body — the wait was not an abort')
  server.close()
  await hDrive.close()
}

log('I: the window-scaled budget — the ceiling is 3 × the OBSERVED live window, not the flat number')
{
  // WHAT THIS GUARDS, AND WHY IT IS NOT A HYPOTHETICAL. The first version of the budget
  // compared a flat 512 MiB against a live window that is OPERATOR-SETTABLE: hls_time up to
  // 30 s × hls_list_size up to 64 segments is a 1920-second window, and ONE healthy window of
  // that at 2 Mbit/s is 458 MiB — 90% of the budget — while any channel over ≈2.24 Mbit/s is
  // over it OUTRIGHT. Worse, the per-drive throttle is keyed on the drive and a rotation hands
  // the host a NEW drive, so nothing damped the retrigger: a healthy arm64 phone on such a
  // channel would have rotated its replica once per reclaim tick for as long as it watched.
  // The fix is arithmetic (sdk/serve.js _effectiveBudget): the ceiling is
  // max(configured, RECLAIM_WINDOW_BUDGET_K × the window this very pass measured), k = 3.
  //
  // Both halves below run on the CRIPPLED storage of scenario E, so the probe measures
  // "cannot punch" and the budget is armed. The window arithmetic is then the only thing
  // standing between this replica and onOverBudget, which is exactly what makes the first
  // half's silence mean something.
  const iDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reclaim-window-'))
  const iStore = noTrimStore(new Corestore(iDir))
  await iStore.ready()

  // (1) A HEALTHY WINDOW: 12 × 160 KB of media, of which the newest TEN are the live window
  // and two have rotated out below it — the ordinary steady state of a feed being watched.
  // Against a 64 KiB configured budget the replica is many times over the configured number
  // and must STILL not trip, because 3 × 1,638,400 = 4,915,200 is the ceiling that applies.
  //
  // ⚠ TEN OF TWELVE, AND THE MARGIN IS LOAD-BEARING — see the measurement note in E. This
  // replica measures 548,864 bytes if it is read inside NTFS's allocation lag and 2,318,336
  // once that has caught up, so an upper bound tuned to either number is a coin toss on how
  // long this scenario's own setup took (it flaked about one run in six that way). A ceiling
  // of 4,915,200 is over twice the SETTLED footprint, so the assertion holds whether the
  // allocation has caught up or not — here, and on the POSIX platforms where it never lagged.
  // Do not shrink the window back towards the drive's size to "make the test tighter".
  const IBUDGET = 64 * 1024
  const iDrive = new Hyperdrive(iStore.namespace('healthy'))
  await iDrive.ready()
  for (let i = 1; i <= 12; i++) await iDrive.put(`/seg${i}.ts`, seg(i))
  const iRef = {}
  for (let i = 1; i <= 12; i++) iRef[i] = (await iDrive.entry(`/seg${i}.ts`)).value.blob
  const iBlobs = await iDrive.getBlobs()
  const iWindowSegs = []
  for (let i = 3; i <= 12; i++) iWindowSegs.push(`seg${i}.ts`)
  const iWin = playlist(iWindowSegs)
  await iDrive.put('/live.m3u8', Buffer.from(iWin))

  const iCalls = []
  const iHandler = driveHandler(iDrive, {
    reclaim: true, reclaimIntervalMs: 0, reclaimBudgetBytes: IBUDGET, onOverBudget: (d, info) => iCalls.push(info)
  })
  const iServer = http.createServer(iHandler)
  await new Promise((resolve) => iServer.listen(0, '127.0.0.1', resolve))
  const iRes = await httpGet(iServer.address().port, '/live.m3u8')
  assert(iRes.status === 200, 'live playlist serves intact on the crippled replica')

  // ⚠ NON-VACUITY, IN THREE PARTS. "It never fired" is worth nothing unless everything else
  // that could have stopped it is shown NOT to have: the pass ran, the gate is open, and the
  // replica really is over the CONFIGURED number.
  await waitFor(() => hasNone(iBlobs.core, iRef[1]), 10000, 'the reclaim pass to run')
  await waitFor(() => iHandler.reclaimStatus().punch !== null, 10000, 'the capability probe to answer')
  const iSt = iHandler.reclaimStatus()
  assert(iSt.punch.ok === true && iSt.punch.canPunch === false, 'the probe MEASURED that this storage cannot punch')
  assert(iSt.budgetActive === true, 'so the budget is ARMED — nothing gates this replica but the arithmetic')
  // The number the handler scaled by, published through reclaimBelowWindow's third parameter
  // — the sink Reclaim reads before the budget check chained off the same pass. Taken here so
  // the bound below is stated in terms of the window this pass really observed, not a literal.
  const spans = []
  const ran = await reclaimBelowWindow(iDrive, iWin, (b) => spans.push(b))
  assert(ran === true, 'a pass over that window completes')
  // At most once per pass — but NOT "only when the whole listing resolved", which is what this
  // line used to claim. The sink is onWindowBytes(bytes, listed, resolved) and it fires for an
  // INCOMPLETE listing too (a segment the playlist names whose metadata entry has not reached
  // this replica contributes 0 bytes and says nothing about it), leaving Reclaim to extrapolate
  // bytes × listed/resolved and to keep the stored window MONOTONE — a short sum can only pull
  // the ceiling toward the flat floor, which is the one direction the arithmetic must not move
  // in. This sink is written as (b) => … and still works because the counts are POSITIONAL
  // extras; here the whole listing does resolve, so the sum below is the exact one.
  assert(spans.length === 1, 'and publishes the window span exactly once')
  assert(spans[0] === iWindowSegs.length * 160 * 1024, `as the summed blob byteLength of every listed segment (${spans[0]})`)

  const iM = await measureDriveBytes(iDrive)
  assert(iM.bytes > IBUDGET, `and the replica is ${(iM.bytes / IBUDGET).toFixed(1)}× the CONFIGURED budget (${iM.bytes} vs ${IBUDGET})`)
  assert(iM.bytes < 3 * spans[0], `while under 3 × the live window (${3 * spans[0]}), which is the ceiling that applies`)
  await sleep(400)
  assert(iCalls.length === 0,
    'onOverBudget was NEVER called — a replica holding ONE LIVE WINDOW is under budget by construction, at any hls_time × hls_list_size')
  iServer.close()
  await iDrive.close()

  // (2) THE SCALED CEILING IS THE ONE THAT FIRES, AND info SAYS SO. Same crippled storage, a
  // one-segment window, and a configured budget deliberately set BELOW 3 × that window — so
  // this time the larger of the two is the scaled term, which is the branch E cannot reach
  // (there the configured floor wins). A replica that frees NOTHING still grows through k
  // windows and still trips: that is the detection power the scaling was not allowed to cost.
  const SMALL = 8 * 1024
  const iScaled = new Hyperdrive(iStore.namespace('scaled'))
  await iScaled.ready()
  for (let i = 1; i <= 11; i++) await iScaled.put(`/seg${i}.ts`, seg(i))
  await iScaled.put('/seg12.ts', Buffer.alloc(SMALL, 12))
  const sWin = playlist(['seg12.ts'])
  await iScaled.put('/live.m3u8', Buffer.from(sWin))
  const sCalls = []
  const sServer = http.createServer(driveHandler(iScaled, {
    reclaim: true, reclaimIntervalMs: 0, reclaimBudgetBytes: SMALL, onOverBudget: (d, info) => sCalls.push(info)
  }))
  await new Promise((resolve) => sServer.listen(0, '127.0.0.1', resolve))
  const sRes = await httpGet(sServer.address().port, '/live.m3u8')
  assert(sRes.status === 200, 'live playlist serves intact with a configured budget below one window')
  await waitFor(() => sCalls.length > 0, 10000, 'onOverBudget')
  const sInfo = sCalls[0]
  assert(sInfo.budgetBytes === SMALL, 'info.budgetBytes still reports the CONFIGURED number, unchanged')
  assert(sInfo.windowBytes === SMALL, `info.windowBytes is the observed window (${sInfo.windowBytes})`)
  assert(sInfo.effectiveBudgetBytes === 3 * sInfo.windowBytes, 'and effectiveBudgetBytes is 3 × it')
  assert(sInfo.effectiveBudgetBytes > sInfo.budgetBytes, 'which is the LARGER of the two here — the scaled ceiling is the one that fired')
  assert(sInfo.bytes > sInfo.effectiveBudgetBytes, `with the replica over it (${sInfo.bytes} vs ${sInfo.effectiveBudgetBytes})`)
  sServer.close()
  await iScaled.close()
  await iStore.close()
  try { fs.rmSync(iDir, { recursive: true, force: true }) } catch {}
}

log('J: the punch gate — where the storage CAN hole-punch, the budget is switched OFF outright')
{
  // ⚠⚠ THE ASSERTION THAT PROVES THE REPAIR, AND THE ONE NEITHER E NOR F CAN MAKE. E shows the
  // no-punch side: a replica that frees nothing is caught. The other half of the contract is
  // that a replica on a filesystem which DOES free bytes is never rotated, however big it
  // happens to be at the moment it is measured — onOverBudget is the trigger for a
  // whole-replica purge and a refetch of the entire live window, and doing that to a device
  // whose reclaim is working is pure cost. F cannot observe the latch either: F never crosses
  // its budget, so "the callback did not fire" there is equally consistent with no gate at all.
  //
  // So: a replica PROVABLY over the effective budget, on a storage layer the probe MEASURES as
  // punchable. Nothing may be reported.
  const jDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reclaim-punch-'))
  const jStore = probeStore(new Corestore(jDir), truncPunch())
  await jStore.ready()
  const jDrive = new Hyperdrive(jStore.namespace('feed'))
  await jDrive.ready()
  const JBUDGET = 64 * 1024
  for (let i = 1; i <= 11; i++) await jDrive.put(`/seg${i}.ts`, seg(i))
  // The thumbnail is the floor under the non-vacuity assertion below. Reclaim punches AROUND
  // it (scenario D), so these bytes are retained on EVERY platform whatever the punch does —
  // which is what keeps "the replica is over the ceiling" true on POSIX allocation accounting,
  // where the freed bytes really do leave the measurement, and not only on this host's.
  await jDrive.put(THUMB_PATH, Buffer.alloc(512 * 1024, 0x7a))
  await jDrive.put('/seg12.ts', Buffer.alloc(8 * 1024, 12))
  const jRef = (await jDrive.entry('/seg1.ts')).value.blob
  const jBlobs = await jDrive.getBlobs()
  const jWin = playlist(['seg12.ts'])
  await jDrive.put('/live.m3u8', Buffer.from(jWin))

  const jCalls = []
  const jHandler = driveHandler(jDrive, {
    reclaim: true, reclaimIntervalMs: 0, reclaimBudgetBytes: JBUDGET, onOverBudget: (d, info) => jCalls.push(info)
  })
  const jServer = http.createServer(jHandler)
  await new Promise((resolve) => jServer.listen(0, '127.0.0.1', resolve))
  const jPort = jServer.address().port
  const jRes = await httpGet(jPort, '/live.m3u8')
  assert(jRes.status === 200, 'live playlist serves intact on the punchable replica')

  await waitFor(() => hasNone(jBlobs.core, jRef), 10000, 'the reclaim pass to run')
  await waitFor(() => jHandler.reclaimStatus().punch !== null, 10000, 'the capability probe to answer')
  const jSt = jHandler.reclaimStatus()
  // reclaimStatus() surfaces ok/canPunch/reason/freed/wideFreed and deliberately not the raw
  // before/after pairs — freed (and, when the wide stage ran, wideFreed) are the numbers that
  // decided the verdict and the ones an operator needs in a log.
  assert(jSt.punch.ok === true && jSt.punch.canPunch === true,
    `the probe MEASURED that this storage frees bytes on a punch (reason "${jSt.punch.reason}", freed ${jSt.punch.freed})`)
  assert(jSt.budgetActive === false, 'so the budget is switched OFF for the life of the handler (reclaimStatus().budgetActive)')
  assert(jSt.budgetBytes === JBUDGET, 'while budgetBytes still reports the number the host configured')

  // ⚠ NON-VACUITY. "Never fired" only means the gate worked if the threshold was really
  // crossed. The ceiling here is max(64 KiB, 3 × the 8 KiB window) = 64 KiB, and the replica
  // is far over it even AFTER a real punch has freed everything it can.
  const jCeiling = Math.max(JBUDGET, 3 * 8 * 1024)
  const jM = await measureDriveBytes(jDrive)
  assert(jM.bytes > jCeiling,
    `the replica IS over the effective budget (${jM.bytes} vs ${jCeiling}) — an armed budget would have fired here`)
  await sleep(400)
  assert(jCalls.length === 0, 'and onOverBudget was NEVER called — the punch verdict gates it out entirely')

  // The latch outlives the tick that set it, and a MEASURED verdict is never re-run: the
  // filesystem under a store is one filesystem for the life of the handler.
  const jRes2 = await httpGet(jPort, '/live.m3u8')
  assert(jRes2.status === 200, 'a second serve, and a second reclaim tick behind it')
  await sleep(400)
  assert(jHandler.reclaimStatus().punchTries === 1, 'the probe ran exactly ONCE across both ticks')
  assert(jHandler.reclaimStatus().budgetActive === false && jCalls.length === 0, 'and the callback is still dead')
  jServer.close()
  await jDrive.close()
  await jStore.close()
  try { fs.rmSync(jDir, { recursive: true, force: true }) } catch {}
}

log('K: probe verdict classification — only the punch itself may produce a VERDICT')
{
  // ⚠⚠ THE DEFECT THIS PINS DOWN. probeHolePunch was once a single try block whose catch
  // returned { ok: true, canPunch: false, reason: 'punch-threw' } — so ANY throw ANYWHERE
  // ("could not allocate the buffer", "the disk is full", "out of file descriptors", "the
  // store was purged under us") latched SESSION-LIFETIME policy out of evidence about
  // something else entirely. ok: true means "this is a VERDICT", and a verdict is permanent:
  // a healthy arm64 phone that hit ENOSPC once had whole-replica rotation armed for the rest
  // of its session, on the strength of a full disk.
  //
  // Each case imposes ONE storage behaviour on the probe's own scratch file (probeStore) and
  // asserts the whole shape of the answer — whether it is a verdict, which way it fell, and
  // the reason string an operator reads out of reclaimStatus(). probeCase (top of file) is
  // the harness; scenario N runs the wide-stage case through the same one.

  // (1) THE 32-BIT ANDROID ABI: fs-native-extensions is absent, random-access-file's _del is
  // `if (!fsext) return req.callback(null)` and the punch frees zero bytes. A VERDICT — this
  // is the platform the entire byte budget exists for, and it has to be recognised with no
  // ABI detection whatsoever.
  const silent = await probeCase(silentPunch())
  assert(silent.r.ok === true && silent.r.canPunch === false, 'an addon-less del (silent success) is a MEASURED cannot-punch')
  assert(silent.r.reason === 'measured' && silent.r.freed === 0, 'reported as measured, with a drop of exactly zero bytes')
  assert(silent.litter.length === 0, 'and the probe left no scratch file behind — it truncates, then unlinks')

  // (2) exFAT, FAT32 and most network mounts: no FALLOC_FL_PUNCH_HOLE, no FSCTL_SET_ZERO_DATA,
  // so the del REJECTS. Also a verdict, and the clearest evidence there is. This is the case
  // the `!ran && !provedCannotPunch()` clause in _checkBudget exists for: on these filesystems
  // the reclaim PASS fails too, and under the old `if (ran)` rule the budget was then never
  // checked at all — on a device that also cannot reclaim, i.e. unbounded growth with no bound.
  const rejected = await probeCase(rejectPunch('EOPNOTSUPP'))
  assert(rejected.r.ok === true && rejected.r.canPunch === false, 'a del that REJECTS is a MEASURED cannot-punch too')
  assert(rejected.r.reason === 'punch-threw: EOPNOTSUPP', `with a reason that names the errno (${rejected.r.reason})`)

  // (3) ENOSPC on the write — a FULL DISK, which is exactly when reclaim matters most and
  // exactly the moment a false verdict would arm rotation forever on hardware that punches
  // perfectly well. INCONCLUSIVE, and therefore retryable (scenario L).
  const nospc = await probeCase(failWrite('ENOSPC'))
  assert(nospc.r.ok === false, 'a WRITE that fails is INCONCLUSIVE — not a verdict in either direction')
  assert(nospc.r.reason === 'write-threw: ENOSPC', `naming the step and the errno (${nospc.r.reason})`)

  // (4) EMFILE on the stat — random-access-storage routes an open error to every request
  // queued behind it, the corestore pool targets ~512 fds, and this probe fires on the FIRST
  // playlist serve of the first feed, concurrent with the feed open and the swarm join.
  const emfile = await probeCase(failStat('EMFILE'))
  assert(emfile.r.ok === false, 'a STAT that fails is INCONCLUSIVE too')
  assert(emfile.r.reason === 'stat-threw: EMFILE', `naming its own step (${emfile.r.reason})`)

  // ⚠ THE DISTINCTION THE WHOLE FIX RESTS ON, AS ONE ASSERTION. An inconclusive probe carries
  // canPunch: false as well, so `!canPunch` is NOT the question to ask — which is precisely why
  // Reclaim._provedCannotPunch asks the positive form (ok && canPunch === false) instead.
  assert(nospc.r.canPunch === false && emfile.r.canPunch === false,
    'both inconclusive answers carry canPunch: false as well — only `ok` tells a verdict from a shrug')

  // (5) A filesystem that really frees the bytes: the verdict that switches the budget off.
  const punches = await probeCase(truncPunch())
  assert(punches.r.ok === true && punches.r.canPunch === true, 'a del that really drops the allocation is a MEASURED can-punch')
  assert(punches.r.after <= punches.r.before && punches.r.freed >= 256 * 1024 / 2,
    `on a drop of at least half the punched hole (${punches.r.before} -> ${punches.r.after}, freed ${punches.r.freed})`)

  // AND THE REAL THING, on this host's own storage, through no wrapper at all. Whether it can
  // punch depends on an OPTIONAL native addon and on the filesystem under the temp dir, so
  // canPunch is REPORTED and never asserted — the same rule E's baseline follows. What IS
  // asserted is that against real random-access-file instances the probe reaches a VERDICT
  // rather than shrugging, whichever way it falls.
  const real = await probeCase(null)
  assert(real.r.ok === true && real.r.reason === 'measured',
    'against REAL storage the probe reaches a verdict, whichever way this host falls')
  log(`  · this host: canPunch=${real.r.canPunch} (${real.r.before} -> ${real.r.after} allocated bytes, freed ${real.r.freed})`)
}

log('L: probe retry accounting — an inconclusive answer is retried, a verdict never is')
{
  // ⚠ THE RULE THIS REPLACED was "the probe is not retried: a filesystem does not acquire the
  // ability to punch holes halfway through a session". True of the FILESYSTEM and false of the
  // PROBE. A verdict really is permanent — nothing ever re-runs one. But an inconclusive
  // answer is a property of the MOMENT (ENOSPC, EMFILE, a purge racing the probe, writeback
  // lag), and latching the fall-back-active answer on one of those is how a healthy device
  // ends up with rotation armed for the rest of the session. So: retried, bounded by
  // PROBE_MAX_TRIES = 3, at most once per reclaim tick. reclaimStatus().punchTries is the only
  // place any of that is visible from outside.
  //
  // ⚠ EVERY TICK BELOW ROTATES THE WINDOW BY ONE SEGMENT, so each serve's pass has something
  // new to free and the freed blocks WITNESS that the tick really ran. Without that,
  // "punchTries stopped at 3" would be indistinguishable from "nothing ran at all after the
  // third serve" — the assertion would pass for the wrong reason. No reclaimBudgetBytes is
  // passed: the shipped 512 MiB default is far above this fixture, so onOverBudget stays out
  // of the way and only the probe accounting moves.
  const TICKS = 5
  const ticks = async (store, ns) => {
    const d = new Hyperdrive(store.namespace(ns))
    await d.ready()
    const ref = {}
    for (let i = 1; i <= TICKS + 1; i++) await d.put(`/seg${i}.ts`, seg(i))
    for (let i = 1; i <= TICKS + 1; i++) ref[i] = (await d.entry(`/seg${i}.ts`)).value.blob
    const bl = await d.getBlobs()
    const handler = driveHandler(d, { reclaim: true, reclaimIntervalMs: 0, onOverBudget: () => {} })
    const server = http.createServer(handler)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const seen = []
    for (let k = 1; k <= TICKS; k++) {
      const names = []
      for (let j = k + 1; j <= TICKS + 1; j++) names.push(`seg${j}.ts`)
      await d.put('/live.m3u8', Buffer.from(playlist(names)))
      const res = await httpGet(port, '/live.m3u8')
      if (res.status !== 200) throw new Error(`tick ${k}: playlist serve failed`)
      await waitFor(() => hasNone(bl.core, ref[k]), 10000, `tick ${k}: the reclaim pass to run`)
      // The probe is counted a couple of microtasks after the pass resolves; settle before the
      // next serve so each tick starts a FRESH probe rather than joining the previous one
      // (Reclaim._punching collapses concurrent drives onto one probe on purpose).
      await sleep(400)
      seen.push(handler.reclaimStatus().punchTries)
    }
    const status = handler.reclaimStatus()
    server.close()
    await d.close()
    return { seen, status }
  }

  // (1) INCONCLUSIVE — the probe's write fails with ENOSPC every time. It must keep asking,
  // and it must stop asking. Everything else about this store is real, so the reclaim pass
  // itself works normally and each tick's cleared blocks prove it ran.
  const lDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reclaim-retry-'))
  const lStore = probeStore(new Corestore(lDir), failWrite('ENOSPC'))
  await lStore.ready()
  const inconclusive = await ticks(lStore, 'inconclusive')
  assert(inconclusive.seen.join(',') === '1,2,3,3,3',
    `an inconclusive probe is re-run once per tick and stops at PROBE_MAX_TRIES (tries after each of ${TICKS} ticks: ${inconclusive.seen.join(', ')})`)
  assert(inconclusive.status.punch.ok === false && inconclusive.status.punch.reason === 'write-threw: ENOSPC',
    'and the last answer is still the inconclusive one, with its reason kept for an operator')
  // ⚠ FAIL-ACTIVE, DELIBERATELY. A probe that cannot answer must leave the budget ARMED: on a
  // device that really cannot punch, disabling it costs ~0.9 GB/hour unbounded, while arming
  // it on a device that can costs one rotation. The asymmetry picks the answer.
  assert(inconclusive.status.budgetActive === true,
    'while the budget stays ARMED throughout — an inconclusive probe falls back to the pre-probe behaviour')

  // (2) A MEASURED VERDICT — the crippled storage of E, which the probe resolves on its first
  // try. Same five ticks, same rotating window, and it must never ask again: a filesystem does
  // not change its mind, and each re-probe is another 512 KiB write on a device with a disk
  // problem by definition.
  const mDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reclaim-verdict-'))
  const mStore = noTrimStore(new Corestore(mDir))
  await mStore.ready()
  const verdict = await ticks(mStore, 'verdict')
  assert(verdict.seen.join(',') === '1,1,1,1,1',
    `a MEASURED verdict is probed exactly once, however many ticks run (tries after each of ${TICKS} ticks: ${verdict.seen.join(', ')})`)
  assert(verdict.status.punch.ok === true && verdict.status.punch.canPunch === false,
    'and the verdict it holds is the measured cannot-punch')

  await lStore.close()
  await mStore.close()
  try { fs.rmSync(lDir, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(mDir, { recursive: true, force: true }) } catch {}
}

log('M: the trigger chain rides RANGED playlist serves — a Range header cannot opt a client out of the bound')
{
  // THE GAP THIS PINS. prefetchAfter (read-ahead + reclaim + budget + probe) used to be
  // wired only into the non-Range 200 branch, whose stream mirror is what fed it — the 206
  // branch pumped without mirroring and fired NOTHING. An HLS player that requests its
  // manifests with `Range:` therefore got no reclaim, no budget check and no probe: the
  // whole disk bound existed only by the grace of client politeness. (ExoPlayer does not
  // Range manifests — measured on-device — which is the only reason production never hit
  // it.)
  //
  // AND THE FIX HAS A HAZARD OF ITS OWN, asserted here too: the floor must come from the
  // WHOLE playlist, never from the served slice. A suffix range that cuts off the OLDEST
  // listed line would RAISE the floor (reclaimBelowWindow takes the minimum blob offset
  // over the URIs it can see) and the clear would eat a still-listed segment's blocks — so
  // the live request below is exactly that slice, and seg3 keeping its blocks is the
  // assertion that the trigger re-read the playlist from the drive instead of trusting it.
  const mDrive = new Hyperdrive(store.namespace('ranged'))
  await mDrive.ready()
  for (let i = 1; i <= 5; i++) await mDrive.put(`/seg${i}.ts`, seg(i))
  const mRef = {}
  for (let i = 1; i <= 5; i++) mRef[i] = (await mDrive.entry(`/seg${i}.ts`)).value.blob
  const mBlobs = await mDrive.getBlobs()
  const mServer = http.createServer(driveHandler(mDrive, { reclaim: true, reclaimIntervalMs: 0 }))
  await new Promise((resolve) => mServer.listen(0, '127.0.0.1', resolve))
  const mPort = mServer.address().port

  // (1) RANGED VOD FIRST — the ENDLIST invariant (scenario B) must hold on this branch
  // too, and it has to be shown BEFORE the live serve below legitimately clears seg1/seg2.
  const mVod = playlist(['seg4.ts', 'seg5.ts'], { end: true })
  await mDrive.put('/vod.m3u8', Buffer.from(mVod))
  const rVod = await httpGetRange(mPort, '/vod.m3u8', 'bytes=0-')
  assert(rVod.status === 206 && rVod.body.toString() === mVod, 'a ranged VOD playlist serves as a 206')
  await sleep(400)
  assert(await hasAll(mBlobs.core, mRef[1]), 'and reclaims NOTHING — the ENDLIST branch holds on ranged serves too')

  // (2) A RANGED LIVE SERVE, sliced to drop the oldest listed line.
  const mWin = playlist(['seg3.ts', 'seg4.ts', 'seg5.ts'])
  await mDrive.put('/live.m3u8', Buffer.from(mWin))
  const cut = mWin.indexOf('seg4.ts') // the slice begins at the seg4 line: seg3's is gone from it
  const rLive = await httpGetRange(mPort, '/live.m3u8', `bytes=${cut}-`)
  assert(rLive.status === 206 && rLive.body.toString() === mWin.slice(cut), 'a ranged live playlist serves the requested slice')
  assert(!rLive.body.toString().includes('seg3.ts'), 'fixture: the served slice really has LOST the oldest listed segment')
  await waitFor(() => hasNone(mBlobs.core, mRef[1]), 10000, 'reclaim to run off a ranged serve')
  assert(await hasNone(mBlobs.core, mRef[2]), 'blocks below the window are freed off a RANGED playlist serve')
  assert(await hasAll(mBlobs.core, mRef[3]),
    'seg3 — still listed, but MISSING from the served slice — keeps every block: the floor came from the whole playlist, not the slice')
  assert((await hasAll(mBlobs.core, mRef[4])) && (await hasAll(mBlobs.core, mRef[5])), 'and the rest of the window is intact as always')
  mServer.close()
  await mDrive.close()

  // (3) AND THE BUDGET RIDES IT TOO. E proves serve -> probe -> measure -> onOverBudget on
  // the 200 branch; this is the same crippled-storage shape reached ONLY through 206es, so
  // the whole chain — not merely the clear — is shown to fire without one non-Range serve.
  const bDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reclaim-ranged-'))
  const bStore = noTrimStore(new Corestore(bDir))
  await bStore.ready()
  const bDrive = new Hyperdrive(bStore.namespace('feed'))
  await bDrive.ready()
  for (let i = 1; i <= 11; i++) await bDrive.put(`/seg${i}.ts`, seg(i))
  await bDrive.put('/seg12.ts', Buffer.alloc(8 * 1024, 12)) // the one-segment window — E says why
  const bRef1 = (await bDrive.entry('/seg1.ts')).value.blob
  const bBlobs = await bDrive.getBlobs()
  const bWin = playlist(['seg12.ts'])
  await bDrive.put('/live.m3u8', Buffer.from(bWin))
  const bCalls = []
  const bHandler = driveHandler(bDrive, {
    reclaim: true, reclaimIntervalMs: 0, reclaimBudgetBytes: 64 * 1024, onOverBudget: (d, info) => bCalls.push(info)
  })
  const bServer = http.createServer(bHandler)
  await new Promise((resolve) => bServer.listen(0, '127.0.0.1', resolve))
  const rBudget = await httpGetRange(bServer.address().port, '/live.m3u8', 'bytes=10-')
  assert(rBudget.status === 206, 'the crippled replica serves its playlist as a 206')
  await waitFor(() => hasNone(bBlobs.core, bRef1), 10000, 'the reclaim pass to run off the ranged serve')
  await waitFor(() => bCalls.length > 0, 10000, 'onOverBudget off the ranged serve')
  const bSt = bHandler.reclaimStatus()
  assert(bSt.punch && bSt.punch.ok === true && bSt.punch.canPunch === false,
    'the capability probe ran and MEASURED off a ranged serve — no 200 was ever needed')
  assert(bCalls.length === 1 && bCalls[0].bytes > 64 * 1024,
    'and the budget verdict fired, with the replica over the configured number')
  bServer.close()
  await bDrive.close()
  await bStore.close()
  try { fs.rmSync(bDir, { recursive: true, force: true }) } catch {}
}

log('N: the wide-punch stage — an addon that casts punch lengths to 32 bits is caught at runtime')
{
  // THE CLASS THIS PINS WAS OBSERVED IN THE WILD (2026-08-13, the fs-native-extensions
  // android-arm rebuild — aliran-ops/fsext-fixed holds the evidence). The addon's C API
  // declared punch lengths as size_t: 32 bits on armeabi-v7a, so hypercore's below-window
  // clear — ONE punch of [0, floor), measured at 64,792,842,531 bytes on a long-lived feed
  // — truncated mod 4 GiB and freed nothing while returning success. The probe's own
  // 256 KiB punch fits in 32 bits and honestly worked: a one-stage probe MEASURED
  // canPunch: true and latched the budget OFF, i.e. the broken build (ba823ca8…) disarmed
  // the rotation safety net on the exact device whose real clears freed zero — strictly
  // worse than shipping no addon at all. That build never deployed (ccc8e363…, uint64_t
  // lengths, is what ships), but the probe must catch the CLASS at runtime rather than
  // trust addon correctness forever: sdk/serve.js runWideProbe punches a > 2^32 length
  // across one block parked above the 4 GiB line, and this scenario is that stage's
  // red/green.
  //
  // Simulated at the same layer as every other storage behaviour in this lane — the del
  // request — and NOT by stubbing the probe: the probe takes its real path end to end and
  // only the arithmetic a size_t cast performs is imposed on it.
  const modPunch = () => (file) => {
    const del = file._del
    file._del = function (req) {
      if (req.size === Infinity) return del.call(this, req) // ftruncate, not a punch — leave it real
      // The cast, exactly: the LENGTH arrives mod 2^32; the offset is untouched (off_t was
      // 64-bit in both builds — the defect was the length parameter alone).
      if (req.size % 2 ** 32 === req.size) return this._truncate(req) // fits 32 bits: a real, freeing punch (truncPunch's trick)
      // Lengths past 2^32: the real broken addon punches only [offset, offset + len mod
      // 2^32). Across the wide stage's file that range is hole from end to end — the one
      // allocated block sits above 4 GiB by construction — so the faithful truncated punch
      // frees zero bytes, and succeeding without touching the file is allocation-identical
      // to it on every host this lane runs on, with or without a native addon of its own.
      req.callback(null)
    }
  }
  const wide = await probeCase(modPunch())
  assert(wide.r.ok === true && wide.r.canPunch === false,
    'a punch that truncates its lengths mod 2^32 is a MEASURED cannot-punch')
  assert(wide.r.reason === 'wide-measured', `decided by the WIDE stage, and the reason says so (${wide.r.reason})`)
  // ⚠ NON-VACUITY. The small punch must have PASSED, or this scenario has quietly collapsed
  // into E/K(1) — the addon-less class — and the wide stage proved nothing at all.
  assert(wide.r.freed >= 256 * 1024 / 2,
    `the SMALL punch really freed (${wide.r.freed} bytes) — stage two, not stage one, refused this addon`)
  assert(wide.r.wideFreed === 0,
    `while the > 4 GiB punch freed nothing (${wide.r.wideFreed}) — it never reached the block above 2^32`)
  assert(wide.litter.length === 0, 'and the ~5 GiB-LOGICAL scratch file was truncated and unlinked like any other')
}

log('O: the METADATA budget — punch-independent, flat, and it survives the punch latch')
{
  // THE FINDING THIS PINS (vc10 soak, TCL Domestica, 2026-08-15): with the punch WORKING
  // and the blob bound holding the active feed's 2.8 GB logical at a flat ~128 MB
  // allocated, the store still grew 40 -> 191 MB overnight — all of it hyperbee METADATA
  // (data+tree growing together; ~2.7 MB/h on the watched channel's db core, ~1.1-1.2 MB/h
  // per warm feed's). A punch cannot free a bee: interior nodes referenced by CURRENT keys
  // live in old blocks, so clearing the db core in place would break drive.entry() — the
  // one reset is the host's purge + re-open. metaBudgetBytes is therefore a SECOND verdict
  // on the SAME throttled measurement: compared against info.meta ALONE, flat (a fresh
  // replica's metadata starts near zero and only appends — there is no healthy
  // operator-scaled floor like the blob window's), gated on NEITHER the punch latch NOR
  // the `ran` rule, and named in the info (trigger: 'meta') so a host can tell the two
  // rotations apart in the field.

  // Deterministic metadata bloat: every put appends the bee (key/value leaf + interior
  // nodes + oplog churn). The bodies are EMPTY so the BLOB core stays boring — this
  // fixture needs meta large and blobs small, the exact inverse of every fixture above.
  const EMPTY = Buffer.alloc(0)
  const bloatMeta = async (d, n) => { for (let i = 0; i < n; i++) await d.put(`/bloat/${i}`, EMPTY) }
  // Tens of KB, the same order as E's blob budget, crossed with structural margin (~1500
  // appends settle to several times this). The serve loop below re-serves until the
  // verdict lands rather than trusting one post-write measurement — the E note's NTFS
  // allocation lag applies to the bee's files exactly as it does to the blob file.
  const METABUDGET = 32 * 1024
  const serveUntil = async (port, p, fn, label) => {
    await waitFor(async () => {
      const r = await httpGet(port, p)
      if (r.status !== 200) throw new Error(`${label}: serve failed (${r.status})`)
      await sleep(100) // the verdict chain is fire-and-forget off the serve
      return fn()
    }, 15000, label)
  }

  // (1) THE ASSERTION THE SCENARIO IS NAMED FOR: a store the probe MEASURES as punchable —
  // the blob budget latched OFF for the life of the handler (J's latch, re-proven here off
  // reclaimStatus) — must still fire the META verdict. Control first, with a generous meta
  // budget: the latch holds, and a bee under its own ceiling adds no verdict of its own.
  //
  // ⚠⚠ THE ORDER IS THE TEST. The bee crosses its ceiling only AFTER the handler has
  // already served, probed and LATCHED — because that is the field sequence (the latch is
  // set on the first playlist serve of the session; the metadata crosses a day later), and
  // because the first version of this scenario bloated the bee up front, which let a meta
  // check gated on the latch pass green here: metaOn was captured before the first probe
  // ever ran, so the one tick that mattered was immune, and the always-on device the bound
  // exists for would have been the first place the regression showed. A mutation run found
  // it (gate metaOn on _budgetOff: the lane stayed green); with the bloat moved BELOW the
  // latch, both that mutation and its verdict-time twin now fail this sub-case.
  const oDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reclaim-meta-'))
  const oStore = probeStore(new Corestore(oDir), truncPunch())
  await oStore.ready()
  const oDrive = new Hyperdrive(oStore.namespace('feed'))
  await oDrive.ready()
  for (let i = 1; i <= 11; i++) await oDrive.put(`/seg${i}.ts`, seg(i))
  await oDrive.put('/seg12.ts', Buffer.alloc(8 * 1024, 12)) // the one-segment window — E says why
  const oWin = playlist(['seg12.ts'])
  await oDrive.put('/live.m3u8', Buffer.from(oWin))

  const oCallsControl = []
  const oControl = driveHandler(oDrive, {
    reclaim: true, reclaimIntervalMs: 0, reclaimBudgetBytes: 64 * 1024, metaBudgetBytes: 64 * 1024 * 1024, onOverBudget: (d, info) => oCallsControl.push(info)
  })
  const oControlServer = http.createServer(oControl)
  await new Promise((resolve) => oControlServer.listen(0, '127.0.0.1', resolve))
  const rO1 = await httpGet(oControlServer.address().port, '/live.m3u8')
  assert(rO1.status === 200, 'live playlist serves intact on the punchable, meta-bloated replica')
  await waitFor(() => oControl.reclaimStatus().punch !== null, 10000, 'the capability probe to answer')
  const oSt1 = oControl.reclaimStatus()
  assert(oSt1.punch.ok === true && oSt1.punch.canPunch === true && oSt1.budgetActive === false,
    'the probe measured PUNCHABLE and latched the blob budget off (J), with the meta budget present')
  assert(oSt1.metaBudgetBytes === 64 * 1024 * 1024 && oSt1.metaBudgetActive === true,
    'while reclaimStatus reports the metadata budget still armed — the latch does not cover it')
  const oM = await measureDriveBytes(oDrive)
  assert(oM.bytes > 64 * 1024, `non-vacuity: the replica IS over the blob budget (${oM.bytes} vs 65536) — only the latch keeps that verdict quiet`)
  await sleep(400)
  assert(oCallsControl.length === 0, 'and nothing fired: blob latched off, bee under its own generous ceiling')
  oControlServer.close()

  // …then the real sequence: a FRESH handler (the 5-minute rotation floor is per handler
  // and the control above must not eat it) with a meta budget the bee is still UNDER;
  // serve, let the probe LATCH the blob budget off; only then bloat the bee past its
  // ceiling and serve again. The verdict has to fire on a tick where _budgetOff is already
  // true — the state every tick of an always-on session is in.
  //
  // 512 KiB rather than (2)-(4)'s 32 KiB, because this sub-case needs UNDER first: a fresh
  // bee's four backing files allocate ~64 KiB units apiece on NTFS sparse accounting
  // (measureDriveBytes' note), so tens-of-KB thresholds are already crossed by an empty
  // core there. Half a MiB clears that floor about 2x on the under side, and ~4000 appends
  // settle several times over it on the over side — margins structural on both, per E.
  const META_LATCHED = 512 * 1024
  const oCalls = []
  const oHandler = driveHandler(oDrive, {
    reclaim: true, reclaimIntervalMs: 0, reclaimBudgetBytes: 64 * 1024, metaBudgetBytes: META_LATCHED, onOverBudget: (d, info) => oCalls.push({ drive: d, info })
  })
  const oServer = http.createServer(oHandler)
  await new Promise((resolve) => oServer.listen(0, '127.0.0.1', resolve))
  const rOArm = await httpGet(oServer.address().port, '/live.m3u8')
  assert(rOArm.status === 200, 'the meta handler serves before the bee has crossed anything')
  await waitFor(() => oHandler.reclaimStatus().punch !== null, 10000, 'the meta handler\'s probe to answer')
  assert(oHandler.reclaimStatus().budgetActive === false, 'the punch latch is SET, with the bee still under its ceiling')
  const oM0 = await measureDriveBytes(oDrive)
  assert(oM0.meta < META_LATCHED, `fixture: the bee really is under the meta ceiling before the bloat (${oM0.meta} vs ${META_LATCHED})`)
  await sleep(400)
  assert(oCalls.length === 0, 'and no verdict fired — armed is not over')
  await bloatMeta(oDrive, 4000) // NOW the bee crosses, with the latch already set
  await serveUntil(oServer.address().port, '/live.m3u8', () => oCalls.length > 0, 'the META verdict through the punch latch')
  const o1 = oCalls[0]
  assert(o1.drive === oDrive, 'the callback names the drive whose bee is over budget')
  assert(o1.info.trigger === 'meta', `and the verdict names the METADATA bound (trigger "${o1.info.trigger}")`)
  assert(o1.info.meta > META_LATCHED, `info.meta (${o1.info.meta}) is over metaBudgetBytes (${META_LATCHED}) — that alone is why it fired`)
  assert(o1.info.metaBudgetBytes === META_LATCHED, 'info.metaBudgetBytes echoes the configured number')
  assert(o1.info.bytes === o1.info.blobs + o1.info.meta, 'the blobs/meta split still adds up on a meta verdict')
  // …and effectiveBudgetBytes does NOT ride along. It is the BLOB ceiling — window × 3, or
  // the configured floor — and on a meta verdict it had no part in the decision. Shipping it
  // anyway put a number in the field log that reads as "the budget this rotation crossed"
  // and is nothing of the kind (worst here: the blob half is LATCHED OFF, so it is the
  // ceiling of a bound that cannot fire at all). Absent beats wrong. windowBytes stays: it
  // is an observation of the playlist, true on both verdicts.
  assert(o1.info.effectiveBudgetBytes === null, `effectiveBudgetBytes is null on a meta verdict (got ${o1.info.effectiveBudgetBytes})`)
  assert(Number.isFinite(o1.info.windowBytes), 'while windowBytes — an observation, not a ceiling — is still reported')
  const oSt2 = oHandler.reclaimStatus()
  assert(oSt2.budgetActive === false && oSt2.metaBudgetActive === true,
    'blob budget latched OFF, meta budget armed — the two verdicts really are gated independently')
  // The 5-minute rotation floor is SHARED: a second serve well inside it adds no verdict.
  const rO2 = await httpGet(oServer.address().port, '/live.m3u8')
  assert(rO2.status === 200, 'a second serve inside the rotation floor')
  await sleep(400)
  assert(oCalls.length === 1, 'the meta trigger shares the 5-minute rotation floor — one verdict, not a storm')
  oServer.close()
  await oDrive.close()
  await oStore.close()
  try { fs.rmSync(oDir, { recursive: true, force: true }) } catch {}

  // (2) NOT THE LATCH'S SHADOW: on the crippled storage (probe measures CANNOT punch, blob
  // budget ARMED) with the replica far UNDER the shipped blob default, the meta verdict
  // still fires — a blob budget that is armed-but-under must not silence the other bound.
  const o2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reclaim-meta2-'))
  const o2Store = noTrimStore(new Corestore(o2Dir))
  await o2Store.ready()
  const o2Drive = new Hyperdrive(o2Store.namespace('feed'))
  await o2Drive.ready()
  for (let i = 1; i <= 3; i++) await o2Drive.put(`/seg${i}.ts`, seg(i))
  await bloatMeta(o2Drive, 1500)
  await o2Drive.put('/live.m3u8', Buffer.from(playlist(['seg2.ts', 'seg3.ts'])))
  const o2Calls = []
  const o2Handler = driveHandler(o2Drive, {
    reclaim: true, reclaimIntervalMs: 0, metaBudgetBytes: METABUDGET, onOverBudget: (d, info) => o2Calls.push(info)
  })
  const o2Server = http.createServer(o2Handler)
  await new Promise((resolve) => o2Server.listen(0, '127.0.0.1', resolve))
  await serveUntil(o2Server.address().port, '/live.m3u8', () => o2Calls.length > 0, 'the META verdict beside an armed-but-under blob budget')
  assert(o2Calls[0].trigger === 'meta', 'trigger: meta — the blob ceiling was never crossed')
  const o2St = o2Handler.reclaimStatus()
  assert(o2St.punch.ok === true && o2St.punch.canPunch === false && o2St.budgetActive === true,
    'with the blob budget ARMED (measured cannot-punch) and simply under — the two coexist')
  const o2M = await measureDriveBytes(o2Drive)
  assert(o2M.bytes < 512 * 1024 * 1024, `non-vacuity: the replica (${o2M.bytes} bytes) is far under the shipped blob default`)
  o2Server.close()
  await o2Drive.close()
  await o2Store.close()
  try { fs.rmSync(o2Dir, { recursive: true, force: true }) } catch {}

  // (3) reclaimBudgetBytes: 0 — the blob half off BY CONFIG. The meta verdict must still
  // fire, VOD serves must reach neither trigger, and the capability probe must never run:
  // the probe answers a BLOB question, and each attempt writes 512 KiB of scratch on a
  // device that is by definition worried about disk.
  const o3Drive = new Hyperdrive(store.namespace('metaonly'))
  await o3Drive.ready()
  await o3Drive.put('/seg1.ts', seg(1))
  await bloatMeta(o3Drive, 1500)
  await o3Drive.put('/vod.m3u8', Buffer.from(playlist(['seg1.ts'], { end: true })))
  await o3Drive.put('/live.m3u8', Buffer.from(playlist(['seg1.ts'])))
  const o3Calls = []
  const o3Handler = driveHandler(o3Drive, {
    reclaim: true, reclaimIntervalMs: 0, reclaimBudgetBytes: 0, metaBudgetBytes: METABUDGET, onOverBudget: (d, info) => o3Calls.push(info)
  })
  const o3Server = http.createServer(o3Handler)
  await new Promise((resolve) => o3Server.listen(0, '127.0.0.1', resolve))
  const o3Port = o3Server.address().port
  for (let i = 0; i < 3; i++) {
    const rVod = await httpGet(o3Port, '/vod.m3u8')
    assert(rVod.status === 200, 'the VOD playlist serves')
    await sleep(150)
  }
  assert(o3Calls.length === 0, 'an #EXT-X-ENDLIST serve reaches NEITHER trigger — the live-only gate covers the meta budget too')
  await serveUntil(o3Port, '/live.m3u8', () => o3Calls.length > 0, 'the META verdict with the blob budget off by config')
  assert(o3Calls[0].trigger === 'meta' && o3Calls[0].budgetBytes === 0, 'trigger: meta, with info.budgetBytes reporting the configured 0')
  // …and this is the shape that made shipping effectiveBudgetBytes on a meta verdict worst:
  // there is NO blob ceiling here at all, so the number would have been windowBytes × 3 —
  // an "effective budget" invented out of a bound the host switched off.
  assert(o3Calls[0].effectiveBudgetBytes === null, `effectiveBudgetBytes is null where no blob budget exists (got ${o3Calls[0].effectiveBudgetBytes})`)
  const o3St = o3Handler.reclaimStatus()
  assert(o3St.punchTries === 0 && o3St.punch === null,
    'and the capability probe NEVER ran — the 512 KiB scratch write belongs to the blob half alone')
  assert(o3St.budgetActive === false && o3St.metaBudgetActive === true, 'reclaimStatus: blob off (configured), meta armed')
  o3Server.close()

  // (3b) THE OFF SWITCH, on the SAME drive the sub-case above just fired on — which is what
  // makes it non-vacuous: identical fixture, identical serves, only `metaBudgetBytes: 0`
  // different, and now nothing may fire. Paired with reclaimBudgetBytes: 0 this is the
  // documented "this viewer never rotates" configuration, and it has to be REAL: it is a
  // pair of zeros, not one, precisely because the metadata bound is independent of the blob
  // one everywhere else in this file. (The host-side half — that the same 0 also disables
  // the IDLE eviction threshold derived from it — is asserted in test:sdk.)
  const o3zCalls = []
  const o3zHandler = driveHandler(o3Drive, {
    reclaim: true, reclaimIntervalMs: 0, reclaimBudgetBytes: 0, metaBudgetBytes: 0, onOverBudget: (d, info) => o3zCalls.push(info)
  })
  const o3zServer = http.createServer(o3zHandler)
  await new Promise((resolve) => o3zServer.listen(0, '127.0.0.1', resolve))
  for (let i = 0; i < 4; i++) {
    const rz = await httpGet(o3zServer.address().port, '/live.m3u8')
    assert(rz.status === 200, 'the live playlist still serves with both budgets off')
    await sleep(150)
  }
  assert(o3zCalls.length === 0, 'metaBudgetBytes: 0 disables the meta verdict — the bee is far over the number the sub-case above fired on, and nothing fired')
  const o3zSt = o3zHandler.reclaimStatus()
  assert(o3zSt.metaBudgetBytes === 0 && o3zSt.metaBudgetActive === false && o3zSt.budgetActive === false,
    'reclaimStatus says so on both halves — the pair of zeros really is "never rotate"')
  assert(o3zSt.punchTries === 0 && o3zSt.punch === null, 'and still no probe: there is no blob budget to gate')
  o3zServer.close()
  await o3Drive.close()

  // (4) …and the `ran` rule does not gate it. A store whose OWN dels REJECT (the exFAT
  // shape — the reclaim pass itself FAILS) with the probe held INCONCLUSIVE (its scratch
  // write fails), so the blob half is withheld on BOTH of its rules — and the meta verdict
  // must fire anyway, because a clear pass, completed or failed, never touches the bee.
  const o4Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reclaim-meta4-'))
  const o4Store = new Corestore(o4Dir)
  {
    const raw = o4Store.storage
    o4Store.storage = (name) => {
      const file = raw(name)
      if (name.startsWith('punch-probe-')) {
        file._write = (req) => req.callback(errno('ENOSPC')) // probe: INCONCLUSIVE, never a verdict
      } else {
        const del = file._del
        file._del = function (req) { if (req.size === Infinity) return del.call(this, req); req.callback(errno('EOPNOTSUPP')) } // core clears: REJECT — the pass fails
      }
      return file
    }
  }
  await o4Store.ready()
  const o4Drive = new Hyperdrive(o4Store.namespace('feed'))
  await o4Drive.ready()
  for (let i = 1; i <= 3; i++) await o4Drive.put(`/seg${i}.ts`, seg(i))
  await bloatMeta(o4Drive, 1500)
  // The floor is seg3's offset (> 0): the pass really has blocks to clear, and the clear
  // REJECTS — `ran` is false on every tick, which is exactly the state under test.
  await o4Drive.put('/live.m3u8', Buffer.from(playlist(['seg3.ts'])))
  const o4Calls = []
  const o4Handler = driveHandler(o4Drive, {
    reclaim: true, reclaimIntervalMs: 0, metaBudgetBytes: METABUDGET, onOverBudget: (d, info) => o4Calls.push(info)
  })
  const o4Server = http.createServer(o4Handler)
  await new Promise((resolve) => o4Server.listen(0, '127.0.0.1', resolve))
  await serveUntil(o4Server.address().port, '/live.m3u8', () => o4Calls.length > 0, 'the META verdict off a FAILED pass with an inconclusive probe')
  assert(o4Calls[0].trigger === 'meta', 'trigger: meta — the blob half was withheld on both of its rules and the meta half takes neither')
  const o4St = o4Handler.reclaimStatus()
  assert(o4St.punch !== null && o4St.punch.ok === false, `the probe stayed INCONCLUSIVE (${o4St.punch && o4St.punch.reason})`)
  assert(o4St.budgetActive === true, 'so the blob budget is armed-and-withheld, not latched — and it still could not silence the meta half')
  o4Server.close()
  await o4Drive.close()
  await o4Store.close()
  try { fs.rmSync(o4Dir, { recursive: true, force: true }) } catch {}
}

log('\nRESULT: PASS ✅  live reclaim after rotation, VOD untouched, opt-in only, live thumbnail survives,')
log('              a no-op trim is caught by the byte budget, a healthy replica never trips it,')
log('              the idle sweep honours all three branches, and the drain surface settles both ways;')
log('              the budget scales to the OBSERVED live window, a punchable store switches it off')
log('              outright, and the capability probe tells a verdict from an inconclusive answer;')
log('              the trigger chain rides RANGED playlist serves off the whole-playlist floor,')
log('              a punch that truncates its lengths mod 2^32 is refused by the wide probe stage,')
log('              and the METADATA budget fires through the punch latch (trigger: meta) — beside an')
log('              armed blob budget, with the blob half off by config (no probe run), and off a')
log('              failed pass — while VOD serves reach neither trigger, metaBudgetBytes: 0 silences')
log('              it on the very fixture it just fired on, and effectiveBudgetBytes is null there')
await drive.close()
await store.close()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
process.exit(0)
