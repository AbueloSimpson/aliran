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
//    source-changed) or feed rotation (feed-changed) rebuilds the player, else the
//    OLD channel keeps playing out of the buffer under the same URL.
//  - Frozen-live-edge self-heal: a live HLS window can slide past the playhead with
//    NO error event — once this mount has played, a playhead still for
//    stallTimeoutMs (default 12 s) forces a rebuild at the live edge; if the rebuild
//    itself brings no playback, the engine's peer connection is wedged
//    (transport-alive, replication-dead) and the ladder escalates to
//    backend.reconnect() before further rebuilds.
//  - VOD (recordType "vod"): the ladder DISARMS (a paused/seeking/finished playhead
//    is by design) and the seek transport is enabled.
//  - Player errors while live self-retry with a rebuild after 2.5 s (the P2P live
//    edge may still be replicating); the engine's friendly {type:'error'} ends the
//    tune and is the one surfaced to the host.
package aliran.kit

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.widget.FrameLayout
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

enum class TunePhase { START, RETUNE, RECONNECT, PLAYING }

data class TuneEvent(val id: Int, val streamId: String, val phase: TunePhase)

@UnstableApi
class AliranPlayerView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null
) : FrameLayout(context, attrs) {

    /** Tune lifecycle for the host's tuning indicator (see the header). */
    var onTune: ((TuneEvent) -> Unit)? = null
    /** The engine's friendly error (tune timeout, not entitled, …) — ends the tune. */
    var onError: ((String) -> Unit)? = null
    var onPeers: ((Int) -> Unit)? = null
    var onBuffering: ((Boolean) -> Unit)? = null
    /** A frozen live edge triggered a resync (logging; drive UI off onTune). */
    var onStall: (() -> Unit)? = null
    var onSource: ((url: String, source: String) -> Unit)? = null
    /** Playhead freeze tolerance while playing live; 0 disables the ladder. */
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
    private var served: String? = null
    private var vod = false

    // The in-flight tune: `live` = the engine confirmed the shared URL serves THIS
    // tune's stream; only then can playback complete the tune.
    private var tuneId = 0
    private var tuneStreamId = ""
    private var tuning = false
    private var tuneLive = false

    // Stall ladder state (see header).
    private var lastPosition = -1L
    private var lastAdvanceAt = 0L
    private var played = false
    private var resyncs = 0

    private val main = Handler(Looper.getMainLooper())
    private var retryScheduled = false

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
     * Call again with a new streamId to zap. detach() releases everything.
     */
    fun attach(backend: AliranBackend, streamId: String, autoPlay: Boolean = true) {
        detachInternal(releaseView = false)
        this.backend = backend
        this.streamId = streamId
        served = backend.activeStreamId
        vod = backend.activeStreamId == streamId && backend.recordType == "vod"
        playerView.useController = useController || vod

        tuneId++
        tuneStreamId = streamId
        tuning = true
        tuneLive = served == streamId // re-entering on the already-served channel
        onTune?.invoke(TuneEvent(tuneId, streamId, TunePhase.START))

        unsubscribe = backend.onMessage { m -> handleMessage(m) }
        url = backend.url
        if (autoPlay) backend.play(streamId)
        if (url != null) rebuild()
        main.removeCallbacks(ticker)
        main.postDelayed(ticker, 1_000)
    }

    fun detach() = detachInternal(releaseView = true)

    private fun detachInternal(releaseView: Boolean) {
        unsubscribe?.invoke(); unsubscribe = null
        main.removeCallbacks(ticker)
        retryScheduled = false
        if (releaseView) releasePlayer()
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
                url = b.url
                b.source?.let { s -> b.url?.let { u -> onSource?.invoke(u, s) } }
                if (replyFor == sid) {
                    tuneLive = true
                    if (m.recordType != null) {
                        vod = m.recordType == "vod"
                        playerView.useController = useController || vod
                    }
                    // The engine confirmed OUR stream is behind the shared URL now —
                    // on a switch, rebuild to flush the previous channel's buffer.
                    if (changed || player == null) rebuild()
                }
            }
            is BackendMessage.Fallback -> if (m.streamId == sid) {
                url = m.url; served = sid; tuneLive = true; rebuild()
            }
            is BackendMessage.SourceChanged -> if (m.streamId == sid) {
                url = m.url; served = sid; tuneLive = true; rebuild()
                onSource?.invoke(m.url, m.source)
            }
            is BackendMessage.FeedChanged -> if (m.streamId == sid) {
                // Same localhost URL, new feed behind it — rebuild to flush.
                url = m.url; tuneLive = true; rebuild()
            }
            is BackendMessage.Status -> {
                m.peers?.let { onPeers?.invoke(it) }
                if (m.state == "feed:retune" || m.state == "feed:reconnect") {
                    // Engine self-heal on the active feed: re-arm completion and let
                    // the host say "reconnecting" instead of freezing its indicator.
                    tuning = true
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

    /** Tear down and rebuild the player onto the current URL — the flush primitive
     *  behind channel switches, source flips, feed rotations, and stall resyncs. */
    private fun rebuild() {
        val u = url ?: return
        releasePlayer()
        // Every rebuild disarms the stall watchdog until the fresh mount plays.
        lastPosition = -1; lastAdvanceAt = System.currentTimeMillis(); played = false
        val p = ExoPlayer.Builder(context)
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
            .build()
        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (p !== player) return // stale mount
                onBuffering?.invoke(state == Player.STATE_BUFFERING)
                if (state == Player.STATE_READY) completeTune()
            }

            override fun onPlayerError(error: PlaybackException) {
                if (p !== player) return
                // Live P2P: the live edge may still be replicating — quiet retry, the
                // engine's tune watchdog owns the friendly failure. (RN parity.)
                if (!retryScheduled) {
                    retryScheduled = true
                    main.postDelayed({ retryScheduled = false; rebuild() }, 2_500)
                }
            }
        })
        p.setMediaItem(MediaItem.fromUri(u))
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

    /** The 1 s ladder tick: advancing-playhead detection (completes the tune, resets
     *  the ladder) + the frozen-live-edge escalation. */
    private fun tick() {
        val p = player ?: return
        val now = System.currentTimeMillis()
        val pos = p.currentPosition
        if (pos != lastPosition && p.isPlaying) {
            lastPosition = pos
            lastAdvanceAt = now
            played = true
            resyncs = 0 // motion since the last resync — the ladder resets
            completeTune()
        }
        if (stallTimeoutMs <= 0 || vod) { lastAdvanceAt = now; return }
        if (!p.playWhenReady) { lastAdvanceAt = now; return } // paused is not a stall
        if (!played && resyncs == 0) return // never played: the tune phase owns recovery
        if (now - lastAdvanceAt < stallTimeoutMs) return
        resyncs++
        // A resync re-arms the tune under a NEW id — the host's indicator restarts.
        tuneId++
        tuning = true
        onStall?.invoke()
        onTune?.invoke(TuneEvent(tuneId, tuneStreamId, TunePhase.START))
        if (resyncs >= 2) backend?.reconnect()
        rebuild() // fresh playlist load at the live edge
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
