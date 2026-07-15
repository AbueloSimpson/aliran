// @aliran/player-sdk — headless Aliran player engine, runtime-agnostic (Node + Bare).
//
// Extracted from the app's Bare worklet backend (client/backend/backend.mjs), which is
// now a thin IPC shell over this class — one engine for the app and for integrators.
// The engine: connect to a panel (replicate the signed DB + login RPC over the DHT),
// OPRF-login, then serve entitled encrypted feeds and catalog art on a localhost Range
// HTTP server that any HLS-capable player can consume.
//
// Runtime modules are INJECTED: pass { http, fs } — node:http/node:fs in Node (see
// index.js for the convenience entry), bare-http1/bare-fs in the Bare worklet. This
// file must stay free of runtime-specific imports so one graph bundles for both.
//
// The on-disk store is a DISPOSABLE replica cache. If a previous process died
// mid-write, opening a core can fail permanently (OPLOG_CORRUPT et al) — recovery
// purges the whole store and retries once (see recover.js); everything re-replicates
// from peers and the in-memory session (entitled stream keys) survives.
//
// Events (no throw on unhandled 'error'):
//   'ready'              connected to the panel topic (login may still need to dial)
//   'streams' (list)     display catalog (no keys inside): after a successful login,
//                        and re-emitted live whenever the panel edits the catalog
//                        (title/isLive/art/... — no polling, no re-login)
//   'status'  ({state})  breadcrumbs: 'feed:open' | 'feed:ready'
//   'peers'   (count)    feed-health ticker while a stream is being served
//   'recovered' (err)    a corrupt store was purged and the operation retried
//   'error'   (err)      background failures that have no caller to throw to
//   'fallback' ({streamId,url,reason})        hybrid: P2P unhealthy -> switched to CDN
//   'source-changed' ({streamId,source,url})  hybrid: active source switched (e.g. back to P2P)
//   'feed-changed' ({streamId,feedKey,url})   the ACTIVE stream's catalog feedKey rotated
//                        underneath the viewer (broadcaster source change / RAM restart):
//                        the SDK re-resolved and swapped the served feed WITHOUT a new
//                        resolve() call. url is the unchanged localhost URL — the host
//                        just reloads the player to flush the stale playlist/segments.
//
// Hybrid CDN<->P2P (S10b): pass `hybrid` config to choose the active source per play.
// The SDK never decodes video — it exposes the CURRENT source URL + health signals and
// keeps replicating the P2P feed in the background while on CDN so it can auto-return.
// Health is playlist-based: the feed is "ready" when /index.m3u8 exists in the replica,
// and "advancing" when its content changes between probes (live edge moving). Playback
// stalls the host player would see show up here as a non-advancing playlist.

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { panelClient, login as oprfLogin } from './login.js'
import { isCorruptionError, withRecovery } from './recover.js'

// Minimal emitter: unlike node:events it exists in both runtimes and never throws on
// an unhandled 'error' event (SDK errors surface to callers as rejections instead).
class Emitter {
  constructor () { this._events = {} }
  on (name, fn) { (this._events[name] = this._events[name] || new Set()).add(fn); return this }
  off (name, fn) { const s = this._events[name]; if (s) s.delete(fn); return this }
  once (name, fn) { const g = (...a) => { this.off(name, g); fn(...a) }; return this.on(name, g) }
  emit (name, ...args) {
    const s = this._events[name]
    if (!s || !s.size) return false
    for (const fn of [...s]) { try { fn(...args) } catch {} }
    return true
  }
}

// Hybrid defaults: p2p-only keeps the pre-hybrid behavior exactly (the app worklet
// runs with this). cdnUrl may be a function (streamId => url) or a template string
// containing '{streamId}'.
function normalizeHybrid (h) {
  const cfg = {
    mode: 'p2p-only',
    start: 'preferP2P',
    cdnUrl: null,
    readyTimeoutMs: 8000,
    rebufferMsToFallback: 10000,
    probeIntervalMs: 5000,
    ...h
  }
  if (!['p2p-only', 'hybrid', 'cdn-only'].includes(cfg.mode)) throw new Error('hybrid.mode must be p2p-only | hybrid | cdn-only')
  if (!['preferP2P', 'preferCDN'].includes(cfg.start)) throw new Error('hybrid.start must be preferP2P | preferCDN')
  if (cfg.mode !== 'p2p-only') {
    if (typeof cfg.cdnUrl === 'string') { const tpl = cfg.cdnUrl; cfg.cdnUrl = (id) => tpl.replace('{streamId}', id) }
    if (typeof cfg.cdnUrl !== 'function') throw new Error('hybrid.cdnUrl (function or template string) is required for mode ' + cfg.mode)
  }
  return cfg
}

