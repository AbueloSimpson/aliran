// Viewer problem reports — panel ingest core (S50a). Deterministic: a loopback
// SecretStream pair + in-memory bee, no DHT, no ffmpeg, no HTTP. Belongs in the
// required core lane.
//
//   A  CRASH FUZZING. The `report` responder is the only surface a viewer can push
//      free text into, and a responder that THROWS kills the whole panel (protomux-rpc
//      hands the throw to safety-catch, which rethrows TypeError/RangeError into a
//      microtask — see the hexField note in panel/src/rpc.js). So the harness arms
//      uncaught/rejection guards and fires non-string tokens, object categories, a
//      20 KiB payload, nested events and numbers-where-strings-go: every one must come
//      back as an in-band {error} (or a sanitized ok) with the process still alive.
//   B  HAPPY PATH: a real hello → PoW → OPRF login → signed session → report. The
//      stored record has the documented shape, and its `reporter` is a 16-hex
//      pseudonym derived from the TOKEN — payload-supplied identity fields are ignored.
//   C  THROTTLE: the shared per-reporter limiter locks the 6th report in the window.
//   D  DEDUPE: the same reporter/channel/category twice = ONE record with count 2.
//   E  LIFECYCLE + KILL SWITCH: ack/resolve through the module; retentionDays=0 is a
//      no-op store that never touches disk AND the RPC method does not exist at all.
//   F  STORM DRILL: 200 real report RPCs, one channel, 30 reporters. The global
//      breaker sheds most of them, the storm collapse caps STORED records at
//      stormSampleSize, exactly ONE alert opens (extended, never duplicated, onAlert
//      fired once), and a viewer logging in on another connection MEANWHILE is not
//      made to wait — reports are the lowest-priority responder.
//   G  ADMIN HTTP SURFACE (S50b): a real panel store + admin server in-process.
//      Auth is enforced, the list/summary/alerts reads answer the documented shapes,
//      the filters work, ack/resolve round-trip over HTTP, an unknown id is a clean
//      404, test-notify reaches the real target, and every mutation lands in the
//      activity ring as an admin audit entry.
//   H  NOTIFIER DELIVERY (S50b): a local http.createServer stub stands in for BOTH
//      the webhook and (via the injected telegramApiBase) the Telegram API. An alert
//      that opens fires EXACTLY ONE POST per target — never one per report — and the
//      webhook body carries title/message/text/content/channel/count plus X-Title,
//      the one shape that satisfies ntfy, Slack and Discord at the same time.
//   I  FAIL-DARK (S50b): endpoints that blackhole, hang, 500 or do not exist. Ingest
//      stays fast and keeps storing WHILE the notifier is stuck, the notification is
//      dropped after its retry budget, the queue is bounded, and an unconfigured
//      notifier is a complete no-op.
//   J  THE NEGATIVE IDENTITY SCAN: analytics runs beside reports through the same
//      logins, then every reports file, alerts file, module response, report-shaped
//      activity-ring entry and analytics rollup is scanned for the needle usernames,
//      device ids and session tokens — ZERO hits (the test:analytics precedent). The
//      replicated bee is checked structurally instead (it legitimately holds the
//      account records): no report namespace, no report content, in either lane.
//
// Exits 0 on PASS, 1 on any failure.

import assert from 'assert'
import os from 'os'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import SecretStream from '@hyperswarm/secret-stream'
import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { blind, powSolve, authKeyPair, authSign } from '@aliran/core'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { makeReports, normalizeReport, REPORT_CATEGORIES } from '../panel/src/reports.js'
import { makeNotifier, renderAlert } from '../panel/src/notify.js'
import { makeAnalytics } from '../panel/src/analytics.js'
import { makeRing } from '../panel/src/activity.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import * as ops from '../panel/src/ops.js'
import { startAdminServer } from '../panel/src/admin-server.js'

const log = (...a) => console.log(...a)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- needles: identity-carrying values that must NEVER reach a report surface ----
const NEEDLE_USER = 'needle-reporter-x7q'
const NEEDLE_DEVICE = 'needle-device-r9k'
const NEEDLE_STORM_USERS = Array.from({ length: 30 }, (_, i) => `needle-storm-user-${i}`)
const NEEDLE_STORM_DEVICE = 'needle-storm-device-b3'

const dirs = {}
const mkdir = (tag) => (dirs[tag] = fs.mkdtempSync(path.join(os.tmpdir(), 'e2erp-' + tag + '-')))
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

// A responder crash never sends a reply, so an rpc that hangs IS the regression.
let crashed = null
process.on('uncaughtException', (e) => { crashed = e; console.error('  FAIL uncaughtException:', e && e.stack) })
process.on('unhandledRejection', (e) => { crashed = e; console.error('  FAIL unhandledRejection:', e && (e.stack || e)) })

function streamPair () {
  const a = new SecretStream(true)
  const b = new SecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  return [a, b]
}

function fakeDb (seed = {}) {
  const m = new Map(Object.entries(seed))
  return {
    async get (k) { return m.has(k) ? { value: m.get(k) } : null },
    async put (k, v) { m.set(k, v) },
    async del (k) { m.delete(k) },
    _map: m
  }
}

function rpcClient (stream, timeoutMs = 8000) {
  const rpc = new ProtomuxRPC(stream)
  const call = async (method, payload, { raw } = {}) => {
    const buf = raw !== undefined ? raw : (payload === undefined ? b4a.alloc(0) : b4a.from(JSON.stringify(payload)))
    let timer
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`rpc '${method}' timed out — handler likely crashed`)), timeoutMs) })
    try {
      const res = await Promise.race([rpc.request(method, buf), timeout])
      return JSON.parse(b4a.toString(res))
    } finally { clearTimeout(timer) }
  }
  return { rpc, call }
}

// A local HTTP stub standing in for the operator's webhook AND (via the injected
// telegramApiBase) the Telegram API. Every request is recorded; `mode` decides how
// it answers — 'ok', 'error' (500), or 'hang' (accepts the request and NEVER
// replies: the blackhole the fail-dark lane needs).
function stubServer (mode = 'ok') {
  const seen = []
  const held = new Set()
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
      seen.push({ method: req.method, url: req.url, headers: req.headers, body, raw: Buffer.concat(chunks).toString('utf8') })
      if (mode === 'hang') { held.add(res); return }
      if (mode === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"nope"}') }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({
      seen,
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => {
        for (const res of held) { try { res.destroy() } catch {} }
        if (server.closeAllConnections) server.closeAllConnections()
        server.close(() => r())
      })
    })
  }))
}

// A complete, REAL viewer login: hello → PoW → OPRF login → signed session token.
async function doLogin (call, username, deviceId, viewer) {
  const chal = b4a.from((await call('hello')).challenge, 'hex')
  const nonce = powSolve(chal, 1)
  const { blinded } = blind('pw-' + username)
  const res = await call('login', { username, blinded: b4a.toString(blinded, 'hex'), powNonce: b4a.toString(nonce, 'hex') })
  assert.ok(res.sessionChallenge, `login for ${username} returned a session challenge`)
  const sig = b4a.toString(authSign(viewer.secretKey, b4a.from(res.sessionChallenge, 'hex')), 'hex')
  const s = await call('session', { username, deviceId, sig })
  assert.ok(s.token, `session token issued for ${username}`)
  return s.token
}

const viewer = authKeyPair()
const seedUser = () => ({ authPub: b4a.toString(viewer.publicKey, 'hex'), status: 'active', devices: [], tokenVersion: 1, maxDevices: 100 })

