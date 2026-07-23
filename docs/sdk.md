# Player SDK

Everything the Aliran Android app knows about playing P2P television lives in two
reusable packages — the app itself is a consumer of them. Build your own viewer
(set-top UI, kiosk, desktop app, seed node) on the same engine the shipped app
dogfoods.

| Package | What it is | Runs in |
|---|---|---|
| [`@aliran/player-sdk`](https://github.com/AbueloSimpson/aliran/tree/main/sdk) | Headless player engine: DHT connect, OPRF login, catalog replication, entitled-feed serving on a localhost HLS URL | Node ≥ 20 and the Bare runtime |
| [`@aliran/react-native`](https://github.com/AbueloSimpson/aliran/tree/main/sdk/react-native) | Drop-in `<AliranVideo>` + `AliranBackend` worklet host on `react-native-video` / `react-native-bare-kit` | React Native — phone + TV, Android 7+ (P2P engine active on Android 10+; silent below) |
| [`@aliran/core`](https://github.com/AbueloSimpson/aliran/tree/main/core) | The shared crypto both sit on (OPRF, Argon2id verifiers, key sealing, tokens) | Node + Bare |

All three are MIT, ship from the monorepo, and are packaged for the npm registry
under the `@aliran` scope. TypeScript definitions are included (`player-sdk` ships
`index.d.ts`; the RN binding ships TypeScript source).

**Building on it?** The [installation & configuration guide](sdk-guide.md) is the
complete manual (every install path, option, event, and troubleshooting), and
[Operator APIs & the SDK](ops-sdk-integration.md) maps the operator control plane
to what your app observes.

## Minimum requirements

The floors below come from the native P2P stack — the engine loads prebuilt
native modules (libsodium, the UDP transport, …) and those prebuilds exist for
exactly these targets. They are hard requirements, not recommendations: on
anything older the engine does not degrade, it simply cannot load. (The SDK's
*JavaScript* is a separate story — on Android it degrades **silently** below
the engine floor; see the last row.)

| Surface | Minimum | Why / notes |
|---|---|---|
| Node host (`@aliran/player-sdk`) | **Node ≥ 20** (ESM-only package) on Linux x64/arm64 · Windows 10+ x64/arm64 · macOS 13+ (Apple silicon + Intel) | `npm install` places prebuilt natives — no compiler, no build step. If your platform/arch isn't listed, there is no prebuild for it |
| React Native app (`@aliran/react-native`), P2P engine | **Android 10 (API level 29)** or newer, 64-bit device; peers: `react ≥ 18`, `react-native-bare-kit ≥ 0.13.3`, `react-native-video` v6. Tested against `react-native-tvos` 0.83 (New Architecture) | The engine worklet cannot load on Android 9 or older (libc ELF-TLS dependency, not a pin). Stock `react-native-bare-kit` sets `minSdkVersion 29`; with the lazy-load patch a single `minSdk 24` APK ships the engine anyway and activates it only here (last row) |
| Android TV / Fire TV | Same **Android 10 / API 29** engine floor | Android TV 10+ and Fire OS 8 devices (Android 11 base) get full P2P; **Fire OS 7 sticks (Android 9 base) cannot run the engine** — the single APK still installs and runs on them, engine silent (verified on a 4K Max 1st gen) |
| Desktop player (`desktop/`) | **Windows 10 or newer** (x64) · **macOS 13 Ventura or newer** (Apple silicon + Intel) | Electron 37 platform floors. HEVC channels additionally need platform hardware decode ([codecs](desktop-player.md#5-codecs-what-this-player-can-decode)) |
| Bare / custom runtimes | The Bare runtime + the addon set `react-native-bare-kit` 0.13.x links | See the [Bare section of the install guide](sdk-guide.md#bare-custom-runtimes) |
| React Native app, **single APK** (runtime engine gate) | **Android 7 (API 24)** — React Native 0.76+'s own hard floor (its prebuilds are built for 24; the build rejects lower) | With the bare-kit lazy-load patch, **one APK installs from Android 7 and carries the engine**: on Android 10+ the engine loads and runs in full; below, the SDK is **silently inactive** (`AliranBackend.isSupported()` → `false`, every call a safe no-op) and the app provides its own content path. No P2P data is reachable below Android 10, and Android 6 can't run a current-RN app at all. [Recipe](sdk-guide.md#older-android-79-one-apk-the-engine-gates-itself-at-runtime) |

(Android "SDK level"/"API level" mapping, since device spec sheets use both:
**API 29 = Android 10**, 30 = 11, 31/32 = 12, 33 = 13, 34 = 14, 35 = 15.)

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

**Live on the npm registry** — first release `0.1.0` (2026-07-22 UTC) for all
three packages:

```sh
npm install @aliran/player-sdk     # or @aliran/react-native for RN apps
```

A cold install resolves the whole dependency chain from the registry. Inside the
monorepo, the npm workspace (`sdk/`) still links the local copies for development,
and the Android app's worklet keeps consuming them via `file:`.
