// Panel storage:
//   - a single-writer, panel-SIGNED Hyperbee holding accounts + catalog (replicated to
//     clients; its key is the panel public key clients pin)
//   - a panel-PRIVATE secrets file holding plaintext stream encryption keys, never
//     replicated (used at grant time to seal a stream key to a user's public key)

import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import fs from 'fs'
import path from 'path'
import sodium from 'sodium-native'

export async function openStore (dataDir, keys) {
  const store = new Corestore(dataDir)
  await store.ready()
  const core = store.get({ keyPair: keys.signing })
  const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await db.ready()
  return { store, db, core }
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
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(secrets, null, 2), { mode: 0o600 })
}
