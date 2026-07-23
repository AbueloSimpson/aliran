// AliranBackend — hosts the Aliran P2P engine in a Bare worklet via Holepunch's
// plain-Java BareKit API (to.holepunch.bare.kit.Worklet/IPC — no React Native
// anywhere), speaking the same line-delimited-JSON IPC protocol as the RN binding
// (sdk/react-native/src/backend.ts is the reference; client/backend/backend.mjs is
// the worklet side).
//
// THE FLOOR, and why this class is safe at minSdk 21: libbare-kit.so needs ELF TLS,
// which Android's linker supports only from API 29 (Android 10) — and BareKit's
// System.loadLibrary sits in the Worklet class's STATIC INITIALIZER. Java classes
// initialize on first active use, so the whole gate is: never touch Worklet/IPC
// below API 29. isSupported() is that gate; below it this backend is SILENTLY
// INERT — start() and every method are safe no-ops, nothing throws, no listener
// ever fires — and the host mounts its own fallback (see EngineNotice).
package aliran.kit

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.InputStream
import java.nio.ByteBuffer
import java.util.concurrent.CopyOnWriteArraySet

/** Engine boot options (the JSON-safe subset of the RN StartOptions). */
class StartOptions {
    /** Omit to boot without connecting; call connect() once the panel key is known. */
    var panelPubKey: String? = null
    /** Warm the first N channels' feeds after login (fast first zap). 0 = off. */
    var prewarm: Int = 0
    /** Extra engine options merged into the connect payload verbatim (hybrid, tune,
     *  zapPrefetch, swarm, uploadPolicy — see the RN binding's StartOptions). */
    var extra: JSONObject? = null
}

class AliranBackend internal constructor(private val hostFactory: () -> EngineHost) {

    constructor() : this({ BareEngineHost() })

    companion object {
        /** The engine floor: Android 10 (API 29). Below it the native runtime cannot
         *  load at all — this build ships it but never touches it — and the whole
         *  backend is silently inert. The host's switch for its own fallback mode. */
        @JvmStatic
        fun isSupported(): Boolean = supportedOverride ?: (Build.VERSION.SDK_INT >= 29)

        /** Test seam (JVM unit tests report SDK_INT 0). */
        internal var supportedOverride: Boolean? = null
    }

    // Caches mirroring the RN binding: screens that mount after the one-shot replies
    // read these instead of missing the message.
    var streams: List<Stream> = emptyList(); private set
    var port: Int? = null; private set
    var url: String? = null; private set
    var source: String? = null; private set
    var activeStreamId: String? = null; private set
    var recordType: String? = null; private set
    var durationSec: Double? = null; private set
    var savedUsername: String? = null; private set
    var savedPassword: String? = null; private set
    var favorites: List<String> = emptyList(); private set
    var prefsLoaded: Boolean = false; private set

