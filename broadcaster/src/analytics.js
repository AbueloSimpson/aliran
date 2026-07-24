// Privacy-preserving broadcaster analytics (S48) — AGGREGATE ONLY, server-side only.
//
// The broadcaster sees only anonymous swarm links: a connection is a Noise keypair,
// not a person, and this module never receives even that — the sampler hands it
// per-channel COUNTS (connection count, byte totals, respawn totals) and nothing
// else. Peer counts are a LOWER BOUND on audience (viewers also serve each other),
// which every surface labels. Per docs/analytics.md.
//
// THE INVARIANT (negative-tested by test:analytics): identity-carrying inputs
// (peer keys, IPs) may exist only in ephemeral in-memory structures; nothing but
// counts and stream ids (public catalog names) is ever written to any analytics
// file, /api/analytics response, or /metrics line.
//
// Storage model — same skeleton as panel/src/analytics.js (the control-auth.js
// self-contained-copy convention: two deployables, no shared runtime module):
// an in-memory current-hour bucket; on hour rollover it reduces into a per-day
// rollup JSON at DATA_DIR/analytics/YYYY-MM-DD.json (UTC; atomic tmp+rename).
// Boot reloads today's file; the in-progress hour is deliberately lost on any
// exit (documented — no partial-hour merge logic to get wrong). Retention prunes
// to `retentionDays`; 0 disables collection entirely (no files, no per-channel
// metrics extension) — one knob, ANALYTICS_RETENTION_DAYS.

import fs from 'fs'
import path from 'path'

const HOUR_MS = 3600000

const dateOf = (t) => new Date(t).toISOString().slice(0, 10) // UTC YYYY-MM-DD
const hourOf = (t) => new Date(t).getUTCHours()

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

// Per-channel egress meter, hooked into the channel's swarm connection handler
// (channel.js). UDX exposes per-connection byte counters (rawStream.bytesTransmitted)
// but they vanish with the connection — so bytes are ACCUMULATED when a connection
// closes, and total() adds the still-live connections on top. The result is a
// monotonic per-run cumulative that the sampler reads; it resets when the channel
// restarts (the analytics delta logic is reset-aware, and Prometheus treats a
// counter reset as normal). Sockets are held only while live — no key material is
// read, stored or exposed; only byte counts leave this closure.
export function makeEgressMeter () {
  let closed = 0
  const live = new Set()
  return {
    onConnection (socket) {
      live.add(socket)
      socket.on('close', () => {
        live.delete(socket)
        closed += (socket.rawStream && socket.rawStream.bytesTransmitted) || 0
      })
    },
    total () {
      let t = closed
      for (const s of live) t += (s.rawStream && s.rawStream.bytesTransmitted) || 0
      return t
    }
  }
}

// Read one analytics sample per running channel off the manager — counts only.
// Shape: [{ id, peers, egressBytes, respawns }] with egressBytes/respawns being
// per-run cumulatives (the tick converts them to deltas, reset-aware).
export function collectChannelSamples (manager) {
  const out = []
  for (const ch of manager.channels.values()) {
    const run = ch.run
    if (!run) continue
    out.push({
      id: ch.meta.id,
      peers: run.swarm ? run.swarm.connections.size : 0,
      egressBytes: run.egress ? run.egress.total() : 0,
      respawns: run.watchdog ? run.watchdog.restarts : 0
    })
  }
  return out
}

