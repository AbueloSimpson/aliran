// End-to-end streaming test. Exercises the real broadcaster + viewer modules over a
// live Hyperswarm, then validates the delivered media with ffprobe.
//
//   node tools/e2e-stream-test.mjs
//
// Requires ffmpeg + ffprobe on PATH and outbound UDP (public DHT). Exits 0 on PASS.
// This is the automated proof of the v0.1 "it streams" milestone.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import crypto from 'hypercore-crypto'
import http from 'http'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { spawnSync } from 'child_process'
import { startFfmpeg, mirrorDirToDrive } from '../broadcaster/src/hls.js'
import { driveHandler } from './lib/serve-drive.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) }
  throw new Error('timeout waiting for ' + label)
}
async function get (port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

const encryptionKey = crypto.randomBytes(32)
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-hls-'))
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-A-'))
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-B-'))
let ff, swarmA, swarmB, server, storeA, storeB
const cleanup = async () => {
  try { ff && ff.kill() } catch {}
  try { server && server.close() } catch {}
  try { swarmA && await swarmA.destroy() } catch {}
  try { swarmB && await swarmB.destroy() } catch {}
  try { storeA && await storeA.close() } catch {}
  try { storeB && await storeB.close() } catch {}
  for (const d of [outDir, dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

try {
  // --- Broadcaster side ---
  storeA = new Corestore(dirA)
  const feed = new Hyperdrive(storeA.namespace('feed'), { encryptionKey })
  await feed.ready()
  swarmA = new Hyperswarm()
  swarmA.on('connection', s => feed.replicate(s))
  swarmA.join(feed.discoveryKey, { server: true, client: false })
  await swarmA.flush()

  ff = startFfmpeg({ input: 'test', hls: { time: 2, listSize: 6 } }, outDir)
  const stopMirror = mirrorDirToDrive(outDir, feed, { interval: 400 })
  log('broadcaster: ffmpeg started; feed key', b4a.toString(feed.key, 'hex').slice(0, 16) + '…')

  // Wait until the feed has a playlist + at least one segment.
  await waitFor(async () => {
    const pl = await feed.entry('/index.m3u8')
    const names = []
    for await (const n of feed.readdir('/')) names.push(n)
    return pl && names.some(n => n.endsWith('.ts')) ? names : null
  }, 30000, 'broadcaster to produce segments')
  log('broadcaster: playlist + segment present in the drive')

  // --- Viewer side (fresh peer) ---
  storeB = new Corestore(dirB)
  const replica = new Hyperdrive(storeB, feed.key, { encryptionKey })
  await replica.ready()
  swarmB = new Hyperswarm()
  swarmB.on('connection', s => replica.replicate(s))
  swarmB.join(replica.discoveryKey, { server: true, client: true })
  log('viewer: joining swarm…')

  server = http.createServer(driveHandler(replica))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  // Wait until the replica can serve the playlist over HTTP (proves DHT + replication).
  const playlist = await waitFor(async () => {
    const r = await get(port, '/index.m3u8')
    return r.status === 200 && r.body.includes('.ts') ? r.body.toString() : null
  }, 40000, 'viewer to serve playlist over localhost')
  log('viewer: served /index.m3u8 over localhost (P2P replication OK)')

  const segName = (playlist.match(/[^\s]+\.ts/) || [])[0]
  if (!segName) throw new Error('no .ts segment in playlist')

  // Range request → expect 206 + partial bytes.
  const ranged = await get(port, '/' + segName, { Range: 'bytes=0-99' })
  const rangeOk = ranged.status === 206 && ranged.body.length === 100 && !!ranged.headers['content-range']
  log('viewer: Range request', segName, '->', ranged.status, ranged.headers['content-range'], `(${ranged.body.length} bytes)`)

  // Full segment → validate it is real media with ffprobe.
  const full = await get(port, '/' + segName)
  const segPath = path.join(os.tmpdir(), 'e2e-seg.ts')
  fs.writeFileSync(segPath, full.body)
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', segPath], { encoding: 'utf8' })
  const probeOut = (probe.stdout || '').trim()
  log('viewer: full segment', full.body.length, 'bytes; ffprobe streams:', JSON.stringify(probeOut))

  const pass = rangeOk && full.body.length > 0 && /video/.test(probeOut)
  log('\nRESULT:', pass ? 'PASS ✅  (end-to-end P2P stream verified)' : 'FAIL ❌')
  await cleanup()
  process.exit(pass ? 0 : 1)
} catch (err) {
  log('ERROR:', err.message)
  await cleanup()
  process.exit(1)
}
