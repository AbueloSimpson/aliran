// FULL-CHAIN test against a REAL production source.
//
// The pieces were each proven separately: the ffmpeg leg (production URL → HLS, verified
// on the GPU box) and the P2P leg (e2e-broadcaster-api-test, but only with test/RTMP/UDP
// inputs). This joins them: a live upstream feed is pulled, TRANSCODED, mirrored into an
// encrypted Hyperdrive, replicated to a fresh viewer over the public DHT, and ffprobed as
// the viewer receives it — so what is asserted is what a real viewer would actually play.
//
//   node tools/prod-chain-test.mjs [sourceUrl] [encoder]
//
// Defaults to a live H.264 production channel and libx264, because the box this normally
// runs on has no NVIDIA. On a GPU host pass h264_nvenc/hevc_nvenc to exercise that path —
// the Hyperdrive mirror is indifferent to how the segments were produced, which is exactly
// why proving the legs separately is legitimate.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import assert from 'assert'
import http from 'http'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { spawnSync } from 'child_process'
import { ChannelManager } from '../broadcaster/src/channel.js'
import { driveHandler } from './lib/serve-drive.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(500) }
  throw new Error('timeout: ' + label)
}
function httpGet (port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

const SOURCE = process.argv[2] || 'http://209.222.97.39:81/ESPN1_NORTE/mpegts?token=aliran-scale-test'
const ENCODER = process.argv[3] || 'libx264'
const cleanups = []

;(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-prodchain-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  log('source :', SOURCE)
  log('encoder:', ENCODER)

  const manager = new ChannelManager({
    dataDir: path.join(root, 'bc'),
    // No panel: registration is a separate concern already covered by the e2e suite, and
    // leaving it out keeps this test about the media path.
    panelPubKey: null,
    publisherKey: null,
    bootstrap: [],
    hls: { time: 2, listSize: 6 },
    feedBuffer: 'ram',
    feedRotate: { hours: 0, treeMb: 0, graceMs: 2000 },
    argon2: { memKiB: 8192, time: 1 }
  })
  await manager.init()
  cleanups.push(() => manager.close())

  // Everything this branch added, on one channel: GPU-capable encoder, a real resize,
  // multi-audio, the tolerance switches, CFR, mux-queue headroom and drift correction.
  await manager.add('prod-chain', {
    title: 'Production chain test',
    input: { kind: 'pull', url: SOURCE },
    transcode: {
      encoder: ENCODER,
      resolution: '720p',
      videoBitrateKbps: 2500,
      audioTracks: 'all',
      fpsMode: 'cfr',
      maxMuxQueue: 2048,
      audioSync: true
    },
    ingestTuning: {
      probesizeKB: 20000,
      analyzeDurationMs: 15000,
      threadQueueSize: 1024,
      discardCorrupt: true,
      genPts: true,
      ignoreDecodeErrors: true
    },
    buffer: 'ram'
  })

  const started = await manager.start('prod-chain')
  const feedKey = started.feedKey
  const encryptionKey = started.encryptionKey
  assert.match(feedKey, /^[0-9a-f]{64}$/, 'start mints a feed key')
  log('feedKey:', feedKey.slice(0, 16) + '…')

  const st = await waitFor(async () => {
    const s = await manager.get('prod-chain')
    return s.running && s.ffmpegUp && s.playlist ? s : null
  }, 120000, 'production source pulled, transcoded and mirrored into the feed')
  log('broadcaster: state=%s ffmpegUp=%s playlist=%s profile=%s',
    st.state, st.ffmpegUp, st.playlist, JSON.stringify(st.detectedProfile))

  // --- the viewer half: a fresh store that has never seen this feed, joining over the DHT
  const viewStore = new Corestore(path.join(root, 'viewer')); await viewStore.ready()
  cleanups.push(() => viewStore.close())
  const replica = new Hyperdrive(viewStore, b4a.from(feedKey, 'hex'), { encryptionKey: b4a.from(encryptionKey, 'hex') })
  await replica.ready()
  const viewSwarm = new Hyperswarm(); cleanups.push(() => viewSwarm.destroy())
  viewSwarm.on('connection', (s) => replica.replicate(s))
  viewSwarm.join(replica.discoveryKey, { server: false, client: true })

  const media = http.createServer(driveHandler(replica))
  await new Promise((res) => media.listen(0, '127.0.0.1', res))
  cleanups.push(() => new Promise((res) => media.close(res)))
  const port = media.address().port

  const playlist = await waitFor(async () => {
    const g = await httpGet(port, '/index.m3u8')
    return g.status === 200 && g.body.includes('.ts') ? g.body.toString() : null
  }, 120000, 'viewer to replicate the playlist over P2P')
  const segs = playlist.match(/[^\s]+\.ts/g) || []
  log('viewer playlist: %d segments, window %s',
    segs.length, (playlist.match(/#EXTINF:[0-9.]+/g) || []).join(' '))
  assert.ok(segs.length >= 2, 'viewer sees a real rolling window, not a single segment')

  // ffprobe what the VIEWER serves — the bytes a real player would receive.
  const segUrl = `http://127.0.0.1:${port}/${segs[segs.length - 1]}`
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height',
    '-of', 'csv=p=0', segUrl], { encoding: 'utf8' })
  assert.strictEqual(probe.status, 0, 'ffprobe the replicated segment: ' + probe.stderr)
  const lines = probe.stdout.trim().split(/\r?\n/).filter(Boolean)
  log('viewer segment streams:', lines.join(' | '))
  const video = lines.find((l) => l.startsWith('video'))
  const audio = lines.filter((l) => l.startsWith('audio'))
  assert.ok(video, 'the replicated segment carries video')
  assert.ok(audio.length >= 1, 'and audio')
  assert.ok(/,1280,720$/.test(video), 'video is the 720p we asked the transcoder for, got: ' + video)

  const peers = (await manager.get('prod-chain')).peers
  log('broadcaster sees %d peer(s)', peers)

  await manager.stop('prod-chain')
  log('\nRESULT: PASS ✅  live production source → transcode → encrypted Hyperdrive → P2P → viewer ffprobe')
})().catch(async (err) => {
  console.error('ERROR:', err.message)
  process.exitCode = 1
}).finally(async () => {
  for (const c of cleanups.reverse()) { try { await c() } catch {} }
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref()
})
