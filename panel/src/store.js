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
import b4a from 'b4a'
import { purgeStaleCores } from '@aliran/core/store-gc.js'
import { writeJsonAtomic } from '@aliran/core/atomic-write.js'

export async function openStore (dataDir, keys) {
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

  // Every core the panel owns is now open, and nothing else has opened one yet — the one
  // moment where the keep set below is complete by construction.
  const reclaimed = reclaimStrayCores(dataDir, { store, core, assets, updates })
  if (reclaimed && reclaimed.removed > 0) {
    console.log(`[gc] reclaimed ${reclaimed.removed} stray core dir(s), ${(reclaimed.bytesFreed / 1e6).toFixed(2)} MB freed (blobsKey probe cores stranded by earlier builds)`)
  }

  return { store, db, core, assets, updates, reclaimed }
}

// The cores the panel OWNS: the signed bee (accounts + catalog) plus the metadata +
// blobs cores of the assets and updates drives. Anything else under <dataDir>/cores/
// is stray.
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
//   2. every core the store currently holds OPEN is kept regardless. Today that is the same
//      five, but it is what keeps this correct if openStore ever opens a sixth: it is kept
//      automatically, with no edit here. It also means a sweep can never yank a core out
//      from under a live session, so calling this later (with an enricher probe in flight)
//      would still be safe.
export function reclaimStrayCores (dataDir, { store, core, assets, updates }) {
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
