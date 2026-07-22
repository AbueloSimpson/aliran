# Player SDK

Everything the Aliran Android app knows about playing P2P television lives in two
reusable packages — the app itself is a consumer of them. Build your own viewer
(set-top UI, kiosk, desktop app, seed node) on the same engine the shipped app
dogfoods.

| Package | What it is | Runs in |
|---|---|---|
| [`@aliran/player-sdk`](https://github.com/AbueloSimpson/aliran/tree/main/sdk) | Headless player engine: DHT connect, OPRF login, catalog replication, entitled-feed serving on a localhost HLS URL | Node ≥ 20 and the Bare runtime |
| [`@aliran/react-native`](https://github.com/AbueloSimpson/aliran/tree/main/sdk/react-native) | Drop-in `<AliranVideo>` + `AliranBackend` worklet host on `react-native-video` / `react-native-bare-kit` | React Native (phone + TV) |
| [`@aliran/core`](https://github.com/AbueloSimpson/aliran/tree/main/core) | The shared crypto both sit on (OPRF, Argon2id verifiers, key sealing, tokens) | Node + Bare |

All three are MIT, ship from the monorepo, and are packaged for the npm registry
under the `@aliran` scope. TypeScript definitions are included (`player-sdk` ships
`index.d.ts`; the RN binding ships TypeScript source).

## Headless quickstart (Node)

```js
import { createPlayer } from '@aliran/player-sdk'

const player = createPlayer({ panelPubKey, storeDir: './aliran-store' })
player.on('peers', (n) => console.log(n, 'peers'))

await player.connect()                          // join the panel topic over the DHT
const streams = await player.login(user, pass)  // OPRF login → entitled display list
const { url, source } = await player.resolve(streams[0].id)
// source 'p2p'  → url is a localhost HLS playlist served from the replicating feed
// source 'cdn'  → a redirect channel: play the operator's remote URL directly
```

Point `ffplay`, VLC, hls.js, ExoPlayer — anything that eats HLS — at the URL.
A complete runnable version is
[`examples/headless-player.mjs`](https://github.com/AbueloSimpson/aliran/tree/main/examples).

Login never sends a plaintext password anywhere (see the
[security model](security-model.md)); stream keys stay inside the engine — hosts
only ever see catalog metadata and localhost URLs. The store directory is a
disposable replica cache: corruption is detected, purged, and re-replicated from
peers automatically.

## React Native

```tsx
import { AliranBackend, AliranVideo } from '@aliran/react-native'

const backend = new AliranBackend()
backend.start(bundleBase64, { panelPubKey })    // your bare-pack'd engine bundle
// after backend.login(user, pass):
<AliranVideo backend={backend} streamId="news" onPeers={setPeers} onTune={setTune} />
```

`<AliranVideo>` self-heals frozen live edges, follows broadcaster feed rotations,
and reports tune progress via `onTune`. The worklet bundle is produced by
[the client build](client-build.md); the binding has no native code of its own.

## What the engine handles for you

- **Live catalog** — the panel's signed DB replicates to the viewer; title/art/isLive
  edits push to the `streams` event without polling or re-login.
- **Feed rotation** — a broadcaster restart publishes a new feed key; the engine
  re-resolves and swaps the served feed behind the same localhost URL
  (`feed-changed` tells the host to reload the player).
- **Redirect channels** — catalog entries that play an operator's CDN URL instead of
  a P2P feed ([content management](content-management.md)); `resolve()` returns the
  URL verbatim with `source: 'cdn'`.
- **Tune self-heal** — timeouts escalate from cache eviction to peer-connection
  teardown before surfacing a friendly error.
- **Zap latency** — progressive serving, playlist read-ahead, optional `prewarm` and
  the adaptive, runtime-switchable `zapPrefetch` ("Smooth zapping").
- **Viewer bandwidth** — `uploadPolicy: 'client-only'` (or `setUploadPolicy()` live)
  for metered networks: near-zero viewer-to-viewer upload
  ([measured numbers](kb/viewer-bandwidth.md)).
- **Seed nodes** — `swarm: { maxPeers }` raises the connection budget for
  repeater-style hosts ([scaling](kb/scaling.md)).

The full option/event reference is the
[package README](https://github.com/AbueloSimpson/aliran/tree/main/sdk) and its
`index.d.ts`.

## Partial adoption

You can keep your own catalog/metadata UI and use only `login()` + `resolve()` for
the video URL — video travels P2P, metadata stays yours. At the other extreme,
`serveFeed(feedKey, encKey)` plays a feed from raw keys with no login at all
(dev/direct-play).

## Publishing status

The packages are publish-ready (`npm pack` produces clean tarballs, MIT license
text included) and the `@aliran` npm scope is registered to the project. Until the
first registry release is cut, consume them from the monorepo — npm workspaces
(`sdk/`) inside the repo, or a git dependency from outside.
