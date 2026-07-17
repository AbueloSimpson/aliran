// Regression test for the 2026-07-16 control-login DoS: a handful of POST /api/login
// attempts must NOT stall the broadcaster's event loop. Argon2id verification is
// memory-hard and used to run synchronously on the main thread — on the production
// VPS (1 GB, deep in swap) 4-5 login attempts blocked the process for 25+ minutes:
// control API dead, swarm replication frozen, container restart required.
//
// The fix moves the verify into a worker thread behind a single-flight gate
// (control-auth.js makeAdminVerifier). This test boots a real ChannelManager +
// control server (no panel — seed-only), STARTS a channel, then floods /api/login
// with an expensive Argon2 cost while sampling /api/status as the event-loop
// responsiveness proxy. Asserts:
//   - /api/status keeps answering fast (< STATUS_MS) throughout the flood
//   - concurrent logins are rejected 503 IMMEDIATELY (single-flight, no queue)
//   - verifies still complete (401 for bad creds) and a valid login works after
//   - the channel is still running + producing after the flood
//   - a verify that outlives loginVerifyTimeoutMs fails 503 and the NEXT login
//     works again (worker terminated + respawned)
//
// Requires ffmpeg on PATH (test-pattern channel). Exits 0 on PASS.
import assert from 'assert'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { ChannelManager } from '../broadcaster/src/channel.js'
import { addAdmin } from '../broadcaster/src/control-auth.js'
import { startControlServer } from '../broadcaster/src/control-server.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(500) } throw new Error('timeout: ' + label) }

const STATUS_MS = 750 // every /api/status sample must beat this (old code: seconds+)
const REJECT_MS = 500 // single-flight 503s must be immediate, not queued
const FLOOD_MS = 6000

const ADMIN_PASSWORD = 'op-secret-password'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eb-flood-'))
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }

