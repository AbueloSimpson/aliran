# Old Android fallback — Aliran + a legacy P2P SDK in one app

The Aliran engine runs on Android 10 and newer. Your app can still install
and play video on Android 5–9. On those devices, the app must use a
different delivery path.

This page shows the full pattern with **SwarmCloud** (also known as CDNBye)
as the legacy path. This is the common migration case: you already deliver
HLS from a CDN with SwarmCloud P2P assist, and you now adopt Aliran. One
APK serves both worlds:

| Device | Delivery | What plays |
|---|---|---|
| Android 10+ | **Aliran** (`aliran-kit`) | Full P2P: DHT login, catalog, encrypted feeds. No CDN needed. |
| Android 5–9 | **Your CDN + SwarmCloud** | Your existing HLS URLs, with SwarmCloud peer assist. |

The two engines never run at the same time. The app selects one path at
start and keeps it for the whole process lifetime.

## Understand the two engines first

They are not the same kind of product. Plan for the difference:

- **Aliran is the full platform.** The engine does login, the channel
  catalog, entitlements, stream keys, and the P2P delivery. It needs no
  origin server and no CDN.
- **SwarmCloud is a delivery assist.** It sits between your player and
  your CDN. It fetches HLS segments from other viewers when it can, and
  from your CDN when it cannot. It does not know about accounts or
  channels. **You keep your own backend for login and the channel list on
  the legacy path** — the same backend you use today.

This split decides the architecture: the legacy path cannot read the
Aliran catalog, because the Aliran engine is what reads it. Do not try to
bridge that gap. Keep your current legacy backend until the old devices
age out, then delete the legacy path.

## Step 1 — dependencies

`aliran-kit` installs from Android 5.0 (the AAR carries the runtime gate).
SwarmCloud supports API 17+. Both fit in one APK.

```kotlin
// app/build.gradle.kts
dependencies {
  implementation(project(":aliran-kit"))                        // see the install guide
  implementation("com.swarmcloud:p2p_engine:latest.release")    // legacy path
  implementation("com.swarmcloud:datachannel_native:latest.release")
  implementation("androidx.media3:media3-exoplayer:1.8.0")
  implementation("androidx.media3:media3-exoplayer-hls:1.8.0")
}
```

SwarmCloud needs a (free-tier) app token from swarmcloud.net. Aliran needs
your panel public key. Neither is a secret in the APK.

## Step 2 — one delivery interface, two implementations

Give the rest of your app one surface. Only these two classes know which
engine runs:

```kotlin
data class Channel(
  val id: String,
  val title: String,
  val isLive: Boolean,
  val posterUrl: String?
)

interface Delivery {
  /** Log in and return the channel list. */
  suspend fun login(user: String, pass: String): List<Channel>
  /** Start playback of a channel inside the given container. */
  fun play(channelId: String)
  /** Release everything. Call from Activity.onDestroy / process end. */
  fun shutdown()
}
```

## Step 3 — the gate

Decide once, at process start. `AliranBackend.isSupported()` is `false`
below Android 10, and every Aliran call is then a safe no-op — but do not
rely on no-ops. Branch explicitly:

```kotlin
val delivery: Delivery =
  if (AliranBackend.isSupported()) AliranDelivery(context)
  else LegacyDelivery(context)
```

## Step 4 — the Aliran path (Android 10+)

This is the standard `aliran-kit` flow. See
[Build a player](build-a-player.md), Path C, for the full walkthrough.

```kotlin
class AliranDelivery(private val context: Context) : Delivery {
  private val backend = AliranBackend()
  private lateinit var playerView: AliranPlayerView   // in your layout

  override suspend fun login(user: String, pass: String): List<Channel> {
    backend.start(context, StartOptions().apply { panelPubKey = SERVICE_KEY })
    return suspendCancellableCoroutine { cont ->
      val unsub = backend.onMessage { m ->
        when (m) {
          is BackendMessage.Ready -> backend.login(user, pass)
          is BackendMessage.Streams -> cont.resume(m.streams.map {
            Channel(it.id, it.title ?: it.id, it.isLive == true, it.poster)
          })
          is BackendMessage.LoginError ->
            if (m.message.contains("not connected")) {          // swarm still dialing:
              handler.postDelayed({ backend.login(user, pass) }, 1500) // retry
            } else cont.resumeWithException(Exception(m.message))
          else -> {}
        }
      }
      cont.invokeOnCancellation { unsub() }
    }
  }

  override fun play(channelId: String) {
    playerView.attach(backend, channelId)   // resolves, renders, self-heals
  }

  override fun shutdown() = backend.stop()
}
```

Notes for this path:

