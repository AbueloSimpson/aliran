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
import Rache from 'rache'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import fs from 'fs'
import net from 'net'
import dgram from 'dgram'
import path from 'path'
import os from 'os'
import { startFfmpeg, mirrorDirToDrive, feedTreeBytes, isStoreCorruption, urlScheme, TRANSCODE_DEFAULTS } from './hls.js'
import { probeCapabilities } from './capabilities.js'
import { PanelLink } from './panel-link.js'
import { makeIncidents } from './incidents.js'
import { tuneSwarm, logSwarmTuning } from '@aliran/core/net-tune.js'
import { purgeStaleCores } from '@aliran/core/store-gc.js'

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
    // Backup sources, tried in order when the primary keeps failing (see _pickSource).
    // Omitted on a PATCH = keep what's stored (same `inherit` rule as a push streamKey);
    // an explicit [] clears them. Same validation as the primary — a backup that would be
    // rejected as a primary is worse than no backup, because it fails at 3am instead of now.
    const rawFb = value.fallbacks !== undefined ? value.fallbacks : (inherit?.fallbacks ?? [])
    if (!Array.isArray(rawFb)) bad('input.fallbacks must be an array of urls')
    if (rawFb.length > MAX_FALLBACKS) bad(`input.fallbacks: at most ${MAX_FALLBACKS} urls`)
    const fallbacks = []
    for (const f of rawFb) {
      const u = f == null ? '' : String(f)
      if (!u || u.length > 512 || /[\r\n]/.test(u)) bad('each fallback url must be 1-512 chars')
      if (!PULL_SCHEME_RE.test(u)) bad('unsupported fallback url scheme (allowed: http(s), rtsp, rtmp(s), srt, udp)')
      if (u !== url && !fallbacks.includes(u)) fallbacks.push(u) // drop dupes / echoes of the primary
    }
    return fallbacks.length ? { kind: 'pull', url, fallbacks } : { kind: 'pull', url }
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
  backoffResetMs: 60000, // sustained health this long → backoff decays back to the base
  // Backup sources (pull inputs with `fallbacks`). Failover is deliberately conservative:
  // a single ffmpeg exit is normal on flaky IPTV, so only a RUN of failures moves off the
  // current url. Return-to-primary is opportunistic — we never interrupt a working backup,
  // we just re-probe the primary on the next respawn once the cooldown has passed. On these
  // sources a respawn is never far away, so in practice the primary is retried often; on a
  // perfectly stable backup we stay there, which is the correct trade (no self-inflicted
  // glitch to go back to a source that only just started working).
  srcFailoverAfter: 2, // consecutive failed respawns on one url before trying the next
  srcPrimaryRetryMs: 300000 // 5 min on a backup → next respawn re-probes the primary
}

// Cap on `input.fallbacks`. Enough for a real redundancy chain, small enough that a
// failover cycle can't take longer than an operator's patience.
const MAX_FALLBACKS = 4

// Per-channel demuxer tuning (see hls.js ingestTuningArgs for WHY each one exists).
// Every field is optional and null means "ffmpeg's default", so an untouched channel is
// byte-identical to before. Ranges are wide because the encoders that need these are
// genuinely bad: 50 MB of probe and 20 s of analysis is a normal setting for a cheap
// HDMI box, not an abuse.
const TUNING_BOUNDS = {
  probesizeKB: [32, 102400], // 32 KB … 100 MB
  analyzeDurationMs: [100, 60000], // 0.1 s … 60 s
  threadQueueSize: [8, 65536]
}

export function normalizeIngestTuning (value, existing = null) {
  if (value == null) return existing ?? null
  if (typeof value !== 'object' || Array.isArray(value)) bad('ingestTuning must be an object')
  const out = {}
  for (const [key, [lo, hi]] of Object.entries(TUNING_BOUNDS)) {
    const raw = value[key] !== undefined ? value[key] : existing?.[key]
    if (raw == null || raw === '') continue
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isInteger(n) || n < lo || n > hi) bad(`ingestTuning.${key} must be an integer ${lo}-${hi} (or null for the ffmpeg default)`)
    out[key] = n
  }
  const dc = value.discardCorrupt !== undefined ? value.discardCorrupt : existing?.discardCorrupt
  if (dc != null && dc !== '') out.discardCorrupt = dc === true || /^(1|true|yes)$/i.test(String(dc))
  return Object.keys(out).length ? out : null
}

