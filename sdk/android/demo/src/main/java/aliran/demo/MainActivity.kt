// The aliran-kit reference host, one Activity:
//   supported (Android 10+): start engine → login (baked dev creds) → channel list
//                            → AliranPlayerView (full P2P via the localhost URL)
//   unsupported (5–9):       EngineNotice → "Watch demo stream" → plain-HLS
//                            fallback via ExoPlayer (the host's own delivery —
//                            here a rights-clean public test stream stands in)
package aliran.demo

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.widget.ArrayAdapter
import android.widget.FrameLayout
import android.widget.ListView
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import aliran.kit.AliranBackend
import aliran.kit.AliranPlayerView
import aliran.kit.BackendMessage
import aliran.kit.EngineNotice
import aliran.kit.StartOptions
import aliran.kit.Stream
import aliran.kit.TunePhase
import org.json.JSONObject

@androidx.media3.common.util.UnstableApi
class MainActivity : Activity() {
    private val backend = AliranBackend()
    private lateinit var root: FrameLayout
    private var unsubscribe: (() -> Unit)? = null
    private var player: AliranPlayerView? = null
    private var fallbackPlayer: ExoPlayer? = null
    private var service: JSONObject? = null
    private var loginAttempts = 0

    private fun tryLogin() {
        val dev = service?.optJSONObject("dev") ?: run {
            status("Engine ready — add dev credentials to service.json to auto-login"); return
        }
        loginAttempts++
        backend.login(dev.getString("username"), dev.getString("password"))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#0B1220")) }
        setContentView(root)

        if (!AliranBackend.isSupported()) {
            showNotice()
            return
        }

        val svc = JSONObject(assets.open("service.json").bufferedReader().readText())
        service = svc
        status("Connecting to ${svc.optString("name", "service")}…")

        unsubscribe = backend.onMessage { m ->
            when (m) {
                is BackendMessage.Ready -> tryLogin()
                is BackendMessage.LoginError ->
                    // The engine's 'ready' fires before the panel connection completes,
                    // so first logins can race it — retry transient failures (the same
                    // pattern as the RN app's splash).
                    if (m.message.contains("not connected") && loginAttempts < 20) {
                        status("Connecting to ${svc.optString("name", "service")}…")
                        root.postDelayed({ tryLogin() }, 1_500)
                    } else status("Login failed: ${m.message}")
                is BackendMessage.Streams -> if (player == null) showList(m.streams)
                else -> {}
            }
        }
        backend.start(this, StartOptions().apply {
            panelPubKey = svc.getString("panelPubKey")
            prewarm = 8
        })
    }

    private fun status(text: String) {
        root.removeAllViews()
        root.addView(TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor("#93A4BF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER
        }, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
        ))
    }

    private fun showList(streams: List<Stream>) {
        root.removeAllViews()
        val titles = streams.map { s -> if (s.type == "vod") "${s.title}  (VOD)" else s.title }
        root.addView(ListView(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_list_item_1, titles)
            setOnItemClickListener { _, _, position, _ -> showPlayer(streams[position]) }
        }, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
        ))
    }

    private fun showPlayer(stream: Stream) {
        root.removeAllViews()
        val overlay = TextView(this).apply {
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#88000000"))
            setPadding(24, 12, 24, 12)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        }
        val p = AliranPlayerView(this).apply {
            onTune = { e ->
                overlay.text = when (e.phase) {
                    TunePhase.START -> "Tuning ${stream.title}…"
                    TunePhase.RETUNE -> "Reconnecting (retune)…"
                    TunePhase.RECONNECT -> "Reconnecting…"
                    TunePhase.PLAYING -> ""
                }
                overlay.visibility = if (e.phase == TunePhase.PLAYING) android.view.View.GONE else android.view.View.VISIBLE
            }
            onError = { msg -> overlay.text = msg; overlay.visibility = android.view.View.VISIBLE }
            onPeers = { /* surface if wanted: overlay.append(" peers=$it") */ }
        }
        player = p
        root.addView(p, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
        ))
        root.addView(overlay, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP or Gravity.START
        ))
        p.attach(backend, stream.id)
    }

    private fun showNotice() {
        root.removeAllViews()
        root.addView(EngineNotice(
            this,
            title = "Aliran Kit Demo",
            actionLabel = "Watch demo stream (no P2P)",
            onAction = { showFallback() }
        ), FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
        ))
    }

    // The host's own delivery below the engine floor — any plain HTTPS HLS plays on
    // ExoPlayer down to Android 5. (Real deployments: mind that Android < 7.1.1
    // doesn't trust Let's Encrypt's root — use a CDN with a classic cert chain.)
    private fun showFallback() {
        root.removeAllViews()
        val view = PlayerView(this)
        root.addView(view, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
        ))
        fallbackPlayer = ExoPlayer.Builder(this).build().also { p ->
            view.player = p
            p.setMediaItem(MediaItem.fromUri("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"))
            p.playWhenReady = true
            p.prepare()
        }
    }

    // BACK from the player returns to the channel list (supported path only).
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && player != null) {
            player?.detach(); player = null
            showList(backend.streams)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        unsubscribe?.invoke()
        player?.detach()
        fallbackPlayer?.release()
        super.onDestroy()
    }
}
