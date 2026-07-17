// Aliran repeater appliance — a KEYLESS regional super-peer (S20, "Open-Connect model").
//
// A standalone hosted app that an operator — or a partner ISP, on-net — runs on a
// high-bandwidth box. It mirrors chosen channels' live windows and serves them to
// viewers, so fan-out moves off the origin broadcaster: the origin's per-channel
// egress drops to ~one stream per repeater, and when the repeater is ISP-hosted the
// viewer traffic stays on the local network. Hypercore's request hotswapping prefers
// fast/low-RTT holders, so an on-net repeater wins locally with ZERO client changes.
//
// KEYLESS by design — the trust story for third-party hosting:
//   - it has no account, no login, no grants, and NEVER holds an encryptionKey;
//   - it never opens a Hyperdrive (opening one takes the encryptionKey) — it mirrors
//     the drive's two hypercores RAW, straight at the corestore level;
//   - everything it stores and serves is ciphertext; it cannot watch what it serves.
//
// How it knows what to join (all public, decided 2026-07-17): there is no free-standing
// "topic id" — the swarm topic is DERIVED: topic = core.discoveryKey = hash(feedKey).
// The naming layer is the panel's PUBLIC catalog (`catalog/<streamId>`, replicated bee,
// readable pre-login) which carries `feedKey` and — since S20a's Option B enrichment —
// `blobsKey` (the blobs core is a NAMED core whose key rides inside the ENCRYPTED drive
// header; it is not publicly derivable, so the panel, which holds every stream's
// encryptionKey from register, publishes it). streamIds are panel-wide unique across
// broadcasters, so the full chain is:
//     streamId → catalog lookup → { feedKey, blobsKey } → hash(feedKey) → swarm topic
// and rotation-following is free: the same catalog watch viewers use (S1 live-push)
// re-targets the mirror whenever a register rotates the feedKey.
//
// It is a BLIND block mirror: no playlist parsing, no decryption. Per channel it
// live-downloads the TAIL of both cores (`core.download({ start: length, end: -1 })`
// follows appends) and periodically clears blocks older than the retention window, so
// storage is O(window) per channel — and the window MAY be deeper than the origin's
// (a regional blip-recovery buffer). Serving is automatic: `store.replicate(socket)`
// on every swarm connection answers requests for any mirrored core; one connection
// carries all cores (viewers request the blobs core over the same stream — no separate
// blobs topic join is needed, the feed topic is the rendezvous).
//
// Retention mechanics (why the range is re-armed): a live download range re-requests
// any missing block in [start, ∞), and clear() marks blocks missing — clearing inside
// the active range would make the replicator re-download what was just dropped. So the
// sweep first destroys the range, clears up to the watermark, then re-arms the range
// FROM the watermark. The watermark is time-based and blind: periodic {time, length}
// samples per core; blocks below the length sampled ≥ retention ago are expired.
// (hypercore's clear() drops block DATA only — the merkle tree stays, which is exactly
// what lets the repeater keep serving verified proofs for the blocks it still holds.)

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { config } from './config.js'

const HEX64 = /^[0-9a-f]{64}$/i

// Channel selection: 'all' | 'ch1,ch2' | 'category:news[,sports]'.
export function parseSelection (v) {
  const s = (v == null || String(v).trim() === '') ? 'all' : String(v).trim()
  if (s === 'all') return { mode: 'all' }
  if (s.startsWith('category:')) {
    const categories = s.slice('category:'.length).split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
    if (!categories.length) throw new Error('CHANNELS category filter needs at least one category (e.g. category:news)')
    return { mode: 'category', categories }
  }
  const ids = s.split(',').map(x => x.trim()).filter(Boolean)
  if (!ids.length) throw new Error('CHANNELS must be "all", a streamId list, or "category:<name>"')
  return { mode: 'ids', ids }
}

// Does a catalog record match the selection? (category may be a string or an array.)
export function selects (selection, streamId, record) {
  if (selection.mode === 'all') return true
  if (selection.mode === 'ids') return selection.ids.includes(streamId)
  const cats = [].concat(record?.category ?? []).map((c) => String(c).toLowerCase())
  return cats.some((c) => selection.categories.includes(c))
}

