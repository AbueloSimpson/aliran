// Panel storage:
//   - a single-writer, panel-SIGNED Hyperbee holding accounts + catalog (replicated to
//     clients; its key is the panel public key clients pin)
//   - a panel-PRIVATE secrets file holding plaintext stream encryption keys, never
//     replicated (used at grant time to seal a stream key to a user's public key)

import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import fs from 'fs'
import path from 'path'
import sodium from 'sodium-native'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { purgeStaleCores } from '@aliran/core/store-gc.js'
import { writeJsonAtomic } from '@aliran/core/atomic-write.js'
import { openEvents, EVENTS_KEY } from './events.js'

export async function openStore (dataDir, keys, opts = {}) {
  const store = new Corestore(dataDir)
  await store.ready()
  const core = store.get({ keyPair: keys.signing })
  const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await db.ready()

  // Assets Hyperdrive (posters/art). Panel-owned, replicated to clients; its key is
  // advertised in the signed DB under meta/assetsKey so clients can discover it.
  // blobsKey rides the record so a keyless repeater can mirror the art blobs without
  // opening the drive (precedent: the EPG pointer and meta/updatesKey below). Clients
  // read only .key, so an existing record gaining blobsKey costs one bee append at
  // the first boot after the upgrade and changes nothing for them.
  const assets = new Hyperdrive(store.namespace('assets'))
  await assets.ready()
  const assetsKeyHex = b4a.toString(assets.key, 'hex')
  const assetsBlobsHex = b4a.toString(assets.blobs.core.key, 'hex')
  const metaNode = await db.get('meta/assetsKey')
  if (!metaNode || metaNode.value.key !== assetsKeyHex || metaNode.value.blobsKey !== assetsBlobsHex) {
    await db.put('meta/assetsKey', { key: assetsKeyHex, blobsKey: assetsBlobsHex })
  }

  // Updates Hyperdrive (app OTA artifacts: /manifest.json + /pkg/ installers, ops.js).
  // Same ownership/discovery pattern as assets, advertised under meta/updatesKey.
  // blobsKey rides the record from day one so a keyless repeater can mirror the
  // artifact blobs without opening the drive (precedent: the EPG pointer). Reading
  // updates.blobs.core post-ready is safe on a writable drive — see guard 1 below.
  const updates = new Hyperdrive(store.namespace('updates'))
  await updates.ready()
  const updatesKeyHex = b4a.toString(updates.key, 'hex')
  const updatesBlobsHex = b4a.toString(updates.blobs.core.key, 'hex')
  const upNode = await db.get('meta/updatesKey')
  if (!upNode || upNode.value.key !== updatesKeyHex || upNode.value.blobsKey !== updatesBlobsHex) {
    await db.put('meta/updatesKey', { key: updatesKeyHex, blobsKey: updatesBlobsHex })
  }

  // Ephemeral events Hyperdrive (src/events.js, advertised as meta/eventsKey). Same
  // ownership/discovery pattern as assets and updates, with one difference that decides
  // where this call has to sit: the drive is EPOCH-ROTATED and MINTED ON FIRST USE, so its
  // cores are not among the panel's own five and would read as stray.
  //
  // ⚠ THIS MUST STAY ABOVE reclaimStrayCores. ready() opens the current epoch AND every
  // epoch still owed a purge; guard 2 below keeps every core the store holds OPEN, which is
  // the only thing standing between an events drive and `rmSync`. Move this call below the
  // sweep and the panel deletes its own events drive on the next boot.
  //
  // On a deployment with no ephemeral source there is no state file, so this opens nothing,
  // writes nothing and returns an inert manager — the whole feature is off by construction.
  // ⚠ "No state file" only means first boot when meta/eventsKey is ALSO absent; ready()
  // throws otherwise rather than let the sweep below reach an advertised drive. That makes
  // events-epoch.json load-bearing: it must travel with DATA_DIR in any restore.
  let events
  try {
    events = await openEvents({ store, db, dataDir, epochDays: opts.eventsEpochDays, graceHours: opts.eventsGraceHours })
  } catch (err) {
    // A refusal here is a boot failure, and a boot failure must not leave the corestore's
    // lock held: the operator's next move is to fix the data directory and start again, and
    // an orphaned lock would make that second attempt fail for a different reason.
    try { await store.close() } catch {}
    throw err
  }

  // Every core the panel owns is now open, and nothing else has opened one yet — the one
  // moment where the keep set below is complete by construction. The advertised events
  // pointer rides along as a SECOND, independent way to account for the events cores: see
  // the eventsPointer note on reclaimStrayCores.
  //
  // Read AFTER openEvents on purpose. A resumed manager re-advertises on the way through,
  // so a pointer record that had been corrupted is already repaired by the time we read it
  // here — and if it could not be repaired (no state file), openEvents threw and we never
  // reached this line. Either way the sweep below never runs against a record it cannot
  // account for.
  const eventsPointer = (await db.get(EVENTS_KEY))?.value ?? null
  const reclaimed = reclaimStrayCores(dataDir, { store, core, assets, updates, eventsPointer })
  if (reclaimed && reclaimed.removed > 0) {
    console.log(`[gc] reclaimed ${reclaimed.removed} stray core dir(s), ${(reclaimed.bytesFreed / 1e6).toFixed(2)} MB freed (blobsKey probe cores stranded by earlier builds)`)
  }

  return { store, db, core, assets, updates, events, reclaimed }
}

