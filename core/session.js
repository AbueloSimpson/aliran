// Session liveness against the replicated signed account record.
//
// Promoted here from sdk/login.js in S50a: BOTH sides now need it. The client uses it
// to notice a revoke and drop to login; the panel uses it in the `report` responder to
// refuse a report from a token whose device was revoked, whose tokenVersion was bumped,
// or whose account was disabled. Same predicate, one copy — the sdk re-exports it
// unchanged, so every existing import keeps working.
//
// Pure read: takes any object with an async `get(key)` returning `{ value }` or null
// (a Hyperbee, or the panel's own signed bee), plus a VERIFIED token payload
// (verifyToken() first — this function does no signature checking).
//
// Cooperative session hygiene, not content protection: a hostile client keeps its
// cached token/keys, so access revocation is grant revoke + stream-key rotation.
export async function sessionLive (db, payload, now = Date.now()) {
  if (!payload || !payload.userId || !payload.deviceId) return false
  const node = await db.get('user/' + payload.userId)
  const user = node && node.value
  if (!user) return false
  if (user.status && user.status !== 'active') return false
  if ((user.tokenVersion || 1) !== (payload.tokenVersion || 1)) return false
  const d = (user.devices || []).find((x) => x.deviceId === payload.deviceId)
  if (!d) return false
  if (d.expiresAt && d.expiresAt <= now) return false
  return (d.tokenVersion || 1) === (payload.tokenVersion || 1)
}
