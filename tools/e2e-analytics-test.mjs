// Privacy-preserving analytics test (S48). Deterministic, no DHT, no ffmpeg —
// belongs in the required core lane.
//
//   A  panel rollup math on a FAKE CLOCK: hour buckets → day rollup JSON, gauge
//      min/mean/max, unique-viewers reduction, day rollover, boot reload of
//      today's file, retention prune (boot + rollover)
//   B  the retention=0 kill switch: no files, no dirs, honest empty endpoints
//   C  panel end-to-end: REAL viewer logins through attachLoginRpc over a loopback
//      SecretStream pair (ok + failed outcomes), then GET /api/analytics (admin
//      Bearer) + /metrics off a real admin server
//   D  broadcaster: egress-meter unit, sampler over a fake ChannelManager,
//      reset-aware deltas, incident folding, control-server /api/analytics +
//      per-channel /metrics lines
//   E  repeater: /metrics renders served-bytes per stream (no rollup files exist)
//   F  THE NEGATIVE IDENTITY SCAN: distinctive needle usernames / hex keys /
//      device ids / IPs are driven through every path above, then every rollup
//      file + API response + /metrics body is scanned — ZERO hits allowed
//      (the repeater e2e's known-plaintext-scan precedent).
//
// Exits 0 on PASS.

import assert from 'assert'
import os from 'os'
import fs from 'fs'
import path from 'path'
import SecretStream from '@hyperswarm/secret-stream'
import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { blind, powSolve, authKeyPair, authSign } from '@aliran/core'
import { makeAnalytics as makePanelAnalytics } from '../panel/src/analytics.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import * as ops from '../panel/src/ops.js'
import { startAdminServer } from '../panel/src/admin-server.js'
import { makeAnalytics as makeBcAnalytics, makeEgressMeter, collectChannelSamples } from '../broadcaster/src/analytics.js'
import { addAdmin as bcAddAdmin } from '../broadcaster/src/control-auth.js'
import { startControlServer } from '../broadcaster/src/control-server.js'
import { startStatusServer } from '../repeater/src/status-server.js'

const log = (...a) => console.log(...a)
const HOUR = 3600000

// ---- needles: distinctive identity-carrying values that must NEVER surface ----
const NEEDLE_USER = 'needle-user-zz93'
const NEEDLE_GHOST = 'needle-ghost-qq41' // a failed login's (unknown) username
const NEEDLE_DEVICE = 'needle-device-77'
const NEEDLE_A_USERS = ['needle-alice-a1', 'needle-bob-b2', 'needle-carol-c3', 'needle-dora-d4']

const dirs = {
  a: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ean-a-')),
  b: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ean-b-')),
  panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ean-panel-')),
  bc: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ean-bc-'))
}
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

// Bodies captured for the section-F scan: [label, text]
const scanBodies = []

function streamPair () {
  const a = new SecretStream(true)
  const b = new SecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  return [a, b]
}

// A Map standing in for the account Hyperbee — with `seq` and `cas`, because the
// `session` responder DEPENDS on both and a stand-in that drops them does not merely
// simplify, it inverts the outcome. That responder compare-and-swaps its record write
// (panel/src/rpc.js), and reads "the cas callback never ran" as "the key did not exist,
// so this put just RESURRECTED a deleted account" — whereupon it undoes the write and
// refuses the session. A `put` that silently ignores its options therefore made every
// login in section C answer 'unknown user'. It is why this lane went red the moment
// zero-write logins landed (a201af1) and stayed red: nothing else here models a bee.
//
// So: monotonic `seq` per write, and hyperbee's own cas contract — consulted only when
// the key ALREADY EXISTS (hyperbee's insert path never calls it), and the write lands
// only if it returns true.
function fakeDb (seed = {}) {
  const m = new Map()
  let seq = 0
  for (const [k, value] of Object.entries(seed)) m.set(k, { value, seq: seq++ })
  const node = (k) => (m.has(k) ? m.get(k) : null)
  return {
    async get (k) { return node(k) },
    async put (k, v, opts) {
      const prev = node(k)
      if (prev && opts && typeof opts.cas === 'function' && !opts.cas(prev, { key: k, value: v, seq: seq + 1 })) return
      m.set(k, { value: v, seq: ++seq })
    },
    async del (k, opts) {
      const prev = node(k)
      if (!prev) return
      if (opts && typeof opts.cas === 'function' && !opts.cas(prev)) return
      m.delete(k)
    },
    _map: m
  }
}

