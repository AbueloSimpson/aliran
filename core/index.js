// @aliran/core — shared crypto used by the panel and the client P2P backend.
//
//   OPRF login  : oprfKeyGen, blind/evaluate/finalize, evaluateFull (enrollment)
//   Passwords   : randomSalt, deriveVerifier, verify
//   Key wrapping: wrapKeyFrom, wrap, unwrap
//
// Enrollment (panel/admin, holds password + oprfKey):
//   rwd      = evaluateFull(oprfKey, password)
//   salt     = randomSalt()
//   verifier = deriveVerifier(rwd, salt)          -> stored in the signed record
//   wrapKey  = wrapKeyFrom(rwd)
//   wrapped  = wrap(wrapKey, streamKey)           -> stored per granted stream
//
// Login (client, holds only the password):
//   { blinded, r } = blind(password)              -> send blinded to panel
//   evaluated      = <panel OPRF RPC>(blinded)    -> panel: evaluate(oprfKey, blinded)
//   rwd            = finalize(password, r, evaluated)
//   verify(rwd, salt, verifier) === true          -> password correct
//   wrapKey        = wrapKeyFrom(rwd); streamKey = unwrap(wrapKey, wrapped)

export * from './oprf.js'
export * from './password.js'
export * from './keybox.js'
