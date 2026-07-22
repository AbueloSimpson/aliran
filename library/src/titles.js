// Aliran library title manager (S8a) — the VOD counterpart of the broadcaster's
// ChannelManager, deliberately WITHOUT its live-pipeline lifecycle.
//
// A title = one registry entry + one encrypted Hyperdrive holding a finished HLS VOD
// rendition (ALL segments — no rolling window, no reclaim, no rotation, no watchdog).
// Ingest is a one-shot job (see ingest.js); after it the title is a static seed until
// the operator deletes it. Disk = the sum of title sizes, operator-managed.
//
// Storage model (the repeater's, not the broadcaster's): ONE Corestore + ONE Hyperswarm
// carry every title on this box. A static seeder gains nothing from per-title swarms —
// one socket pair serves all fan-out — and hundreds of titles must not mean hundreds of
// UDP sockets. Each title's drive lives under a per-generation namespace
// (`title:<id>:g<gen>`), so its feedKey is deterministic per generation; a RE-ingest
// bumps the generation (fresh feedKey — viewers follow the catalog, as with a live
// source change) and the retired generation's cores are purged from disk.
//
// Keys: each title's encryption key is minted ONCE (DATA_DIR/secrets/titles.json, 0600)
// and survives re-ingest, so per-user grants sealed to it stay valid — exactly the
// broadcaster's feed.key contract. The grant/sealing machinery is untouched: the panel
// stores the key privately at register and seals it per user, same as a live channel.
//
// Panel registration rides the PanelLink verbatim with `type:'vod'` + `durationSec`
// in the payload and NO isLive (liveness is not a property a title has). Descriptive
// metadata (title/description/category) is panel-authoritative after creation (S27e):
// the library seeds it once and never overwrites an admin's edits.

import fs from 'fs'
import os from 'os'
import path from 'path'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Rache from 'rache'
import b4a from 'b4a'
import hcrypto from 'hypercore-crypto'
import { PanelLink } from './panel-link.js'
import { probeInput, copyCompatible, convertToVod, importIntoDrive } from './ingest.js'
import { tuneSwarm, logSwarmTuning } from '@aliran/core/net-tune.js'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const LOG_RING_MAX = 200

// Same error contract as the broadcaster's ChannelManager: `code` maps to the HTTP
// status in control-server.js (not-found → 404, exists → 409, bad-request → 400).
export class ControlError extends Error {
  constructor (code, message) { super(message); this.code = code }
}
const bad = (m) => { throw new ControlError('bad-request', m) }

export class TitleManager {
  constructor (config) {
    this.config = config
    this.titles = new Map() // id -> meta (the registry entry, persisted)
    this.runtime = new Map() // id -> { drive, discovery, logRing, ingest: {phase,pct,startedAt} | null }
    this.panelLink = new PanelLink(config)
    this._store = null
    this._swarm = null
    this._queue = [] // pending ingest jobs: { id, resolve, reject }
    this._running = 0
    this._closed = false
  }

  get registryPath () { return path.join(this.config.dataDir, 'titles.json') }
  get secretsPath () { return path.join(this.config.dataDir, 'secrets', 'titles.json') }

  async init () {
    fs.mkdirSync(this.config.dataDir, { recursive: true })
    // Bounded bee cache budget — same contract as every corestore in the system
    // (broadcaster/repeater/SDK): each drive's internal hyperbee links into ONE
    // bounded cache instead of retaining ~1.5 KB per append forever.
    this._store = new Corestore(path.join(this.config.dataDir, 'store'), { globalCache: new Rache({ maxSize: 4096 }) })
    await this._store.ready()
    const maxPeers = this.config.swarmMaxPeers
    const swarmOpts = { maxPeers }
    if (this.config.bootstrap && this.config.bootstrap.length) swarmOpts.bootstrap = this.config.bootstrap
    this._swarm = new Hyperswarm(swarmOpts)
    // Size the UDP socket buffers before this box starts absorbing fan-out (a seeder is
    // send-dominant; see config.js). Best-effort — tuning must never block boot.
    logSwarmTuning(
      await tuneSwarm(this._swarm, { recvBytes: this.config.swarmRcvBuf, sendBytes: this.config.swarmSndBuf }),
      (line) => console.log('[net]', line)
    )
    // Serving IS this handler: corestore replication answers any request for a core this
    // box holds, one stream per connection. hyperswarm only budgets OUTGOING dials, so
    // the budget is also enforced at accept time (same gate as broadcaster/repeater).
    this._swarm.on('connection', (socket) => {
      if (!this._store || this._closed) { try { socket.destroy() } catch {} ; return }
      if (this._swarm.connections.size > maxPeers) { socket.destroy(); return }
      this._store.replicate(socket)
    })

    this._load()
    this.panelLink.connect()

    // Boot: re-seed + re-register every ready title. A title found mid-'ingesting' was
    // interrupted by a crash/restart — mark it failed rather than silently re-running a
    // transcode burst the operator did not just ask for (ingest is a one-shot job, not a
    // supervised pipeline; re-ingesting is one click/POST away).
    for (const meta of this.titles.values()) {
      if (meta.state === 'ingesting') {
        meta.state = 'error'
        meta.error = 'ingest interrupted by a library restart — re-ingest to retry'
      }
      if (meta.state === 'ready') {
        try {
          await this._openAndSeed(meta)
          this._registerReady(meta)
        } catch (err) {
          meta.state = 'error'
          meta.error = 'title store unreadable: ' + (err && err.message ? err.message : String(err))
          console.error(`title "${meta.id}": failed to reopen at boot: ${meta.error}`)
        }
      }
    }
    this._save()
  }

