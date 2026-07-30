// Panel key management: the signing keypair (signs the account/catalog Hyperbee) and
// the secret OPRF key (the brute-force choke point). Stored under DATA_DIR/keys/.
//
// SECURITY: these files are the deployment's crown jewels. They are gitignored. Back
// them up securely (encrypted at rest — see docs/kb/backup-and-rotation.md); losing
// the OPRF key locks every user out, leaking it re-enables offline brute-force.
// Consider an HSM / OS keystore for production.

import fs from 'fs'
import path from 'path'
import crypto from 'hypercore-crypto'
import sodium from 'sodium-native'
import b4a from 'b4a'
import { authKeyPair } from '@aliran/core'
import { writeFileAtomic, writeJsonAtomic } from '@aliran/core/atomic-write.js'

function keysDir (dataDir) {
  return path.join(dataDir, 'keys')
}

// Generate and persist panel keys. Throws if they already exist (avoid clobbering).
export function initKeys (dataDir) {
  const dir = keysDir(dataDir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) // owner-only: this dir holds the crown jewels

  const signingPath = path.join(dir, 'signing.json')
  const oprfPath = path.join(dir, 'oprf.key')
  if (fs.existsSync(signingPath) || fs.existsSync(oprfPath)) {
    throw new Error('Panel keys already exist in ' + dir + ' — refusing to overwrite.')
  }

  // Each file is written atomically (tmp + fsync + rename). These are written ONCE and
  // initKeys refuses to overwrite them, so a truncated one is unrecoverable: a half-written
  // oprf.key still parses as hex and silently becomes a DIFFERENT key, locking out every
  // user. Whole-or-absent is the only safe outcome. (Atomicity is per file — a crash
  // between them can still leave a partial SET, which initKeys reports rather than fixes.)
  const signing = crypto.keyPair()
  writeJsonAtomic(signingPath, {
    publicKey: b4a.toString(signing.publicKey, 'hex'),
    secretKey: b4a.toString(signing.secretKey, 'hex')
  }, { mode: 0o600 })

  // OPRF secret scalar (32 bytes). Used to obliviously evaluate blinded passwords.
  const oprf = b4a.alloc(32)
  sodium.randombytes_buf(oprf)
  writeFileAtomic(oprfPath, b4a.toString(oprf, 'hex'), { mode: 0o600 })

  // Publisher keypair (Ed25519): broadcasters sign stream registrations with the secret;
  // the panel verifies with the public key. The secret goes in the broadcaster config.
  const publisher = authKeyPair()
  writeJsonAtomic(path.join(dir, 'publisher.json'), {
    publicKey: b4a.toString(publisher.publicKey, 'hex'),
    secretKey: b4a.toString(publisher.secretKey, 'hex')
  }, { mode: 0o600 })

  return {
    publicKeyHex: b4a.toString(signing.publicKey, 'hex'),
    publisherSecretHex: b4a.toString(publisher.secretKey, 'hex')
  }
}

// Load keys, or return null if not initialized.
export function openKeys (dataDir) {
  const dir = keysDir(dataDir)
  const signingPath = path.join(dir, 'signing.json')
  const oprfPath = path.join(dir, 'oprf.key')
  if (!fs.existsSync(signingPath) || !fs.existsSync(oprfPath)) return null

  const s = JSON.parse(fs.readFileSync(signingPath, 'utf8'))
  const out = {
    signing: {
      publicKey: b4a.from(s.publicKey, 'hex'),
      secretKey: b4a.from(s.secretKey, 'hex')
    },
    oprf: b4a.from(fs.readFileSync(oprfPath, 'utf8').trim(), 'hex')
  }
  const pubPath = path.join(dir, 'publisher.json')
  if (fs.existsSync(pubPath)) {
    const p = JSON.parse(fs.readFileSync(pubPath, 'utf8'))
    out.publisher = { publicKey: b4a.from(p.publicKey, 'hex'), secretKey: b4a.from(p.secretKey, 'hex') }
  }
  return out
}
