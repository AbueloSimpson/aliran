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

## Redirect channels — the CDN path

A catalog entry can be a **redirect channel** instead of a P2P feed: the admin panel
stores `{ redirect: true, url: 'https://…' }` on the record, and `resolve()` returns
that URL verbatim with `source: 'cdn'` and **no `port`** — no feed open, no swarm
join, no watchdogs. The host player fetches the URL directly (any HLS the platform
player supports); its errors are the host's to surface. Because the URL rides the
replicated catalog, an admin edit reaches viewers on their **next tune** — no
re-login. Entitlement is unchanged: the channel appears only for granted users.

This is the **only** CDN mechanism in the product. A channel is either P2P (kept
playing by the tune self-heal ladder) or a redirect — **P2P channels have no CDN
failover, by design**.

## Hybrid mode (internal — test harness only)

The engine retains a config-driven `hybrid` option
(`mode: 'p2p-only'|'hybrid'|'cdn-only'`, a global `cdnUrl` template, and the
`fallback` / `source-changed` events) from before redirect channels existed. It is
**not a product path** — the app never configures it — and it survives as
infrastructure for the e2e harness (`test:sdk` uses it to prove the
serving-health verdicts). Leave it unset: the default `p2p-only` is the shipped
behavior.

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
  full bitrate while playing). `true` = the adaptive defaults below, or pass an
  object to tune `{ neighbors, intervalMs, directional, stallMs, resumeMs,
  minHeadroom }`.

### Smooth zapping (S21): runtime toggle + adaptive gate

`zapPrefetch` is designed to be a **user-facing choice** (the app surfaces it as
"Smooth zapping — uses more data"):

- **Runtime switch** — `player.setZapPrefetch(true | false | cfg)` applies mid-play:
  OFF stops the warm loop and drops every standing download instantly; ON re-arms
  against the active stream. Echoed as a `'zap-prefetch'` `{enabled}` event.
- **Adaptive gate** — prefetch must never compete with playback or surprise someone
  on a paid connection, so the engine suspends the warm loop (dropping its
  downloads, keeping the tick alive to observe recovery) whenever:
  - the host reports a **metered/expensive network** via
    `player.setNetworkProfile({ expensive })` (lifts the moment it is cheap again);
  - the **active playlist stops advancing** for `stallMs` (default 12 s — the
    viewer's own stream is starving); resumes after `resumeMs` (default 60 s) of
    clean advance;
  - neighbor segments download **slower than `minHeadroom`× realtime** (default 3×,
    two thin samples in a row) — the pipe has no room for a second stream.
  Suspensions/resumes surface as `'zap-prefetch'` `{state:'suspended',reason}` /
  `{state:'resumed'}` events (`reason: 'metered' | 'stall' | 'thin'`).
- **Directional** (`directional: true`, the default) — once the viewer's surf
  direction is known (an adjacent-channel move), only that side is warmed, halving
  the standing cost for the common CH+/CH+/CH+ pattern; a menu jump resets to both
  sides. The channel just left stays warm in the feed cache regardless.

## Upload policy

`createPlayer({ uploadPolicy: 'reseed' | 'client-only' })` — `'reseed'` (default)
joins feed/assets topics announced (`server: true`): blocks this viewer replicated
are served back to other viewers on request (opportunistic, demand-driven upload
that strengthens the swarm). `'client-only'` joins **unannounced** (`server:
false`): the peer is not discoverable on those topics, so other viewers can never
dial it — practically **zero viewer-to-viewer upload** by construction, at the
swarm-wide cost of one fewer re-seeder. Boot-time option. See
`docs/kb/viewer-bandwidth.md` for measured numbers.

## Swarm tuning (seed nodes)

`createPlayer({ swarm: { maxPeers } })` raises the total-connection budget of the
engine's single Hyperswarm (lib default 64 — plenty for a viewer). Ordinary viewers
should omit it; SDK-based **seed nodes** and the repeater appliance raise it into the
hundreds so they can hold big fan-out while re-seeding.

`swarm: { bootstrap: [{ host, port }, …] }` points the engine at custom DHT
bootstrap nodes — for local DHT testnets (`hyperdht/testnet.js`, used by
`test:repeater`) or private-DHT deployments. Omit it for the public DHT.

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