// prewarm: after login, open+join entitled feeds in the background so the FIRST zap to
// a channel is warm (the cold DHT discovery + handshake are paid upfront, off the play
// path). false (default) = off; true = all entitled feeds; a positive integer = cap to
// that many (lowest curated order first — the channels a viewer is likeliest to reach).
function normalizePrewarm (v) {
  if (v === true) return Infinity
  if (v === false || v == null) return 0
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error('prewarm must be a boolean or a non-negative integer')
  return n
}

export class AliranPlayer extends Emitter {
  constructor ({ panelPubKey, storeDir = './aliran-store', http, fs, hybrid, prewarm } = {}) {
    super()
    if (!http || !fs) throw new Error('AliranPlayer needs injected { http, fs } runtime modules (use index.js in Node)')
    this._hybrid = normalizeHybrid(hybrid)
    this._prewarmN = normalizePrewarm(prewarm)
    this._active = null // current play state: { streamId, feedKey, localUrl, cdnUrl, source, lastSig, lastAdvance }
    this._watchTimer = null // P2P stall watchdog (while source === 'p2p')
    this._probeTimer = null // P2P recovery probe (while source === 'cdn')
    this._panelKey = panelPubKey || null
    this._storeDir = storeDir
    this._http = http
    this._fs = fs
    this._store = null
    this._swarm = null
    this._panelBee = null
    this._catalogWatcher = null
    this._call = null
    this._server = null
    this._assetsDrive = null
    this._feedDrive = null // the CURRENTLY served feed (one of _feeds' drives)
    this._feedDiscovery = null
    this._feeds = new Map() // feedKey:encKey -> Promise<{ drive, discovery }> — opened feeds (single-flight), reused across resolve()s
    this._statusTimer = null
    this._assetsOpen = null
    this._purging = null
    this._streams = []
    this._entitled = new Map() // streamId -> { feedKey, encryptionKey }
  }

  // --- public API ---

  // Join the panel's topic and replicate its signed DB. Resolves once the topic is
  // joined (the actual socket dials in the background — login retries cover the gap).
  async connect (panelPubKey) {
    if (panelPubKey) this._panelKey = panelPubKey
    if (!this._panelKey) throw new Error('no panelPubKey configured')
    await this._recover(() => this._openPanel())
    this.emit('ready')
  }

  // OPRF login. Returns (and caches, and emits as 'streams') the DISPLAY list: id,
  // title, description, category, isLive, poster/backdrop/logo as localhost URLs —
  // stream keys stay inside the engine. Throws on failure ('not connected to panel'
  // is the transient one while the swarm dials).
  async login (username, password) {
    const streams = await this._recover(() => this._doLogin(username, password))
    this._streams = streams
    this.emit('streams', streams)
    if (this._prewarmN) this.prewarm().catch(() => {}) // background warm the lineup — never blocks login
    return streams
  }

  // Open + join entitled feeds ahead of play so the FIRST zap to a channel is warm: the
  // cold DHT lookup + peer handshake happen now, in the background, instead of on the
  // play path. Best-effort and idempotent (reuses the feed cache) — safe to call again.
  // Sparse replication means this warms the CONNECTION, not a full download: segments
  // still only transfer when a feed is actually served, so the bandwidth cost is small.
  async prewarm () {
    const n = this._prewarmN
    if (!n || this._hybrid.mode === 'cdn-only' || !this._entitled.size) return
    // Warm lowest curated order first (viewers start at ch1 and zap up); fall back to
    // login order for uncurated streams.
    const rank = new Map(this._streams.map((s, i) => [s.id, (s.order ?? 1e9) * 1e6 + i]))
    const ids = [...this._entitled.keys()]
      .sort((a, b) => (rank.get(a) ?? 1e15) - (rank.get(b) ?? 1e15))
      .slice(0, n === Infinity ? undefined : n)
    await Promise.all(ids.map(async (id) => {
      try {
        const k = this._entitled.get(id)
        if (!k || !k.encryptionKey) return
        const feedKey = await this._currentFeedKey(id, k.feedKey)
        if (feedKey) await this._openFeed(feedKey, k.encryptionKey)
      } catch { /* prewarm is best-effort; a real play will retry */ }
    }))
  }

