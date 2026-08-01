# Build a player — a complete walkthrough

This page shows the full path from an empty project to a playing channel:
connect with the panel public key, log in with a username and password, read
the channel list, and play a stream in a video element. Every example is
complete — you can copy it and run it.

For the full option-by-option reference, see the
[SDK installation & configuration guide](sdk-guide.md).

## What you need before you start

| Item | Where it comes from | How you use it |
|---|---|---|
| **Panel public key** (64-char hex) | Your operator. The panel prints it at start. Viewers can also type the short **pairing code** in the apps instead. | Pass it to `createPlayer({ panelPubKey })`. It is not a secret — it identifies and verifies the service. |
| **Username and password** | Your operator creates accounts (`admin-cli add-user` or the dashboard). | Pass both to `player.login(username, password)`. The password never leaves your process in plaintext — login runs an OPRF protocol. |

There is no API token and no server URL. The public key **is** the address:
the engine finds the panel over the DHT and verifies everything it reads
against that key.

## Step 1 — install and create the engine

```bash
npm install @aliran/player-sdk
```

```js
import { createPlayer } from '@aliran/player-sdk'

const player = createPlayer({
  panelPubKey: 'ce7a…your 64-char hex key…3773',
  storeDir: './aliran-store'   // local cache; any writable directory
})
```

## Step 2 — connect, then log in

`connect()` joins the panel's DHT topic and replicates the signed catalog.
`login()` can throw `not connected to panel` while the swarm is still
dialing — retry it in a short loop:

```js
await player.connect()   // resolves when the engine is ready

let streams
for (let attempt = 0; attempt < 20; attempt++) {
  try { streams = await player.login('alice', 'her-password'); break }
  catch (err) {
    if (!/not connected/i.test(String(err.message))) throw err
    await new Promise(r => setTimeout(r, 1500))
  }
}
```

A first login on a fresh store can take 30–90 seconds on a slow network —
the engine is still finding peers. Later logins are fast.

`login()` returns the **display list**: every channel and title this account
is entitled to. It also enrolls this device against the account's device
limit (see the guide, section 8).

## Step 3 — read the channel list

Each entry in the list is a `Stream` record:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable channel id. Pass it to `resolve()`. |
| `title`, `description` | string | Display text. |
| `category` | string[] | Category path, e.g. `["Deportes", "Mexico"]`. |
| `isLive` | boolean | The broadcaster publishes this channel right now. Gray out or badge accordingly. |
| `order` | number \| null | Sort key from the operator (lower first; null last). |
| `featured` | boolean | Operator's hero/menu pick. |
| `restricted` | boolean | Parental control: PIN-gate this channel; **hide it while no PIN is set**. |
| `poster`, `backdrop`, `logo` | string | Image URLs. Localhost URLs (P2P-served) or absolute https. Use them directly in `<img src>`. |
| `epgUrl`, `epgId` | string | Program-guide feed for this channel (fetch on demand). |
| `type` | `'live'` \| `'vod'` | `'vod'` = on-demand title: show seek/pause UI, ignore `isLive`. |
| `durationSec` | number \| null | VOD only. |
| `status` | string | `'live'`/`'idle'`; VOD: `'available'`/`'unavailable'` (gray out). |

The list also arrives as a `streams` event — at login **and again, live, on
any catalog edit** (title, art, isLive, order). Re-render on that event and
your lineup stays current without polling:

```js
player.on('streams', (list) => renderLineup(list))
```

## Step 4 — play a channel

```js
const r = await player.resolve('demo-channel')
// r.url  -> 'http://127.0.0.1:<port>/index.m3u8'  (P2P channels)
//        -> the operator's https URL, verbatim     (redirect channels)
```

`resolve()` starts serving the stream on a localhost HLS URL. Hand that URL
to any HLS-capable player. In a browser or Electron renderer with
[hls.js](https://github.com/video-dev/hls.js):

```html
<!doctype html>
<video id="tv" autoplay controls style="width:100%"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script>
  const url = 'http://127.0.0.1:PORT/index.m3u8'  // from resolve()
  const video = document.getElementById('tv')
  const hls = new Hls({ liveSyncDurationCount: 5 }) // play ~10 s behind live: churn headroom
  hls.loadSource(url)
  hls.attachMedia(video)
</script>
```

Two behaviors to build in:

- **`feed-changed` event** — the channel's feed rotated (broadcaster
  restart). The engine already swapped the served feed behind the **same
  URL**; reload or remount your player to flush the stale playlist. No
  re-login, no new `resolve()`.
- **Zapping** — just call `resolve(otherId)`. The engine serves the new
  channel on the same port. Keep one player element and swap its source.

When your app closes, call `player.stop()`.

## Complete minimal example (Node)

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
console.log('play this in any HLS player:', r.url)
```

## React Native — the same flow with the bundled binding

The RN package wraps the engine (running in a Bare worklet) and a
ready-made video component. Install and pack the worklet bundle per the
[guide's React Native section](sdk-guide.md#7-react-native-binding-configuration).
The backend speaks messages, not promises — results arrive as events:

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
    if (m.type === 'login-error') console.warn(m.message) // retry login on "not connected"
    if (m.type === 'streams') setStreams(m.streams)
  }), [])

  if (playing) {
    return <AliranVideo backend={backend} streamId={playing} autoPlay
                        onTune={(e) => {/* drive your tuning spinner from e.phase */}} />
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

`<AliranVideo>` already carries the live-offset and self-heal behavior the
official apps use — do not add your own stall timers. For a complete
dogfooded screen (overlays, zapping, tune indicator), read
`client/src/screens/LiveScreen.tsx` in the repository.

## Common questions

- **Is the panel key secret?** No. It is the service's public identity.
  Credentials (username/password) are the secrets.
- **Can one app serve many operators?** Yes — ship no baked key and ask for
  the key or pairing code at runtime (the public app flavor does exactly
  this).
- **Where do the stream keys live?** Inside the engine. `resolve()` never
  exposes feed or encryption keys to your UI code.
