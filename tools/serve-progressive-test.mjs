// Progressive-serving test for the shared media-serving core (sdk/serve.js via
// tools/lib/serve-drive.js — the same handler sdk/player.js serves the app with).
//
// Deterministic (no DHT, no ffmpeg): a writer and a reader corestore are linked by
// a replication pipe with a byte-BUDGET gate, so the test controls exactly how much
// replication data flows at any moment. Validates the zap-latency behaviors:
//
//   A  PROGRESSIVE BODY — first segment bytes reach the HTTP client while the
//      blob's tail is PROVABLY not yet replicated (the gate holds it hostage), and
//      the response only completes after the gate opens: the server streams blocks
//      as they land instead of waiting for the full blob.
//   B  AVAILABILITY WAIT — a GET issued BEFORE the path exists in the replica is
//      held (bounded) and served on arrival instead of 404ing into the player's
//      2.5 s retry remount; a genuinely missing path still 404s after the bound,
//      and a non-media mount (posters) 404s immediately.
//   C  RANGE semantics — 206 with exact byte math, 416 past EOF (ExoPlayer probes
//      with ranged requests; regressions here surface as silent playback failures).
//   D  LIVE-EDGE READ-AHEAD — serving a playlist triggers a background download of
//      its newest segments, so their blocks are local before the player asks.
//
// Exits 0 on PASS.

import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import http from 'http'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { Transform } from 'stream'
import { driveHandler } from './lib/serve-drive.js'

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

// Pass-through with a byte budget: forwards until the budget is spent, buffers the
// rest (with backpressure) until more budget is granted. `open()` = unlimited.
function makeGate () {
  let budget = Infinity
  const queue = [] // buffered slices while the budget is exhausted
  let pending = null // the transform callback held while chunks are buffered
  let stream
  function drain () {
    while (queue.length && budget > 0) {
      const c = queue[0]
      if (budget >= c.length) {
        stream.push(c)
        if (budget !== Infinity) budget -= c.length
        queue.shift()
      } else {
        stream.push(c.subarray(0, budget))
        queue[0] = c.subarray(budget)
        budget = 0
      }
    }
    if (!queue.length && pending) { const cb = pending; pending = null; cb() }
  }
  stream = new Transform({
    transform (chunk, enc, cb) {
      queue.push(chunk)
      if (queue.length === 1 && budget > 0) { drain(); if (!queue.length) return cb() }
      pending = cb
    }
  })
  return {
    stream,
    limit (n) { budget = n; drain() },
    open () { budget = Infinity; drain() }
  }
}

function httpGet (port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), 'srv-w-')), fs.mkdtempSync(path.join(os.tmpdir(), 'srv-r-'))]
const encKey = hcrypto.randomBytes(32)

const storeW = new Corestore(dirs[0])
await storeW.ready()
const writer = new Hyperdrive(storeW.namespace('feed'), { encryptionKey: encKey })
await writer.ready()

const storeR = new Corestore(dirs[1])
await storeR.ready()
const reader = new Hyperdrive(storeR.namespace('feed'), writer.key, { encryptionKey: encKey })
await reader.ready()

// Link the stores; only the writer->reader direction (blob data) is gated.
const gate = makeGate()
const sW = storeW.replicate(true)
const sR = storeR.replicate(false)
sW.pipe(gate.stream).pipe(sR).pipe(sW)
for (const s of [sW, sR]) s.on('error', () => {})

// Media fixture: 1 MB segment (≈16 blocks of 64 KB) + small segments for later tests.
const SEG = Buffer.alloc(1024 * 1024)
for (let i = 0; i < SEG.length; i++) SEG[i] = i & 0xff
const SMALL = Buffer.alloc(160 * 1024, 7)
await writer.put('/seg0.ts', SEG)

// Short waitMs so the negative 404 case doesn't stall the suite; the reader drive
// doubles as an '/assets' mount to exercise the no-wait (media: false) path.
const server = http.createServer(driveHandler(reader, { waitMs: 1500, pollMs: 60, mounts: { '/assets': reader } }))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

