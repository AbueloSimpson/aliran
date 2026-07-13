// Globals the react-native-bare-kit (0.13.x) worklet runtime does not provide.
// MUST be the first import of backend.mjs so it evaluates before the rest of the
// graph — @aliran/core (via @noble/hashes utf8ToBytes) hits TextEncoder at module
// evaluation time, and anything WebCrypto-shaped expects globalThis.crypto.
// Buffer IS a worklet global (bare-buffer), so the encoders lean on it.

import sodium from 'sodium-native'

function asBytes (view) {
  return ArrayBuffer.isView(view)
    ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    : new Uint8Array(view)
}

if (typeof globalThis.TextEncoder !== 'function') {
  globalThis.TextEncoder = class TextEncoder {
    get encoding () { return 'utf-8' }
    encode (input = '') { return new Uint8Array(Buffer.from(String(input), 'utf8')) }
  }
}

if (typeof globalThis.TextDecoder !== 'function') {
  // UTF-8 only — enough for the libraries in this bundle.
  globalThis.TextDecoder = class TextDecoder {
    get encoding () { return 'utf-8' }
    decode (input) {
      if (input === undefined) return ''
      return Buffer.from(asBytes(input)).toString('utf8')
    }
  }
}

if (!globalThis.crypto) {
  globalThis.crypto = {
    getRandomValues (view) {
      sodium.randombytes_buf(asBytes(view))
      return view
    }
  }
}
