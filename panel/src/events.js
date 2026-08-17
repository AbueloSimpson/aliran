// Ephemeral event channels — a FEED, not a ledger (S57).
//
// THE PROBLEM. The panel's signed Hyperbee is an append-only, replicated LEDGER: nothing
// reads its history, but every superseded block stays on disk forever and nothing can ever
// reclaim it (docs/kb/panel-bee-compaction.md). Sports-event sources put ~550 channels
// through it that live a few hours each and are replaced roughly half per 30-minute sync.
// Even with the grant-map write amplifier fixed, the STRUCTURAL cost remains — measured at
// roughly 200-660 MB/day — because those records are written into a log that can never
// shrink. Compaction buys the disk back once; it does not stop the writer.
//
// THE SHAPE. An `ephemeral` source's channels never enter the bee at all. They are
// published into a panel-owned Hyperdrive whose superseded bytes ARE reclaimable, advertised
// in the signed bee under ONE record — `meta/eventsKey` = { key, blobsKey } — following the
// meta/assetsKey / meta/updatesKey idiom exactly (store.js). blobsKey rides the record so a
// keyless repeater can mirror the shards as blind blocks without opening the drive.
//
// THE WIRE FORMAT (the contract the viewer half is built against):
//
//   /v1/index.json            { rev, updatedAt, sources: [ { name, shard, count } ] }
//   /v1/<source>-<rev>.json   [ entry, … ] — one shard per source, the array a viewer renders
//
// `shard` in the index is the FULL drive path of that source's current revision, so a viewer
// never derives a filename: it reads the index and fetches exactly what the index names. The
// revision rides in the FILENAME (not in a header) so a superseded revision is a different
// path — which is what makes it clearable, and what makes a cached viewer unable to read a
// half-replaced file.
//
// FOUR RULES THAT ARE LOAD-BEARING HERE, none of them optional:
//
//   1. A superseded revision is clear()ed and THEN del()ed. del alone drops the metadata
//      entry and KEEPS the bytes (node_modules/hyperdrive/index.js:311-315) — the rule the
//      panel states at ops.js pruneUpdateArtifacts and the broadcaster at hls.js:848-858,
//      and the one the EPG service once missed to the tune of ~2 GB of dead guide.
//   2. Byte-compare before writing. A quiet cycle — the common case, since most of a sync
//      re-stamps identical entries — must append NOTHING to the drive either. Same
//      soundness argument as epg/src/guide.js putDay: canonical serialization means
//      identical state ⇒ identical bytes ⇒ zero appends.
//   3. Epoch rotation bounds the drive's OWN metadata bee, which is itself an append-only
//      hypercore: every put and del appends to it, so without rotation we would have moved
//      the unbounded log rather than removed it. Every `epochDays` a fresh drive is minted,
//      the current index+shards are copied in, `meta/eventsKey` is flipped (ONE bee block
//      per epoch), the old drive is grace-served, then purged.
//   4. ⚠ A retired epoch JOINS a pending-purge LIST — it never replaces what is already on
//      it. A single `prev` slot silently discards a queued epoch, and a discarded epoch is
//      unreachable FOREVER: nothing names it, so no code path can purge it and its whole
//      drive sits on disk for the life of the box. Two ordinary situations produce one — a
//      purge that threw, and a service down across a rotation boundary. (epg/src/guide.js
//      carries the same list for the same reason; its header has the full argument.)
//
// ⚠ THE STRAY-CORE GC. store.js `reclaimStrayCores()` rmSync-es every 64-hex core directory
// under DATA_DIR/cores that is neither one of the panel's five own cores nor a core the
// corestore currently holds OPEN. An epoch drive is neither — so `ready()` below OPENS the
// current epoch AND every pending one, and store.js calls it BEFORE the sweep. Skip that
// ordering and the panel deletes its own events drive on the next boot.
//
// DEFAULT OFF, and provably so: with no source marked `ephemeral` nothing here ever mints a
// drive, opens a core, or writes a bee record. `ready()` on a data directory with no
// events-epoch.json returns an inert manager.
//
// Entitlement does NOT live here. An ephemeral channel has no minted stream secret and
// therefore no sealed per-user grant; `user.eventSources` (packages.js) names the SOURCES a
// viewer may read, ~200 bytes written only when a bouquet changes. That is an ACL, not
// cryptography — the per-source shard layout is exactly the granularity a later
// `wrappedSources` hardening would seal against.

