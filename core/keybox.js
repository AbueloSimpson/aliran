// Per-user keypair + anonymous sealing (X25519 crypto_box_seal).
//
// Lets the panel grant a stream to a user WITHOUT the user's password: the panel seals
// the stream key to the user's PUBLIC key. Only the user, after logging in and
// recovering their PRIVATE key (which is sealed under their password), can open it.
//
// Enrollment:  kp = userKeyPair(); store pub; encPriv = wrap(wrapKeyFrom(rwd), kp.secretKey)
// Grant:       user.wrapped[stream] = sealTo(pub, streamKey)          (no password needed)
// Login:       priv = unwrap(wrapKeyFrom(rwd), encPriv); key = sealOpen(pub, priv, sealed)

import sodium from 'sodium-native'
import b4a from 'b4a'

export function userKeyPair () {
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

// Anonymous-seal `message` to a public key → hex. Anyone with the pubkey can seal.
export function sealTo (publicKey, message) {
  const cipher = b4a.alloc(message.length + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(cipher, message, publicKey)
  return b4a.toString(cipher, 'hex')
}

// Open a sealed message. Returns the plaintext Buffer, or null on failure.
export function sealOpen (publicKey, secretKey, sealedHex) {
  const cipher = b4a.from(sealedHex, 'hex')
  const out = b4a.alloc(cipher.length - sodium.crypto_box_SEALBYTES)
  return sodium.crypto_box_seal_open(out, cipher, publicKey, secretKey) ? out : null
}
