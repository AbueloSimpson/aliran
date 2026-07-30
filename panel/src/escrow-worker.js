// Argon2id key derivation for key escrow, off the main thread.
//
// Same reasoning as admin-verify-worker.js, and a harder case: the escrow KDF runs at
// MODERATE limits or higher (256 MiB and up, tunable — see src/escrow.js), so on the
// main thread one export would freeze catalog replication and every viewer login for
// seconds. Escrow is rare, but "rare" is not "free", and a panel must not stutter
// because an operator pressed Export.
//
// The derived key crosses back as hex. It is a 32-byte AEAD key, not a password, and
// it never touches disk on either side.

import { parentPort } from 'worker_threads'
import b4a from 'b4a'
import { deriveKey } from './escrow.js'

parentPort.on('message', ({ id, passphrase, saltHex, kdf }) => {
  try {
    const key = deriveKey(passphrase, b4a.from(saltHex, 'hex'), kdf)
    parentPort.postMessage({ id, keyHex: b4a.toString(key, 'hex') })
  } catch (err) {
    parentPort.postMessage({ id, error: err.message || 'key derivation failed' })
  }
})
