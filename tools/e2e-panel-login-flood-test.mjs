// Regression test for the panel-side twin of the 2026-07-16 control-login DoS: a
// handful of POST /api/login attempts against the PANEL admin API must NOT stall
// the panel's event loop. Argon2id verification is memory-hard and used to run
// synchronously on the main thread (ops.js verifyAdmin) — the same defect that
// froze the broadcaster in production (1 GB VPS deep in swap: 4-5 login attempts =
// 25+ minutes dead). On the panel the blast radius is the admin API, catalog
// replication AND the viewer login RPC — every fresh app login in the fleet.
//
// The fix mirrors broadcaster/src/control-auth.js: the verify runs in a worker
// thread behind a single-flight gate (ops.js makeAdminVerifier). This test boots a
// real panel store + admin server + a Hyperswarm login-RPC plane, connects a
// viewer BEFORE the flood, then floods /api/login with an expensive Argon2 cost
// while sampling /api/status as the event-loop responsiveness proxy. Asserts:
//   - /api/status keeps answering fast (< STATUS_MS) throughout the flood
//   - concurrent logins are rejected 503 IMMEDIATELY (single-flight, no queue)
//   - verifies still complete (401 for bad creds) and a valid login works after
//   - a viewer OPRF login over the swarm COMPLETES DURING the flood (the plane
//     the incident froze)
//   - a verify that outlives loginVerifyTimeoutMs fails 503 and the NEXT login
//     works again (worker terminated + respawned)
//
// No ffmpeg needed. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { panelClient, login } from '../sdk/login.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import * as ops from '../panel/src/ops.js'
import { startAdminServer } from '../panel/src/admin-server.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) } throw new Error('timeout: ' + label) }

const STATUS_MS = 750 // every /api/status sample must beat this (old code: seconds+)
const REJECT_MS = 500 // single-flight 503s must be immediate, not queued
const VIEWER_LOGIN_MS = 5000 // swarm login mid-flood must not queue behind a grind
const FLOOD_MS = 6000

