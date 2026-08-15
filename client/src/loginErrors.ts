// Classification of ONE login failure the two password doors (SplashScreen, LoginScreen)
// must treat specially: a bare 'unknown user'.
//
// Replication gap, not a verdict: for the first moments after the panel socket comes up,
// the local replica of the account DB can still be empty, and the login's local record
// read comes back null — the panel never said this account does not exist. The WHOLE-
// message match is the load-bearing part: 'session failed: unknown user' is the panel's
// authoritative verdict in the keys door (see the classification comment on
// sdk/player.js signInWithKeys) and 'login failed: …' is a panel refusal; neither may
// land here. Canonical reasoning lives in client/backend/signin-vault.mjs
// accountNotReplicatedYet() — duplicated as one line rather than imported because that
// module pulls @aliran/core (native sodium) and has no business in the RN bundle.
//
// And it is a PAID failure, unlike 'not connected to panel': hello + pow + login all
// reached the panel before the local read came back empty, so every retry spends one of
// the panel throttle's LOCKOUT_THRESHOLD (10) logins. Hence its own small budget —
// mirroring the worklet resume path's RESUME_RECORD_TRIES / RESUME_RECORD_STEP_MS — and
// never the free transient ladder, which would burn 8 of the 10 on its own.
export const REPLICATION_GAP_TRIES = 3
export const REPLICATION_GAP_STEP_MS = 3000

export function isReplicationGap (message: string): boolean {
  return message.trim().toLowerCase() === 'unknown user'
}
