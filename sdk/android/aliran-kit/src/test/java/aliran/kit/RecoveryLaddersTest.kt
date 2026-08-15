// The give-up contracts — the JVM mirror of the RN test lanes in
// client/__tests__/AliranVideoTune.test.tsx (the stall/error give-up lanes and the
// offline watchdog lanes). Four properties per ladder, pinned the same way there:
// the waits double, the attempts are capped with a friendly give-up, a spent ladder
// goes quiet, and only real playback — never a rebuild — buys attempts back. Plus
// the shared rule every give-up obeys: BOTH ladders spend together, so no lane can
// resurrect the tune over the host's error UI. AliranPlayerView is a thin adapter
// over this machine (it cannot run on the plain JVM), so these lanes are where the
// contracts live.
package aliran.kit

import aliran.kit.RecoveryLadders.ErrorAction
import aliran.kit.RecoveryLadders.StallAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecoveryLaddersTest {
    private var now = 0L
    private val ladders = RecoveryLadders { now }

    /** Advance the clock in the view's 1 s ticks, collecting stall actions. */
    private fun stallTicksOver(ms: Long): List<StallAction> {
        val out = ArrayList<StallAction>()
        repeat((ms / 1000).toInt()) {
            now += 1000
            out.add(ladders.onStallTick(12_000))
        }
        return out
    }

    private fun offlineTick(
        tuning: Boolean = true, vod: Boolean = false, paused: Boolean = false,
        autoPlay: Boolean = true, live: Boolean, cdn: Boolean
    ) = ladders.onOfflineTick(tuning, vod, paused, autoPlay, live, cdn)

    // ---- the error retry ladder (RN ERROR_GIVE_UP) ----

    @Test fun `error ladder backs off 2500 5000 10000 and the fourth gives up`() {
        assertEquals(ErrorAction.Retry(2_500L), ladders.onPlayerError()); ladders.retryFired()
        assertEquals(ErrorAction.Retry(5_000L), ladders.onPlayerError()); ladders.retryFired()
        assertEquals(ErrorAction.Retry(10_000L), ladders.onPlayerError()); ladders.retryFired()
        // The 4th consecutive error is the give-up — and on a p2p/localhost source it
        // is the player breaking, not the channel refusing: not offline.
        assertEquals(ErrorAction.GiveUp(offline = false), ladders.onPlayerError())
    }

    @Test fun `spent means spent - a rebuild buys nothing, real playback re-arms at the fast rung`() {
        repeat(3) { ladders.onPlayerError(); ladders.retryFired() }
        ladders.spend() // the view's giveUp() on the 4th error
        repeat(5) { assertEquals(ErrorAction.Ignore, ladders.onPlayerError()) }
        // A rebuild alone (feed rotation, port handoff) must not re-arm the ladder —
        // or a host that keeps the view attached would loop at the give-up boundary.
        ladders.rebuilt()
        assertEquals(ErrorAction.Ignore, ladders.onPlayerError())
        // …and REAL PLAYBACK is what re-arms it, at the fast 2.5 s first rung.
        ladders.playing()
        assertEquals(ErrorAction.Retry(2_500L), ladders.onPlayerError())
    }

    @Test fun `real playback between errors keeps the retry at the fast first rung`() {
        assertEquals(ErrorAction.Retry(2_500L), ladders.onPlayerError()); ladders.retryFired()
        // The retry mount PLAYS: the next error is a fresh transient, not consecutive
        // failure #2 — an unreset ladder would wait 5 s here (and every channel would
        // creep toward the give-up over a long session).
        ladders.playing()
        assertEquals(ErrorAction.Retry(2_500L), ladders.onPlayerError())
    }

    @Test fun `cdn 404 - the second consecutive permanent refusal gives up immediately`() {
        // Refusal 1 gets the one retry the playlist-rotation edge earns…
        assertEquals(ErrorAction.Retry(2_500L), ladders.onPlayerError(gone = true, cdn = true))
        ladders.retryFired()
        // …refusal 2 is the provider saying no — give up NOW (~5 s in), not at ~27 s,
        // and it is the CHANNEL's fault: offline.
        assertEquals(ErrorAction.GiveUp(offline = true), ladders.onPlayerError(gone = true, cdn = true))
    }

    @Test fun `cdn 403 pair is a token-rotation suspect - the third consecutive refusal gives up, not the second`() {
        // Event playlists rotate tokens and a rotation window can straddle two
        // attempts — a healthy event channel must not be declared offline by its own
        // token churn.
        assertEquals(ErrorAction.Retry(2_500L), ladders.onPlayerError(refused = true, cdn = true)); ladders.retryFired()
        assertEquals(ErrorAction.Retry(5_000L), ladders.onPlayerError(refused = true, cdn = true)); ladders.retryFired()
        assertEquals(ErrorAction.GiveUp(offline = true), ladders.onPlayerError(refused = true, cdn = true))
    }

    @Test fun `p2p refusals never shortcut - a loopback 404 is the routine transient the fast retry exists for`() {
        assertEquals(ErrorAction.Retry(2_500L), ladders.onPlayerError(gone = true)); ladders.retryFired()
        assertEquals(ErrorAction.Retry(5_000L), ladders.onPlayerError(gone = true)); ladders.retryFired()
        assertEquals(ErrorAction.Retry(10_000L), ladders.onPlayerError(gone = true))
    }

    // ---- the stall ladder (RN STALL_GIVE_UP) ----

    @Test fun `stall ladder - windows double, rungs 2 and 3 reconnect, the fourth gives up, playback re-arms`() {
        ladders.playing()
        // Rung 1 at 12 s — a plain rebuild, no transport teardown.
        assertTrue(stallTicksOver(11_000).all { it == StallAction.None })
        assertEquals(StallAction.Resync(reconnect = false), stallTicksOver(1_000).last())
        // Rung 2 only after ANOTHER 24 s (a flat ladder would fire at +12 s), and the
        // rebuild didn't help — escalate to the wedged-transport teardown.
        assertTrue(stallTicksOver(23_000).all { it == StallAction.None })
        assertEquals(StallAction.Resync(reconnect = true), stallTicksOver(1_000).last())
        // Rung 3 after another 48 s.
        assertTrue(stallTicksOver(47_000).all { it == StallAction.None })
        assertEquals(StallAction.Resync(reconnect = true), stallTicksOver(1_000).last())
        // The 4th rung GIVES UP instead of resyncing again (t = 180 s, matching the
        // RN lane: 12+24+48+96).
        assertTrue(stallTicksOver(95_000).all { it == StallAction.None })
        assertEquals(StallAction.GiveUp, stallTicksOver(1_000).last())
        ladders.spend() // the view's giveUp()
        // SPENT MEANS SPENT: ten minutes with the playhead still buys nothing.
        assertTrue(stallTicksOver(600_000).all { it == StallAction.None })
        // …and real playback re-arms it: a fresh freeze earns a fresh first rung at
        // the full 12 s.
        ladders.playing()
        assertEquals(StallAction.Resync(reconnect = false), stallTicksOver(12_000).last())
    }

    @Test fun `a mount that never played earns no resync - the tune phase owns recovery`() {
        assertTrue(stallTicksOver(600_000).all { it == StallAction.None })
    }

    @Test fun `a rebuild disarms the stall watchdog until the fresh mount plays`() {
        ladders.playing()
        stallTicksOver(6_000)
        ladders.rebuilt() // e.g. a feed rotation mid-freeze
        assertTrue(stallTicksOver(60_000).all { it == StallAction.None })
    }

    @Test fun `parking the stall clock (vod or paused) never bills the ladder`() {
        ladders.playing()
        repeat(60) { now += 1000; ladders.parkStall() } // the view parks instead of ticking
        assertTrue(stallTicksOver(11_000).all { it == StallAction.None }) // the full window remains
    }

    // ---- every give-up spends BOTH ladders ----

    @Test fun `a give-up mid stall ladder spends both lanes - no resurrection over the error UI`() {
        ladders.playing()
        stallTicksOver(12_000) // rung 1 spent…
        stallTicksOver(24_000) // …rung 2 spent, resyncs = 2
        // The offline watchdog (or the error ladder) gives up here — the view's
        // giveUp() spends BOTH lanes, exactly like the RN giveUp() helper.
        ladders.spend()
        assertTrue(stallTicksOver(600_000).all { it == StallAction.None }) // no fresh pill over the error UI
        assertEquals(ErrorAction.Ignore, ladders.onPlayerError()) // and no retry rebuilds behind it
    }

    // ---- the offline watchdog (RN NO_ANSWER / CDN_TUNE) ----

    @Test fun `a confirmed cdn source with no playback trips at 30 s, not 29`() {
        ladders.phaseAdvanced()
        now += 29_000 // a slow link must not false-trip
        assertFalse(offlineTick(live = true, cdn = true))
        now += 1_000
        assertTrue(offlineTick(live = true, cdn = true))
    }

    @Test fun `a play the engine never answers trips at 15 s, not 14`() {
        ladders.phaseAdvanced()
        now += 14_000 // a slow resolve is still allowed to land
        assertFalse(offlineTick(live = false, cdn = false))
        now += 1_000
        assertTrue(offlineTick(live = false, cdn = false))
    }

    @Test fun `NO_ANSWER fires through leftover playback from the outzapped channel`() {
        // After a zap the OLD channel keeps playing under the shared URL — its motion
        // latches `played`, and that must not shield the new tune from its bound.
        ladders.playing()
        ladders.phaseAdvanced()
        now += 15_000
        assertTrue(offlineTick(live = false, cdn = false))
    }

    @Test fun `autoPlay false sent no play and earns no NO_ANSWER verdict`() {
        now += 600_000
        assertFalse(offlineTick(autoPlay = false, live = false, cdn = false))
    }

    @Test fun `paused or vod tunes are parked, not billed - and an ended tune is nobody's to bill`() {
        now += 600_000
        assertFalse(offlineTick(paused = true, live = true, cdn = true))
        assertFalse(offlineTick(vod = true, live = true, cdn = true))
        assertFalse(offlineTick(tuning = false, live = true, cdn = true))
    }

    @Test fun `a p2p tune never trips it - the engine's tune watchdog owns that class`() {
        ladders.phaseAdvanced()
        now += 120_000
        assertFalse(offlineTick(live = true, cdn = false))
    }

    @Test fun `playback gates CDN_TUNE - a cdn stream that played and then froze belongs to the stall ladder`() {
        ladders.phaseAdvanced()
        ladders.playing()
        now += 120_000
        assertFalse(offlineTick(live = true, cdn = true))
    }

    @Test fun `a tune phase advance restarts the offline clock - no phase inherits spent time`() {
        now += 20_000 // time the previous phase already spent
        ladders.phaseAdvanced() // port confirm / self-heal re-arm / stall resync
        now += 29_000 // would already be past 30 s on an inherited clock
        assertFalse(offlineTick(live = true, cdn = true))
        now += 1_000
        assertTrue(offlineTick(live = true, cdn = true))
    }
}