// The cores the panel owns AT A FIXED KEY: the signed bee (accounts + catalog) plus the
// metadata + blobs cores of the assets and updates drives. The events drive's epoch cores
// are owned too but are NOT fixed — they are covered by guard 2 below, not by this count,
// which is why the number does not move when an epoch rotates.
const PANEL_CORE_COUNT = 5

// One-shot start-time reclaim of stray cores (the sweep itself is @aliran/core/store-gc.js,
// shared with the broadcaster's retired-generation GC).
//
// Builds before the blobsKey enricher purged its own probes stranded one metadata + one
// blobs core per DISTINCT feedKey they ever opened, on the panel's own corestore
// (see blobs-key.js). The enricher no longer leaks, but nothing reclaims what those builds
// already wrote — on a long-lived deployment that is the bulk of an unattributed
// control-plane volume (docs/kb/scaling.md, "The panel's own disk").
//
// This is the one delete in the panel that could be UNRECOVERABLE: the bee is the
// single-writer origin of truth for accounts and the catalog, and there is no peer to
// re-replicate it from. So it is guarded twice, and both guards fail SAFE (skip the sweep,
// leak the disk, retry next start) rather than deleting anything they cannot account for:
//
//   1. all FIVE of the panel's own discovery keys must resolve. They do by construction
//      here — the bee core is opened by keyPair, and hyperdrive's _open() creates a WRITABLE
//      drive's blobs core during ready(), so neither drive's .blobs is null at this point.
//   2. every core the store currently holds OPEN is kept regardless. That is what carries
//      the EVENTS drive (src/events.js), whose epoch namespaces are minted at runtime and
//      cannot be enumerated from a fixed list — openStore opens the live epoch and every
//      pending one immediately above this call, so they are kept with no edit here. It also
//      means a sweep can never yank a core out from under a live session, so calling this
//      later (with an enricher probe in flight) would still be safe.
//   3. `eventsPointer` — the meta/eventsKey record, if one is advertised — is kept even when
//      nothing has it open. Guard 2 depends on the manager having resumed, and the manager
//      resumes off a FILE (events-epoch.json). A missing state file therefore used to mean
//      an inert manager plus two unaccounted core directories, and this sweep would delete
//      the very drive the signed bee is still pointing viewers at. events.js now refuses to
//      boot in that state, which is the real fix; this is the second lock on the same door,
//      derived from the bee rather than from the filesystem. Both keys go in because a
//      keyless mirror needs both and a sweep that kept only one would still be a delete.
//      ⚠ A pointer record that EXISTS but carries an unusable key skips the whole sweep.
//      Dropping just that key would make this guard ask the same question the boot check
//      asks — "is there a usable key" — and the two locks would open to one malformed
//      record between them. A record we cannot resolve is a core we cannot account for,
//      which is precisely the condition guard 1 already refuses to delete under.
export function reclaimStrayCores (dataDir, { store, core, assets, updates, eventsPointer }) {
  const keep = new Set()
  for (const c of [
    core,
    assets && assets.core, assets && assets.blobs && assets.blobs.core,
    updates && updates.core, updates && updates.blobs && updates.blobs.core
  ]) {
    try { if (c && c.discoveryKey) keep.add(b4a.toString(c.discoveryKey, 'hex')) } catch {}
  }
  if (keep.size !== PANEL_CORE_COUNT) return null // cannot account for our own cores — delete nothing
  for (const id of store.cores.keys()) keep.add(id)
  if (eventsPointer != null) {
    for (const hex of [eventsPointer.key, eventsPointer.blobsKey]) {
      if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) return null // a pointer we cannot resolve — delete nothing
      try { keep.add(b4a.toString(hcrypto.discoveryKey(b4a.from(hex, 'hex')), 'hex')) } catch { return null }
    }
  }
  try { return purgeStaleCores(dataDir, keep) } catch { return null }
}

// Argon2id parameters from config, recorded per-user so the client verifies with the
// same cost. (memlimit is bytes; opslimit is iterations.)
export function argonOpts (config) {
  return {
    opslimit: Math.max(config.argon2.time, sodium.crypto_pwhash_OPSLIMIT_MIN),
    memlimit: Math.max(config.argon2.memKiB * 1024, sodium.crypto_pwhash_MEMLIMIT_MIN)
  }
}

// --- panel-private stream secrets (NOT replicated) ---
function secretsPath (dataDir) { return path.join(dataDir, 'secrets', 'streams.json') }

export function loadSecrets (dataDir) {
  const p = secretsPath(dataDir)
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

// Atomic (tmp + fsync + rename): these are the per-stream keys every user grant seals
// against — a truncated write would make every existing grant worthless.
export function saveSecrets (dataDir, secrets) {
  writeJsonAtomic(secretsPath(dataDir), secrets, { mode: 0o600, dirMode: 0o700 })
}
