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

export class GuideManager {
  constructor (config) {
    this.config = config
    this._store = null
    this._swarm = null
    this._bee = null // sparse panel-catalog replica (read-only)
    this._drive = null // current epoch drive (writer)
    this._prevDrive = null // kept open through the grace window so we still serve it
    this._state = null // { epoch, driveKey, rotatedAt, prev: { epoch, driveKey, purgeAt } | null }
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
      if (this._state.prev) await this._openPrevForGrace()
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
    const cur = await this._drive.get(file).catch(() => null)
    if (cur && b4a.equals(cur, next)) { this._skips++; return 'skip' }
    await this._drive.put(file, next)
    this._puts++
    return 'put'
  }

  // Drop days older than yesterday (UTC) — the sliding window. Runs from _maintain.
  async pruneOldDays () {
    const floor = utcDay(Date.now() - 24 * 3600 * 1000)
    for await (const entry of this._drive.list('/v1', { recursive: true })) {
      const m = entry.key.match(/\/(\d{4}-\d{2}-\d{2})\.json$/)
      if (m && m[1] < floor) await this._drive.del(entry.key)
    }
  }

  // --- epochs ---

  _loadState () {
    try {
      const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      return s && Number.isInteger(s.epoch) && HEX64.test(s.driveKey || '') ? s : null
    } catch { return null }
  }

  _saveState () {
    writeJsonAtomic(this.statePath, this._state)
  }

  _announceDrive (drive) {
    this._swarm.join(drive.discoveryKey, { server: true, client: true })
  }

  async _mintEpoch (n) {
    const drive = new Hyperdrive(this._store.namespace('epg-' + n))
    await drive.ready()
    const blobs = await drive.getBlobs()
    this._drive = drive
    this._state = { epoch: n, driveKey: b4a.toString(drive.key, 'hex'), blobsKey: b4a.toString(blobs.core.key, 'hex'), rotatedAt: Date.now(), prev: this._state ? { epoch: this._state.epoch, driveKey: this._state.driveKey, purgeAt: Date.now() + this.config.graceHours * 3600 * 1000 } : null }
    this._saveState()
    this._announceDrive(drive)
    console.log(`[epg] epoch ${n} drive ${this._state.driveKey.slice(0, 8)}… announced`)
  }

  async _openPrevForGrace () {
    this._prevDrive = new Hyperdrive(this._store.namespace('epg-' + this._state.prev.epoch))
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
    for await (const entry of old.list('/v1', { recursive: true })) {
      const buf = await old.get(entry.key)
      if (buf) { await this._drive.put(entry.key, buf); copied++ }
    }
    this._prevDrive = old
    console.log(`[epg] rotated to epoch ${this._state.epoch} (${copied} files copied; old drive grace until ${new Date(this._state.prev.purgeAt).toISOString()})`)
    if (this.onRotate) await this.onRotate(this.driveInfo())
  }

  // Hourly: prune old days, rotate when the epoch aged out, purge the previous drive
  // once its grace passed. Each step independent — one failure must not stop the rest.
  async _maintain () {
    if (this._closed) return
    try { await this.pruneOldDays() } catch (e) { console.warn('[epg] prune:', e?.message || e) }
    const ageDays = (Date.now() - this._state.rotatedAt) / 86400000
    if (ageDays >= this.config.epochDays) {
      try { await this.rotate() } catch (e) { console.warn('[epg] rotate:', e?.message || e) }
    }
    if (this._state.prev && Date.now() >= this._state.prev.purgeAt) {
      try {
        const drive = this._prevDrive || new Hyperdrive(this._store.namespace('epg-' + this._state.prev.epoch))
        await drive.ready()
        await drive.purge()
        this._prevDrive = null
        console.log(`[epg] purged epoch ${this._state.prev.epoch} drive after grace`)
        this._state.prev = null
        this._saveState()
      } catch (e) { console.warn('[epg] purge:', e?.message || e) }
    }
  }

  status () {
    return {
      epoch: this._state?.epoch ?? null,
      driveKey: this._state?.driveKey ?? null,
      rotatedAt: this._state?.rotatedAt ?? null,
      prev: this._state?.prev ?? null,
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
