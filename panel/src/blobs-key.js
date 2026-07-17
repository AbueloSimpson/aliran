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
// before this feature / registers missed while the panel was down.

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
  const probes = new Set() // in-flight { drive, topic } — force-closed by close()
  let closed = false

  // Fetch the blobs-core key for one feedKey. The drive opens on a namespaced session
  // of the panel's corestore, so the existing swarm 'connection' handler
  // (store.replicate) serves its replication; only the tiny header block is requested.
  async function readBlobsKey (feedKeyHex, encKeyHex) {
    const drive = new Hyperdrive(store.namespace('blobs-probe:' + feedKeyHex), b4a.from(feedKeyHex, 'hex'), { encryptionKey: b4a.from(encKeyHex, 'hex') })
    await drive.ready()
    const probe = { drive, topic: drive.discoveryKey }
    probes.add(probe)
    try {
      swarm.join(drive.discoveryKey, { client: true, server: false })
      const open = drive.getBlobs()
      open.catch(() => {}) // a post-timeout settle must not become an unhandled rejection
      const blobs = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('blobs header timeout')), cfg.attemptTimeoutMs)
        open.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
      })
      return b4a.toString(blobs.core.key, 'hex')
    } finally {
      probes.delete(probe)
      try { await swarm.leave(probe.topic) } catch {}
      try { await drive.close() } catch {}
    }
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
      // Force in-flight probes shut so their header waits reject promptly.
      await Promise.all([...probes].map(async (p) => {
        try { await swarm.leave(p.topic) } catch {}
        try { await p.drive.close() } catch {}
      }))
    }
  }
}
