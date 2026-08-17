// Fork-surviving range watch over a Hyperbee.
//
// VERBATIM COPY of core/bee-watch.js — keep it in sync (the same arrangement as
// repeater/src/net-tune.js, and for the same reason). The repeater deliberately depends on
// NOTHING from @aliran/core: the whole security story is that this box provably cannot
// decrypt what it serves, and pulling the crypto package in to reach one plumbing helper
// would dilute that. A ~120-line copy is the cheaper trade.
//
// WHY THIS EXISTS
//
// `bee.watch(range)` goes PERMANENTLY DEAF when the underlying hypercore is TRUNCATED, and
// stays deaf until the process restarts. A truncate is what a FORK is, and a fork is what
// panel bee compaction does: the rebuilt core is installed at fork+1 and every replica reorgs
// onto it (docs/kb/panel-bee-compaction.md). For this appliance that means the catalog and
// meta follows both stop after one panel maintenance window: the mirror set freezes at
// whatever the lineup was beforehand and no reconcile is ever scheduled again, silently,
// until someone restarts the process.
//
// WHY THE OBVIOUS READING OF HYPERBEE IS WRONG
//
// hyperbee's Watcher LOOKS fork-aware — `_next()` contains
//
//     if (this.current.core.fork !== this.previous.core.fork) return await this._yield()
//
// so it is widely assumed a fork is simply yielded through. That guard CANNOT FIRE. hypercore
// defines `get fork () { return this.core.tree.fork }` — a LIVE read of the shared core, not a
// value captured when the snapshot was taken. `current` and `previous` are two sessions over
// one core, so after a truncate both report the same NEW fork and the comparison is a number
// against itself.
//
// So the watcher shows one of two faces instead, and which one it shows is a race:
//
//   THROWS  — `SNAPSHOT_NOT_AVAILABLE`. A truncate pulls a snapshot's `compatLength` back to
//             the truncation point, and hypercore refuses to read a snapshot past it. The
//             watcher is holding exactly such a snapshot in `current`/`previous`.
//   PARKS   — silently, forever. `_waitForChanges()` returns only once `current.version <
//             bee.version`, and `current` is a snapshot of the OLD, LONG log. A rebuild makes
//             the log SHORTER, so `bee.version` does not pass that mark again until the fresh
//             log has been re-grown past the OLD length. In production that is ~70,137 blocks
//             against a rebuilt core of ~2,731 — i.e. "until the process is restarted".
//
// This is why the `while (!this._closed)` re-arm loop this file replaces was NOT a fix. It
// repairs the throwing face only. The parking face never leaves the `for await`, so the
// wrapper never gets to run again.
//
// THE FIX: RE-ARM ON THE CORE'S `truncate` EVENT
//
// The core announces the truncate; the watcher built on top of it cannot. So listen there and
// build a new watcher. Two details make it clean rather than merely effective:
//
//   * The listener runs SYNCHRONOUSLY in the same emit as hyperbee's own handler (hyperbee
//     registers `core.on('truncate')` when the bee is constructed, so its handler is first and
//     this one second), and `close()` sets the Watcher's `closing` synchronously. hyperbee's
//     Watcher unparks on a MICROTASK, after both handlers have run, sees `closing`, and returns
//     `{ done: true }`. The iterator therefore ENDS rather than throwing — which is why this
//     silences the SNAPSHOT_NOT_AVAILABLE face too instead of just recovering from it.
//   * A re-arm RESYNCS. A new watcher's baseline snapshot is taken when it is armed, so
//     anything that landed between the truncate and the re-arm is already "current" to it and
//     would never be reported. So the change callback is called once per re-arm, AFTER the new
//     watcher is armed — that order is what leaves no window, since an append during the
//     catch-up is still caught by the watcher that is already listening.
//
// The first arm does not resync unless `catchUp` is set, and the resync callback is separable
// from the tick callback (`onResync`). Neither is used here: both repeater follows just mark
// the reconcile dirty, and _scheduleReconcile is already the single-flight machinery that
// collapses a burst into one pass.
//
// The error path keeps the re-arm loop this appliance already had (a bee hiccup must not end
// its ability to follow), with a backoff so a permanently unhappy bee cannot spin. A fork skips
// the backoff — a reorg is exactly the moment to be fast.