import fs from 'fs'
import path from 'path'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import { writeJsonAtomic } from '@aliran/core/atomic-write.js'

const HEX64 = /^[0-9a-f]{64}$/i
export const EVENTS_KEY = 'meta/eventsKey'
export const INDEX_PATH = '/v1/index.json'
export const V1_PREFIX = '/v1'

const namespaceOf = (epoch) => 'events-' + epoch
export const shardPath = (name, rev) => `${V1_PREFIX}/${name}-${rev}.json`

// The fields a viewer needs to RENDER and RESOLVE a channel, in a fixed order so
// JSON.stringify is canonical (rule 2 above depends on it). Deliberately the catalog
// record's own shape — a client can splice these straight into the lineup it already
// builds from `catalog/*` — plus the two an event has and a channel does not.
//
// `protection: 'none'` is the honest value and not an oversight: an ephemeral channel has
// no minted stream secret, so there is nothing to seal and nothing to unseal. Every
// ephemeral entry is a redirect (a provider url), which is the only kind of channel a
// source ever imports; a P2P feedKey is carried through anyway so the shape stays a
// superset of the catalog record rather than a subset of it.
export function canonicalEntry (id, m) {
  return {
    id,
    title: String(m.title ?? id),
    description: String(m.description ?? ''),
    category: Array.isArray(m.category) ? m.category.map(String) : [],
    type: 'live',
    protection: 'none',
    feedKey: m.feedKey ?? null,
    blobsKey: m.blobsKey ?? null,
    redirect: m.url != null,
    url: m.url ?? null,
    headers: m.headers ?? null,
    isLive: m.isLive !== false,
    poster: m.poster ?? null,
    backdrop: m.backdrop ?? null,
    logo: m.logo ?? null,
    order: Number.isFinite(m.order) ? m.order : 0,
    featured: m.featured === true,
    restricted: m.restricted === true,
    status: 'live',
    source: String(m.source ?? ''),
    epgUrl: m.epgUrl ?? null,
    epgId: m.epgId ?? null,
    // What separates an EVENT from a channel: the window it exists for. Null whenever the
    // feed does not declare it — an m3u playlist has no standard field for either, so the
    // pair is normally null and the client falls back to "on now" exactly as today.
    startsAt: m.startsAt ?? null,
    endsAt: m.endsAt ?? null
  }
}

export function canonicalShardJson (entries) {
  return b4a.from(JSON.stringify(entries))
}

function canonicalIndexJson (rev, updatedAt, shards) {
  const sources = [...shards.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) // stable across syncs
    .map(([name, s]) => ({ name, shard: s.shard, count: s.count }))
  return b4a.from(JSON.stringify({ rev, updatedAt, sources }))
}

// Free the blob blocks behind ONE superseded drive entry — the epg/src/guide.js helper,
// same argument: put() appends a NEW blob range and repoints the entry, del() drops the
// entry, and in BOTH cases the old bytes stay stored forever unless clear() frees them.
// clear() is LOCAL-only: the merkle tree stays valid, so replication of everything still
// referenced is untouched. Best-effort — a reclaim must never fail the write it follows.
async function clearBlobRange (drive, blob) {
  if (!blob || !(blob.blockLength > 0)) return
  try {
    const blobs = await drive.getBlobs()
    if (blobs) await blobs.clear(blob)
  } catch {}
}

export class EventsDrive {
  constructor ({ store, db, dataDir, epochDays = 7, graceHours = 6, log = console.log } = {}) {
    this._store = store
    this._db = db
    this._dataDir = dataDir
    this._epochDays = epochDays
    this._graceHours = graceHours
    this._log = log
    this._drive = null
    this._state = null
    // epoch -> Hyperdrive, held OPEN for two reasons at once: it grace-serves viewers who
    // have not seen the pointer flip, and it keeps the core out of reclaimStrayCores' jaws.
    this._pendingDrives = new Map()
    this._shards = new Map() // source -> { shard, count }
    this._entries = new Map() // source -> [ entry, … ] (the published array, in drive order)
    this._chain = Promise.resolve() // every mutation is read-modify-write over index.json
    this._closed = false
    this._puts = 0
    this._skips = 0
  }

