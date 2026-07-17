// Runtime start/stoppable broadcast channels (S12a refactor of the old one-env-stream
// index.js). A Channel owns one ingest→ffmpeg→encrypted-Hyperdrive→Hyperswarm pipeline;
// the ChannelManager persists the channel registry (DATA_DIR/channels.json) and is the
// single owner of every channel's Corestore.
//
// Feed identity vs feed DATA (the rolling buffer):
// - The ENCRYPTION key (feed.key in the channel's store dir) is persisted — user
//   grants seal it, so it must survive restarts. API-added channels live under
//   DATA_DIR/channels/<id>/; the env-configured channel keeps the LEGACY layout
//   (feed.key at DATA_DIR root) so pre-seeded feed.key files keep working.
// - The feed DATA is a rolling live window (the m3u8 defines what exists); rotated-out
//   segments are clear()ed so storage stays O(window) in either mode. Two buffers:
// - buffer 'disk' (DEFAULT): one persistent on-disk core — the feedKey and its DHT
//   discovery topic are STABLE across restarts, so returning viewers rejoin a warm
//   topic and resume their replica (fast time-to-play, healthier P2P). resolveFeedKey()
//   returns the deterministic key even before the first start().
// - buffer 'ram': a RAM-backed SESSION core — each start() mints a FRESH feed keypair,
//   registers the new feedKey with the panel, and segment data never touches disk.
//   (Reusing one keypair over an emptied RAM store would FORK the core and break
//   existing replicas — that is why a RAM restart is a new session core.) The catalog
//   follows: the SDK resolves the CURRENT feedKey at play time, so no re-login is
//   needed after a restart. Pick 'ram' when the host disk must stay byte-flat.

import Corestore from 'corestore'
import RAM from 'random-access-memory'
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
import { PanelLink } from './panel-link.js'

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

// Watchdog (S15b) timing. Bounded exponential backoff, no hard attempt cap: a 24/7 live
// channel should keep trying to reconnect a flaky source indefinitely, just never hot-loop.
const WD = {
  checkIntervalMs: 4000, // liveness poll period
  stallGraceMs: 20000, // a pull-style source must advance the live edge within this window
  backoffBaseMs: 1000, // first respawn delay after an ffmpeg exit
  backoffMaxMs: 30000, // respawn backoff cap
  backoffResetMs: 60000 // sustained health this long → backoff decays back to the base
}

// S15b log ring: the last N ffmpeg stderr lines per channel, for diagnosing why a source
// won't play. It lives on the Channel (not the run) so it survives ffmpeg respawns; an
// operator start() clears it, a watchdog respawn only appends a restart marker.
const LOG_RING_MAX = 400

// Deep-equal for typed input objects — flat, primitive-valued (see normalizeInput). Used
// to decide whether a PATCH actually changed a channel's SOURCE (→ rotate the feed).
function inputsEqual (a, b) {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length) return false
  return ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

// Signature of the HLS live edge: the muxer rewrites index.m3u8 on every new segment, so a
// changing (mtime,size) means the live edge is advancing. null = no playlist yet.
function liveEdgeSig (outDir) {
  try {
    const st = fs.statSync(path.join(outDir, 'index.m3u8'))
    return `${st.mtimeMs}:${st.size}`
  } catch { return null }
}

// One channel's live pipeline. Created stopped; start()/stop() any number of times.
class Channel {
  constructor (manager, meta) {
    this.manager = manager
    this.meta = meta // { id, title, description, category[], input, hls, protection, feedKey, legacy, desiredRunning }
    this.run = null // runtime state while started
    this.logRing = [] // S15b: last LOG_RING_MAX ffmpeg stderr lines {t,line}; survives respawns
  }

  // Append an ffmpeg stderr line (or an internal restart marker) to the ring.
  _log (line) {
    this.logRing.push({ t: Date.now(), line: typeof line === 'string' ? line : String(line) })
    if (this.logRing.length > LOG_RING_MAX) this.logRing.splice(0, this.logRing.length - LOG_RING_MAX)
  }

