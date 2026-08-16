// The hole-punch capability verdict, made readable on an ORDINARY build — the PURE half
// (no IPC, no console, no engine), so the one rule that matters is testable off a
// television (tools/reclaim-log-test.mjs), like catalog-cache.mjs and signin-vault.mjs
// before it. backend.mjs owns the ticker and the print; this file owns WHAT to print and
// WHEN it is worth printing.
//
// WHAT THE VERDICT IS. Once per drive handler, sdk/serve.js probes whether this
// filesystem actually frees allocated bytes when a hole is punched in a storage file
// (probeHolePunch). The viewer's whole disk story hangs off the answer:
//
//   proved it CAN punch     the blob byte budget latches OFF for the life of the handler;
//                           clear() below the live window is what bounds the replica.
//   proved it CANNOT        the platform the budget exists for — a 32-bit ABI ships
//                           without fs-native-extensions, clear() frees zero, and the
//                           budget plus rotation is all that stands between the device
//                           and a replica growing at ~1x bitrate for the whole session.
//   could not tell          the budget stays armed (fail-active) and the probe is RETRIED
//                           on a later reclaim tick, up to PROBE_MAX_TRIES.
//
// WHY THIS FILE EXISTS. The verdict was computed and never observable. handler.reclaimStatus()
// has always exposed it and nothing in the app ever called it, so reading canPunch/freed/
// reason on a real device took a one-off diagnostics build that logged every reclaim pass
// (the "1.0.2-fsext-dbg6" APK) — instrumentation that never lived in the repo and had to be
// rebuilt from memory the next time the question came up. One line in logcat replaces it.
//
// ⚠ WHY THIS DEDUPES ON THE RENDERED LINE rather than firing once. Neither end of the
// verdict is a single event. An INCONCLUSIVE probe (ok: false) is re-run up to
// PROBE_MAX_TRIES, a reclaim tick apart, and the SEQUENCE is the diagnosis — three tries
// that kept timing out say something very different from one that answered. The latches the
// verdict drives flip AFTER it lands, too (budgetActive goes false the moment the punch is
// proved; metaBudgetActive goes false only where the platform cannot report allocated bytes
// at all). Comparing the rendered line catches every one of those transitions and nothing
// else: the caller may tick as often as it likes and the log stays silent in between.
//
// The line count is bounded by construction — at most PROBE_MAX_TRIES verdicts plus a
// handful of one-way latch flips per engine — so this can never become a heartbeat, which
// is the whole reason it is safe to leave on in a shipping build.

// The verdict as one JSON line, or null while there is nothing to say: no handler yet
// (the loopback server builds it), or the probe has not answered (reclaimStatus() reports
// punch: null until a reclaim tick has run, and a reclaim tick needs a feed being served).
//
// Field order is fixed, so two renderings of the same status compare equal as strings.
// Missing numbers stay MISSING rather than being filled in with a null — JSON.stringify
// drops undefined-valued keys, and that absence is load-bearing: `wideFreed` is undefined
// unless the wide (> 4 GiB) stage ran, and next to `freed` its absence is exactly what
// tells the size_t addon class apart from the addon-less one in a log.
export function reclaimVerdictLine (status) {
  if (!status || !status.punch) return null
  const p = status.punch
  return JSON.stringify({
    // ok distinguishes a MEASURED verdict from an inconclusive one; canPunch is only a real
    // answer when ok is true (an inconclusive probe also carries canPunch: false).
    ok: p.ok,
    canPunch: p.canPunch,
    reason: p.reason,
    freed: p.freed,
    wideFreed: p.wideFreed,
    // Probes spent. A measured verdict is never re-run, so tries > 1 alongside ok: false
    // says "this device kept failing to answer" — and tries at PROBE_MAX_TRIES says it has
    // stopped asking and the fail-active budget is now permanent for the session.
    punchTries: status.punchTries,
    // What the verdict actually bought: whether the blob rotation and the metadata
    // rotation are armed on this device right now.
    budgetActive: status.budgetActive,
    metaBudgetActive: status.metaBudgetActive,
    unmeasurable: status.unmeasurable
  })
}

// A latch for the caller: hand it a reclaimStatus() as often as you like and get back a
// line to print only when the verdict CHANGED. One per engine — a service switch builds a
// new engine with a new handler, and that handler's probe starts over from zero.
export function createReclaimVerdictLog () {
  let last = null
  return function note (status) {
    const line = reclaimVerdictLine(status)
    if (line === null || line === last) return null
    last = line
    return line
  }
}