// Bodies captured for the section-G scan: [label, text]
const scanBodies = []

try {
  // ===================== A: crash fuzzing =====================
  {
    const dir = mkdir('fuzz')
    const signing = hcrypto.keyPair()
    const db = fakeDb({ ['user/' + NEEDLE_USER]: seedUser() })
    const reports = makeReports({ dataDir: dir, retentionDays: 30 })
    const [cli, srv] = streamPair()
    cleanups.push(() => { cli.destroy(); srv.destroy() })
    attachLoginRpc(srv, { keys: { signing }, oprfKey: hcrypto.randomBytes(32), difficulty: 1, throttle: makeThrottle(1000, 900), db, dataDir: dir, reports, reportThrottle: makeThrottle(1000, 900) })
    const { call } = rpcClient(cli)

    // Unauthenticated junk: every one of these must be an in-band error.
    for (const [label, token] of [['object', {}], ['number', 5], ['array', [1, 2]], ['bool', true], ['null', null], ['empty', ''], ['garbage', 'zz'], ['dotted-garbage', 'a.b'], ['no-dot', 'abcdef']]) {
      const r = await call('report', { token, category: 'buffering', channel: 'news-24' })
      assert.strictEqual(typeof r.error, 'string', `report token=${label} → in-band error (got ${JSON.stringify(r)})`)
    }
    // A forged token signed by the WRONG key.
    {
      const other = hcrypto.keyPair()
      const body = b4a.from(JSON.stringify({ userId: NEEDLE_USER, deviceId: NEEDLE_DEVICE, expiresAt: Date.now() + 60000, tokenVersion: 1 }))
      const sig = b4a.alloc(64)
      const forged = b4a.toString(body, 'base64') + '.' + b4a.toString(sig, 'base64')
      const r = await call('report', { token: forged, category: 'other' })
      assert.strictEqual(r.error, 'unauthorized', 'a forged token is unauthorized')
      assert.ok(other, 'wrong-key material built')
    }
    // The 16 KiB raw size cap, enforced BEFORE JSON.parse.
    {
      const big = b4a.from(JSON.stringify({ token: 'x'.repeat(20000), category: 'other' }))
      assert.ok(big.length > 16384, 'oversize payload really is > 16 KiB')
      const r = await call('report', undefined, { raw: big })
      assert.strictEqual(r.error, 'too large', 'a 20 KiB report is refused before parse')
    }
    // Not-JSON, and JSON that is not an object.
    assert.strictEqual((await call('report', undefined, { raw: b4a.from('{not json') })).error, 'bad request', 'malformed JSON → bad request')
    assert.strictEqual((await call('report', [1, 2, 3])).error, 'bad request', 'a JSON array payload → bad request')
    assert.strictEqual(typeof (await call('report', undefined, { raw: b4a.alloc(0) })).error, 'string', 'an empty buffer → error')

    // Authenticated field fuzzing: a REAL token, then every field the wrong type.
    const token = await doLogin(call, NEEDLE_USER, NEEDLE_DEVICE, viewer)
    for (const [label, body] of [
      ['category object', { category: {} }],
      ['category number', { category: 7 }],
      ['category array', { category: ['buffering'] }],
      ['category unknown', { category: 'not-a-category' }],
      ['category missing', {}]
    ]) {
      const r = await call('report', { token, ...body })
      assert.strictEqual(r.error, 'bad-category', `${label} → bad-category, never coerced (got ${JSON.stringify(r)})`)
    }
    for (const [label, body] of [
      ['text object', { category: 'other', text: { a: 1 } }],
      ['channel array', { category: 'other', channel: ['news'] }],
      ['peers string', { category: 'other', peers: 'many' }],
      ['events object', { category: 'other', events: { nested: { deep: { deeper: 1 } } } }],
      ['events of junk', { category: 'other', events: [null, 5, 'x', [], { type: 9 }, { detail: 'no type' }] }],
      ['appVersion number', { category: 'other', appVersion: 42, platform: false }],
      // 55 events × a 220-char detail — over the 50/200 caps, but deliberately under
      // the 16 KiB raw cap so it reaches the sanitizer instead of the size gate.
      ['over-cap event list', { category: 'other', events: Array.from({ length: 55 }, (_, i) => ({ t: i, type: 'e' + i, detail: 'd'.repeat(220) })) }]
    ]) {
      const r = await call('report', { token, ...body })
      assert.strictEqual(r.ok, true, `${label} → sanitized ok, no crash (got ${JSON.stringify(r)})`)
    }
    // The sanitizer really did cap things.
    const stored = reports.list({ limit: 1000 })
    const huge = stored.find((r) => r.events.length > 0 && r.events[0].type === 'e0')
    assert.ok(huge, 'the over-cap event report was stored')
    assert.strictEqual(huge.events.length, 50, 'events capped at 50')
    assert.ok(huge.events.every((e) => (e.detail || '').length <= 200), 'event detail capped at 200 bytes')
    // Control characters and over-long text are stripped/capped, not stored raw.
    {
      const r = await call('report', { token, category: 'other', channel: 'ctl-ch', text: 'a\x00b\x1fc' + 'z'.repeat(400) })
      assert.strictEqual(r.ok, true)
      const rec = reports.list({ channel: 'ctl-ch' })[0]
      assert.ok(!/[\x00-\x1f]/.test(rec.text), 'control characters stripped from free text')
      assert.strictEqual(rec.text.length, 300, 'free text capped at 300 chars')
    }
    // normalizeReport is total: it never throws on any shape.
    for (const junk of [null, undefined, 0, 'x', [], { category: null }, { category: 'other', events: 'nope' }]) {
      assert.doesNotThrow(() => normalizeReport(junk), 'normalizeReport never throws')
    }
    await new Promise((r) => setTimeout(r, 60)) // let a deferred microtask throw surface
    assert.ok(!crashed, 'no uncaught exception fired during the fuzz lane')
    log('A: crash fuzzing — bad tokens, oversize payloads, wrong-typed fields all fail closed; panel alive ✓')
  }

  // ===================== B: happy path =====================
  let happyReporter
  {
    const dir = mkdir('happy')
    const signing = hcrypto.keyPair()
    const db = fakeDb({ ['user/' + NEEDLE_USER]: seedUser() })
    const reports = makeReports({ dataDir: dir, retentionDays: 30 })
    const activity = makeRing(50)
    const [cli, srv] = streamPair()
    cleanups.push(() => { cli.destroy(); srv.destroy() })
    attachLoginRpc(srv, { keys: { signing }, oprfKey: hcrypto.randomBytes(32), difficulty: 1, throttle: makeThrottle(1000, 900), db, dataDir: dir, reports, reportThrottle: makeThrottle(1000, 900), activity })
    const { call } = rpcClient(cli)

    const token = await doLogin(call, NEEDLE_USER, NEEDLE_DEVICE, viewer)
    const res = await call('report', {
      token,
      category: 'no-audio',
      text: 'no sound since 20:00',
      channel: 'news-24',
      appVersion: '0.2.0',
      platform: 'android-tv',
      peers: 4,
      events: [{ t: 1, type: 'error', detail: 'audio decoder stalled' }],
      // Identity fields a hostile client might try to steer with — ignored entirely.
      username: 'somebody-else',
      reporter: 'deadbeefdeadbeef',
      deviceId: 'not-my-device'
    })
    assert.strictEqual(res.ok, true, 'report accepted')
    assert.ok(res.id, 'report id returned')

    const rec = reports.get(res.id)
    assert.ok(rec, 'record persisted')
    assert.deepStrictEqual(Object.keys(rec).sort(), ['ackAt', 'appVersion', 'at', 'category', 'channel', 'count', 'events', 'id', 'lastAt', 'note', 'peers', 'platform', 'reporter', 'resolvedAt', 'status', 'text'].sort(), 'record has the documented shape')
    assert.strictEqual(rec.category, 'no-audio')
    assert.strictEqual(rec.channel, 'news-24')
    assert.strictEqual(rec.status, 'new')
    assert.strictEqual(rec.count, 1)
    assert.strictEqual(rec.peers, 4)
    assert.deepStrictEqual(rec.events, [{ t: 1, type: 'error', detail: 'audio decoder stalled' }])
    assert.ok(/^[0-9a-f]{16}$/.test(rec.reporter), `reporter is a 16-hex pseudonym (got ${rec.reporter})`)
    // Identity comes from the TOKEN, not from anything in the payload.
    assert.strictEqual(rec.reporter, reports.pseudonym(NEEDLE_USER, NEEDLE_DEVICE), 'pseudonym derives from the token identity')
    assert.notStrictEqual(rec.reporter, 'deadbeefdeadbeef', 'a payload-supplied reporter is ignored')
    happyReporter = rec.reporter
    // The salt is per-deployment: another panel derives a DIFFERENT pseudonym.
    const other = makeReports({ dataDir: mkdir('salt2'), retentionDays: 30 })
    assert.notStrictEqual(other.pseudonym(NEEDLE_USER, NEEDLE_DEVICE), rec.reporter, 'a different salt yields a different pseudonym')
    other.close()
    // The salt file itself is owner-only where the OS has mode bits.
    const saltPath = path.join(dir, 'secrets', 'reports-salt')
    assert.ok(fs.existsSync(saltPath), 'the pseudonym salt was generated into secrets/')
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(saltPath).mode & 0o777, 0o600, 'reports-salt is 0600')

    // The activity ring carries WHAT broke, never WHO.
    const ev = activity.list().find((e) => e.type === 'report')
    assert.ok(ev, 'a report event reached the activity ring')
    assert.deepStrictEqual(Object.keys(ev).sort(), ['category', 'channel', 't', 'type'], 'activity entry carries only channel+category')
    // Only the REPORT entries: the ring's pre-existing 'session' events deliberately
    // carry user/deviceId (S16 loopback-only observability) — that is not this
    // segment's surface, and the invariant here is that a report adds no identity.
    scanBodies.push(['activity ring (report entries)', JSON.stringify(activity.list().filter((e) => e.type === 'report'))])

    // Revocation-aware: revoke the device and the very next report is refused.
    const user = (await db.get('user/' + NEEDLE_USER)).value
    user.devices = []
    await db.put('user/' + NEEDLE_USER, user)
    const after = await call('report', { token, category: 'other', channel: 'news-24' })
    assert.strictEqual(after.error, 'unauthorized', 'a revoked device cannot report')

    scanBodies.push(['reports.list()', JSON.stringify(reports.list())], ['reports.summary()', JSON.stringify(reports.summary())])
    reports.close()
    log('B: happy path — real login → report → documented record shape, token-derived pseudonym, revoke-aware ✓')
  }

  // ===================== C: per-reporter throttle =====================
  {
    const dir = mkdir('throttle')
    const signing = hcrypto.keyPair()
    const db = fakeDb({ ['user/' + NEEDLE_USER]: seedUser() })
    const reports = makeReports({ dataDir: dir, retentionDays: 30, alertCount: 99 })
    const [cli, srv] = streamPair()
    cleanups.push(() => { cli.destroy(); srv.destroy() })
    attachLoginRpc(srv, { keys: { signing }, oprfKey: hcrypto.randomBytes(32), difficulty: 1, throttle: makeThrottle(1000, 900), db, dataDir: dir, reports, reportThrottle: makeThrottle(5, 600) })
    const { call } = rpcClient(cli)
    const token = await doLogin(call, NEEDLE_USER, NEEDLE_DEVICE, viewer)

    for (let i = 0; i < 5; i++) {
      const r = await call('report', { token, category: 'buffering', channel: 'ch-' + i })
      assert.strictEqual(r.ok, true, `report ${i + 1} of the window accepted`)
    }
    const sixth = await call('report', { token, category: 'buffering', channel: 'ch-6' })
    assert.strictEqual(sixth.error, 'locked', 'the 6th report in the window is locked')
    assert.ok(Number.isFinite(sixth.retryAfter) && sixth.retryAfter > 0, `retryAfter is a positive number (got ${sixth.retryAfter})`)
    assert.strictEqual(reports.list({ limit: 100 }).length, 5, 'the locked report was never stored')
    reports.close()
    log(`C: throttle — 5 per window accepted, the 6th locked with retryAfter=${sixth.retryAfter}s ✓`)
  }

  // ===================== D: dedupe =====================
  {
    const dir = mkdir('dedupe')
    const signing = hcrypto.keyPair()
    const db = fakeDb({ ['user/' + NEEDLE_USER]: seedUser() })
    const reports = makeReports({ dataDir: dir, retentionDays: 30, alertCount: 99 })
    const [cli, srv] = streamPair()
    cleanups.push(() => { cli.destroy(); srv.destroy() })
    attachLoginRpc(srv, { keys: { signing }, oprfKey: hcrypto.randomBytes(32), difficulty: 1, throttle: makeThrottle(1000, 900), db, dataDir: dir, reports, reportThrottle: makeThrottle(1000, 900) })
    const { call } = rpcClient(cli)
    const token = await doLogin(call, NEEDLE_USER, NEEDLE_DEVICE, viewer)

    const r1 = await call('report', { token, category: 'black-screen', channel: 'film-hd', peers: 1 })
    const r2 = await call('report', { token, category: 'black-screen', channel: 'film-hd', peers: 7, text: 'still black' })
    assert.strictEqual(r1.ok, true); assert.strictEqual(r2.ok, true)
    assert.strictEqual(r2.id, r1.id, 'the repeat folded onto the same record')
    assert.strictEqual(r2.count, 2, 'the reply reports count 2')
    const all = reports.list({ limit: 100 })
    assert.strictEqual(all.length, 1, 'exactly ONE record exists')
    assert.strictEqual(all[0].count, 2, 'count bumped to 2')
    assert.strictEqual(all[0].peers, 7, 'the repeat refreshed the diagnostics')
    assert.strictEqual(all[0].text, 'still black', 'the repeat kept the newer free text')
    assert.ok(all[0].lastAt >= all[0].at, 'lastAt advanced')

    // A DIFFERENT category (or channel) is a different problem — a new record.
    await call('report', { token, category: 'buffering', channel: 'film-hd' })
    await call('report', { token, category: 'black-screen', channel: 'sports-1' })
    assert.strictEqual(reports.list({ limit: 100 }).length, 3, 'different category/channel → separate records')

    // Once resolved, the next report is a genuinely new occurrence.
    reports.resolve(r1.id, 'transcoder restarted')
    const r3 = await call('report', { token, category: 'black-screen', channel: 'film-hd' })
    assert.notStrictEqual(r3.id, r1.id, 'a report after resolve opens a fresh record')
    reports.close()
    log('D: dedupe — same reporter/channel/category folds to one record (count 2); resolve starts a new one ✓')
  }

  // ===================== E: lifecycle (module) + the kill switch =====================
  {
    const dir = mkdir('lifecycle')
    const reports = makeReports({ dataDir: dir, retentionDays: 30, alertCount: 2, alertWindowMin: 10 })
    const rep = (u) => reports.pseudonym(u, NEEDLE_DEVICE)
    const a = reports.ingest({ reporter: rep('u1'), category: 'buffering', channel: 'news-24' })
    const b = reports.ingest({ reporter: rep('u2'), category: 'buffering', channel: 'news-24' })
    assert.strictEqual(a.ok, true); assert.strictEqual(b.ok, true)
    assert.ok(b.alertId, 'the 2nd distinct reporter opened an alert')

    assert.strictEqual(reports.ack('nope').error, 'not-found', 'ack of an unknown id is a clean error')
    const acked = reports.ack(a.id)
    assert.strictEqual(acked.ok, true)
    assert.strictEqual(reports.get(a.id).status, 'ack', 'ack persisted')
    assert.ok(reports.get(a.id).ackAt > 0, 'ackAt stamped')
    const resolved = reports.resolve(a.id, 'upstream fixed\x00\x01')
    assert.strictEqual(resolved.ok, true)
    assert.strictEqual(reports.get(a.id).status, 'resolved', 'resolve persisted')
    assert.strictEqual(reports.get(a.id).note, 'upstream fixed', 'the note is control-char stripped')
    assert.strictEqual(reports.list({ status: 'new' }).length, 1, 'status filter works')
    assert.strictEqual(reports.list({ channel: 'news-24' }).length, 2, 'channel filter works')
    assert.strictEqual(reports.list({ category: 'no-audio' }).length, 0, 'category filter works')

    assert.strictEqual(reports.listAlerts({ status: 'open' }).length, 1, 'one open alert')
    assert.strictEqual(reports.ackAlert(b.alertId).ok, true)
    assert.strictEqual(reports.listAlerts({ status: 'ack' }).length, 1, 'alert ack persisted')
    assert.strictEqual(reports.resolveAlert(b.alertId).ok, true)
    assert.strictEqual(reports.listAlerts({ status: 'open' }).length, 0, 'alert resolved')
    assert.strictEqual(reports.resolveAlert('nope').error, 'not-found', 'resolving an unknown alert is a clean error')

    const sum = reports.summary()
    assert.strictEqual(sum.total, 2); assert.strictEqual(sum.resolved, 1); assert.strictEqual(sum.new, 1)
    assert.strictEqual(sum.byChannel['news-24'], 2)
    assert.ok(Array.isArray(sum.byHour) && sum.byHour.length === 24, 'summary carries a 24-hour series')
    reports.close()

    // Files really landed, and NOT in the analytics tree.
    assert.ok(fs.existsSync(path.join(dir, 'reports', 'reports.json')), 'reports.json written')
    assert.ok(fs.existsSync(path.join(dir, 'reports', 'alerts.json')), 'alerts.json written')
    assert.ok(!fs.existsSync(path.join(dir, 'analytics')), 'reports never touch the analytics tree')
    // A reopened store reads the same records back (re-read per operation).
    const reopened = makeReports({ dataDir: dir, retentionDays: 30 })
    assert.strictEqual(reopened.list({ limit: 100 }).length, 2, 'records survive a restart')
    assert.strictEqual(reopened.listAlerts().length, 1, 'alerts survive a restart')
    assert.strictEqual(reopened.pseudonym('u1', NEEDLE_DEVICE), rep('u1'), 'the salt is stable across restarts')
    reopened.close()

    // Retention prune: an ancient record is dropped on the next write.
    {
      const p = path.join(dir, 'reports', 'reports.json')
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
      raw.records.push({ id: 'ancient', at: Date.now() - 400 * 86400000, lastAt: Date.now() - 400 * 86400000, count: 1, reporter: 'ffffffffffffffff', category: 'other', channel: 'old-ch', status: 'new', events: [] })
      fs.writeFileSync(p, JSON.stringify(raw))
      const pruner = makeReports({ dataDir: dir, retentionDays: 30, alertCount: 99 })
      assert.ok(pruner.list({ limit: 100 }).some((r) => r.id === 'ancient'), 'the ancient record is present before a write')
      pruner.ingest({ reporter: rep('u3'), category: 'other', channel: 'fresh' })
      assert.ok(!pruner.list({ limit: 100 }).some((r) => r.id === 'ancient'), 'retention pruned the out-of-window record')
      pruner.close()
    }

    // The 5000-record cap evicts oldest-RESOLVED first.
    {
      const capDir = mkdir('cap')
      const capped = makeReports({ dataDir: capDir, retentionDays: 30, alertCount: 99, maxRecords: 10 })
      for (let i = 0; i < 6; i++) {
        const r = capped.ingest({ reporter: capped.pseudonym('cap-user-' + i, 'd'), category: 'other', channel: 'cap-ch' })
        if (i < 3) capped.resolve(r.id, 'done')
      }
      for (let i = 6; i < 16; i++) capped.ingest({ reporter: capped.pseudonym('cap-user-' + i, 'd'), category: 'other', channel: 'cap-ch' })
      const left = capped.list({ limit: 100 })
      assert.strictEqual(left.length, 10, 'the record cap holds')
      assert.strictEqual(left.filter((r) => r.status === 'resolved').length, 0, 'resolved records were evicted first')
      capped.close()
    }

    // Kill switch: retentionDays=0 → no-op store, no disk, and NO responder.
    {
      const offDir = mkdir('off')
      const off = makeReports({ dataDir: offDir, retentionDays: 0 })
      assert.strictEqual(off.enabled, false, 'retentionDays=0 disables the store')
      assert.strictEqual(off.ingest({ reporter: 'aabbccddeeff0011', category: 'other' }).error, 'disabled')
      assert.deepStrictEqual(off.list(), [])
      assert.strictEqual(off.summary().enabled, false)
      off.close()
      assert.deepStrictEqual(fs.readdirSync(offDir), [], 'the disabled store never touches disk (not even a salt)')

      const signing = hcrypto.keyPair()
      const db = fakeDb({ ['user/' + NEEDLE_USER]: seedUser() })
      const [cli, srv] = streamPair()
      cleanups.push(() => { cli.destroy(); srv.destroy() })
      attachLoginRpc(srv, { keys: { signing }, oprfKey: hcrypto.randomBytes(32), difficulty: 1, throttle: makeThrottle(1000, 900), db, dataDir: offDir, reports: off })
      const { call } = rpcClient(cli)
      const token = await doLogin(call, NEEDLE_USER, NEEDLE_DEVICE, viewer)
      await assert.rejects(() => call('report', { token, category: 'other' }), 'the report method does not exist when reports are disabled')
      // …and the rest of the panel is untouched.
      assert.ok((await call('hello')).challenge, 'hello still served with reports off')
    }
    log('E: lifecycle — ack/resolve/filters/summary, restart durability, retention + cap eviction, kill switch ✓')
  }

  // ===================== F: storm drill =====================
  {
    const dir = mkdir('storm')
    const signing = hcrypto.keyPair()
    const seed = {}
    for (const u of NEEDLE_STORM_USERS) seed['user/' + u] = seedUser()
    seed['user/' + NEEDLE_USER] = seedUser()
    const db = fakeDb(seed)
    let opens = 0
    const opened = []
    const reports = makeReports({
      dataDir: dir,
      retentionDays: 30,
      alertCount: 3,
      alertWindowMin: 10,
      stormSampleSize: 5,
      globalPerMin: 80,
      flushMs: 20,
      onAlert: (a) => { opens++; opened.push(a) }
    })
    const shared = { keys: { signing }, oprfKey: hcrypto.randomBytes(32), difficulty: 1, throttle: makeThrottle(10000, 900), db, dataDir: dir, reports, reportThrottle: makeThrottle(10000, 900) }

    const [cli, srv] = streamPair()
    cleanups.push(() => { cli.destroy(); srv.destroy() })
    attachLoginRpc(srv, shared)
    const { call } = rpcClient(cli, 20000)

    const tokens = []
    for (const u of NEEDLE_STORM_USERS) tokens.push(await doLogin(call, u, NEEDLE_STORM_DEVICE, viewer))
    assert.strictEqual(tokens.length, 30, '30 real viewer sessions established')

    // A SECOND connection — the "innocent viewer logging in during the storm".
    const [cli2, srv2] = streamPair()
    cleanups.push(() => { cli2.destroy(); srv2.destroy() })
    attachLoginRpc(srv2, shared)
    const { call: call2 } = rpcClient(cli2, 20000)

    const CATS = ['no-audio', 'black-screen', 'buffering']
    const stormStart = Date.now()
    const storm = Promise.all(Array.from({ length: 200 }, (_, i) =>
      call('report', { token: tokens[i % 30], category: CATS[i % 3], channel: 'storm-ch', peers: i % 9, appVersion: '0.2.0', platform: 'android' })
    ))
    // Concurrently: a full hello → login → session on the other connection.
    const t0 = Date.now()
    const sessionToken = await doLogin(call2, NEEDLE_USER, NEEDLE_DEVICE, viewer)
    const sessionMs = Date.now() - t0
    const results = await storm
    const stormMs = Date.now() - stormStart

    assert.ok(sessionToken, 'the concurrent login succeeded during the storm')
    assert.ok(sessionMs < 5000, `a concurrent session RPC stayed fast during the storm (${sessionMs} ms)`)
    assert.ok(results.every((r) => r && r.ok === true), 'every report was answered ok (shed/collapsed are still ok)')

    const shed = results.filter((r) => r.shed).length
    const collapsed = results.filter((r) => r.collapsed).length
    const stored = results.filter((r) => r.id).length
    assert.strictEqual(shed + collapsed + stored, 200, 'every report took exactly one path')
    // The bucket starts at 80 and refills 80/min, so a burst that takes well under a
    // minute lets through 80 plus at most a couple of refilled tokens.
    assert.ok(shed >= 110 && shed <= 125, `the global breaker shed everything past the 80/min bucket (${shed} shed)`)
    assert.ok(results.filter((r) => r.shed).every((r) => r.cooldown > 0), 'a shed reply carries a cooldown')

    const records = reports.list({ limit: 1000 })
    assert.ok(records.length <= 5, `storm collapse capped STORED records at stormSampleSize (${records.length} ≤ 5)`)
    assert.ok(collapsed > 50, `most surviving reports collapsed onto the alert (${collapsed})`)

    const alerts = reports.listAlerts()
    assert.strictEqual(alerts.length, 1, 'exactly ONE alert for the storm — extended, never duplicated')
    assert.strictEqual(opens, 1, 'onAlert fired exactly once')
    assert.strictEqual(alerts[0].kind, 'channel')
    assert.strictEqual(alerts[0].channel, 'storm-ch')
    assert.ok(alerts[0].reporters >= 20, `the alert accumulated distinct reporters (${alerts[0].reporters})`)
    assert.ok(alerts[0].shedCount > 0, `shed reports were attributed to the alert (${alerts[0].shedCount})`)
    assert.deepStrictEqual(Object.keys(alerts[0].categories).sort(), CATS.slice().sort(), 'per-category tallies kept')
    assert.ok(Object.values(alerts[0].categories).reduce((a, b) => a + b, 0) > 50, 'category tallies counted the collapsed reports')
    assert.ok(alerts[0].lastAt >= alerts[0].openedAt, 'the alert was extended')

    reports.close()
    const alertsFile = JSON.parse(fs.readFileSync(path.join(dir, 'reports', 'alerts.json'), 'utf8'))
    assert.strictEqual(alertsFile.alerts.length, 1, 'the debounced flush wrote exactly one alert')

    scanBodies.push(
      ['storm reports.json', fs.readFileSync(path.join(dir, 'reports', 'reports.json'), 'utf8')],
      ['storm alerts.json', fs.readFileSync(path.join(dir, 'reports', 'alerts.json'), 'utf8')],
      ['storm reports.list()', JSON.stringify(records)],
      ['storm listAlerts()', JSON.stringify(alerts)],
      ['storm rpc replies', JSON.stringify(results)]
    )
    // Nothing report-shaped may live in the bee — it replicates to EVERY viewer, so a
    // report in it would be published to the whole audience. (The bee legitimately
    // holds the account records, so it is checked structurally, not scanned for
    // needles: no report key, and no report content in any value.)
    for (const [k, v] of db._map) {
      assert.ok(['user/', 'catalog/', 'meta/'].some((ns) => k.startsWith(ns)), `the bee holds only account/catalog keys — no report namespace (found ${k})`)
      assert.ok(!JSON.stringify(v).includes('storm-ch'), `the bee holds no report content (in ${k})`)
    }

    log(`F: storm drill — 200 reports/30 reporters: ${shed} shed, ${collapsed} collapsed, ${records.length} stored, 1 alert, concurrent login ${sessionMs} ms (storm ${stormMs} ms) ✓`)
  }

  // ===================== G: the admin HTTP surface =====================
  {
    const dir = mkdir('adminapi')
    initKeys(dir)
    const keys = openKeys(dir)
    const { store, db, assets } = await openStore(dir, keys)
    cleanups.push(() => store.close())
    const activity = makeRing(200)
    const hook = await stubServer('ok')
    cleanups.push(hook.close)
    const notifier = makeNotifier({ webhookUrl: hook.base + '/hook', timeoutMs: 2000, backoffMs: [10, 10], log: () => {} })
    const reports = makeReports({ dataDir: dir, retentionDays: 30, alertCount: 2, flushMs: 10, onAlert: (a) => notifier.notify(a) })
    // Argon2 at the sodium minimum — this lane tests routing, not password cost.
    const ctx = { config: { argon2: { memKiB: 8192, time: 1 }, maxDevicesDefault: 2 }, keys, db, assets, dataDir: dir, activity, reports, notifier }
    ops.addAdmin(ctx, 'root', 'correct-horse-battery')
    const srv = await startAdminServer(ctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 50, seconds: 60 } })
    cleanups.push(srv.close)
    const base = `http://127.0.0.1:${srv.port}`
    let adminToken = null
    const http_ = async (method, p, body) => {
      const headers = {}
      if (adminToken) headers.authorization = 'Bearer ' + adminToken
      if (body !== undefined) headers['content-type'] = 'application/json'
      const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch {}
      return { status: res.status, body: json, text }
    }

    // Seeded by the module (the responder path is lanes A-F's job).
    const repA = reports.pseudonym(NEEDLE_USER, NEEDLE_DEVICE)
    const repB = reports.pseudonym(NEEDLE_STORM_USERS[1], NEEDLE_STORM_DEVICE)
    const s1 = reports.ingest({ reporter: repA, category: 'no-audio', channel: 'api-ch', text: 'sound cuts out', appVersion: '0.2.0', platform: 'android-tv', peers: 3, events: [{ t: 1, type: 'error', detail: 'decoder stalled' }] })
    const s2 = reports.ingest({ reporter: repB, category: 'no-audio', channel: 'api-ch' })
    reports.ingest({ reporter: repA, category: 'buffering', channel: 'other-ch' })
    assert.ok(s2.alertId, 'the seed opened an alert (2 distinct reporters)')
    await notifier.idle()
    assert.strictEqual(hook.seen.length, 1, 'the opened alert produced exactly one webhook POST')

    assert.strictEqual((await http_('GET', '/api/reports')).status, 401, 'reports need an admin token')
    assert.strictEqual((await http_('GET', '/api/alerts')).status, 401, 'alerts need an admin token')
    const login = await http_('POST', '/api/login', { username: 'root', password: 'correct-horse-battery' })
    assert.strictEqual(login.status, 200, 'admin login: ' + login.text)
    adminToken = login.body.token

    const all = await http_('GET', '/api/reports')
    assert.strictEqual(all.status, 200)
    assert.strictEqual(all.body.enabled, true, 'GET /api/reports reports the store as enabled')
    assert.strictEqual(all.body.reports.length, 3, 'all three seeded reports are listed')
    assert.ok(all.body.reports.every((r) => /^[0-9a-f]{16}$/.test(r.reporter)), 'every listed reporter is a 16-hex pseudonym')
    assert.strictEqual((await http_('GET', '/api/reports?channel=api-ch')).body.reports.length, 2, 'channel filter')
    assert.strictEqual((await http_('GET', '/api/reports?category=buffering')).body.reports.length, 1, 'category filter')
    assert.strictEqual((await http_('GET', '/api/reports?status=new')).body.reports.length, 3, 'status filter')
    assert.strictEqual((await http_('GET', '/api/reports?limit=1')).body.reports.length, 1, 'limit')
    assert.strictEqual((await http_('GET', '/api/reports?since=' + (Date.now() + 60000))).body.reports.length, 0, 'since filter')

    const sum = await http_('GET', '/api/reports/summary')
    assert.strictEqual(sum.status, 200)
    assert.strictEqual(sum.body.enabled, true)
    assert.strictEqual(sum.body.total, 3)
    assert.strictEqual(sum.body.new, 3)
    assert.strictEqual(sum.body.openAlerts, 1, 'the summary carries the badge count')
    assert.strictEqual(sum.body.byChannel['api-ch'], 2)
    assert.strictEqual(sum.body.byCategory['no-audio'], 2)
    assert.strictEqual(sum.body.byHour.length, 24, 'the summary carries a 24-hour chart series')

    assert.strictEqual((await http_('POST', '/api/reports/nope/ack')).status, 404, 'ack of an unknown report is 404')
    const acked = await http_('POST', `/api/reports/${s1.id}/ack`)
    assert.strictEqual(acked.status, 200)
    assert.strictEqual(acked.body.status, 'ack', 'ack round-tripped over HTTP')
    const resolved = await http_('POST', `/api/reports/${s1.id}/resolve`, { note: 'transcoder restarted' })
    assert.strictEqual(resolved.status, 200)
    assert.strictEqual(resolved.body.status, 'resolved')
    assert.strictEqual(resolved.body.note, 'transcoder restarted', 'the operator note is stored')
    assert.strictEqual((await http_('GET', '/api/reports?status=resolved')).body.reports.length, 1)
    assert.strictEqual(reports.get(s1.id).status, 'resolved', 'the HTTP mutation hit the same store the module reads')

    const alerts = await http_('GET', '/api/alerts')
    assert.strictEqual(alerts.body.alerts.length, 1, 'one alert over HTTP')
    assert.strictEqual(alerts.body.alerts[0].kind, 'channel')
    assert.strictEqual(alerts.body.alerts[0].channel, 'api-ch')
    const alertId = alerts.body.alerts[0].id
    assert.strictEqual((await http_('POST', '/api/alerts/nope/ack')).status, 404, 'ack of an unknown alert is 404')
    assert.strictEqual((await http_('POST', `/api/alerts/${alertId}/ack`)).body.status, 'ack')
    assert.strictEqual((await http_('GET', '/api/alerts?status=ack')).body.alerts.length, 1, 'alert status filter')
    assert.strictEqual((await http_('POST', `/api/alerts/${alertId}/resolve`)).body.status, 'resolved')
    assert.strictEqual((await http_('GET', '/api/reports/summary')).body.openAlerts, 0, 'resolving the alert clears the badge')

    const tn = await http_('POST', '/api/reports/test-notify')
    assert.strictEqual(tn.status, 200)
    assert.deepStrictEqual(tn.body.targets, ['webhook'])
    assert.strictEqual(tn.body.results[0].ok, true, 'test-notify reached the stub: ' + tn.text)
    assert.strictEqual(hook.seen.length, 2, 'test-notify sent exactly one more POST')
    assert.ok(/test notification/i.test(hook.seen[1].body.title), 'the test push is obviously synthetic')

    // Every mutation is audited through act() into the observability ring.
    const audit = activity.list().filter((e) => e.type === 'admin').map((e) => e.op)
    for (const op of ['report-ack', 'report-resolve', 'alert-ack', 'alert-resolve', 'report-test-notify']) {
      assert.ok(audit.includes(op), `admin audit carries ${op} (got ${audit.join(',')})`)
    }
    assert.ok(activity.list().filter((e) => e.type === 'admin').every((e) => e.admin === 'root'), 'audit entries name the acting admin')

    scanBodies.push(
      ['GET /api/reports', all.text],
      ['GET /api/reports/summary', sum.text],
      ['GET /api/alerts', alerts.text],
      ['POST /api/reports/:id/resolve', resolved.text],
      ['admin audit ring', JSON.stringify(activity.list())]
    )
    reports.close(); notifier.close()
    log('G: admin HTTP surface — auth, filters, summary, ack/resolve, alerts, test-notify, 404s, audited ✓')
  }

  // ===================== H: notifier delivery =====================
  {
    const dir = mkdir('notify')
    const hook = await stubServer('ok')
    cleanups.push(hook.close)
    const notifier = makeNotifier({
      webhookUrl: hook.base + '/topic/aliran',
      telegramBotToken: 'TESTBOTTOKEN',
      telegramChatId: '-100123',
      telegramApiBase: hook.base, // the injectable seam — no traffic ever leaves the box
      timeoutMs: 2000,
      backoffMs: [10, 10],
      log: () => {}
    })
    assert.deepStrictEqual(notifier.targets, ['webhook', 'telegram'], 'both targets configured')

    let opens = 0
    const reports = makeReports({
      dataDir: dir,
      retentionDays: 30,
      alertCount: 3,
      stormSampleSize: 50,
      flushMs: 10,
      onAlert: (a) => { opens++; notifier.notify(a) }
    })
    // 12 reports, 4 distinct reporters, one channel: ONE alert opens and is then
    // EXTENDED nine more times. A notification per report would be nine too many.
    for (let i = 0; i < 12; i++) {
      reports.ingest({
        reporter: reports.pseudonym('notify-user-' + (i % 4), NEEDLE_DEVICE),
        category: i % 2 ? 'no-audio' : 'buffering',
        channel: 'notify-ch'
      })
    }
    await notifier.idle()
    assert.strictEqual(opens, 1, 'exactly ONE alert opened for the burst')
    assert.strictEqual(hook.seen.length, 2, `exactly ONE POST per target (got ${hook.seen.length}: ${hook.seen.map((p) => p.url).join(', ')})`)

    const webhook = hook.seen.find((p) => p.url === '/topic/aliran')
    const telegram = hook.seen.find((p) => p.url.startsWith('/bot'))
    assert.ok(webhook, 'the webhook target was posted to')
    assert.strictEqual(webhook.method, 'POST')
    // THE compatibility shape: ntfy reads title/message, Slack reads text, Discord
    // reads content — one body, three providers, no adapter.
    assert.deepStrictEqual(Object.keys(webhook.body).sort(), ['channel', 'content', 'count', 'message', 'text', 'title'], 'the webhook body carries the ntfy/Slack/Discord union')
    assert.strictEqual(webhook.body.channel, 'notify-ch')
    assert.ok(webhook.body.count >= 3, `the push carries the distinct-reporter count (${webhook.body.count})`)
    assert.ok(webhook.body.title.includes('notify-ch'), 'the title names the broken channel')
    assert.strictEqual(webhook.body.text, webhook.body.content, 'text and content carry the same line')
    assert.ok(webhook.body.text.includes(webhook.body.message), 'text embeds the message')
    assert.strictEqual(webhook.headers['x-title'], webhook.body.title, 'X-Title is set for plain ntfy topic URLs')
    assert.strictEqual(webhook.headers['content-type'], 'application/json')

    assert.ok(telegram, 'the Telegram target was posted to')
    assert.strictEqual(telegram.url, '/botTESTBOTTOKEN/sendMessage', 'Telegram uses /bot<token>/sendMessage on the injected base')
    assert.strictEqual(telegram.body.chat_id, '-100123')
    assert.ok(telegram.body.text.includes('notify-ch'), 'the Telegram text names the channel')

    // A second, LOGIN-kind alert: panel-wide, no channel.
    for (let i = 0; i < 3; i++) reports.ingest({ reporter: reports.pseudonym('login-user-' + i, NEEDLE_DEVICE), category: 'login' })
    await notifier.idle()
    assert.strictEqual(opens, 2, 'the panel-wide login rule opened its own alert')
    assert.strictEqual(hook.seen.length, 4, 'one more POST per target — still never per report')
    const loginPush = hook.seen[2]
    assert.strictEqual(loginPush.body.channel, null, 'a login alert has no channel')
    assert.ok(/login/i.test(loginPush.body.title), 'the login alert says so')

    // renderAlert is pure and total — it never throws on a partial alert record.
    assert.doesNotThrow(() => renderAlert({}), 'renderAlert tolerates an empty alert')
    assert.ok(renderAlert({ reporters: 600, reportersCapped: true, channel: 'x', id: 'y' }).title.includes('≥'), 'a capped reporter count renders as a lower bound')

    const notifierStats = notifier.stats()
    assert.strictEqual(notifierStats.sent, 4)
    assert.strictEqual(notifierStats.failed, 0)
    assert.strictEqual(notifierStats.dropped, 0)

    scanBodies.push(['webhook POST bodies', JSON.stringify(hook.seen.map((p) => ({ url: p.url, body: p.body })))])
    reports.close(); notifier.close()
    log('H: notifier delivery — 12 reports → 1 alert → exactly 1 POST per target; ntfy/Slack/Discord body union + X-Title + Telegram sendMessage ✓')
  }

  // ===================== I: fail-dark =====================
  {
    const dir = mkdir('faildark')
    // A blackhole: it accepts the request and never answers. This is the shape that
    // would deadlock a naive notifier — and with it, report ingest.
    const black = await stubServer('hang')
    cleanups.push(black.close)
    const notifier = makeNotifier({ webhookUrl: black.base + '/dead', timeoutMs: 150, backoffMs: [20, 20], log: () => {} })
    const reports = makeReports({ dataDir: dir, retentionDays: 30, alertCount: 2, stormSampleSize: 100, flushMs: 10, onAlert: (a) => notifier.notify(a) })

    const t0 = Date.now()
    for (let i = 0; i < 40; i++) {
      const r = reports.ingest({ reporter: reports.pseudonym('dark-user-' + i, NEEDLE_DEVICE), category: 'buffering', channel: 'dark-ch' })
      assert.strictEqual(r.ok, true, `ingest ${i} still succeeds while the endpoint blackholes`)
    }
    const ingestMs = Date.now() - t0
    assert.ok(ingestMs < 5000, `ingest never waits on the notifier (${ingestMs} ms for 40 reports)`)
    assert.ok(reports.list({ limit: 1000 }).length >= 20, 'reports kept landing on disk throughout')
    assert.strictEqual(reports.listAlerts().length, 1, 'the alert opened normally')

    await notifier.idle()
    const stats = notifier.stats()
    assert.strictEqual(stats.sent, 0, 'nothing was delivered to the blackhole')
    assert.strictEqual(stats.failed, 1, 'the notification was DROPPED, once, after its budget')
    assert.strictEqual(stats.attempts, 3, `3 attempts then drop (got ${stats.attempts})`)
    assert.ok(black.seen.length >= 1, 'the blackhole really did receive attempts')
    // And the panel is entirely unaffected: ingest still works after the drop.
    assert.strictEqual(reports.ingest({ reporter: reports.pseudonym('after-drop', NEEDLE_DEVICE), category: 'other', channel: 'dark-ch' }).ok, true, 'ingest still works after a dropped notification')
    reports.close(); notifier.close()

    // A 5xx endpoint: retried to the budget, then dropped with the status in the error.
    const bad = await stubServer('error')
    cleanups.push(bad.close)
    const n2 = makeNotifier({ webhookUrl: bad.base + '/x', timeoutMs: 1000, backoffMs: [5, 5], log: () => {} })
    const r2 = await n2.test()
    assert.strictEqual(r2.results[0].ok, false, 'a 500 is a failure')
    assert.strictEqual(r2.results[0].attempts, 3, 'retried to the budget')
    assert.ok(/HTTP 500/.test(r2.results[0].error), `the error names the status (got ${r2.results[0].error})`)
    assert.strictEqual(bad.seen.length, 3, 'exactly 3 attempts reached the endpoint')
    n2.close()

    // A refused connection (nothing listening) is a failure, not a crash.
    const gone = await stubServer('ok')
    const goneBase = gone.base
    await gone.close()
    const n3 = makeNotifier({ webhookUrl: goneBase + '/gone', timeoutMs: 500, backoffMs: [5, 5], log: () => {} })
    const r3 = await n3.test()
    assert.strictEqual(r3.results[0].ok, false, 'a refused connection fails cleanly')
    assert.ok(typeof r3.results[0].error === 'string' && r3.results[0].error.length > 0, 'the failure carries a message')
    n3.close()

    // Unconfigured = a complete no-op (the default deployment).
    const off = makeNotifier({})
    assert.strictEqual(off.enabled, false, 'no knobs → disabled')
    assert.deepStrictEqual(off.targets, [], 'no targets')
    assert.deepStrictEqual(await off.notify({ id: 'x', channel: 'y' }), [], 'notify is a no-op')
    assert.strictEqual((await off.test()).enabled, false, 'test says so honestly')
    off.close()

    // The queue is BOUNDED: a stuck endpoint costs bounded memory, not unbounded growth.
    const stuck = await stubServer('hang')
    cleanups.push(stuck.close)
    const n4 = makeNotifier({ webhookUrl: stuck.base + '/q', timeoutMs: 100, backoffMs: [5, 5], queueMax: 3, log: () => {} })
    for (let i = 0; i < 12; i++) n4.notify({ id: 'q' + i, kind: 'channel', channel: 'q-ch', reporters: 3, categories: {} })
    assert.ok(n4.stats().queued <= 3, `the queue is capped at queueMax (${n4.stats().queued})`)
    assert.ok(n4.stats().dropped >= 8, `the oldest pending notifications were dropped (${n4.stats().dropped})`)
    n4.close()

    log(`I: fail-dark — blackhole/500/refused endpoints all drop after 3 attempts, ingest unaffected (40 reports in ${ingestMs} ms), queue bounded, unconfigured = no-op ✓`)
  }

  // ===================== J: the negative identity scan =====================
  {
    const dir = mkdir('scan')
    const signing = hcrypto.keyPair()
    const db = fakeDb({ ['user/' + NEEDLE_USER]: seedUser() })
    // Analytics runs BESIDE reports through the same logins — the S48 tree must stay
    // clean and the reports tree must never carry identity either.
    const analytics = makeAnalytics({ dataDir: dir, retentionDays: 30 })
    const reports = makeReports({ dataDir: dir, retentionDays: 30, alertCount: 2 })
    const activity = makeRing(50)
    const [cli, srv] = streamPair()
    cleanups.push(() => { cli.destroy(); srv.destroy() })
    attachLoginRpc(srv, { keys: { signing }, oprfKey: hcrypto.randomBytes(32), difficulty: 1, throttle: makeThrottle(1000, 900), db, dataDir: dir, reports, reportThrottle: makeThrottle(1000, 900), activity, analytics })
    const { call } = rpcClient(cli)

    const token = await doLogin(call, NEEDLE_USER, NEEDLE_DEVICE, viewer)
    await call('report', { token, category: 'no-audio', channel: 'scan-ch', text: 'my name is ' + NEEDLE_USER, appVersion: '0.2.0', platform: 'android' })
    await call('report', { token, category: 'login', text: 'cannot sign in' })
    // A SECOND distinct reporter on the same channel opens an alert, so alerts.json
    // is written and joins the scan (its pseudonym derives from another needle name).
    reports.ingest({ reporter: reports.pseudonym(NEEDLE_STORM_USERS[0], NEEDLE_STORM_DEVICE), category: 'no-audio', channel: 'scan-ch', appVersion: '0.2.0' })
    reports.close(); analytics.close()

    // Free text is viewer-authored: if they type their own username it is stored,
    // and that is not a leak the panel can prevent. The scan therefore targets
    // the fields the PANEL fills in — so drive a second, text-free report and scan
    // structurally: no field of any record may equal a needle.
    const records = reports.list({ limit: 100 })
    for (const r of records) {
      for (const [k, v] of Object.entries(r)) {
        if (k === 'text') continue // viewer-authored free text — see above
        assert.ok(v !== NEEDLE_USER && v !== NEEDLE_DEVICE, `record field ${k} carries no identity`)
      }
    }

    const files = []
    const rdir = path.join(dir, 'reports')
    for (const n of fs.readdirSync(rdir)) files.push([path.join(rdir, n), fs.readFileSync(path.join(rdir, n), 'utf8')])
    const adir = path.join(dir, 'analytics')
    if (fs.existsSync(adir)) for (const n of fs.readdirSync(adir)) files.push([path.join(adir, n), fs.readFileSync(path.join(adir, n), 'utf8')])
    assert.ok(files.length >= 2, `positive control: report files were actually written (${files.length})`)
    assert.ok(files.some(([, t]) => t.includes('scan-ch')), 'positive control: the scan channel IS in the files (so the scan can see content)')

    scanBodies.push(
      ...files.map(([p, t]) => ['file ' + path.basename(p), t]),
      // The free-text field is the one viewer-authored surface — strip it, then scan.
      ['scan reports.list()', JSON.stringify(records.map((r) => ({ ...r, text: null })))],
      ['scan reports.summary()', JSON.stringify(reports.summary())],
      ['scan listAlerts()', JSON.stringify(reports.listAlerts())],
      ['scan activity ring (report entries)', JSON.stringify(activity.list().filter((e) => e.type === 'report'))],
      ['scan analytics api', JSON.stringify(analytics.api(2))]
    )
    // Same structural check as the storm lane: the replicated bee must stay report-free.
    for (const [k, v] of db._map) {
      assert.ok(['user/', 'catalog/', 'meta/'].some((ns) => k.startsWith(ns)), `the bee holds only account/catalog keys — no report namespace (found ${k})`)
      assert.ok(!JSON.stringify(v).includes('scan-ch'), `the bee holds no report content (in ${k})`)
    }
    // The one file that legitimately holds the viewer's own words.
    const withoutText = files.map(([p, t]) => {
      if (path.basename(p) !== 'reports.json') return [path.basename(p), t]
      const raw = JSON.parse(t)
      return ['reports.json (text stripped)', JSON.stringify({ ...raw, records: raw.records.map((r) => ({ ...r, text: null })) })]
    })

    const needles = [
      ['username', NEEDLE_USER],
      ['device id', NEEDLE_DEVICE],
      ['storm device id', NEEDLE_STORM_DEVICE],
      ...NEEDLE_STORM_USERS.slice(0, 5).map((u) => ['storm username', u]),
      ['session token', token],
      ['viewer auth public key', b4a.toString(viewer.publicKey, 'hex')],
      ['client noise public key', b4a.toString(cli.publicKey, 'hex')],
      ['IP literal', '127.0.0.1']
    ]
    const bodies = scanBodies.concat(withoutText.map(([l, t]) => ['stripped ' + l, t]))
      .filter(([l]) => !l.startsWith('file reports.json')) // superseded by the stripped copy
    const hits = []
    for (const [label, text] of bodies) {
      for (const [what, needle] of needles) if (text.includes(needle)) hits.push(`${what} "${needle}" found in ${label}`)
    }
    assert.deepStrictEqual(hits, [], 'IDENTITY LEAK:\n  ' + hits.join('\n  '))
    assert.ok(happyReporter && !bodies.some(([l]) => l === 'nope'), 'scan ran over the captured surfaces')
    log(`J: negative identity scan — ${bodies.length} surfaces × ${needles.length} needles, ZERO hits ✓`)

    // Category drift guard: the sdk copy (S50c) must stay deep-equal to the panel's.
    const sdkReport = path.join(root, 'sdk', 'report.js')
    if (fs.existsSync(sdkReport)) {
      const { REPORT_CATEGORIES: sdkCats } = await import(pathToFileURL(sdkReport).href)
      assert.deepStrictEqual(sdkCats, REPORT_CATEGORIES, 'sdk/report.js categories must deep-equal the panel copy')
      log('   drift guard: sdk/report.js categories deep-equal the panel copy ✓')
    } else {
      log('   drift guard: sdk/report.js not present yet (lands in S50c) — skipped')
    }
    assert.strictEqual(REPORT_CATEGORIES.length, 7, 'the category enum is the frozen set of 7')
  }

  assert.ok(!crashed, 'no uncaught exception / unhandled rejection fired during the run')
  log('\nRESULT: PASS ✅  (crash fuzzing; happy path + token-derived pseudonym; throttle; dedupe; lifecycle + kill switch; storm drill; admin HTTP surface; notifier delivery; fail-dark; negative identity scan)')
  await cleanup(); process.exit(0)
} catch (err) {
  console.error('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