// The backup-source rotation decision, as a pure function of the current state — split
// out of Channel so the tricky half ("fail forward, but come home when you can") is
// unit-testable without spawning ffmpeg or opening a store. Returns the next rotation
// state plus WHY it changed, which is what the operator log line is built from.
export function pickSource ({
  sources, srcIndex = 0, srcFailures = 0, lastPrimaryTryAt = 0, now = Date.now(),
  failoverAfter = WD.srcFailoverAfter, primaryRetryMs = WD.srcPrimaryRetryMs
} = {}) {
  const keep = { srcIndex, srcFailures, lastPrimaryTryAt, reason: null }
  if (!Array.isArray(sources) || sources.length < 2) return { ...keep, srcIndex: 0 }
  // Rule 1 — return to primary. Checked BEFORE failover so a backup that is also failing
  // can't walk the ring forever without ever re-probing the primary.
  if (srcIndex !== 0 && now - lastPrimaryTryAt >= primaryRetryMs) {
    return { srcIndex: 0, srcFailures: 0, lastPrimaryTryAt: now, reason: 'primary-retry' }
  }
  // Rule 2 — fail forward after a RUN of failures (one exit is normal on flaky IPTV).
  if (srcFailures >= failoverAfter) {
    const next = (srcIndex + 1) % sources.length
    return {
      srcIndex: next,
      srcFailures: 0,
      lastPrimaryTryAt: next === 0 ? now : lastPrimaryTryAt,
      reason: 'failover'
    }
  }
  return keep
}

// S15b log ring: the last N ffmpeg stderr lines per channel, for diagnosing why a source
// won't play. It lives on the Channel (not the run) so it survives ffmpeg respawns; an
// operator start() clears it, a watchdog respawn only appends a restart marker.
const LOG_RING_MAX = 400

// Periodic orphan-namespace GC cadence while a channel runs — belt-and-suspenders on top of
// the start-time sweep and each rotation's own teardown purge (catches anything a crash or
// a partially-completed rotation stranded). Cheap: a shallow directory scan under cores/.
const GC_INTERVAL_MS = 30 * 60000

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

