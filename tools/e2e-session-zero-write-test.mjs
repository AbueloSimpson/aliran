// ZERO-WRITE LOGIN — the acceptance gate on the panel's `session` responder.
//
// THE COST BEING REMOVED. The panel's account bee is an append-only, single-writer
// Hypercore with no compaction: every `db.put` costs its bytes FOREVER. Until this step
// the `session` responder rewrote the WHOLE user record on EVERY login, purely to push a
// device's `expiresAt` forward. On the production deployment one such record (`user/dev01`)
// is 510,093 bytes — half a megabyte of permanent log per sign-in, per device, forever. It
// is the term left over after the grant-map amplifier that put 12.35 GB on the same core.
//
// THE FIX BEING PROVED. Devices are enrolled WITHOUT an `expiresAt` at all, so a login by
// an already-enrolled device has nothing to update and appends NOTHING. The session's real
// lifetime was never in the record: it rides the panel-SIGNED token
// (`{ userId, deviceId, issuedAt, expiresAt, tokenVersion }`), which the client enforces
// offline in `checkSession` and the panel re-checks on presentation. Both existing readers
// of the record already treat a missing `expiresAt` as "not expired" — `core/session.js`
// (`if (d.expiresAt && d.expiresAt <= now) return false`) and the responder's own prune —
// so nothing client-side changes and `core/session.js` is imported here UNMODIFIED.
//
// WHAT THE OLD EXPIRY ALSO DID, AND WHERE IT WENT. It was the record's only RECENCY
// signal, precisely because every login refreshed it. `issuedAt` cannot stand in — it is
// ENROLMENT time and nothing has ever refreshed it, so evicting "the oldest issuedAt"
// signs out the household's daily driver and keeps the handset abandoned six months ago.
// Recency now lives in its own tiny key, `seen/<username>` → { deviceId: dayNumber }, at
// day granularity: a few hundred bytes written at most once per user per day per active
// device, and nothing at all for repeat logins inside one day. Lane D pins the eviction
// order; lane K measures what the key actually costs.
//
// THE LANES
//   A  the headline: 100 sequential logins move NEITHER core.length NOR core.byteLength.
//      Both, deliberately: `length` is a block count that would pass while blocks grew,
//      and `byteLength` alone would pass if a tiny record were appended. Sampled after
//      EVERY login. Plus: a varying deviceLabel must not reintroduce the write.
//   B  durable enrolment — the bug the old expiry caused. FAILS on the pre-change
//      responder (the sibling device is pruned away); that is the point of it.
//   C  the device limit, eviction and the 'reject' policy still hold.
//   D  eviction picks the least-recently-SEEN device, not the earliest-enrolled. This is
//      the regression an earlier revision of this change shipped: with `expiresAt` gone
//      and `issuedAt` used as the order, a daily-driver television enrolled two years ago
//      was evicted in favour of a phone abandoned last spring.
//   E  a lowered maxDevices converges instead of leaving the surplus live for ever.
//   F  records written by the OLD build log in and heal, in one write, whole-record.
//   G  revocation, via core/session.js UNMODIFIED.
//   H  a per-device revoke landing mid-login is not lost (compare-and-swap).
//   I  concurrency: parallel logins all land; parallel logins on one enrolled device
//      write nothing.
//   J  malformed records fail closed instead of killing the panel, and every failure
//      branch is unchanged.
//   K  what `seen/` costs per day, measured at 10 accounts × 2 devices.
//   L  what the operator surfaces report now that there is no expiry to report.
//   M  the recency PRUNE re-reads membership, so a sibling that signed in mid-write does
//      not lose its fresh stamp (and with it, its place in the eviction order).
//   N  the compensating delete that undoes a resurrected record must not eat an account
//      the operator legitimately re-created inside the same window.
//   O  a lost compare-and-swap redoes the decision against a FRESH recency map, not the
//      one read before the write that forced the retry.
//
// Loopback SecretStream pairs (the rpc-hardening / analytics idiom) over a REAL panel
// store, so the measurements are of a real Hyperbee on a real Hypercore. No DHT, no
// ffmpeg, temp dirs only, full cleanup. Exits 0 on PASS.
import SecretStream from '@hyperswarm/secret-stream'
import ProtomuxRPC from 'protomux-rpc'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import {
  blind, powSolve, authSign, evaluateFull, wrapKeyFrom, unwrap,
  verifyToken, tokenValid, sessionLive
} from '@aliran/core'
import { login } from '../sdk/login.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import * as ops from '../panel/src/ops.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PASSWORD = 'zero-write-secret-1'
const DIFFICULTY = 1 // the PoW is not what is under test
const LOGINS = 100
const SHORT_TTL_MS = 500 // lane B's stand-in for SESSION_TTL_DAYS
const DAY = 86400000

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-zerowrite-'))
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

// A connected, encrypted stream pair — the same stream type a real swarm hands
// attachLoginRpc, but loopback and DHT-free (tools/rpc-hardening-test.mjs).
function streamPair () {
  const a = new SecretStream(true)
  const b = new SecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  cleanups.push(() => { a.destroy(); b.destroy() })
  return [a, b]
}

function rpcClient (stream) {
  const rpc = new ProtomuxRPC(stream)
  return async (method, payload) => {
    const buf = payload === undefined ? b4a.alloc(0) : b4a.from(JSON.stringify(payload))
    // A responder that throws never replies, so an unbounded request would hang the
    // whole test rather than failing it.
    let timer
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`rpc '${method}' timed out`)), 15000) })
    try {
      const res = await Promise.race([rpc.request(method, buf), timeout])
      return JSON.parse(b4a.toString(res))
    } finally { clearTimeout(timer) }
  }
}

// Counting stand-ins for the two observability sinks the responder feeds. Their call
// sites must not move when the write does: a login that appends nothing is still a
// login, and the operator's feed and counters must see it.
function spies () {
  const analytics = { ok: 0, failed: 0, users: [], loginFailed () { this.failed++ }, sessionIssued (u) { this.ok++; this.users.push(u) } }
  const activity = { events: [], record (kind, data) { this.events.push({ kind, ...data }) } }
  return { analytics, activity }
}

// A pass-through view of the bee whose next write of a given kind can be HELD OPEN, so
// the race lanes can land a competing mutation at exactly the instant that used to lose
// it. `hold('put', 'user/')` parks the responder between its read and its write;
// `hold('del', 'user/')` parks its compensating delete.
function gatedDb (db) {
  const gates = []
  // Counted PER OPERATION. One shared counter cannot tell "the put is still parked" from
  // "the delete is now parked", so a lane that releases the put and then waits for the
  // delete would see the put's own count and race straight past it.
  const pending = { put: 0, del: 0 }
  const maybeHold = async (op, k) => {
    const i = gates.findIndex((g) => g.op === op && String(k).startsWith(g.prefix))
    if (i < 0) return
    const gate = gates.splice(i, 1)[0]
    pending[op]++
    await gate.promise
    pending[op]--
  }
  return {
    core: db.core,
    get: (k) => db.get(k),
    async del (k, o) { await maybeHold('del', k); return db.del(k, o) },
    async put (k, v, o) { await maybeHold('put', k); return db.put(k, v, o) },
    // Arms a gate; returns the function that lets the held write through.
    hold (op, prefix) {
      let open
      const promise = new Promise((r) => { open = r })
      gates.push({ op, prefix, promise })
      return open
    },
    heldOf: (op) => pending[op]
  }
}

