// Runtime start/stoppable broadcast channels (S12a refactor of the old one-env-stream
// index.js). A Channel owns one ingest→ffmpeg→encrypted-Hyperdrive→Hyperswarm pipeline;
// the ChannelManager persists the channel registry (DATA_DIR/channels.json) and is the
// single owner of every channel's Corestore.
//
// Feed identity: each channel has its own store dir with a persisted feed.key
// (encryption key), so feedKey/encryptionKey are stable across restarts. API-added
// channels live under DATA_DIR/channels/<id>/; the env-configured channel keeps the
// LEGACY layout (store at DATA_DIR root, feed.key beside it) so existing deployments
// keep their feed identity and pre-seeded feed.key files.

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { startFfmpeg, mirrorDirToDrive } from './hls.js'
import { panelClient, registerWithPanel } from './register.js'

export class ControlError extends Error {
  constructor (code, message) { super(message); this.code = code }
}
const bad = (m) => { throw new ControlError('bad-request', m) }
const notFound = (m) => { throw new ControlError('not-found', m) }
const exists = (m) => { throw new ControlError('exists', m) }

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// Persist (and reuse) the feed encryption key so the feed identity is stable.
function loadOrCreateEncryptionKey (storeDir) {
  const p = path.join(storeDir, 'feed.key')
  if (fs.existsSync(p)) return b4a.from(fs.readFileSync(p, 'utf8').trim(), 'hex')
  fs.mkdirSync(storeDir, { recursive: true })
  const key = crypto.randomBytes(32)
  fs.writeFileSync(p, b4a.toString(key, 'hex'), { mode: 0o600 })
  return key
}

// One channel's live pipeline. Created stopped; start()/stop() any number of times.
class Channel {
  constructor (manager, meta) {
    this.manager = manager
    this.meta = meta // { id, title, description, category[], input, hls, protection, feedKey, legacy }
    this.run = null // runtime state while started
  }

  get storeDir () {
    return this.meta.legacy ? this.manager.config.dataDir : path.join(this.manager.config.dataDir, 'channels', this.meta.id)
  }

  encryptionKeyHex () {
    return b4a.toString(loadOrCreateEncryptionKey(this.storeDir), 'hex')
  }

  // Open the drive briefly to learn the (deterministic) feed key without starting.
  async resolveFeedKey () {
    if (this.meta.feedKey) return this.meta.feedKey
    if (this.run) return this.run.feedKey
    const store = new Corestore(this.storeDir)
    await store.ready()
    const drive = new Hyperdrive(store.namespace('feed'), { encryptionKey: loadOrCreateEncryptionKey(this.storeDir) })
    await drive.ready()
    this.meta.feedKey = b4a.toString(drive.key, 'hex')
    await store.close()
    return this.meta.feedKey
  }

  async start () {
    if (this.run) bad(`channel "${this.meta.id}" is already running`)
    const { config } = this.manager
    const encryptionKey = loadOrCreateEncryptionKey(this.storeDir)
    const store = new Corestore(this.storeDir)
    await store.ready()
    const drive = new Hyperdrive(store.namespace('feed'), { encryptionKey })
    await drive.ready()
    const feedKeyHex = b4a.toString(drive.key, 'hex')
    this.meta.feedKey = feedKeyHex

    const bootstrap = config.bootstrap.length ? config.bootstrap : undefined
    const swarm = new Hyperswarm({ bootstrap })
    swarm.on('connection', (socket) => drive.replicate(socket))
    swarm.join(drive.discoveryKey, { server: true, client: false })
    await swarm.flush()

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-hls-'))
    const stopMirror = mirrorDirToDrive(outDir, drive, { interval: 500 })
    const run = {
      store,
      drive,
      swarm,
      panelSwarm: null,
      stopMirror,
      outDir,
      feedKey: feedKeyHex,
      encryptionKey: b4a.toString(encryptionKey, 'hex'),
      startedAt: Date.now(),
      ffmpegExit: null,
      registered: false,
      registerError: null
    }
    run.ff = startFfmpeg({ input: this.meta.input, hls: this.meta.hls }, outDir, {
      onExit: (code) => { run.ffmpegExit = code ?? -1 }
    })

    // Auto-register with the panel (publisher-key auth, unchanged from v0.2).
    if (config.panelPubKey && config.publisherKey) {
      const panelSwarm = new Hyperswarm({ bootstrap })
      run.panelSwarm = panelSwarm
      panelSwarm.on('connection', async (socket) => {
        if (run.registered) return
        try {
          const { call } = panelClient(socket)
          await registerWithPanel(call, config.publisherKey, {
            streamId: this.meta.id,
            feedKey: feedKeyHex,
            encryptionKey: run.encryptionKey,
            title: this.meta.title || this.meta.id,
            description: this.meta.description || '',
            category: this.meta.category || [],
            protection: this.meta.protection || 'self',
            isLive: true
          })
          run.registered = true
          run.registerError = null
        } catch (err) { run.registerError = err.message }
      })
      panelSwarm.join(crypto.hash(b4a.from(config.panelPubKey, 'hex')), { client: true, server: false })
    }

    this.run = run
    return { feedKey: feedKeyHex, encryptionKey: run.encryptionKey }
  }

