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
  hybrid: { mode: 'hybrid', cdnUrl: 'https://cdn.example.com/{streamId}/index.m3u8' }
})
// after backend.login(user, pass) resolves entitlements ('streams' message):
<AliranVideo
  backend={backend}
  streamId="news"
  onPeers={(n) => setPeers(n)}
  onFallback={({ reason }) => console.log('now on CDN:', reason)}
  onSourceChanged={({ source }) => console.log('back on', source)}
  onBuffering={setBuffering}
  onError={setError}
/>
```

- **`AliranBackend`** — boots the worklet from a [bare-pack](../../docs/client-build.md)
  bundle (base64 or bytes) and speaks the engine's IPC protocol: `login()`, `play()`,
  `playRaw()`, `onMessage()`, with `streams` / `port` / `url` / `source` cached for
  screens that mount after the one-shot replies.
- **`<AliranVideo>`** — chrome-free video surface: plays the ACTIVE source URL,
  auto-retries while the P2P live edge replicates, and switches sources on
  `fallback` / `source-changed`. Overlays (badges, peer counts, spinners) belong to
  the host app via the callbacks — see `client/src/screens/PlayerScreen.tsx` for a
  complete example (the Aliran app dogfoods this package).

Requirements: peers `react-native-bare-kit` (min SDK 29) and `react-native-video`;
Android release builds need cleartext-to-loopback permitted for the local media
server (see `docs/client-build.md`). Ships TypeScript source (Metro consumes it
directly); if the package lives outside your app root (monorepo / `file:` dep), add
its path to Metro `watchFolders` and map its peers in `tsconfig` paths — see
`client/metro.config.js` + `client/tsconfig.json`.
