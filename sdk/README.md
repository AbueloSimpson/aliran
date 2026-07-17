# @aliran/player-sdk

Headless Aliran player engine — the same core the Android app's Bare worklet runs,
usable from any Node (or Bare) host. It connects to a panel over the DHT, replicates
the signed catalog DB, performs the OPRF login (no plaintext password ever leaves the
process), and serves entitled encrypted feeds + catalog art on a localhost Range HTTP
server that any HLS-capable player can consume.

```js
import { createPlayer } from '@aliran/player-sdk'

const player = createPlayer({ panelPubKey, storeDir: './aliran-store' })
player.on('peers', (n) => console.log(n, 'peers'))

await player.connect()                    // join the panel topic ('ready')
const streams = await player.login(user, pass) // display list ('streams'); retry while
                                               // 'not connected to panel' (DHT dialing)
const { localUrl } = await player.resolve(streams[0].id)
// -> point ffplay / ExoPlayer / hls.js at localUrl (e.g. http://127.0.0.1:PORT/index.m3u8)
```

## API

`createPlayer(opts)` (Node) or `new AliranPlayer({ ...opts, http, fs })` (any runtime —
inject `node:http`/`node:fs` or `bare-http1`/`bare-fs`):

| Member | Description |
|---|---|
| `connect(panelPubKey?)` | Join the panel topic + replicate its signed DB. Emits `ready`. |
| `login(username, password)` | OPRF login. Returns/emits the **display list** (id, title, description, category, isLive, poster/backdrop/logo as localhost URLs — stream keys stay inside the engine). Throws `not connected to panel` while the swarm is still dialing: retry. |
| `listStreams()` | Last display list. |
| `resolve(streamId)` | → `{ localUrl, port, feedKey }` — replicates the entitled feed (and re-seeds it) and serves it on localhost. |
| `serveFeed(feedKey, encKey)` | Low-level direct-play by raw keys (no login). Returns the port. |
| `assetUrl(path)` | Catalog art path → localhost URL (after login). |
| `stop()` | Full teardown. |

Events: `ready` · `streams` (display list — emitted at login, and **re-emitted live**
whenever the panel edits the catalog: the SDK watches the replicated `catalog/` range,
so title/isLive/art changes push to the host without polling or re-login; a newly
*granted* stream still requires the next login) · `status`
(`{state: 'feed:open'|'feed:ready'}`) · `peers` (count, every 3 s while serving) ·
`recovered` (corrupt store purged + retried) · `error` ·
`fallback` (`{streamId, url, reason: 'timeout'|'stall'}`) ·
`source-changed` (`{streamId, source, url}`) ·
`feed-changed` (`{streamId, feedKey, url}` — the stream being watched had its `feedKey`
rotated in the catalog (broadcaster source change / RAM restart); the SDK re-resolved and
swapped the served feed behind the **same** localhost `url`, so the host just reloads the
player to flush the stale playlist — no re-login or `resolve()` needed). The emitter never
throws on unhandled `error`.

## Hybrid CDN↔P2P

Pass a `hybrid` config to fail over to a CDN when P2P isn't healthy — and return
automatically when it is:

```js
const player = createPlayer({
  panelPubKey,
  hybrid: {
    mode: 'hybrid',              // 'p2p-only' (default) | 'hybrid' | 'cdn-only'
    start: 'preferP2P',          // or 'preferCDN' (start on CDN, probe to P2P)
    cdnUrl: (id) => `https://cdn.example.com/${id}/index.m3u8`, // or '…/{streamId}/…' template
    readyTimeoutMs: 8000,        // max wait for the P2P playlist before falling back
    rebufferMsToFallback: 10000, // P2P playlist stalls this long -> fall back
    probeIntervalMs: 5000        // background P2P health probe while on CDN
  }
})
const { url, source } = await player.resolve(streamId) // url = the ACTIVE source
player.on('fallback', ({ url }) => video.src = url)         // P2P -> CDN
player.on('source-changed', ({ url }) => video.src = url)   // CDN -> P2P (auto-return)
```

The SDK never decodes video: it exposes the current source URL (`resolve()` /
`source()`) and switches it based on playlist health in the feed replica (present
within `readyTimeoutMs`, advancing between probes). While on CDN the feed keeps
replicating in the background — the DHT lookup is re-run on every probe so a
broadcaster that comes up later is found quickly — and after two consecutive
advancing probes playback is handed back to P2P. With `mode: 'p2p-only'` (the
default, used by the app worklet) behavior is exactly the pre-hybrid engine.

## Zap latency

The localhost server (`serve.js`, shared with the desktop tools) is tuned for fast
channel switching: segment bodies stream **block-progressively** (bytes reach the
player as they replicate — no waiting for the full blob), a not-yet-replicated
playlist/segment request is **held briefly and served on arrival** instead of 404ing,
and each playlist request **read-aheads the newest segments in parallel**. Two
warm-up options stack on top:

- `prewarm` — open entitled feeds' DHT topics right after login so the *first* zap is
  warm. `false` (default) | `true` (all) | integer cap (lowest curated order first).
  Bandwidth-cheap: warms connections, not downloads.
- `zapPrefetch` — while a stream plays, keep the **newest segment** of the
  next/previous channels in curated zap order replicated locally, so CH+/CH− starts
  from warm bytes. **Off by default — costs standing bandwidth** (≈ each neighbor's
  full bitrate while playing). `true` = `{ neighbors: 1, intervalMs: 3000 }`, or pass
  the object to tune.

## Swarm tuning (seed nodes)

`createPlayer({ swarm: { maxPeers } })` raises the total-connection budget of the
engine's single Hyperswarm (lib default 64 — plenty for a viewer). Ordinary viewers
should omit it; SDK-based **seed nodes** and the repeater appliance raise it into the
hundreds so they can hold big fan-out while re-seeding.

The on-disk store is a **disposable replica cache**: corruption (e.g. a crash mid-write →
`OPLOG_CORRUPT`) is detected, the store is purged and the operation retried once —
in-memory entitlements survive, everything re-replicates from peers (`recover.js`,
verified by `npm run test:corrupt`).

**Partial adoption:** you can keep your own catalog/metadata and use only
`login()` + `resolve()` for the video URL — video travels P2P, metadata stays yours.

## Layout

- `player.js` — runtime-agnostic engine (`{ http, fs }` injected; no Node/Bare imports)
- `index.js` — Node entry (wires `node:http`/`node:fs`; exports `createPlayer`)
- `login.js` — OPRF login protocol (canonical home; `client/backend/login.mjs` re-exports)
- `recover.js` — store-corruption recovery (canonical home)
- `serve.js` — progressive media-serving core (availability wait, Range, read-ahead;
  also behind `tools/lib/serve-drive.js`)

The app's worklet (`client/backend/backend.mjs`) is a thin IPC shell over `player.js`.

## Tests

- `npm test` (from `sdk/`) — fast unit tests, no network.
- `npm run test:sdk` (repo root) — headless e2e: real panel + broadcaster, SDK
  login → resolve → ffprobe-validated HLS over P2P. Needs ffmpeg/ffprobe on PATH.
- `npm run test:serve` (repo root) — deterministic serving-core test: progressive
  first-byte-before-full-blob, availability wait, Range math, playlist read-ahead.

For React Native apps, see **[`@aliran/react-native`](react-native/README.md)** — a
drop-in `<AliranVideo>` component + worklet host built on this engine.
