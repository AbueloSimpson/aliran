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
import net from 'net'
import dgram from 'dgram'
import path from 'path'
import os from 'os'
import { startFfmpeg, mirrorDirToDrive, urlScheme, TRANSCODE_DEFAULTS } from './hls.js'
import { probeCapabilities } from './capabilities.js'
import { panelClient, registerWithPanel } from './register.js'

export class ControlError extends Error {
  constructor (code, message) { super(message); this.code = code }
}
const bad = (m) => { throw new ControlError('bad-request', m) }
const notFound = (m) => { throw new ControlError('not-found', m) }
const exists = (m) => { throw new ControlError('exists', m) }

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// --- typed inputs + transcode (S15a) -----------------------------------------

const PULL_SCHEME_RE = /^(https?|rtsp|rtmps?|srt|udp):\/\//i
const STREAM_KEY_RE = /^[A-Za-z0-9]{8,64}$/
const PASSPHRASE_RE = /^[A-Za-z0-9._-]{10,79}$/
const PUSH_KINDS = new Set(['rtmp', 'srt', 'udp'])
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

const ENCODERS = new Set(['libx264', 'copy', 'h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_amf'])
const RESOLUTIONS = new Set(['source', '1080p', '720p', '480p', '360p'])
const FPS_VALUES = new Set([24, 25, 30, 50, 60])
const PRESETS = new Set(['fast', 'balanced', 'quality'])

export function isPushInput (input) {
  return !!input && typeof input === 'object' && PUSH_KINDS.has(input.kind)
}

export function randomStreamKey (len = 22) {
  let out = ''
  while (out.length < len) {
    for (const byte of crypto.randomBytes(32)) {
      if (byte >= 248) continue // rejection-sample away the modulo bias (248 = 4*62)
      out += KEY_ALPHABET[byte % 62]
      if (out.length === len) break
    }
  }
  return out
}

// Operator-facing push URL (display only — listeners always bind 0.0.0.0).
export function pushUrl (input, publicHost) {
  if (!isPushInput(input)) return null
  const host = publicHost || '<this-host>'
  if (input.kind === 'rtmp') return `rtmp://${host}:${input.port}/live/${input.streamKey}`
  if (input.kind === 'srt') {
    let url = `srt://${host}:${input.port}?latency=${(input.latencyMs ?? 200) * 1000}`
    if (input.passphrase) url += `&passphrase=${input.passphrase}`
    return url
  }
  return `udp://${host}:${input.port}`
}

function intInRange (v, min, max, label) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    bad(`${label} must be an integer ${min}-${max}`)
  }
  return n
}

function allocPort (requested, { config, usedPorts }) {
  if (requested != null) {
    const port = intInRange(requested, 1024, 65535, 'input.port')
    if (usedPorts.has(port)) bad(`port ${port} is already used by another channel`)
    return port
  }
  const base = config?.ingest?.portBase ?? 5000
  const max = config?.ingest?.portMax ?? 5999
  for (let port = base; port <= max; port++) if (!usedPorts.has(port)) return port
  bad(`no free ingest port in ${base}-${max} (set input.port explicitly or raise INGEST_PORT_MAX)`)
}