  get statePath () { return path.join(this._dataDir, 'events-epoch.json') }
  get _pending () { return (this._state && this._state.pending) || [] }
  get enabled () { return !!this._drive }

  driveInfo () {
    if (!this._state) return null
    return {
      key: this._state.driveKey,
      blobsKey: this._state.blobsKey ?? null,
      epoch: this._state.epoch,
      rev: this._state.rev,
      rotatedAt: this._state.rotatedAt
    }
  }

  status () {
    return {
      enabled: this.enabled,
      epoch: this._state?.epoch ?? null,
      driveKey: this._state?.driveKey ?? null,
      rev: this._state?.rev ?? 0,
      rotatedAt: this._state?.rotatedAt ?? null,
      pendingPurge: this._pending.length,
      sources: [...this._shards.keys()].sort(),
      channels: [...this._entries.values()].reduce((n, list) => n + list.length, 0),
      puts: this._puts,
      skips: this._skips
    }
  }

  // Resume, or stay inert. MUST run before store.js's stray-core sweep (see the header).
  async ready () {
    this._state = this._loadState()
    if (!this._state) {
      // ⚠⚠ THE UNRECOVERABLE CASE, and the one branch that used not to fail closed.
      //
      // A MISSING events-epoch.json is indistinguishable from a first boot by looking at the
      // filesystem — but it is not indistinguishable from the BEE. If meta/eventsKey is
      // advertised, a drive was published: clients and repeaters have replicated its blocks,
      // and its cores are on disk holding nothing open. Returning inert here hands
      // reclaimStrayCores two unaccounted core directories to rmSync, and then
      // `namespaceOf(1)` re-mints epoch 1 at the SAME deterministic public key over an empty
      // history. Every peer holding an old block sees two valid signatures at one length —
      // a hypercore conflict at a pinned key, which is the class nothing recovers from.
      //
      // So the pointer is the authority on whether this is a first boot, and a state file
      // that has gone missing under an advertised drive fails closed exactly like an
      // unparseable one. The read is deliberately NOT wrapped in a catch: a bee we cannot
      // read is not a bee that told us there is no pointer.
      //
      // ⚠ THE TEST IS "IS THERE A RECORD", NOT "IS THERE A USABLE KEY". A pointer whose key
      // is empty or malformed is not a first boot either — a drive was published and
      // something has since corrupted the record — and reading it as one walks straight
      // back into the case above, defeating the sweep's own guard on the way past (it
      // validates hex too, so a malformed key would slip through BOTH). _advertise() only
      // ever writes well-formed values, so this is reachable only by corruption or a hand
      // edit; a malformed pointer is a reason to stop, never a reason to proceed.
      const node = this._db ? await this._db.get(EVENTS_KEY) : null
      if (node && node.value) {
        const key = typeof node.value.key === 'string' && node.value.key ? node.value.key : null
        throw new Error(
          `events-epoch.json is missing while ${EVENTS_KEY} is still present` +
          (key ? ` (it advertises drive ${key.slice(0, 16)}…)` : ' (and carries no usable drive key — the record is corrupt)') +
          ' — refusing to mint a fresh epoch at the same key over an existing history. Restore events-epoch.json from the ' +
          'backup archive (it lives in DATA_DIR beside sources.json and is load-bearing), or, only if no viewer has ever ' +
          `replicated this drive, delete the ${EVENTS_KEY} record and the events cores together.`
        )
      }
      return this // genuine first boot: nothing was ever published, no core, no bee record
    }
    this._drive = new Hyperdrive(this._store.namespace(namespaceOf(this._state.epoch)))
    await this._drive.ready()
    // A recorded key that does not match the reopened namespace means the state file and
    // the store diverged (a restored backup?). Refuse to serve a pointer to a drive we do
    // not hold — the same fail-closed stance epg/src/guide.js takes.
    if (b4a.toString(this._drive.key, 'hex') !== this._state.driveKey) {
      throw new Error('events-epoch.json driveKey does not match the store — restore both or delete both')
    }
    if (!this._state.blobsKey) { // written by an older build — backfill once
      const blobs = await this._drive.getBlobs()
      this._state.blobsKey = b4a.toString(blobs.core.key, 'hex')
      this._saveState()
    }
    for (const p of this._pending) await this._openPending(p.epoch)
    await this._advertise()
    await this._loadIndex()
    return this
  }

