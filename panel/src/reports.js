// Viewer problem reports (S50a) — PSEUDONYMOUS ingest + correlation alerts.
//
// Viewers report a problem ("no audio on channel X") over the EXISTING P2P RPC
// socket (`report` in src/rpc.js). This module is the store + the correlation
// engine behind that responder, and the one place where an authenticated identity
// is reduced to something that can be kept.
//
// THE INVARIANT (negative-tested by test:reports): no username and no deviceId is
// ever stored, returned, counted or logged. The responder verifies the session
// token, then IMMEDIATELY reduces the identity to
//     reporter = hex(HMAC-SHA256(salt, userId + '|' + deviceId)).slice(0, 16)
// with a 32-byte salt generated once into DATA_DIR/secrets/reports-salt (0600).
// Everything downstream — dedupe, throttling, distinct-reporter alert counting,
// the stored record, the activity ring, the admin API — sees only `reporter`.
// Honest limit: HMAC with a panel-held salt is PSEUDONYMOUS AT REST, not anonymous
// to the operator (they hold the salt and the account list, so they can re-derive
// the mapping). It stops leaks, cross-surface correlation and casual snooping — it
// is not a promise to the viewer that the operator cannot identify them.
//
// Storage: DATA_DIR/reports/reports.json + alerts.json, atomic tmp+rename (the
// analytics.js discipline). Reports must NEVER go in data/analytics/ (the
// test:analytics negative scan owns that tree) and NEVER in the Hyperbee — the bee
// replicates to every viewer, so a report in it would be published to the whole
// audience. reports.json is RE-READ per operation (the loadPublishers pattern) so
// the admin CLI can ack/resolve beside a live panel; alerts.json is held in memory
// by the live process and flushed at most once per `flushMs`, because the storm
// path touches it on every ingest and a real outage must cost ~nothing.
//
// Flood control (design D2 layers 2-4 — layer 1 is the client-side cooldown):
//   - per-reporter throttle: the responder's shared makeThrottle (5 / 600 s)
//   - per-channel storm collapse: once an alert is active for a channel, only the
//     first `stormSampleSize` records for that window are STORED; every further
//     report bumps the alert tally and returns {collapsed:true} with NO file write
//   - global breaker: a token bucket (default 120 ingests/min panel-wide); beyond
//     it a report is acknowledged, counted as shed, and dropped without persisting.
//     Reports are the lowest-priority responder — `session` must never queue behind
//     a report storm.
//
// retentionDays = 0 is the kill switch: a no-op factory that never touches disk,
// and src/index.js does not attach the responder at all (an old client gets the
// same "unknown method" it gets from a pre-S50 panel).

import fs from 'fs'
import path from 'path'
import { createHmac, randomBytes } from 'crypto'
import { writeJsonAtomic } from '@aliran/core/atomic-write.js'

// The closed category enum. Duplicated in sdk/report.js (S50c) under the
// no-shared-runtime-module convention; the e2e drift guard asserts deep equality.
// Unknown categories are REJECTED, never coerced to 'other' — a client sending
// something else is a bug or an attack, and silently relabeling it would poison
// the per-category tallies the operator reads.
export const REPORT_CATEGORIES = [
  'no-audio',
  'black-screen',
  'visual-artifacts',
  'buffering',
  'wrong-content',
  'login',
  'other'
]

// Ingest caps. Also enforced at the responder (the 16 KiB raw cap happens BEFORE
// JSON.parse there); duplicated here so a CLI/HTTP caller cannot bypass them.
const MAX_TEXT = 300
const MAX_EVENTS = 50
const MAX_EVENT_TYPE = 40
const MAX_EVENT_DETAIL = 200
const MAX_SHORT = 64 // appVersion / platform
const MAX_CHANNEL = 128
const MAX_NOTE = 500

// A repeat of the same (reporter, channel, category) inside this window bumps the
// existing record's count instead of creating a new one. Beyond it — or once the
// record is resolved — the next report is genuinely a NEW occurrence.
const DEDUPE_WINDOW_MS = 86400000

// An alert's distinct-reporter Set is bounded: past this many it stops growing and
// the surfaces label the count as a lower bound (same "≥" honesty as the analytics
// peer counts). A storm cannot make one alert hold an unbounded set.
const REPORTER_SET_CAP = 500

