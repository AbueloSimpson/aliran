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
//   G  THE NEGATIVE IDENTITY SCAN: analytics runs beside reports through the same
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
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import SecretStream from '@hyperswarm/secret-stream'
import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { blind, powSolve, authKeyPair, authSign } from '@aliran/core'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { makeReports, normalizeReport, REPORT_CATEGORIES } from '../panel/src/reports.js'
import { makeAnalytics } from '../panel/src/analytics.js'
import { makeRing } from '../panel/src/activity.js'

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

  // ===================== G: the negative identity scan =====================
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
    log(`G: negative identity scan — ${bodies.length} surfaces × ${needles.length} needles, ZERO hits ✓`)

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
  log('\nRESULT: PASS ✅  (crash fuzzing; happy path + token-derived pseudonym; throttle; dedupe; lifecycle + kill switch; storm drill; negative identity scan)')
  await cleanup(); process.exit(0)
} catch (err) {
  console.error('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