  // Last display list from a successful login.
  listStreams () { return this._streams }

  // Start (or reuse) the localhost server for an entitled stream and return where to
  // point the host's video player. `url`/`source` reflect the ACTIVE source under the
  // hybrid policy (p2p-only: always the localhost URL — pre-hybrid shape unchanged).
  async resolve (streamId) {
    const keys = this._entitled.get(streamId)
    if (!keys) throw new Error('not entitled to ' + streamId)
    // Live feeds are SESSION cores under the broadcaster's ephemeral buffer: a
    // restart publishes a fresh feedKey to the catalog while the per-user sealed
    // ENCRYPTION key stays the same. Follow the replicated catalog for the current
    // feedKey (falling back to the login-time value) so viewers survive broadcaster
    // restarts without re-login. A re-KEYED stream (new encryption key) still needs
    // a fresh login — that one is a deliberate access-control boundary.
    const feedKey = await this._currentFeedKey(streamId, keys.feedKey)
    // A catalog entry can exist before any broadcaster feeds it (feedKey null) —
    // surface that honestly instead of leaking a key-length error from hypercore.
    if (this._hybrid.mode !== 'cdn-only' && (!feedKey || !keys.encryptionKey)) {
      throw new Error('channel is not broadcasting right now')
    }
    const cfg = this._hybrid
    this._clearHybridTimers()

    if (cfg.mode === 'cdn-only') {
      const url = cfg.cdnUrl(streamId)
      this._active = { streamId, feedKey, localUrl: null, cdnUrl: url, source: 'cdn', lastSig: null, lastAdvance: 0 }
      return { url, source: 'cdn', localUrl: undefined, port: undefined, feedKey }
    }

    const port = await this.serveFeed(feedKey, keys.encryptionKey)
    const localUrl = `http://127.0.0.1:${port}/index.m3u8`
    if (cfg.mode === 'p2p-only') {
      this._active = { streamId, feedKey, localUrl, cdnUrl: null, source: 'p2p', lastSig: null, lastAdvance: Date.now() }
      return { url: localUrl, source: 'p2p', localUrl, port, feedKey }
    }

    // hybrid: pick the starting source, then keep watching/probing in the background.
    this._active = { streamId, feedKey, localUrl, cdnUrl: cfg.cdnUrl(streamId), source: null, lastSig: null, lastAdvance: Date.now() }
    if (cfg.start === 'preferCDN') {
      this._active.source = 'cdn'
      this._startRecoveryProbe()
    } else if (await this._waitP2PReady(cfg.readyTimeoutMs)) {
      this._active.source = 'p2p'
      this._startStallWatchdog()
    } else {
      this._active.source = 'cdn'
      this.emit('fallback', { streamId, url: this._active.cdnUrl, reason: 'timeout' })
      this._startRecoveryProbe()
    }
    const url = this._active.source === 'p2p' ? localUrl : this._active.cdnUrl
    return { url, source: this._active.source, localUrl, port, feedKey }
  }

  // Current active source for the last resolve(), or null.
  source () {
    const a = this._active
    if (!a) return null
    return { streamId: a.streamId, source: a.source, url: a.source === 'p2p' ? a.localUrl : a.cdnUrl }
  }