  async stop () {
    const run = this.run
    if (!run) bad(`channel "${this.meta.id}" is not running`)
    this.run = null
    run.stopMirror()
    try { run.ff.kill('SIGINT') } catch {}
    // Give ffmpeg a moment to exit; force-kill if it ignores SIGINT (Windows).
    await new Promise((resolve) => {
      if (run.ffmpegExit !== null || run.ff.exitCode !== null) return resolve()
      const t = setTimeout(() => { try { run.ff.kill('SIGKILL') } catch {}; resolve() }, 3000)
      run.ff.once('exit', () => { clearTimeout(t); resolve() })
    })
    try { await run.swarm.destroy() } catch {}
    if (run.panelSwarm) { try { await run.panelSwarm.destroy() } catch {} }
    try { await run.store.close() } catch {}
    try { fs.rmSync(run.outDir, { recursive: true, force: true }) } catch {}
  }

  // Live status for the API: is ffmpeg up, do we have peers, did the panel accept us,
  // is the playlist actually in the drive (the end-to-end "it flows" signal).
  async status () {
    const run = this.run
    const out = {
      ...this.meta,
      running: !!run,
      ffmpegUp: !!run && run.ffmpegExit === null && run.ff.exitCode === null,
      ffmpegExit: run ? run.ffmpegExit : null,
      peers: run ? run.swarm.connections.size : 0,
      registered: run ? run.registered : false,
      registerError: run ? run.registerError : null,
      startedAt: run ? run.startedAt : null,
      playlist: false,
      driveVersion: null
    }
    if (run) {
      try {
        out.playlist = !!(await run.drive.entry('/index.m3u8'))
        out.driveVersion = run.drive.version
      } catch {}
    }
    return out
  }
}

export class ChannelManager {
  constructor (config) {
    this.config = config
    this.channels = new Map()
  }

  registryPath () { return path.join(this.config.dataDir, 'channels.json') }

  async init () {
    let reg = {}
    try { reg = JSON.parse(fs.readFileSync(this.registryPath(), 'utf8')) } catch {}
    for (const meta of Object.values(reg)) this.channels.set(meta.id, new Channel(this, meta))
    return this
  }

  _save () {
    const reg = {}
    for (const [id, ch] of this.channels) reg[id] = ch.meta
    fs.mkdirSync(this.config.dataDir, { recursive: true })
    fs.writeFileSync(this.registryPath(), JSON.stringify(reg, null, 2))
  }