// Validate/normalize a channel input. String shorthands auto-upgrade to typed
// objects — env INPUT, pre-S15a channels.json entries and API strings all land
// here. Result is one of:
//   { kind:'test' } | { kind:'file', path } | { kind:'pull', url }
//   { kind:'rtmp', port, streamKey }            (push; OBS-style FLV publish)
//   { kind:'srt',  port, latencyMs, passphrase? } (push; passphrase = real auth)
//   { kind:'udp',  port, timeoutMs }             (push; raw MPEG-TS)
// opts: { config, usedPorts: Set<port>, existing?: previous typed input }
// Push ports must be unique across channels — ffmpeg -listen is single-client,
// so one port is one channel (a shared-port RTMP demux is explicitly post-v1).
// Omitted port → first free in the INGEST_PORT range. When the kind matches
// `existing`, omitted fields are inherited so a PATCH never silently rotates the
// stream key / passphrase an encoder is already configured with.
export function normalizeInput (value, { config, usedPorts = new Set(), existing = null } = {}) {
  if (value == null) bad('input is required')
  if (typeof value === 'string') {
    const s = value
    if (s.length > 512 || /[\r\n]/.test(s)) bad('invalid input source')
    if (s === 'test') return { kind: 'test' }
    if (s === 'rtmp') {
      // The documented legacy default: an RTMP listener on RTMP_PORT.
      value = { kind: 'rtmp', port: config?.rtmpPort ?? 1935 }
    } else if (PULL_SCHEME_RE.test(s)) {
      value = { kind: 'pull', url: s }
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      bad('unsupported input url scheme (allowed: http(s), rtsp, rtmp(s), srt, udp)')
    } else {
      value = { kind: 'file', path: s }
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) bad('input must be a string or an object')
  const kind = value.kind
  const inherit = existing && typeof existing === 'object' && existing.kind === kind ? existing : null

  if (kind === 'test') return { kind: 'test' }
  if (kind === 'file') {
    const p = value.path == null ? '' : String(value.path)
    if (!p || p.length > 512 || /[\r\n]/.test(p)) bad('file input needs a path (≤512 chars)')
    return { kind: 'file', path: p }
  }
  if (kind === 'pull') {
    const url = value.url == null ? '' : String(value.url)
    if (!url || url.length > 512 || /[\r\n]/.test(url)) bad('pull input needs a url (≤512 chars)')
    if (!PULL_SCHEME_RE.test(url)) bad('unsupported pull url scheme (allowed: http(s), rtsp, rtmp(s), srt, udp)')
    return { kind: 'pull', url }
  }
  if (!PUSH_KINDS.has(kind)) bad('input.kind must be one of: test, file, pull, rtmp, srt, udp')

  const port = allocPort(value.port ?? inherit?.port, { config, usedPorts })

  if (kind === 'rtmp') {
    const streamKey = value.streamKey !== undefined
      ? String(value.streamKey)
      : (inherit?.streamKey ?? randomStreamKey())
    if (!STREAM_KEY_RE.test(streamKey)) bad('streamKey must be 8-64 letters/digits')
    return { kind: 'rtmp', port, streamKey }
  }
  if (kind === 'srt') {
    // passphrase: undefined → inherit; null/'' → none (unencrypted).
    let passphrase = value.passphrase === undefined ? (inherit ? inherit.passphrase ?? null : null) : value.passphrase
    if (passphrase != null && passphrase !== '') {
      passphrase = String(passphrase)
      if (!PASSPHRASE_RE.test(passphrase)) bad('srt passphrase must be 10-79 chars of A-Z a-z 0-9 . _ -')
    } else passphrase = null
    const latencyMs = intInRange(value.latencyMs ?? inherit?.latencyMs ?? 200, 20, 5000, 'latencyMs')
    const out = { kind: 'srt', port, latencyMs }
    if (passphrase) out.passphrase = passphrase
    return out
  }
  const timeoutMs = intInRange(value.timeoutMs ?? inherit?.timeoutMs ?? 10000, 1000, 60000, 'timeoutMs')
  return { kind: 'udp', port, timeoutMs }
}

// Validate/normalize per-channel transcode settings. Every field is optional and
// the defaults reproduce pre-S15a behavior. This validates VALUES only — encoder
// availability on the host is checked at start() against the capability probe.
export function normalizeTranscode (value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) bad('transcode must be an object')
  const t = { ...TRANSCODE_DEFAULTS }
  if (value.encoder !== undefined) {
    if (!ENCODERS.has(value.encoder)) bad('transcode.encoder must be one of: ' + [...ENCODERS].join(', '))
    t.encoder = value.encoder
  }
  if (value.resolution !== undefined) {
    if (!RESOLUTIONS.has(value.resolution)) bad('transcode.resolution must be one of: ' + [...RESOLUTIONS].join(', '))
    t.resolution = value.resolution
  }
  if (value.fps !== undefined) {
    if (value.fps === 'source') t.fps = 'source'
    else {
      const n = Number(value.fps)
      if (!FPS_VALUES.has(n)) bad('transcode.fps must be source, 24, 25, 30, 50 or 60')
      t.fps = n
    }
  }
  if (value.videoBitrateKbps !== undefined && value.videoBitrateKbps !== null) {
    t.videoBitrateKbps = intInRange(value.videoBitrateKbps, 100, 20000, 'transcode.videoBitrateKbps')
  }
  if (value.audioBitrateKbps !== undefined) {
    t.audioBitrateKbps = intInRange(value.audioBitrateKbps, 64, 320, 'transcode.audioBitrateKbps')
  }
  if (value.preset !== undefined) {
    if (!PRESETS.has(value.preset)) bad('transcode.preset must be fast, balanced or quality')
    t.preset = value.preset
  }
  if (t.encoder === 'copy') {
    if (t.resolution !== 'source' || t.fps !== 'source') bad('encoder "copy" cannot change resolution/fps (leave them "source")')
    if (t.videoBitrateKbps != null) bad('encoder "copy" cannot set videoBitrateKbps')
  }
  return t
}

