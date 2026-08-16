// GuideManager — the EPG service's engine.
//
//   ingest (src/ingest.js, pluggable) → normalized per-channel-per-day JSON
//     -> written into a PUBLIC epoch Hyperdrive at /v1/<streamId>/<YYYY-MM-DD>.json
//        (byte-compared first — a quiet refresh appends NOTHING, same frugality rule
//        as the panel's register put, panel/src/rpc.js S29)
//     -> drive announced {server:true} on its own discovery topic; viewers open a
//        sparse replica and lazily fetch only the files they display (the proven
//        assets-drive pattern, sdk/player.js `_doOpenAssets`)
//     -> the drive key reaches viewers via ONE panel bee record, meta/epgKey,
//        written through the publisher-scoped setEpgKey RPC (src/register.js)
//
// Epoch rotation (growth control): the drive's internal bee appends per put, so
// every `epochDays` a FRESH drive is minted under the next namespace, current
// window copied in, the panel pointer flipped (one bee block), the old drive kept
// for `graceHours` (viewers offline across the flip fall back to https), then
// drive.purge()d. Guide files older than yesterday are pruned daily — the drive
// holds a sliding window, not an archive.
//
// Channel mapping: this service reads the panel catalog EXACTLY like a repeater —
// a sparse client-only Hyperbee replica (repeater/src/index.js is the reference) —
// and matches each provider channel id against the catalog records' admin-owned
// `epgId` field. Files are written under the STREAM id; viewers never see provider
// ids. Unmatched provider ids surface in status() as an operator to-do.

import fs from 'fs'
import path from 'path'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import Rache from 'rache'
import { writeJsonAtomic } from '@aliran/core/atomic-write.js'
import { tuneSwarm, logSwarmTuning } from '@aliran/core/net-tune.js'

const HEX64 = /^[0-9a-f]{64}$/i
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

// Canonical serialization: stable key order + sorted programs, so the byte-compare
// below is sound (identical guide state ⇒ identical bytes ⇒ zero appends). Same
// soundness argument as the panel's idempotent register (panel/src/rpc.js S29).
export function canonicalDayJson (programs) {
  const rows = [...programs]
    .filter((p) => p && p.title && p.start && p.stop)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
    .map((p) => ({ title: String(p.title), start: String(p.start), stop: String(p.stop), ...(p.desc ? { desc: String(p.desc) } : {}) }))
  return b4a.from(JSON.stringify(rows))
}

export function utcDay (ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10)
}

// Free the blob blocks behind ONE superseded drive entry. Hypercore is append-only, and
// hyperdrive touches only the metadata bee: put() appends a NEW blob range and repoints
// the entry, del() drops the entry (node_modules/hyperdrive/index.js:311-315). In both
// cases the old bytes stay stored forever unless clear() frees them — the rule the panel
// states at panel/src/ops.js:626-631 and the broadcaster at broadcaster/src/hls.js:848-858.
// clear() is LOCAL-only: the merkle tree stays valid, so replication of everything still
// referenced is untouched; peers simply cannot fetch a range we no longer publish.
// blockLength 0 (dirs/symlinks/empty) and a drive with no blobs core are no-ops.
//
// `drive` is passed in rather than read from the manager: the caller must hand us the SAME
// drive it wrote to. An offset from one epoch cleared against another frees live blocks.
//
// This goes through hyperblobs' own clear(id) rather than core.clear(offset, length):
// hyperblobs handles an id carrying a blockMap before falling back to the contiguous range
// (node_modules/hyperblobs/index.js:185-193). hyperdrive.put only ever produces contiguous
// ids today, so the two agree — but reaching past the public method makes that an
// unwritten dependency, and pruneOldDays goes through the public drive.clear(name).
async function clearBlobRange (drive, blob) {
  if (!blob || !(blob.blockLength > 0)) return
  try {
    const blobs = await drive.getBlobs()
    if (blobs) await blobs.clear(blob)
  } catch { /* reclaim is best-effort — never fail a write or a prune over it */ }
}