  _get (id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) bad('invalid channel id (allowed: letters, digits, _ . - ; max 64)')
    const ch = this.channels.get(id)
    if (!ch) notFound(`no such channel: ${id}`)
    return ch
  }

  normalizeMeta (fields = {}) {
    const out = {}
    if (fields.title != null) out.title = String(fields.title)
    if (fields.description != null) out.description = String(fields.description)
    if (fields.category != null) out.category = Array.isArray(fields.category) ? fields.category.map(String) : [String(fields.category)]
    if (fields.input != null) {
      const input = String(fields.input)
      // ffmpeg args are spawn()ed (no shell), but keep inputs sane anyway.
      if (input.length > 512 || /[\r\n]/.test(input)) bad('invalid input source')
      out.input = input
    }
    if (fields.hlsTime != null || fields.hlsListSize != null) {
      const time = parseInt(fields.hlsTime ?? 2, 10)
      const listSize = parseInt(fields.hlsListSize ?? 6, 10)
      if (!Number.isInteger(time) || time < 1 || time > 30) bad('hlsTime must be 1-30')
      if (!Number.isInteger(listSize) || listSize < 2 || listSize > 60) bad('hlsListSize must be 2-60')
      out.hls = { time, listSize }
    }
    return out
  }

  async add (id, fields = {}) {
    if (typeof id !== 'string' || !ID_RE.test(id)) bad('invalid channel id (allowed: letters, digits, _ . - ; max 64)')
    if (this.channels.has(id)) exists(`channel "${id}" already exists`)
    const norm = this.normalizeMeta(fields)
    const meta = {
      id,
      title: norm.title || id,
      description: norm.description || '',
      category: norm.category || [],
      input: norm.input || 'test',
      hls: norm.hls || { time: this.config.hls.time, listSize: this.config.hls.listSize },
      protection: 'self',
      feedKey: null,
      legacy: false,
      createdAt: Date.now()
    }
    const ch = new Channel(this, meta)
    this.channels.set(id, ch)
    const encryptionKey = ch.encryptionKeyHex()
    await ch.resolveFeedKey()
    this._save()
    return { ...meta, encryptionKey }
  }

  // Back-compat: the env-configured stream keeps the legacy DATA_DIR-root layout
  // (same Corestore + feed.key as pre-S12a broadcasters → same feed identity).
  // Meta is refreshed from the env on every boot.
  async ensureLegacy ({ id, title, category, input, hls, protection }) {
    let ch = this.channels.get(id)
    if (!ch) {
      ch = new Channel(this, { id, legacy: true, createdAt: Date.now() })
      this.channels.set(id, ch)
    }
    Object.assign(ch.meta, {
      legacy: true,
      title: title || id,
      description: ch.meta.description || '',
      category: category ? [category] : (ch.meta.category || []),
      input: input || 'test',
      hls: hls || { time: 2, listSize: 6 },
      protection: protection || 'self'
    })
    await ch.resolveFeedKey()
    this._save()
    return ch
  }

  async update (id, fields) {
    const ch = this._get(id)
    Object.assign(ch.meta, this.normalizeMeta(fields))
    this._save()
    return { ...(await ch.status()), restartRequired: !!ch.run }
  }

  // Removes the channel from the registry. The store dir (feed identity) is kept on
  // disk on purpose — deleting media/keys is the operator's call, not an API's.
  async remove (id) {
    const ch = this._get(id)
    if (ch.run) bad(`channel "${id}" is running — stop it first`)
    this.channels.delete(id)
    this._save()
    return { id, removed: true, dataKept: ch.storeDir }
  }

  async start (id) {
    const ch = this._get(id)
    const info = await ch.start()
    this._save() // feedKey may have just been learned
    return { id, ...info }
  }

  async stop (id) {
    const ch = this._get(id)
    await ch.stop()
    return { id, running: false }
  }

  async get (id) { return this._get(id).status() }

  async list () {
    const out = []
    for (const ch of this.channels.values()) out.push(await ch.status())
    return out
  }

  async statusSummary () {
    const list = await this.list()
    return {
      channels: list.length,
      running: list.filter((c) => c.running).length,
      panelConfigured: !!(this.config.panelPubKey && this.config.publisherKey)
    }
  }

  async close () {
    for (const ch of this.channels.values()) {
      if (ch.run) { try { await ch.stop() } catch {} }
    }
  }
}