  // --- state ---------------------------------------------------------------------------

  // null ONLY for a genuine first boot. A file that exists but will not parse FAILS CLOSED:
  // returning null there would mint epoch 1 over a store that already holds epochs 1..n,
  // reopening a stale namespace as "fresh" and orphaning every epoch above it — the exact
  // unreachable-drive outcome rule 4 exists to prevent, reached from the other side.
  _loadState () {
    let raw
    try { raw = fs.readFileSync(this.statePath, 'utf8') } catch (e) {
      if (e && e.code === 'ENOENT') return null
      throw new Error(`events-epoch.json could not be read (${e?.message || e}) — refusing to mint a fresh epoch over an existing store`)
    }
    let s
    try { s = JSON.parse(raw) } catch (e) {
      throw new Error(`events-epoch.json is present but unparseable (${e?.message || e}) — refusing to mint a fresh epoch over an existing store`)
    }
    if (!s || !Number.isInteger(s.epoch) || !HEX64.test(s.driveKey || '')) {
      throw new Error('events-epoch.json carries no usable epoch/driveKey — refusing to mint a fresh epoch over an existing store')
    }
    s.rev = Number.isInteger(s.rev) ? s.rev : 0
    // An entry we cannot read a deadline from is due NOW: a grace window we cannot date is
    // not one we can defend, and leaving it un-dated is exactly how an epoch stops being
    // reachable. Oldest first, which is also earliest-deadline-first.
    s.pending = (Array.isArray(s.pending) ? s.pending : [])
      .filter((p) => p && Number.isInteger(p.epoch))
      .map((p) => ({ epoch: p.epoch, driveKey: p.driveKey || null, purgeAt: Number.isFinite(p.purgeAt) ? p.purgeAt : Date.now() }))
      .sort((a, b) => a.epoch - b.epoch)
    return s
  }

  _saveState () { writeJsonAtomic(this.statePath, this._state) }

  // --- the drive ------------------------------------------------------------------------

  // Mint on FIRST USE, never at boot: this is what makes the whole feature default-off.
  // A deployment with no ephemeral source never reaches here, so its bee is byte-identical
  // to a deployment without this code at all.
  async _ensureDrive () {
    if (this._drive) return this._drive
    await this._mintEpoch(1)
    return this._drive
  }

  async _mintEpoch (n) {
    const drive = new Hyperdrive(this._store.namespace(namespaceOf(n)))
    await drive.ready()
    const blobs = await drive.getBlobs()
    // ⚠ RULE 4. The outgoing epoch JOINS the list; it never replaces what is on it.
    const pending = this._pending.slice()
    if (this._state) {
      pending.push({ epoch: this._state.epoch, driveKey: this._state.driveKey, purgeAt: Date.now() + this._graceHours * 3600 * 1000 })
    }
    const rev = this._state ? this._state.rev : 0 // revisions are monotonic ACROSS epochs
    this._drive = drive
    this._state = {
      epoch: n,
      driveKey: b4a.toString(drive.key, 'hex'),
      blobsKey: b4a.toString(blobs.core.key, 'hex'),
      rotatedAt: Date.now(),
      rev,
      pending
    }
    this._saveState()
    await this._advertise()
    this._log(`[events] epoch ${n} drive ${this._state.driveKey.slice(0, 8)}… advertised as ${EVENTS_KEY}`)
  }

  // ONE bee record, written only when it actually changes — the meta/assetsKey rule. A
  // rotation is therefore exactly one appended block per epoch, and a restart is zero.
  async _advertise () {
    if (!this._db || !this._state) return
    const want = { key: this._state.driveKey, blobsKey: this._state.blobsKey }
    const node = await this._db.get(EVENTS_KEY)
    if (node && node.value && node.value.key === want.key && node.value.blobsKey === want.blobsKey) return false
    await this._db.put(EVENTS_KEY, want)
    return true
  }

  async _openPending (epoch) {
    if (this._pendingDrives.has(epoch)) return this._pendingDrives.get(epoch)
    const drive = new Hyperdrive(this._store.namespace(namespaceOf(epoch)))
    await drive.ready()
    this._pendingDrives.set(epoch, drive)
    return drive
  }

