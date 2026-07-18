// Broadcaster memory soak — reproduce / bisect the RAM-feed-buffer node RSS leak.
//
// Runs the REAL ChannelManager pipeline (like scale-bench.mjs) over a local DHT testnet with
// N looped-sample `copy` channels and NO viewers, then samples memory every --interval seconds
// for --minutes minutes:
//   - process.memoryUsage(): rss / heapUsed / external / arrayBuffers
//     (RAM-store pages are Buffers → external; JS-object growth → heapUsed; the remainder
//      rss - heap - external ≈ native (udx/dht) + allocator fragmentation)
//   - per-hypercore-FILE allocated bytes inside every channel's RAM Corestore
//     (oplog / tree / bitfield / data, split by bee[metadata] vs blobs core) — this shows
//     exactly WHICH append-only file accumulates and whether clear() frees data pages.
//
// Acceleration: --hls-time 1 (vs 4 s in prod) quadruples the append cadence, so an hour of
// VPS churn compresses into ~15 min. A leak that is O(appends) scales with this; one that is
// O(wall-clock) (DHT timers etc.) does not — comparing the two rates bisects the class.
//
// Usage: node --expose-gc tools/mem-soak.mjs [--channels 6] [--minutes 30] [--interval 30]
//          [--buffer ram|disk] [--hls-time 1] [--list-size 12] [--snapshot] [--log PATH]
//   --snapshot   write a V8 heap snapshot after the 2nd sample and at the end (to --log's dir)
import { ChannelManager } from '../broadcaster/src/channel.js'
import createTestnet from 'hyperdht/testnet.js'
import { spawnSync } from 'child_process'
import v8 from 'v8'
import fs from 'fs'
import os from 'os'
import path from 'path'

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const has = (name) => process.argv.includes('--' + name)

const N = parseInt(arg('channels', '6'), 10)
const MINUTES = parseFloat(arg('minutes', '30'))
const INTERVAL_S = parseInt(arg('interval', '30'), 10)
const BUFFER = arg('buffer', 'ram') === 'disk' ? 'disk' : 'ram'
const HLS_TIME = parseInt(arg('hls-time', '1'), 10)
const LIST_SIZE = parseInt(arg('list-size', '12'), 10)
const SNAPSHOT = has('snapshot')
const LOG = arg('log', null)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MB = (b) => (b / 1024 / 1024).toFixed(1)
const logStream = LOG ? fs.createWriteStream(LOG, { flags: 'a' }) : null
const log = (...a) => { const s = a.join(' '); console.log(s); if (logStream) logStream.write(s + '\n') }

// 12 s looped H264 sample with a keyframe every HLS_TIME seconds so `copy` cuts segments at
// exactly the accelerated cadence. 960x540 keeps segments multi-block (~100-300 KB) like prod.
function makeSample (dir) {
  const out = path.join(dir, 'sample.ts')
  const g = String(25 * HLS_TIME)
  const args = ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-g', g, '-keyint_min', g, '-c:a', 'aac', '-t', '12', '-y', out]
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] })
  if (r.status !== 0) throw new Error('ffmpeg sample generation failed (is ffmpeg on PATH?)')
  return out
}

// Allocated bytes actually held by a random-access-memory instance (sum of live pages), plus
// the file's logical length. On a disk-mode run buffers is absent → nulls.
function ramFile (ra) {
  if (!ra || !Array.isArray(ra.buffers)) return null
  let alloc = 0
  for (const b of ra.buffers) if (b) alloc += b.byteLength
  return { alloc, len: ra.length }
}

// Per-file breakdown of one hypercore's internal storage.
function coreFiles (hc) {
  const c = hc && hc.core
  if (!c) return null
  return {
    oplog: ramFile(c.oplog && c.oplog.storage),
    tree: ramFile(c.tree && c.tree.storage),
    bitfield: ramFile(c.bitfield && c.bitfield.storage),
    data: ramFile(c.blocks && c.blocks.storage)
  }
}

function addInto (sum, files) {
  if (!files) return
  for (const k of Object.keys(files)) {
    const f = files[k]
    if (!f) continue
    sum[k] = sum[k] || { alloc: 0, len: 0 }
    sum[k].alloc += f.alloc
    sum[k].len += f.len
  }
}