const ADMIN_PASSWORD = 'root-secret-password'
const USER_PASSWORD = 'viewer-secret-1'
const dirs = { panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ep-flood-')), cli: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ep-flood-cli-')) }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

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
  // ===== Panel store + admin + one viewer account. Fast Argon2 for the STORED
  // verifiers; the flood later targets an UNKNOWN name, whose dummy verify reads
  // argon cost from config live, so we can crank it without touching root's record.
  const config = { argon2: { memKiB: 8192, time: 1 }, maxDevicesDefault: 2 }
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db, assets } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const ctx = { config, keys, db, assets, dataDir: dirs.panel }
  ops.addAdmin(ctx, 'root', ADMIN_PASSWORD)
  await ops.createUser(ctx, 'viewer', USER_PASSWORD)

  // Lockout threshold sky-high: this test is about the verify path, and the throttle
  // 429s BEFORE credentials are checked — it must not shield the code under test.
  const { port, close } = await startAdminServer(ctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 100000, seconds: 60 } })
  cleanups.push(close)
  const api = apiFor(port)
  log('admin API listening on', port)

  const baseline = await api('POST', '/api/login', { username: 'root', password: ADMIN_PASSWORD })
  assert.strictEqual(baseline.status, 200, 'baseline login: ' + JSON.stringify(baseline.body))
  const token = baseline.body.token

  // ===== The login-RPC plane: a viewer connected over a real Hyperswarm BEFORE the
  // flood (connection setup is DHT-paced; the assertion is about the RPC during it).
  const throttle = makeThrottle(100000, 60)
  const panelSwarm = new Hyperswarm(); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: 8, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000 }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()

  const cliStore = new Corestore(dirs.cli); await cliStore.ready(); cleanups.push(() => cliStore.close())
  const cliBee = new Hyperbee(cliStore.get({ key: keys.signing.publicKey }), { keyEncoding: 'utf-8', valueEncoding: 'json' }); await cliBee.ready()
  let call = null
  const cliSwarm = new Hyperswarm(); cleanups.push(() => cliSwarm.destroy())
  cliSwarm.on('connection', (socket) => { cliStore.replicate(socket); if (!call) call = panelClient(socket).call })
  cliSwarm.join(hcrypto.hash(keys.signing.publicKey), { client: true, server: false })
  await waitFor(async () => call, 30000, 'panel connection')
  await waitFor(async () => await cliBee.get('user/viewer'), 30000, 'DB replication')
  log('viewer connected over the swarm (login RPC + replication live)')

  // ===== Crank the (dummy-path) Argon2 cost to incident scale: each verify is a
  // multi-second memory-hard grind. Pre-fix, ONE of these froze the event loop.
  // The viewer's client-side derive uses the RECORDED (fast) cost — unaffected.
  config.argon2 = { memKiB: 262144, time: 6 } // 256 MiB × 6 passes

  // ===== The flood: volleys of concurrent bad admin logins, while /api/status is
  // sampled as the event-loop liveness probe and a viewer logs in over the swarm.
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
  let viewerLogin = null
  const t0 = Date.now()
  while (Date.now() - t0 < FLOOD_MS) {
    for (let i = 0; i < 4; i++) {
      const s = Date.now()
      floodP.push(api('POST', '/api/login', { username: 'nobody', password: 'wrong-password' }).then((r) => ({ ...r, ms: Date.now() - s })))
    }
    if (!viewerLogin && Date.now() - t0 >= 1000) { // mid-flood, with grinds in flight
      const s = Date.now()
      viewerLogin = login(call, cliBee, 'viewer', USER_PASSWORD, { deviceId: 'flood-device', deviceLabel: 'e2e' }).then((sess) => ({ sess, ms: Date.now() - s }))
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

  // ===== The viewer plane rode it out: the OPRF login issued mid-flood finished
  // without queueing behind a grind (pre-fix: minutes; incident: 25+).
  assert.ok(viewerLogin, 'viewer login was issued during the flood')
  const vl = await viewerLogin
  assert.ok(vl.sess && vl.sess.token, 'viewer login over the swarm succeeded during the flood')
  assert.ok(vl.ms < VIEWER_LOGIN_MS, `viewer login mid-flood must be fast (took ${vl.ms}ms)`)
  const relogin = await api('POST', '/api/login', { username: 'root', password: ADMIN_PASSWORD })
  assert.strictEqual(relogin.status, 200, 'valid admin login works after the flood')
  log(`B: viewer OPRF login completed mid-flood in ${vl.ms}ms; valid admin login fine after ✓`)

  // ===== Verify timeout: a grind that outlives loginVerifyTimeoutMs fails 503 and
  // the worker is respawned for the next attempt (a thrashing box keeps replicating).
  const srv2 = await startAdminServer(ctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 100000, seconds: 60 }, loginVerifyTimeoutMs: 600 })
  cleanups.push(srv2.close)
  const api2 = apiFor(srv2.port)
  const timedOut = await api2('POST', '/api/login', { username: 'nobody', password: 'x' }) // 256 MiB × 6 ≫ 600 ms
  assert.strictEqual(timedOut.status, 503, 'over-budget verify → 503: ' + JSON.stringify(timedOut.body))
  assert.match(timedOut.body.error, /timed out/, '503 names the timeout')
  let recovered = null
  for (let i = 0; i < 5 && !recovered; i++) { // root's stored verifier is cheap; fresh worker boot ≪ 600 ms
    const r = await api2('POST', '/api/login', { username: 'root', password: ADMIN_PASSWORD })
    if (r.status === 200) recovered = r
    else await sleep(300)
  }
  assert.ok(recovered, 'login recovers after a timed-out verify (worker respawned)')
  log('C: verify timeout → 503, worker respawned, next login fine ✓')

  log('\nRESULT: PASS ✅  (panel login flood: event loop responsive, single-flight 503s immediate, viewer login plane unaffected, verify timeout self-heals)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
