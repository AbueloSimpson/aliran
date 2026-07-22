# SDK installation & configuration

The complete setup and configuration reference for building a viewer on the Aliran
SDK. The [Player SDK overview](sdk.md) explains what the packages are; this page is
the working manual: every install path, every option, every event, and the runtime
controls. For how *operator* actions flow into what your app sees, read
[Operator APIs & the SDK](ops-sdk-integration.md).

All packages are live on npm under the `@aliran` scope (0.1.0, MIT).

---

## 1. Installation

### Node (headless host)

```sh
npm install @aliran/player-sdk
```

- **Node ≥ 20.** The package is ESM (`"type": "module"`).
- TypeScript definitions ship in the package (`index.d.ts`) — no `@types` needed.
- Nothing else is required to *serve* video; to *watch* it you point any HLS-capable
  player (ffplay, VLC, mpv, hls.js, ExoPlayer) at the localhost URL the SDK returns.
- Native modules (`sodium-native` via `@aliran/core`) install from prebuilds on
  Linux/macOS/Windows — no toolchain needed on mainstream platforms.

Smoke test (prints usage, proves the install resolves):

```sh
node -e "import('@aliran/player-sdk').then(m => console.log(Object.keys(m)))"
```

A complete runnable starting point is
[`examples/headless-player.mjs`](https://github.com/AbueloSimpson/aliran/tree/main/examples).

### React Native (phone + TV apps)

```sh
npm install @aliran/react-native react-native-video react-native-bare-kit b4a
```

Peer requirements and platform notes:

| Peer | Range | Notes |
|---|---|---|
| `react` | ≥ 18 | |
| `react-native` | `*` | Deliberately unpinned: TV apps install it as an npm **alias of `react-native-tvos`**, whose prerelease versions fail any strict semver range. With those, install with `--legacy-peer-deps`. |
| `react-native-video` | ^6 | Renders the HLS. |
| `react-native-bare-kit` | ≥ 0.13.3 | Hosts the engine worklet. **Requires `minSdkVersion` 29.** |
| `b4a` | ^1.6.6 | Buffer shim shared with the engine. |

Three things the host app must provide:

1. **The worklet bundle.** The binding has no build-time coupling to an engine build —
   you supply the engine as a [bare-pack](client-build.md) bundle (base64 string or
   raw bytes) to `AliranBackend.start()`. The reference recipe (packing
   `@aliran/player-sdk` + `bare-fs`/`bare-http1` wiring into `app.bundle`) is the
   [client build guide](client-build.md); the shipped app's
   `client/backend/` is the working example.
2. **Cleartext to loopback** (Android release builds): the engine serves HLS on
   `http://127.0.0.1:<port>`, so release builds need cleartext permitted **for
   loopback only** (network-security-config) — details in the
   [client build guide](client-build.md).
3. **Metro visibility** when the package lives outside your app root (monorepo /
   `file:` install): add its path to `metro.config.js` `watchFolders` and map the
   peers in `tsconfig.json` `paths`. The shipped app's `client/metro.config.js` +
   `client/tsconfig.json` are working references. The package ships TypeScript
   *source* (Metro consumes `.ts/.tsx` directly — no build step).

**Codec reality check:** the SDK passes streams through untouched (`copy` end to
end), so the *device* must decode whatever the operator broadcasts. A lineup with
HEVC/1080p channels needs HEVC-capable hardware — see
[source compatibility](kb/source-compatibility.md).

### Bare / custom runtimes

The engine core is runtime-agnostic — `player.js` takes injected `{ http, fs }`
modules and never imports Node builtins:

```js
import { AliranPlayer } from '@aliran/player-sdk/player.js'
import http from 'bare-http1'
import fs from 'bare-fs'

const player = new AliranPlayer({ panelPubKey, storeDir, http, fs })
```

`index.js` (`createPlayer`) is exactly this with `node:http`/`node:fs` wired in.
The Android app's worklet (`client/backend/backend.mjs`) is the Bare reference.

---

## 2. What you need from your operator

The SDK talks to a deployment, so three artifacts come from whoever runs the
[panel](operator-guide.md):

| Artifact | Where it comes from | What the SDK does with it |
|---|---|---|
| **Panel public key** (hex) | Printed at panel `init`; also in the panel's `keys/` | `connect()` derives the DHT topic and verifies every catalog read — the entire control plane is signed by this key. |
| **An account** (username/password) | `admin-cli add-user` or `POST /api/users` | `login()` runs the OPRF protocol against it. The password never leaves your process in plaintext. |
| **Grants** | `admin-cli grant` or `POST /api/users/:u/grants` | Decide which streams appear in the display list and which sealed keys the login can unseal. |

No URLs, hostnames, or ports: discovery is the DHT, identity is the key. A viewer
app config is typically just `{ panelPubKey }` plus your own branding.

---

## 3. `createPlayer(opts)` — full configuration reference

Every option is optional except that a panel key must arrive either here or in
`connect(panelPubKey)`.

### `panelPubKey: string`
Hex panel public key (§2).

### `storeDir: string` — default `'./aliran-store'`
The on-disk replica cache. Treat it as **disposable**: corruption from unclean
exits is detected (`EPARTIALREAD`, `OPLOG_CORRUPT`, …), the store is purged and the
operation retried once, and everything re-replicates from peers — in-memory
entitlements survive (`recovered` event fires). Place it in platform cache storage
(RN worklet: app files dir; Node: any writable path). Deleting it while stopped is
always safe; you lose only warm replicas.

### `prewarm: boolean | number` — default `false`
Open entitled feeds' DHT topics right after login so the **first** zap to a channel
skips the cold lookup. `true` = all entitled feeds; an integer = that many, lowest
curated `order` first. Bandwidth-cheap — it warms *connections*, not downloads.
Also callable later as `player.prewarm()`.

### `tune: { timeoutMs?, relookupMinMs?, relookupMaxMs? }` — defaults 30 000 / 5 000 / (backoff)
The tune self-heal ladder's knobs. One tune attempt is bounded by `timeoutMs`: the
first expiry evicts the cached feed open and retries once; the second tears down
wedged peer connections (transport-alive but replication-dead) and dials fresh;
only then does a friendly `error` surface (≤ ~90 s with defaults). While a tune is
incomplete, forced DHT re-lookups are paced between `relookupMinMs` and
`relookupMaxMs`. Raise `timeoutMs` only for genuinely slow networks — the ladder
usually beats waiting.

### `zapPrefetch: boolean | object` — default off ("Smooth zapping")
While a stream plays, keep the **newest segment** of the adjacent channels (curated
zap order) replicated locally so CH+/CH− starts from warm bytes. **Costs standing
bandwidth** (≈ each warmed neighbor's bitrate) — that's why it's off, and why it's
designed to be a *user-facing* choice, not a silent default.

`true` enables the adaptive defaults; an object tunes them:

| Key | Default | Meaning |
|---|---|---|
| `neighbors` | 1 | How many channels on each side to warm. |
| `intervalMs` | 4000 | Warm-loop tick. |
| `directional` | `true` | Once the surf direction is known (an adjacent-channel move), warm only that side — halves the standing cost for CH+/CH+/CH+ patterns. A menu jump resets to both sides. |
| `stallMs` | 12 000 | Suspend when the **active** playlist stops advancing this long (your own stream is starving). |
| `resumeMs` | 60 000 | Clean-advance run required before a stall/thin suspension lifts. |
| `minHeadroom` | 3 | Neighbor segments must download ≥ this × realtime, else the pipe has no room and prefetch suspends. |

The engine **suspends itself** (dropping the standing downloads, keeping the tick
alive to observe recovery) on: a metered network (`setNetworkProfile`), an active
stream stall, or a thin pipe — and reports every transition as a `zap-prefetch`
event (`reason: 'metered' | 'stall' | 'thin'`). Runtime-switchable with
`setZapPrefetch()`.

### `uploadPolicy: 'reseed' | 'client-only'` — default `'reseed'`
`'reseed'` joins feed/assets topics announced: blocks this viewer already
replicated are served back to other viewers on request — the opportunistic upload
that makes the P2P model work. `'client-only'` joins **unannounced**: the peer is
undiscoverable on those topics, so other viewers can never dial it — practically
zero viewer-to-viewer upload by construction, at the swarm-wide cost of one fewer
re-seeder. The viewer's own playback is unaffected. Switchable live with
`setUploadPolicy()` — the standard pattern is wiring it to the platform's
metered-network signal. Measured numbers: [viewer bandwidth](kb/viewer-bandwidth.md).

### `swarm: { maxPeers?, bootstrap? }`
Tuning for the engine's single Hyperswarm. Ordinary viewers omit the whole object.

- `maxPeers` — total-connection budget (hyperswarm default 64, plenty for a
  viewer). SDK-based **seed nodes** and repeater-style hosts raise it into the
  hundreds to hold big fan-out while re-seeding ([scaling](kb/scaling.md)).
- `bootstrap: [{ host, port }, …]` — custom DHT bootstrap nodes, for local DHT
  testnets or private-DHT deployments. Omit for the public DHT.

### `hybrid` — leave unset
A config-driven CDN↔P2P failover engine predating [redirect channels](content-management.md);
it survives as e2e-harness infrastructure and is **not a product path**. The
default `p2p-only` is the shipped behavior; the product CDN mechanism is the
redirect channel class, which needs no client config at all.

---

## 4. Runtime control surface

| Method | What it does |
|---|---|
| `connect(panelPubKey?)` | Join the panel topic, replicate the signed DB. Emits `ready`. |
| `login(username, password)` | OPRF login → display list. Throws `not connected to panel` while the swarm is still dialing — **retry on that message** (see the pattern below). |
| `listStreams()` | Last display list (also re-delivered via the `streams` event). |
| `resolve(streamId)` | Serve an entitled stream; see §5 for the contract. |
| `source()` | `{ streamId, source, url }` of the active stream, or `null`. |
| `serveFeed(feedKey, encKey)` | Low-level direct-play from raw keys, no login (dev/diagnostics). Returns the port. |
| `assetUrl(path)` | Catalog art path → localhost URL (absolute `http(s)` URLs pass through). |
| `prewarm()` | Warm entitled feeds' topics now. |
| `setZapPrefetch(v)` | Runtime Smooth-zapping switch; applies mid-play, echoed as `zap-prefetch {enabled}`. |
| `setNetworkProfile({ expensive })` | Host network hint: `expensive: true` suspends zap-prefetch until the network is cheap again. Wire it to NetInfo (`isConnectionExpensive` / cellular). |
| `setUploadPolicy(policy)` | Live upload-policy flip: re-joins active topics with the new announce flag and tears down standing reseed connections **without blipping playback**. Resolves `{ policy, changed, rejoined }`, echoed as an `upload-policy` event. |
| `reconnectActiveFeed()` | Tear down the active feed's peer connections and dial fresh (the wedged-transport escalation; the tune ladder calls it for you). |
| `stop()` | Full teardown. |

The login retry pattern every host should use:

```js
let streams
for (let i = 0; ; i++) {
  try { streams = await player.login(user, pass); break }
  catch (err) {
    if (i < 30 && /not connected to panel/.test(String(err.message))) {
      await new Promise(r => setTimeout(r, 1000)); continue
    }
    throw err
  }
}
```

---

## 5. The `resolve()` contract

```js
const r = await player.resolve(streamId)
// r = { url, source: 'p2p' | 'cdn', localUrl?, port?, feedKey, type: 'live' | 'vod', durationSec? }
```

- **P2P stream** → `source: 'p2p'`, `url` = `localUrl` =
  `http://127.0.0.1:<port>/index.m3u8`. The feed replicates and is served
  progressively (bytes reach the player as they arrive; playlist requests are held
  briefly instead of 404ing; the live edge is read ahead).
- **VOD title** (a library title, `type:'vod'` in the catalog) → same
  localhost serving, but the playlist is a **finished** VOD rendition
  (`#EXT-X-PLAYLIST-TYPE:VOD`, every segment listed, `#EXT-X-ENDLIST`): seek freely —
  any byte of any segment is Range-served and demand-paged over P2P — and pause
  indefinitely. `type` is `'vod'` and `durationSec` carries the runtime (`null` if
  the catalog lacks it). **None of the live machinery arms**: no tune watchdog, no
  zap prefetch, no `feed-changed` follow (a re-ingest applies on the *next*
  `resolve()`), and no `status`/`error` self-heal events for it — a stalled download
  is the host player's to surface, with `reconnectActiveFeed()` as the manual
  redial. Build seek/pause UI off `type === 'vod'`, never off a URL shape.
- **Redirect channel** → `source: 'cdn'`, `url` is the operator's remote URL
  **verbatim**, `localUrl`/`port` are `undefined`, `feedKey` is `null`. No feed, no
  swarm join, no watchdogs — remote-URL errors belong to the host player.
- **Not entitled** → throws `not entitled to <id>`.
- **Entitled but no broadcaster feeding it** (`feedKey` null in the catalog) →
  throws `channel is not broadcasting right now` (vod: `title is not available
  right now`) — show it as a friendly state, not a crash.

One localhost URL serves *whatever feed is active*: zapping re-uses the same
server/port. That's why the RN binding identifies the playing channel by the
engine's confirmation, never by URL — do the same in custom hosts.

---

## 6. Events reference

`player.on(name, fn)` — the emitter never throws on unhandled `error`.

| Event | Payload | Host action |
|---|---|---|
| `ready` | — | `connect()` finished; safe to `login()`. |
| `streams` | `Stream[]` | Render the lineup. Fires at login **and live** on any panel catalog edit (title/art/isLive/order/categories) — no polling, no re-login. A newly *granted* stream still needs the next login. |
| `status` | `{ state: 'feed:open' \| 'feed:ready' \| 'feed:retune' \| 'feed:reconnect' }` | Drive a tuning indicator: `open` = cold tune started, `ready` = playable, `retune`/`reconnect` = self-heal in progress (say "reconnecting…", don't freeze a spinner at a fake %). |
| `peers` | `number` | Peer count of the served feed, every 3 s while serving. |
| `feed-changed` | `{ streamId, feedKey, url }` | The watched stream's feedKey rotated (broadcaster restart/rotation). The engine already re-resolved and swapped the served feed behind the **same** `url` — reload/remount the player to flush the stale playlist. No re-login, no `resolve()`. |
| `zap-prefetch` | `{ enabled? }` or `{ state: 'suspended' \| 'resumed', reason: 'metered' \| 'stall' \| 'thin' }` | Reflect the Smooth-zapping toggle / adaptive gate in UI if you surface it. |
| `upload-policy` | `{ policy, rejoined }` | Confirmation of a live `setUploadPolicy()`. |
| `recovered` | `Error` | Corrupt store purged + retried automatically; informational. |
| `error` | `Error` | Friendly, surfaced failures (e.g. the tune-timeout message). Show, offer retry. |
| `fallback`, `source-changed` | see `index.d.ts` | Internal hybrid mode only — production apps never receive them. |

---

## 7. React Native binding configuration

### `AliranBackend`

```ts
const backend = new AliranBackend()
backend.start(bundle, opts /* StartOptions */)
```

`StartOptions` = `{ panelPubKey, hybrid?, prewarm?, tune?, zapPrefetch?, swarm?, uploadPolicy?, debug? }`
— the same knobs as §3 with two differences: `hybrid.cdnUrl` must be a **template
string** (functions can't cross the worklet IPC), and `debug: true` logs every
backend message (`adb logcat -s ReactNativeJS`). The worklet owns `storeDir`.

Methods: `login(u,p)` · `play(streamId)` · `playRaw(feedKey, encKey)` ·
`reconnect()` · `setZapPrefetch(v)` · `setNetworkProfile(expensive, cellular?)` ·
`onMessage(fn)` (returns an unsubscribe) · prefs: `requestPrefs()` /
`saveCredentials(u,p)` / `clearCredentials()` / `toggleFavorite(id)` /
`isFavorite(id)`.

Cached state for late-mounting screens (the one-shot replies may land before your
screen exists): `backend.streams`, `.port`, `.url`, `.source`, `.activeStreamId`
(the engine-confirmed playing channel — the thing to trust, since one URL serves
every channel), `.creds`, `.favorites`.

Messages arrive as the `BackendMessage` union (`streams`, `port`, `status`,
`error`, `login-error`, `fallback`, `source-changed`, `feed-changed`,
`zap-prefetch`, `prefs`) — all typed in the package.

### `<AliranVideo>`

Chrome-free video surface; overlays belong to the host app via callbacks
(`client/src/screens/LiveScreen.tsx` is a complete dogfooded example).

| Prop | Purpose |
|---|---|
| `backend`, `streamId` | Required wiring. |
| `autoPlay`, `paused`, `controls`, `style`, `resizeMode` | Standard surface control. |
| `onTune(e)` | **Drive your tuning indicator from this**, not raw player events: after a zap the *previous* channel keeps playing under the same URL until the engine flips the feed. Phases per monotonic tune `id`: `start` → (`retune` \| `reconnect` — self-heal, show "reconnecting") → `playing` (first real playback of *this* tune — dismiss). The friendly tune-timeout arrives via `onError` and ends the tune. |
| `onPeers`, `onBuffering`, `onSource`, `onError` | Status surface. |
| `onFeedChanged` | Informational — the component already remounts itself on feed rotation. |
| `onStall` | Fired when the frozen-live-edge self-heal kicks in (playhead still for `stallTimeoutMs` while "playing" → resync remount at the live edge → escalate to `backend.reconnect()` if a resync mount doesn't play within another window). |
| `stallTimeoutMs` | Default 12 000 — the freeze detector above. |
| `bufferConfig` | Merged over the zap-tuned ExoPlayer defaults (playback starts at ~1 s buffered instead of ~2.5 s). Raise if your feeds need more headroom. |
| `selectedAudioTrack`, `selectedTextTrack`, `onAudioTracks`, `onTextTracks` | In-stream audio/subtitle track selection. |
| `videoProps` | Escape hatch: extra props onto the underlying `react-native-video`. |

### EPG (program guide)

Catalog entries may carry `epgUrl`/`epgId` pointers (schedule data is **never** in
the replicated catalog). The binding ships the data layer:

```ts
import { useEpg } from '@aliran/react-native'
const { data, loaded } = useEpg(stream.epgUrl, stream.epgId) // { now, next[] }
```

`EpgService` (or the shared `epg` singleton) underneath: per-URL cache with ETag
revalidation, one fetch covers every channel sharing the URL. Options
(`EpgServiceOpts`): `maxBytes` (8 MiB), `minRefetchMs` (5 min), `maxAgeMs` (3 h),
`fetchTimeoutMs` (15 s), `nextCount` (4), plus injectable `fetchImpl`/`now` for
tests. Playback never depends on it — a missing/unreachable feed just yields no
guide.

---

## 8. Sessions, devices, and cooperative revocation

`login()` enrolls a device (subject to the account's `maxDevices`; oldest is
evicted) and the panel signs a session token. Two helpers ship for hosts that keep
sessions across launches:

- `checkSession(panelPubKey, token)` — **offline**: signature + expiry → payload or
  `null`.
- `sessionLive(db, payload)` — **online**: the device is still enrolled with a
  matching `tokenVersion` in the replicated user record. This is what notices an
  admin's per-device revoke — a well-behaved client drops to the login screen.

This is cooperative session hygiene, not content protection: real access
revocation is grant removal + stream-key rotation on the operator side
([details](ops-sdk-integration.md#8-what-revocation-really-means)).

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `login` throws `not connected to panel` | DHT still dialing — retry loop (§4). Persisting >30 s: wrong `panelPubKey`, or the panel is down/unreachable. |
| `channel is not broadcasting right now` | Catalog entry exists but no feedKey — the broadcaster hasn't fed it (or is stopped). Operator-side state; show it gracefully. |
| Tune-timeout errors on one channel | The channel may be unreachable/unseeded right now; the message says to switch to it again — the ladder already evicted the poisoned open, so a re-zap retries fresh. |
| Black video, audio fine (or instant player error) on some channels | Device lacks the codec (HEVC lineup on an h264-only device) — [source compatibility](kb/source-compatibility.md). |
| Release APK can't play (dev build can) | Cleartext-to-loopback missing — [client build](client-build.md). |
| `recovered` events after crashes | Normal: the disposable store self-healed. Frequent recoveries = the host is killing the process uncleanly. |
| First zap slow, later zaps fast | Cold DHT lookup. Enable `prewarm`. |

Deeper playback internals: [playback & client runtime](kb/playback.md) and the
[feed buffer & tuning](kb/feed-buffer.md) pages.