  // Low-level: replicate an encrypted feed by its keys and serve it on localhost with
  // Range support. Returns the port. (resolve() is the entitlement-checked path; this
  // one also powers the dev direct-play IPC message.)
  //
  // Opened feeds are cached by key and REUSED across resolve()s. Zapping back to a
  // channel already served this session must NOT open a second Hyperdrive over the same
  // store namespace — that call's ready() deadlocks against the still-open first drive
  // (the old code leaked it and wedged on the flip-back). Reuse makes a re-zap
  // near-instant: the replica is already warm. Cached feeds keep replicating in the
  // background (their swarm topic stays joined) until stop()/a recovery purge closes
  // them, so recently-watched channels stay ready to zap back to.
  async serveFeed (feedKeyHex, encKeyHex) {
    // feed:open marks a COLD open (nothing cached yet). A prewarmed / recently-served
    // feed skips it — the host player sees only feed:ready, i.e. an instant switch.
    if (!this._feeds.has(feedKeyHex + ':' + encKeyHex)) this.emit('status', { state: 'feed:open' })
    const feed = await this._openFeed(feedKeyHex, encKeyHex)
    this._feedDrive = feed.drive
    this._feedDiscovery = feed.discovery
    this.emit('status', { state: 'feed:ready' })
    const port = await this._ensureServer()
    // Feed-health ticker for player overlays: how many peers serve the CURRENT feed.
    if (!this._statusTimer) {
      this._statusTimer = setInterval(() => {
        if (this._feedDrive) this.emit('peers', this._feedDrive.core.peers.length)
      }, 3000)
    }
    return port
  }

  // Open (or return the cached) feed drive for a key pair: replicate it and join its
  // swarm topic. No side effects on the ACTIVE feed or status — serveFeed() makes it
  // current, prewarm() just warms it. SINGLE-FLIGHT: the cache stores the open PROMISE,
  // so a prewarm and a concurrent zap for the same feed share ONE Hyperdrive (opening a
  // second over the same store namespace would deadlock — the very bug this cache fixes).
  // Cached in this._feeds and closed by stop()/purge.
  _openFeed (feedKeyHex, encKeyHex) {
    const cacheKey = feedKeyHex + ':' + encKeyHex
    let feed = this._feeds.get(cacheKey)
    if (!feed) {
      feed = (async () => {
        const drive = await this._recover(async () => {
          await this._ensureStore()
          const d = new Hyperdrive(this._store.namespace('replica:' + feedKeyHex), b4a.from(feedKeyHex, 'hex'), { encryptionKey: b4a.from(encKeyHex, 'hex') })
          await d.ready()
          return d
        })
        const discovery = this._swarm.join(drive.discoveryKey, { server: true, client: true }) // pull + re-seed
        return { drive, discovery }
      })()
      this._feeds.set(cacheKey, feed)
      feed.catch(() => { if (this._feeds.get(cacheKey) === feed) this._feeds.delete(cacheKey) }) // drop a failed open so a retry re-opens
    }
    return feed
  }

  // Current feedKey for a stream: follow the replicated catalog (a broadcaster restart
  // publishes a fresh key in RAM-buffer mode), falling back to the login-time value.
  async _currentFeedKey (streamId, fallback) {
    try {
      const node = this._panelBee && await this._panelBee.get('catalog/' + streamId)
      if (node && node.value && node.value.feedKey) return node.value.feedKey
    } catch { /* replicated catalog momentarily unreadable — use the cached key */ }
    return fallback
  }

  // Catalog art fields hold drive paths like 'assets/<id>/poster.png'; turn them into
  // URLs on the local server (undefined until login has started it).
  assetUrl (p) {
    if (!p || !this._server) return undefined
    return `http://127.0.0.1:${this._server.address().port}/${String(p).replace(/^\//, '')}`
  }

