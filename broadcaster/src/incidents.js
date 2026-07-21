// Incident ring for the broadcaster — the last N noteworthy events, newest first,
// surfaced by GET /api/incidents and the control dashboard's timeline.
//
// WHY THIS EXISTS (2026-07-21). Every ffmpeg respawn was already counted in
// `watchdog.restarts`, but only as a per-channel CUMULATIVE total. On flaky IPTV sources
// that counter climbs constantly (~2.5 per channel per hour, measured over 69 channels),
// so a single restart carries no information at all. When all 69 channels respawned
// together at 05:51Z, nothing anywhere recorded it: each channel simply incremented by
// one, exactly like ordinary churn. The only reason it was noticed is that a 10-minute
// sampler happened to land in the trough — and reconstructing it afterwards needed
// process ages, because the obvious log greps returned nothing.
//
// The lesson shaping this module: the signal is CORRELATION, not count. One channel
// restarting is noise; forty restarting inside two minutes is an outage. So respawns are
// deliberately NOT logged individually — that would just be the same noise with
// timestamps. They are correlated, and a burst becomes ONE incident that is extended
// while it continues.
//
// Deliberately ephemeral, like the panel's activity ring: it lives in the process and a
// restart clears it. Durable history belongs in a metrics system, not here.

export function makeIncidents ({
  capacity = 100,
  windowMs = 120000, // 2 min — the 05:51Z event put 51 of 68 channels inside ~2 min
  // ⚠ THE THRESHOLD MUST SCALE WITH FLEET SIZE, or it cries wolf. Measured baseline:
  // 2085 respawns / 68 channels / 12.1 h = ~2.5 per channel per hour, i.e. ~5.7 restarts
  // across ~5 DISTINCT channels every 2 minutes on a healthy box. A flat "5 channels"
  // trigger therefore sits exactly on the noise floor and fires continuously — useless.
  // A fraction of the RUNNING fleet keeps the signal: 25% of 69 is ~17, far above that
  // ~5 churn floor and far below the 51 actually seen. minChannels is only the floor for
  // small deployments, where 5 of 6 channels really is a fleet event.
  minFraction = 0.25,
  minChannels = 5,
  clock = () => Date.now()
} = {}) {
  const events = []
  let recent = [] // restarts still inside the window: [{ id, t }]
  let open = null // the fleet incident currently being extended

  const push = (e) => {
    events.push(e)
    if (events.length > capacity) events.shift()
    return e
  }

  return {
    // A discrete event that is always worth recording on its own (source failover,
    // a channel giving up, an operator stop). No correlation applied.
    record (type, fields = {}) {
      return push({ t: clock(), type, ...fields })
    },

    // One ffmpeg respawn. Returns the fleet incident if this restart is part of a burst,
    // otherwise null (the common case — a lone flaky source).
    restart (channelId, runningTotal = 0) {
      const now = clock()
      recent = recent.filter((r) => now - r.t < windowMs)
      recent.push({ id: channelId, t: now })
      const distinct = new Set(recent.map((r) => r.id))
      const threshold = Math.max(minChannels, Math.ceil((runningTotal || 0) * minFraction))
      if (distinct.size < threshold) {
        open = null // ordinary churn, or a burst that never reached the bar
        return null
      }
      // Extend the incident already open rather than emitting a new one per restart —
      // otherwise a fleet event floods the ring and evicts its own start.
      if (open && now - open.lastAt < windowMs) {
        open.channels = distinct.size
        open.restarts = recent.length
        open.lastAt = now
        if (runningTotal) open.of = runningTotal
        return open
      }
      open = push({
        t: now,
        type: 'fleet-restart',
        channels: distinct.size,
        restarts: recent.length,
        of: runningTotal,
        firstAt: now,
        lastAt: now
      })
      return open
    },

    list () { return events.slice().reverse() }, // newest first
    _size () { return events.length }
  }
}