// Bind-test a push listener port before spawning ffmpeg, so a taken port is a
// clean API error instead of an ffmpeg crash loop. (Small TOCTOU window between
// close and spawn — acceptable; the watchdog surfaces the rest.)
function assertPortFree (input) {
  return new Promise((resolve, reject) => {
    const fail = (err) => reject(new ControlError('bad-request',
      `ingest port ${input.port} is not bindable (${err.code || err.message}) — another process may be using it`))
    if (input.kind === 'rtmp') { // rtmp is TCP; srt/udp listen on UDP
      const srv = net.createServer()
      srv.once('error', fail)
      srv.listen(input.port, '0.0.0.0', () => srv.close(() => resolve()))
    } else {
      const sock = dgram.createSocket('udp4')
      sock.once('error', (err) => { try { sock.close() } catch {}; fail(err) })
      sock.bind(input.port, '0.0.0.0', () => sock.close(() => resolve()))
    }
  })
}

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
    // Refuse cleanly BEFORE any resources spin up: unavailable encoder/protocol
    // (capability probe) and unbindable push ports are operator errors, not crashes.
    await this.manager.assertStartable(this.meta)
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
    run.ff = startFfmpeg({
      input: this.meta.input,
      transcode: this.meta.transcode,
      hls: this.meta.hls,
      vaapiDevice: config.vaapiDevice
    }, outDir, {
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
    this._caps = null
  }

  registryPath () { return path.join(this.config.dataDir, 'channels.json') }

  async init () {
    let reg = {}
    try { reg = JSON.parse(fs.readFileSync(this.registryPath(), 'utf8')) } catch {}
    for (const meta of Object.values(reg)) this.channels.set(meta.id, new Channel(this, meta))
    // Upgrade pre-S15a string inputs to typed objects and persist, so generated
    // stream keys stay stable across boots.
    let upgraded = false
    for (const ch of this.channels.values()) {
      if (typeof ch.meta.input === 'string') {
        const opts = { config: this.config, usedPorts: this.usedPushPorts(ch.meta.id) }
        try {
          ch.meta.input = normalizeInput(ch.meta.input, opts)
        } catch (err) {
          // 'rtmp' entries can collide on RTMP_PORT if several exist — fall back
          // to an auto-allocated ingest port rather than refusing to boot.
          if (ch.meta.input !== 'rtmp') throw err
          ch.meta.input = normalizeInput({ kind: 'rtmp' }, opts)
        }
        upgraded = true
      }
    }
    if (upgraded) this._save()
    this.capabilities().catch(() => {}) // warm the ffmpeg probe in the background
    return this
  }

  // One ffmpeg capability probe per process, shared by every start().
  capabilities () {
    if (!this._caps) {
      this._caps = probeCapabilities({ vaapiDevice: this.config.vaapiDevice })
        .catch((err) => { this._caps = null; throw err })
    }
    return this._caps
  }

  // Throws ControlError('bad-request') when the host ffmpeg lacks the protocol or
  // the (deep-verified) encoder a channel needs, or its push port isn't bindable.
  // No silent fallback — the operator picked these settings, tell them the truth.
  async assertStartable (meta) {
    const caps = await this.capabilities()
    if (!caps.ffmpeg) bad('ffmpeg not found on PATH')

    const input = meta.input
    const proto = isPushInput(input) ? input.kind
      : input?.kind === 'pull' ? urlScheme(input.url)
      : null
    if (proto && caps.protocols[proto] === false) {
      bad(`this ffmpeg build has no "${proto}" protocol support (input needs it)`)
    }

    const encoder = meta.transcode?.encoder ?? TRANSCODE_DEFAULTS.encoder
    if (encoder !== 'copy') {
      const e = caps.encoders[encoder]
      if (!e || !e.verified) {
        bad(`encoder "${encoder}" is not usable on this host` +
          (e?.error ? ` (${e.error})` : e && !e.listed ? ' (not in this ffmpeg build)' : ''))
      }
    }

    if (isPushInput(input)) await assertPortFree(input)
  }

  // Ports already claimed by push channels (uniqueness domain for allocPort).
  usedPushPorts (excludeId = null) {
    const used = new Set()
    for (const [id, ch] of this.channels) {
      if (id !== excludeId && isPushInput(ch.meta.input)) used.add(ch.meta.input.port)
    }
    return used
  }

  _save () {
    const reg = {}
    for (const [id, ch] of this.channels) reg[id] = ch.meta
    fs.mkdirSync(this.config.dataDir, { recursive: true })
    // 0600: channels.json now holds push stream keys / SRT passphrases.
    fs.writeFileSync(this.registryPath(), JSON.stringify(reg, null, 2), { mode: 0o600 })
    try { fs.chmodSync(this.registryPath(), 0o600) } catch {} // pre-existing file; no-op on Windows
  }

  _get (id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) bad('invalid channel id (allowed: letters, digits, _ . - ; max 64)')
    const ch = this.channels.get(id)
    if (!ch) notFound(`no such channel: ${id}`)
    return ch
  }

  normalizeMeta (fields = {}, { excludeId = null } = {}) {
    const out = {}
    if (fields.title != null) out.title = String(fields.title)
    if (fields.description != null) out.description = String(fields.description)
    if (fields.category != null) out.category = Array.isArray(fields.category) ? fields.category.map(String) : [String(fields.category)]
    if (fields.input != null) {
      out.input = normalizeInput(fields.input, {
        config: this.config,
        usedPorts: this.usedPushPorts(excludeId),
        existing: excludeId ? this.channels.get(excludeId)?.meta.input : null
      })
    }
    if (fields.transcode !== undefined) out.transcode = normalizeTranscode(fields.transcode) // null clears
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
      input: norm.input || { kind: 'test' },
      transcode: norm.transcode ?? null,
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
      // env INPUT is refreshed every boot, but a previously generated stream key
      // is inherited (kind-matching `existing`) so it survives restarts.
      input: normalizeInput(input || 'test', {
        config: this.config,
        usedPorts: this.usedPushPorts(id),
        existing: ch.meta.input
      }),
      transcode: ch.meta.transcode ?? null,
      hls: hls || { time: 2, listSize: 6 },
      protection: protection || 'self'
    })
    await ch.resolveFeedKey()
    this._save()
    return ch
  }

  async update (id, fields) {
    const ch = this._get(id)
    Object.assign(ch.meta, this.normalizeMeta(fields, { excludeId: id }))
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