  // Newest-last log lines (at most `lines`, default the whole ring).
  logs (lines = LOG_RING_MAX) {
    return lines >= this.logRing.length ? this.logRing.slice() : this.logRing.slice(-lines)
  }

  get storeDir () {
    return this.meta.legacy ? this.manager.config.dataDir : path.join(this.manager.config.dataDir, 'channels', this.meta.id)
  }

  encryptionKeyHex () {
    return b4a.toString(loadOrCreateEncryptionKey(this.storeDir), 'hex')
  }

  // The Corestore namespace the feed core lives under. A source change bumps feedGen so the
  // namespace — and therefore the deterministic DISK feedKey — rotates, forcing clients to
  // drop their cached replica of the OLD source. feedGen 0/undefined → the original 'feed'
  // namespace, so existing disk feeds keep their key across this upgrade. Harmless in RAM
  // mode, which mints a fresh keypair every start regardless of the namespace.
  feedNamespace () {
    return this.meta.feedGen ? ('feed-gen-' + this.meta.feedGen) : 'feed'
  }

  // Open the drive briefly to learn the (deterministic) feed key without starting.
  async resolveFeedKey () {
    if (this.meta.feedKey) return this.meta.feedKey
    if (this.run) return this.run.feedKey
    // Ephemeral (RAM) feeds are session cores: the feedKey only exists while the
    // channel runs — each start() mints one and registers it with the panel. Disk
    // feeds (the default) resolve a stable, deterministic key here before first start.
    if ((this.meta.buffer || this.manager.config.feedBuffer || 'disk') === 'ram') return null
    const store = new Corestore(this.storeDir)
    await store.ready()
    const drive = new Hyperdrive(store.namespace(this.feedNamespace()), { encryptionKey: loadOrCreateEncryptionKey(this.storeDir) })
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
    this.logRing.length = 0 // fresh diagnostics for this operator-initiated run
    const encryptionKey = loadOrCreateEncryptionKey(this.storeDir) // persisted — grants seal it
    const buffer = this.meta.buffer || config.feedBuffer || 'disk'
    // 'disk' (default): persistent core with a stable feedKey/DHT topic across restarts.
    // 'ram': ephemeral session core — fresh keypair, data only ever in memory.
    const store = buffer === 'ram' ? new Corestore(RAM) : new Corestore(this.storeDir)
    await store.ready()
    const drive = new Hyperdrive(store.namespace(this.feedNamespace()), { encryptionKey })
    await drive.ready()
    const feedKeyHex = b4a.toString(drive.key, 'hex')
    this.meta.feedKey = feedKeyHex

    const bootstrap = config.bootstrap.length ? config.bootstrap : undefined
    // SWARM_MAX_PEERS (S20a): optional per-channel connection budget. hyperswarm 4.x
    // only applies maxPeers to OUTGOING dials and this swarm is server-only, so the cap
    // is also enforced at accept time — a connection beyond the budget is dropped before
    // replication starts (the peer's own retry/self-heal covers the refusal).
    const maxPeers = config.swarmMaxPeers || 0
    const swarm = new Hyperswarm(maxPeers ? { bootstrap, maxPeers } : { bootstrap })
    swarm.on('connection', (socket) => {
      if (maxPeers && swarm.connections.size > maxPeers) { socket.destroy(); return }
      drive.replicate(socket)
    })
    swarm.join(drive.discoveryKey, { server: true, client: false })
    await swarm.flush()

    // ffmpeg's live-window scratch. Defaults to the OS temp dir; HLS_WORK_DIR (config.workDir)
    // can point it at a tmpfs so the per-segment write churn never hits disk — the scale
    // profile for high channel density (see docs/kb/scaling.md).
    const workDir = config.workDir || os.tmpdir()
    fs.mkdirSync(workDir, { recursive: true })
    const outDir = fs.mkdtempSync(path.join(workDir, 'aliran-hls-'))
    const stopMirror = mirrorDirToDrive(outDir, drive, { interval: 500 })
    const now = Date.now()
    const run = {
      store,
      drive,
      swarm,
      stopMirror,
      outDir,
      feedKey: feedKeyHex,
      encryptionKey: b4a.toString(encryptionKey, 'hex'),
      startedAt: now,
      ff: null,
      ffmpegExit: null,
      // S15b watchdog: keeps ffmpeg alive across source hiccups (crash, empty/off-air
      // source, publisher disconnect) and restarts a stalled live edge. See _startWatchdog.
      watchdog: {
        timer: null,
        respawnTimer: null,
        stopped: false,
        restarting: false,
        restarts: 0,
        stalls: 0,
        lastExit: null,
        backoffMs: WD.backoffBaseMs,
        lastRestartAt: now,
        lastAdvanceAt: now,
        lastSig: null,
        everAdvanced: false,
        state: 'starting'
      }
    }
    // this.run must be live BEFORE the watchdog first ticks (its loop guards on
    // this.run === run). Both calls below are synchronous, so status() can't observe a
    // half-built run.
    this.run = run
    this._spawnFfmpeg(run)
    this._startWatchdog(run)

    // Panel registration is now the manager's job: manager.start() enqueues the live
    // register through the ONE manager-owned PanelLink (see panel-link.js). This returns
    // the identity the manager needs to build that op.
    return { feedKey: feedKeyHex, encryptionKey: run.encryptionKey }
  }