const DEFAULTS = {
  retentionSeconds: 300,
  swarmMaxPeers: 256,
  statusIntervalSeconds: 60,
  bootstrap: [],
  // Internal pacing (tests shrink these): how often core lengths are sampled for the
  // time→block watermark, how often expired blocks are cleared, and a safety-net
  // reconcile behind the live catalog watch.
  sampleIntervalMs: 5000,
  sweepIntervalMs: 15000,
  reconcileIntervalMs: 300000
}

export class Repeater {
  constructor (opts = {}) {
    const cfg = { ...DEFAULTS, ...opts }
    if (!cfg.panelPubKey || !HEX64.test(cfg.panelPubKey)) throw new Error('panelPubKey (64 hex chars) is required — the panel whose catalog names the channels')
    if (!(Number(cfg.retentionSeconds) > 0)) throw new Error('retentionSeconds must be a positive number')
    if (!Number.isInteger(cfg.swarmMaxPeers) || cfg.swarmMaxPeers < 1) throw new Error('swarmMaxPeers must be a positive integer')
    if (!cfg.dataDir) throw new Error('dataDir is required')
    this.config = cfg
    this.selection = parseSelection(cfg.channels)
    this._store = null
    this._swarm = null
    this._bee = null
    this._watcher = null
    this._mirrors = new Map() // streamId -> mirror (see _startMirror)
    this._timers = []
    this._sleepers = new Set()
    this._reconciling = null
    this._dirty = false
    this._sweeping = false
    this._closed = false
  }