  // --- reading --------------------------------------------------------------------------

  async _loadIndex () {
    this._shards = new Map()
    this._entries = new Map()
    const buf = await this._drive.get(INDEX_PATH).catch(() => null)
    if (!buf) return
    let idx
    try { idx = JSON.parse(b4a.toString(buf)) } catch { return } // written only by us — a bad parse is nothing to keep
    for (const s of (idx && idx.sources) || []) {
      if (!s || typeof s.name !== 'string' || typeof s.shard !== 'string') continue
      const shardBuf = await this._drive.get(s.shard).catch(() => null)
      const list = shardBuf ? (() => { try { return JSON.parse(b4a.toString(shardBuf)) } catch { return null } })() : null
      if (!Array.isArray(list)) continue
      this._shards.set(s.name, { shard: s.shard, count: list.length })
      this._entries.set(s.name, list)
    }
    // The recorded rev must never be BELOW anything the drive already names. A crash
    // between the index write and the state write would otherwise hand the next publish a
    // path that already exists — overwriting a live shard and then, one line later,
    // reclaiming the bytes it had just written. Revisions are free; reusing one is not.
    if (Number.isInteger(idx.rev) && idx.rev > this._state.rev) { this._state.rev = idx.rev; this._saveState() }
  }

  /** The published lineup as id -> entry. What package selectors and the liveness prober read. */
  snapshot () {
    const out = new Map()
    for (const list of this._entries.values()) for (const e of list) if (e && e.id) out.set(e.id, e)
    return out
  }

  entries (name) { return this._entries.get(name) || [] }
  sources () { return [...this._shards.keys()] }

  // --- writing --------------------------------------------------------------------------

  // Every mutation is a read-modify-write over ONE index file, so two interleaved publishes
  // would drop a shard entry. Same serialization chain as ops.js putUpdate, and for the
  // same reason: two ephemeral sources CAN sync concurrently (manual syncs over the admin
  // API are not ordered by the scheduler).
  _serialize (fn) {
    const run = this._chain.then(fn)
    this._chain = run.then(() => {}, () => {})
    return run
  }

  /**
   * Publish one source's channels. `mapped` is the mapper's Map(id -> fields).
   * Returns { changed, rev, shard, count, reclaimed, added, updated, removed, unchanged }.
   */
  publish (name, mapped) {
    return this._serialize(async () => {
      await this._ensureDrive()
      const prev = this._shards.get(name) || null
      const prevById = new Map((this._entries.get(name) || []).map((e) => [e.id, e]))
      const next = []
      const diff = { added: 0, updated: 0, unchanged: 0, removed: 0 }
      for (const [id, m] of mapped) {
        const before = prevById.get(id)
        // isLive is PANEL-owned, exactly as it is on a catalog record: the source stamps it
        // true at creation and the liveness prober owns it from then on (applyFeed's
        // `...cur` spread is the same carry-forward on the bee side). Without this a sync
        // would undim every dead event every half hour and the prober would never win.
        const entry = canonicalEntry(id, { ...m, source: name, isLive: before ? before.isLive !== false : true })
        if (!before) diff.added++
        else if (JSON.stringify(before) !== JSON.stringify(entry)) diff.updated++
        else diff.unchanged++
        next.push(entry)
      }
      for (const id of prevById.keys()) if (!mapped.has(id)) diff.removed++
      return { ...diff, ...(await this._writeShard(name, next, prev)) }
    })
  }