log('A: progressive body (first bytes while the blob tail is gated)')
{
  // Metadata replicates freely, then the gate closes hard: the GET below starts
  // with ZERO blob blocks local.
  await waitFor(() => reader.entry('/seg0.ts'), 10000, 'entry replication')
  gate.limit(0)
  let ended = false
  let received = 0
  let firstByteAt = null
  const done = new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/seg0.ts', agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => {
        if (received === 0) firstByteAt = Date.now()
        received += c.length
        chunks.push(c)
      })
      res.on('end', () => { ended = true; resolve({ status: res.statusCode, body: Buffer.concat(chunks) }) })
    }).on('error', reject)
  })
  await sleep(300) // the handler is now awaiting block 0 — nothing can flow yet
  assert(!ended && received === 0, 'response idles open while zero blob bytes have replicated')
  // Grant ~5 blocks of replication budget: enough for first bytes, far from 1 MB.
  gate.limit(340 * 1024)
  await waitFor(() => received > 0, 10000, 'first progressive bytes')
  await sleep(400) // let in-flight deliveries settle against the exhausted budget
  assert(received > 0 && received < SEG.length, `first bytes served while the tail is hostage (${received} of ${SEG.length} bytes)`)
  assert(!ended, 'response is still streaming (not ended) while the blob is incomplete')
  gate.open()
  const res = await done
  assert(res.status === 200, 'segment GET is 200')
  assert(res.body.length === SEG.length && res.body.equals(SEG), 'full body intact after the gate opened')
  assert(firstByteAt !== null, 'first-byte timestamp recorded')
}

log('B: availability wait (GET before the path replicates)')
{
  // Issue the GET first; put the file 300 ms later. The old handler 404'd here and
  // the player paid a hard error + 2.5 s retry remount.
  const pending = httpGet(port, '/late.ts')
  await sleep(300)
  await writer.put('/late.ts', SMALL)
  const res = await pending
  assert(res.status === 200 && res.body.equals(SMALL), 'pre-replication GET was held and served on arrival (no 404)')
  const t0 = Date.now()
  const miss = await httpGet(port, '/never.ts')
  assert(miss.status === 404 && Date.now() - t0 >= 1400, 'missing media path still 404s after the wait bound')
  const t1 = Date.now()
  const art = await httpGet(port, '/assets/nope.png')
  assert(art.status === 404 && Date.now() - t1 < 1000, 'missing mount (posters) path 404s immediately — no availability wait')
}

log('C: range semantics')
{
  const r1 = await httpGet(port, '/seg0.ts', { range: 'bytes=100-199' })
  assert(r1.status === 206 && r1.body.length === 100 && r1.body.equals(SEG.subarray(100, 200)), '206 exact bytes for bytes=100-199')
  assert(r1.headers['content-range'] === `bytes 100-199/${SEG.length}`, 'Content-Range header exact')
  const r2 = await httpGet(port, '/seg0.ts', { range: `bytes=0-${SEG.length}` })
  assert(r2.status === 416, '416 for a range past EOF')
  const r3 = await httpGet(port, '/seg0.ts', { range: 'bytes=1048000-' })
  assert(r3.status === 206 && r3.body.length === SEG.length - 1048000, 'open-ended range serves the tail')
}

log('D: playlist read-ahead (newest segments downloaded without being requested)')
{
  await writer.put('/ra1.ts', SMALL)
  await writer.put('/ra2.ts', SMALL)
  await writer.put('/ra3.ts', SMALL)
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nra1.ts\n#EXTINF:2,\nra2.ts\n#EXTINF:2,\nra3.ts\n'
  await writer.put('/index.m3u8', Buffer.from(playlist))
  const res = await httpGet(port, '/index.m3u8')
  assert(res.status === 200 && res.body.toString() === playlist, 'playlist serves intact')
  // Without requesting any segment over HTTP, the newest ones must land locally.
  const blobs = await reader.getBlobs()
  const covered = async (name) => {
    const entry = await reader.entry(name)
    const b = entry && entry.value.blob
    if (!b) return false
    for (let i = b.blockOffset; i < b.blockOffset + b.blockLength; i++) {
      if (!(await blobs.core.has(i))) return false
    }
    return true
  }
  await waitFor(() => covered('/ra3.ts'), 10000, 'read-ahead of the newest segment')
  assert(await covered('/ra3.ts'), 'newest segment fully replicated by read-ahead (never requested over HTTP)')
  await waitFor(() => covered('/ra2.ts'), 10000, 'read-ahead of the second-newest segment')
  assert(await covered('/ra2.ts'), 'second-newest segment replicated by read-ahead')
}

log('\nRESULT: PASS ✅  progressive serving, availability wait, ranges, read-ahead')
server.close()
await writer.close(); await reader.close()
await storeW.close(); await storeR.close()
for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
process.exit(0)
