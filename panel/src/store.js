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

export async function openStore (dataDir, keys) {
  const store = new Corestore(dataDir)
  await store.ready()
  const core = store.get({ keyPair: keys.signing })
  const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await db.ready()

  // Assets Hyperdrive (posters/art). Panel-owned, replicated to clients; its key is
  // advertised in the signed DB under meta/assetsKey so clients can discover it.
  const assets = new Hyperdrive(store.namespace('assets'))
  await assets.ready()
  const assetsKeyHex = b4a.toString(assets.key, 'hex')
  const metaNode = await db.get('meta/assetsKey')
  if (!metaNode || metaNode.value.key !== assetsKeyHex) await db.put('meta/assetsKey', { key: assetsKeyHex })

  // Every core the panel owns is now open, and nothing else has opened one yet — the one
  // moment where the keep set below is complete by construction.
  const reclaimed = reclaimStrayCores(dataDir, { store, core, assets })
  if (reclaimed && reclaimed.removed > 0) {
    console.log(`[gc] reclaimed ${reclaimed.removed} stray core dir(s), ${(reclaimed.bytesFreed / 1e6).toFixed(2)} MB freed (blobsKey probe cores stranded by earlier builds)`)
  }

  return { store, db, core, assets, reclaimed }
}

// The cores the panel OWNS: the signed bee (accounts + catalog) and the assets drive's
// metadata + blobs cores. Anything else under <dataDir>/cores/ is stray.
const PANEL_CORE_COUNT = 3

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
//   1. all THREE of the panel's own discovery keys must resolve. They do by construction
//      here — the bee core is opened by keyPair, and hyperdrive's _open() creates a WRITABLE
//      drive's blobs core during ready(), so assets.blobs is never null at this point.
//   2. every core the store currently holds OPEN is kept regardless. Today that is the same
//      three, but it is what keeps this correct if openStore ever opens a fourth: it is kept
//      automatically, with no edit here. It also means a sweep can never yank a core out
//      from under a live session, so calling this later (with an enricher probe in flight)
//      would still be safe.
export function reclaimStrayCores (dataDir, { store, core, assets }) {
  const keep = new Set()
  for (const c of [core, assets && assets.core, assets && assets.blobs && assets.blobs.core]) {
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

export function saveSecrets (dataDir, secrets) {
  const p = secretsPath(dataDir)
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }) // owner-only secrets dir
  fs.writeFileSync(p, JSON.stringify(secrets, null, 2), { mode: 0o600 })
}
