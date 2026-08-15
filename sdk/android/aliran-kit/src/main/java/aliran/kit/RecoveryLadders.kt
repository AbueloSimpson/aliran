// RecoveryLadders — the bounded self-heal ladders + offline watchdog behind
// AliranPlayerView, kept plain-Kotlin (no Android imports) so the give-up contracts
// run as JVM unit tests in this module's style. The RN component is the reference
// (sdk/react-native/src/AliranVideo.tsx — its ERROR_GIVE_UP / STALL_GIVE_UP /
// NO_ANSWER / CDN_TUNE constants carry the full incident notes); the short form:
//
//  - ERROR ladder: a hard player error earns a rebuild, but each CONSECUTIVE failure
//    doubles the wait (2.5 s -> 5 s -> 10 s) and the FOURTH gives up with a friendly
//    error instead. Unbounded, this loop was the SIGABRT recipe (TCL Android 14,
//    2026-08-14: serial ExoPlayer/MediaCodec teardown/rebuild cycles until ART
//    aborted the process) — and nothing else bounds it: a redirect channel has no
//    feed for the engine's tune watchdog to fail on (player.js clears the tune timer
//    on the redirect branch), and a dead loopback server cannot report anything at
//    all. A permanent HTTP refusal on a cdn source shortens the ladder: 404/410/451
//    earn ONE retry (a single miss can be a playlist-rotation edge), 401/403 earn
//    TWO (event playlists rotate tokens; a rotation window can straddle two
//    attempts — a healthy event channel must not be declared offline by its own
//    token churn).
//  - STALL ladder: the same defect class on a slower clock — each resync that fails
//    to restore playback doubles the next window (12 s -> 24 s -> 48 s), rungs >= 2
//    add the transport teardown, and the fourth gives up (12+24+48+96 ~= 3 min).
//  - OFFLINE watchdog: wall-clock bounds for the classes NEITHER ladder can see (no
//    player error, no engine watchdog): a play() the engine never answered
//    (NO_ANSWER, 15 s — resolve is a bounded local catalog read, so 15 s means the
//    worklet is gone, not slow) and a confirmed cdn source that never produced a
//    first frame (CDN_TUNE, 30 s — just past the error ladder's ~27 s give-up, so
//    whichever signal arrives first ends the tune). Never armed for p2p (the
//    engine's tune watchdog owns that class) and never for vod. The clock restarts
//    on every tune phase advance (phaseAdvanced) so no phase inherits time another
//    phase already spent.
//  - EVERY give-up spends BOTH ladders (spend()) — a give-up mid-stall-ladder must
//    not leave the other lane armed to resurrect the tune over the host's error UI.
//    Only real playback (playing()) re-arms a spent ladder; a rebuild alone never
//    does, and a zap / source switch (resetLadders()) starts clean.
package aliran.kit

internal class RecoveryLadders(private val clock: () -> Long = System::currentTimeMillis) {

    companion object {
        const val RETRY_MS = 2_500L
        const val ERROR_GIVE_UP = 4
        const val STALL_GIVE_UP = 4
        const val NO_ANSWER_TIMEOUT_MS = 15_000L
        const val CDN_TUNE_TIMEOUT_MS = 30_000L
    }

    sealed class ErrorAction {
        /** Spent — the error UI is up; only real playback re-arms. */
        object Ignore : ErrorAction()
        /** Rebuild after delayMs; bill the attempt via retryFired() when it happens. */
        data class Retry(val delayMs: Long) : ErrorAction()
        /** Surface the friendly error (offline = the channel's fault, not the player's). */
        data class GiveUp(val offline: Boolean) : ErrorAction()
    }

    sealed class StallAction {
        object None : StallAction()
        /** Rebuild at the live edge; reconnect adds the wedged-transport teardown. */
        data class Resync(val reconnect: Boolean) : StallAction()
        object GiveUp : StallAction()
    }

    private var failures = 0
    private var resyncs = 0
    private var lastAdvanceAt = clock()
    private var tuneStart = clock()

    /** The current mount has produced real motion (arms the stall watchdog, gates
     *  CDN_TUNE). */
    var played = false
        private set

    /** A zap or source switch (streamId/url change): both ladders start clean. A feed
     *  rotation (same url) must NOT pass here — that rebuild neither spends attempts
     *  nor buys any back. */
    fun resetLadders() { failures = 0; resyncs = 0 }