  // Apply liveness verdicts across every shard they touch. `verdicts` is
  // id -> { isLive, probedUrl }, and the two guards are the ones liveness.js states for the
  // bee side, enforced here because this is where the write happens:
  //
  //   - put-only-on-flip: a verdict that restates what the shard already says writes
  //     nothing, so a steadily-dead channel costs the drive nothing sweep after sweep
  //   - a verdict whose probedUrl no longer matches the published one is STALE and is
  //     dropped: the judgement belongs to the old url, and a sync may have re-stamped a
  //     token between the snapshot and now
  //
  // Returns { flipped, ids } — the ids are what the caller records to the activity ring,
  // so only flips that really landed are reported.
  applyLiveness (verdicts) {
    return this._serialize(async () => {
      if (!this._drive || !verdicts || verdicts.size === 0) return { flipped: 0, ids: [] }
      const ids = []
      for (const [name, list] of [...this._entries.entries()]) {
        let dirty = false
        const next = list.map((e) => {
          const v = verdicts.get(e.id)
          if (!v) return e
          if (v.probedUrl != null && e.url !== v.probedUrl) return e // the entry moved — this verdict is stale
          const want = v.isLive !== false
          if ((e.isLive !== false) === want) return e
          dirty = true
          ids.push(e.id)
          return { ...e, isLive: want }
        })
        if (dirty) await this._writeShard(name, next, this._shards.get(name) || null)
      }
      return { flipped: ids.length, ids }
    })
  }

  /** Drop a source's shard entirely (removeSource). Clears the bytes, not just the entry. */
  dropSource (name) {
    return this._serialize(async () => {
      if (!this._drive || !this._shards.has(name)) return { dropped: false }
      const prev = this._shards.get(name)
      this._shards.delete(name)
      this._entries.delete(name)
      await this._writeIndex()
      await this._retire(prev.shard)
      return { dropped: true, shard: prev.shard }
    })
  }

  // The write path. RULE 2 first: a shard whose canonical bytes are unchanged costs a
  // single read and returns without appending anything — not the shard, not the index.
  async _writeShard (name, entries, prev) {
    const bytes = canonicalShardJson(entries)
    if (prev) {
      const cur = await this._drive.get(prev.shard).catch(() => null)
      if (cur && b4a.equals(cur, bytes)) {
        this._skips++
        return { changed: false, rev: this._state.rev, shard: prev.shard, count: entries.length, reclaimed: 0 }
      }
    }
    // The counter is persisted BEFORE the path that uses it exists. A crash here leaves a
    // GAP in the numbering, which costs nothing; the other order leaves a rev that the
    // drive has already spent, which is a shard path being reused (see _loadIndex).
    const rev = ++this._state.rev
    this._saveState()
    const shard = shardPath(name, rev)
    await this._drive.put(shard, bytes)
    this._puts++
    this._shards.set(name, { shard, count: entries.length })
    this._entries.set(name, entries)
    await this._writeIndex()
    // RULE 1, and AFTER the index no longer names it. Reclaiming first would, on a failed
    // write, leave an index entry whose blocks are gone — a viewer reading a file we can
    // no longer serve. This way round the worst case is a leaked range, retried never but
    // bounded by the epoch.
    const reclaimed = prev && prev.shard !== shard ? await this._retire(prev.shard) : 0
    return { changed: true, rev, shard, count: entries.length, reclaimed }
  }

  // ⚠ clear() BEFORE del(). clear resolves the blob range THROUGH the drive entry and del
  // removes that entry — reversed, the bytes are unreachable and stay allocated forever.
  // The getBlobs() is what makes clear() do anything at all: hyperdrive's clear returns
  // null and frees NOTHING while drive.blobs is still unset.
  async _retire (file) {
    let blocks = 0
    try {
      await this._drive.getBlobs()
      const e = await this._drive.entry(file).catch(() => null)
      blocks = e?.value?.blob?.blockLength ?? 0
      try { await this._drive.clear(file) } catch {}
      await this._drive.del(file)
    } catch {} // a shard that is already gone is the outcome we wanted
    return blocks
  }

  // index.json keeps ONE path across revisions (a viewer needs a fixed entry point), so its
  // superseded blob is freed by descriptor the way ops.js uploadArt does — read before the
  // put, clear after it.
  async _writeIndex () {
    const bytes = canonicalIndexJson(this._state.rev, Date.now(), this._shards)
    let stale = null
    try {
      await this._drive.getBlobs()
      stale = (await this._drive.entry(INDEX_PATH, { wait: false }))?.value?.blob ?? null
    } catch {}
    await this._drive.put(INDEX_PATH, bytes)
    this._puts++
    await clearBlobRange(this._drive, stale)
  }

  // --- epochs ---------------------------------------------------------------------------

