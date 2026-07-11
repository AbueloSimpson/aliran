// Password verifier (Argon2id) + key wrapping (secretbox), on top of the OPRF output.
//
// - verifier: Argon2id(rwd, salt) — memory-hard barrier if the panel OPRF key ever leaks.
// - wrapKey : fast KDF of rwd — used to seal per-user stream keys so that even other
//   authorized members replicating the signed DB see only ciphertext.

import sodium from 'sodium-native'
import b4a from 'b4a'

export const SALT_BYTES = sodium.crypto_pwhash_SALTBYTES // 16
const VERIFIER_BYTES = 32
const WRAP_LABEL = b4a.from('aliran-wrapkey-v1')

// Default Argon2id cost (interactive). Override per deployment (config.argon2).
export const ARGON2_DEFAULT = {
  opslimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
  memlimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
}

export function randomSalt () { const s = b4a.alloc(SALT_BYTES); sodium.randombytes_buf(s); return s }

export function deriveVerifier (rwd, salt, opts = ARGON2_DEFAULT) {
  const out = b4a.alloc(VERIFIER_BYTES)
  sodium.crypto_pwhash(out, rwd, salt, opts.opslimit, opts.memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13)
  return out
}

// Constant-time verify.
export function verify (rwd, salt, verifier, opts = ARGON2_DEFAULT) {
  const got = deriveVerifier(rwd, salt, opts)
  return got.length === verifier.length && sodium.sodium_memcmp(got, verifier)
}

// Fast wrap key derived from rwd (rwd is already high-entropy from the OPRF).
export function wrapKeyFrom (rwd) {
  const out = b4a.alloc(sodium.crypto_secretbox_KEYBYTES)
  sodium.crypto_generichash(out, rwd, WRAP_LABEL)
  return out
}

// Seal a secret (e.g. a stream key) under wrapKey → nonce || ciphertext (hex string).
export function wrap (wrapKey, plaintext) {
  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)
  const cipher = b4a.alloc(plaintext.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(cipher, plaintext, nonce, wrapKey)
  return b4a.toString(b4a.concat([nonce, cipher]), 'hex')
}

// Open a wrapped secret. Returns the plaintext Buffer, or null if auth fails.
export function unwrap (wrapKey, boxHex) {
  const box = b4a.from(boxHex, 'hex')
  const n = sodium.crypto_secretbox_NONCEBYTES
  const nonce = box.subarray(0, n)
  const cipher = box.subarray(n)
  const out = b4a.alloc(cipher.length - sodium.crypto_secretbox_MACBYTES)
  return sodium.crypto_secretbox_open_easy(out, cipher, nonce, wrapKey) ? out : null
}