// Bound on the in-memory correlation windows (one per channel + one for login).
// A flood of junk channel names cannot grow this without bound.
const WINDOW_KEY_CAP = 5000

// Strip control characters, trim, cap. Returns null for anything that is not a
// non-empty string — every caller treats null as "absent", never as an error the
// viewer has to fix.
function clean (v, max) {
  if (typeof v !== 'string') return null
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}

const nowId = () => randomBytes(8).toString('hex')

// Normalize + cap a whole ingest payload. Returns { error } or a clean record body.
// EVERY field is typeof-gated: this runs on attacker-controlled JSON.
export function normalizeReport (input) {
  const o = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const category = typeof o.category === 'string' && REPORT_CATEGORIES.includes(o.category) ? o.category : null
  if (!category) return { error: 'bad-category' }
  const events = []
  if (Array.isArray(o.events)) {
    for (const e of o.events.slice(0, MAX_EVENTS)) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue
      const type = clean(e.type, MAX_EVENT_TYPE)
      if (!type) continue
      events.push({
        t: Number.isFinite(e.t) ? Math.floor(e.t) : null,
        type,
        detail: clean(e.detail, MAX_EVENT_DETAIL)
      })
    }
  }
  return {
    category,
    text: clean(o.text, MAX_TEXT),
    channel: clean(o.channel, MAX_CHANNEL),
    appVersion: clean(o.appVersion, MAX_SHORT),
    platform: clean(o.platform, MAX_SHORT),
    peers: Number.isFinite(o.peers) ? Math.max(0, Math.min(100000, Math.floor(o.peers))) : null,
    events
  }
}

// The pseudonym salt: 32 random bytes in DATA_DIR/secrets/reports-salt (0600, in
// the same owner-only dir as the stream secrets). Generated once, on first use.
// Rotating it re-pseudonymizes everyone (old records keep their old ids and stop
// correlating with new ones) — deliberately NOT automated.
export function loadReportsSalt (dataDir) {
  const p = path.join(dataDir, 'secrets', 'reports-salt')
  try {
    const hex = fs.readFileSync(p, 'utf8').trim()
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex')
  } catch {}
  const salt = randomBytes(32)
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  fs.writeFileSync(p, salt.toString('hex') + '\n', { mode: 0o600 })
  return salt
}

