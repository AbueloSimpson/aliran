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

Events: `ready` · `streams` (display list) · `status` (`{state: 'feed:open'|'feed:ready'}`)
· `peers` (count, every 3 s while serving) · `recovered` (corrupt store purged + retried)
· `error`. The emitter never throws on unhandled `error`.

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

The app's worklet (`client/backend/backend.mjs`) is a thin IPC shell over `player.js`.

## Tests

- `npm test` (from `sdk/`) — fast unit tests, no network.
- `npm run test:sdk` (repo root) — headless e2e: real panel + broadcaster, SDK
  login → resolve → ffprobe-validated HLS over P2P. Needs ffmpeg/ffprobe on PATH.

Coming next (see ROADMAP): hybrid CDN↔P2P failover/auto-return (S10b) and a
React Native `<AliranVideo>` binding (S10c).
