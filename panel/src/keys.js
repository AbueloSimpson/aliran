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

  const signing = crypto.keyPair()
  fs.writeFileSync(signingPath, JSON.stringify({
    publicKey: b4a.toString(signing.publicKey, 'hex'),
    secretKey: b4a.toString(signing.secretKey, 'hex')
  }, null, 2), { mode: 0o600 })

  // OPRF secret scalar (32 bytes). Used to obliviously evaluate blinded passwords.
  const oprf = b4a.alloc(32)
  sodium.randombytes_buf(oprf)
  fs.writeFileSync(oprfPath, b4a.toString(oprf, 'hex'), { mode: 0o600 })

  // Publisher keypair (Ed25519): broadcasters sign stream registrations with the secret;
  // the panel verifies with the public key. The secret goes in the broadcaster config.
  const publisher = authKeyPair()
  fs.writeFileSync(path.join(dir, 'publisher.json'), JSON.stringify({
    publicKey: b4a.toString(publisher.publicKey, 'hex'),
    secretKey: b4a.toString(publisher.secretKey, 'hex')
  }, null, 2), { mode: 0o600 })

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
