// Privacy-preserving panel analytics (S48) — AGGREGATE ONLY, server-side only.
//
// The panel cannot see what anyone watches (viewers replicate P2P and never phone
// home), so this module aggregates only what the panel already observes as a side
// effect of serving: login outcomes, sessions issued, how many peers hold the
// catalog connection, and what the catalog is composed of. Per docs/analytics.md.
//
// THE INVARIANT (negative-tested by test:analytics): identity-carrying inputs
// (usernames, hex keys, IPs, device ids) may exist only in ephemeral in-memory
// structures scoped to the current hour/day; they are reduced to COUNTS at rollup
// and the raw value is NEVER written to any analytics file, /api/analytics
// response, or /metrics line. Concretely: the only identity this module ever
// receives is the username handed to sessionIssued(), and the only thing done
// with it is Set.add() on an in-memory day-scoped Set whose .size becomes the
// uniqueViewers count — the Set dies at day rollover (or process exit) and is
// never serialized. loginFailed() deliberately takes NO arguments at all.
//
// Storage model: an in-memory current-hour bucket; on hour rollover the bucket is
// reduced and folded into a per-day rollup JSON at DATA_DIR/analytics/YYYY-MM-DD.json
// (UTC days; atomic tmp+rename write). Boot reloads today's file, so the completed
// hours of the current day survive a restart. The IN-PROGRESS hour is deliberately
// not flushed on shutdown or crash — losing up to one hour of counts is the
// documented trade for never needing merge logic over partial hours. Retention is
// pruned to `retentionDays`; 0 disables collection entirely (no files, no timers,
// endpoints answer {enabled:false}) — one knob, ANALYTICS_RETENTION_DAYS.
//
// Same self-contained-copy convention as broadcaster/src/control-auth.js: the
// broadcaster carries its own analytics.js with the same rollup skeleton but its
// own (per-channel) series — two deployables, no shared runtime module.

import fs from 'fs'
import path from 'path'
import { writeJsonAtomic } from '@aliran/core/atomic-write.js'

const HOUR_MS = 3600000

const dateOf = (t) => new Date(t).toISOString().slice(0, 10) // UTC YYYY-MM-DD
const hourOf = (t) => new Date(t).getUTCHours()

// min/max/sum/samples accumulator for a sampled gauge. mean is derived at read
// time (sum/samples) so partial hours never need weighted-merge logic.
const gauge = () => ({ min: null, max: null, sum: 0, samples: 0 })
const gaugeAdd = (g, v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return
  g.min = g.min === null ? v : Math.min(g.min, v)
  g.max = g.max === null ? v : Math.max(g.max, v)
  g.sum += v
  g.samples++
}
const gaugeOut = (g) => g.samples
  ? { min: g.min, max: g.max, mean: Math.round((g.sum / g.samples) * 10) / 10, samples: g.samples }
  : { min: null, max: null, mean: null, samples: 0 }

