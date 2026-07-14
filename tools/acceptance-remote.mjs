// Remote acceptance: prove a DEPLOYED Aliran service end-to-end from anywhere.
//
// Runs on any machine with Node + ffprobe + outbound UDP — no localhost assumptions:
// it reaches the panel purely through the public DHT (panel public key), logs in as a
// real viewer, replicates each granted feed P2P, and validates the media with ffprobe.
// One AliranPlayer per stream (a player serves a single active feed), so N streams
// double as N concurrent simulated viewers.
//
//   node tools/acceptance-remote.mjs --panel <panelPubKeyHex> --user demo --pass '…' \
//        [--streams ch1,ch2] [--expect-live ch1] [--expect-off ch2] [--timeout 120]
//
// Env fallbacks: PANEL_PUBKEY, ALIRAN_USER, ALIRAN_PASS.
// Defaults: every stream the login returns; per-stream playback timeout 120 s.
// Exit 0 iff every checked stream PASSes (and every --expect-* assertion holds).
//
// Login retries while the DHT dials are local-only failures (no panel RPC is sent
// before the socket exists), so the panel's login throttle sees ~1 real attempt per
// player — safe against LOCKOUT_THRESHOLD even with several concurrent players.

import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { spawnSync } from 'child_process'
import { createPlayer } from '../sdk/index.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(400) }
  throw new Error('timeout: ' + label)
}
function httpGet (port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

function parseArgs (argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
      opts[k] = v
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const panelPubKey = opts.panel || process.env.PANEL_PUBKEY
const username = opts.user || process.env.ALIRAN_USER
const password = opts.pass || process.env.ALIRAN_PASS
const timeoutS = Number(opts.timeout || 120)
const wantStreams = opts.streams ? String(opts.streams).split(',').map(s => s.trim()).filter(Boolean) : null
const expectLive = opts['expect-live'] ? String(opts['expect-live']).split(',').map(s => s.trim()).filter(Boolean) : []
const expectOff = opts['expect-off'] ? String(opts['expect-off']).split(',').map(s => s.trim()).filter(Boolean) : []

if (!panelPubKey || !username || !password) {
  console.error('usage: node tools/acceptance-remote.mjs --panel <panelPubKeyHex> --user <u> --pass <p> [--streams a,b] [--expect-live a] [--expect-off b] [--timeout 120]')
  process.exit(2)
}

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const tempDirs = []
const players = []
async function cleanup () {
  for (const p of players.reverse()) { try { await p.stop() } catch {} }
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

// Login races the DHT dial + DB replication; only 'not connected' / replication-lag
// errors are retried (they are local — the throttle never sees them).
async function connectAndLogin (label) {
  const dir = tmp('acc-' + label + '-'); tempDirs.push(dir)
  const player = createPlayer({ panelPubKey, storeDir: dir }); players.push(player)
  const peers = { max: 0 }
  player.on('peers', (n) => { peers.max = Math.max(peers.max, n) })
  player.on('error', () => {})
  await player.connect()
  const deadline = Date.now() + 90000
  while (true) {
    try {
      const streams = await player.login(username, password)
      return { player, streams, peers }
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
      if (Date.now() > deadline) throw new Error('timeout: login via DHT (' + label + ')')
      await sleep(2000)
    }
  }
}

async function checkStream (id) {
  const t0 = Date.now()
  const res = { id, ok: false, ms: null, segBytes: 0, peers: 0, error: null }
  try {
    const { player, peers } = await connectAndLogin(id)
    const { localUrl, port } = await player.resolve(id)
    const playlist = await waitFor(async () => {
      const r = await httpGet(port, '/index.m3u8')
      return r.status === 200 && r.body.toString().includes('.ts') ? r.body.toString() : null
    }, timeoutS * 1000, 'playlist for ' + id)
    const segs = playlist.split('\n').filter(l => l.trim().endsWith('.ts'))
    const seg = await httpGet(port, '/' + segs[segs.length - 1].trim())
    if (seg.status !== 200 || seg.body.length === 0) throw new Error('segment fetch failed (' + seg.status + ')')
    const segPath = path.join(tempDirs[tempDirs.length - 1], 'probe.ts')
    fs.writeFileSync(segPath, seg.body)
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', segPath], { encoding: 'utf8' })
    const codecs = (probe.stdout || '').trim().split(/\r?\n/).filter(Boolean)
    if (!codecs.includes('video')) throw new Error('ffprobe found no video stream (' + JSON.stringify(codecs) + ')')
    res.ok = true
    res.ms = Date.now() - t0
    res.segBytes = seg.body.length
    res.peers = peers.max
    log(`  ✓ ${id}: playlist+segment+ffprobe OK in ${res.ms} ms via ${localUrl} (${seg.body.length} bytes, codecs ${codecs.join('+')})`)
  } catch (e) {
    res.error = String(e.message || e)
    log(`  ✗ ${id}: ${res.error}`)
  }
  return res
}

try {
  log(`acceptance: panel ${panelPubKey.slice(0, 16)}… as '${username}' from ${os.hostname()} (${process.platform})`)

  // Probe login: discover the entitled catalog (also validates credentials once).
  const probe = await connectAndLogin('probe')
  const display = probe.streams
  log('login OK —', display.length, 'entitled stream(s):', display.map(s => `${s.id}${s.isLive ? ' [LIVE]' : ''}`).join(', '))

  for (const id of expectLive) {
    const s = display.find(x => x.id === id)
    if (!s || s.isLive !== true) throw new Error(`--expect-live failed: '${id}' is ${s ? 'not live' : 'absent'}`)
  }
  for (const id of expectOff) {
    const s = display.find(x => x.id === id)
    if (s && s.isLive === true) throw new Error(`--expect-off failed: '${id}' is live`)
  }
  if (expectLive.length || expectOff.length) log('catalog assertions OK (live:', expectLive.join(',') || '-', '; off:', expectOff.join(',') || '-', ')')

  const targets = wantStreams || display.filter(s => s.isLive).map(s => s.id)
  if (targets.length === 0) throw new Error('no live streams to check (use --streams to force)')
  log('checking', targets.length, 'stream(s) CONCURRENTLY:', targets.join(', '))

  const results = await Promise.all(targets.map(id => checkStream(id)))

  log('\n  stream        result   time-to-play   segment      peers')
  for (const r of results) {
    log(`  ${r.id.padEnd(12)}  ${r.ok ? 'PASS' : 'FAIL'}     ${String(r.ms ?? '-').padStart(7)} ms   ${String(r.segBytes).padStart(8)} B   ${r.peers}`)
  }
  const failed = results.filter(r => !r.ok)
  await cleanup()
  if (failed.length) {
    console.error(`\nRESULT: FAIL ❌  (${failed.length}/${results.length} stream(s) failed)`)
    process.exit(1)
  }
  log(`\nRESULT: PASS ✅  (${results.length} stream(s) played over the real DHT — no localhost anywhere)`)
  process.exit(0)
} catch (err) {
  console.error('\nRESULT: FAIL ❌ ', err.message || err)
  await cleanup()
  process.exit(1)
}