function apiFor (port) {
  return async (method, p, body, token) => {
    const headers = {}
    if (token) headers.authorization = 'Bearer ' + token
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`http://127.0.0.1:${port}` + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
}

try {
  // ===== Broadcaster only — no panel. Fast Argon2 for the op admin's verifier; the
  // flood later targets an UNKNOWN name, whose dummy verify reads argon cost from
  // config live, so we can crank it without touching op's stored record.
  const bcConfig = {
    dataDir: dir,
    panelPubKey: null,
    publisherKey: null,
    bootstrap: [],
    hls: { time: 2, listSize: 6 },
    feedBuffer: 'ram',
    argon2: { memKiB: 8192, time: 1 }
  }
  const manager = new ChannelManager(bcConfig); await manager.init(); cleanups.push(() => manager.close())
  addAdmin({ config: bcConfig, dataDir: dir }, 'op', ADMIN_PASSWORD)

  // Lockout threshold sky-high: this test is about the verify path, and the throttle
  // 429s BEFORE credentials are checked — it must not shield the code under test.
  const { port, close } = await startControlServer({ config: bcConfig, manager, dataDir: dir }, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 100000, seconds: 60 } })
  cleanups.push(close)
  const api = apiFor(port)
  log('control API listening on', port)

  const login = await api('POST', '/api/login', { username: 'op', password: ADMIN_PASSWORD })
  assert.strictEqual(login.status, 200, 'baseline login: ' + JSON.stringify(login.body))
  const token = login.body.token

  // ===== A channel streams throughout =====
  assert.strictEqual((await api('POST', '/api/channels', { id: 'flood-chan', title: 'Flood Chan', input: 'test', buffer: 'ram' }, token)).status, 201, 'add channel')
  assert.strictEqual((await api('POST', '/api/channels/flood-chan/start', undefined, token)).status, 200, 'start channel')
  await waitFor(async () => {
    const s = (await api('GET', '/api/channels/flood-chan', undefined, token)).body
    return s.running && s.ffmpegUp && s.playlist ? s : null
  }, 90000, 'channel running + playlist before the flood')
  log('channel streaming (test pattern → HLS → encrypted feed)')

  // ===== Crank the (dummy-path) Argon2 cost to incident scale: each verify is a
  // multi-second memory-hard grind. Pre-fix, ONE of these froze the event loop.
  bcConfig.argon2 = { memKiB: 262144, time: 6 } // 256 MiB × 6 passes

  // ===== The flood: volleys of concurrent bad logins, while /api/status is sampled
  // as the event-loop liveness probe.
  const floodP = []
  const statusSamples = []
  let flooding = true
  const sampler = (async () => {
    while (flooding) {
      const s0 = Date.now()
      const r = await api('GET', '/api/status', undefined, token)
      statusSamples.push({ ms: Date.now() - s0, status: r.status })
      await sleep(150)
    }
  })()
  const t0 = Date.now()
  while (Date.now() - t0 < FLOOD_MS) {
    for (let i = 0; i < 4; i++) {
      const s = Date.now()
      floodP.push(api('POST', '/api/login', { username: 'nobody', password: 'wrong-password' }).then((r) => ({ ...r, ms: Date.now() - s })))
    }
    await sleep(200)
  }
  const results = await Promise.all(floodP) // drains the in-flight verify too
  flooding = false
  await sampler

  const n401 = results.filter((r) => r.status === 401).length
  const n503 = results.filter((r) => r.status === 503)
  const nOther = results.filter((r) => r.status !== 401 && r.status !== 503)
  const maxStatus = Math.max(...statusSamples.map((s) => s.ms))
  const slow503 = n503.filter((r) => r.ms > REJECT_MS)
  log(`flood: ${results.length} attempts → ${n401}×401 (verified), ${n503.length}×503 (rejected immediately), ${nOther.length}×other`)
  log(`status samples: ${statusSamples.length}, max latency ${maxStatus}ms (limit ${STATUS_MS}ms)`)

  assert.strictEqual(nOther.length, 0, 'only 401/503 expected: ' + JSON.stringify(nOther.map((r) => r.status)))
  assert.ok(n401 >= 1, 'at least one expensive verify completed through the worker')
  assert.ok(n503.length >= results.length / 2, 'single-flight rejected the concurrent bulk (got ' + n503.length + ' 503s)')
  assert.match(n503[0].body.error, /in flight/, '503 names the single-flight gate')
  assert.strictEqual(slow503.length, 0, `503s must be immediate; slow ones: ${JSON.stringify(slow503.map((r) => r.ms))}`)
  assert.ok(statusSamples.length >= 20, 'sampler kept running (got ' + statusSamples.length + ' samples)')
  assert.ok(statusSamples.every((s) => s.status === 200), 'every status sample answered 200')
  assert.ok(maxStatus < STATUS_MS, `event loop stayed responsive under login flood (max /api/status ${maxStatus}ms)`)
  log('A: login flood never blocked the event loop; concurrency 503d immediately ✓')

  // ===== The media plane rode it out =====
  const after = (await api('GET', '/api/channels/flood-chan', undefined, token)).body
  assert.strictEqual(after.running, true, 'channel still running after the flood')
  assert.strictEqual(after.ffmpegUp, true, 'ffmpeg still up after the flood')
  assert.strictEqual(after.playlist, true, 'playlist still present after the flood')
  const relogin = await api('POST', '/api/login', { username: 'op', password: ADMIN_PASSWORD })
  assert.strictEqual(relogin.status, 200, 'valid login works after the flood')
  log('B: channel streamed through the flood; valid login fine after ✓')

  // ===== Verify timeout: a grind that outlives loginVerifyTimeoutMs fails 503 and
  // the worker is respawned for the next attempt (a thrashing box keeps serving).
  const srv2 = await startControlServer({ config: bcConfig, manager, dataDir: dir }, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 100000, seconds: 60 }, loginVerifyTimeoutMs: 600 })
  cleanups.push(srv2.close)
  const api2 = apiFor(srv2.port)
  const timedOut = await api2('POST', '/api/login', { username: 'nobody', password: 'x' }) // 256 MiB × 6 ≫ 600 ms
  assert.strictEqual(timedOut.status, 503, 'over-budget verify → 503: ' + JSON.stringify(timedOut.body))
  assert.match(timedOut.body.error, /timed out/, '503 names the timeout')
  let recovered = null
  for (let i = 0; i < 5 && !recovered; i++) { // op's stored verifier is cheap; fresh worker boot ≪ 600 ms
    const r = await api2('POST', '/api/login', { username: 'op', password: ADMIN_PASSWORD })
    if (r.status === 200) recovered = r
    else await sleep(300)
  }
  assert.ok(recovered, 'login recovers after a timed-out verify (worker respawned)')
  log('C: verify timeout → 503, worker respawned, next login fine ✓')

  assert.strictEqual((await api('POST', '/api/channels/flood-chan/stop', undefined, token)).status, 200, 'stop channel')

  log('\nRESULT: PASS ✅  (login flood: event loop responsive, single-flight 503s immediate, media plane unaffected, verify timeout self-heals)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