export function makeReports ({
  dataDir,
  retentionDays = 30,
  alertCount = 3,
  alertWindowMin = 10,
  stormSampleSize = 20,
  globalPerMin = 120,
  maxRecords = 5000,
  flushMs = 5000,
  clock = Date.now,
  onAlert = null
} = {}) {
  if (!(retentionDays > 0)) {
    // Kill switch (REPORTS_RETENTION_DAYS=0): a complete no-op that never touches
    // disk — no salt, no directory, no files. src/index.js also skips attaching the
    // responder, so the RPC method simply does not exist.
    const off = { ok: false, error: 'disabled' }
    return {
      enabled: false,
      categories: REPORT_CATEGORIES,
      pseudonym () { return null },
      ingest () { return { ...off } },
      list () { return [] },
      get () { return null },
      ack () { return { ...off } },
      resolve () { return { ...off } },
      listAlerts () { return [] },
      ackAlert () { return { ...off } },
      resolveAlert () { return { ...off } },
      summary () { return { enabled: false, total: 0, new: 0, ack: 0, resolved: 0, openAlerts: 0, shed: 0, byChannel: {}, byHour: [] } },
      close () {}
    }
  }

  const dir = path.join(dataDir, 'reports')
  const reportsPath = path.join(dir, 'reports.json')
  const alertsPath = path.join(dir, 'alerts.json')
  const windowMs = alertWindowMin * 60000
  const retentionMs = retentionDays * 86400000
  const salt = loadReportsSalt(dataDir)

  // ---- files ----
  const readJson = (p, fallback) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
  }
  // Atomic: a crash mid-write can never truncate the store. indent 0 keeps the compact
  // on-disk form; fsync off — reports are ingest-rate data, and losing the last few on a
  // power cut is acceptable where losing a registry is not.
  const writeJson = (p, value) => {
    writeJsonAtomic(p, value, { indent: 0, fsync: false })
  }

  const loadRecords = () => {
    const raw = readJson(reportsPath, null)
    const list = raw && Array.isArray(raw.records) ? raw.records : []
    return list.filter((r) => r && typeof r === 'object')
  }

  // Retention + the 5000 cap. Evicts oldest-RESOLVED first (a resolved report has
  // already done its job) and only then the oldest record of any status, so a flood
  // of new reports can never silently erase the ones an operator is still working.
  const trim = (records) => {
    const cutoff = clock() - retentionMs
    let out = records.filter((r) => (r.lastAt || r.at || 0) >= cutoff)
    if (out.length > maxRecords) {
      const byAge = (a, b) => (a.at || 0) - (b.at || 0)
      const resolved = out.filter((r) => r.status === 'resolved').sort(byAge)
      const drop = new Set()
      let excess = out.length - maxRecords
      for (const r of resolved) { if (excess <= 0) break; drop.add(r.id); excess-- }
      if (excess > 0) {
        for (const r of out.slice().sort(byAge)) { if (excess <= 0) break; if (!drop.has(r.id)) { drop.add(r.id); excess-- } }
      }
      out = out.filter((r) => !drop.has(r.id))
    }
    return out
  }

  const saveRecords = (records) => writeJson(reportsPath, { v: 1, records: trim(records) })

  // ---- alerts (in memory, debounced flush) ----
  const rawAlerts = readJson(alertsPath, null)
  const alerts = rawAlerts && Array.isArray(rawAlerts.alerts) ? rawAlerts.alerts.filter((a) => a && typeof a === 'object') : []
  // Per-alert distinct-reporter sets are rebuilt empty on boot — the alert's own
  // `reporters` count is the durable number (same trade analytics makes with the
  // in-progress hour: a restart forgets in-progress correlation state, never data).
  const alertSets = new Map()
  let alertsDirty = false
  let flushTimer = null

  const flushAlerts = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (!alertsDirty) return
    alertsDirty = false
    const cutoff = clock() - retentionMs
    const keep = alerts.filter((a) => (a.lastAt || a.openedAt || 0) >= cutoff)
    if (keep.length !== alerts.length) alerts.splice(0, alerts.length, ...keep)
    writeJson(alertsPath, { v: 1, alerts })
  }
  const touchAlerts = ({ now = false } = {}) => {
    alertsDirty = true
    if (now) return flushAlerts()
    if (flushTimer) return
    flushTimer = setTimeout(flushAlerts, flushMs)
    if (flushTimer.unref) flushTimer.unref()
  }

  // ---- in-memory correlation windows ----
  // key -> Map(reporter -> lastAt). 'ch:<channel>' for channel rules, 'login' for
  // the panel-wide login rule. Pruned by age on touch, and hard-bounded.
  const windows = new Map()
  const touchWindow = (key, reporter, now) => {
    let w = windows.get(key)
    if (!w) {
      if (windows.size >= WINDOW_KEY_CAP) {
        for (const [k, v] of windows) { let live = false; for (const t of v.values()) if (now - t <= windowMs) { live = true; break } if (!live) windows.delete(k) }
        if (windows.size >= WINDOW_KEY_CAP) { const keep = WINDOW_KEY_CAP >> 1; for (const k of windows.keys()) { if (windows.size <= keep) break; windows.delete(k) } }
      }
      w = new Map(); windows.set(key, w)
    }
    for (const [r, t] of w) if (now - t > windowMs) w.delete(r)
    if (w.size < REPORTER_SET_CAP * 4 || w.has(reporter)) w.set(reporter, now)
    return w.size
  }

  // ---- global breaker (token bucket) ----
  let tokens = globalPerMin
  let lastRefill = clock()
  const takeToken = (now) => {
    tokens = Math.min(globalPerMin, tokens + ((now - lastRefill) * globalPerMin) / 60000)
    lastRefill = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }

  const stats = { shed: 0, collapsed: 0, ingested: 0 }
  const cooldownSec = Math.max(60, Math.round(windowMs / 1000))

  const activeAlert = (key) => alerts.find((a) => a.key === key && a.status !== 'resolved') || null

  const bumpAlert = (alert, reporter, category, now) => {
    alert.lastAt = now
    alert.categories[category] = (alert.categories[category] || 0) + 1
    let set = alertSets.get(alert.id)
    if (!set) { set = new Set(); alertSets.set(alert.id, set) }
    if (set.size < REPORTER_SET_CAP) {
      const before = set.size
      set.add(reporter)
      if (set.size !== before) alert.reporters = Math.max(alert.reporters || 0, set.size)
    } else {
      alert.reportersCapped = true // count is a documented LOWER BOUND past the cap
    }
  }

  return {
    enabled: true,
    categories: REPORT_CATEGORIES,
    dir,

    // The one identity reduction. userId/deviceId are arguments only — they are
    // never stored on this object, logged, or returned.
    pseudonym (userId, deviceId) {
      if (typeof userId !== 'string' || typeof deviceId !== 'string') return null
      return createHmac('sha256', salt).update(userId + '|' + deviceId).digest('hex').slice(0, 16)
    },

    // Ingest one report. `reporter` MUST already be a pseudonym (the responder
    // derives it); everything else is attacker-controlled and normalized here.
    // Never throws for bad input — returns { ok:false, error } instead.
    ingest (input) {
      const reporter = typeof input === 'object' && input && typeof input.reporter === 'string' && /^[0-9a-f]{6,64}$/i.test(input.reporter)
        ? input.reporter
        : null
      if (!reporter) return { ok: false, error: 'bad-reporter' }
      const body = normalizeReport(input)
      if (body.error) return { ok: false, error: body.error }
      const now = clock()

      // Layer 4 — the global breaker. Shed reports are ACKNOWLEDGED (the viewer
      // must not be told to retry into a fire) but never persisted.
      if (!takeToken(now)) {
        stats.shed++
        const a = body.channel ? activeAlert('ch:' + body.channel) : null
        if (a) { a.shedCount = (a.shedCount || 0) + 1; touchAlerts() }
        return { ok: true, shed: true, cooldown: cooldownSec, category: body.category, channel: body.channel }
      }

      // Correlation windows: the channel rule, plus the panel-wide login rule
      // (a broken login is not a channel problem — nobody can even reach one).
      const key = body.category === 'login' ? 'login' : (body.channel ? 'ch:' + body.channel : null)
      let alert = null
      let opened = null
      if (key) {
        const distinct = touchWindow(key, reporter, now)
        alert = activeAlert(key)
        if (!alert && distinct >= alertCount) {
          // Records already stored for this window count against the storm sample,
          // so a whole storm can never store more than stormSampleSize records.
          const priors = loadRecords().filter((r) => r.at >= now - windowMs && (key === 'login' ? r.category === 'login' : r.channel === body.channel)).length
          alert = {
            id: nowId(),
            key,
            kind: key === 'login' ? 'login' : 'channel',
            channel: key === 'login' ? null : body.channel,
            categories: {},
            reporters: distinct,
            openedAt: now,
            lastAt: now,
            status: 'open',
            shedCount: 0,
            sampled: priors
          }
          alerts.push(alert)
          alertSets.set(alert.id, new Set(windows.get(key).keys()))
          opened = alert
        }
      }

      // Layer 3 — storm collapse. Once the sample is full the hot path does NO
      // file write at all: tally on the in-memory alert, debounced flush.
      if (alert && alert.sampled >= stormSampleSize) {
        bumpAlert(alert, reporter, body.category, now)
        stats.collapsed++
        touchAlerts()
        if (opened && onAlert) { try { onAlert({ ...opened }) } catch {} }
        return { ok: true, collapsed: true, cooldown: cooldownSec, alertId: alert.id, category: body.category, channel: body.channel }
      }

      // Store (or dedupe onto an existing open record).
      const records = loadRecords()
      const dupe = records.find((r) => r.reporter === reporter && r.category === body.category &&
        (r.channel || null) === (body.channel || null) && r.status !== 'resolved' &&
        now - (r.at || 0) <= DEDUPE_WINDOW_MS)
      let id
      if (dupe) {
        dupe.count = (dupe.count || 1) + 1
        dupe.lastAt = now
        // A repeat carries fresher diagnostics — keep the newest, and the newest
        // free text if the viewer typed one this time.
        dupe.peers = body.peers
        dupe.events = body.events
        if (body.text) dupe.text = body.text
        id = dupe.id
      } else {
        id = nowId()
        records.push({
          id,
          at: now,
          lastAt: now,
          count: 1,
          reporter,
          category: body.category,
          text: body.text,
          channel: body.channel,
          appVersion: body.appVersion,
          platform: body.platform,
          peers: body.peers,
          events: body.events,
          status: 'new',
          ackAt: null,
          resolvedAt: null,
          note: null
        })
      }
      saveRecords(records)
      stats.ingested++

      if (alert) { alert.sampled = (alert.sampled || 0) + 1; bumpAlert(alert, reporter, body.category, now); touchAlerts() }
      if (opened && onAlert) { try { onAlert({ ...opened }) } catch {} }

      return { ok: true, id, count: dupe ? dupe.count : 1, alertId: alert ? alert.id : null, category: body.category, channel: body.channel }
    },

    // ---- read + lifecycle (the admin API/CLI in S50b sit on exactly these) ----
    list ({ status, channel, category, since, limit = 200 } = {}) {
      let out = loadRecords()
      if (status) out = out.filter((r) => r.status === status)
      if (channel) out = out.filter((r) => r.channel === channel)
      if (category) out = out.filter((r) => r.category === category)
      if (Number.isFinite(since)) out = out.filter((r) => (r.lastAt || r.at) >= since)
      out.sort((a, b) => (b.lastAt || b.at) - (a.lastAt || a.at))
      const n = Math.max(1, Math.min(Number.isFinite(+limit) ? Math.floor(+limit) : 200, 1000))
      return out.slice(0, n)
    },

    get (id) { return loadRecords().find((r) => r.id === id) || null },

    ack (id) {
      const records = loadRecords()
      const r = records.find((x) => x.id === id)
      if (!r) return { ok: false, error: 'not-found' }
      r.status = 'ack'; r.ackAt = clock()
      saveRecords(records)
      return { ok: true, report: r }
    },

    resolve (id, note) {
      const records = loadRecords()
      const r = records.find((x) => x.id === id)
      if (!r) return { ok: false, error: 'not-found' }
      r.status = 'resolved'; r.resolvedAt = clock(); r.note = clean(note, MAX_NOTE)
      saveRecords(records)
      return { ok: true, report: r }
    },

    listAlerts ({ status } = {}) {
      const out = alerts.filter((a) => !status || a.status === status)
      return out.slice().sort((a, b) => (b.lastAt || b.openedAt) - (a.lastAt || a.openedAt)).map((a) => ({ ...a }))
    },

    ackAlert (id) {
      const a = alerts.find((x) => x.id === id)
      if (!a) return { ok: false, error: 'not-found' }
      a.status = 'ack'; a.ackAt = clock(); touchAlerts({ now: true })
      return { ok: true, alert: { ...a } }
    },

    resolveAlert (id) {
      const a = alerts.find((x) => x.id === id)
      if (!a) return { ok: false, error: 'not-found' }
      a.status = 'resolved'; a.resolvedAt = clock(); alertSets.delete(a.id); touchAlerts({ now: true })
      return { ok: true, alert: { ...a } }
    },

    // Badge + chart source. Counts only — no reporter ids leave this method.
    summary ({ hours = 24 } = {}) {
      const records = loadRecords()
      const now = clock()
      const byChannel = {}
      const byCategory = {}
      const buckets = new Array(Math.max(1, Math.min(hours, 168))).fill(0)
      let fresh = 0; let acked = 0; let resolved = 0
      for (const r of records) {
        if (r.status === 'ack') acked++
        else if (r.status === 'resolved') resolved++
        else fresh++
        const ch = r.channel || '(none)'
        byChannel[ch] = (byChannel[ch] || 0) + 1
        byCategory[r.category] = (byCategory[r.category] || 0) + 1
        const age = now - (r.lastAt || r.at)
        const slot = buckets.length - 1 - Math.floor(age / 3600000)
        if (slot >= 0 && slot < buckets.length) buckets[slot] += r.count || 1
      }
      return {
        enabled: true,
        retentionDays,
        total: records.length,
        new: fresh,
        ack: acked,
        resolved,
        openAlerts: alerts.filter((a) => a.status === 'open').length,
        shed: stats.shed,
        collapsed: stats.collapsed,
        byChannel,
        byCategory,
        byHour: buckets
      }
    },

    stats () { return { ...stats } },

    close () { flushAlerts() }
  }
}
