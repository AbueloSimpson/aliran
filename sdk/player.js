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
//   'streams' (list)     display catalog after a successful login (no keys inside)
//   'status'  ({state})  breadcrumbs: 'feed:open' | 'feed:ready'
//   'peers'   (count)    feed-health ticker while a stream is being served
//   'recovered' (err)    a corrupt store was purged and the operation retried
//   'error'   (err)      background failures that have no caller to throw to

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

export class AliranPlayer extends Emitter {
  constructor ({ panelPubKey, storeDir = './aliran-store', http, fs } = {}) {
    super()
    if (!http || !fs) throw new Error('AliranPlayer needs injected { http, fs } runtime modules (use index.js in Node)')
    this._panelKey = panelPubKey || null
    this._storeDir = storeDir
    this._http = http
    this._fs = fs
    this._store = null
    this._swarm = null
    this._panelBee = null
    this._call = null
    this._server = null
    this._assetsDrive = null
    this._feedDrive = null
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
    return streams
  }

  // Last display list from a successful login.
  listStreams () { return this._streams }

  // Start (or reuse) the localhost server for an entitled stream and return where to
  // point the host's video player.
  async resolve (streamId) {
    const keys = this._entitled.get(streamId)
    if (!keys) throw new Error('not entitled to ' + streamId)
    const port = await this.serveFeed(keys.feedKey, keys.encryptionKey)
    return { localUrl: `http://127.0.0.1:${port}/index.m3u8`, port, feedKey: keys.feedKey }
  }

  // Low-level: replicate an encrypted feed by its keys and serve it on localhost with
  // Range support. Returns the port. (resolve() is the entitlement-checked path; this
  // one also powers the dev direct-play IPC message.)
  async serveFeed (feedKeyHex, encKeyHex) {
    this.emit('status', { state: 'feed:open' })
    const drive = await this._recover(async () => {
      await this._ensureStore()
      const d = new Hyperdrive(this._store.namespace('replica:' + feedKeyHex), b4a.from(feedKeyHex, 'hex'), { encryptionKey: b4a.from(encKeyHex, 'hex') })
      await d.ready()
      return d
    })
    this.emit('status', { state: 'feed:ready' })
    this._swarm.join(drive.discoveryKey, { server: true, client: true }) // pull + re-seed
    this._feedDrive = drive
    const port = await this._ensureServer()
    // Feed-health ticker for player overlays: how many peers serve the current feed.
    if (!this._statusTimer) {
      this._statusTimer = setInterval(() => {
        if (this._feedDrive) this.emit('peers', this._feedDrive.core.peers.length)
      }, 3000)
    }
    return port
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
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null }
    const server = this._server; this._server = null
    if (server) { try { await new Promise((resolve) => server.close(resolve)) } catch {} }
    const closing = [this._feedDrive, this._assetsDrive, this._panelBee, this._store]
    this._feedDrive = this._assetsDrive = this._panelBee = this._store = null
    this._assetsOpen = null
    this._call = null
    if (this._swarm) { const s = this._swarm; this._swarm = null; try { await s.destroy() } catch {} }
    for (const c of closing) { if (c) { try { await c.close() } catch {} } }
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
    const closing = [this._feedDrive, this._assetsDrive, this._panelBee, this._store]
    this._feedDrive = this._assetsDrive = this._panelBee = this._store = null
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
      return {
        id: s.id,
        title: s.title,
        description: s.description,
        category: s.category,
        isLive: s.isLive,
        poster: this._artUrl(port, s.poster),
        backdrop: this._artUrl(port, s.backdrop),
        logo: this._artUrl(port, s.logo)
      }
    })
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
          let sent = 0
          rs.on('data', (chunk) => { if (sent >= wanted) return; const out = sent + chunk.length > wanted ? chunk.subarray(0, wanted - sent) : chunk; sent += out.length; res.write(out); if (sent >= wanted) { res.end(); rs.destroy() } })
          rs.on('end', () => { if (sent < wanted) res.end() })
          rs.on('error', () => { try { res.destroy() } catch {} })
        } else {
          res.writeHead(200, { ...headers, 'Content-Length': String(size) })
          target.createReadStream(p).pipe(res)
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
