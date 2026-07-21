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
  minChannels = 5, // below this it is ordinary churn, not a fleet event
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
      if (distinct.size < minChannels) {
        open = null // burst died out before reaching the threshold
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
