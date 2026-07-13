// Minimal `node:crypto` stand-in for the Bare worklet bundle.
//
// The only module in the app.bundle graph that imports `node:crypto` is
// @noble/hashes/cryptoNode.js (pulled in via @aliran/core), and all it reads is
// `webcrypto` (for getRandomValues). Aliran's own randomness comes from
// sodium-native (core/oprf.js randomScalar), so this shim just has to make the
// import resolve and provide WebCrypto-shaped randomness, backed by libsodium.
//
// bare-pack maps `node:crypto` here via the global imports map
// (client/backend/imports.json); the Bare worklet runtime itself ships no
// node-style `crypto` builtin (that gap crashed the first S5c boot).

import sodium from 'sodium-native'

function fillRandom (view) {
  const bytes = ArrayBuffer.isView(view)
    ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    : new Uint8Array(view)
  sodium.randombytes_buf(bytes)
  return view
}

export const webcrypto = {
  getRandomValues: fillRandom
}

export function randomBytes (size) {
  const buf = Buffer.alloc(size)
  sodium.randombytes_buf(buf)
  return buf
}

export function randomFillSync (view) {
  return fillRandom(view)
}

export default { webcrypto, randomBytes, randomFillSync }