  // Spawn (or respawn) ffmpeg into the run's outDir. onExit is bound to THIS process so a
  // late exit callback from a process we already replaced can't clobber the live one.
  _spawnFfmpeg (run) {
    const { config } = this.manager
    const proc = startFfmpeg({
      input: this.meta.input,
      transcode: this.meta.transcode,
      hls: this.meta.hls,
      vaapiDevice: config.vaapiDevice
    }, run.outDir, {
      onLine: (line) => this._log(line), // → the per-channel log ring
      onExit: (code) => {
        if (run.ff !== proc) return // superseded process — ignore its exit
        run.ffmpegExit = code ?? -1
        run.watchdog.lastExit = code ?? -1
        run.watchdog.state = 'exited'
      }
    })
    run.ff = proc
    run.ffmpegExit = null
  }

  // Watchdog loop (S15b). Two failure modes, both bounded by exponential backoff:
  //  - ffmpeg EXITED (crash, source ended/off-air, publisher disconnected) → respawn.
  //  - live edge STALLED (index.m3u8 stopped advancing) on a pull-style source → kill it,
  //    which routes into the same exit→respawn path. Push listeners (rtmp/srt/udp) idle
  //    legitimately while awaiting a publisher, so they respawn only on a real exit and are
  //    never "stall"-cycled (that would drop the listen socket out from under a reconnect).
  _startWatchdog (run) {
    const wd = run.watchdog
    const check = () => {
      wd.timer = null
      if (wd.stopped || this.run !== run) return
      const t = Date.now()
      const isPush = isPushInput(this.meta.input) // re-read: a respawn picks up a PATCHed input
      const ffAlive = run.ffmpegExit === null && run.ff && run.ff.exitCode === null
      if (!ffAlive) {
        if (!wd.restarting) this._scheduleRespawn(run)
      } else {
        const sig = liveEdgeSig(run.outDir)
        if (sig !== null && sig !== wd.lastSig) {
          wd.lastSig = sig
          wd.lastAdvanceAt = t
          wd.everAdvanced = true
          wd.state = 'live'
          if (t - wd.lastRestartAt > WD.backoffResetMs) wd.backoffMs = WD.backoffBaseMs
        } else if (!isPush && t - wd.lastAdvanceAt > WD.stallGraceMs) {
          wd.stalls++
          wd.state = 'stalled'
          wd.lastAdvanceAt = t // debounce; the respawn re-arms fresh timing
          try { run.ff.kill('SIGKILL') } catch {} // exit path respawns it with backoff
        } else if (isPush && !wd.everAdvanced) {
          wd.state = 'waiting' // listener up, no publisher yet — normal
        }
      }
      if (!wd.stopped && this.run === run) wd.timer = setTimeout(check, WD.checkIntervalMs)
    }
    wd.timer = setTimeout(check, WD.checkIntervalMs)
  }

