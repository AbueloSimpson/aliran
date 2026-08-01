# Build a player — a complete walkthrough

This page shows the full path from an empty project to a playing channel.
You connect with the panel public key. You log in with a username and a
password. You read the channel list. You play a stream.

The first two sections apply to every platform. Then follow the section for
your platform:

- [Node or browser](#path-a--node-or-browser) — `@aliran/player-sdk`
- [React Native](#path-b--react-native) — `@aliran/react-native`
- [Native Android (Kotlin)](#path-c--native-android-kotlin) — `aliran-kit`

The engine is the same in all three. Only the binding is different.

For the option-by-option reference, see the
[SDK installation & configuration guide](sdk-guide.md).

## What you need

| Item | Source | Use |
|---|---|---|
| **Panel public key** (64-char hex) | Your operator. The panel prints it at start. | Give it to the engine at start. It is not a secret. It identifies the service and verifies the catalog. |
| **Username and password** | Your operator creates the account. | Give both to `login()`. The password does not leave your process in plaintext. Login uses an OPRF protocol. |

There is no API token. There is no server URL. The public key is the
address: the engine finds the panel through the DHT and verifies each read
against the key.

The apps can also accept the short **pairing code** from a viewer at
runtime, in place of the hex key.

## The channel list

`login()` returns the channels and titles this account can watch. Each
entry is a `Stream` record:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable channel id. Give it to `resolve()` or `play()`. |
| `title`, `description` | string | Display text. |
| `category` | string[] | Category path. Example: `["Deportes", "Mexico"]`. |
| `isLive` | boolean | The broadcaster publishes this channel now. |
| `order` | number, null | Operator sort key. Lower comes first. Null comes last. |
| `featured` | boolean | Operator hero pick. |
| `restricted` | boolean | Parental control. PIN-gate this channel. Hide it when no PIN is set. |
| `poster`, `backdrop`, `logo` | string | Image URLs. Use them directly in an image element. |
| `epgUrl`, `epgId` | string | Program-guide feed for this channel. Fetch on demand. |
| `type` | `'live'`, `'vod'` | `'vod'` = on-demand title. Show seek and pause controls. Ignore `isLive`. |
| `durationSec` | number, null | VOD only. |
| `status` | string | `'live'` or `'idle'`. VOD: `'available'` or `'unavailable'`. Gray out unavailable titles. |

The list also arrives as a `streams` event. The event fires at login, and
again on each catalog edit by the operator. Re-render on the event and your
lineup stays current. Do not poll.

---

## Path A — Node or browser

### Install

```bash
npm install @aliran/player-sdk
```

### Connect and log in

```js
import { createPlayer } from '@aliran/player-sdk'

const player = createPlayer({
  panelPubKey: 'ce7a…your 64-char hex key…3773',
  storeDir: './aliran-store'   // local cache; any writable directory
})

await player.connect()
```

`login()` throws `not connected to panel` while the swarm still dials.
Retry in a loop:

```js
let streams
for (let attempt = 0; attempt < 20; attempt++) {
  try { streams = await player.login('alice', 'her-password'); break }
  catch (err) {
    if (!/not connected/i.test(String(err.message))) throw err
    await new Promise(r => setTimeout(r, 1500))
  }
}
```

A first login on a fresh store can take 30–90 seconds. The engine is still
finding peers. Later logins are fast.

### Play

```js
const r = await player.resolve('demo-channel')
// r.url -> 'http://127.0.0.1:<port>/index.m3u8'   (P2P channel)
// r.url -> the operator's https URL, unchanged     (redirect channel)
```

Give the URL to any HLS player. In a browser or an Electron renderer, use
[hls.js](https://github.com/video-dev/hls.js):

```html
<!doctype html>
<video id="tv" autoplay controls style="width:100%"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script>
  const url = 'http://127.0.0.1:PORT/index.m3u8'  // from resolve()
  const video = document.getElementById('tv')
  const hls = new Hls({ liveSyncDurationCount: 5 }) // ~10 s behind live: churn headroom
  hls.loadSource(url)
  hls.attachMedia(video)
</script>
```

Build in these two behaviors:

- **`feed-changed` event.** The channel's feed rotated. The engine already
  serves the new feed at the same URL. Reload or remount your player. Do
  not log in again. Do not call `resolve()` again.
- **Zapping.** Call `resolve(otherId)`. The engine serves the new channel
  on the same port. Keep one player element and reload it.

Call `player.stop()` when your app closes.

### Complete example

```js
import { createPlayer } from '@aliran/player-sdk'

const player = createPlayer({ panelPubKey: process.env.PANEL_KEY, storeDir: './aliran-store' })
player.on('streams', (l) => console.log('lineup updated:', l.length, 'entries'))
player.on('error', (e) => console.error('engine:', e.message))

await player.connect()
let streams
for (;;) {
  try { streams = await player.login(process.env.ALIRAN_USER, process.env.ALIRAN_PASS); break }
  catch (e) { if (!/not connected/i.test(e.message)) throw e; await new Promise(r => setTimeout(r, 1500)) }
}

const live = streams.filter(s => s.isLive && s.type !== 'vod' && !s.restricted)
console.table(live.map(s => ({ id: s.id, title: s.title, category: (s.category || []).join('/') })))

const r = await player.resolve(live[0].id)
console.log('play this URL in any HLS player:', r.url)
```

---

## Path B — React Native

The RN package wraps the engine in a Bare worklet and gives you a video
component. Install and pack the worklet bundle first: see the
[install guide](sdk-guide.md) (section "React Native (phone + TV apps)").

The backend sends messages. It does not return promises. Results arrive as
events:

```tsx
import { AliranBackend, AliranVideo } from '@aliran/react-native'
import bundle from './app.bundle.js'   // your bare-pack of the engine (see the guide)

const backend = new AliranBackend()
backend.start(bundle, { panelPubKey: PANEL_KEY })

function Player () {
  const [streams, setStreams] = useState(backend.streams ?? [])
  const [playing, setPlaying] = useState(null)

  useEffect(() => backend.onMessage((m) => {           // returns an unsubscribe
    if (m.type === 'ready') backend.login('alice', 'her-password')
    if (m.type === 'login-error') console.warn(m.message) // retry on "not connected"
    if (m.type === 'streams') setStreams(m.streams)
  }), [])

  if (playing) {
    return <AliranVideo backend={backend} streamId={playing} autoPlay
                        onTune={(e) => {/* show a tuning indicator from e.phase */}} />
  }
  return (
    <FlatList data={streams.filter(s => s.isLive && !s.restricted)} keyExtractor={s => s.id}
      renderItem={({ item }) => (
        <Pressable onPress={() => { backend.play(item.id); setPlaying(item.id) }}>
          <Text>{item.title}</Text>
        </Pressable>
      )} />
  )
}
```

`<AliranVideo>` contains the live-offset and self-heal behavior of the
official apps. Do not add your own stall timers.

For a complete production screen with overlays, zapping, and a tune
indicator, read `client/src/screens/LiveScreen.tsx` in the repository.

---

## Path C — Native Android (Kotlin)

`aliran-kit` gives the same engine to a Kotlin app, without React Native.
Build the AAR first: see the
[install guide](sdk-guide.md) (section "Native Android (Kotlin)").

The engine runs on Android 10 and newer. For Android 5–9, your app supplies
its own delivery path. If you migrate from a legacy P2P SDK such as
SwarmCloud, the complete two-engine pattern is in
[Old Android fallback](legacy-p2p-fallback.md).

The pieces mirror the RN surface. `AliranBackend` runs the engine.
`AliranPlayerView` renders the video with Media3/ExoPlayer, and contains
the same live-offset and self-heal behavior.

```kotlin
if (AliranBackend.isSupported()) {                       // false below Android 10: every call a safe no-op
  backend.start(context, StartOptions().apply { panelPubKey = SERVICE_KEY })

  val unsubscribe = backend.onMessage { m ->
    when (m) {
      is BackendMessage.Ready -> backend.login(user, pass) // retry on "not connected"
      is BackendMessage.Streams -> renderLineup(m.streams) // the channel list
      is BackendMessage.LoginError -> showError(m.message)
      else -> {}
    }
  }

  // Play: attach the view to a channel id. The view resolves and renders.
  playerView.attach(backend, streamId)
} else {
  // Android 5-9: provide your own delivery. Plain HLS plays on ExoPlayer from 5.0.
  // Migrating from a legacy P2P SDK? See the full pattern: legacy-p2p-fallback.md
}
```

The message types and the `Stream` fields are the same as on the other
platforms.

---

## Common questions

- **Is the panel key secret?** No. It is the public identity of the
  service. The username and password are the secrets.
- **Can one app serve many operators?** Yes. Ship no baked key. Ask for the
  key or the pairing code at runtime. The public app flavor does this.
- **Where do the stream keys live?** Inside the engine. `resolve()` and
  `play()` do not expose feed keys or encryption keys to your UI code.
