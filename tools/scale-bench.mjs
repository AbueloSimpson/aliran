// Channel-density bench — measures the per-channel resource cost of the broadcaster so you
// can size hardware (RAM / disk / CPU) for N channels. See docs/kb/scaling.md.
//
// It runs the REAL ChannelManager pipeline (Corestore + Hyperdrive + Hyperswarm + the
// ffmpeg->HLS->encrypted-feed mirror) over a LOCAL DHT testnet (never the public DHT), with
// production-representative channels: a looped H264 sample muxed with `copy` (exactly how the
// VPS pulls behave — near-zero encode CPU). It reports node RSS, ffmpeg RSS, on-disk/tmpfs
// footprint and CPU, per channel, then extrapolates max channels for a few RAM budgets.
//
// Usage:  node tools/scale-bench.mjs [--channels N] [--seconds S] [--buffer disk|ram] [--workdir PATH]
//   --channels  how many channels to run concurrently   (default 6)
//   --seconds   steady-state sampling window            (default 40)
//   --buffer    disk (default) | ram                    (feed storage mode)
//   --workdir   ffmpeg scratch dir (point at a tmpfs to model the scale profile)
//
// This measures RAM / storage / CPU. IOPS is the OTHER scaling wall (see the guide): it is
// filesystem-specific, so the bench reports the write RATE and leaves the IOPS verdict to the
// guide's formula. Absolute numbers are hardware-specific — re-run on YOUR box (VPS, Pi, …).
import { ChannelManager } from '../broadcaster/src/channel.js'
import createTestnet from 'hyperdht/testnet.js'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const N = parseInt(arg('channels', '6'), 10)
const SECONDS = parseInt(arg('seconds', '40'), 10)
const BUFFER = arg('buffer', 'disk') === 'ram' ? 'ram' : 'disk'
const WORKDIR = arg('workdir', null)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MB = (b) => (b / 1024 / 1024).toFixed(1)
const log = (...a) => console.log(...a)

// Recursive ALLOCATED size of a dir (bytes) = sum of st.blocks*512. This is the real on-disk
// footprint — critical here because the feed's blob file is SPARSE (holes punched as segments
// rotate), so its logical size (st.size) grossly overstates disk use. Accurate on Linux (ext4
// etc. hole-punch); on Windows/non-sparse filesystems st.blocks tracks logical, so treat this
// number as Linux-authoritative.
function dirSize (d) {
  let total = 0
  let ents = []
  try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return 0 }
  for (const e of ents) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) total += dirSize(p)
    else { try { const st = fs.statSync(p); total += (typeof st.blocks === 'number' ? st.blocks * 512 : st.size) } catch {} }
  }
  return total
}

// Best-effort RSS (KiB) of a set of pids. Reads /proc on Linux; else returns null (the node
// RSS delta already captures the feed engine — ffmpeg RSS is a per-process constant we note).
function ffmpegRssKiB (pids) {
  if (process.platform !== 'linux') return null
  let total = 0
  for (const pid of pids) {
    try {
      // statm field 2 = resident pages; * page size.
      const pages = parseInt(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1], 10)
      total += (pages * 4096) / 1024
    } catch {}
  }
  return total
}

function makeSample (dir) {
  const out = path.join(dir, 'sample.ts')
  // 12 s of 640x360 H264 with a keyframe every 2 s (-g 50 @ 25fps) so `copy` cuts clean 2 s
  // segments. ultrafast keeps sample generation quick; the bench itself uses copy (no encode).
  const args = ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-g', '50', '-keyint_min', '50', '-c:a', 'aac', '-t', '12', '-y', out]
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] })
  if (r.status !== 0) throw new Error('ffmpeg sample generation failed (is ffmpeg on PATH?)')
  return out
}

