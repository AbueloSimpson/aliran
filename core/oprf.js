// Oblivious PRF (2HashDH over ristretto255) — the brute-force-resistant core of login.
//
// The panel holds a secret scalar k. A client learns rwd = F_k(password) WITHOUT the
// panel seeing the password, and WITHOUT the client learning k. Because rwd needs k,
// an attacker who copied the account DB cannot compute rwd offline → cannot test
// password guesses. See docs/security-model.md.
//
// Group math uses the audited @noble/curves ristretto255. Have this reviewed before
// production; it follows the RFC 9497 2HashDH construction but is not a certified impl.

import { ristretto255 } from '@noble/curves/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { concatBytes } from '@noble/hashes/utils'
import sodium from 'sodium-native'
import b4a from 'b4a'

const P = ristretto255.Point
const Fn = P.Fn
const ORDER = Fn.ORDER
const DST = b4a.from('aliran-oprf-v1')
const RWD_LABEL = b4a.from('aliran-rwd-v1')

const enc = (s) => (typeof s === 'string' ? b4a.from(s, 'utf8') : s)

function bytesToBig (u8) { let x = 0n; for (const b of u8) x = (x << 8n) | BigInt(b); return x }
function bigToBytes (x, len = 32) {
  const out = b4a.alloc(len)
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n }
  return out
}
function randomScalar () {
  const buf = b4a.alloc(64); sodium.randombytes_buf(buf)
  const s = bytesToBig(buf) % ORDER
  return s === 0n ? 1n : s
}
function loadScalar (bytes) { const s = bytesToBig(bytes) % ORDER; return s === 0n ? 1n : s }

// Map a password to a group element (expand to 64 uniform bytes, then ristretto map).
function hashToGroup (password) { return P.hashToCurve(sha512(concatBytes(DST, enc(password)))) }

// rwd = H(label, password, N) where N = k*H(password).
function deriveRwd (password, pointBytes) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, concatBytes(RWD_LABEL, enc(password), pointBytes))
  return out
}

// --- Panel side ---
export function oprfKeyGen () { return bigToBytes(randomScalar()) } // 32-byte secret scalar

// Evaluate a blinded point: E = k * B. Panel never sees the password.
export function evaluate (oprfKey, blindedBytes) {
  const B = P.fromBytes(blindedBytes)
  return b4a.from(B.multiply(loadScalar(oprfKey)).toBytes())
}

// Enrollment convenience (admin holds both password and k): rwd directly, no blinding.
export function evaluateFull (oprfKey, password) {
  const N = hashToGroup(password).multiply(loadScalar(oprfKey))
  return deriveRwd(password, b4a.from(N.toBytes()))
}

// --- Client side ---
// Blind the password; keep `r` secret until finalize().
export function blind (password) {
  const r = randomScalar()
  const B = hashToGroup(password).multiply(r)
  return { blinded: b4a.from(B.toBytes()), r: bigToBytes(r) }
}

// Unblind the panel's evaluation and derive rwd. Must pass the same password + r.
export function finalize (password, r, evaluatedBytes) {
  const E = P.fromBytes(evaluatedBytes)
  const N = E.multiply(Fn.inv(loadScalar(r)))
  return deriveRwd(password, b4a.from(N.toBytes()))
}