export function makeAnalytics ({ dataDir, retentionDays = 90, clock = Date.now } = {}) {
  if (!(retentionDays > 0)) {
    const empty = { enabled: false, retentionDays: 0, days: [], current: null }
    return {
      enabled: false,
      tick () {},
      api () { return { ...empty } },
      metricsSnapshot () { return null },
      close () {}
    }
  }

  const dir = path.join(dataDir, 'analytics')

  let bucket = null // current-hour accumulator
  let today = null // { v, date, hours } — mirrors today's file
  let lastSample = [] // most recent per-channel sample, for /metrics (sync reads)
  let lastCum = new Map() // channel id -> { egressBytes, respawns } for delta math
  let lastIncidentT = clock() // incidents newer than this are counted on the next tick

  const newBucket = (t) => ({
    hourStart: Math.floor(t / HOUR_MS) * HOUR_MS,
    channels: new Map(), // id -> { peers: gauge, egressBytes, respawns }
    incidents: 0
  })

  const filePath = (date) => path.join(dir, date + '.json')
  const readDay = (date) => {
    try { return JSON.parse(fs.readFileSync(filePath(date), 'utf8')) } catch { return null }
  }
  const writeToday = () => {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = filePath(today.date) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(today))
    fs.renameSync(tmp, filePath(today.date))
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

  const reduceBucket = () => {
    const h = String(hourOf(bucket.hourStart))
    const channels = {}
    for (const [id, c] of bucket.channels) {
      channels[id] = { peers: gaugeOut(c.peers), egressBytes: c.egressBytes, respawns: c.respawns }
    }
    const entry = { channels, incidents: bucket.incidents }
    const prev = today.hours[h]
    if (prev) {
      // Same-hour collision (clock skew insurance): sum what sums, re-min/max peers.
      entry.incidents += prev.incidents || 0
      for (const [id, pc] of Object.entries(prev.channels || {})) {
        const c = entry.channels[id]
        if (!c) { entry.channels[id] = pc; continue }
        c.egressBytes += pc.egressBytes || 0
        c.respawns += pc.respawns || 0
      }
    }
    today.hours[h] = entry
    writeToday()
  }

  const roll = () => {
    const now = clock()
    const date = dateOf(now)
    if (!today || today.date !== date) {
      if (today && bucket) reduceBucket()
      today = readDay(date) || { v: 1, date, hours: {} }
      if (today.date !== date) today = { v: 1, date, hours: {} }
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
    today = readDay(dateOf(now)) || { v: 1, date: dateOf(now), hours: {} }
    if (today.date !== dateOf(now)) today = { v: 1, date: dateOf(now), hours: {} }
    bucket = newBucket(now)
    prune()
  }

  const listDates = (n) => {
    const out = []
    const now = clock()
    for (let i = n - 1; i >= 0; i--) out.push(dateOf(now - i * 24 * HOUR_MS))
    return out
  }

  const currentView = () => {
    const channels = {}
    for (const [id, c] of bucket.channels) {
      channels[id] = { peers: gaugeOut(c.peers), egressBytes: c.egressBytes, respawns: c.respawns }
    }
    return { date: today.date, hour: hourOf(bucket.hourStart), channels, incidents: bucket.incidents }
  }

  return {
    enabled: true,

    // 5-minute sampling tick (wired in src/index.js). `samples` comes from
    // collectChannelSamples(); `incidents` is the manager's ring (list() entries
    // carry .t) — new entries since the last tick are counted, never copied.
    tick (samples = [], incidents = null) {
      roll()
      for (const s of samples) {
        let c = bucket.channels.get(s.id)
        if (!c) { c = { peers: gauge(), egressBytes: 0, respawns: 0 }; bucket.channels.set(s.id, c) }
        gaugeAdd(c.peers, s.peers)
        // egress/respawns arrive as per-run cumulatives: delta against the last
        // tick, treating a shrink as a restart (delta = the new cumulative).
        const last = lastCum.get(s.id) || { egressBytes: 0, respawns: 0 }
        c.egressBytes += s.egressBytes >= last.egressBytes ? s.egressBytes - last.egressBytes : s.egressBytes
        c.respawns += s.respawns >= last.respawns ? s.respawns - last.respawns : s.respawns
        lastCum.set(s.id, { egressBytes: s.egressBytes, respawns: s.respawns })
      }
      // Forget channels that stopped sampling so a later restart deltas from zero.
      const seen = new Set(samples.map((s) => s.id))
      for (const id of lastCum.keys()) if (!seen.has(id)) lastCum.delete(id)
      lastSample = samples
      if (incidents) {
        let maxT = lastIncidentT
        for (const ev of incidents.list()) {
          if (ev.t > lastIncidentT) bucket.incidents++
          if (ev.t > maxT) maxT = ev.t
        }
        lastIncidentT = maxT
      }
    },

    // GET /api/analytics?days=N — last N UTC days plus the in-progress hour.
    api (days = 7) {
      roll()
      const n = Math.max(1, Math.min(Number.isFinite(+days) ? Math.floor(+days) : 7, retentionDays))
      const out = []
      for (const date of listDates(n)) {
        const d = date === today.date ? today : readDay(date)
        if (d) out.push(d)
      }
      return { enabled: true, retentionDays, days: out, current: currentView() }
    },

    // Sync in-memory snapshot for /metrics: the most recent per-channel sample.
    metricsSnapshot () {
      return lastSample
    },

    // No flush: the in-progress hour is dropped by design (see the header note).
    close () {}
  }
}
