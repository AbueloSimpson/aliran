# @aliran/react-native

Drop-in React Native binding for the Aliran P2P player: hosts the engine in a Bare
worklet (`react-native-bare-kit`) and renders live HLS with `react-native-video` —
including the hybrid CDN↔P2P policy with automatic fallback and return.

```tsx
import { AliranBackend, AliranVideo } from '@aliran/react-native'
import bundleBase64 from './backend/app.bundle.js' // your bare-pack'd engine bundle

const backend = new AliranBackend()
backend.start(bundleBase64, {
  panelPubKey: SERVICE.panelPubKey,
  hybrid: { mode: 'hybrid', cdnUrl: 'https://cdn.example.com/{streamId}/index.m3u8' },
  prewarm: 12,       // warm the first N channels' feeds at login (fast first zap)
  zapPrefetch: false // keep CH+/CH- neighbors' newest segment warm while playing —
                     // OFF by default: costs standing bandwidth (see sdk/README.md)
  // swarm: { maxPeers: 256 } — seed-node hosts only; viewers keep the default (64)
  // uploadPolicy: 'client-only' — never announce on feed topics: ~zero
  //                viewer-to-viewer upload (default 'reseed' serves blocks back)
})

// "Smooth zapping" is a runtime, user-facing choice — wire it to a Settings switch
// and feed the network profile so the engine can suspend it on metered connections:
backend.setZapPrefetch(true)             // ON mid-play (echoed as {type:'zap-prefetch'})
backend.setNetworkProfile(expensive)     // from NetInfo state.details.isConnectionExpensive
// The engine also auto-suspends while the ACTIVE stream stalls or the pipe shows no
// headroom, and resumes by itself — listen for {type:'zap-prefetch', state, reason}.
// after backend.login(user, pass) resolves entitlements ('streams' message):
<AliranVideo
  backend={backend}
  streamId="news"
  onPeers={(n) => setPeers(n)}
  onTune={(e) => setTuning(e.phase === 'playing' ? null : e)} // drive your tuning UI from this
  onFallback={({ reason }) => console.log('now on CDN:', reason)}
  onSourceChanged={({ source }) => console.log('back on', source)}
  onError={setError}
/>
```

- **`AliranBackend`** — boots the worklet from a [bare-pack](../../docs/client-build.md)
  bundle (base64 or bytes) and speaks the engine's IPC protocol: `login()`, `play()`,
  `playRaw()`, `reconnect()` (tear down the active feed's swarm connections and dial
  fresh — the wedged-transport escalation), `onMessage()`, with `streams` / `port` /
  `url` / `source` cached for screens that mount after the one-shot replies.
- **`<AliranVideo>`** — chrome-free video surface: plays the ACTIVE source URL,
  auto-retries while the P2P live edge replicates, switches sources on
  `fallback` / `source-changed`, and remounts on `feed-changed` (the broadcaster
  rotated the watched channel's feed — reload to flush the stale playlist). It also
  self-heals a **frozen live edge**: live HLS windows are short, so a network blip
  longer than the window slides it past the playhead with *no* error event — once the
  playhead sits still for `stallTimeoutMs` (default 12 s) while playing, the component
  remounts onto a fresh playlist load at the live edge and fires `onStall`. If a
  resync mount then fails to play within another window, the ladder escalates to
  `backend.reconnect()` — the network flap left the engine's peer connection
  transport-alive but replication-dead, and only a fresh dial (not a remount)
  recovers that. Drive your **tuning indicator from `onTune`**, not from raw player
  events: ONE localhost URL serves every P2P channel, so after a zap the *previous*
  channel keeps playing (and emitting `onProgress`/`onBuffer`) under the same URL
  until the engine flips the served feed. `onTune` reports each switch as a tune
  (monotonic `id`): `start` (arm/reset the indicator), `retune` / `reconnect` (the
  engine is self-healing — say "reconnecting", don't freeze a fake percentage),
  `playing` (the FIRST real playback of *this* tune — dismiss; edge-proof against
  mid-tune remounts and the old channel's events). The friendly tune-timeout arrives
  via `onError` and ends the tune. Zap-tuned start buffer:
  ExoPlayer begins playback at ~1 s buffered (vs its ~2.5 s default) — override via
  the `bufferConfig` prop (merged over the defaults) if your feeds need more headroom.
  Overlays (badges, peer counts, spinners) belong to
  the host app via the callbacks — see `client/src/screens/LiveScreen.tsx` for a
  complete example (the Aliran app dogfoods this package).

Requirements: peers `react-native-bare-kit` (min SDK 29) and `react-native-video`;
Android release builds need cleartext-to-loopback permitted for the local media
server (see `docs/client-build.md`). Ships TypeScript source (Metro consumes it
directly); if the package lives outside your app root (monorepo / `file:` dep), add
its path to Metro `watchFolders` and map its peers in `tsconfig` paths — see
`client/metro.config.js` + `client/tsconfig.json`.
