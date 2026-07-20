// blobsKey catalog enrichment (S20a — the S20 repeater enabler, "Option B").
//
// A keyless repeater box can replicate a feed drive's METADATA core straight from the
// public catalog's feedKey, but NOT its video blobs: on this stack the blobs core is a
// NAMED core whose key travels inside the drive's ENCRYPTED bee header
// (header.metadata.contentFeed) — it is not publicly derivable. The panel, however,
// already holds every registered stream's encryptionKey (register RPC → secrets file),
// so it alone can open the drive, read the blobs-core key out of the header, and
// publish it in the public catalog record as `blobsKey` — with ZERO broadcaster
// changes. Publishing it is safe: it only enables ENCRYPTED-block replication (what a
// repeater needs); watching still requires a per-user sealed grant key.
//
// Mechanics: the register responder (rpc.js) keeps `blobsKey` beside `feedKey` in the
// catalog record — preserved while the feedKey is unchanged, cleared to null when a
// register rotates it — and enqueues the stream here. Enrichment then runs OFF the RPC
// path: open the drive by feedKey + stored encryptionKey on the panel's own corestore,
// join the feed topic client-mode on the panel's own swarm (the broadcaster's channel
// swarm serves the header block), read the blobs key, and write it back — re-checking
// first that the record still carries the same feedKey (a rotation may have landed
// while the header replicated). Idempotent, retried with backoff, and bounded: a
// stream that can't be enriched (broadcaster offline, or a channel so freshly started
// that nothing has been written yet — the header block only exists once the first file
// lands) parks after maxAttempts and is re-enqueued by the next register (the
// broadcaster heartbeats its running state every 5 min). sweep() heals records from
// before this feature / registers missed while the panel was down. Every probe PURGES
// the cores it opened (see teardown) — otherwise the panel's control-plane disk would
// grow with every distinct feedKey it ever saw.

import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import { loadSecrets } from './store.js'

const DEFAULTS = {
  attemptTimeoutMs: 20000, // one header fetch (DHT lookup + dial + block 0)
  backoffBaseMs: 5000,
  backoffMaxMs: 60000,
  maxAttempts: 8 // ~4½ min of tries, then park until the next register re-enqueues
}

