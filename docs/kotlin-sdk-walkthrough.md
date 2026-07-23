# Kotlin SDK walkthrough — one app from Android 5.0, with a CDN fallback

This is the step-by-step guide for **`aliran-kit`**, the native Kotlin SDK
([`sdk/android/`](https://github.com/AbueloSimpson/aliran/tree/main/sdk/android)
in the repo). You'll build an app that ships as **one APK with `minSdk 21`**
and behaves per device:

- **Android 10+** — the full P2P engine: login over the DHT, catalog, live
  playback, re-seeding. Same engine bundle and protocol as the official apps.
- **Android 5.0 – 9** — the engine physically cannot load (its native runtime
  needs a libc feature added in Android 10), so the SDK stays **silently
  inert** and hands you two things instead: a **detection hook** and a
  ready-made **notice screen with an action button** — the seam where *you*
  offer the viewer your own delivery (typically plain HLS from your CDN).

Every snippet below is the pattern of the repo's
[`demo/MainActivity.kt`](https://github.com/AbueloSimpson/aliran/blob/main/sdk/android/demo/src/main/java/aliran/demo/MainActivity.kt),
which was verified end-to-end on an Android 5.1 emulator (notice → fallback
HLS playing) and a modern one (full P2P against a production panel).

## 0. Get the library building

`aliran-kit` is consumed from the repo for now (no Maven artifact yet). One-time
prerequisites — the engine runtime is vendored from the React Native package's
checkout:

```bash
git clone https://github.com/AbueloSimpson/aliran && cd aliran
cd client && npm install && cd ..
# the per-ABI addon set (populated by any client Android build, or directly):
cd client/node_modules/react-native-bare-kit/android && node link.mjs && cd ../../../..

cd sdk/android
./gradlew :aliran-kit:testDebugUnitTest   # sanity: JVM protocol tests
./gradlew :demo:assembleDebug             # the runnable reference APK
```

To use it from your own project, include the module
(`includeBuild`/`include` from your settings.gradle, or copy `aliran-kit/`
into your project) and depend on it:

```kotlin
dependencies { implementation(project(":aliran-kit")) }
```

Your app manifest needs `INTERNET` and — for the P2P path — cleartext
permitted **to loopback only** (the engine serves HLS on `127.0.0.1`); copy
[`demo/src/main/res/xml/network_security_config.xml`](https://github.com/AbueloSimpson/aliran/blob/main/sdk/android/demo/src/main/res/xml/network_security_config.xml).

## 1. The hook: detect an incompatible device

One call, at startup:

```kotlin
import aliran.kit.AliranBackend

if (AliranBackend.isSupported()) {
    startP2P()        // step 3
} else {
    showFallbackOffer()  // step 2 — Android 5.0-9 lands here
}
```

`isSupported()` is `false` on any Android below 10. In that state the whole
backend is **inert by contract**: `start()` and every other method are safe
no-ops, nothing throws, nothing queues, no listener ever fires — so even code
that forgets the check cannot crash the app. The engine's native library is
never even class-loaded on these devices.

## 2. The notice + the CDN switch (your side)

`EngineNotice` is the ready-made screen for the unsupported branch: honest
default copy, your branding, and an **action button that is the switch** —
wire `onAction` to mount your own delivery. The SDK deliberately provides the
notice and the switch, never the content: what plays after the press is yours.

Here is the complete fallback, using ExoPlayer (which `aliran-kit` already
brings in, and which plays plain HLS down to Android 5.0):

```kotlin
import aliran.kit.EngineNotice
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

private var fallbackPlayer: ExoPlayer? = null

private fun showFallbackOffer() {
    setContentView(EngineNotice(
        this,
        title = "Acme TV",                                   // your brand
        message = "This device can't run the P2P engine — " +
                  "Android 10 or newer is required.",        // optional override
        actionLabel = "Watch over the internet",             // the switch
        onAction = { startCdnPlayback() }
        // colors = EngineNotice defaults are dark; pass your palette to rebrand
    ))
}

private fun startCdnPlayback() {
    val view = PlayerView(this)
    setContentView(view)
    fallbackPlayer = ExoPlayer.Builder(this).build().also { p ->
        view.player = p
        // YOUR delivery — plain HLS from your CDN. This is entirely outside
        // the P2P system; entitlement/auth for this URL is your design.
        p.setMediaItem(MediaItem.fromUri("https://cdn.example.com/live/main.m3u8"))
        p.playWhenReady = true
        p.prepare()
    }
}

// release fallbackPlayer in onDestroy()
```

The action button is focusable with visible feedback, so the same code works
on TV boxes with a D-pad. Omit `actionLabel`/`onAction` and the screen is a
plain informational notice.

**The one old-device trap:** Android **below 7.1.1 does not trust Let's
Encrypt's root certificate**. If your CDN's HTTPS chain is Let's-Encrypt-only,
the fallback fails TLS on exactly the devices it exists for — serve it from a
host with a classic certificate chain.

## 3. The supported path (Android 10+): full P2P

```kotlin
import aliran.kit.*

private val backend = AliranBackend()

private fun startP2P() {
    backend.onMessage { m ->
        when (m) {
            is BackendMessage.Ready -> backend.login(username, password)
            is BackendMessage.LoginError ->
                // 'ready' fires before the panel link completes — retry the
                // transient case instead of surfacing it:
                if (m.message.contains("not connected")) retryLoginSoon()
                else showLoginError(m.message)
            is BackendMessage.Streams -> showChannelList(m.streams)
            else -> {}
        }
    }
    backend.start(this, StartOptions().apply {
        panelPubKey = "your-64-hex-panel-public-key"
        prewarm = 8   // warm the first channels' feeds for fast first zaps
    })
}

private fun play(stream: Stream) {
    val player = AliranPlayerView(this)
    setContentView(player)
    player.onTune = { e -> showTuningPill(e.phase != TunePhase.PLAYING) }
    player.onError = { msg -> showChannelError(msg) }
    player.attach(backend, stream.id)   // sends play() and renders the video
}
```

`AliranPlayerView` carries the official apps' playback contracts so you don't
reimplement them: the ~1 s zap buffer, the engine-driven tune lifecycle
(drive your "tuning…" indicator from `onTune`, not raw player events), the
frozen-live-edge self-heal ladder, feed-rotation rebuilds, and the vod seek
transport (auto-enabled when the engine reports a vod title).

## 4. Run it

```bash
./gradlew :demo:assembleDebug
adb install demo/build/outputs/apk/debug/demo-debug.apk
```

On a modern device you get login → channel list → live P2P playback; on an
Android 5–9 device (or emulator) you get the notice, and the button plays the
fallback stream. The demo bakes its service descriptor from
`demo/src/main/assets/service.json` (gitignored — copy
`demo/service.example.json` and fill in your panel key and a dev account).

## Reference

- [SDK overview & requirements matrix](sdk.md) — floors for every surface
- [SDK installation & configuration](sdk-guide.md) — the RN edition + the engine concepts
- [Operator APIs & the SDK](ops-sdk-integration.md) — the control plane your app observes