  /** Hourly from index.js: rotate when the epoch aged out, then drain the purge queue. */
  async maintain () {
    if (this._closed || !this._state) return { rotated: false, purged: [] }
    let rotated = false
    if ((Date.now() - this._state.rotatedAt) / 86400000 >= this._epochDays) {
      try { await this.rotate(); rotated = true } catch (e) { this._log(`[events] rotate: ${e?.message || e}`) }
    }
    const purged = await this._drainPurges()
    return { rotated, purged }
  }

  // Mint the next epoch, copy the whole /v1 tree in, flip the pointer, grace-serve the old
  // drive, purge it later. The copy is small by construction — one index plus one shard per
  // ephemeral source — which is the whole reason rotation is cheap enough to be routine.
  rotate () {
    return this._serialize(async () => {
      if (!this._drive) return { rotated: false }
      const old = this._drive
      const oldEpoch = this._state.epoch
      await this._mintEpoch(oldEpoch + 1)
      let copied = 0
      let skipped = 0
      for await (const entry of old.list(V1_PREFIX, { recursive: true })) {
        // Per ENTRY. _mintEpoch has ALREADY flipped the drive, the state file and the bee
        // pointer, so letting one unreadable file throw out of rotate() would strand the
        // service mid-flip: the new epoch would serve a partial tree and the purge would
        // delete the old one once grace elapsed. A skipped shard costs that source its
        // lineup until its next sync rewrites it; a thrown one costs every source.
        try {
          const buf = await old.get(entry.key)
          if (buf) { await this._drive.put(entry.key, buf); copied++ }
        } catch (e) {
          skipped++
          this._log(`[events] rotate: could not copy ${entry.key} (${e?.message || e}) — the next sync rewrites it`)
        }
      }
      this._pendingDrives.set(oldEpoch, old)
      const grace = this._pending[this._pending.length - 1]
      const owed = this._pending.length > 1 ? `; ${this._pending.length - 1} earlier epoch(s) still owed a purge` : ''
      this._log(`[events] rotated to epoch ${this._state.epoch} (${copied} file(s) copied${skipped ? `, ${skipped} SKIPPED` : ''}; old drive grace until ${new Date(grace.purgeAt).toISOString()}${owed})`)
      return { rotated: true, epoch: this._state.epoch, copied, skipped }
    })
  }

  // Drain EVERY epoch whose grace has passed, not only the newest. A purge that throws
  // stays on the list and is retried on the next tick instead of being forgotten at the
  // next rotation — which is precisely how an epoch used to become unreachable.
  async _drainPurges () {
    if (!this._pending.length) return []
    const purged = new Set()
    for (const p of this._pending.slice()) {
      if (Date.now() < p.purgeAt) continue
      let drive = this._pendingDrives.get(p.epoch) || null
      const held = !!drive
      try {
        if (!drive) drive = new Hyperdrive(this._store.namespace(namespaceOf(p.epoch)))
        // Whatever happens from here this is no longer a grace session: purge() closes it
        // on the way through, and a failed attempt must not park a half-open drive for the
        // next tick to reuse.
        this._pendingDrives.delete(p.epoch)
        if (!held) await drive.ready()
        await drive.purge()
        drive = null // purge() closed it for us
        purged.add(p.epoch)
        this._log(`[events] purged epoch ${p.epoch} drive after grace`)
      } catch (e) {
        this._log(`[events] purge: ${e?.message || e}`)
      } finally {
        // ready() can throw with the session already constructed. The entry stays queued and
        // is retried every hour, so not closing here would strand a drive, its corestore
        // session and its cores on EVERY tick, for ever.
        if (drive) { try { await drive.close() } catch {} }
      }
    }
    if (!purged.size) return []
    // Filter the LIVE list — never write back one computed before the awaits above, or a
    // rotation that landed mid-drain would be silently discarded: the very orphan rule 4
    // exists to prevent, reintroduced by the fix for it.
    this._state.pending = this._pending.filter((p) => !purged.has(p.epoch))
    this._saveState()
    return [...purged]
  }

  async close () {
    this._closed = true
    for (const d of this._pendingDrives.values()) { try { await d.close() } catch {} }
    this._pendingDrives.clear()
    if (this._drive) { try { await this._drive.close() } catch {} }
  }
}

// The panel's factory. Returns an INERT manager when nothing was ever published — no core
// opened, no bee record written, no state file created.
export async function openEvents (opts) {
  return new EventsDrive(opts).ready()
}