- `AliranPlayerView` contains the live offset and the stall self-heal. Do
  not add your own stall timers here.
- The first login on a fresh install can take 30–90 seconds. Show a
  connect indicator, not an error.

## Step 5 — the legacy path (Android 5–9)

This is your app as it works today, wrapped in the same interface. Login
and the channel list come from **your existing backend**. Playback goes
CDN URL → SwarmCloud proxy URL → ExoPlayer.

```kotlin
class LegacyDelivery(private val context: Context) : Delivery {
  private lateinit var player: ExoPlayer
  private var channels: List<LegacyChannel> = emptyList()  // your backend's model

  override suspend fun login(user: String, pass: String): List<Channel> {
    // 1. Your existing auth + channel list. Unchanged.
    channels = legacyApi.login(user, pass)

    // 2. Start SwarmCloud once per process, BEFORE the first parseStreamUrl.
    val config = P2pConfig.Builder()
      .maxPeerConnections(25)
      .build()
    P2pEngine.init(context, SWARMCLOUD_TOKEN, config)

    return channels.map { Channel(it.id, it.title, it.isLive, it.poster) }
  }

  override fun play(channelId: String) {
    val cdnUrl = channels.first { it.id == channelId }.hlsUrl

    // SwarmCloud rewrites the URL to its local proxy. Segments then come
    // from peers when possible, from your CDN when not.
    val playUrl = P2pEngine.getInstance().parseStreamUrl(cdnUrl)

    player = ExoPlayer.Builder(context).build()
    player.setMediaItem(MediaItem.fromUri(playUrl))
    player.prepare()
    player.play()

    // Live streams: give SwarmCloud the buffer signal it schedules by.
    P2pEngine.getInstance().setPlayerInteractor(object : PlayerInteractor() {
      override fun onBufferedDuration(): Long =
        player.bufferedPosition - player.currentPosition
    })

    // Tell SwarmCloud about stalls so it can prefer the CDN for a while.
    player.addListener(object : Player.Listener {
      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_BUFFERING) {
          P2pEngine.getInstance().notifyPlaybackStalled()
        }
      }
    })
  }

  override fun shutdown() {
    player.release()
    P2pEngine.getInstance().shutdown()   // stops P2P and the local proxy
  }
}
```

Notes for this path:

- **Cleartext:** the SwarmCloud proxy serves on localhost over http. Allow
  cleartext to `127.0.0.1` in your `network_security_config.xml`, the same
  as for the Aliran path.
- **Zapping:** call `parseStreamUrl` again for the new channel and give
  ExoPlayer the new item. Do not call `P2pEngine.init` again.
- **Background:** call `P2pEngine.getInstance().stopP2p()` when the app
  goes to background for a long time; `restartP2p()` on return. A viewer
  on this path uploads to peers — respect metered networks with your own
  gate if your policy needs one (Aliran does this itself on its path).
- **Stats:** `P2pStatisticsListener` gives you p2p/http byte counters and
  the peer list — useful to verify the assist works in the field.

## Step 6 — the shared UI

Your screens only see `Delivery`, `Channel`, and one player container:

```kotlin
lifecycleScope.launch {
  val channels = delivery.login(user, pass)
  lineup.submitList(channels.filter { it.isLive })
}

lineup.onClick = { channel -> delivery.play(channel.id) }

override fun onDestroy() {
  delivery.shutdown()
  super.onDestroy()
}
```

The only visible difference between the paths: the Aliran path renders in
`AliranPlayerView`, the legacy path in ExoPlayer's `PlayerView`. Put both
in your layout and show one:

```kotlin
aliranView.isVisible = AliranBackend.isSupported()
exoView.isVisible = !AliranBackend.isSupported()
```

## What this costs and when to delete it

- The legacy path keeps your CDN bill and your SwarmCloud account for as
  long as Android 5–9 devices matter to you.
- Watch the split in your analytics. When the legacy share is small enough,
  delete `LegacyDelivery`, the SwarmCloud dependencies, and your legacy
  backend endpoints. The Aliran path needs none of them.
- Do not extend the legacy path with new features. It is a bridge, not a
  second product.

## Version reference

Checked against: `aliran-kit` 0.5.0-era (`@aliran/player-sdk` 0.1.3),
SwarmCloud Android `p2p_engine` (API level 17+), Media3 1.8.0. SwarmCloud
class and method names (`P2pEngine.init`, `parseStreamUrl`,
`PlayerInteractor`, `notifyPlaybackStalled`, `stopP2p`, `restartP2p`,
`shutdown`, `P2pStatisticsListener`) follow the vendor documentation at
swarmcloud.net — verify against the SwarmCloud release you pin.