export function makeAnalytics ({ dataDir, retentionDays = 90, clock = Date.now } = {}) {
  if (!(retentionDays > 0)) {
    // Kill switch (ANALYTICS_RETENTION_DAYS=0): a complete no-op that never touches
    // disk. Endpoints still answer, honestly, that nothing is collected.
    const empty = { enabled: false, retentionDays: 0, days: [], current: null }
    return {
      enabled: false,
      sessionIssued () {},
      loginFailed () {},
      tick () {},
      setCatalog () {},
      api () { return { ...empty } },
      metricsSnapshot () { return null },
      close () {}
    }
  }

  const dir = path.join(dataDir, 'analytics')

  // Process-lifetime totals for /metrics (Prometheus counters — reset on restart,
  // which scrapers handle as a normal counter reset).
  const totals = { loginsOk: 0, loginsFailed: 0, sessions: 0 }
  let lastCatalog = null // { live, redirect, vod } — set by the slow tick
  let lastOnlineApps = null // last sampled swarm connection count

  // Ephemeral identity reduction: usernames of successfully-proven sessions for the
  // CURRENT UTC day. In memory only; reduced to .size; discarded at day rollover.
  let daySet = new Set()

  let bucket = null // current-hour accumulator
  let today = null // { date, hours: {...}, day: {...} } — mirrors today's file

  const newBucket = (t) => ({
    hourStart: Math.floor(t / HOUR_MS) * HOUR_MS,
    logins: { ok: 0, failed: 0 },
    sessions: 0,
    onlineApps: gauge()
  })

  const filePath = (date) => path.join(dir, date + '.json')

  const readDay = (date) => {
    try { return JSON.parse(fs.readFileSync(filePath(date), 'utf8')) } catch { return null }
  }

  // Atomic write, so a crash mid-write can never truncate a rollup. indent 0 keeps the
  // compact on-disk form; fsync off — a rollup is disposable and this runs on every tick.
  const writeToday = () => {
    writeJsonAtomic(filePath(today.date), today, { indent: 0, fsync: false })
  }

  const prune = () => {
    let names = []
    try { names = fs.readdirSync(dir) } catch { return }
    const cutoff = dateOf(clock() - retentionDays * 24 * HOUR_MS)
    for (const n of names) {
      const m = n.match(/^(\d{4}-\d{2}-\d{2})\.json$/)
      if (m && m[1] < cutoff) { try { fs.unlinkSync(path.join(dir, n)) } catch {} }
    }
  }

  // Reduce the finished bucket into today's rollup and persist. If the same hour
  // key somehow already exists (clock skew), counters are summed — cheap insurance,
  // never a data model the normal path relies on.
  const reduceBucket = () => {
    const h = String(hourOf(bucket.hourStart))
    const entry = {
      logins: { ...bucket.logins },
      sessions: bucket.sessions,
      onlineApps: gaugeOut(bucket.onlineApps),
      ...(lastCatalog ? { catalog: { ...lastCatalog } } : {})
    }
    const prev = today.hours[h]
    if (prev) {
      entry.logins.ok += prev.logins?.ok || 0
      entry.logins.failed += prev.logins?.failed || 0
      entry.sessions += prev.sessions || 0
    }
    today.hours[h] = entry
    // Running unique-viewers count for the day (a COUNT — the Set never leaves
    // memory). max() keeps a restart from shrinking an already-written value.
    today.day.uniqueViewers = Math.max(today.day.uniqueViewers || 0, daySet.size)
    writeToday()
  }

  // Rollover check — cheap (one floor-divide compare), run at the head of every
  // mutator so hour/day boundaries are honored even between ticks.
  const roll = () => {
    const now = clock()
    const date = dateOf(now)
    if (!today || today.date !== date) {
      if (today && bucket) reduceBucket() // close out the old day's last hour
      today = readDay(date) || { v: 1, date, hours: {}, day: {} }
      if (today.date !== date) today = { v: 1, date, hours: {}, day: {} }
      daySet = new Set()
      bucket = newBucket(now)
      prune()
      return
    }
    if (!bucket) { bucket = newBucket(now); return }
    if (Math.floor(now / HOUR_MS) * HOUR_MS !== bucket.hourStart) {
      reduceBucket()
      bucket = newBucket(now)
    }
  }

  // Boot reload: today's completed hours come back; the in-progress hour starts empty.
  {
    const now = clock()
    today = readDay(dateOf(now)) || { v: 1, date: dateOf(now), hours: {}, day: {} }
    if (today.date !== dateOf(now)) today = { v: 1, date: dateOf(now), hours: {}, day: {} }
    bucket = newBucket(now)
    prune()
  }

  const listDates = (n) => {
    const out = []
    const now = clock()
    for (let i = n - 1; i >= 0; i--) out.push(dateOf(now - i * 24 * HOUR_MS))
    return out
  }

  return {
    enabled: true,

    // A verified session proof — the panel's only honest "login ok" moment (the
    // OPRF stage is oblivious by design: a wrong password fails on the CLIENT).
    // The username is reduced to daySet membership and never stored.
    sessionIssued (username) {
      roll()
      bucket.logins.ok++
      bucket.sessions++
      totals.loginsOk++
      totals.sessions++
      if (typeof username === 'string' && username) daySet.add(username)
    },

    // A session proof that failed (unknown user / disabled / bad signature /
    // device-limit). Takes no arguments on purpose — a failed attempt's username
    // is attacker-controlled junk and must never enter any structure at all.
    loginFailed () {
      roll()
      bucket.logins.failed++
      totals.loginsFailed++
    },

    // 5-minute sampling tick (wired in src/index.js). gauges = { onlineApps } —
    // the panel swarm connection count: every open app holds the catalog
    // connection, so this approximates "apps online right now" (it also counts
    // non-viewer peers such as repeaters — documented, and why every surface
    // labels it as approximate).
    tick (gauges = {}) {
      roll()
      if (gauges.onlineApps !== undefined) {
        gaugeAdd(bucket.onlineApps, gauges.onlineApps)
        lastOnlineApps = gauges.onlineApps
      }
    },

    // Slow-tick catalog composition ({ live, redirect, vod } counts) — attached to
    // hour entries at reduce time and exposed on /metrics from memory.
    setCatalog (counts) {
      if (counts && typeof counts === 'object') {
        lastCatalog = {
          live: counts.live || 0,
          redirect: counts.redirect || 0,
          vod: counts.vod || 0
        }
      }
    },

    // GET /api/analytics?days=N — last N UTC days (today inclusive, from memory;
    // earlier days from disk) plus the reduced in-progress hour. Counts only.
    api (days = 7) {
      roll()
      const n = Math.max(1, Math.min(Number.isFinite(+days) ? Math.floor(+days) : 7, retentionDays))
      const out = []
      for (const date of listDates(n)) {
        const d = date === today.date ? today : readDay(date)
        if (d) out.push(d)
      }
      return {
        enabled: true,
        retentionDays,
        days: out,
        current: {
          date: today.date,
          hour: hourOf(bucket.hourStart),
          logins: { ...bucket.logins },
          sessions: bucket.sessions,
          onlineApps: gaugeOut(bucket.onlineApps),
          onlineAppsNow: lastOnlineApps,
          uniqueViewersToday: daySet.size,
          ...(lastCatalog ? { catalog: { ...lastCatalog } } : {})
        }
      }
    },

    // Sync in-memory snapshot for /metrics (the S40 cheap-and-synchronous contract).
    metricsSnapshot () {
      return {
        loginsOk: totals.loginsOk,
        loginsFailed: totals.loginsFailed,
        sessions: totals.sessions,
        onlineApps: lastOnlineApps,
        catalog: lastCatalog
      }
    },

    // No flush: the in-progress hour is dropped by design (see the header note).
    close () {}
  }
}