export class GuideManager {
  constructor (config) {
    this.config = config
    this._store = null
    this._swarm = null
    this._bee = null // sparse panel-catalog replica (read-only)
    this._drive = null // current epoch drive (writer)
    this._prevDrive = null // kept open through the grace window so we still serve it
    this._prevEpoch = null // which epoch _prevDrive holds (so a purge closes the right session)
    // { epoch, driveKey, blobsKey, rotatedAt, pending: [ { epoch, driveKey, purgeAt } ],
    //   prev: <derived mirror of the newest pending entry — see _saveState> }
    this._state = null
    this._maintaining = false // _maintain runs off a bare setInterval; never let two overlap
    this._map = new Map() // providerId(epgId) -> streamId
    this._unmatched = new Map() // providerId -> count of guide entries we could not place
    this._puts = 0 // drive appends since boot (frugality telemetry)
    this._skips = 0 // byte-compare skips since boot
    this._closed = false
    this._watcher = null
    this._timers = []
    this.onRotate = null // set by index.js: async ({ key, epoch, rotatedAt }) => re-register the pointer
  }

  get statePath () { return path.join(this.config.dataDir, 'epoch.json') }

  // Epochs minted out of service but not yet purged, OLDEST first — and since purgeAt is
  // mintTime + graceHours, oldest-first is also earliest-deadline-first, so the LAST entry
  // is always the one with the longest left to live. Normally there is at most one (the
  // predecessor inside its grace window; config validation keeps GRACE_HOURS under a whole
  // epoch, epg/src/config.js). More than one means a purge is still owed from an earlier
  // rotation, and every entry but the last is past its deadline.
  get _pending () { return (this._state && this._state.pending) || [] }

  driveInfo () {
    return this._state && {
      key: this._state.driveKey,
      // The drive's blobs-core key rides along for RAW mirrors (the repeater serves
      // the guide as blind blocks, hyperdrive-free — it needs both core keys).
      // Viewers ignore it: they open the drive properly by its key alone.
      blobsKey: this._state.blobsKey ?? null,
      epoch: this._state.epoch,
      rotatedAt: this._state.rotatedAt
    }
  }