  // Respawn ffmpeg after the current backoff, then double it (capped at backoffMaxMs). A
  // stretch of health decays the backoff back to the base (see _startWatchdog).
  _scheduleRespawn (run) {
    const wd = run.watchdog
    if (wd.restarting || wd.stopped || this.run !== run) return
    wd.restarting = true
    wd.state = 'restarting'
    wd.respawnTimer = setTimeout(() => {
      wd.respawnTimer = null
      wd.restarting = false
      if (wd.stopped || this.run !== run) return
      wd.restarts++
      wd.lastRestartAt = Date.now()
      wd.lastAdvanceAt = Date.now() // fresh grace window before stall detection re-arms
      wd.lastSig = null
      this._log(`--- watchdog: ffmpeg restart #${wd.restarts} (prev exit ${wd.lastExit}, backoff ${wd.backoffMs}ms) ---`)
      this._spawnFfmpeg(run)
      wd.backoffMs = Math.min(wd.backoffMs * 2, WD.backoffMaxMs)
    }, wd.backoffMs)
  }

  async stop () {
    const run = this.run
    if (!run) bad(`channel "${this.meta.id}" is not running`)
    this.run = null
    // Silence the watchdog before we touch ffmpeg, so a pending tick/respawn can't fight
    // the teardown (both also guard on this.run === run, which is now null).
    run.watchdog.stopped = true
    if (run.watchdog.timer) { clearTimeout(run.watchdog.timer); run.watchdog.timer = null }
    if (run.watchdog.respawnTimer) { clearTimeout(run.watchdog.respawnTimer); run.watchdog.respawnTimer = null }
    run.stopMirror()
    try { run.ff.kill('SIGINT') } catch {}
    // Give ffmpeg a moment to exit; force-kill if it ignores SIGINT (Windows).
    await new Promise((resolve) => {
      if (run.ffmpegExit !== null || run.ff.exitCode !== null) return resolve()
      const t = setTimeout(() => { try { run.ff.kill('SIGKILL') } catch {}; resolve() }, 3000)
      run.ff.once('exit', () => { clearTimeout(t); resolve() })
    })
    try { await run.swarm.destroy() } catch {}
    try { await run.store.close() } catch {}
    try { fs.rmSync(run.outDir, { recursive: true, force: true }) } catch {}
  }