const DEFAULT_RETRY_MS = 5000

// unref'd: a retry timer must never be the reason a process refuses to exit.
function defaultSleep (ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (t && typeof t.unref === 'function') t.unref()
  })
}

// Watch `range` on `bee`, calling `onChange()` per change, across truncates and errors.
//
//   onChange   — awaited. Called per watcher tick. Must be idempotent: every caller here is a
//                "re-read and re-emit" sweep, which is what makes an extra call free.
//   onResync   — awaited. Called once per RE-arm, after the new watcher is armed. Defaults to
//                onChange; pass it only where the catch-up must differ from a tick.
//   catchUp    — also resync after the FIRST arm. Arming first and catching up second is the
//                order that leaves no blind window behind the arm.
//   shouldStop — extra stop predicate, for callers with their own lifecycle flag
//                (`this._closed`). Checked alongside the handle's own closed state.
//   onError    — the WATCH itself threw and has been re-armed past. A log line, not a failure.
//                Note that closing the watcher on truncate does not eliminate this: a read
//                already in flight when the truncate lands still throws SNAPSHOT_NOT_AVAILABLE
//                on its way out, and that throw is the recovery working, not a fault.
//   onChangeError — onChange/onResync threw. Defaults to onError. This one IS the caller's own
//                work failing, so it keeps whatever meaning the caller gave it; the watch
//                carries on regardless, since one failed sweep must not end live delivery.
//   retryMs    — backoff before re-arming after a WATCH error. A fork ignores it.
//   sleep      — injectable backoff, so a component with a wake-on-shutdown sleeper
//                (repeater's `_sleep`) does not sit out its own teardown.
//
// Returns a handle with close()/destroy() — the same pair hyperbee's own Watcher exposes, so
// it drops into existing teardown paths unchanged. close() is idempotent and does NOT await an
// in-flight onChange, matching what closing the raw Watcher did before this helper existed.
export function watchRange (bee, range, onChange, opts = {}) {
  const retryMs = opts.retryMs === undefined ? DEFAULT_RETRY_MS : opts.retryMs
  const shouldStop = opts.shouldStop || null
  const onError = opts.onError || null
  const onChangeError = opts.onChangeError || onError
  const onResync = opts.onResync || onChange
  const sleep = opts.sleep || defaultSleep
  const core = bee.core

  let closed = false
  let closing = null
  let watcher = null // the hyperbee Watcher currently being iterated
  let forked = false // a truncate landed: re-arm at once (no backoff) and resync
  let resync = opts.catchUp === true // resync after the arm below (see catchUp)
  let wake = null // resolves an in-flight backoff early

  // bee.closed is the one stop condition the CALLER cannot express: a bee closed underneath
  // the watch (shutdown, a replica purge) would otherwise fail every arm and re-arm forever.
  const stopped = () => closed || bee.closed === true || (shouldStop !== null && shouldStop() === true)
  // FORK FALLOUT IS NOT AN ERROR. A reorg rejects every read that was in flight when it
  // landed — hypercore's Replicator.ontruncate fails them with SNAPSHOT_NOT_AVAILABLE — so an
  // onChange that was midway through a bee.get across the truncate throws through no fault of
  // its own. `forked` is true from the truncate until the re-arm that follows it, which is
  // exactly the window in which that is the only thing an error can mean, and the resync at
  // the end of it re-runs the work anyway. Reporting inside it would hand the host an error
  // for a maintenance window it is meant not to notice.
  const quiet = () => closed || forked
  const report = (err) => { if (!quiet() && onError !== null) { try { onError(err) } catch {} } }
  const reportChange = (err) => { if (!quiet() && onChangeError !== null) { try { onChangeError(err) } catch {} } }
  const wakeUp = () => { const w = wake; wake = null; if (w) w() }

  // A FORK MUST NOT HAVE TO WAIT FOR onChange. The loop can only re-arm once the callback it
  // is awaiting returns, and these callbacks read the bee — sdk/player.js `_refreshEntitlements`
  // does an UNBOUNDED bee.get. A get for a block the rebuilt log will never contain can park
  // forever, and a re-arm parked behind it is the same permanent deafness this whole module
  // exists to prevent, just one layer up. So a truncate resolves this signal and the loop stops
  // waiting: the orphaned call is left to settle on its own (it can no longer report anything —
  // see quiet()), and the resync after the re-arm redoes its work from scratch.
  let forkWait = null
  let signalFork = null
  const armForkSignal = () => { forkWait = new Promise((resolve) => { signalFork = resolve }) }
  armForkSignal()
  const runChange = async (fn) => {
    let abandoned = false // the fork got here first; whatever this call throws is its wreckage
    // Never rejects, so losing the race below cannot leave an unhandled rejection behind —
    // which in the Bare worklet is not a warning but the process dying (the S22 crash class).
    const work = (async () => { try { await fn() } catch (err) { if (!abandoned) reportChange(err) } })()
    await Promise.race([work, forkWait.then(() => { abandoned = true })])
  }

  const onTruncate = () => {
    forked = true
    resync = true
    if (signalFork !== null) { const f = signalFork; signalFork = null; f() }
    const w = watcher; watcher = null
    if (w) w.close().catch(() => {}) // unparks the `for await` into { done: true } — see the header
    wakeUp()
  }
  const listening = core && typeof core.on === 'function'
  if (listening) core.on('truncate', onTruncate)
  const unlisten = () => { if (listening) { try { core.off('truncate', onTruncate) } catch {} } }

  const backoff = async (ms) => {
    if (ms <= 0 || forked || stopped()) return
    await new Promise((resolve) => {
      let done = false
      const fire = () => { if (done) return; done = true; wake = null; resolve() }
      wake = fire
      Promise.resolve(sleep(ms)).then(fire, fire)
    })
  }

  const loop = async () => {
    try {
      while (!stopped()) {
        forked = false // consumed by the backoff at the bottom; cleared here so a truncate
        armForkSignal() // landing between this point and the arm below is never lost
        let w = null
        try {
          w = bee.watch(range)
        } catch (err) {
          report(err)
          await backoff(retryMs)
          continue
        }
        watcher = w
        // AFTER the arm, never before: an append during the catch-up is then still caught by
        // the watcher that is already listening, so the two cannot straddle a change.
        if (resync) {
          resync = false
          await runChange(onResync)
        }
        let failed = null
        try {
          for await (const _ of w) { // eslint-disable-line no-unused-vars
            if (stopped() || watcher !== w) break
            // Caught HERE, so one failed sweep costs one tick rather than the whole watch —
            // and so onError below can mean "the watch broke" and nothing else.
            await runChange(onChange)
          }
        } catch (err) { failed = err }
        if (watcher === w) watcher = null
        try { await w.close() } catch {}
        if (stopped()) break
        if (failed !== null) report(failed)
        resync = true // EVERY re-arm catches up: the next watcher's baseline snapshot is taken
        await backoff(retryMs) // when it is armed, so whatever landed in between is invisible to it
      }
    } finally {
      unlisten()
      const w = watcher; watcher = null
      if (w) { try { await w.close() } catch {} }
    }
  }

  const close = () => {
    if (closing !== null) return closing
    closed = true
    unlisten()
    wakeUp()
    // Same reason as the truncate path: a loop parked behind a hung onChange must still be
    // able to reach its exit, or teardown leaves it holding the bee forever.
    if (signalFork !== null) { const f = signalFork; signalFork = null; f() }
    const w = watcher; watcher = null
    closing = w ? Promise.resolve(w.close()).catch(() => {}) : Promise.resolve()
    return closing
  }

  loop().catch(() => {}) // the loop swallows its own failures; this is the belt for a bug in it

  return { close, destroy: close }
}