export function makeBlobsKeyEnricher ({ store, swarm, db, dataDir }, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const jobs = new Map() // streamId -> { attempts, wake } (present = loop running)
  const probes = new Set() // in-flight { drive, topic, torn } — force-torn by close()
  let closed = false

  // Fetch the blobs-core key for one feedKey. The drive opens on a namespaced session
  // of the panel's corestore, so the existing swarm 'connection' handler
  // (store.replicate) serves its replication; only the tiny header block is requested.
  // The namespace costs nothing on disk (corestore namespaces are in-memory key-derivation
  // salts, and this drive's cores are keyed anyway — see teardown) and has to stay
  // per-probe: drive.close() closes whatever corestore session it was handed, so a shared
  // probe namespace would be shut by whichever probe finished first.
  async function readBlobsKey (feedKeyHex, encKeyHex) {
    const drive = new Hyperdrive(store.namespace('blobs-probe:' + feedKeyHex), b4a.from(feedKeyHex, 'hex'), { encryptionKey: b4a.from(encKeyHex, 'hex') })
    // Registered BEFORE ready() so a failed open is torn down (and purged) too.
    const probe = { drive, topic: null, torn: null }
    probes.add(probe)
    try {
      await drive.ready()
      probe.topic = drive.discoveryKey
      swarm.join(drive.discoveryKey, { client: true, server: false })
      const open = drive.getBlobs()
      open.catch(() => {}) // a post-timeout settle must not become an unhandled rejection
      const blobs = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('blobs header timeout')), cfg.attemptTimeoutMs)
        open.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
      })
      return b4a.toString(blobs.core.key, 'hex')
    } finally {
      await teardown(probe)
    }
  }

  // Close a probe AND reclaim its disk.
  //
  // A probe drive's cores are KEYED — the metadata core by the feedKey, the blobs core by
  // the key inside the header — so corestore files them under <dataDir>/cores/<disc>/
  // regardless of the 'blobs-probe:' namespace, and drive.close() only ends the SESSION:
  // the directories stay behind forever with nothing to collect them. That grows with the
  // number of DISTINCT feedKeys ever probed, not with channel count, and since S28 every
  // periodic feed rotation (FEED_ROTATE_TREE_MB / FEED_ROTATE_HOURS) mints a fresh feedKey
  // and re-enqueues the stream here — so the panel's disk would grow with
  // rotations × channels, without bound.
  //
  // purge() closes every session of a core and unlinks its storage (oplog/tree/bitfield/
  // data); corestore opens those with rmdir, so the core directory goes with the last file.
  // Same call the repeater makes when it retires a rotated mirror (repeater/src/index.js).
  // The warm replication state this drops is worth nothing: a probe reads exactly one block
  // (the encrypted bee header) and throws the rest away.
  //
  // A RAM-backed probe store would avoid the panel's disk entirely, but it would have to be
  // replicated on the panel's swarm connections too — and a SECOND corestore on one
  // connection silently breaks the first: both call protomux pair() for 'hypercore/alpha',
  // and the later registration REPLACES the earlier one's on-demand core lookup, so the
  // panel would stop answering discovery-key requests for the signed DB and the assets
  // drive. Purging on the shared store is the contained fix.
  //
  // Idempotent — close() force-tears in-flight probes while readBlobsKey's own finally may
  // be running, so the delete + purge decision is taken synchronously here. Purging cannot
  // yank a sibling probe's session either: hyperdrive opens its bee core `exclusive`, so
  // only one probe per feedKey is ever open at a time.
  function teardown (probe) {
    if (probe.torn) return probe.torn
    probes.delete(probe)
    probe.torn = (async () => {
      if (probe.topic) { try { await swarm.leave(probe.topic) } catch {} }
      for (const core of [probe.drive.core, probe.drive.blobs && probe.drive.blobs.core]) {
        // A purge that fails only leaks disk (retried the next time this feedKey is
        // probed); it must never wedge the enricher, so fall back to a plain close.
        if (core) { try { await core.purge() } catch { try { await core.close() } catch {} } }
      }
      try { await probe.drive.close() } catch {}
    })()
    return probe.torn
  }

  // One enrichment attempt. Returns true when there is nothing (left) to do for the
  // stream's CURRENT record — enriched, un-enrichable, or gone. Throws/false = retry.
  async function attempt (streamId) {
    const rec = (await db.get('catalog/' + streamId))?.value
    if (!rec || !rec.feedKey || rec.blobsKey) return true
    const encKeyHex = loadSecrets(dataDir)[streamId]
    if (!encKeyHex) return true // panel never saw this stream's encryptionKey — cannot open
    const feedKeyHex = rec.feedKey
    const blobsKeyHex = await readBlobsKey(feedKeyHex, encKeyHex)
    // Re-read before writing: blobsKey must only ever sit beside the feedKey it
    // belongs to, and a rotation/delete may have landed while the header replicated.
    const rec2 = (await db.get('catalog/' + streamId))?.value
    if (!rec2 || rec2.feedKey !== feedKeyHex) return false // rotated underneath — retry against the new record
    if (!rec2.blobsKey) await db.put('catalog/' + streamId, { ...rec2, blobsKey: blobsKeyHex })
    return true
  }

  async function run (streamId, job) {
    try {
      while (!closed && job.attempts < cfg.maxAttempts) {
        try { if (await attempt(streamId)) return } catch {}
        if (closed) return
        const delay = Math.min(cfg.backoffBaseMs * 2 ** job.attempts, cfg.backoffMaxMs)
        job.attempts++
        await new Promise((resolve) => {
          job.wake = resolve
          job.timer = setTimeout(resolve, delay)
          if (job.timer.unref) job.timer.unref()
        })
        clearTimeout(job.timer); job.timer = null; job.wake = null
      }
    } finally {
      jobs.delete(streamId) // parked or done — the next enqueue starts a fresh loop
    }
  }

  return {
    // Fire-and-forget: never blocks the caller (the register RPC reply). A re-enqueue
    // of an in-flight stream resets its retry budget and wakes a sleeping backoff —
    // that is what makes rotation re-enrichment prompt.
    enqueue (streamId) {
      if (closed) return
      const job = jobs.get(streamId)
      if (job) {
        job.attempts = 0
        if (job.wake) job.wake()
        return
      }
      const fresh = { attempts: 0, wake: null, timer: null }
      jobs.set(streamId, fresh)
      run(streamId, fresh).catch(() => {})
    },

    // Enqueue every catalog record that has a feedKey + a stored secret but no
    // blobsKey yet (pre-upgrade catalogs; registers that landed while the panel was
    // down). Call once after the panel announces.
    async sweep () {
      const secrets = loadSecrets(dataDir)
      for await (const { key, value } of db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
        const id = key.slice('catalog/'.length)
        if (value && value.feedKey && !value.blobsKey && secrets[id]) this.enqueue(id)
      }
    },

    pending () { return jobs.size },

    async close () {
      closed = true
      for (const job of jobs.values()) { if (job.wake) job.wake() }
      // Force in-flight probes shut so their header waits reject promptly (and leave no
      // cores behind — a probe killed by shutdown is exactly as disposable as one that ran).
      await Promise.all([...probes].map(teardown))
    }
  }
}
