// AliranPlayerView — Media3/ExoPlayer port of the RN SDK's <AliranVideo> playback
// contracts (sdk/react-native/src/AliranVideo.tsx is the reference; the desktop
// player's HlsVideo.tsx proved these contracts port cleanly off React Native):
//
//  - ~1 s start buffer (zap latency) instead of ExoPlayer's ~2.5 s default.
//  - ONE localhost URL serves every P2P channel, so the ENGINE's messages — not raw
//    player events — drive the tune lifecycle: 'start' arms the host's indicator,
//    'retune'/'reconnect' surface the engine's self-heal, 'playing' fires on the
//    first REAL playback of THIS tune (an advancing playhead, or ready-for-display
//    while the engine has confirmed our stream is the one being served).
//  - Rebuild-to-flush: a confirmed channel switch, source flip (fallback /
//    source-changed), feed rotation (feed-changed) or headers rotation (a provider
//    changing only its User-Agent behind a stable url) rebuilds the player, else the
//    OLD channel keeps playing out of the buffer under the same URL.
//  - Frozen-live-edge self-heal: a live HLS window can slide past the playhead with
//    NO error event — once this mount has played, a playhead still for
//    stallTimeoutMs (default 12 s) forces a rebuild at the live edge; if the rebuild
//    itself brings no playback, the engine's peer connection is wedged
//    (transport-alive, replication-dead) and the ladder escalates to
//    backend.reconnect() before further rebuilds. BOUNDED: each failed resync
//    doubles the next window (12/24/48 s) and the fourth gives up with a friendly
//    error (see RecoveryLadders — the unbounded version was the TCL SIGABRT recipe).
//  - Player errors self-retry with a rebuild, BOUNDED the same way on a faster clock:
//    consecutive failures double the wait (2.5/5/10 s) and the fourth surfaces a
//    friendly error — for a redirect/cdn channel NO engine error is ever coming (the
//    engine arms no tune watchdog there: player.js clears the tune timer on the
//    redirect branch), and a dead loopback server cannot report anything at all.
//  - Offline watchdog: wall-clock bounds for the tunes no player event can end — a
//    play() the engine never answers (15 s) and a confirmed cdn source that never
//    produces a first frame (30 s) give up with the offline marker (onOffline).
//  - Redirect channels behind a provider hotlink check: the port reply's headers
//    ride the media open (via the data source factory — ExoPlayer reads them once,
//    at open, which is why a headers change is a rebuild, never a reuse).
//  - VOD (recordType "vod"): the stall ladder DISARMS (a paused/seeking/finished
//    playhead is by design) and the seek transport is enabled. The error ladder
//    stays armed — a hard error is a real failure on any record class.
//  - The engine's friendly {type:'error'} (tune timeout, not entitled, …) still ends
//    the tune whenever it does arrive; every give-up here is for the classes where
//    it never will.
package aliran.kit

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.widget.FrameLayout
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView

enum class TunePhase { START, RETUNE, RECONNECT, PLAYING }

data class TuneEvent(val id: Int, val streamId: String, val phase: TunePhase)