    private var host: EngineHost? = null
    private var inactive = false
    private var engineOpts = JSONObject()
    private val pending = ArrayList<JSONObject>()
    private val listeners = CopyOnWriteArraySet<(BackendMessage) -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    /** Subscribe to engine messages (delivered on the main thread). Returns the
     *  unsubscribe function. */
    fun onMessage(listener: (BackendMessage) -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    /**
     * Boot the worklet with the SDK's packaged engine bundle. On an unsupported
     * device this is a silent no-op (and any queued sends are dropped). Omit
     * opts.panelPubKey to boot without connecting — connect() dials later.
     */
    fun start(context: Context, opts: StartOptions = StartOptions()) =
        startWith(opts) { context.assets.open("app.bundle") }

    internal fun startWith(opts: StartOptions, bundleSource: () -> InputStream) {
        if (!isSupported()) { inactive = true; pending.clear(); return }
        if (host != null) return
        engineOpts = JSONObject()
        if (opts.prewarm > 0) engineOpts.put("prewarm", opts.prewarm)
        opts.extra?.let { extra -> extra.keys().forEach { k -> engineOpts.put(k, extra.get(k)) } }
        val h = hostFactory()
        host = h
        h.start("/app.bundle", bundleSource()) { line -> onLine(line) }
        opts.panelPubKey?.let { connect(it) }
        val queued = ArrayList(pending); pending.clear()
        queued.forEach { send(it) }
    }

    /** Connect (or switch) the engine to a panel. With the engine already on a
     *  DIFFERENT panel the worklet swaps it wholesale — wait for the fresh Ready. */
    fun connect(panelPubKey: String) {
        val o = JSONObject(engineOpts.toString())
        o.put("panelPubKey", panelPubKey)
        send(o)
    }

    fun login(username: String, password: String) =
        send(JSONObject().put("username", username).put("password", password))

    fun play(streamId: String) = send(JSONObject().put("streamId", streamId))

    /** Tear down the active feed's swarm connections and dial fresh (the wedged-
     *  transport escalation — see AliranPlayerView's stall ladder). */
    fun reconnect() = send(JSONObject().put("type", "reconnect"))

    /** Ask for saved credentials + favorites; answered with BackendMessage.Prefs. */
    fun requestPrefs() = send(JSONObject().put("type", "prefs-get"))

    fun saveCredentials(username: String, password: String) =
        send(JSONObject().put("type", "creds-save").put("username", username).put("password", password))

    fun clearCredentials() {
        savedUsername = null; savedPassword = null
        send(JSONObject().put("type", "creds-clear"))
    }

    fun toggleFavorite(streamId: String) {
        val next = if (favorites.contains(streamId)) favorites - streamId else favorites + streamId
        favorites = next // optimistic; the prefs reply confirms
        send(JSONObject().put("type", "favorites-set").put("favorites", org.json.JSONArray(next)))
    }

    fun isFavorite(streamId: String) = favorites.contains(streamId)

    /** Feed network-cost changes down (metered/cellular gates the engine's upload
     *  and zap-prefetch behavior — see the RN binding). */
    fun setNetworkProfile(expensive: Boolean, cellular: Boolean = false) =
        send(JSONObject().put("type", "net-info").put("expensive", expensive).put("cellular", cellular))

    private fun send(obj: JSONObject) {
        if (inactive) return // engine-less device: drop silently, never queue
        val h = host ?: run { pending.add(obj); return }
        h.write((obj.toString() + "\n").toByteArray(Charsets.UTF_8))
    }

    private fun onLine(line: String) {
        val msg = BackendMessage.parse(line) ?: return
        // Cache updates + dispatch together on the main thread, so listeners always
        // observe caches consistent with the message they were handed.
        main.post {
            when (msg) {
                is BackendMessage.Streams -> streams = msg.streams
                is BackendMessage.Port -> {
                    port = msg.port
                    url = msg.url ?: msg.port?.let { "http://127.0.0.1:$it/index.m3u8" }
                    source = msg.source ?: if (url != null) "p2p" else null
                    msg.streamId?.let { activeStreamId = it }
                    recordType = msg.recordType
                    durationSec = msg.durationSec
                }
                is BackendMessage.Fallback -> { url = msg.url; source = "cdn" }
                is BackendMessage.SourceChanged -> { url = msg.url; source = msg.source }
                is BackendMessage.FeedChanged -> url = msg.url // same localhost URL, new feed behind it
                is BackendMessage.Prefs -> {
                    savedUsername = msg.username; savedPassword = msg.password
                    favorites = msg.favorites; prefsLoaded = true
                }
                else -> {}
            }
            listeners.forEach { it(msg) }
        }
    }
}

/** The worklet transport, behind an interface so the protocol layer is unit-testable
 *  on the JVM without the native runtime. */
internal interface EngineHost {
    fun start(name: String, source: InputStream, onLine: (String) -> Unit)
    fun write(bytes: ByteArray)
}

/** The real host. ONLY constructed on API 29+ (see the class header): touching
 *  Worklet triggers its static System.loadLibrary("bare-kit"). */
private class BareEngineHost : EngineHost {
    private lateinit var worklet: to.holepunch.bare.kit.Worklet
    private lateinit var ipc: to.holepunch.bare.kit.IPC

    override fun start(name: String, source: InputStream, onLine: (String) -> Unit) {
        worklet = to.holepunch.bare.kit.Worklet(to.holepunch.bare.kit.Worklet.Options())
        worklet.start(name, source, arrayOf<String>())
        ipc = to.holepunch.bare.kit.IPC(worklet)
        val acc = LineAccumulator(onLine)
        // Poll-and-drain, mirroring the C API: read() returns null on would-block.
        ipc.readable(to.holepunch.bare.kit.IPC.PollCallback {
            while (true) {
                val buf = ipc.read() ?: break
                val bytes = ByteArray(buf.remaining())
                buf.get(bytes)
                acc.feed(bytes)
            }
        })
    }

    override fun write(bytes: ByteArray) {
        // Direct buffer: the native side reads the address; the async write completes
        // partial writes internally via the writable poll.
        val direct = ByteBuffer.allocateDirect(bytes.size)
        direct.put(bytes)
        direct.flip()
        ipc.write(direct, to.holepunch.bare.kit.IPC.WriteCallback { /* engine death surfaces via read EOF */ })
    }
}
