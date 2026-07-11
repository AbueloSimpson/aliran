// Panel-signed session tokens. Compact, offline-verifiable: base64(payload).base64(sig),
// signed by the panel's Ed25519 signing key. The client checks the signature (with the
// pinned panel public key) + expiry offline, and the tokenVersion when it is online.

import sodium from 'sodium-native'
import b4a from 'b4a'

// payload e.g. { userId, deviceId, issuedAt, expiresAt, tokenVersion }
export function signToken (signingSecretKey, payload) {
  const body = b4a.from(JSON.stringify(payload))
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, body, signingSecretKey)
  return b4a.toString(body, 'base64') + '.' + b4a.toString(sig, 'base64')
}

// Returns the payload if the signature is valid, else null. Does NOT check expiry —
// the caller decides (so it can distinguish "forged" from "expired").
export function verifyToken (signingPublicKey, token) {
  const dot = String(token).indexOf('.')
  if (dot < 0) return null
  const body = b4a.from(token.slice(0, dot), 'base64')
  const sig = b4a.from(token.slice(dot + 1), 'base64')
  if (sig.length !== sodium.crypto_sign_BYTES) return null
  if (!sodium.crypto_sign_verify_detached(sig, body, signingPublicKey)) return null
  try { return JSON.parse(b4a.toString(body)) } catch { return null }
}

// Convenience: valid signature AND not expired (by the caller's clock).
export function tokenValid (signingPublicKey, token, now = Date.now()) {
  const p = verifyToken(signingPublicKey, token)
  if (!p) return null
  if (typeof p.expiresAt === 'number' && now >= p.expiresAt) return null
  return p
}
