// In-memory activity ring for the panel: the last N noteworthy events (viewer
// sessions, broadcaster registrations, admin mutations), surfaced by
// GET /api/observability. Deliberately ephemeral — it lives in the process and a
// restart clears it; the signed DB remains the only durable record.

export function makeRing (capacity = 200) {
  const events = []
  return {
    record (type, fields = {}) {
      events.push({ t: Date.now(), type, ...fields })
      if (events.length > capacity) events.shift()
    },
    list () {
      return events.slice().reverse() // newest first
    }
  }
}
