# aliran-kit — native Kotlin Aliran SDK

The React-Native-free twin of [`@aliran/react-native`](../react-native/): hosts the
same P2P engine (a Bare worklet, via Holepunch's plain-Java BareKit API) and speaks
the same IPC protocol, for **any Android app** — **one APK from Android 5.0
(minSdk 21)**. On Android 10+ the engine runs in full; below that it cannot load
(its ELF-TLS libc floor) and the SDK is **silently inert**: gate on
`AliranBackend.isSupported()` and mount your own fallback via `EngineNotice`.

| Piece | What it is |
|---|---|
| `AliranBackend` | Worklet host + the line-JSON IPC protocol (login, play, streams, port, prefs, …) |
| `AliranPlayerView` | Media3/ExoPlayer view with the `<AliranVideo>` playback contracts — 1 s zap buffer, engine-driven tune lifecycle, frozen-live-edge resync ladder, feed-rotation rebuild, vod transport |
| `EngineNotice` | Brandable "engine can't run here" screen with an optional action button — your fallback seam |
| `demo/` | Reference host: login → channel list → live playback on 10+; notice + plain-HLS fallback below |

## Building

Prerequisites (the engine runtime is vendored from the RN package's checkout):

```bash
cd ../../client && npm install        # places react-native-bare-kit + prebuilds
# addons: any client Android build populates them, or:
#   cd node_modules/react-native-bare-kit/android && node link.mjs
```

Then:

```bash
cd sdk/android
./gradlew :aliran-kit:testDebugUnitTest   # JVM protocol tests
./gradlew :demo:assembleDebug             # the demo APK (minSdk 21)
```

The demo needs a service descriptor: copy `demo/service.example.json` to
`demo/src/main/assets/service.json` (gitignored) and fill in your panel public key
and dev credentials.

Full walkthrough, usage example, and the old-device TLS caveat:
[SDK guide — Native Android (Kotlin)](https://abuelosimpson.github.io/aliran/sdk-guide/).