  // Live status for the API: is ffmpeg up, do we have peers, did the panel accept us,
  // is the playlist actually in the drive (the end-to-end "it flows" signal).
  async status () {
    const run = this.run
    // Top-level operator state (S15c) — the one-word answer to "how is this channel":
    //   stopped | starting | up | waiting-input | backoff
    // 'waiting-input' = push listener up, no publisher yet (normal); 'backoff' = the
    // watchdog is nursing a dying/stalled source (see watchdog.lastExit/backoffMs).
    const wd = run ? run.watchdog.state : null
    const state = !run ? 'stopped'
      : wd === 'live' ? 'up'
      : wd === 'waiting' ? 'waiting-input'
      : (wd === 'restarting' || wd === 'exited' || wd === 'stalled') ? 'backoff'
      : 'starting'
    const out = {
      ...this.meta,
      state,
      // Operator-facing push ingest info (display only — listeners bind 0.0.0.0).
      // pushUrl uses PUBLIC_HOST when set, '<this-host>' otherwise.
      ingest: isPushInput(this.meta.input) ? {
        kind: this.meta.input.kind,
        port: this.meta.input.port,
        pushUrl: pushUrl(this.meta.input, this.manager.config.publicHost)
      } : null,
      // While running, report the LIVE key (meta.feedKey is nulled on a source change and
      // only re-resolved on the next start — see _rotateFeedIfSourceChanged).
      feedKey: run ? run.feedKey : this.meta.feedKey,
      running: !!run,
      ffmpegUp: !!run && run.ffmpegExit === null && !!run.ff && run.ff.exitCode === null,
      ffmpegExit: run ? run.ffmpegExit : null,
      peers: run ? run.swarm.connections.size : 0,
      // Registration state now lives on the manager-owned PanelLink (per-stream op state),
      // not the run — so the shape is unchanged but stop() can honestly report "not live".
      registered: this.manager.panelLink.isRegistered(this.meta.id),
      registerError: this.manager.panelLink.lastError(this.meta.id),
      startedAt: run ? run.startedAt : null,
      // S15b watchdog surface: is ffmpeg being kept alive, and how hard.
      watchdog: run ? {
        state: run.watchdog.state,
        restarts: run.watchdog.restarts,
        stalls: run.watchdog.stalls,
        lastExit: run.watchdog.lastExit,
        backoffMs: run.watchdog.backoffMs
      } : null,
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
    // ONE panel connection for every channel's registration (S15b) — see panel-link.js.
    this.panelLink = new PanelLink(config)
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
    this.panelLink.connect() // one panel connection for all channel registrations
    await this._reconcile() // auto-resume desired-running channels; heal stale-live catalog
    return this
  }

  // Boot reconciliation (S15b). For every persisted channel:
  //  - desiredRunning → auto-start it (it re-registers isLive:true). The env/legacy channel
  //    is skipped here — index.js starts it explicitly (STREAM_ID-gated), so we never
  //    double-start it.
  //  - otherwise → enqueue isLive:false so a catalog entry left LIVE by an unclean crash is
  //    healed. Idempotent: a catalog that's already idle just gets rewritten idle.
  async _reconcile () {
    for (const ch of this.channels.values()) {
      if (ch.meta.legacy) continue
      if (ch.meta.desiredRunning) {
        try { await this.start(ch.meta.id) } catch (err) { ch.meta.resumeError = err.message }
      } else {
        this.panelLink.setDesired(ch.meta.id, { streamId: ch.meta.id, feedKey: ch.meta.feedKey ?? null, isLive: false })
      }
    }
  }

  // The full live-registration op for a running channel (matches the pre-S15b register
  // payload). encryptionKey is included so the panel (re)stores the private secret.
  _livePayload (ch, info) {
    return {
      streamId: ch.meta.id,
      feedKey: info.feedKey,
      encryptionKey: info.encryptionKey,
      title: ch.meta.title || ch.meta.id,
      description: ch.meta.description || '',
      category: ch.meta.category || [],
      protection: ch.meta.protection || 'self',
      isLive: true
    }
  }

  // Newest-last ffmpeg log lines for a channel (S15b log ring; the S15c control API exposes it).
  logs (id, lines) { return this._get(id).logs(lines) }

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
    if (fields.buffer != null) {
      if (fields.buffer !== 'ram' && fields.buffer !== 'disk') bad("buffer must be 'ram' (ephemeral session feed) or 'disk' (persistent feed identity)")
      out.buffer = fields.buffer
    }
    if (fields.hlsTime != null || fields.hlsListSize != null) {
      const time = parseInt(fields.hlsTime ?? this.config.hls?.time ?? 2, 10)
      const listSize = parseInt(fields.hlsListSize ?? this.config.hls?.listSize ?? 8, 10)
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
      buffer: norm.buffer ?? null, // null = config.feedBuffer default at start
      hls: norm.hls || { time: this.config.hls.time, listSize: this.config.hls.listSize },
      protection: 'self',
      feedKey: null,
      feedGen: 0, // bumped whenever the source changes → rotates the disk feed identity
      legacy: false,
      desiredRunning: false, // S15b: persisted desired state → auto-resume on boot
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
    // env INPUT is refreshed every boot, but a previously generated stream key is
    // inherited (kind-matching `existing`) so it survives restarts. If the operator
    // changed INPUT across boots, rotate the feed identity like any other source change.
    const newInput = normalizeInput(input || 'test', {
      config: this.config,
      usedPorts: this.usedPushPorts(id),
      existing: ch.meta.input
    })
    this._rotateFeedIfSourceChanged(ch, newInput)
    Object.assign(ch.meta, {
      legacy: true,
      title: title || id,
      description: ch.meta.description || '',
      category: category ? [category] : (ch.meta.category || []),
      input: newInput,
      transcode: ch.meta.transcode ?? null,
      hls: hls || { time: this.config.hls?.time ?? 2, listSize: this.config.hls?.listSize ?? 8 },
      protection: protection || 'self'
    })
    await ch.resolveFeedKey()
    this._save()
    return ch
  }

  // A channel's SOURCE changed → rotate its feed identity so clients drop their cached
  // replica of the OLD source. In disk mode the feedKey is deterministic per feedGen, so
  // bumping feedGen (and forgetting the cached feedKey) yields a fresh key on the next
  // start; clients catalog-follow it. The feed.key (ENCRYPTION) is untouched — user grants
  // survive. No-op on the initial assignment (no prior source) and in RAM mode, which mints
  // a fresh key every start anyway.
  _rotateFeedIfSourceChanged (ch, newInput) {
    if (newInput === undefined) return // the update didn't touch input
    if (ch.meta.input == null) return // first assignment — nothing to rotate
    if (inputsEqual(ch.meta.input, newInput)) return
    ch.meta.feedGen = (ch.meta.feedGen || 0) + 1
    ch.meta.feedKey = null
  }

  async update (id, fields) {
    const ch = this._get(id)
    const norm = this.normalizeMeta(fields, { excludeId: id })
    this._rotateFeedIfSourceChanged(ch, norm.input)
    Object.assign(ch.meta, norm)
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
    ch.meta.desiredRunning = true // persist desired state → auto-resume on next boot
    this._save() // feedKey may have just been learned
    // Register through the ONE panel link (isLive:true). Non-blocking, like the old async
    // per-channel register — status.registered flips once the op lands.
    this.panelLink.setDesired(id, this._livePayload(ch, info))
    return { id, ...info }
  }

  async stop (id) {
    const ch = this._get(id)
    const feedKey = ch.run ? ch.run.feedKey : ch.meta.feedKey
    await ch.stop()
    ch.meta.desiredRunning = false // operator stop → do NOT auto-resume
    this._save()
    // Flip the catalog to isLive:false and wait ≤5 s for it to land (the S1 catalog
    // live-push then tells clients instantly). Proceed even if the panel is unreachable.
    const seq = this.panelLink.setDesired(id, { streamId: id, feedKey: feedKey ?? null, isLive: false })
    await this.panelLink.flush(id, seq, 5000)
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

  // Graceful shutdown. Tear down every running pipeline and, since the broadcaster is going
  // down, flip its catalog entry to isLive:false — but LEAVE desiredRunning=true so the
  // channel auto-resumes on the next boot. Then close the panel link.
  async close () {
    for (const ch of this.channels.values()) {
      if (!ch.run) continue
      const feedKey = ch.run.feedKey
      try { await ch.stop() } catch {}
      this.panelLink.setDesired(ch.meta.id, { streamId: ch.meta.id, feedKey: feedKey ?? null, isLive: false })
    }
    try { await this.panelLink.flushAll(5000) } catch {}
    await this.panelLink.close()
  }
}