async function main () {
  log(`\n=== Aliran channel-density bench ===`)
  log(`channels=${N}  window=${SECONDS}s  buffer=${BUFFER}  platform=${process.platform}/${process.arch}  cpus=${os.cpus().length}`)
  log(`host RAM=${MB(os.totalmem())} MB total, ${MB(os.freemem())} MB free\n`)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-scale-'))
  const dataDir = path.join(root, 'data')
  const workDir = WORKDIR || path.join(root, 'work')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })
  const sample = makeSample(root)

  const testnet = await createTestnet(3)
  const config = {
    dataDir,
    workDir,
    panelPubKey: null, // no panel → PanelLink stays disabled (registration is a no-op)
    publisherKey: null,
    bootstrap: testnet.bootstrap,
    feedBuffer: BUFFER,
    hls: { time: 2, listSize: 8 }
  }

  const manager = new ChannelManager(config)
  await manager.init()
  await manager.capabilities().catch(() => {}) // warm the ffmpeg probe before we time anything
  await sleep(500)
  global.gc && global.gc()
  const baseRss = process.memoryUsage().rss

  const t0 = Date.now()
  for (let i = 0; i < N; i++) {
    await manager.add(`ch${i}`, { title: `ch${i}`, input: { kind: 'file', path: sample }, transcode: { encoder: 'copy' } })
    await manager.start(`ch${i}`)
  }
  const startMs = Date.now() - t0

  // Wait until every channel has a live playlist (all ffmpegs producing) — that's steady state.
  const deadline = Date.now() + 30000
  let live = 0
  while (Date.now() < deadline) {
    live = 0
    for (let i = 0; i < N; i++) { try { if ((await manager.get(`ch${i}`)).playlist) live++ } catch {} }
    if (live === N) break
    await sleep(500)
  }
  log(`${live}/${N} channels live after ${((Date.now() - t0) / 1000).toFixed(1)}s (start calls took ${startMs}ms)`)

  // Let the rolling window FILL and the initial tree settle before measuring, so store growth
  // reflects the steady-state metadata creep — not the one-time window fill (listSize x time).
  const fillMs = (8 * 2 + 6) * 1000
  log(`settling ${fillMs / 1000}s (window fill) before the ${SECONDS}s steady-state sample...\n`)
  await sleep(fillMs)

  // Sample over the steady-state window: CPU via cpuUsage delta, footprint at the end.
  const cpu0 = process.cpuUsage()
  const wall0 = Date.now()
  const store0 = dirSize(dataDir)
  await sleep(SECONDS * 1000)
  const cpu1 = process.cpuUsage(cpu0)
  const wallMs = Date.now() - wall0
  global.gc && global.gc()
  const rss = process.memoryUsage().rss
  const store1 = dirSize(dataDir)

  const ffPids = []
  for (const ch of manager.channels.values()) if (ch.run && ch.run.ff && ch.run.ff.pid) ffPids.push(ch.run.ff.pid)
  const ffRss = ffmpegRssKiB(ffPids)

  const nodeCpuPct = ((cpu1.user + cpu1.system) / 1000 / wallMs) * 100 // % of ONE core, node only
  const storeGrowthPerMin = ((store1 - store0) / (wallMs / 60000))
  const perChNodeRss = (rss - baseRss) / N
  const workBytes = dirSize(workDir)

  log('--- measured (N=' + N + ', ' + BUFFER + ' buffer) ---')
  log(`node RSS            : ${MB(rss)} MB   (baseline ${MB(baseRss)} MB, +${MB(rss - baseRss)} MB for ${N} ch)`)
  log(`  per channel (node): ${MB(perChNodeRss)} MB  <- Corestore+Hyperdrive+Hyperswarm+buffers`)
  if (ffRss != null) log(`ffmpeg RSS (sum)    : ${MB(ffRss * 1024)} MB   (${MB((ffRss * 1024) / N)} MB/ch, copy passthrough)`)
  else log(`ffmpeg RSS          : n/a on ${process.platform} — measure on Linux; copy ffmpeg is ~30-55 MB/ch`)
  log(`node CPU            : ${nodeCpuPct.toFixed(1)}% of one core total  (${(nodeCpuPct / N).toFixed(2)}%/ch — the mirror; copy adds ~no encode CPU)`)
  log(`feed store (${BUFFER})    : ${MB(store1)} MB allocated, growth ${MB(storeGrowthPerMin)} MB/min  (Linux-authoritative; segment data bounded, slow append-only metadata creep)`)
  log(`ffmpeg scratch      : ${MB(workBytes)} MB in workDir (${MB(workBytes / Math.max(live, 1))} MB/ch window; put this on tmpfs at scale)`)

  // Extrapolate RAM-bound channel ceilings (RAM is usually the first wall on small boxes).
  const perChTotalRss = perChNodeRss + (ffRss != null ? (ffRss * 1024) / N : 45 * 1024 * 1024)
  log(`\n--- RAM-bound ceiling (per-channel ~${MB(perChTotalRss)} MB incl. ffmpeg; leaves 25% headroom) ---`)
  for (const budgetMB of [512, 1024, 2048, 4096, 8192]) {
    const usableB = budgetMB * 1024 * 1024 * 0.75 - baseRss
    const max = Math.max(0, Math.floor(usableB / perChTotalRss))
    log(`  ${String(budgetMB).padStart(5)} MB RAM box  ->  ~${max} channels (RAM-bound)`)
  }
  log(`\nNote: CPU (copy≈free, x264 SD≈0.5-1 core/ch), disk IOPS (use tmpfs at scale), and DHT`)
  log(`socket fan-out are the OTHER walls — see docs/kb/scaling.md for the full formula.\n`)

  // Cleanup
  await manager.close().catch(() => {})
  await testnet.destroy().catch(() => {})
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  log('done.')
  process.exit(0)
}

main().catch((err) => { console.error('BENCH ERROR:', err.stack || err.message); process.exit(1) })