    /** The tune advanced a phase (start, port confirm, source/feed change, self-heal
     *  re-arm, stall resync) — the offline clock restarts. */
    fun phaseAdvanced() { tuneStart = clock() }

    /** A fresh player mount: the stall watchdog disarms until it plays. */
    fun rebuilt() { played = false; lastAdvanceAt = clock() }

    /** Playhead idle by design (vod, paused, ladder disabled) — park the stall clock. */
    fun parkStall() { lastAdvanceAt = clock() }

    /** Real playhead motion — THE re-arm signal: the error ladder resets here (never
     *  on a merely successful mount, because a mount that errors again 5 s later is
     *  the loop, not recovery) and the next stall tick resets the stall ladder. */
    fun playing() {
        played = true
        lastAdvanceAt = clock()
        failures = 0
    }

    /** Every give-up spends BOTH ladders — no lane may resurrect the tune (a fresh
     *  tuning indicator OVER the error UI, then a second friendly error). */
    fun spend() { failures = ERROR_GIVE_UP; resyncs = STALL_GIVE_UP }

    fun onPlayerError(gone: Boolean = false, refused: Boolean = false, cdn: Boolean = false): ErrorAction {
        if (failures >= ERROR_GIVE_UP) return ErrorAction.Ignore
        // The last rung gives up on the ERROR itself — unlike a stall rung, which can
        // only learn it failed by letting the next window expire, an error IS the
        // failure signal, and waiting longer would just hold a spinner over a player
        // that is never rebuilt again. On cdn, a repeated permanent HTTP refusal
        // gives up early (see the header's refusal grades).
        if (failures == ERROR_GIVE_UP - 1 || (cdn && ((gone && failures >= 1) || (refused && failures >= 2)))) {
            return ErrorAction.GiveUp(offline = cdn)
        }
        // The FIRST retry stays fast on purpose — transients are real: right after
        // play() the playlist can 404 while the live edge replicates. Only
        // CONSECUTIVE failures back off.
        return ErrorAction.Retry(RETRY_MS * (1L shl failures))
    }

    /** The scheduled retry actually rebuilt — bill the attempt now, so N error events
     *  that collapse into one pending retry spend one attempt, not N. */
    fun retryFired() { failures++ }

    /** The 1 s stall tick — call only while live playback is expected (not vod, not
     *  paused, ladder enabled); park the clock otherwise. */
    fun onStallTick(stallTimeoutMs: Long): StallAction {
        if (played) resyncs = 0 // motion since the last resync — the ladder resets
        else if (resyncs == 0) return StallAction.None // never played: the tune phase owns recovery
        else if (resyncs >= STALL_GIVE_UP) return StallAction.None // spent: only real playback re-arms
        // Back off: a resync that changed nothing earns the next attempt twice the window.
        if (clock() - lastAdvanceAt < stallTimeoutMs * (1L shl resyncs)) return StallAction.None
        played = false
        lastAdvanceAt = clock()
        resyncs++
        if (resyncs >= STALL_GIVE_UP) return StallAction.GiveUp
        return StallAction.Resync(reconnect = resyncs >= 2)
    }

    /** The 1 s offline tick — true means give up with the offline marker. Runs with
     *  or without a player mounted (NO_ANSWER is exactly the class where none ever
     *  mounts). */
    fun onOfflineTick(tuning: Boolean, vod: Boolean, paused: Boolean, autoPlay: Boolean, live: Boolean, cdn: Boolean): Boolean {
        if (!tuning || vod || paused) return false
        val waited = clock() - tuneStart
        // NO_ANSWER: play() was sent and the engine has not confirmed THIS stream.
        // Deliberately NOT gated on `played` — after a zap the OLD channel keeps
        // playing under the shared URL, and its leftover motion must not shield the
        // new tune from its bound. autoPlay=false sent no play(), so there is
        // nothing to answer yet.
        val noAnswer = autoPlay && !live && waited >= NO_ANSWER_TIMEOUT_MS
        // CDN_TUNE: the engine confirmed a cdn source and the mounted player produced
        // no first frame. p2p is out of scope on both arms — the engine's tune
        // watchdog owns that class, and each of its answers restarts this clock.
        val cdnDead = live && !played && cdn && waited >= CDN_TUNE_TIMEOUT_MS
        return noAnswer || cdnDead
    }
}
