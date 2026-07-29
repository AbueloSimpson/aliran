// Service pairing code — a 12-character alias for a panel public key.
//
//   pairingCode('a3f1…')  ->  'A3K7-9QF2-M4XR'
//
// The problem it solves: a panel public key is 64 hex characters. A viewer types it
// on a phone keyboard, or worse, on a TV remote. The code is short enough to print on
// a card and to key in with a D-pad.
//
// DERIVED, NOT ASSIGNED. The code is a pure function of the panel key:
//
//   code = crockford32( top 60 bits of Argon2id(panelPubKey, PAIRING_SALT) )
//
// so there is no registry, nothing to mint, no expiry and no per-customer state. The
// panel computes its own code at boot; anyone who holds the key (the reseller panel,
// a support tool) computes the same code locally with no panel call. Rotate the panel
// key and the code changes with it — it belongs on reprintable material.
//
// The code carries NO credentials. The viewer still types their own username and
// password, so this is not a secret and an operator can print it publicly.
//
// WHY A MEMORY-HARD KDF, AND WHY 60 BITS. The attack to price out is not "read the
// panel key" — the key is public. It is an attacker who GRINDS a keypair whose code
// collides with a real operator's, so that a customer pairing lands on the attacker's
// panel and types real credentials into it (the attacker holds that panel's OPRF key,
// so they can then crack the password offline). Argon2id at INTERACTIVE limits costs
// ~70 ms and 64 MiB per candidate key, which prices a 2^60 grind out of reach; 12
// characters rather than 8 buys the margin. The client's own cost is one derivation
// per pairing — the same barrier the login already pays on every phone and TV box.
//
// Crockford base32 (no I, L, O or U) so that nothing is misread off a TV screen and
// nothing spells anything. Decoding accepts the confusable characters as their
// digits: I and L read as 1, O reads as 0.

import sodium from 'sodium-native'
import b4a from 'b4a'

// 12 characters x 5 bits = 60 bits.
export const PAIRING_CODE_LENGTH = 12
export const PAIRING_CODE_BITS = PAIRING_CODE_LENGTH * 5
const GROUP = 4 // display grouping: XXXX-XXXX-XXXX

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CANONICAL_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/

// Domain separation. The KDF salt is distinct from the login verifier's (that one is
// random per user, core/password.js) and from the topic label below, so no output of
// one construction is ever an input the other would accept.
const KDF_SALT = deriveSalt('aliran-pairing-code-v1')
const TOPIC_LABEL = 'aliran-pair-v1'

// Argon2id cost. INTERACTIVE (2 ops, 64 MiB) — the same limits the login verifier
// runs at, so it is already proven on the phones and TV boxes this must work on.
// Anything heavier has to be benchmarked on the weakest target first: the client
// pays this cost on the pairing screen, in front of a waiting viewer.
export const PAIRING_KDF_DEFAULT = {
  opslimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
  memlimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
}

const KDF_BYTES = 32 // >= crypto_pwhash_BYTES_MIN; only the top 60 bits are used

function deriveSalt (label) {
  const out = b4a.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.crypto_generichash(out, b4a.from(label))
  return out
}

// Accept the panel key as 64 lowercase-or-uppercase hex characters (how it travels
// everywhere in this codebase) or as the raw 32 bytes. Anything else throws — a
// caller that lets a malformed key through would otherwise get a plausible-looking
// code for nothing.
function panelKeyBytes (panelPubKey) {
  if (typeof panelPubKey === 'string') {
    if (!/^[0-9a-fA-F]{64}$/.test(panelPubKey)) throw new TypeError('panelPubKey must be 64 hex characters')
    return b4a.from(panelPubKey.toLowerCase(), 'hex')
  }
  if (b4a.isBuffer(panelPubKey) || panelPubKey instanceof Uint8Array) {
    if (panelPubKey.length !== 32) throw new TypeError('panelPubKey must be 32 bytes')
    return b4a.from(panelPubKey)
  }
  throw new TypeError('panelPubKey must be a hex string or a 32-byte buffer')
}

/**
 * The pairing code for a panel public key, in its display form: 'A3K7-9QF2-M4XR'.
 * Deterministic, and ~70 ms per call — derive it once and keep it.
 */
export function pairingCode (panelPubKey, opts = PAIRING_KDF_DEFAULT) {
  const digest = b4a.alloc(KDF_BYTES)
  sodium.crypto_pwhash(digest, panelKeyBytes(panelPubKey), KDF_SALT, opts.opslimit, opts.memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13)
  // Big-endian bit stream, most significant bit first: the code is the top 60 bits of
  // the digest. `acc` never holds more than 12 + 8 bits, so plain numbers suffice.
  let acc = 0
  let bits = 0
  let out = ''
  for (let i = 0; out.length < PAIRING_CODE_LENGTH; i++) {
    acc = (acc << 8) | digest[i]
    bits += 8
    while (bits >= 5 && out.length < PAIRING_CODE_LENGTH) {
      bits -= 5
      out += CROCKFORD_ALPHABET[(acc >>> bits) & 31]
    }
  }
  return formatPairingCode(out)
}

/**
 * The comparison form of a typed code: 12 uppercase Crockford characters, no
 * separators. Returns null when the input is not a pairing code at all.
 *
 * Everything that hashes or compares a code goes through this first — a viewer types
 * spaces, dashes and lowercase, and reads I for 1 and O for 0 off a printed card.
 */
export function normalizePairingCode (input) {
  if (typeof input !== 'string') return null
  const s = input
    .toUpperCase()
    .replace(/[\s._-]/g, '') // separators the viewer may type or paste
    .replace(/O/g, '0') // Crockford: the excluded characters decode to their digits
    .replace(/[IL]/g, '1')
  return CANONICAL_RE.test(s) ? s : null
}

/** Group a canonical code for display: 'A3K79QF2M4XR' -> 'A3K7-9QF2-M4XR'. */
export function formatPairingCode (canonical) {
  return (canonical.match(new RegExp('.{1,' + GROUP + '}', 'g')) || []).join('-')
}

/**
 * The swarm topic a panel announces on, and the one a client joins with nothing but
 * the code the viewer typed. Throws on a malformed code.
 *
 * The topic is only a rendezvous: whoever answers there is UNTRUSTED until the client
 * re-derives the code from the panel key it received and finds the two equal.
 */
export function pairingTopic (code) {
  const canonical = normalizePairingCode(code)
  if (!canonical) throw new TypeError('not a pairing code')
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.from(TOPIC_LABEL + canonical))
  return out
}

/**
 * Does this panel key really own this code? The verification the client runs on the
 * descriptor it received — the whole point of deriving the code rather than assigning
 * it. A false here means the peer that answered is not the operator's panel.
 */
export function pairingCodeMatches (panelPubKey, code, opts = PAIRING_KDF_DEFAULT) {
  const canonical = normalizePairingCode(code)
  if (!canonical) return false
  let derived = null
  try { derived = normalizePairingCode(pairingCode(panelPubKey, opts)) } catch { return false }
  return derived === canonical
}