// Park until the responder is actually blocked on the named gate, so a race lane's
// competing mutation lands in the window it means to and not before it opens.
async function waitParked (gated, op, what) {
  for (let i = 0; i < 400 && gated.heldOf(op) === 0; i++) await sleep(10)
  assert.strictEqual(gated.heldOf(op), 1, what)
}

try {
  initKeys(dir)
  const keys = openKeys(dir)
  const { store, db } = await openStore(dir, keys); cleanups.push(() => store.close())
  // Minimum-cost Argon2: this test runs the password grind 150+ times and the grind is
  // not what is being measured. The panel stamps the cost into each record, so the
  // client verifies at exactly this cost too.
  const ctx = { config: { argon2: { memKiB: 64, time: 1 }, maxDevicesDefault: 2 }, keys, db, dataDir: dir }
  const today = Math.floor(Date.now() / DAY)

  // The responder has exactly one operator-facing warning (lane N). Captured rather than
  // printed, so a lane can assert both that it fires when it must and — just as
  // important — that a ROUTINE repair stays silent. A warning nobody can trust is noise.
  const warnings = []
  const realWarn = console.warn
  console.warn = (...a) => { warnings.push(a.join(' ')) }
  cleanups.push(() => { console.warn = realWarn })

  const mark = () => ({ blocks: db.core.length, bytes: db.core.byteLength })
  const since = (m) => ({ blocks: db.core.length - m.blocks, bytes: db.core.byteLength - m.bytes })
  const devicesOf = async (u) => (await db.get('user/' + u)).value.devices
  const idsOf = async (u) => (await devicesOf(u)).map((d) => d.deviceId)
  const seenOf = async (u) => { const n = await db.get('seen/' + u); return n ? n.value : null }
  // The account's Ed25519 auth key, recovered the way a client recovers it. Needed for
  // the lanes that must inspect a RAW `session` reply rather than sdk login()'s throw.
  const authPrivOf = async (u) => {
    const rec = (await db.get('user/' + u)).value
    return unwrap(wrapKeyFrom(evaluateFull(keys.oprf, PASSWORD)), rec.authPrivEnc)
  }
  const rawSession = async (call, username, deviceId, deviceLabel, authPriv, { skipLogin = false } = {}) => {
    if (skipLogin) return call('session', { username, deviceId, deviceLabel, sig: '00'.repeat(64) })
    const hello = await call('hello')
    const nonce = powSolve(b4a.from(hello.challenge, 'hex'), hello.difficulty)
    const { blinded } = blind(PASSWORD)
    const l = await call('login', { username, blinded: b4a.toString(blinded, 'hex'), powNonce: b4a.toString(nonce, 'hex') })
    if (l.error) return { error: 'login-stage: ' + l.error }
    if (authPriv === null) return call('session', { username, deviceId, deviceLabel, sig: '00'.repeat(64) })
    const sig = authSign(authPriv, b4a.from(l.sessionChallenge, 'hex'))
    return call('session', { username, deviceId, deviceLabel, sig: b4a.toString(sig, 'hex') })
  }
  // One attached responder + its client caller, with the options a lane needs.
  const panel = (opts = {}) => {
    const [cli, srv] = streamPair()
    attachLoginRpc(srv, { keys, difficulty: DIFFICULTY, throttle: makeThrottle(1e6, 900), db, dataDir: dir, sessionTtlMs: 3600000, ...opts })
    return rpcClient(cli)
  }

  // ================================================================ A. the headline
  {
    await ops.createUser(ctx, 'alice', PASSWORD)
    const { analytics, activity } = spies()
    const call = panel({ analytics, activity })

    const beforeEnroll = mark()
    const first = await login(call, db, 'alice', PASSWORD, { deviceId: 'device-1', deviceLabel: 'Living room TV' })
    assert.ok(first.token, 'first login issued a token')
    const enroll = since(beforeEnroll)
    log(`A: first-ever login on a new device → +${enroll.blocks} block(s), +${enroll.bytes} B (record + the seen/ stamp)`)
    assert.strictEqual(enroll.blocks, 2, 'enrolling a device appends the record and its recency stamp, once each')
    assert.ok(enroll.bytes > 0, 'those blocks carry the record')

    const baseline = mark()
    const enrolled = (await devicesOf('alice'))[0]
    let firstDrift = null
    for (let i = 0; i < LOGINS; i++) {
      const s = await login(call, db, 'alice', PASSWORD, { deviceId: 'device-1', deviceLabel: 'Living room TV' })
      assert.ok(s.token, `login ${i + 1} issued a token`)
      const d = since(baseline)
      if (!firstDrift && (d.blocks !== 0 || d.bytes !== 0)) firstDrift = { at: i + 1, ...d }
    }
    const total = since(baseline)
    log(`A: ${LOGINS} sequential logins on the enrolled device → +${total.blocks} block(s), +${total.bytes} B` +
        (firstDrift ? ` (first drift at login ${firstDrift.at})` : ''))
    assert.strictEqual(firstDrift, null, 'no login may append anything: ' + JSON.stringify(firstDrift))
    assert.strictEqual(total.blocks, 0, `${LOGINS} logins appended ${total.blocks} block(s)`)
    assert.strictEqual(total.bytes, 0, `${LOGINS} logins appended ${total.bytes} byte(s)`)

    // A VARYING LABEL MUST NOT REINTRODUCE THE WRITE. Every login above sent the same
    // label, so a regression that synced `label` on each login would have passed the
    // whole lane. The responder deliberately never updates it (the pre-change one did
    // not either), and this is what says so.
    const labelBase = mark()
    for (let i = 0; i < 20; i++) {
      await login(call, db, 'alice', PASSWORD, { deviceId: 'device-1', deviceLabel: 'TV ' + i + ' ' + Math.random() })
    }
    const labelDelta = since(labelBase)
    log(`A: 20 logins with a DIFFERENT label each time → +${labelDelta.blocks} block(s), +${labelDelta.bytes} B`)
    assert.strictEqual(labelDelta.blocks, 0, 'a varying deviceLabel must not write')
    assert.strictEqual((await devicesOf('alice'))[0].label, 'Living room TV', 'the stored label is the one from enrolment')

    // Zero-write is not zero-work: the record still says the device is enrolled, and the
    // observability sinks still saw every one of these sessions.
    const after = await devicesOf('alice')
    assert.strictEqual(after.length, 1, 'the device is still the only enrollment')
    assert.strictEqual(after[0].issuedAt, enrolled.issuedAt, 'it kept its ORIGINAL enrollment stamp — it was never re-enrolled')
    assert.ok(!('expiresAt' in after[0]), 'the enrolled entry carries no expiresAt at all')
    assert.deepStrictEqual(await seenOf('alice'), { 'device-1': today }, 'and the recency map holds exactly one day stamp')
    const sessions = LOGINS + 21
    assert.strictEqual(analytics.ok, sessions, 'analytics.sessionIssued fired on every login, written or not')
    assert.strictEqual(analytics.failed, 0, 'no failures counted')
    assert.strictEqual(activity.events.filter((e) => e.kind === 'session' && e.deviceId === 'device-1').length, sessions,
      "activity.record('session', …) fired on every login, written or not")
    log('A: PASS — the enrolled device keeps its slot and its stamp; analytics + activity unchanged ✓')
  }

  // ============================================== B. durable enrolment (the old bug)
  // A device offline for longer than the session TTL used to be PRUNED out of the record
  // by the next login of ANY device — losing its slot and forcing a fresh enrolment that
  // evicted a sibling. With no expiresAt on the entry there is nothing to lapse.
  {
    await ops.createUser(ctx, 'bob', PASSWORD)
    const call = panel({ sessionTtlMs: SHORT_TTL_MS })

    await login(call, db, 'bob', PASSWORD, { deviceId: 'tv', deviceLabel: 'Television' })
    await sleep(5) // strictly increasing issuedAt, so "oldest" is unambiguous
    await login(call, db, 'bob', PASSWORD, { deviceId: 'phone', deviceLabel: 'Phone' })
    const enrolled = await devicesOf('bob')
    assert.strictEqual(enrolled.length, 2, 'both devices enrolled (maxDevices 2)')
    const tvStamp = enrolled.find((d) => d.deviceId === 'tv').issuedAt

    await sleep(SHORT_TTL_MS + 300) // the television is now "offline past SESSION_TTL_DAYS"
    const before = mark()
    const back = await login(call, db, 'bob', PASSWORD, { deviceId: 'tv', deviceLabel: 'Television' })
    assert.ok(back.token, 'the returning device logs in')
    const d = since(before)
    const now = await devicesOf('bob')
    log(`B: returning device after ${SHORT_TTL_MS + 300}ms > TTL ${SHORT_TTL_MS}ms → devices ${JSON.stringify(now.map((x) => x.deviceId))}, +${d.blocks} block(s)`)
    assert.ok(now.find((x) => x.deviceId === 'phone'), 'the sibling device kept its enrollment (pre-fix: pruned away)')
    const tv = now.find((x) => x.deviceId === 'tv')
    assert.ok(tv, 'the returning device is enrolled')
    assert.strictEqual(tv.issuedAt, tvStamp, 'it kept its OWN slot — it was not re-enrolled (pre-fix: re-enrolled with a fresh stamp)')
    assert.strictEqual(now.length, 2, 'still exactly two enrollments — nothing was evicted')
    assert.strictEqual(d.blocks, 0, 'and the return cost no block either (same day, already stamped)')
    // The session it was issued is fresh even though nothing was written: the expiry is
    // in the TOKEN, which is the only place it ever mattered.
    const payload = verifyToken(db.core.key, back.token)
    assert.ok(payload.expiresAt > Date.now(), 'the new token is not expired')
    log('B: PASS — enrolment is durable; the token, not the record, carries the expiry ✓')
  }

  // ================================================== C. device limit, eviction, reject
  {
    await ops.createUser(ctx, 'carol', PASSWORD)
    const { analytics } = spies()
    const call = panel({ analytics })

    for (const id of ['d1', 'd2', 'd3']) {
      await login(call, db, 'carol', PASSWORD, { deviceId: id, deviceLabel: id })
      await sleep(5) // strictly increasing issuedAt
    }
    const kept = (await idsOf('carol')).sort()
    log('C: three logins at maxDevices 2 →', JSON.stringify(kept))
    // All three were seen on the same day, so the tie-break (enrolment order) decides —
    // and it agrees with the old behaviour here. Lane D is where the two differ.
    assert.deepStrictEqual(kept, ['d2', 'd3'], 'the least-recently-seen device was evicted (tie → earliest enrolled)')
    assert.deepStrictEqual(Object.keys(await seenOf('carol')).sort(), ['d2', 'd3'], 'the recency map was pruned with it')

    // devicePolicy 'reject': the fourth device is refused BY NAME, and the reply carries
    // the list so the app can ask the viewer which one to drop.
    const call2 = panel({ devicePolicy: 'reject', analytics })
    const authPriv = await authPrivOf('carol')
    const failedBefore = analytics.failed
    const before = mark()
    const res = await rawSession(call2, 'carol', 'd4', 'Fourth', authPriv)
    log('C: devicePolicy reject →', JSON.stringify(res))
    assert.strictEqual(res.error, 'device-limit', "a full account under 'reject' refuses by name")
    assert.strictEqual(res.devices.length, 2, 'the refusal lists the enrolled devices')
    assert.deepStrictEqual(Object.keys(res.devices[0]).sort(), ['deviceId', 'label'], 'and lists ONLY deviceId + label')
    assert.deepStrictEqual(res.devices.map((x) => x.deviceId).sort(), ['d2', 'd3'])
    assert.strictEqual(analytics.failed, failedBefore + 1, 'a refused login counts as a failure')
    assert.strictEqual(since(before).blocks, 0, 'a refused login on a healthy record writes nothing')
    log('C: PASS — limit enforced, oldest-by-issuedAt evicted, reject policy intact ✓')
  }

  // ============================== D. eviction follows RECENCY, not enrolment order
  // THE REGRESSION THIS LANE EXISTS FOR. `expiresAt` was refreshed on every login, so it
  // doubled as a recency signal; `issuedAt` is enrolment time and has never been
  // refreshed by anything. Ordering evictions by `issuedAt` therefore evicts the device
  // that has been in the household LONGEST — the daily driver — and keeps the one nobody
  // has touched since spring. Recorded recency (`seen/<username>`) is what makes this
  // right, and it is strictly better than the 30-day expiry it replaces.
  {
    await ops.createUser(ctx, 'dora', PASSWORD)
    const rec = (await db.get('user/dora')).value
    const t = Date.now()
    rec.devices = [
      { deviceId: 'tv', label: 'Living room TV', issuedAt: t - 200 * DAY, tokenVersion: 1, status: 'active' }, // enrolled FIRST…
      { deviceId: 'phone', label: 'Old phone', issuedAt: t - 150 * DAY, tokenVersion: 1, status: 'active' }
    ]
    await db.put('user/dora', rec)
    // …but the TV is the one actually in use: seen today, where the phone went quiet
    // 120 days ago. By `issuedAt` the TV is "oldest" and would be the one signed out.
    await db.put('seen/dora', { tv: today, phone: today - 120 })

    const call = panel()
    await login(call, db, 'dora', PASSWORD, { deviceId: 'tablet', deviceLabel: 'New tablet' })
    const after = (await idsOf('dora')).sort()
    log('D: tv (enrolled 200d ago, seen today) + phone (enrolled 150d ago, seen 120d ago) + a new tablet →', JSON.stringify(after))
    assert.deepStrictEqual(after, ['tablet', 'tv'], 'the ABANDONED phone was evicted, not the daily-driver TV')

    // …and the TV's session is still live. Under the enrolment-order rule its
    // freshly-issued token failed sessionLive and it dropped to a password prompt.
    const tvSession = await login(call, db, 'dora', PASSWORD, { deviceId: 'tv', deviceLabel: 'Living room TV' })
    assert.strictEqual(await sessionLive(db, verifyToken(db.core.key, tvSession.token)), true, 'the daily driver stayed signed in')
    log('D: PASS — eviction is least-recently-SEEN, and the daily driver keeps its slot ✓')
  }

  // ============================================ E. a lowered maxDevices converges
  // Nothing drops a durable enrolment on its own, so without an explicit trim a cap
  // lowered from 8 to 2 would leave all 8 devices live for ever, a 9th would evict
  // exactly one, and the reseller dashboard would read "8 of 2 device slot(s) in use".
  {
    await ops.createUser(ctx, 'evan', PASSWORD)
    await ops.setMaxDevices(ctx, 'evan', 8)
    const call = panel()
    for (let i = 1; i <= 8; i++) {
      await login(call, db, 'evan', PASSWORD, { deviceId: 'e' + i, deviceLabel: 'e' + i })
      await sleep(3)
    }
    assert.strictEqual((await devicesOf('evan')).length, 8, 'eight devices enrolled at cap 8')
    // Recency: e1 is the daily driver, e8 has been quiet longest.
    await db.put('seen/evan', { e1: today, e2: today - 1, e3: today - 2, e4: today - 3, e5: today - 4, e6: today - 5, e7: today - 6, e8: today - 7 })
    await ops.setMaxDevices(ctx, 'evan', 2)

    const before = mark()
    await login(call, db, 'evan', PASSWORD, { deviceId: 'e1', deviceLabel: 'e1' })
    const trimmed = (await idsOf('evan')).sort()
    log(`E: cap 8→2 then one login → ${JSON.stringify(trimmed)}, +${since(before).blocks} block(s)`)
    assert.deepStrictEqual(trimmed, ['e1', 'e2'], 'the surplus was trimmed to the cap, keeping the two most recently seen')
    assert.deepStrictEqual(Object.keys(await seenOf('evan')).sort(), ['e1', 'e2'], 'the recency map was pruned with it')
    const settled = mark()
    await login(call, db, 'evan', PASSWORD, { deviceId: 'e1', deviceLabel: 'e1' })
    assert.strictEqual(since(settled).blocks, 0, 'and it has converged — the next login is free again')
    log('E: PASS — a lowered cap converges in one write ✓')
  }

  // ============================================ F. a record from the OLD build still works
  // Entries written before this change carry their own expiresAt. They must keep logging
  // in, and HEAL to the new shape on the first write rather than needing a migration.
  {
    await ops.createUser(ctx, 'erin', PASSWORD)
    const rec = (await db.get('user/erin')).value
    const t = Date.now()
    rec.maxDevices = 3
    rec.devices = [
      { deviceId: 'old-tv', label: 'Old TV', issuedAt: t - 90000, expiresAt: t + 3600000, tokenVersion: 1, status: 'active' },
      { deviceId: 'old-phone', label: 'Old phone', issuedAt: t - 85000, expiresAt: t + 3600000, tokenVersion: 1, status: 'active' },
      { deviceId: 'old-lapsed', label: 'Long gone', issuedAt: t - 80000, expiresAt: t - 1000, tokenVersion: 1, status: 'active' }
    ]
    await db.put('user/erin', rec)
    const call = panel()

    const before = mark()
    const s = await login(call, db, 'erin', PASSWORD, { deviceId: 'old-tv', deviceLabel: 'Old TV' })
    assert.ok(s.token, 'a legacy-shaped record still logs in')
    const heal = since(before)
    const healed = await devicesOf('erin')
    log(`F: legacy record → +${heal.blocks} block(s); devices now ${JSON.stringify(healed.map((x) => x.deviceId))}`)
    assert.strictEqual(heal.blocks, 2, 'the heal costs one record write plus the first recency stamp')
    assert.deepStrictEqual(healed.map((x) => x.deviceId), ['old-tv', 'old-phone'], 'the lapsed legacy entry is still pruned')
    const tv = healed.find((x) => x.deviceId === 'old-tv')
    assert.ok(!('expiresAt' in tv), 'the entry that signed in healed to the new shape')
    assert.strictEqual(tv.issuedAt, t - 90000, 'healing preserved the original enrollment stamp')
    assert.strictEqual(tv.label, 'Old TV', 'and its label')
    // The heal covers the whole record: a SIBLING that did not sign in is durable too.
    // Left legacy, it would have lapsed and been pruned out from under itself later.
    const phone = healed.find((x) => x.deviceId === 'old-phone')
    assert.ok(!('expiresAt' in phone), 'the sibling entry healed in the SAME write')
    assert.strictEqual(phone.issuedAt, t - 85000, 'without disturbing its enrollment stamp')

    const after = mark()
    await login(call, db, 'erin', PASSWORD, { deviceId: 'old-tv', deviceLabel: 'Old TV' })
    assert.strictEqual(since(after).blocks, 0, 'and the login after the heal is free')
    const sib = mark()
    await login(call, db, 'erin', PASSWORD, { deviceId: 'old-phone', deviceLabel: 'Old phone' })
    assert.strictEqual(since(sib).blocks, 1, "the sibling's first login costs only its recency stamp — never a record write")

    // A legacy record where EVERY entry has lapsed: the prune empties it and the device
    // that signs in re-enrols. One write, and nothing is left behind.
    await ops.createUser(ctx, 'elsa', PASSWORD)
    const dead = (await db.get('user/elsa')).value
    dead.devices = [
      { deviceId: 'gone-1', label: 'a', issuedAt: t - 90000, expiresAt: t - 5000, tokenVersion: 1, status: 'active' },
      { deviceId: 'gone-2', label: 'b', issuedAt: t - 80000, expiresAt: t - 4000, tokenVersion: 1, status: 'active' }
    ]
    await db.put('user/elsa', dead)
    await login(call, db, 'elsa', PASSWORD, { deviceId: 'gone-1', deviceLabel: 'a' })
    assert.deepStrictEqual(await idsOf('elsa'), ['gone-1'], 'an all-lapsed legacy record re-enrols the device that returned')
    assert.ok(!('expiresAt' in (await devicesOf('elsa'))[0]), 'in the new shape')

    // A record with NO tokenVersion at all heals once to the default and then costs
    // nothing — the exact-identity compare must not churn on it.
    await ops.createUser(ctx, 'edna', PASSWORD)
    const noTv = (await db.get('user/edna')).value
    delete noTv.tokenVersion
    noTv.devices = [{ deviceId: 'tv', label: 'TV', issuedAt: t - 1000, status: 'active' }]
    await db.put('user/edna', noTv)
    const tvBase = mark()
    await login(call, db, 'edna', PASSWORD, { deviceId: 'tv', deviceLabel: 'TV' })
    assert.strictEqual(since(tvBase).blocks, 2, 'a record with no tokenVersion heals once (record + stamp)')
    assert.strictEqual((await devicesOf('edna'))[0].tokenVersion, 1, 'to the default sessionLive assumes')
    const tvSettled = mark()
    await login(call, db, 'edna', PASSWORD, { deviceId: 'tv', deviceLabel: 'TV' })
    assert.strictEqual(since(tvSettled).blocks, 0, 'and never again')

    // A device entry whose `status` is not 'active' must NOT trigger a write: nothing in
    // the repo reads that field, so healing it would be churn for a dead value.
    const stale = (await db.get('user/edna')).value
    stale.devices[0].status = 'whatever'
    await db.put('user/edna', stale)
    const statusBase = mark()
    await login(call, db, 'edna', PASSWORD, { deviceId: 'tv', deviceLabel: 'TV' })
    assert.strictEqual(since(statusBase).blocks, 0, "a device entry's status is a dead field and must not be a write trigger")
    log('F: PASS — legacy records log in, heal whole-record in one write, then cost nothing ✓')
  }

  // =============================================== G. revocation, with core/session.js
  // sessionLive is imported UNMODIFIED from @aliran/core (core/session.js). Only issuance
  // became stateless; liveness is still re-derived from the record on every presentation.
  {
    await ops.createUser(ctx, 'dave', PASSWORD)
    const call = panel()

    const s1 = await login(call, db, 'dave', PASSWORD, { deviceId: 'tablet', deviceLabel: 'Tablet' })
    const p1 = verifyToken(db.core.key, s1.token)
    assert.strictEqual(await sessionLive(db, p1), true, 'an enrolled device is live')

    await ops.revokeDevice(ctx, 'dave', 'tablet')
    assert.strictEqual(await sessionLive(db, p1), false, 'per-device revoke kills it on the next check')
    assert.strictEqual((await db.get('user/dave')).value.tokenVersion, p1.tokenVersion, 'per-device revoke does NOT bump tokenVersion')

    const s2 = await login(call, db, 'dave', PASSWORD, { deviceId: 'tablet', deviceLabel: 'Tablet' })
    const p2 = verifyToken(db.core.key, s2.token)
    assert.strictEqual(await sessionLive(db, p2), true, 're-enrolling after a revoke works')

    await ops.logoutAll(ctx, 'dave')
    assert.strictEqual(await sessionLive(db, p2), false, '"log out all devices" kills the live session')
    const s3 = await login(call, db, 'dave', PASSWORD, { deviceId: 'tablet', deviceLabel: 'Tablet' })
    const p3 = verifyToken(db.core.key, s3.token)
    assert.strictEqual(p3.tokenVersion, (await db.get('user/dave')).value.tokenVersion, 'the fresh token carries the bumped tokenVersion')
    assert.strictEqual(await sessionLive(db, p3), true, 'and the device signs back in')
    assert.strictEqual(await sessionLive(db, p2), false, 'while the old token stays dead')

    await ops.setUserStatus(ctx, 'dave', 'disabled')
    assert.strictEqual(await sessionLive(db, p3), false, 'a disabled account kills every session')
    await ops.setUserStatus(ctx, 'dave', 'active')

    // Deleting the account takes the recency map with it — nothing else would collect it.
    await ops.createUser(ctx, 'doomed', PASSWORD)
    await login(call, db, 'doomed', PASSWORD, { deviceId: 'x', deviceLabel: 'x' })
    assert.ok(await seenOf('doomed'), 'the recency map exists while the account does')
    await ops.deleteUser(ctx, 'doomed')
    assert.strictEqual(await seenOf('doomed'), null, 'and is deleted with it')
    log('G: PASS — revoke, logout-all, disable and delete behave exactly as before ✓')
  }

  // ================================== H. a revoke landing mid-login is not lost (CAS)
  // Read-modify-write on a record an admin can mutate at the same instant. Pre-CAS the
  // login's write clobbered the revoke, and durable enrolment made the consequence
  // permanent: the resurrected entry used to lapse itself out within SESSION_TTL_DAYS
  // and would now hold the slot for ever, with the dashboard still showing it removed.
  {
    await ops.createUser(ctx, 'frank', PASSWORD)
    await ops.setMaxDevices(ctx, 'frank', 4)
    const plain = panel()
    await login(plain, db, 'frank', PASSWORD, { deviceId: 'stolen', deviceLabel: 'Stolen phone' })

    const gated = gatedDb(db)
    const [cli, srv] = streamPair()
    attachLoginRpc(srv, { keys, difficulty: DIFFICULTY, throttle: makeThrottle(1e6, 900), db: gated, dataDir: dir, sessionTtlMs: 3600000 })
    const call = rpcClient(cli)

    const open = gated.hold('put', 'user/') // the next user/ put by the responder will block
    const inFlight = login(call, db, 'frank', PASSWORD, { deviceId: 'newtv', deviceLabel: 'New TV' })
    inFlight.catch(() => {}) // observed, so a failure elsewhere does not also crash on this
    await waitParked(gated, 'put', 'the login is parked between its read and its write')

    await ops.revokeDevice(ctx, 'frank', 'stolen') // the operator revokes, right now
    open() // …and only now does the login get to write
    const out = await inFlight
    assert.ok(out.token, 'the login still succeeds')
    const ids = (await idsOf('frank')).sort()
    log('H: revoke landed mid-login → devices', JSON.stringify(ids))
    assert.deepStrictEqual(ids, ['newtv'], 'the revoke survived and the new device still enrolled (pre-CAS: ["stolen","newtv"])')
    log('H: PASS — a concurrent admin revoke is never lost ✓')
  }

  // ================================================================= I. concurrency
  {
    await ops.createUser(ctx, 'gwen', PASSWORD)
    await ops.setMaxDevices(ctx, 'gwen', 5)
    // Three brand-new devices signing in at once: each contends on the same record, and
    // every one of them must land (the losers redo their decision on the winner's record).
    const calls = [panel(), panel(), panel()]
    const results = await Promise.all(calls.map((c, i) => login(c, db, 'gwen', PASSWORD, { deviceId: 'p' + i, deviceLabel: 'p' + i })))
    assert.ok(results.every((r) => r.token), 'every concurrent login was issued a token')
    assert.deepStrictEqual((await idsOf('gwen')).sort(), ['p0', 'p1', 'p2'], 'no concurrent enrolment was lost')

    // …and the steady state has no contention at all, because it does not write.
    const before = mark()
    await Promise.all(calls.map((c) => login(c, db, 'gwen', PASSWORD, { deviceId: 'p0', deviceLabel: 'p0' })))
    assert.strictEqual(since(before).blocks, 0, 'concurrent logins on an ENROLLED device write nothing')
    log('I: PASS — parallel enrolments all land; parallel repeat logins cost nothing ✓')
  }

  // ================================================= J. malformed records + failures
  {
    await ops.createUser(ctx, 'gina', PASSWORD)
    const { analytics, activity } = spies()
    const call = panel({ analytics, activity })
    const authPriv = await authPrivOf('gina')
    // Measured PER BRANCH, not across the lane: the disabled-account branch needs an
    // admin setUserStatus either side of it, and an admin write is not a login write.
    let bytes = 0
    const noWrite = async (label, fn) => {
      const m = mark()
      const r = await fn()
      const d = since(m)
      assert.strictEqual(d.blocks, 0, `${label} must not write to the bee (+${d.blocks} block(s), +${d.bytes} B)`)
      bytes += d.bytes
      return r
    }

    // No challenge: `session` before any `login` on this connection.
    const noChal = await noWrite('no challenge', () => rawSession(call, 'gina', 'g1', 'G', authPriv, { skipLogin: true }))
    assert.match(noChal.error, /no session challenge/, 'session without a login is refused')
    assert.strictEqual(analytics.failed, 0, 'a missing challenge is not a credential failure')

    const unknown = await noWrite('unknown user', () => rawSession(call, 'nobody', 'g1', 'G', authPriv))
    assert.strictEqual(unknown.error, 'unknown user')
    assert.strictEqual(analytics.failed, 1, 'unknown user counts a failure')

    await ops.setUserStatus(ctx, 'gina', 'disabled')
    const disabled = await noWrite('disabled account', () => rawSession(call, 'gina', 'g1', 'G', authPriv))
    assert.strictEqual(disabled.error, 'account disabled')
    assert.strictEqual(analytics.failed, 2, 'disabled account counts a failure')
    await ops.setUserStatus(ctx, 'gina', 'active')

    const forged = await noWrite('forged signature', () => rawSession(call, 'gina', 'g1', 'G', null))
    assert.strictEqual(forged.error, 'auth failed')
    assert.strictEqual(analytics.failed, 3, 'a forged signature counts a failure')

    for (const [label, bad] of [['missing', undefined], ['object', {}], ['number', 7], ['array', ['a']], ['empty', '']]) {
      const r = await noWrite('deviceId=' + label, () => rawSession(call, 'gina', bad, 'G', authPriv))
      assert.strictEqual(r.error, 'missing deviceId', `a ${label} deviceId is refused, not stored`)
    }
    assert.strictEqual(analytics.failed, 3, 'a missing deviceId is NOT counted (unchanged from before)')

    assert.strictEqual(analytics.ok, 0, 'no session was issued on any failure path')
    assert.strictEqual(activity.events.length, 0, 'and none reached the activity feed')
    log(`J: nine failure branches → +0 block(s), +${bytes} B`)
    assert.strictEqual(bytes, 0, 'and not one byte either')
    assert.deepStrictEqual(await devicesOf('gina'), [], 'no failed attempt enrolled anything')

    // MALFORMED `devices` MUST NOT KILL THE PANEL. An unguarded touch on a non-array
    // throws a TypeError, which safety-catch rethrows into a microtask — an uncaught
    // exception with no handler, i.e. the whole process. Surviving with a working login
    // IS the assertion here; a crash takes this test process down with it.
    for (const junk of [{}, 'x', 7, [null], [{}], [{ deviceId: 5 }], ['nope'], [[]]]) {
      const rec = (await db.get('user/gina')).value
      rec.devices = junk
      await db.put('user/gina', rec)
      const r = await login(call, db, 'gina', PASSWORD, { deviceId: 'survivor', deviceLabel: 'S' })
      assert.ok(r.token, 'a login against devices=' + JSON.stringify(junk) + ' still succeeds')
      assert.deepStrictEqual(await idsOf('gina'), ['survivor'], 'and the malformed list is repaired to a clean array')
    }
    log('J: PASS — every failure branch unchanged; malformed device lists fail closed ✓')
  }

  // ==================================== K. what the recency key costs, and the token
  {
    // The reply shape and the token are unchanged, and the expiry advances on a login
    // that writes nothing — the whole point of moving it into the token.
    await ops.createUser(ctx, 'hank', PASSWORD)
    const TTL = 7 * DAY
    const call = panel({ sessionTtlMs: TTL })
    const authPriv = await authPrivOf('hank')
    const t0 = Date.now()
    const res = await rawSession(call, 'hank', 'laptop', 'Laptop', authPriv)
    assert.deepStrictEqual(Object.keys(res).sort(), ['expiresAt', 'token', 'tokenVersion'], 'the reply shape is unchanged')
    assert.strictEqual(res.tokenVersion, 1)
    const p = verifyToken(db.core.key, res.token)
    assert.ok(p, 'the token verifies against the bee core key (= the panel signing key)')
    assert.strictEqual(p.userId, 'hank'); assert.strictEqual(p.deviceId, 'laptop')
    assert.strictEqual(p.expiresAt, res.expiresAt, 'the reply repeats the token expiry')
    assert.ok(p.expiresAt >= t0 + TTL && p.expiresAt <= Date.now() + TTL, 'expiry is now + SESSION_TTL, in the future')
    assert.ok(tokenValid(db.core.key, res.token), 'and the token is fresh by the token check')
    const before = mark()
    await sleep(5)
    const res2 = await rawSession(call, 'hank', 'laptop', 'Laptop', authPriv)
    assert.ok(res2.expiresAt > res.expiresAt, 'the second token expires strictly later than the first')
    assert.strictEqual(since(before).blocks, 0, 'even though nothing was written')
    log(`K: token expiry advanced ${res2.expiresAt - res.expiresAt}ms with 0 blocks appended ✓`)

    // THE STANDING COST. 10 accounts × 2 devices, every recency stamp rewound one day,
    // then one login each — that is exactly one day's worth of `seen/` traffic for a
    // fleet of that size, and it is ALL the bee sees from logins in steady state.
    const N = 10
    const flock = panel()
    for (let i = 0; i < N; i++) {
      const u = 'day' + i
      await ops.createUser(ctx, u, PASSWORD)
      await login(flock, db, u, PASSWORD, { deviceId: 'tv', deviceLabel: 'Television' })
      await login(flock, db, u, PASSWORD, { deviceId: 'phone', deviceLabel: 'Phone' })
    }
    for (let i = 0; i < N; i++) await db.put('seen/day' + i, { tv: today - 1, phone: today - 1 }) // "yesterday"
    const dayStart = mark()
    for (let i = 0; i < N; i++) {
      const u = 'day' + i
      await login(flock, db, u, PASSWORD, { deviceId: 'tv', deviceLabel: 'Television' })
      await login(flock, db, u, PASSWORD, { deviceId: 'phone', deviceLabel: 'Phone' })
      // …and a second login the same day by each device, which must cost nothing more.
      await login(flock, db, u, PASSWORD, { deviceId: 'tv', deviceLabel: 'Television' })
      await login(flock, db, u, PASSWORD, { deviceId: 'phone', deviceLabel: 'Phone' })
    }
    const dayCost = since(dayStart)
    log(`K: one day of ${N} accounts × 2 devices (40 logins) → +${dayCost.blocks} block(s), +${dayCost.bytes} B ` +
        `= ${(dayCost.bytes / N).toFixed(1)} B/account/day, ${(dayCost.bytes * 365 / 1024).toFixed(1)} KiB/year at this size`)
    // Two devices, two day-changes, one small put each. The repeat logins add nothing —
    // if they did, the count would be 4N, not 2N.
    assert.strictEqual(dayCost.blocks, 2 * N, `one recency stamp per device per day and no more (got ${dayCost.blocks}, expected ${2 * N})`)
    assert.ok(dayCost.bytes < 200 * 2 * N, `and each stamp stays small (${(dayCost.bytes / (2 * N)).toFixed(0)} B)`)
    for (let i = 0; i < N; i++) assert.deepStrictEqual(await seenOf('day' + i), { tv: today, phone: today }, 'every map advanced to today')
    log('K: PASS — token shape intact; the recency key costs one small block per device per day ✓')
  }

  // ============================================ L. what the operator surfaces now say
  {
    const list = await ops.listDevices(ctx, 'alice')
    assert.strictEqual(list.length, 1)
    assert.strictEqual(list[0].deviceId, 'device-1')
    assert.ok(list[0].issuedAt > 0, 'the dashboard still knows WHEN the device enrolled')
    assert.strictEqual(list[0].expiresAt, null, 'and reports no expiry rather than inventing one')
    assert.strictEqual(list[0].expired, false, 'so nothing renders a confidently wrong "expired" badge')
    assert.strictEqual(list[0].lastSeenAt, today * DAY, 'it reports the DAY the device last signed in instead')
    // A device that has not signed in since the map existed reports null, not a guess.
    const legacy = await ops.listDevices(ctx, 'erin')
    const unseen = legacy.find((d) => d.deviceId === 'old-phone')
    assert.ok(unseen, 'the sibling legacy device is listed')
    assert.strictEqual(await ops.listDevices(ctx, 'gina').then((l) => l.length), 1, 'a repaired record lists cleanly')
    log('L: PASS — listDevices reports enrolment and a real last-seen day, never a guessed expiry ✓')
  }

  // ========================= M. the recency PRUNE must not drop a sibling's fresh stamp
  // The stamp write is compare-and-swapped, but the membership set it prunes AGAINST is
  // this responder's own snapshot of the device array, read before the write. A sibling
  // that completed a whole login in between is enrolled in the RECORD and absent from
  // that snapshot — pruning against it deletes the sibling's fresh stamp, which is
  // exactly the recency the eviction order reads. The sibling then falls back to its
  // enrolment day and becomes the next eviction candidate: the round-one defect again,
  // one step narrower.
  {
    await ops.createUser(ctx, 'iris', PASSWORD)
    await ops.setMaxDevices(ctx, 'iris', 4)
    const plain = panel()
    await login(plain, db, 'iris', PASSWORD, { deviceId: 'A', deviceLabel: 'A' })
    await db.put('seen/iris', { A: today - 1 }) // A's stamp is stale, so its login must write

    const gated = gatedDb(db)
    const [cli, srv] = streamPair()
    attachLoginRpc(srv, { keys, difficulty: DIFFICULTY, throttle: makeThrottle(1e6, 900), db: gated, dataDir: dir, sessionTtlMs: 3600000 })
    const call = rpcClient(cli)

    const open = gated.hold('put', 'seen/') // park A between reading the map and stamping it
    const inFlight = login(call, db, 'iris', PASSWORD, { deviceId: 'A', deviceLabel: 'A' })
    inFlight.catch(() => {})
    await waitParked(gated, 'put', "A's login is parked at its recency stamp")

    await login(plain, db, 'iris', PASSWORD, { deviceId: 'B', deviceLabel: 'B' }) // B enrols AND stamps
    open()
    await inFlight
    const map = await seenOf('iris')
    log('M: sibling enrolled mid-stamp → seen/iris =', JSON.stringify(map))
    assert.deepStrictEqual(map, { A: today, B: today }, "B's fresh stamp survived A's prune (pre-fix: {A} only)")
    assert.deepStrictEqual((await idsOf('iris')).sort(), ['A', 'B'], 'and both devices are enrolled')
    log('M: PASS — the prune re-reads membership instead of trusting a stale snapshot ✓')
  }

  // ===================== N. the compensating delete must not eat a re-created account
  // A login whose CAS never ran has just RESURRECTED a record the operator deleted, and
  // undoes it. But `delete-user alice` followed by `create-user alice` is a routine
  // repair, and the whole sequence fits inside that window — an uncompensated delete
  // there destroys a live account, its verifier and every sealed grant, which is worse
  // in kind than the resurrection it was undoing. And the device is told 'unknown user',
  // which IS a verdict, so a television would erase its stored keys over it.
  {
    await ops.createUser(ctx, 'ivan', PASSWORD)
    await ops.setMaxDevices(ctx, 'ivan', 4)
    const plain = panel()
    await login(plain, db, 'ivan', PASSWORD, { deviceId: 'first', deviceLabel: 'First' })
    warnings.length = 0

    const gated = gatedDb(db)
    const [cli, srv] = streamPair()
    attachLoginRpc(srv, { keys, difficulty: DIFFICULTY, throttle: makeThrottle(1e6, 900), db: gated, dataDir: dir, sessionTtlMs: 3600000 })
    const call = rpcClient(cli)
    const authPriv = await authPrivOf('ivan')

    const openPut = gated.hold('put', 'user/')
    const inFlight = rawSession(call, 'ivan', 'second', 'Second', authPriv) // a NEW device → it will write
    inFlight.catch(() => {})
    await waitParked(gated, 'put', 'the login is parked at its record write')

    await ops.deleteUser(ctx, 'ivan') // the operator removes the account…
    const openDel = gated.hold('del', 'user/') // …and we park the compensation that follows
    openPut() // the put now INSERTS, resurrecting the deleted record
    await waitParked(gated, 'del', 'the compensating delete is parked')

    // Inside that window: the operator finishes the repair. Both halves land.
    await ops.deleteUser(ctx, 'ivan') // clears the resurrection
    await ops.createUser(ctx, 'ivan', PASSWORD) // a brand-new, legitimate account
    const reborn = (await db.get('user/ivan')).value.verifier
    openDel()
    const reply = await inFlight

    const survivor = await db.get('user/ivan')
    log('N: delete+create inside the compensation window → reply', JSON.stringify(reply.error) + ', account', survivor ? 'INTACT' : 'GONE')
    assert.strictEqual(reply.error, 'unknown user', 'the login is still refused')
    assert.ok(survivor, 'the re-created account survived (pre-fix: the compensation deleted it)')
    assert.strictEqual(survivor.value.verifier, reborn, 'and it is the operator\'s new record, untouched')
    assert.deepStrictEqual(survivor.value.devices, [], 'with no resurrected enrolment on it')
    assert.deepStrictEqual(warnings, [], 'and it warned about NOTHING — this is a routine repair, not an incident')

    // THE ONE STATE THE COMPENSATION CANNOT REPAIR, and the reason it must be loud. If a
    // third writer rewrites the RESURRECTED record inside the same window, the record is
    // no longer the one the put created, the undo correctly stands down, and the deleted
    // account stays in the bee carrying its old verifier — so the old password still
    // opens it. No session is issued, and nothing else on this path leaves a trace.
    await ops.createUser(ctx, 'ivy', PASSWORD)
    await ops.setMaxDevices(ctx, 'ivy', 4)
    const deadAuthPub = (await db.get('user/ivy')).value.authPub
    await login(plain, db, 'ivy', PASSWORD, { deviceId: 'first', deviceLabel: 'First' })

    const gated2 = gatedDb(db)
    const [cli2, srv2] = streamPair()
    attachLoginRpc(srv2, { keys, difficulty: DIFFICULTY, throttle: makeThrottle(1e6, 900), db: gated2, dataDir: dir, sessionTtlMs: 3600000 })
    const call2 = rpcClient(cli2)
    const authPriv2 = await authPrivOf('ivy')

    const openPut2 = gated2.hold('put', 'user/')
    const inFlight2 = rawSession(call2, 'ivy', 'second', 'Second', authPriv2)
    inFlight2.catch(() => {})
    await waitParked(gated2, 'put', 'the login is parked at its record write')
    await ops.deleteUser(ctx, 'ivy')
    const openDel2 = gated2.hold('del', 'user/')
    openPut2() // resurrects the deleted record
    await waitParked(gated2, 'del', 'the compensating delete is parked')
    // A third writer touches the resurrected record — an admin op standing in for the
    // grant/package reconcile that would really do it, holding a pre-delete read.
    await ops.setMaxDevices(ctx, 'ivy', 3)
    warnings.length = 0
    openDel2()
    const reply2 = await inFlight2

    const zombie = await db.get('user/ivy')
    log('N: a third write landed on the resurrection →', warnings.length, 'warning(s)')
    assert.strictEqual(reply2.error, 'unknown user', 'the login is refused, so no session is issued for it')
    assert.ok(zombie, 'the deleted account really is back — this is the state being reported')
    assert.strictEqual(zombie.value.authPub, deadAuthPub, 'and it is the DEAD account, not a re-created one')
    assert.strictEqual(warnings.length, 1, 'exactly one warning was logged')
    assert.match(warnings[0], /RESURRECTED A DELETED ACCOUNT/, 'it says plainly what happened')
    assert.match(warnings[0], /"ivy"/, 'it names the account')
    assert.match(warnings[0], /delete-user ivy/, 'and it tells the operator exactly how to finish the job')
    await ops.deleteUser(ctx, 'ivy') // …which is what the operator is told to do
    log('N: PASS — the undo stands down for a re-created account, and reports the one case it cannot repair ✓')
  }

  // ================================ O. a retry re-reads recency, not just the record
  // A lost CAS redoes the device decision — and must redo it against a FRESH recency
  // map, because the eviction order is derived from it. Reusing the map read before the
  // write that forced the retry evicts on an answer that is already known to be stale.
  {
    await ops.createUser(ctx, 'ione', PASSWORD)
    const rec = (await db.get('user/ione')).value
    const t = Date.now()
    // X is LEGACY (carries an expiresAt), so X's own login writes the record — which is
    // what forces the parked login to retry.
    rec.devices = [
      { deviceId: 'X', label: 'X', issuedAt: t - 300 * DAY, expiresAt: t + 3600000, tokenVersion: 1, status: 'active' },
      { deviceId: 'Y', label: 'Y', issuedAt: t - 200 * DAY, tokenVersion: 1, status: 'active' }
    ]
    await db.put('user/ione', rec)
    await db.put('seen/ione', { X: today - 100, Y: today - 1 }) // X looks stalest… for now

    const gated = gatedDb(db)
    const [cli, srv] = streamPair()
    attachLoginRpc(srv, { keys, difficulty: DIFFICULTY, throttle: makeThrottle(1e6, 900), db: gated, dataDir: dir, sessionTtlMs: 3600000 })
    const call = rpcClient(cli)
    const plain = panel()

    const open = gated.hold('put', 'user/')
    const inFlight = login(call, db, 'ione', PASSWORD, { deviceId: 'Z', deviceLabel: 'Z' })
    inFlight.catch(() => {})
    await waitParked(gated, 'put', "Z's login is parked having decided to evict X")

    await login(plain, db, 'ione', PASSWORD, { deviceId: 'X', deviceLabel: 'X' }) // heals X (record write) + stamps X today
    open()
    await inFlight
    const left = (await idsOf('ione')).sort()
    log('O: X signed in while Z was parked → devices', JSON.stringify(left))
    assert.deepStrictEqual(left, ['X', 'Z'], 'the retry evicted Y on FRESH recency (pre-fix: evicted X on the stale map)')
    log('O: PASS — a retry re-reads the recency map, not just the record ✓')
  }

  log('\nRESULT: PASS ✅  (100 logins on an enrolled device append 0 blocks / 0 bytes; enrolment is durable; eviction is least-recently-seen; a lowered cap converges; concurrent revokes, prunes, compensations and retries all hold; limits, revocation, malformed records and every failure branch unchanged)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