  async init () {
    fs.mkdirSync(this.config.dataDir, { recursive: true })
    this._store = new Corestore(path.join(this.config.dataDir, 'store'), { globalCache: new Rache({ maxSize: 4096 }) })
    await this._store.ready()

    const swarmOpts = { maxPeers: this.config.swarmMaxPeers }
    if (this.config.bootstrap.length) swarmOpts.bootstrap = this.config.bootstrap
    this._swarm = new Hyperswarm(swarmOpts)
    tuneSwarm(this._swarm, { recvBytes: this.config.swarmRcvBuf, sendBytes: this.config.swarmSndBuf })
      .then((r) => logSwarmTuning(r, (line) => console.log('[net]', line)))
      .catch(() => {})
    this._swarm.on('connection', (socket) => {
      if (this._closed) { try { socket.destroy() } catch {}; return }
      this._store.replicate(socket) // serves the guide drive(s) we hold; feeds our catalog replica
    })

    // Panel catalog replica — viewer-shaped: sparse, client-only, never announced.
    if (this.config.panelPubKey) {
      const panelKey = b4a.from(this.config.panelPubKey, 'hex')
      this._bee = new Hyperbee(this._store.get({ key: panelKey }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
      await this._bee.ready()
      this._swarm.join(hcrypto.hash(panelKey), { client: true, server: false })
      this._watchCatalog()
      await this._rebuildMapping().catch(() => {}) // first pass is best-effort; the watch retries
    }

    // Epoch state: resume the recorded epoch, or mint epoch 1.
    this._state = this._loadState()
    if (!this._state) {
      await this._mintEpoch(1)
    } else {
      this._drive = new Hyperdrive(this._store.namespace('epg-' + this._state.epoch))
      await this._drive.ready()
      // The recorded key must match the reopened drive — a mismatch means the state
      // file and store diverged (restored backup?); refuse to serve a wrong pointer.
      if (b4a.toString(this._drive.key, 'hex') !== this._state.driveKey) {
        throw new Error('epoch.json driveKey does not match the store — restore both or delete both')
      }
      if (!this._state.blobsKey) { // state written by an older build — backfill once
        const blobs = await this._drive.getBlobs()
        this._state.blobsKey = b4a.toString(blobs.core.key, 'hex')
        this._saveState()
      }
      this._announceDrive(this._drive)
      if (this._pending.length) await this._openPrevForGrace()
    }

    this._timers.push(setInterval(() => { this._maintain().catch((e) => console.warn('[epg] maintain:', e?.message || e)) }, 60 * 60 * 1000))
    return this
  }

  // --- catalog mapping ---

  _watchCatalog () {
    const run = async () => {
      while (!this._closed) {
        const watcher = this._bee.watch({ gt: 'catalog/', lt: 'catalog0' })
        this._watcher = watcher
        try {
          for await (const _ of watcher) { // eslint-disable-line no-unused-vars
            if (this._closed || this._watcher !== watcher) return
            await this._rebuildMapping().catch(() => {})
          }
        } catch { /* bee closing (shutdown) or transient */ }
        if (this._closed || this._watcher !== watcher) return
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
    run().catch(() => {})
  }

  // Sparse-replica read with a destroy deadline (repeater/src/index.js:209 — a dead
  // panel link parks a read forever otherwise).
  async _rebuildMapping () {
    if (!this._bee) return
    const map = new Map()
    const stream = this._bee.createReadStream({ gt: 'catalog/', lt: 'catalog0' })
    const timer = setTimeout(() => stream.destroy(new Error('catalog read timeout')), 60000)
    try {
      for await (const { key, value } of stream) {
        if (!value || !value.epgId) continue
        const id = key.slice('catalog/'.length)
        // First mapping wins on a duplicate epgId — deterministic (bee order), and a
        // duplicate is an operator mistake surfaced via status().
        if (!map.has(String(value.epgId))) map.set(String(value.epgId), id)
      }
    } finally {
      clearTimeout(timer)
    }
    if (!this._closed) this._map = map
  }

  // providerId -> streamId (config overrides win over catalog epgId matches).
  resolveStreamId (providerId, overrides) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, providerId)) return overrides[providerId]
    return this._map.get(String(providerId)) || null
  }

  noteUnmatched (providerId, entries) {
    this._unmatched.set(String(providerId), entries)
  }

  // --- guide writes ---

  // Write one channel-day. Returns 'put' | 'skip'. The byte-compare makes a quiet
  // refresh free — the drive only grows when a schedule genuinely changed.
  async putDay (streamId, day, programs) {
    if (!DAY_RE.test(day)) throw new Error('bad day: ' + day)
    const file = `/v1/${streamId}/${day}.json`
    const next = canonicalDayJson(programs)
    // PIN the epoch drive for the whole call. `this._drive` is reassigned by _mintEpoch and
    // nothing serialises this method against rotate(): ingest calls putDay from its own
    // per-provider interval (src/ingest.js) while _maintain rotates on the hourly one. Read
    // `this._drive` fresh at each await below and a rotation landing mid-call would take the
    // blob descriptor from the OLD epoch and clear it against the NEW one. That no-ops in
    // the instant after the mint (an empty core has nothing at that offset), but rotate()
    // then copies the whole window into that same core — and once the copy passes the
    // offset, the clear frees LIVE blocks of the epoch just minted. We are the writer;
    // there is no peer left to refetch them from.
    const drive = this._drive
    const cur = await drive.get(file).catch(() => null)
    if (cur && b4a.equals(cur, next)) { this._skips++; return 'skip' }
    // The day genuinely changed, so this put SUPERSEDES a blob range that nothing will
    // reference again — read the outgoing descriptor before the write, free it after.
    // Nothing above this line moved: a quiet cycle still costs exactly one read and
    // returns 'skip' before any of it, which is what keeps a refresh free.
    const stale = cur ? (await drive.entry(file).catch(() => null))?.value?.blob : null
    await drive.put(file, next)
    this._puts++
    // AFTER the put, never before. The entry must already point at the new bytes: clearing
    // first would, on a failed put, leave a live entry whose blocks are gone — and rotate()
    // reads EVERY entry, so one unreadable day would cost that day its copy.
    await clearBlobRange(drive, stale)
    return 'put'
  }

  // Drop days older than yesterday (UTC) — the sliding window. Runs from _maintain.
  // Returns the number of day-files dropped.
  async pruneOldDays () {
    const drive = this._drive // pinned for the whole sweep, for the reason putDay explains
    const floor = utcDay(Date.now() - 24 * 3600 * 1000)
    // clear() BEFORE del(), the pattern panel/src/ops.js uses in pruneUpdateArtifacts: clear resolves the
    // blob range THROUGH the drive entry, and del removes that entry. Reversed, the bytes
    // are unreachable and stay allocated forever. The EPG was the one place that called
    // del() alone, which is why a drive holding a 7-day window carried months of dead bytes.
    // The getBlobs() below is belt-and-braces, not the load-bearing part: hyperdrive opens
    // the blobs core eagerly for a WRITABLE drive, so on the epoch writer it has already
    // happened. It matters on read-only/replica drives, where clear() silently returns null
    // when `this.blobs` is still unset (node_modules/hyperdrive/index.js:333) — keeping the
    // call means this loop never depends on which of those a caller hands it.
    await drive.getBlobs().catch(() => null)
    let dropped = 0
    for await (const entry of drive.list('/v1', { recursive: true })) {
      const m = entry.key.match(/\/(\d{4}-\d{2}-\d{2})\.json$/)
      if (m && m[1] < floor) {
        try { await drive.clear(entry.key) } catch {}
        await drive.del(entry.key)
        dropped++
      }
    }
    return dropped
  }

  // --- epochs ---

  // null ONLY for a genuine first boot (no state file). A state file that exists but will
  // not parse FAILS CLOSED, like the driveKey-mismatch guard in init(): returning null
  // there would mint epoch 1 over a store that already holds epochs 1..n, reopening a
  // months-old namespace as "fresh" and orphaning every epoch above it — the same
  // unreachable-drive outcome this file works to prevent, reached from the other side.
  _loadState () {
    let raw
    try { raw = fs.readFileSync(this.statePath, 'utf8') } catch (e) {
      if (e && e.code === 'ENOENT') return null
      throw new Error(`epoch.json could not be read (${e?.message || e}) — refusing to mint a fresh epoch over an existing store`)
    }
    let s
    try { s = JSON.parse(raw) } catch (e) {
      throw new Error(`epoch.json is present but unparseable (${e?.message || e}) — refusing to mint a fresh epoch over an existing store; restore it or delete the data directory outright`)
    }
    if (!s || !Number.isInteger(s.epoch) || !HEX64.test(s.driveKey || '')) {
      throw new Error('epoch.json is present but carries no usable epoch/driveKey — refusing to mint a fresh epoch over an existing store')
    }
    // The pending-purge list was a single `prev` slot in earlier builds. Accept either and
    // normalize to `pending`, sorted oldest-first. An entry we cannot read a deadline from
    // is due now — a grace window we cannot date is not one we can defend, and leaving it
    // un-dated is exactly how an epoch stops being reachable.
    const raws = Array.isArray(s.pending) ? s.pending : (Array.isArray(s.prev) ? s.prev : (s.prev ? [s.prev] : []))
    s.pending = raws
      .filter((p) => p && Number.isInteger(p.epoch))
      .map((p) => ({ epoch: p.epoch, driveKey: p.driveKey || null, purgeAt: Number.isFinite(p.purgeAt) ? p.purgeAt : Date.now() }))
      .sort((a, b) => a.epoch - b.epoch)
    return s
  }

  _saveState () {
    // `pending` is the source of truth; nothing in this build reads `prev`. It is written
    // as a DERIVED mirror of the newest pending entry for exactly one reason: rolling this
    // deploy back must stay survivable. An older build reads `prev` as an OBJECT, and
    // handed a list it would announce a drive named `epg-undefined`. With the mirror in
    // place a downgrade instead degrades to the old single-slot behaviour — it grace-serves
    // and purges the newest epoch and forgets any older one, which is the bug it already
    // had, not a new failure. Recomputing here (rather than maintaining two fields) is what
    // stops the two from ever drifting apart.
    const pending = this._pending
    this._state.pending = pending
    this._state.prev = pending.length ? pending[pending.length - 1] : null
    writeJsonAtomic(this.statePath, this._state)
  }

  _announceDrive (drive) {
    this._swarm.join(drive.discoveryKey, { server: true, client: true })
  }

  async _mintEpoch (n) {
    const drive = new Hyperdrive(this._store.namespace('epg-' + n))
    await drive.ready()
    const blobs = await drive.getBlobs()
    // The outgoing epoch JOINS the pending-purge list — it never replaces what is already
    // on it. A single `prev` slot silently discarded anything still queued, and a discarded
    // epoch is unreachable forever: nothing in epoch.json names it, so no code path can
    // ever purge it and its whole drive sits on disk for the life of the box. Two ordinary
    // situations produced one — a purge that threw (it was dropped at the next rotation
    // instead of retried), and a service down across a rotation boundary, where _maintain
    // rotates on its first hourly tick and overwrites the prev it was about to purge.
    const pending = this._pending.slice()
    if (this._state) pending.push({ epoch: this._state.epoch, driveKey: this._state.driveKey, purgeAt: Date.now() + this.config.graceHours * 3600 * 1000 })
    this._drive = drive
    this._state = { epoch: n, driveKey: b4a.toString(drive.key, 'hex'), blobsKey: b4a.toString(blobs.core.key, 'hex'), rotatedAt: Date.now(), pending, prev: null }
    this._saveState()
    this._announceDrive(drive)
    console.log(`[epg] epoch ${n} drive ${this._state.driveKey.slice(0, 8)}… announced`)
  }

  // Grace-serve the predecessor with the latest deadline — the last list entry, since
  // purgeAt rises with the mint time. Anything older is past its window (config validation
  // caps GRACE_HOURS below one epoch, so only one can ever be inside its own), and so is
  // this entry once its own deadline has passed: both are purge-only, and re-announcing a
  // drive we are about to delete would be worse than not serving it.
  async _openPrevForGrace () {
    const prev = this._pending[this._pending.length - 1]
    if (!prev || Date.now() >= prev.purgeAt) return
    this._prevDrive = new Hyperdrive(this._store.namespace('epg-' + prev.epoch))
    this._prevEpoch = prev.epoch
    await this._prevDrive.ready()
    this._announceDrive(this._prevDrive)
  }

  // Rotate: mint epoch n+1, copy the current window in (files already byte-canonical),
  // flip the panel pointer via onRotate, grace-serve the old drive, purge later.
  async rotate () {
    const old = this._drive
    const oldEpoch = this._state.epoch
    await this._mintEpoch(oldEpoch + 1)
    let copied = 0
    let skipped = 0
    for await (const entry of old.list('/v1', { recursive: true })) {
      // Per ENTRY. _mintEpoch has ALREADY flipped this._drive, this._state and epoch.json
      // by the time we reach this loop, so letting one unreadable day throw out of rotate()
      // would strand the service mid-flip: onRotate never fires, the panel pointer keeps
      // naming the retired drive, rotatedAt has reset so nothing retries for another
      // epochDays, and the purge deletes the drive viewers are still being pointed at once
      // graceHours elapses. A skipped day costs one day of guide until the next ingest
      // refresh rewrites it; a thrown one costs the whole guide.
      try {
        const buf = await old.get(entry.key)
        if (buf) { await this._drive.put(entry.key, buf); copied++ }
      } catch (e) {
        skipped++
        console.warn(`[epg] rotate: could not copy ${entry.key} (${e?.message || e}) — the next ingest will rewrite it`)
      }
    }
    // Any predecessor still open here is one an earlier rotation left behind, and it is
    // past its grace: config validation keeps GRACE_HOURS under a single epoch, so minting
    // a new one means the last one's window has closed. Hand the session back rather than
    // leaking it until close().
    if (this._prevDrive && this._prevDrive !== old) { try { await this._prevDrive.close() } catch {} }
    this._prevDrive = old
    this._prevEpoch = oldEpoch
    const grace = this._pending[this._pending.length - 1]
    const owed = this._pending.length > 1 ? `; ${this._pending.length - 1} earlier epoch(s) still owed a purge` : ''
    const lost = skipped ? `, ${skipped} SKIPPED` : ''
    console.log(`[epg] rotated to epoch ${this._state.epoch} (${copied} files copied${lost}; old drive grace until ${new Date(grace.purgeAt).toISOString()}${owed})`)
    if (this.onRotate) await this.onRotate(this.driveInfo())
  }

  // Hourly: prune old days, rotate when the epoch aged out, purge the previous drive
  // once its grace passed. Each step independent — one failure must not stop the rest.
  async _maintain () {
    if (this._closed) return
    // This is driven by a bare setInterval that never awaits us, and the body below waits
    // on multi-GB filesystem deletes (purge) and a network write (rotate -> onRotate). Two
    // overlapping ticks could double-mint an epoch or race each other's state writes, so
    // one runs at a time and a tick that arrives early is simply the next hour's problem.
    if (this._maintaining) return
    this._maintaining = true
    try {
      await this._maintainOnce()
    } finally {
      this._maintaining = false
    }
  }

  async _maintainOnce () {
    try {
      const dropped = await this.pruneOldDays()
      if (dropped) console.log(`[epg] pruned ${dropped} day-file(s) out of the window (blob bytes reclaimed)`)
    } catch (e) { console.warn('[epg] prune:', e?.message || e) }
    const ageDays = (Date.now() - this._state.rotatedAt) / 86400000
    if (ageDays >= this.config.epochDays) {
      try { await this.rotate() } catch (e) { console.warn('[epg] rotate:', e?.message || e) }
    }
    // Drain the pending-purge list: EVERY epoch whose grace has passed, not only the
    // newest. A purge that throws stays on the list and is retried on the next tick
    // instead of being forgotten at the next rotation.
    if (!this._pending.length) return
    const purged = new Set()
    for (const p of this._pending.slice()) {
      if (Date.now() < p.purgeAt) continue
      // Reuse the open grace session when it is this epoch — purging a namespace out from
      // under a live drive session is not something to invite.
      const reuse = !!(this._prevDrive && this._prevEpoch === p.epoch)
      let drive = null
      try {
        drive = reuse ? this._prevDrive : new Hyperdrive(this._store.namespace('epg-' + p.epoch))
        // Whatever happens from here, this is no longer the grace-served session: purge()
        // closes it on the way through, and a failed attempt must not park a half-open
        // drive in _prevDrive for the next tick to reuse.
        if (reuse) { this._prevDrive = null; this._prevEpoch = null }
        await drive.ready()
        await drive.purge()
        drive = null // purge() closed it for us
        purged.add(p.epoch)
        console.log(`[epg] purged epoch ${p.epoch} drive after grace`)
      } catch (e) {
        console.warn('[epg] purge:', e?.message || e)
      } finally {
        // ready() can throw with the session already constructed. Since a failed entry stays
        // queued and is retried every hour, not closing here would leak a drive plus its
        // corestore session and open cores on EVERY tick, for ever.
        if (drive) { try { await drive.close() } catch {} }
      }
    }
    if (!purged.size) return
    // Filter the LIVE list — never write back one computed before the awaits above. Even
    // with the re-entrancy guard this is the honest way to express it: what we learned in
    // this loop is "these epochs are gone", and that is exactly what gets removed. A
    // precomputed keep-list would silently discard anything added to the list meanwhile,
    // which is the very orphan _mintEpoch's comment promises can no longer happen.
    this._state.pending = this._pending.filter((p) => !purged.has(p.epoch))
    this._saveState()
  }

  status () {
    return {
      epoch: this._state?.epoch ?? null,
      driveKey: this._state?.driveKey ?? null,
      rotatedAt: this._state?.rotatedAt ?? null,
      // `prev` keeps its old shape (the grace-served predecessor, or null) so scrapers
      // and /status readers are untouched; pendingPurge > 1 is the operator's signal that
      // an older epoch is still on disk owing a purge — previously invisible.
      prev: this._pending[this._pending.length - 1] ?? null,
      pendingPurge: this._pending.length,
      mappedChannels: this._map.size,
      unmatched: Object.fromEntries(this._unmatched),
      puts: this._puts,
      skips: this._skips,
      swarmConnections: this._swarm?.connections?.size ?? 0,
      catalogReplicated: !!(this._bee && this._bee.core.length > 0)
    }
  }

  async close () {
    this._closed = true
    for (const t of this._timers) clearInterval(t)
    this._timers = []
    if (this._watcher) { try { this._watcher.destroy() } catch {} }
    if (this._swarm) { try { await this._swarm.destroy() } catch {} }
    if (this._drive) { try { await this._drive.close() } catch {} }
    if (this._prevDrive) { try { await this._prevDrive.close() } catch {} }
    if (this._bee) { try { await this._bee.close() } catch {} }
    if (this._store) { try { await this._store.close() } catch {} }
  }
}