  // Full teardown (tests / host shutdown). The worklet never calls this — it dies with
  // the app process.
  async stop () {
    this._clearHybridTimers()
    this._active = null
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null }
    const server = this._server; this._server = null
    if (server) { try { await new Promise((resolve) => server.close(resolve)) } catch {} }
    const watcher = this._catalogWatcher; this._catalogWatcher = null
    if (watcher) { try { await watcher.close() } catch {} }
    this._closeFeeds() // fire-and-forget close of every opened feed (see _closeFeeds)
    const closing = [this._assetsDrive, this._panelBee, this._store]
    this._feedDrive = this._assetsDrive = this._panelBee = this._store = null
    this._feedDiscovery = null
    this._assetsOpen = null
    this._call = null
    if (this._swarm) { const s = this._swarm; this._swarm = null; try { await s.destroy() } catch {} }
    for (const c of closing) { if (c) { try { await c.close() } catch {} } }
  }

  // Close every opened feed and drop them from the cache. Fire-and-forget: the cache
  // holds OPEN PROMISES that may still be in flight (and whose _recover() could be
  // awaiting the very purge that calls this) — awaiting them here risks a deadlock, so
  // schedule each close when its open settles instead.
  _closeFeeds () {
    const feedProms = [...this._feeds.values()]
    this._feeds.clear()
    for (const p of feedProms) Promise.resolve(p).then((f) => f && f.drive && f.drive.close()).catch(() => {})
  }

  // --- hybrid internals ---

  _clearHybridTimers () {
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null }
    if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null }
  }

  // Playlist probe against the current feed replica. Returns a signature (null =
  // playlist not available). Metadata-only (drive.entry, no blob download — cannot
  // hang on missing blocks); the bee seq for the playlist key bumps on every rewrite,
  // so a changing signature means the live edge advances.
  async _playlistSig () {
    try {
      const drive = this._feedDrive
      if (!drive) return null
      const entry = await drive.entry('/index.m3u8')
      return entry ? 'seq:' + entry.seq : null
    } catch {
      return null
    }
  }

  // Initial readiness: the playlist exists in the replica within `timeoutMs`.
  async _waitP2PReady (timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this._playlistSig() !== null) return true
      await new Promise((resolve) => setTimeout(resolve, Math.min(400, timeoutMs)))
    }
    return (await this._playlistSig()) !== null
  }

  // While on P2P: fall back to CDN if the playlist stops advancing for too long
  // (covers both peer loss and a stalled live edge — what the host player would
  // experience as rebuffering).
  _startStallWatchdog () {
    const cfg = this._hybrid
    const a = this._active
    a.lastAdvance = Date.now()
    this._watchTimer = setInterval(async () => {
      if (!this._active || this._active !== a || a.source !== 'p2p') return
      const sig = await this._playlistSig()
      if (sig !== null && sig !== a.lastSig) { a.lastSig = sig; a.lastAdvance = Date.now(); return }
      if (Date.now() - a.lastAdvance > cfg.rebufferMsToFallback) {
        a.source = 'cdn'
        this._clearHybridTimers()
        this.emit('fallback', { streamId: a.streamId, url: a.cdnUrl, reason: 'stall' })
        this._startRecoveryProbe()
      }
    }, Math.min(cfg.probeIntervalMs, 1000))
  }

  // While on CDN: the feed keeps replicating in the background; once the playlist
  // ADVANCES across two consecutive probes (healthy for ~probeIntervalMs), switch the
  // active source back to P2P and tell the host.
  _startRecoveryProbe () {
    const cfg = this._hybrid
    const a = this._active
    let healthyStreak = 0
    this._probeTimer = setInterval(async () => {
      if (!this._active || this._active !== a || a.source !== 'cdn') return
      // Re-run the DHT lookup for the feed topic: a broadcaster that came up AFTER we
      // joined is otherwise only found on hyperswarm's slow periodic refresh.
      try { const r = this._feedDiscovery && this._feedDiscovery.refresh(); if (r && r.catch) r.catch(() => {}) } catch {}
      const sig = await this._playlistSig()
      if (sig !== null && sig !== a.lastSig) { a.lastSig = sig; healthyStreak++ } else if (sig === null) { healthyStreak = 0 }
      if (healthyStreak >= 2) {
        a.source = 'p2p'
        a.lastAdvance = Date.now()
        this._clearHybridTimers()
        this.emit('source-changed', { streamId: a.streamId, source: 'p2p', url: a.localUrl })
        this._startStallWatchdog()
      }
    }, cfg.probeIntervalMs)
  }

  // --- internals (extracted 1:1 from the worklet backend) ---

  async _ensureStore () {
    if (this._store) return
    this._store = new Corestore(this._storeDir)
    await this._store.ready()
    this._swarm = new Hyperswarm()
    // The first connection after connect() is the panel (we join only its topic
    // first); wire the RPC there. Later feed connections are ignored for RPC (call is
    // already set). If the panel socket drops, clear `call` so the next reconnect
    // re-arms it (otherwise every RPC after a drop fails with CHANNEL_CLOSED forever).
    this._swarm.on('connection', (socket) => {
      // A handshake that was in flight when stop()/a recovery purge nulled the store
      // can still land here (swarm.destroy() resolves later) — drop it, don't crash.
      if (!this._store) { try { socket.destroy() } catch {} return }
      this._store.replicate(socket)
      if (!this._call && this._panelBee) {
        const rpcCall = panelClient(socket).call
        this._call = rpcCall
        socket.on('close', () => { if (this._call === rpcCall) this._call = null })
      }
    })
  }

  // Open (or re-open, after a corruption purge) the panel DB and join its topic.
  async _openPanel () {
    await this._ensureStore()
    this._panelBee = new Hyperbee(this._store.get({ key: b4a.from(this._panelKey, 'hex') }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await this._panelBee.ready()
    this._swarm.join(hcrypto.hash(b4a.from(this._panelKey, 'hex')), { client: true, server: false })
    this._watchCatalog()
  }

  // Live catalog push: watch the replicated bee's catalog/ range and re-emit 'streams'
  // whenever a record changes, so hosts update their UI without polling. Armed with
  // the panel DB (also after a recovery purge re-opens it); emits only once a login
  // has established what the user is entitled to see.
  _watchCatalog () {
    if (!this._panelBee) return
    const watcher = this._panelBee.watch({ gt: 'catalog/', lt: 'catalog0' }) // '0' = next char after '/'
    this._catalogWatcher = watcher
    const run = async () => {
      try {
        for await (const _ of watcher) { // eslint-disable-line no-unused-vars
          if (this._catalogWatcher !== watcher) return // superseded by purge/stop
          await this._recover(() => this._pushCatalog())
          await this._maybeReresolveActiveFeed() // follow a rotated feedKey for the stream being watched
        }
      } catch (err) {
        // The bee closing underneath us (stop/purge) ends the watcher — not an error.
        if (this._catalogWatcher === watcher && !this._purging) this.emit('error', err)
      }
    }
    run()
  }

  // Rebuild the display list for the current session from the latest replicated
  // catalog records and emit it. Display-only: the sealed stream keys in _entitled
  // come from the user record at login and are not touched — a stream whose feed was
  // re-keyed (new feedKey in the catalog) needs a fresh login to unseal anyway, and
  // a newly granted stream only appears after the next login.
  async _pushCatalog () {
    if (!this._entitled.size || !this._panelBee) return
    const port = await this._ensureServer()
    const streams = []
    for (const id of this._entitled.keys()) {
      const node = await this._panelBee.get('catalog/' + id)
      if (node && node.value) streams.push(this._display(port, id, node.value))
    }
    this._streams = streams
    this.emit('streams', streams)
  }

  // A stream's feedKey can rotate in the catalog WHILE a viewer is watching it (broadcaster
  // source change / RAM-buffer restart): resolve() only reads the feedKey once, so the
  // active viewer would keep replicating the DEAD feed until they re-zap. Called on every
  // catalog change: if the ACTIVE stream now points at a different feedKey, open it and make
  // it the one served on the (unchanged) localhost port, then emit 'feed-changed' so the host
  // reloads its player. The per-user ENCRYPTION key is unchanged (a re-KEY still needs a fresh
  // login) — only the feedKey moved. Best-effort: never throws (it runs inside the watch loop,
  // whose only failure mode is to stop following the catalog); a failed open simply retries on
  // the next catalog tick since a.feedKey is left untouched.
  async _maybeReresolveActiveFeed () {
    const a = this._active
    if (!a || this._hybrid.mode === 'cdn-only') return // cdn-only never serves the P2P feed
    const keys = this._entitled.get(a.streamId)
    if (!keys || !keys.encryptionKey) return
    // Fallback = the key we're already serving, so a momentarily unreadable catalog (or a
    // channel that just went off-air, feedKey null) is a no-op, never a spurious rotation.
    const feedKey = await this._currentFeedKey(a.streamId, a.feedKey)
    if (!feedKey || feedKey === a.feedKey) return
    let feed
    try { feed = await this._openFeed(feedKey, keys.encryptionKey) } catch { return }
    // A zap during the open moved _active on; leave _feedDrive to that resolve()'s serveFeed
    // (don't clobber it back to this now-stale channel's feed).
    if (this._active !== a) return
    this._feedDrive = feed.drive
    this._feedDiscovery = feed.discovery
    a.feedKey = feedKey
    a.lastSig = null
    a.lastAdvance = Date.now()
    this.emit('status', { state: 'feed:ready' })
    // On CDN under hybrid the recovery probe now tracks the NEW feed and will emit
    // 'source-changed' when it flips back; only tell the host to reload when P2P is live.
    if (a.source === 'p2p') this.emit('feed-changed', { streamId: a.streamId, feedKey, url: a.localUrl })
  }

  // Any open of on-disk replica state can fail with a corruption error if a previous
  // process died mid-write. The store is a disposable cache: purge it, rebuild, retry
  // the op once; a second failure surfaces to the caller as usual.
  _recover (op) {
    return withRecovery(op, () => this._purge(), (err) => this.emit('recovered', err))
  }

  // Single-flight purge: tear down everything holding the store, delete it from disk,
  // and re-arm the panel connection. Feed/assets drives re-open on demand; the
  // in-memory session (entitled stream keys) survives, so no re-login is needed.
  _purge () {
    if (!this._purging) this._purging = this._purgeAndRebuild().finally(() => { this._purging = null })
    return this._purging
  }

  async _purgeAndRebuild () {
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null }
    const watcher = this._catalogWatcher; this._catalogWatcher = null
    if (watcher) { try { await watcher.close() } catch {} } // corrupt bees may refuse; bee close below retries
    this._closeFeeds() // drop every cached feed on the dead store (fire-and-forget; see _closeFeeds)
    const closing = [this._assetsDrive, this._panelBee, this._store]
    this._feedDrive = this._assetsDrive = this._panelBee = this._store = null
    this._feedDiscovery = null
    this._assetsOpen = null
    this._call = null
    if (this._swarm) { const s = this._swarm; this._swarm = null; try { await s.destroy() } catch {} }
    for (const c of closing) { if (c) { try { await c.close() } catch {} } } // corrupt cores may refuse to close
    try { this._fs.rmSync(this._storeDir, { recursive: true, force: true }) } catch {}
    if (this._panelKey) {
      await this._openPanel()
      this._openAssets().catch(() => {}) // posters re-replicate in the background once the panel reconnects
    }
  }

  async _doLogin (username, password) {
    if (!this._call) throw new Error('not connected to panel')
    const { streams } = await oprfLogin(this._call, this._panelBee, username, password)
    await this._openAssets()
    const port = await this._ensureServer() // posters must be loadable before anything plays
    this._entitled.clear()
    return streams.map((s) => {
      this._entitled.set(s.id, { feedKey: s.feedKey, encryptionKey: s.encryptionKey })
      return this._display(port, s.id, s)
    })
  }

  // Catalog record -> display shape handed to hosts (login result and live pushes):
  // metadata only — never the feed/encryption keys — with art paths as localhost URLs.
  // order/featured are the panel's curation hints (S16c): rail sort / hero-wallpaper pick.
  _display (port, id, cat) {
    return {
      id,
      title: cat.title,
      description: cat.description,
      category: cat.category,
      isLive: cat.isLive,
      order: cat.order,
      featured: cat.featured,
      poster: this._artUrl(port, cat.poster),
      backdrop: this._artUrl(port, cat.backdrop),
      logo: this._artUrl(port, cat.logo)
    }
  }

  _artUrl (port, p) {
    if (!p) return undefined
    return `http://127.0.0.1:${port}/${p.replace(/^\//, '')}`
  }

  // Open the panel's assets Hyperdrive (posters/art) so the localhost server can serve
  // /assets/*. Key is advertised in the signed DB under meta/assetsKey. Single-flight:
  // login and post-purge recovery can call this concurrently.
  _openAssets () {
    if (!this._assetsOpen) {
      const p = this._doOpenAssets().then(
        () => { if (this._assetsOpen === p && !this._assetsDrive) this._assetsOpen = null }, // nothing advertised yet — re-check on the next login
        (err) => { if (this._assetsOpen === p) this._assetsOpen = null; throw err }
      )
      this._assetsOpen = p
    }
    return this._assetsOpen
  }

  async _doOpenAssets () {
    if (this._assetsDrive || !this._panelBee) return
    const meta = await this._panelBee.get('meta/assetsKey')
    if (!meta || !meta.value.key) return
    this._assetsDrive = new Hyperdrive(this._store.namespace('assets-replica'), b4a.from(meta.value.key, 'hex'))
    await this._assetsDrive.ready()
    this._swarm.join(this._assetsDrive.discoveryKey, { client: true, server: true })
  }

  // One persistent localhost server for the whole session: /assets/* is served from
  // the panel's assets drive (posters/art), everything else from the currently playing
  // feed. The port never changes, so asset URLs handed out at login stay valid.
  async _ensureServer () {
    if (!this._server) {
      this._server = this._http.createServer(this._requestHandler())
      await new Promise((resolve) => this._server.listen(0, '127.0.0.1', resolve))
    }
    return this._server.address().port
  }

  // Range-capable Hyperdrive request handler for HLS players (and poster art).
  _requestHandler () {
    const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
    const ctype = (p) => { const i = p.lastIndexOf('.'); return (i >= 0 && TYPES[p.slice(i).toLowerCase()]) || 'application/octet-stream' }
    return async (req, res) => {
      try {
        let p = decodeURIComponent((req.url || '/').split('?')[0]); if (p === '/') p = '/index.m3u8'
        // /assets/* is served from the panel's assets drive (posters/art).
        let target = this._feedDrive
        if (p.startsWith('/assets/') && this._assetsDrive) { target = this._assetsDrive; p = p.slice('/assets'.length) }
        if (!target) { res.writeHead(404); return res.end('not found') }
        const entry = await target.entry(p)
        if (!entry || !entry.value.blob) { res.writeHead(404); return res.end('not found') }
        const size = entry.value.blob.byteLength
        const range = req.headers.range
        const headers = { 'Content-Type': ctype(p), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range)
          const start = m && m[1] ? parseInt(m[1], 10) : 0
          const end = m && m[2] ? parseInt(m[2], 10) : size - 1
          if (isNaN(start) || isNaN(end) || start > end || end >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end() }
          const wanted = end - start + 1
          res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(wanted) })
          const rs = target.createReadStream(p, { start })
          // The player aborts in-flight requests routinely (source switch, seek,
          // teardown) — writing into the closed response must not become an unhandled
          // stream error (it SIGABRTs the Bare worklet).
          const abort = () => { try { rs.destroy() } catch {} }
          res.on('error', abort)
          res.on('close', abort)
          let sent = 0
          rs.on('data', (chunk) => { if (sent >= wanted) return; const out = sent + chunk.length > wanted ? chunk.subarray(0, wanted - sent) : chunk; sent += out.length; try { res.write(out) } catch { abort(); return } if (sent >= wanted) { try { res.end() } catch {} rs.destroy() } })
          rs.on('end', () => { if (sent < wanted) { try { res.end() } catch {} } })
          rs.on('error', () => { try { res.destroy() } catch {} })
        } else {
          res.writeHead(200, { ...headers, 'Content-Length': String(size) })
          const rs = target.createReadStream(p)
          res.on('error', () => { try { rs.destroy() } catch {} })
          res.on('close', () => { try { rs.destroy() } catch {} })
          rs.on('error', () => { try { res.destroy() } catch {} })
          rs.pipe(res, () => {}) // callback swallows abort errors under streamx (Bare); ignored by Node
        }
      } catch (err) {
        // Corruption can also surface at read time (the blobs core opens lazily): heal
        // in the background; the host player's retry re-opens the feed on the fresh store.
        if (isCorruptionError(err)) this._purge().catch(() => {})
        res.writeHead(500); res.end('server error: ' + (err && err.message))
      }
    }
  }
}