  async start () {
    this._store = new Corestore(this.config.dataDir)
    await this._store.ready()
    const maxPeers = this.config.swarmMaxPeers
    const swarmOpts = { maxPeers }
    if (this.config.bootstrap.length) swarmOpts.bootstrap = this.config.bootstrap
    this._swarm = new Hyperswarm(swarmOpts)
    // Serving IS this handler: corestore replication answers any request for a core
    // this box holds — every mirrored channel plus the public panel bee — over one
    // stream per connection. hyperswarm 4.x only budgets OUTGOING dials, so the
    // budget is also enforced at accept time (same gate as the broadcaster's).
    this._swarm.on('connection', (socket) => {
      if (!this._store || this._closed) { try { socket.destroy() } catch {} ; return }
      if (this._swarm.connections.size > maxPeers) { socket.destroy(); return }
      this._store.replicate(socket)
    })

    // Replicate the panel's public bee — the same pre-login read any viewer does.
    const panelKey = b4a.from(this.config.panelPubKey, 'hex')
    this._bee = new Hyperbee(this._store.get({ key: panelKey }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await this._bee.ready()
    this._swarm.join(hcrypto.hash(panelKey), { client: true, server: false })
    this._log('joined panel topic; waiting for the public catalog to replicate…')
    await this._awaitLength(this._bee.core, () => this._closed, 'panel catalog')
    if (this._closed) return
    this._log('panel catalog replicated (length ' + this._bee.core.length + ')')

    this._watchCatalog()
    this._scheduleReconcile()
    this._timers.push(setInterval(() => this._sample(), this.config.sampleIntervalMs))
    this._timers.push(setInterval(() => { this._sweep().catch(() => {}) }, this.config.sweepIntervalMs))
    this._timers.push(setInterval(() => this._scheduleReconcile(), this.config.reconcileIntervalMs))
    if (this.config.statusIntervalSeconds > 0) {
      this._timers.push(setInterval(() => this._logStatus(), this.config.statusIntervalSeconds * 1000))
    }
  }

  // --- catalog follow ---

  // Live re-target on catalog changes (the S1 live-push pattern viewers use), with a
  // re-arm loop: a bee hiccup must not end the appliance's ability to follow.
  _watchCatalog () {
    const run = async () => {
      while (!this._closed) {
        const watcher = this._bee.watch({ gt: 'catalog/', lt: 'catalog0' }) // '0' = next char after '/'
        this._watcher = watcher
        try {
          for await (const _ of watcher) { // eslint-disable-line no-unused-vars
            if (this._closed || this._watcher !== watcher) return
            this._scheduleReconcile()
          }
        } catch { /* bee closing under us (shutdown) or a transient failure */ }
        if (this._closed || this._watcher !== watcher) return
        await this._sleep(5000)
      }
    }
    run().catch(() => {})
  }

  // Single-flight + dirty flag: a burst of catalog ticks collapses into one pass, and
  // a failed pass retries instead of silently dropping the change.
  _scheduleReconcile () {
    this._dirty = true
    if (this._reconciling || this._closed) return
    this._reconciling = (async () => {
      while (this._dirty && !this._closed) {
        this._dirty = false
        try {
          await this._reconcile()
        } catch (err) {
          this._log('reconcile failed (will retry): ' + (err?.message || err))
          this._dirty = true
          await this._sleep(5000)
        }
      }
    })().finally(() => { this._reconciling = null })
  }

  // One pass: read the catalog, compute the wanted set, drop/retarget/add mirrors.
  async _reconcile () {
    const wanted = new Map() // streamId -> { feedKey, blobsKey }
    // The bee is a sparse replica — a dead panel link can park a read forever, so the
    // stream is destroyed on a deadline and the pass retries via the dirty flag.
    const stream = this._bee.createReadStream({ gt: 'catalog/', lt: 'catalog0' })
    const timer = setTimeout(() => stream.destroy(new Error('catalog read timeout')), 60000)
    try {
      for await (const { key, value } of stream) {
        const id = key.slice('catalog/'.length)
        if (!value || !HEX64.test(value.feedKey || '')) continue // no feed yet — nothing to mirror
        if (!selects(this.selection, id, value)) continue
        wanted.set(id, {
          feedKey: value.feedKey.toLowerCase(),
          blobsKey: HEX64.test(value.blobsKey || '') ? value.blobsKey.toLowerCase() : null
        })
      }
    } finally {
      clearTimeout(timer)
    }
    if (this._closed) return

    // Drop what is gone/deselected; a rotated feedKey drops the old mirror here and
    // re-adds the new one below (grants/entitlements are unaffected — this box has none).
    for (const [id, m] of [...this._mirrors]) {
      const w = wanted.get(id)
      if (!w) await this._dropMirror(id, 'removed from catalog / deselected', { purge: true })
      else if (w.feedKey !== m.feedKey) await this._dropMirror(id, 'feedKey rotated', { purge: true })
    }
    for (const [id, w] of wanted) {
      const m = this._mirrors.get(id)
      if (!m) {
        await this._startMirror(id, w)
      } else if (w.blobsKey && !m.blobsKey) {
        // Enrichment landed after we started (it is async on the panel side).
        this._addTail(m, 'blobs', w.blobsKey, { keepFirst: false })
        m.blobsKey = w.blobsKey
      } else if (w.blobsKey && m.blobsKey && w.blobsKey !== m.blobsKey) {
        await this._dropMirror(id, 'blobsKey changed', { purge: true })
        await this._startMirror(id, w)
      }
    }
  }

  // --- mirrors ---

  async _startMirror (id, { feedKey, blobsKey }) {
    const m = {
      streamId: id,
      feedKey,
      blobsKey: null,
      topic: null,
      discovery: null,
      tails: new Map(), // 'db' | 'blobs' -> tail
      closed: false
    }
    this._mirrors.set(id, m)
    // The db core IS the drive: its key is the public feedKey and its discoveryKey is
    // the topic both the origin (channel.js) and every viewer (player.js) join.
    const dbCore = this._store.get({ key: b4a.from(feedKey, 'hex') })
    await dbCore.ready()
    if (this._closed || m.closed) { try { await dbCore.close() } catch {} ; return }
    m.topic = dbCore.discoveryKey
    // server: viewers must be able to FIND this box on the channel topic;
    // client: it must also dial the origin (whose channel swarm is server-only).
    m.discovery = this._swarm.join(m.topic, { server: true, client: true })
    this._attachTail(m, 'db', dbCore, { keepFirst: true }) // block 0 = drive header — a cold viewer needs it to open the drive
    if (blobsKey) {
      this._addTail(m, 'blobs', blobsKey, { keepFirst: false })
      m.blobsKey = blobsKey
    } else {
      this._log(`[${id}] mirroring metadata; waiting for the catalog blobsKey (panel enrichment is async)`)
    }
    this._log(`[${id}] mirror started (feed ${feedKey.slice(0, 8)}…)`)
  }

  // Open a core by key and attach a tail to an existing mirror (blobs arrives later
  // than db when enrichment is still running). Fire-and-forget open; guards re-check.
  _addTail (m, kind, keyHex, { keepFirst }) {
    if (m.tails.has(kind)) return
    const core = this._store.get({ key: b4a.from(keyHex, 'hex') })
    m.tails.set(kind, this._makeTail(kind, keyHex, core, keepFirst))
    core.ready().then(() => {
      if (this._closed || m.closed) return
      this._armTail(m, m.tails.get(kind))
    }).catch(() => { m.tails.delete(kind) })
  }

  _attachTail (m, kind, readyCore, { keepFirst }) {
    const tail = this._makeTail(kind, b4a.toString(readyCore.key, 'hex'), readyCore, keepFirst)
    m.tails.set(kind, tail)
    this._armTail(m, tail)
  }

  _makeTail (kind, keyHex, core, keepFirst) {
    return { kind, keyHex, core, keepFirst, armed: false, range: null, headRange: null, clearedUpTo: 0, samples: [] }
  }

  // Arm the live tail: learn the CURRENT remote length (never download history), then
  // follow appends from there. Runs in the background — the origin may be offline for
  // now; the loop keeps trying until the mirror is dropped.
  _armTail (m, tail) {
    const run = async () => {
      await this._awaitLength(tail.core, () => this._closed || m.closed, `${m.streamId}/${tail.kind}`)
      if (this._closed || m.closed || tail.armed) return
      const edge = tail.core.length
      const floor = tail.keepFirst ? 1 : 0
      // Remnants below today's live edge (a previous run's window) would otherwise sit
      // forever — the retention watermark only ever starts at the edge. Drop them now.
      try { if (edge > floor) await tail.core.clear(floor, edge) } catch {}
      if (this._closed || m.closed) return
      tail.clearedUpTo = Math.max(edge, floor)
      tail.range = tail.core.download({ start: tail.clearedUpTo, end: -1 }) // live range: follows appends
      if (tail.keepFirst) tail.headRange = tail.core.download({ start: 0, end: 1 })
      tail.samples.push({ t: Date.now(), len: tail.core.length })
      tail.armed = true
      this._log(`[${m.streamId}] ${tail.kind} tail armed at block ${tail.clearedUpTo} (key ${tail.keyHex.slice(0, 8)}…)`)
    }
    run().catch(() => {})
  }

  async _dropMirror (id, reason, { purge } = {}) {
    const m = this._mirrors.get(id)
    if (!m) return
    this._mirrors.delete(id)
    m.closed = true
    if (m.topic) { try { await this._swarm.leave(m.topic) } catch {} }
    for (const tail of m.tails.values()) {
      try { tail.range?.destroy() } catch {}
      try { tail.headRange?.destroy() } catch {}
      if (purge) {
        // Rotation/deselection: the old core will never be served again — delete its
        // blocks from disk so storage stays bounded across arbitrarily many rotations.
        try { await tail.core.purge() } catch { try { await tail.core.close() } catch {} }
      } else {
        try { await tail.core.close() } catch {}
      }
    }
    m.tails.clear()
    this._log(`[${id}] mirror dropped (${reason})`)
  }

  // --- retention ---

  _sample () {
    const t = Date.now()
    for (const m of this._mirrors.values()) {
      for (const tail of m.tails.values()) {
        if (!tail.armed) continue
        tail.samples.push({ t, len: tail.core.length })
        if (tail.samples.length > 10000) tail.samples.splice(0, tail.samples.length - 10000)
      }
    }
  }

  // Clear expired blocks. The range is torn down first and re-armed FROM the new
  // watermark — clearing inside a live range would make the replicator re-download
  // the cleared blocks (they read as missing wants).
  async _sweep () {
    if (this._sweeping || this._closed) return
    this._sweeping = true
    try {
      const cutoff = Date.now() - this.config.retentionSeconds * 1000
      for (const m of this._mirrors.values()) {
        for (const tail of m.tails.values()) {
          if (!tail.armed || m.closed) continue
          let watermark = tail.clearedUpTo
          for (const s of tail.samples) if (s.t <= cutoff && s.len > watermark) watermark = s.len
          tail.samples = tail.samples.filter((s) => s.t > cutoff)
          if (watermark <= tail.clearedUpTo) continue
          const from = Math.max(tail.clearedUpTo, tail.keepFirst ? 1 : 0)
          try { tail.range?.destroy() } catch {}
          try { await tail.core.clear(from, watermark) } catch {}
          if (this._closed || m.closed) return
          tail.range = tail.core.download({ start: watermark, end: -1 })
          tail.clearedUpTo = watermark
        }
      }
    } finally {
      this._sweeping = false
    }
  }

  // --- introspection ---

  status () {
    const channels = [...this._mirrors.values()].map((m) => {
      const cores = {}
      for (const [kind, tail] of m.tails) {
        cores[kind] = {
          key: tail.keyHex,
          armed: tail.armed,
          length: tail.core.length,
          clearedUpTo: tail.clearedUpTo,
          held: tail.armed ? Math.max(0, tail.core.length - tail.clearedUpTo) + (tail.keepFirst ? 1 : 0) : 0,
          peers: tail.core.peers?.length ?? 0
        }
      }
      return { streamId: m.streamId, feedKey: m.feedKey, blobsKey: m.blobsKey, cores }
    })
    return {
      panelPubKey: this.config.panelPubKey,
      selection: this.selection,
      retentionSeconds: this.config.retentionSeconds,
      swarm: {
        publicKey: this._swarm ? b4a.toString(this._swarm.keyPair.publicKey, 'hex') : null,
        connections: this._swarm?.connections.size ?? 0,
        maxPeers: this.config.swarmMaxPeers
      },
      channels
    }
  }

  _logStatus () {
    const s = this.status()
    for (const c of s.channels) {
      const parts = Object.entries(c.cores).map(([k, v]) => `${k}: ${v.armed ? `held ${v.held} @${v.length}` : 'arming'} peers ${v.peers}`)
      this._log(`[${c.streamId}] ${parts.join(' | ') || 'waiting for catalog keys'}`)
    }
    this._log(`swarm: ${s.swarm.connections} connection(s), ${s.channels.length} channel(s) mirrored`)
  }

  _log (msg) { console.log('[repeater]', msg) }

  // --- plumbing ---

  // Learn a replicated core's remote length. update({ wait:true }) resolves early
  // (length 0) unless findingPeers is wired to the swarm flush — and if no peer is
  // reachable yet (origin down, panel down) it keeps retrying until stopped().
  async _awaitLength (core, stopped, label) {
    let delay = 3000
    while (!stopped() && core.length === 0) {
      const done = core.findingPeers()
      this._swarm.flush().then(() => { try { done() } catch {} }, () => { try { done() } catch {} })
      try { await core.update({ wait: true }) } catch {}
      if (core.length > 0 || stopped()) break
      this._log(`waiting for peers on ${label}…`)
      await this._sleep(delay)
      delay = Math.min(delay * 2, 15000)
    }
  }

  _sleep (ms) {
    if (this._closed) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._sleepers.delete(entry); resolve() }, ms)
      const entry = () => { clearTimeout(timer); resolve() }
      this._sleepers.add(entry)
    })
  }

  async close () {
    if (this._closed) return
    this._closed = true
    for (const wake of [...this._sleepers]) wake()
    this._sleepers.clear()
    for (const t of this._timers) clearInterval(t)
    this._timers = []
    const watcher = this._watcher
    this._watcher = null
    if (watcher) { try { await watcher.close() } catch {} }
    // Shutdown KEEPS the mirrored windows on disk (no purge): a restart re-arms at the
    // new live edge and the arming remnant-clear drops what expired meanwhile.
    for (const m of this._mirrors.values()) {
      m.closed = true
      for (const tail of m.tails.values()) {
        try { tail.range?.destroy() } catch {}
        try { tail.headRange?.destroy() } catch {}
      }
    }
    if (this._swarm) { const s = this._swarm; this._swarm = null; try { await s.destroy() } catch {} }
    for (const m of this._mirrors.values()) {
      for (const tail of m.tails.values()) { try { await tail.core.close() } catch {} }
    }
    this._mirrors.clear()
    const bee = this._bee
    this._bee = null
    if (bee) { try { await bee.close() } catch {} }
    const store = this._store
    this._store = null
    if (store) { try { await store.close() } catch {} }
  }
}

export async function startRepeater (overrides = {}) {
  const repeater = new Repeater({ ...config, ...overrides })
  console.log('=== Aliran repeater ===')
  console.log('Panel:', repeater.config.panelPubKey)
  console.log('Channels:', repeater.config.channels, ' Retention:', repeater.config.retentionSeconds + 's', ' maxPeers:', repeater.config.swarmMaxPeers)
  console.log('Ciphertext-only mirror: this box holds NO encryption keys and cannot watch what it serves.')
  console.log('=======================')
  await repeater.start()
  const shutdown = async () => { await repeater.close(); process.exit(0) }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
  return repeater
}

// Run directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  startRepeater().catch((err) => { console.error(err); process.exit(1) })
}