function rpcClient (stream) {
  const rpc = new ProtomuxRPC(stream)
  return async (method, payload) => {
    const buf = payload === undefined ? b4a.alloc(0) : b4a.from(JSON.stringify(payload))
    let timer
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`rpc '${method}' timed out`)), 4000) })
    try {
      const res = await Promise.race([rpc.request(method, buf), timeout])
      return JSON.parse(b4a.toString(res))
    } finally { clearTimeout(timer) }
  }
}

async function httpJson (method, port, p, { token, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { status: res.status, data, text }
}

try {
  // ===================== A: panel rollup math on a fake clock =====================
  {
    // Prune-at-boot fixture: an ancient file must be deleted, a recent one kept.
    const anDir = path.join(dirs.a, 'analytics')
    fs.mkdirSync(anDir, { recursive: true })
    fs.writeFileSync(path.join(anDir, '2020-01-01.json'), '{"v":1,"date":"2020-01-01","hours":{},"day":{}}')
    fs.writeFileSync(path.join(anDir, '2026-01-14.json'), '{"v":1,"date":"2026-01-14","hours":{"5":{"logins":{"ok":9,"failed":0},"sessions":9,"onlineApps":{"min":1,"max":1,"mean":1,"samples":1}}},"day":{"uniqueViewers":4}}')

    let now = Date.UTC(2026, 0, 15, 10, 12, 0)
    const an = makePanelAnalytics({ dataDir: dirs.a, retentionDays: 3, clock: () => now })
    assert.strictEqual(an.enabled, true)
    assert.ok(!fs.existsSync(path.join(anDir, '2020-01-01.json')), 'boot prune removed the ancient rollup')
    assert.ok(fs.existsSync(path.join(anDir, '2026-01-14.json')), 'boot prune kept the in-retention rollup')

    an.sessionIssued(NEEDLE_A_USERS[0])
    an.sessionIssued(NEEDLE_A_USERS[0]) // same user twice — uniques must stay 1
    an.sessionIssued(NEEDLE_A_USERS[1])
    an.loginFailed()
    an.tick({ onlineApps: 4 }); an.tick({ onlineApps: 8 }); an.tick({ onlineApps: 6 })
    an.setCatalog({ live: 5, redirect: 2, vod: 1 })

    now = Date.UTC(2026, 0, 15, 11, 1, 0) // hour boundary crossed
    an.sessionIssued(NEEDLE_A_USERS[2]) // triggers the rollover of hour 10
    const day15 = JSON.parse(fs.readFileSync(path.join(anDir, '2026-01-15.json'), 'utf8'))
    assert.deepStrictEqual(day15.hours['10'].logins, { ok: 3, failed: 1 }, 'hour-10 login counts')
    assert.strictEqual(day15.hours['10'].sessions, 3)
    assert.deepStrictEqual(day15.hours['10'].onlineApps, { min: 4, max: 8, mean: 6, samples: 3 }, 'gauge min/mean/max')
    assert.deepStrictEqual(day15.hours['10'].catalog, { live: 5, redirect: 2, vod: 1 }, 'catalog snapshot attached at reduce')
    assert.strictEqual(day15.day.uniqueViewers, 2, 'uniques/day = Set size at rollup (duplicate collapsed)')

    const api1 = an.api(2)
    assert.strictEqual(api1.enabled, true)
    assert.strictEqual(api1.current.hour, 11)
    assert.strictEqual(api1.current.logins.ok, 1)
    assert.strictEqual(api1.current.uniqueViewersToday, 3)
    assert.ok(api1.days.some((d) => d.date === '2026-01-14'), 'api reads earlier in-retention days off disk')

    now = Date.UTC(2026, 0, 16, 0, 5, 0) // day boundary crossed
    an.sessionIssued(NEEDLE_A_USERS[3]) // closes out Jan-15 hour 11, starts Jan-16
    const day15b = JSON.parse(fs.readFileSync(path.join(anDir, '2026-01-15.json'), 'utf8'))
    assert.strictEqual(day15b.hours['11'].logins.ok, 1, 'day rollover reduced the final hour into the OLD day')
    assert.strictEqual(day15b.day.uniqueViewers, 3, 'day uniques count finalized (3 distinct users)')
    assert.strictEqual(an.api(1).current.uniqueViewersToday, 1, 'day Set discarded at rollover')

    // Boot reload: a fresh instance over the same dir sees today's completed hours.
    now = Date.UTC(2026, 0, 15, 23, 30, 0)
    const an2 = makePanelAnalytics({ dataDir: dirs.a, retentionDays: 3, clock: () => now })
    const reload = an2.api(1)
    assert.strictEqual(reload.days[0].hours['10'].logins.ok, 3, 'boot reload restored today\'s completed hours')

    // metrics snapshot is process-lifetime totals + cached gauges
    const ms = an.metricsSnapshot()
    assert.strictEqual(ms.loginsOk, 5); assert.strictEqual(ms.loginsFailed, 1); assert.strictEqual(ms.sessions, 5)
    assert.deepStrictEqual(ms.catalog, { live: 5, redirect: 2, vod: 1 })
    log('A: panel bucket math, day rollover, uniques reduction, boot reload, prune ✓')
  }

  // ===================== B: the retention=0 kill switch =====================
  {
    const an = makePanelAnalytics({ dataDir: dirs.b, retentionDays: 0 })
    assert.strictEqual(an.enabled, false)
    an.sessionIssued('someone'); an.loginFailed(); an.tick({ onlineApps: 3 }); an.setCatalog({ live: 1 })
    assert.deepStrictEqual(an.api(7), { enabled: false, retentionDays: 0, days: [], current: null })
    assert.strictEqual(an.metricsSnapshot(), null)
    assert.ok(!fs.existsSync(path.join(dirs.b, 'analytics')), 'kill switch: no analytics dir is ever created')
    const bc = makeBcAnalytics({ dataDir: dirs.b, retentionDays: 0 })
    bc.tick([{ id: 'x', peers: 1, egressBytes: 10, respawns: 0 }])
    assert.strictEqual(bc.enabled, false)
    assert.ok(!fs.existsSync(path.join(dirs.b, 'analytics')), 'kill switch holds for the broadcaster module too')
    log('B: retention=0 collects nothing, writes nothing, answers honestly ✓')
  }

  // ===================== C: panel end-to-end (real logins → API + metrics) =====================
  let panelMetricsText, panelApiText
  const viewer = authKeyPair()
  let clientPubHex
  {
    initKeys(dirs.panel)
    const keys = openKeys(dirs.panel)
    const db = fakeDb({
      ['user/' + NEEDLE_USER]: { authPub: b4a.toString(viewer.publicKey, 'hex'), status: 'active', devices: [], tokenVersion: 1, maxDevices: 2 }
    })
    // Fake clock so the needle-driven counts ROLL INTO A FILE we can scan in F.
    let now = Date.UTC(2026, 2, 3, 9, 20, 0)
    const analytics = makePanelAnalytics({ dataDir: dirs.panel, retentionDays: 30, clock: () => now })

    const [cli, srv] = streamPair()
    cleanups.push(() => { cli.destroy(); srv.destroy() })
    attachLoginRpc(srv, { keys, difficulty: 1, throttle: makeThrottle(1000, 900), db, dataDir: dirs.panel, activity: null, analytics, legacyPublisher: true })
    const call = rpcClient(cli)
    clientPubHex = b4a.toString(cli.publicKey, 'hex')

    // A real, complete viewer login: hello → PoW → OPRF login → signed session.
    const doLogin = async (username) => {
      const chal = b4a.from((await call('hello')).challenge, 'hex')
      const nonce = powSolve(chal, 1)
      const { blinded } = blind('pw-' + username)
      return call('login', { username, blinded: b4a.toString(blinded, 'hex'), powNonce: b4a.toString(nonce, 'hex') })
    }
    const l1 = await doLogin(NEEDLE_USER)
    assert.ok(l1.sessionChallenge, 'login returned a session challenge')
    const sig = b4a.toString(authSign(viewer.secretKey, b4a.from(l1.sessionChallenge, 'hex')), 'hex')
    const s1 = await call('session', { username: NEEDLE_USER, deviceId: NEEDLE_DEVICE, sig })
    assert.ok(s1.token, 'session token issued')

    // Failed outcomes: an unknown user, and a bad signature for a real one.
    const l2 = await doLogin(NEEDLE_GHOST)
    const s2 = await call('session', { username: NEEDLE_GHOST, deviceId: NEEDLE_DEVICE, sig: '00'.repeat(64) })
    assert.strictEqual(s2.error, 'unknown user')
    const l3 = await doLogin(NEEDLE_USER)
    assert.ok(l2 && l3, 'login RPCs answered')
    const s3 = await call('session', { username: NEEDLE_USER, deviceId: NEEDLE_DEVICE, sig: '11'.repeat(64) })
    assert.strictEqual(s3.error, 'auth failed')

    analytics.tick({ onlineApps: 2 })
    analytics.setCatalog({ live: 1, redirect: 2, vod: 3 })

    const cur = analytics.api(1).current
    assert.strictEqual(cur.logins.ok, 1, 'one verified login counted ok')
    assert.strictEqual(cur.logins.failed, 2, 'unknown-user + bad-sig counted failed')
    assert.strictEqual(cur.sessions, 1)
    assert.strictEqual(cur.uniqueViewersToday, 1, 'uniques counts only VERIFIED users (ghost excluded)')

    // Roll the needle-driven hour into a rollup file (scanned in F).
    now = Date.UTC(2026, 2, 3, 10, 0, 5)
    analytics.tick({ onlineApps: 2 })
    assert.ok(fs.existsSync(path.join(dirs.panel, 'analytics', '2026-03-03.json')), 'needle-driven hour rolled into a day file')

    // Real admin server: Bearer-gated /api/analytics + unauthenticated /metrics.
    const ctx = { config: { argon2: { memKiB: 8192, time: 1 } }, keys, db, assets: null, dataDir: dirs.panel, analytics }
    ops.addAdmin(ctx, 'op', 'op-password-1')
    const admin = await startAdminServer(ctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 50, seconds: 60 } })
    cleanups.push(admin.close)
    assert.strictEqual((await httpJson('GET', admin.port, '/api/analytics')).status, 401, '/api/analytics requires auth')
    const { data: login } = await httpJson('POST', admin.port, '/api/login', { body: { username: 'op', password: 'op-password-1' } })
    const r = await httpJson('GET', admin.port, '/api/analytics?days=3', { token: login.token })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.data.enabled, true)
    assert.strictEqual(r.data.days.at(-1).hours['9'].logins.ok, 1, 'API serves the rolled-up hour')
    assert.strictEqual(r.data.days.at(-1).hours['9'].logins.failed, 2)
    assert.strictEqual(r.data.days.at(-1).day.uniqueViewers, 1)
    panelApiText = r.text
    const m = await fetch(`http://127.0.0.1:${admin.port}/metrics`)
    panelMetricsText = await m.text()
    assert.ok(panelMetricsText.includes('aliran_panel_logins_ok_total 1'), 'metrics: logins ok total')
    assert.ok(panelMetricsText.includes('aliran_panel_logins_failed_total 2'), 'metrics: logins failed total')
    assert.ok(panelMetricsText.includes('aliran_panel_sessions_issued_total 1'), 'metrics: sessions total')
    assert.ok(panelMetricsText.includes('aliran_panel_catalog_channels{class="redirect"} 2'), 'metrics: catalog composition')
    log('C: real loopback logins counted (ok/failed/uniques), API + /metrics serve aggregates ✓')
  }

  // ===================== D: broadcaster meters, sampler, deltas, API + metrics =====================
  let bcMetricsText, bcApiText
  {
    // Egress meter over fake sockets: closed bytes accumulate, live bytes add on read.
    const meter = makeEgressMeter()
    const mkSock = (tx) => {
      const handlers = {}
      return {
        rawStream: { bytesTransmitted: tx },
        on (ev, fn) { handlers[ev] = fn },
        close () { handlers.close && handlers.close() }
      }
    }
    const s1 = mkSock(100)
    meter.onConnection(s1)
    assert.strictEqual(meter.total(), 100, 'live connection bytes counted')
    s1.rawStream.bytesTransmitted = 150
    s1.close()
    assert.strictEqual(meter.total(), 150, 'closed connection bytes accumulated (not lost)')
    const s2 = mkSock(30)
    meter.onConnection(s2)
    assert.strictEqual(meter.total(), 180, 'closed + live sum')

    // Sampler over a fake ChannelManager (the test:mcp fake-manager precedent).
    const fakeChannel = (id, peers, egress, restarts) => ({
      meta: { id },
      run: {
        swarm: { connections: { size: peers } },
        egress: { total: () => egress },
        watchdog: { restarts }
      }
    })
    const manager = {
      channels: new Map([
        ['news-24', fakeChannel('news-24', 3, 1000, 1)],
        ['film-hd', fakeChannel('film-hd', 1, 500, 0)],
        ['stopped-ch', { meta: { id: 'stopped-ch' }, run: null }]
      ]),
      health: () => ({ up: true, uptimeSec: 1, resuming: false, resumed: 0, failed: 0, total: 3 }),
      incidents: { list: () => [] },
      statusSummary: async () => ({ channels: 3 })
    }
    const samples = collectChannelSamples(manager)
    assert.deepStrictEqual(samples.map((s) => s.id).sort(), ['film-hd', 'news-24'], 'stopped channels are not sampled')

    let now = Date.UTC(2026, 2, 3, 14, 2, 0)
    const incidents = []
    const an = makeBcAnalytics({ dataDir: dirs.bc, retentionDays: 14, clock: () => now })
    now += 60000
    incidents.push({ t: now - 1000, type: 'fleet-restart', channels: 9 })
    an.tick(collectChannelSamples(manager), { list: () => incidents })
    // Cumulatives grow: egress 1000→2500, respawns 1→3 ⇒ deltas 1500 / 2.
    manager.channels.get('news-24').run.egress.total = () => 2500
    manager.channels.get('news-24').run.watchdog.restarts = 3
    now += 300000
    an.tick(collectChannelSamples(manager), { list: () => incidents })
    // Channel restarted: cumulative SHRINKS (2500→400) ⇒ the delta is the new value.
    manager.channels.get('news-24').run.egress.total = () => 400
    now += 300000
    an.tick(collectChannelSamples(manager), { list: () => incidents })
    const cur = an.api(1).current
    assert.strictEqual(cur.channels['news-24'].egressBytes, 2900, 'reset-aware egress deltas (1000+1500+400)')
    assert.strictEqual(cur.channels['news-24'].respawns, 3, 'reset-aware respawn deltas')
    assert.deepStrictEqual([cur.channels['news-24'].peers.min, cur.channels['news-24'].peers.max], [3, 3])
    assert.strictEqual(cur.incidents, 1, 'incident counted once, not per tick')

    // Hour rollover → day file with per-channel entries.
    now = Date.UTC(2026, 2, 3, 15, 0, 5)
    an.tick(collectChannelSamples(manager), { list: () => incidents })
    const day = JSON.parse(fs.readFileSync(path.join(dirs.bc, 'analytics', '2026-03-03.json'), 'utf8'))
    assert.strictEqual(day.hours['14'].channels['news-24'].egressBytes, 2900, 'rollup file carries the hour totals')
    assert.strictEqual(day.hours['14'].incidents, 1)

    // Control server: Bearer-gated /api/analytics + per-channel /metrics lines.
    const bcConfig = { dataDir: dirs.bc, argon2: { memKiB: 8192, time: 1 } }
    bcAddAdmin({ config: bcConfig, dataDir: dirs.bc }, 'bcop', 'bc-op-password-1')
    const srv = await startControlServer({ config: bcConfig, manager, dataDir: dirs.bc, analytics: an }, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 50, seconds: 60 } })
    cleanups.push(srv.close)
    assert.strictEqual((await httpJson('GET', srv.port, '/api/analytics')).status, 401, 'broadcaster /api/analytics requires auth')
    const { data: login } = await httpJson('POST', srv.port, '/api/login', { body: { username: 'bcop', password: 'bc-op-password-1' } })
    const r = await httpJson('GET', srv.port, '/api/analytics?days=2', { token: login.token })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.data.days.at(-1).hours['14'].channels['film-hd'].egressBytes, 500)
    bcApiText = r.text
    const m = await fetch(`http://127.0.0.1:${srv.port}/metrics`)
    bcMetricsText = await m.text()
    assert.ok(bcMetricsText.includes('aliran_broadcaster_channel_peers{stream_id="news-24"} 3'), 'per-channel peers gauge')
    assert.ok(bcMetricsText.includes('aliran_broadcaster_channel_egress_bytes_total{stream_id="news-24"} 400'), 'per-channel egress counter (last sample)')
    assert.ok(bcMetricsText.includes('aliran_broadcaster_channels 3'), 'pre-existing gauges untouched')
    log('D: egress meter, sampler, reset-aware deltas, incidents, control API + per-channel metrics ✓')
  }

  // ===================== E: repeater served-bytes metrics (no files, render only) =====================
  let repMetricsText
  {
    const fakeRepeater = {
      status: () => ({
        panelPubKey: 'e'.repeat(64),
        selection: { mode: 'all' },
        retentionSeconds: 300,
        swarm: { publicKey: 'f'.repeat(64), connections: 2, maxPeers: 16 },
        channels: [{
          streamId: 'news-24',
          feedKey: 'a'.repeat(64),
          blobsKey: 'b'.repeat(64),
          cores: {
            db: { key: 'a'.repeat(64), armed: true, length: 12, clearedUpTo: 4, held: 9, peers: 2, servedBytes: 4096 },
            blobs: { key: 'b'.repeat(64), armed: true, length: 40, clearedUpTo: 10, held: 30, peers: 2, servedBytes: 123456 }
          }
        }]
      })
    }
    const st = await startStatusServer(fakeRepeater, { host: '127.0.0.1', port: 0 })
    cleanups.push(st.close)
    const m = await fetch(`http://127.0.0.1:${st.port}/metrics`)
    repMetricsText = await m.text()
    assert.ok(repMetricsText.includes('aliran_repeater_served_bytes_total{stream_id="news-24",core="db"} 4096'), 'served bytes per stream (db core)')
    assert.ok(repMetricsText.includes('aliran_repeater_served_bytes_total{stream_id="news-24",core="blobs"} 123456'), 'served bytes per stream (blobs core)')
    assert.ok(repMetricsText.includes('aliran_repeater_held_blocks{stream_id="news-24",core="db"} 9'), 'existing held_blocks untouched')
    log('E: repeater /metrics serves per-stream served-bytes beside held_blocks/peers ✓')
  }

  // ===================== F: THE NEGATIVE IDENTITY SCAN =====================
  {
    const needles = [
      ['username (verified)', NEEDLE_USER],
      ['username (failed attempt)', NEEDLE_GHOST],
      ['device id', NEEDLE_DEVICE],
      ...NEEDLE_A_USERS.map((u) => ['username (rollup-driven)', u]),
      ['viewer auth public key', b4a.toString(viewer.publicKey, 'hex')],
      ['client noise public key', clientPubHex],
      ['IP literal', '127.0.0.1']
    ]
    const HEX64 = /[0-9a-f]{64}/i

    // Every rollup file written anywhere in this run…
    const files = []
    for (const d of [dirs.a, dirs.b, dirs.panel, dirs.bc]) {
      const anDir = path.join(d, 'analytics')
      if (!fs.existsSync(anDir)) continue
      for (const n of fs.readdirSync(anDir)) files.push([path.join(anDir, n), fs.readFileSync(path.join(anDir, n), 'utf8')])
    }
    assert.ok(files.length >= 3, `positive control: rollup files were actually written (${files.length})`)
    // …plus every API response and /metrics body captured above.
    scanBodies.push(
      ...files.map(([p, text]) => ['file ' + path.basename(p), text]),
      ['panel /api/analytics', panelApiText],
      ['panel /metrics', panelMetricsText],
      ['broadcaster /api/analytics', bcApiText],
      ['broadcaster /metrics', bcMetricsText],
      ['repeater /metrics', repMetricsText]
    )
    const hits = []
    for (const [label, text] of scanBodies) {
      for (const [what, needle] of needles) {
        if (text.includes(needle)) hits.push(`${what} "${needle}" found in ${label}`)
      }
      if (HEX64.test(text)) hits.push(`64-hex key material found in ${label}`)
    }
    assert.deepStrictEqual(hits, [], 'IDENTITY LEAK:\n  ' + hits.join('\n  '))
    log(`F: negative identity scan — ${scanBodies.length} surfaces × ${needles.length + 1} needle classes, ZERO hits ✓`)
  }

  log('\nRESULT: PASS ✅  (rollup math + rollover + reload + prune; kill switch; real loopback logins → API/metrics; broadcaster meters/deltas/incidents; repeater served-bytes; negative identity scan clean)')
  await cleanup(); process.exit(0)
} catch (err) {
  console.error('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