  // --- registry persistence ---

  _load () {
    if (fs.existsSync(this.registryPath)) {
      try {
        for (const meta of JSON.parse(fs.readFileSync(this.registryPath, 'utf8'))) this.titles.set(meta.id, meta)
      } catch (err) {
        // A corrupt registry must not brick the service, but silently starting empty
        // would look like every title vanished — refuse loudly instead.
        throw new Error(`titles.json is unreadable (${err.message}) — fix or remove it: ${this.registryPath}`)
      }
    }
  }

  _save () {
    fs.mkdirSync(this.config.dataDir, { recursive: true })
    fs.writeFileSync(this.registryPath, JSON.stringify([...this.titles.values()], null, 2))
  }

  _loadSecrets () {
    if (!fs.existsSync(this.secretsPath)) return {}
    try { return JSON.parse(fs.readFileSync(this.secretsPath, 'utf8')) } catch { return {} }
  }

  _saveSecrets (secrets) {
    fs.mkdirSync(path.dirname(this.secretsPath), { recursive: true })
    fs.writeFileSync(this.secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 })
  }

  // Minted once per title and REUSED across re-ingests, so grants sealed to it survive
  // (the broadcaster's feed.key contract). Deleted only with the title itself.
  _encryptionKey (id) {
    const secrets = this._loadSecrets()
    if (!secrets[id]) {
      secrets[id] = b4a.toString(hcrypto.randomBytes(32), 'hex')
      this._saveSecrets(secrets)
    }
    return secrets[id]
  }

  _rt (id) {
    let rt = this.runtime.get(id)
    if (!rt) { rt = { drive: null, discovery: null, logRing: [], ingest: null }; this.runtime.set(id, rt) }
    return rt
  }

  _log (id, line) {
    const rt = this._rt(id)
    rt.logRing.push(line)
    if (rt.logRing.length > LOG_RING_MAX) rt.logRing.splice(0, rt.logRing.length - LOG_RING_MAX)
  }

  // --- public API (the control server calls these) ---

  list () {
    return [...this.titles.values()].map((meta) => this._view(meta))
  }

  get (id) {
    const meta = this.titles.get(id)
    if (!meta) throw new ControlError('not-found', `no such title: ${id}`)
    return this._view(meta)
  }

  logs (id, lines = LOG_RING_MAX) {
    if (!this.titles.has(id)) throw new ControlError('not-found', `no such title: ${id}`)
    const ring = this._rt(id).logRing
    return lines >= ring.length ? ring.slice() : ring.slice(-lines)
  }

  _view (meta) {
    const rt = this.runtime.get(meta.id)
    return {
      ...meta,
      ingest: rt && rt.ingest ? { ...rt.ingest } : null,
      peers: rt && rt.drive ? rt.drive.core.peers.length : 0,
      registered: this.panelLink.isRegistered(meta.id),
      registerError: this.panelLink.lastError(meta.id)
    }
  }

  // Create a title and queue its ingest. `input` = a file path on this box or any URL
  // ffmpeg can read. Returns the registry view immediately; the ingest runs (bounded
  // by ingestConcurrency) in the background — poll GET /api/titles/:id for progress.
  async add (id, opts = {}) {
    if (typeof id !== 'string' || !ID_RE.test(id)) bad('invalid title id (allowed: letters, digits, _ . - ; max 64)')
    if (this.titles.has(id)) throw new ControlError('exists', `title "${id}" already exists`)
    if (typeof opts.input !== 'string' || !opts.input.trim()) bad('input is required (a file path on the library box, or a URL ffmpeg can read)')
    const mode = opts.mode ?? 'auto'
    if (!['auto', 'copy', 'transcode'].includes(mode)) bad("mode must be 'auto', 'copy' or 'transcode'")
    const hlsTime = opts.hlsTime ?? this.config.hls.time
    if (!Number.isInteger(hlsTime) || hlsTime < 1 || hlsTime > 30) bad('hlsTime must be an integer between 1 and 30 (seconds)')
    const meta = {
      id,
      title: opts.title || id,
      description: opts.description || '',
      category: Array.isArray(opts.category) ? opts.category : (opts.category ? [opts.category] : []),
      protection: opts.protection || 'self',
      input: opts.input.trim(),
      mode,
      hlsTime,
      state: 'queued',
      error: null,
      gen: 0,
      feedKey: null,
      durationSec: null,
      segments: null,
      bytes: null,
      createdAt: Date.now(),
      ingestedAt: null
    }
    this.titles.set(id, meta)
    this._save()
    this._enqueueIngest(id)
    return this._view(meta)
  }

  // Re-ingest an existing title (optionally from a new input): mints the NEXT feed
  // generation — fresh feedKey, viewers follow via the catalog — and purges the old one.
  async reingest (id, opts = {}) {
    const meta = this.titles.get(id)
    if (!meta) throw new ControlError('not-found', `no such title: ${id}`)
    if (meta.state === 'ingesting' || meta.state === 'queued') bad(`title "${id}" is already ${meta.state}`)
    if (opts.input !== undefined) {
      if (typeof opts.input !== 'string' || !opts.input.trim()) bad('input must be a non-empty path/URL')
      meta.input = opts.input.trim()
    }
    meta.state = 'queued'
    meta.error = null
    this._save()
    this._enqueueIngest(id)
    return this._view(meta)
  }

  // Descriptive metadata is panel-authoritative after creation (S27e) — the library
  // only PATCHes its own operational fields.
  async update (id, patch = {}) {
    const meta = this.titles.get(id)
    if (!meta) throw new ControlError('not-found', `no such title: ${id}`)
    const allowed = ['input', 'mode', 'hlsTime']
    const unknown = Object.keys(patch).filter((k) => !allowed.includes(k))
    if (unknown.length) bad(`only ${allowed.join('/')} can be changed here (${unknown.join(', ')} — descriptive metadata is edited in the panel; it is admin-owned after creation)`)
    if (patch.input !== undefined) {
      if (typeof patch.input !== 'string' || !patch.input.trim()) bad('input must be a non-empty path/URL')
      meta.input = patch.input.trim()
    }
    if (patch.mode !== undefined) {
      if (!['auto', 'copy', 'transcode'].includes(patch.mode)) bad("mode must be 'auto', 'copy' or 'transcode'")
      meta.mode = patch.mode
    }
    if (patch.hlsTime !== undefined) {
      if (!Number.isInteger(patch.hlsTime) || patch.hlsTime < 1 || patch.hlsTime > 30) bad('hlsTime must be an integer between 1 and 30 (seconds)')
      meta.hlsTime = patch.hlsTime
    }
    this._save()
    return this._view(meta) // applies on the next (re-)ingest
  }

  // Delete a title: stop seeding, purge its cores from disk, drop the registry entry +
  // its encryption key, and tell the panel the title is gone (status 'unavailable' —
  // the catalog record itself is admin-owned; remove it and any grants in the panel).
  async remove (id) {
    const meta = this.titles.get(id)
    if (!meta) throw new ControlError('not-found', `no such title: ${id}`)
    if (meta.state === 'ingesting' || meta.state === 'queued') bad(`title "${id}" is ${meta.state} — wait for the ingest to finish before deleting`)
    await this._dropDrive(id, { purge: true })
    this.titles.delete(id)
    this.runtime.delete(id)
    this._save()
    const secrets = this._loadSecrets()
    delete secrets[id]
    this._saveSecrets(secrets)
    // status:'unavailable' tells viewers the truth (nothing seeds this title anymore).
    // isLive:false here is PanelLink-side ONLY — it stops the 5-min heartbeat for this
    // id (the link re-asserts payloads unless isLive === false); the panel's vod record
    // class never reads isLive.
    this.panelLink.setDesired(id, this._regPayload({ streamId: id, type: 'vod', status: 'unavailable', isLive: false }))
    return { id, removed: true }
  }

  // --- ingest queue (bounded one-shot jobs) ---

  _enqueueIngest (id) {
    this._queue.push(id)
    this._pump()
  }

  _pump () {
    while (!this._closed && this._running < this.config.ingestConcurrency && this._queue.length) {
      const id = this._queue.shift()
      this._running++
      this._ingest(id)
        .catch((err) => {
          const meta = this.titles.get(id)
          if (meta) {
            meta.state = 'error'
            meta.error = err && err.message ? err.message : String(err)
            this._save()
          }
          this._log(id, 'INGEST FAILED: ' + (err && err.message ? err.message : String(err)))
          console.error(`title "${id}" ingest failed: ${err && err.message ? err.message : err}`)
        })
        .finally(() => {
          this._running--
          this._pump()
        })
    }
  }

  async _ingest (id) {
    const meta = this.titles.get(id)
    if (!meta || this._closed) return
    const rt = this._rt(id)
    rt.logRing.length = 0 // fresh diagnostics for this run
    rt.ingest = { phase: 'probe', pct: 0, startedAt: Date.now() }
    meta.state = 'ingesting'
    meta.error = null
    this._save()
    this._log(id, `--- ingest: probing ${meta.input} ---`)

    const probe = await probeInput(meta.input)
    const mode = meta.mode === 'auto' ? (copyCompatible(probe) ? 'copy' : 'transcode') : meta.mode
    this._log(id, `--- probe: ${probe.durationSec.toFixed(1)}s, video ${probe.video.codec}${probe.video.width ? ` ${probe.video.width}x${probe.video.height}` : ''}${probe.audio ? `, audio ${probe.audio.codec}` : ', no audio'} → ${mode} ---`)

    // Convert into a scratch dir first; the drive only ever sees a FINISHED rendition.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-vod-'))
    let drive = null
    const nextGen = (meta.gen || 0) + 1
    try {
      rt.ingest = { phase: 'convert', pct: 0, startedAt: rt.ingest.startedAt }
      await convertToVod({
        input: meta.input,
        mode,
        hlsTime: meta.hlsTime,
        outDir: workDir,
        onLine: (line) => this._log(id, line),
        onProgress: (sec) => { rt.ingest.pct = Math.min(1, sec / probe.durationSec) }
      })
      if (this._closed) throw new Error('library shutting down')

      // Import into a FRESH generation's encrypted drive. The previous generation (if
      // any) keeps seeding while the conversion/import runs and is purged at the swap
      // below — a viewer mid-play at that moment keeps their local replica but loses
      // the seeder for the OLD rendition; their next resolve() plays the new one.
      rt.ingest = { phase: 'import', pct: 0, startedAt: rt.ingest.startedAt }
      drive = new Hyperdrive(this._store.namespace(this._namespace(id, nextGen)), { encryptionKey: b4a.from(this._encryptionKey(id), 'hex') })
      await drive.ready()
      const { segments, bytes } = await importIntoDrive(workDir, drive, {
        onProgress: (pct) => { rt.ingest.pct = pct }
      })

      // Swap: retire the previous generation (purge its cores — a title's disk must not
      // grow with re-ingests), seed the new one, register the new feedKey.
      await this._dropDrive(id, { purge: true })
      meta.gen = nextGen
      meta.feedKey = b4a.toString(drive.key, 'hex')
      meta.durationSec = Math.round(probe.durationSec)
      meta.segments = segments
      meta.bytes = bytes
      meta.state = 'ready'
      meta.ingestedAt = Date.now()
      rt.drive = drive
      await drive.getBlobs() // materialize the blobs core before anyone replicates
      rt.discovery = this._swarm.join(drive.discoveryKey, { server: true, client: false })
      this._save()
      this._registerReady(meta)
      this._log(id, `--- ingest done: ${segments} segments, ${(bytes / 1e6).toFixed(1)} MB, ${meta.durationSec}s (${mode}) ---`)
      console.log(`title "${id}" ready: ${segments} segments, ${(bytes / 1e6).toFixed(1)} MB, feed ${meta.feedKey.slice(0, 8)}…`)
    } catch (err) {
      // A failed ingest must leave nothing half-registered: purge the partial new-gen
      // drive (the previous generation, if any, keeps seeding untouched).
      if (drive) {
        try { await this._purgeDrive(drive) } catch {}
      }
      throw err
    } finally {
      rt.ingest = null
      try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
    }
  }

  _namespace (id, gen) { return `title:${id}:g${gen}` }

  // Open + seed an existing ready title (boot path).
  async _openAndSeed (meta) {
    const rt = this._rt(meta.id)
    if (rt.drive) return
    const drive = new Hyperdrive(this._store.namespace(this._namespace(meta.id, meta.gen)), { encryptionKey: b4a.from(this._encryptionKey(meta.id), 'hex') })
    await drive.ready()
    const keyHex = b4a.toString(drive.key, 'hex')
    if (meta.feedKey && meta.feedKey !== keyHex) {
      // The namespace no longer derives the recorded key (a foreign/copied store) —
      // refuse rather than seed the wrong bytes under a registered identity.
      try { await drive.close() } catch {}
      throw new Error(`feed key mismatch (registry ${meta.feedKey.slice(0, 8)}…, store ${keyHex.slice(0, 8)}…)`)
    }
    await drive.getBlobs()
    rt.drive = drive
    rt.discovery = this._swarm.join(drive.discoveryKey, { server: true, client: false })
  }

  async _dropDrive (id, { purge } = {}) {
    const rt = this.runtime.get(id)
    if (!rt || !rt.drive) return
    const drive = rt.drive
    const discovery = rt.discovery
    rt.drive = null
    rt.discovery = null
    if (discovery) { try { await this._swarm.leave(drive.discoveryKey) } catch {} }
    if (purge) await this._purgeDrive(drive)
    else { try { await drive.close() } catch {} }
  }

  // Purge a drive's cores from disk (metadata + blobs). purge() closes every session of
  // a core and unlinks its storage — the same reclaim the repeater does on a retired
  // mirror and the panel does on its blobsKey probes. Falls back to close(): a failed
  // purge only leaks disk, it must never wedge the manager.
  async _purgeDrive (drive) {
    try { await drive.getBlobs() } catch {}
    for (const core of [drive.core, drive.blobs && drive.blobs.core]) {
      if (core) { try { await core.purge() } catch { try { await core.close() } catch {} } }
    }
    try { await drive.close() } catch {}
  }

  // --- panel registration ---

  _regPayload (fields) {
    return this.config.publisherName ? { publisher: this.config.publisherName, ...fields } : fields
  }

  _registerReady (meta) {
    // No isLive: liveness is not a property a title has — the panel's vod record class
    // omits the field entirely (payloads without isLive still count as "running" to the
    // PanelLink heartbeat, which is right: a ready title is a running seed).
    this.panelLink.setDesired(meta.id, this._regPayload({
      streamId: meta.id,
      type: 'vod',
      feedKey: meta.feedKey,
      encryptionKey: this._encryptionKey(meta.id),
      durationSec: meta.durationSec,
      title: meta.title,
      description: meta.description,
      category: meta.category,
      protection: meta.protection,
      status: 'available'
    }))
  }

  // --- introspection ---

  // Cheap + synchronous (the /healthz contract: answers as long as the loop turns).
  health () {
    let ready = 0; let ingesting = 0; let queued = 0; let error = 0
    for (const meta of this.titles.values()) {
      if (meta.state === 'ready') ready++
      else if (meta.state === 'ingesting') ingesting++
      else if (meta.state === 'queued') queued++
      else if (meta.state === 'error') error++
    }
    return {
      ok: true,
      titles: this.titles.size,
      ready,
      ingesting,
      queued,
      error,
      panelLink: this.panelLink.health()
    }
  }

  async statusSummary () {
    return {
      titles: this.titles.size,
      states: this.health(),
      publisher: this.config.publisherName || (this.config.publisherKey ? '(legacy shared key)' : null),
      panel: this.config.panelPubKey,
      swarm: {
        publicKey: this._swarm ? b4a.toString(this._swarm.keyPair.publicKey, 'hex') : null,
        connections: this._swarm ? this._swarm.connections.size : 0,
        maxPeers: this.config.swarmMaxPeers
      }
    }
  }

  async close () {
    this._closed = true
    this._queue.length = 0
    await this.panelLink.close()
    // Shutdown KEEPS every title's cores on disk (no purge) — a restart re-opens and
    // re-seeds them; only delete-title reclaims disk.
    for (const id of [...this.runtime.keys()]) {
      await this._dropDrive(id, { purge: false })
    }
    if (this._swarm) { const s = this._swarm; this._swarm = null; try { await s.destroy() } catch {} }
    if (this._store) { const st = this._store; this._store = null; try { await st.close() } catch {} }
  }
}