async function main () {
  log(`=== mem-soak: channels=${N} buffer=${BUFFER} hlsTime=${HLS_TIME}s listSize=${LIST_SIZE} minutes=${MINUTES} interval=${INTERVAL_S}s gc=${!!global.gc} node=${process.version} platform=${process.platform} ===`)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-soak-'))
  const dataDir = path.join(root, 'data')
  const workDir = path.join(root, 'work')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })
  const sample = makeSample(root)

  const testnet = await createTestnet(3)
  const config = {
    dataDir,
    workDir,
    panelPubKey: null, // no panel → PanelLink disabled (registration no-op)
    publisherKey: null,
    bootstrap: testnet.bootstrap,
    feedBuffer: BUFFER,
    hls: { time: HLS_TIME, listSize: LIST_SIZE }
  }

  const manager = new ChannelManager(config)
  await manager.init()
  await manager.capabilities().catch(() => {})

  for (let i = 0; i < N; i++) {
    await manager.add(`ch${i}`, {
      title: `ch${i}`,
      input: { kind: 'file', path: sample },
      transcode: { encoder: 'copy' },
      buffer: BUFFER,
      hlsTime: HLS_TIME,
      hlsListSize: LIST_SIZE
    })
    await manager.start(`ch${i}`)
  }

  // Wait for every channel to publish a playlist, then let the rolling window fill.
  const deadline = Date.now() + 60000
  let live = 0
  while (Date.now() < deadline) {
    live = 0
    for (let i = 0; i < N; i++) { try { if ((await manager.get(`ch${i}`)).playlist) live++ } catch {} }
    if (live === N) break
    await sleep(500)
  }
  log(`${live}/${N} channels live; settling ${LIST_SIZE * HLS_TIME + 6}s for window fill`)
  await sleep((LIST_SIZE * HLS_TIME + 6) * 1000)

  const snapDir = LOG ? path.dirname(LOG) : root
  const t0 = Date.now()
  const samples = []
  let snapped = false

  log('min\trssMB\theapMB\textMB\tabufMB\tbee.data\tbee.tree\tbee.oplog\tbee.bitf\tblob.data\tblob.tree\tblob.oplog\tblob.bitf\tblobLen\tbeeVer\tconns\tcache\t(alloc MB; len MB in parens)')

  const endAt = t0 + MINUTES * 60 * 1000
  while (Date.now() < endAt) {
    if (global.gc) global.gc()
    const mu = process.memoryUsage()
    const bee = {}
    const blob = {}
    const other = {}
    let blobLen = 0
    let beeVer = 0
    let conns = 0
    for (const ch of manager.channels.values()) {
      const run = ch.run
      if (!run) continue
      conns += run.swarm.connections.size
      beeVer += run.drive.version
      const beeCore = run.drive.db && run.drive.db.core
      const blobsCore = run.drive.blobs && run.drive.blobs.core
      if (blobsCore) blobLen += blobsCore.length
      const seen = new Set()
      if (beeCore) { addInto(bee, coreFiles(beeCore)); seen.add(beeCore.core) }
      if (blobsCore) { addInto(blob, coreFiles(blobsCore)); seen.add(blobsCore.core) }
      for (const hc of run.store.cores.values()) {
        if (hc.core && !seen.has(hc.core)) addInto(other, coreFiles(hc))
      }
    }
    const f = (x) => x ? `${MB(x.alloc)}(${MB(x.len)})` : '-'
    const min = ((Date.now() - t0) / 60000).toFixed(1)
    const row = [min, MB(mu.rss), MB(mu.heapUsed), MB(mu.external), MB(mu.arrayBuffers),
      f(bee.data), f(bee.tree), f(bee.oplog), f(bee.bitfield),
      f(blob.data), f(blob.tree), f(blob.oplog), f(blob.bitfield),
      blobLen, beeVer, conns,
      manager.feedCache ? manager.feedCache.globalSize : '-'].join('\t')
    log(row)
    const otherAlloc = Object.values(other).reduce((a, x) => a + (x ? x.alloc : 0), 0)
    if (otherAlloc > 1024 * 1024) log(`  (other cores alloc: ${MB(otherAlloc)} MB)`)
    samples.push({ t: Date.now(), mu })

    if (SNAPSHOT && !snapped && samples.length >= 2) {
      snapped = true
      const p = v8.writeHeapSnapshot(path.join(snapDir, 'soak-early.heapsnapshot'))
      log(`  heap snapshot: ${p}`)
    }
    await sleep(INTERVAL_S * 1000)
  }

  if (SNAPSHOT) {
    if (global.gc) global.gc()
    const p = v8.writeHeapSnapshot(path.join(snapDir, 'soak-late.heapsnapshot'))
    log(`  heap snapshot: ${p}`)
  }

  // Linear-fit growth rates (least squares over the sample series).
  if (samples.length >= 3) {
    const rate = (get) => {
      const n = samples.length
      const xs = samples.map((s) => (s.t - samples[0].t) / 3600000)
      const ys = samples.map(get)
      const mx = xs.reduce((a, b) => a + b, 0) / n
      const my = ys.reduce((a, b) => a + b, 0) / n
      let num = 0; let den = 0
      for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2 }
      return den ? num / den : 0
    }
    log(`--- growth rates (MB/h over ${samples.length} samples) ---`)
    log(`rss: ${MB(rate((s) => s.mu.rss))}  heapUsed: ${MB(rate((s) => s.mu.heapUsed))}  external: ${MB(rate((s) => s.mu.external))}  arrayBuffers: ${MB(rate((s) => s.mu.arrayBuffers))}`)
  }

  await manager.close().catch(() => {})
  await testnet.destroy().catch(() => {})
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  log('done.')
  process.exit(0)
}

main().catch((err) => { console.error('SOAK ERROR:', err.stack || err.message); process.exit(1) })