// Memory footprint of a live process: VmRSS+VmSwap in MB, from <procDir>/<pid>/status.
// Swap counts on purpose — on a small box the leaked demuxer state is exactly what gets
// paged out, so resident-only would under-read the processes we're hunting. Returns null
// when unreadable (non-Linux host, or the process already exited) — the memory cap simply
// doesn't apply then. procDir is injectable so tests can fake a /proc on any OS.
function procMemMb (pid, procDir = '/proc') {
  try {
    const text = fs.readFileSync(path.join(procDir, String(pid), 'status'), 'utf8')
    let kb = null
    for (const m of text.matchAll(/^Vm(?:RSS|Swap):\s*(\d+)\s*kB/gm)) kb = (kb ?? 0) + Number(m[1])
    return kb === null ? null : kb / 1024
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

  // Open the current generation's Hyperdrive (metadata + blobs cores materialized). If the
  // on-disk store is CORRUPT (an unclean exit truncated a core — EPARTIALREAD/OPLOG_CORRUPT),
  // self-heal ONCE by rotating to a fresh generation: bump feedGen so the next namespace
  // derives brand-new, uncorrupted cores. Disk mode only — a ram store is fresh every start,
  // so a corruption there is not persistent. The corrupt old generation is left for the
  // start-time GC to purge. getBlobs() is called here so the blobs core's discovery key is
  // known before the first GC/rotation (the mirror reuses the cached blobs).
  async _openFeedDriveSelfHealing (store, encryptionKey, buffer) {
    const open = async () => {
      const drive = new Hyperdrive(store.namespace(this.feedNamespace()), { encryptionKey })
      try {
        await drive.ready()
        await drive.getBlobs()
        return drive
      } catch (err) {
        try { await drive.close() } catch {} // release the half-open (possibly corrupt) cores
        throw err
      }
    }
    try {
      return await open()
    } catch (err) {
      if (buffer === 'ram' || !isStoreCorruption(err)) throw err
      this._log(`--- self-heal: feed store unreadable (${err.code || err.message}) — rotating to a fresh generation ${(this.meta.feedGen || 0) + 1} ---`)
      console.error(`channel "${this.meta.id}": feed store corrupt (${err.code || err.message}); self-healing to a fresh generation`)
      this.meta.feedGen = (this.meta.feedGen || 0) + 1
      this.meta.feedKey = null
      return await open() // fresh namespace → brand-new cores (a second failure propagates)
    }
  }

  // Open the drive briefly to learn the (deterministic) feed key without starting.
  async resolveFeedKey () {
    if (this.meta.feedKey) return this.meta.feedKey
    if (this.run) return this.run.feedKey
    // Ephemeral (RAM) feeds are session cores: the feedKey only exists while the
    // channel runs — each start() mints one and registers it with the panel. Disk
    // feeds (the default) resolve a stable, deterministic key here before first start.
    if ((this.meta.buffer || this.manager.config.feedBuffer || 'disk') === 'ram') return null
    const store = new Corestore(this.storeDir, { globalCache: this.manager.feedCache })
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
    const store = buffer === 'ram'
      ? new Corestore(RAM, { globalCache: this.manager.feedCache })
      : new Corestore(this.storeDir, { globalCache: this.manager.feedCache })
    await store.ready()
    // Open the current generation's feed drive, self-healing a CORRUPT on-disk store: an
    // unclean exit (SIGKILL/OOM/power loss/`docker stop` over its grace) can truncate a
    // core mid-write, so a disk feed can fail to reopen forever (EPARTIALREAD / OPLOG_CORRUPT)
    // — which would silently strand the channel on every boot. On corruption we rotate ONCE
    // to a fresh generation (bump feedGen → a brand-new namespace derives uncorrupted cores);
    // the start-time GC below then purges the corrupt old generation. Grants survive (the
    // encryption key is untouched); viewers follow the new feedKey via the catalog.
    const drive = await this._openFeedDriveSelfHealing(store, encryptionKey, buffer)
    const feedKeyHex = b4a.toString(drive.key, 'hex')
    this.meta.feedKey = feedKeyHex

    const bootstrap = config.bootstrap.length ? config.bootstrap : undefined
    // SWARM_MAX_PEERS (S20a): optional per-channel connection budget. hyperswarm 4.x
    // only applies maxPeers to OUTGOING dials and this swarm is server-only, so the cap
    // is also enforced at accept time — a connection beyond the budget is dropped before
    // replication starts (the peer's own retry/self-heal covers the refusal).
    const maxPeers = config.swarmMaxPeers || 0
    const swarm = new Hyperswarm(maxPeers ? { bootstrap, maxPeers } : { bootstrap })
    // Size the UDP socket buffers BEFORE this swarm starts serving. This swarm carries
    // every viewer of this channel over one socket pair, so the send buffer is the thing
    // that overflows under fan-out — and it is the direction udx leaves at the OS default.
    // Warnings are deduped process-wide (a clamp is a host property, not a per-channel one).
    // Goes to the process log, not this channel's ring: a clamped buffer is a property of
    // the HOST and applies to every channel equally, so pinning it to whichever channel
    // happened to start first would be misleading.
    logSwarmTuning(
      await tuneSwarm(swarm, { recvBytes: config.swarmRcvBuf, sendBytes: config.swarmSndBuf }),
      (line) => console.log('[net]', line)
    )
    swarm.on('connection', (socket) => {
      if (maxPeers && swarm.connections.size > maxPeers) { socket.destroy(); return }
      // Replicate the whole STORE (equivalent to drive.replicate — hyperdrive.replicate
      // delegates to its corestore), so both the current AND a retired-but-still-draining
      // feed generation (both live in this one store) are served to peers that ask for
      // either discovery key. Peers request only the feedKey their catalog points at.
      store.replicate(socket)
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
      // Periodic feed rotation (disk mode): the generation is hot-swapped in place while
      // ffmpeg keeps running. `drainMirrors` holds the just-retired generation's mirror(s)
      // still replicating through the grace window; `rotateGraceUntil`/`rotating` gate the
      // scheduled trigger and periodic GC off the live path during a rotation.
      lastRotateAt: now,
      lastGcAt: now,
      rotating: false,
      rotateTimer: null,
      rotateGraceUntil: 0,
      drainMirrors: [], // [{ stopMirror }] — retired generations mid-grace
      ff: null,
      ffmpegExit: null,
      // Backup-source rotation for pull inputs with `fallbacks` (see _pickSource).
      // srcIndex 0 is always the primary `input.url`.
      srcIndex: 0,
      srcFailures: 0,
      lastPrimaryTryAt: now,
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
        memMb: null, // last VmRSS+VmSwap sample of the live ffmpeg (Linux; null elsewhere)
        memRecycles: 0, // times the memory cap forced a recycle (see FFMPEG_MAX_RSS_MB)
        state: 'starting'
      }
    }
    // this.run must be live BEFORE the watchdog first ticks (its loop guards on
    // this.run === run). Both calls below are synchronous, so status() can't observe a
    // half-built run.
    this.run = run
    this._spawnFfmpeg(run)
    this._startWatchdog(run)
    // Drop any generations a prior run left behind (source changes, past rotations, an
    // unclean exit): in disk mode the store persists every generation's cores across
    // restarts, so this is where a reopened store sheds the orphaned metadata trees.
    this._gcStaleCores(run)

    // Panel registration is now the manager's job: manager.start() enqueues the live
    // register through the ONE manager-owned PanelLink (see panel-link.js). This returns
    // the identity the manager needs to build that op.
    return { feedKey: feedKeyHex, encryptionKey: run.encryptionKey }
  }

  // Spawn (or respawn) ffmpeg into the run's outDir. onExit is bound to THIS process so a
  // late exit callback from a process we already replaced can't clobber the live one.
  // [primary, ...fallbacks] for a pull input; [] for anything else. Re-read from meta on
  // every call so a PATCHed source list takes effect on the next respawn.
  _sources () {
    const i = this.meta.input
    return i && i.kind === 'pull' ? [i.url, ...(i.fallbacks || [])] : []
  }

  // The url this run should use right now. Never throws and never returns undefined: a
  // srcIndex left dangling by a PATCH that shortened the list falls back to the primary.
  _activeUrl (run) {
    const s = this._sources()
    if (s.length === 0) return null
    return s[run.srcIndex] ?? s[0]
  }

  // Decide which source the NEXT spawn uses. Called once per respawn, before _spawnFfmpeg.
  // Two rules, in priority order:
  //   1. return-to-primary — if we're on a backup and the cooldown has elapsed, go home.
  //      This is why failover isn't sticky: we get back without interrupting a working run.
  //   2. fail forward — a run of consecutive failures on the current url advances to the next.
  _pickSource (run) {
    const sources = this._sources()
    const next = pickSource({ ...run, sources, now: Date.now() })
    // Failover and coming home are ALWAYS worth an incident on their own — unlike a
    // respawn, they are rare and they change which source viewers are being served.
    if (next.reason === 'primary-retry') {
      this._log(`--- watchdog: retrying PRIMARY source ${sources[0]} ---`)
      try { this.manager.incidents.record('source-primary-retry', { channel: this.meta.id }) } catch {}
    } else if (next.reason === 'failover') {
      this._log(`--- watchdog: source failover → [${next.srcIndex}] ${sources[next.srcIndex]} ---`)
      try { this.manager.incidents.record('source-failover', { channel: this.meta.id, index: next.srcIndex, of: sources.length }) } catch {}
    }
    run.srcIndex = next.srcIndex
    run.srcFailures = next.srcFailures
    run.lastPrimaryTryAt = next.lastPrimaryTryAt
  }

  _spawnFfmpeg (run) {
    const { config } = this.manager
    // Swap the active backup url in without mutating meta.input (which stays the operator's
    // configured primary + list — status() and a PATCH must still see what was configured).
    const activeUrl = this._activeUrl(run)
    const input = activeUrl && activeUrl !== this.meta.input.url
      ? { ...this.meta.input, url: activeUrl }
      : this.meta.input
    const proc = startFfmpeg({
      input,
      transcode: this.meta.transcode,
      ingestTuning: this.meta.ingestTuning,
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

  // Watchdog loop (S15b). Three failure modes, all bounded by exponential backoff:
  //  - ffmpeg EXITED (crash, source ended/off-air, publisher disconnected) → respawn.
  //  - live edge STALLED (index.m3u8 stopped advancing) on a pull-style source → kill it,
  //    which routes into the same exit→respawn path. Push listeners (rtmp/srt/udp) idle
  //    legitimately while awaiting a publisher, so they respawn only on a real exit and are
  //    never "stall"-cycled (that would drop the listen socket out from under a reconnect).
  //  - memory OVER CAP (FFMPEG_MAX_RSS_MB) on a pull-style source → same kill→respawn path.
  //    The live-HLS demuxer retains playlist/segment/stream state on some upstreams (SSAI ad
  //    insertion churns TS PIDs, and libavformat never frees an AVStream), so a long-running
  //    pull slowly accumulates RSS+swap that only a process restart returns. No hls-demuxer
  //    input flag bounds that state (-live_start_index / -http_persistent / -m3u8_hold_counters
  //    control start position / connection reuse / reload budgets, not retention), so the
  //    bound lives here. A respawn is the usual sub-window blip — no feed rotation.
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
          // The live edge advanced, so whatever url we're on is working — clear the
          // failure run so an old streak can't trigger a failover much later.
          run.srcFailures = 0
          if (t - wd.lastRestartAt > WD.backoffResetMs) wd.backoffMs = WD.backoffBaseMs
        } else if (!isPush && t - wd.lastAdvanceAt > WD.stallGraceMs) {
          wd.stalls++
          wd.state = 'stalled'
          wd.lastAdvanceAt = t // debounce; the respawn re-arms fresh timing
          try { run.ff.kill('SIGKILL') } catch {} // exit path respawns it with backoff
        } else if (isPush && !wd.everAdvanced) {
          wd.state = 'waiting' // listener up, no publisher yet — normal
        }
        // Memory cap (independent of the edge checks above — a leaking pull is usually
        // still advancing). Push listeners are exempt: a kill would drop the publisher's
        // connection, and the accumulation is a pull-demuxer behavior anyway.
        const capMb = this.manager.config.ffmpegMaxRssMb || 0
        if (capMb > 0 && !isPush) {
          const memMb = procMemMb(run.ff.pid, this.manager.config.procDir)
          wd.memMb = memMb
          if (memMb !== null && memMb > capMb) {
            wd.memRecycles++
            this._log(`--- watchdog: ffmpeg memory ${memMb.toFixed(1)} MB > FFMPEG_MAX_RSS_MB ${capMb} — recycling ---`)
            try { run.ff.kill('SIGKILL') } catch {} // exit path respawns it with backoff
          }
        }
      }
      // Periodic maintenance (disk mode): rotate the feed generation when due — bounds the
      // never-reclaimed merkle-tree growth — and otherwise sweep any orphaned generations a
      // past rotation/crash stranded. Only rotate a HEALTHY, advancing feed; both stand down
      // during an in-flight rotation (see _rotateDue / _gcStaleCores).
      if (!wd.stopped && this.run === run) {
        if (ffAlive && wd.everAdvanced && this._rotateDue(run)) {
          this._rotateFeed(run, 'scheduled').catch((err) => this._log('--- rotate error: ' + (err && err.message) + ' ---'))
        } else if (Date.now() - run.lastGcAt >= GC_INTERVAL_MS) {
          run.lastGcAt = Date.now()
          this._gcStaleCores(run)
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
      // Feed the correlator. A lone respawn returns null (ordinary churn); a burst opens
      // or extends ONE fleet-restart incident — the thing that was invisible before.
      try {
        const running = [...this.manager.channels.values()].filter((c) => c.run).length
        this.manager.incidents.restart(this.meta.id, running)
      } catch {}
      // This respawn is itself the evidence the current source failed. Count it, then let
      // _pickSource decide whether to fail forward or go back to the primary.
      run.srcFailures++
      this._pickSource(run)
      wd.lastRestartAt = Date.now()
      wd.lastAdvanceAt = Date.now() // fresh grace window before stall detection re-arms
      wd.lastSig = null
      this._log(`--- watchdog: ffmpeg restart #${wd.restarts} (prev exit ${wd.lastExit}, backoff ${wd.backoffMs}ms) ---`)
      this._spawnFfmpeg(run)
      wd.backoffMs = Math.min(wd.backoffMs * 2, WD.backoffMaxMs)
    }, wd.backoffMs)
  }

  // --- disk-mode storage bounding: orphan GC + periodic feed rotation -------------------

  // Discovery keys (hex) of the CURRENT generation's live cores (metadata + blobs) — the
  // GC keep set. Read straight off the open drive, so they are correct by construction.
  _liveCoreDiscs (run) {
    const set = new Set()
    try { if (run.drive && run.drive.discoveryKey) set.add(b4a.toString(run.drive.discoveryKey, 'hex')) } catch {}
    try {
      const bc = run.drive && run.drive.blobs && run.drive.blobs.core
      if (bc && bc.discoveryKey) set.add(b4a.toString(bc.discoveryKey, 'hex'))
    } catch {}
    return set
  }

  // Delete the on-disk cores of every RETIRED feed generation (source changes, past
  // rotations, unclean exits) — the append-only metadata trees blob reclaim never frees.
  // Disk mode only; stands down while a rotation's grace window is open (the retired
  // generation is still replicating then — its own teardown purges it). Refuses to run
  // unless BOTH live discovery keys are known, so a half-open drive can never delete the
  // running feed (see purgeStaleCores' empty-keep-set guard).
  _gcStaleCores (run) {
    if (this.run !== run) return
    if ((this.meta.buffer || this.manager.config.feedBuffer || 'disk') === 'ram') return
    if (run.rotating || Date.now() < (run.rotateGraceUntil || 0)) return
    const keep = this._liveCoreDiscs(run)
    if (keep.size < 2) return // both current cores must be resolved before we delete siblings
    try {
      const r = purgeStaleCores(this.storeDir, keep)
      if (r.removed > 0) this._log(`--- gc: purged ${r.removed} retired feed-generation core dir(s), ${(r.bytesFreed / 1e6).toFixed(1)} MB freed ---`)
    } catch {}
  }

  // Is a scheduled feed rotation due? Disk mode only; never while stopped, rotating, or
  // inside a grace window. Triggers on age (FEED_ROTATE_HOURS since the last rotation/start)
  // or the live merkle tree crossing FEED_ROTATE_TREE_MB. Both 0 (default) = never.
  _rotateDue (run) {
    if ((this.meta.buffer || this.manager.config.feedBuffer || 'disk') === 'ram') return false
    if (run.rotating || Date.now() < (run.rotateGraceUntil || 0)) return false
    const rc = this.manager.config.feedRotate || {}
    if (rc.hours > 0 && Date.now() - (run.lastRotateAt || run.startedAt) >= rc.hours * 3600000) return true
    if (rc.treeMb > 0 && feedTreeBytes(this.storeDir, this._liveCoreDiscs(run)) >= rc.treeMb * 1e6) return true
    return false
  }

  // Operator-triggered feed rotation (control API POST /api/channels/:id/rotate).
  async rotateFeed () {
    const run = this.run
    if (!run) bad(`channel "${this.meta.id}" is not running`)
    if ((this.meta.buffer || this.manager.config.feedBuffer || 'disk') === 'ram') {
      bad('feed rotation applies to disk-buffer channels only (a ram feed already rotates on every restart)')
    }
    if (run.rotating || Date.now() < (run.rotateGraceUntil || 0)) bad(`channel "${this.meta.id}" is already rotating`)
    await this._rotateFeed(run, 'manual')
    return { id: this.meta.id, feedKey: run.feedKey, feedGen: this.meta.feedGen }
  }

  // Hot feed rotation (disk mode). Mint the next generation's drive over a fresh namespace,
  // mirror the SAME live window into it (ffmpeg is untouched), announce its topic, and make
  // it the served feed — then retire the previous generation: keep it replicating +
  // announced through the grace window so in-flight viewers finish following the catalog to
  // the new feedKey, and finally tear it down and purge its cores. The ENCRYPTION key is
  // unchanged (grants survive); only the feedKey/discovery topic moves, which watching
  // viewers follow live via the catalog (sdk _maybeReresolveActiveFeed → 'feed-changed').
  async _rotateFeed (run, reason) {
    if (this.run !== run || run.rotating) return
    run.rotating = true
    let newDrive = null
    let newStopMirror = null
    try {
      const encryptionKey = loadOrCreateEncryptionKey(this.storeDir)
      const newGen = (this.meta.feedGen || 0) + 1
      newDrive = new Hyperdrive(run.store.namespace('feed-gen-' + newGen), { encryptionKey })
      await newDrive.ready()
      await newDrive.getBlobs()
      // Mirror the SAME live window into the new generation (ffmpeg is untouched).
      if (this.run !== run) return // stopped mid-rotate — finally cleans up newDrive
      newStopMirror = mirrorDirToDrive(run.outDir, newDrive, { interval: 500 })

      // Announce the new topic BEFORE swapping so it is discoverable the moment viewers
      // learn the new feedKey. join()/flush() can race a concurrent stop() — guard after.
      try { run.swarm.join(newDrive.discoveryKey, { server: true, client: false }); await run.swarm.flush() } catch {}
      if (this.run !== run) return // finally cleans up newStopMirror + newDrive

      // Commit the swap synchronously (no awaits from here) so a concurrent stop() sees a
      // consistent run: the retired generation goes on the drain list as the new one lands.
      const oldDrive = run.drive
      const oldStopMirror = run.stopMirror
      const oldDiscovery = oldDrive.discoveryKey
      const newFeedKeyHex = b4a.toString(newDrive.key, 'hex')
      run.drive = newDrive
      run.stopMirror = newStopMirror
      run.feedKey = newFeedKeyHex
      run.lastRotateAt = Date.now()
      run.drainMirrors.push({ stopMirror: oldStopMirror })
      this.meta.feedGen = newGen
      this.meta.feedKey = newFeedKeyHex
      newDrive = null // ownership transferred to run — don't close it in finally
      newStopMirror = null

      const graceMs = this.manager.config.feedRotate?.graceMs ?? 30000
      run.rotateGraceUntil = Date.now() + graceMs
      this._log(`--- rotate: feed → generation ${newGen} (${reason}); retiring previous feed for ${Math.round(graceMs / 1000)}s ---`)

      // Re-register the new feedKey (isLive:true) so watching viewers' catalog-follow picks
      // it up, and persist the new generation to the registry.
      this.manager._reregisterLive(this, run)

      // Grace teardown: stop the retired mirror, leave its topic, close it, purge its cores.
      run.rotateTimer = setTimeout(async () => {
        run.rotateTimer = null
        run.rotateGraceUntil = 0
        try { oldStopMirror() } catch {}
        const idx = run.drainMirrors.findIndex((d) => d.stopMirror === oldStopMirror)
        if (idx >= 0) run.drainMirrors.splice(idx, 1)
        try { run.swarm.leave(oldDiscovery) } catch {}
        try { await oldDrive.close() } catch {} // release the retired cores so the purge can unlink them
        if (this.run === run) this._gcStaleCores(run)
      }, graceMs)
    } finally {
      run.rotating = false
      // Aborted before committing (stopped mid-rotate): tear down the half-built new gen.
      if (newStopMirror) { try { newStopMirror() } catch {} }
      if (newDrive) { try { await newDrive.close() } catch {} }
    }
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
    // Cancel a pending rotation grace teardown and stop every mirror (current + any retired
    // generation still draining); run.store.close() below closes all their cores.
    if (run.rotateTimer) { clearTimeout(run.rotateTimer); run.rotateTimer = null }
    for (const d of run.drainMirrors) { try { d.stopMirror() } catch {} }
    run.drainMirrors = []
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
      // Backup-source state: which of [primary, ...fallbacks] this run is pulling from
      // right now. sourceIndex 0 = primary, so a non-zero value means "running on a
      // backup" — the one thing an operator needs to see at a glance.
      sourceIndex: run ? run.srcIndex : 0,
      sourceCount: this._sources().length,
      activeSource: run ? this._activeUrl(run) : null,
      // S15b watchdog surface: is ffmpeg being kept alive, and how hard.
      watchdog: run ? {
        state: run.watchdog.state,
        restarts: run.watchdog.restarts,
        stalls: run.watchdog.stalls,
        lastExit: run.watchdog.lastExit,
        backoffMs: run.watchdog.backoffMs,
        // When the CURRENT ffmpeg process started — initialised to the run's startedAt and
        // bumped on every respawn. On a flaky source the channel can be hours old while
        // ffmpeg is seconds old, so this is the honest "how long has media been flowing"
        // clock; run.startedAt only tells you when the operator pressed Start.
        lastRestartAt: run.watchdog.lastRestartAt,
        memMb: run.watchdog.memMb,
        memRecycles: run.watchdog.memRecycles
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
    // Correlated incident ring (see incidents.js): individual respawns are noise on
    // flaky sources, so only bursts and discrete events land here.
    this.incidents = makeIncidents()
    // ONE bounded cache budget shared by every channel's cores. Without it each feed's
    // Hyperbee grows two per-instance caches (decoded nodes + keys) keyed by the
    // ever-increasing seq — ~1.5 KB retained per metadata append, forever (the prod
    // RSS leak: ~24 MB/h at 6 channels). Rache gives all bees one global entry budget
    // with random eviction; a re-read of an evicted node is a cheap RAM/disk hit.
    this.feedCache = new Rache({ maxSize: config.feedCacheMax || 8192 })
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
        try {
          await this.start(ch.meta.id)
        } catch (err) {
          // Surface WHY a channel didn't auto-resume — a silent failure here (corrupt store,
          // capability gate, port clash) otherwise looks like a mysterious "0 ffmpeg" boot.
          ch.meta.resumeError = err.message
          console.error(`channel "${ch.meta.id}" failed to auto-resume: ${err.message}`)
        }
      } else {
        this.panelLink.setDesired(ch.meta.id, this._regPayload({ streamId: ch.meta.id, feedKey: ch.meta.feedKey ?? null, isLive: false }))
      }
    }
  }

  // Wrap a register op with this broadcaster's enrolled identity (S26). With
  // PUBLISHER_NAME set the panel verifies the payload against that enrollment's own
  // key + channel scopes and stamps `origin:<name>` on the catalog record; without
  // it the payload stays unnamed (legacy shared-key path). Every payload the manager
  // hands to the PanelLink goes through here — the link itself passes them through
  // untouched.
  _regPayload (fields) {
    return this.config.publisherName ? { publisher: this.config.publisherName, ...fields } : fields
  }

  // The full live-registration op for a running channel (matches the pre-S15b register
  // payload). encryptionKey is included so the panel (re)stores the private secret.
  _livePayload (ch, info) {
    return this._regPayload({
      streamId: ch.meta.id,
      feedKey: info.feedKey,
      encryptionKey: info.encryptionKey,
      title: ch.meta.title || ch.meta.id,
      description: ch.meta.description || '',
      category: ch.meta.category || [],
      protection: ch.meta.protection || 'self',
      isLive: true
    })
  }

  // Re-announce a running channel's CURRENT feedKey to the panel (isLive:true) after a hot
  // feed rotation, so watching viewers' catalog-follow picks up the new key, and persist the
  // rotated generation (feedGen/feedKey moved) to the registry.
  _reregisterLive (ch, run) {
    this._save()
    this.panelLink.setDesired(ch.meta.id, this._livePayload(ch, { feedKey: run.feedKey, encryptionKey: run.encryptionKey }))
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
    // Demuxer tuning follows the same partial-update rule: omitted keeps, null clears.
    if (fields.ingestTuning !== undefined) out.ingestTuning = normalizeIngestTuning(fields.ingestTuning)
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
      ingestTuning: norm.ingestTuning ?? null,
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
      ingestTuning: ch.meta.ingestTuning ?? null,
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
    const seq = this.panelLink.setDesired(id, this._regPayload({ streamId: id, feedKey: feedKey ?? null, isLive: false }))
    await this.panelLink.flush(id, seq, 5000)
    return { id, running: false }
  }

  // Mint a fresh feed generation for a running disk-mode channel now, bounding the feed's
  // never-reclaimed merkle-tree growth. Viewers follow the new feedKey live (no re-login).
  async rotate (id) { return this._get(id).rotateFeed() }

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
      this.panelLink.setDesired(ch.meta.id, this._regPayload({ streamId: ch.meta.id, feedKey: feedKey ?? null, isLive: false }))
    }
    try { await this.panelLink.flushAll(5000) } catch {}
    await this.panelLink.close()
  }
}