@UnstableApi
class AliranPlayerView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null
) : FrameLayout(context, attrs) {

    /** Tune lifecycle for the host's tuning indicator (see the header). */
    var onTune: ((TuneEvent) -> Unit)? = null
    /** A friendly, viewer-showable failure — the tune ENDS here and your error UI
     *  owns the screen. Four sources: the engine (tune timeout, not entitled, …),
     *  the stall ladder giving up, the error retry ladder giving up, and the offline
     *  watchdog. Every give-up text ends in "switch to it again to retry" because
     *  the retry has to be a re-select that calls attach() again — a spent ladder is
     *  only re-armed by real playback, never by a rebuild, so leaving the view
     *  attached leaves it spent. */
    var onError: ((String) -> Unit)? = null
    /** The give-ups that mean THE CHANNEL ITSELF is not answering (dead redirect
     *  url, permanent HTTP refusal, silent worklet) — the RN binding's
     *  info.code === 'offline'. When set, those failures arrive HERE instead of
     *  onError, so the host can show a "channel offline" screen instead of generic
     *  error prose; unset, they fall through to onError. */
    var onOffline: ((String) -> Unit)? = null
    var onPeers: ((Int) -> Unit)? = null
    var onBuffering: ((Boolean) -> Unit)? = null
    /** A frozen live edge triggered a resync (logging; drive UI off onTune). Fires
     *  once per resync, so it stops after the ladder gives up (onError fires instead). */
    var onStall: (() -> Unit)? = null
    var onSource: ((url: String, source: String) -> Unit)? = null
    /** Playhead freeze tolerance while playing live; 0 disables the ladder. This is
     *  the FIRST rung only: each failed resync doubles the wait, and the whole
     *  ladder ends in a friendly error after 15x this value (12+24+48+96 s at the
     *  default). */
    var stallTimeoutMs: Long = 12_000
    /** Show Media3's transport controller (auto-enabled for vod titles). */
    var useController: Boolean = false
        set(value) { field = value; playerView.useController = value || vod }

    private val playerView = PlayerView(context).apply { useController = false }
    private var backend: AliranBackend? = null
    private var streamId: String? = null
    private var unsubscribe: (() -> Unit)? = null
    private var player: ExoPlayer? = null
    private var url: String? = null
    // Request headers that belong to THIS url (a redirect channel behind a provider's
    // Referer/Origin/User-Agent hotlink check) — without them the provider answers 403.
    private var headers: Map<String, String>? = null
    private var served: String? = null
    private var vod = false
    private var autoPlay = true

    // The in-flight tune: `live` = the engine confirmed the shared URL serves THIS
    // tune's stream; only then can playback complete the tune.
    private var tuneId = 0
    private var tuneStreamId = ""
    private var tuning = false
    private var tuneLive = false

    // The bounded self-heal brain (stall + error ladders, offline watchdog) — the
    // give-up contracts live there, plain-JVM and unit-tested. This view is the thin
    // adapter: it detects motion/errors and executes the machine's decisions.
    private val ladders = RecoveryLadders()
    private var lastPosition = -1L

    private val main = Handler(Looper.getMainLooper())
    private var retry: Runnable? = null

    private val ticker = object : Runnable {
        override fun run() {
            tick()
            main.postDelayed(this, 1_000)
        }
    }

    init {
        addView(playerView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    /**
     * Bind to a backend and tune to a stream (sends play() unless autoPlay=false).
     * Call again with a new streamId to zap — or with the SAME streamId to retry
     * after a give-up error: a (re-)attach is the "switch to it again" the error
     * texts ask for, and it starts both ladders clean. detach() releases everything.
     */
    fun attach(backend: AliranBackend, streamId: String, autoPlay: Boolean = true) {
        detachInternal(releaseView = false)
        this.backend = backend
        this.streamId = streamId
        this.autoPlay = autoPlay
        served = backend.activeStreamId
        vod = backend.activeStreamId == streamId && backend.recordType == "vod"
        playerView.useController = useController || vod

        tuneId++
        tuneStreamId = streamId
        tuning = true
        tuneLive = served == streamId // re-entering on the already-served channel
        ladders.resetLadders()
        ladders.phaseAdvanced()
        onTune?.invoke(TuneEvent(tuneId, streamId, TunePhase.START))

        unsubscribe = backend.onMessage { m -> handleMessage(m) }
        url = backend.url
        headers = backend.headers // re-entry onto an already-resolved redirect channel
        if (autoPlay) backend.play(streamId)
        if (url != null) rebuild()
        main.removeCallbacks(ticker)
        main.postDelayed(ticker, 1_000)
    }

    fun detach() = detachInternal(releaseView = true)

    private fun detachInternal(releaseView: Boolean) {
        unsubscribe?.invoke(); unsubscribe = null
        main.removeCallbacks(ticker)
        cancelRetry()
        if (releaseView) releasePlayer()
    }

    /** Adopt a (possibly) new playback url. A VALUE change resets both give-up
     *  ladders — fresh source, fresh attempts (RN parity: the [streamId, url] reset
     *  effect) — which is also why a feed rotation, same url, resets nothing. */
    private fun adoptUrl(u: String?): Boolean {
        if (u == url) return false
        url = u
        ladders.resetLadders()
        return true
    }

    private fun handleMessage(m: BackendMessage) {
        val b = backend ?: return
        val sid = streamId ?: return
        when (m) {
            is BackendMessage.Port -> {
                if (b.url == null) return
                val replyFor = m.streamId ?: sid // pre-streamId bundles: assume ours
                val changed = replyFor != served
                served = replyFor
                val urlChanged = adoptUrl(b.url)
                b.source?.let { s -> b.url?.let { u -> onSource?.invoke(u, s) } }
                if (replyFor == sid) {
                    // A HEADERS-ONLY change (a provider rotating its User-Agent behind
                    // a stable url) must tear the player down too — the open player is
                    // still sending the old set, and ExoPlayer only reads headers when
                    // it opens the media.
                    val headersChanged = b.headers != headers
                    headers = b.headers
                    tuneLive = true
                    ladders.phaseAdvanced() // confirmed serve: the CDN_TUNE clock starts here
                    if (m.recordType != null) {
                        vod = m.recordType == "vod"
                        playerView.useController = useController || vod
                    }
                    // The engine confirmed OUR stream is behind the shared URL now —
                    // on a switch, rebuild to flush the previous channel's buffer.
                    if (changed || urlChanged || headersChanged || player == null) rebuild()
                }
            }
            is BackendMessage.Fallback -> if (m.streamId == sid) {
                // A different url (the operator's CDN template) — the previous
                // provider's headers do not belong to it.
                adoptUrl(m.url); headers = null
                served = sid; tuneLive = true
                ladders.phaseAdvanced() // fresh source, fresh offline clock
                rebuild()
            }
            is BackendMessage.SourceChanged -> if (m.streamId == sid) {
                adoptUrl(m.url); headers = null // same reason as 'fallback' above
                served = sid; tuneLive = true
                ladders.phaseAdvanced()
                rebuild()
                onSource?.invoke(m.url, m.source)
            }
            is BackendMessage.FeedChanged -> if (m.streamId == sid) {
                // Same localhost URL, new feed behind it — rebuild to flush. Headers
                // are left alone on purpose (P2P-only event, they are already null),
                // and the ladders are too: this rebuild neither spends attempts nor
                // buys any back.
                adoptUrl(m.url); tuneLive = true
                ladders.phaseAdvanced()
                rebuild()
            }
            is BackendMessage.Status -> {
                m.peers?.let { onPeers?.invoke(it) }
                if (m.state == "feed:retune" || m.state == "feed:reconnect") {
                    // Engine self-heal on the active feed: re-arm completion and let
                    // the host say "reconnecting" instead of freezing its indicator.
                    tuning = true
                    ladders.phaseAdvanced() // self-heal re-arm: the offline clock must not bill it
                    onTune?.invoke(TuneEvent(tuneId, tuneStreamId,
                        if (m.state == "feed:retune") TunePhase.RETUNE else TunePhase.RECONNECT))
                }
            }
            is BackendMessage.Error -> {
                tuning = false // the friendly error ENDS the tune — host error UI takes over
                onError?.invoke(m.message)
            }
            else -> {}
        }
    }

    private fun completeTune() {
        if (!tuning || !tuneLive) return
        tuning = false
        onTune?.invoke(TuneEvent(tuneId, tuneStreamId, TunePhase.PLAYING))
    }

    private fun cancelRetry() {
        retry?.let { main.removeCallbacks(it) }
        retry = null
    }

    /** The ONE spent-state for every give-up (error ladder, stall ladder, offline
     *  watchdog): kill any pending retry (no zombie rebuilds behind the error UI),
     *  spend BOTH ladders — a give-up mid-stall-ladder must not leave the other lane
     *  armed to resurrect the tune with a fresh indicator OVER the error UI — end
     *  the tune, tell the host. Only real playback re-arms either ladder; the retry
     *  the error text offers is a host-side re-attach, whose ladders start clean. */
    private fun giveUp(message: String, offline: Boolean) {
        cancelRetry()
        ladders.spend()
        tuning = false
        (if (offline) onOffline ?: onError else onError)?.invoke(message)
    }

    /** Tear down and rebuild the player onto the current URL — the flush primitive
     *  behind channel switches, source flips, feed rotations, headers rotations,
     *  stall resyncs, and error retries. */
    private fun rebuild() {
        val u = url ?: return
        // A pending error retry belongs to the mount being torn down — letting it
        // fire would rebuild the fresh player a second time (and bill the ladder an
        // attempt no error of its own earned).
        cancelRetry()
        releasePlayer()
        // Every rebuild disarms the stall watchdog until the fresh mount plays.
        lastPosition = -1
        ladders.rebuilt()
        val builder = ExoPlayer.Builder(context)
            .setLoadControl(
                DefaultLoadControl.Builder()
                    .setBufferDurationsMs(
                        DefaultLoadControl.DEFAULT_MIN_BUFFER_MS,
                        DefaultLoadControl.DEFAULT_MAX_BUFFER_MS,
                        1_000,  // start at ~1 s buffered: every segment begins on a keyframe
                        1_500   // slightly more headroom after a rebuffer
                    )
                    .build()
            )
        // Provider playback headers (hotlink-checked redirect channels): ExoPlayer
        // takes them at the data source, read once when the media opens — a headers
        // change reaches the wire because it comes through here as a rebuild.
        headers?.let { h ->
            builder.setMediaSourceFactory(
                DefaultMediaSourceFactory(
                    DefaultDataSource.Factory(
                        context, DefaultHttpDataSource.Factory().setDefaultRequestProperties(h)
                    )
                )
            )
        }
        val p = builder.build()
        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (p !== player) return // stale mount
                onBuffering?.invoke(state == Player.STATE_BUFFERING)
                if (state == Player.STATE_READY) completeTune()
            }

            override fun onPlayerError(error: PlaybackException) {
                if (p !== player) return
                // Live P2P: the live edge may still be replicating — quiet retry, on
                // the BOUNDED ladder (see RecoveryLadders). The friendly failure is
                // owned HERE for the classes the engine cannot see: a redirect channel
                // arms no engine tune watchdog (player.js clears the tune timer on the
                // redirect branch), and a dead loopback server reports nothing at all.
                val code = generateSequence<Throwable>(error) { it.cause }
                    .filterIsInstance<HttpDataSource.InvalidResponseCodeException>()
                    .firstOrNull()?.responseCode ?: 0
                when (val a = ladders.onPlayerError(
                    gone = code == 404 || code == 410 || code == 451,
                    refused = code == 401 || code == 403,
                    cdn = backend?.source == "cdn"
                )) {
                    is RecoveryLadders.ErrorAction.Retry -> {
                        onBuffering?.invoke(true)
                        cancelRetry()
                        val r = Runnable { retry = null; ladders.retryFired(); rebuild() }
                        retry = r
                        main.postDelayed(r, a.delayMs)
                    }
                    is RecoveryLadders.ErrorAction.GiveUp -> giveUp(
                        "playback failed: '$tuneStreamId' will not load — the channel may be broken right now, switch to it again to retry",
                        offline = a.offline
                    )
                    RecoveryLadders.ErrorAction.Ignore -> {} // spent: the error UI is up, only real playback re-arms
                }
            }
        })
        // Live offset (RN parity — AliranVideo.tsx BUFFER_CONFIG.live): sit ~10 s
        // behind the edge for churn headroom — the engine replicates the whole live
        // window on-device, so everything between playhead and edge survives an
        // upstream peer loss. Playback still starts thin (the 1 s start buffer
        // above), so zaps stay fast; minOffsetMs lets ExoPlayer trade a little
        // headroom before it stalls. Live-only — a vod MediaItem ignores it.
        val item = MediaItem.Builder()
            .setUri(u)
            .setLiveConfiguration(
                MediaItem.LiveConfiguration.Builder()
                    .setTargetOffsetMs(10_000)
                    .setMinOffsetMs(4_000)
                    .build()
            )
        // Container hint (RN parity — AliranVideo.tsx sourceType(), ported as
        // SourceType.kt): an extension-less redirect url (the Samsung TV Plus KR
        // class, https://jmp2.uk/stvp-<id>) gives ExoPlayer's inference nothing to
        // go on, so it guesses progressive and dies with
        // UnrecognizedInputFormatException even though the wire is fine. Force HLS
        // only then — a self-describing url (.mpd) still opens as itself.
        if (!hasContainerExtension(u)) item.setMimeType(MimeTypes.APPLICATION_M3U8)
        p.setMediaItem(item.build())
        p.playWhenReady = true
        p.prepare()
        player = p
        playerView.player = p
    }

    private fun releasePlayer() {
        playerView.player = null
        player?.release()
        player = null
    }

    /** The 1 s ladder tick: advancing-playhead detection (completes the tune, re-arms
     *  the ladders), the frozen-live-edge escalation, and the offline watchdog —
     *  which runs with or without a player, because a play() the worklet never
     *  answers leaves url null with no player mounted at all. */
    private fun tick() {
        val p = player
        if (p != null) {
            val pos = p.currentPosition
            if (pos != lastPosition && p.isPlaying) {
                lastPosition = pos
                ladders.playing() // real motion — THE re-arm signal for both ladders
                completeTune()
            }
            when {
                stallTimeoutMs <= 0 || vod -> ladders.parkStall() // vod: a still playhead is by design
                !p.playWhenReady -> ladders.parkStall() // paused is not a stall
                else -> when (val a = ladders.onStallTick(stallTimeoutMs)) {
                    is RecoveryLadders.StallAction.Resync -> {
                        // A resync re-arms the tune under a NEW id — the host's
                        // indicator restarts.
                        tuneId++
                        tuning = true
                        ladders.phaseAdvanced() // resync is a fresh tune — fresh offline clock too
                        onStall?.invoke()
                        onTune?.invoke(TuneEvent(tuneId, tuneStreamId, TunePhase.START))
                        if (a.reconnect) backend?.reconnect()
                        rebuild() // fresh playlist load at the live edge
                    }
                    RecoveryLadders.StallAction.GiveUp -> giveUp(
                        "playback stalled: no video from '$tuneStreamId' — the channel may be unreachable right now, switch to it again to retry",
                        offline = false
                    )
                    RecoveryLadders.StallAction.None -> {}
                }
            }
        }
        if (ladders.onOfflineTick(
                tuning = tuning, vod = vod,
                paused = player?.playWhenReady == false,
                autoPlay = autoPlay, live = tuneLive,
                cdn = backend?.source == "cdn"
            )) {
            giveUp("channel is not answering — it may be offline right now, switch to it again to retry", offline = true)
        }
    }

    /** Absolute seek in seconds — vod transport UI (the localhost server does full
     *  Range, so the whole timeline is seekable). */
    fun seek(seconds: Double) {
        player?.seekTo((seconds * 1000).toLong())
    }

    override fun onDetachedFromWindow() {
        detach()
        super.onDetachedFromWindow()
    }
}
