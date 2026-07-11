// Proof-of-work admission for login (raises the cost of automated guessing before the
// request even reaches the OPRF/throttle). Shared by panel (verify) and client (solve).
// Hash = blake2b (sodium generichash), available in both Node and Bare.

import sodium from 'sodium-native'
import b4a from 'b4a'

function hash (buf) { const out = b4a.alloc(32); sodium.crypto_generichash(out, buf); return out }

function leadingZeroBits (buf) {
  let n = 0
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue }
    let m = byte
    while ((m & 0x80) === 0) { n++; m <<= 1 }
    break
  }
  return n
}

export function powVerify (challenge, nonce, difficulty) {
  return leadingZeroBits(hash(b4a.concat([challenge, nonce]))) >= difficulty
}

// Find an 8-byte nonce whose hash(challenge||nonce) has `difficulty` leading zero bits.
export function powSolve (challenge, difficulty) {
  const nonce = b4a.alloc(8)
  for (let i = 0; ; i++) {
    nonce.writeUInt32LE(i & 0xffffffff, 0)
    nonce.writeUInt32LE(Math.floor(i / 0x100000000), 4)
    if (powVerify(challenge, nonce, difficulty)) return nonce
  }
}
