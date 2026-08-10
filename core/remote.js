// Remote-device rendezvous and mutual proof — the primitives behind "sign in on my TV"
// and "play this on my TV".
//
// Runtime-agnostic (Node and the Bare worklet on Android), like core/pairing.js: no fs,
// no swarm, no timers, no state machine. Derivations and pure predicates only. Joining
// topics, drawing screens and expiring codes belong to the callers.
//
//   TWO RENDEZVOUS, ONE PROOF
//
//   A. Sign-in handover. The TV is not signed in yet, so the two devices share nothing
//      but what a viewer can carry across a room: a code the TV shows and the phone
//      types.
//
//        rec = newSigninCode()                      -> { code: 'A3K7-9QF2-M4XR', … }
//        { topic, secret } = signinKeys(rec.code)   -> one Argon2id, then two subkeys
//
//   B. Account handover. Both devices are already signed in to the SAME account, so
//      they already share the account's X25519 private key and need no code at all.
//
//        secret = remoteSecret(accountPrivateKey)   -> stays inside sdk/login.js's scope
//        topic  = remoteTopic(secret)
//
//   Both arrive at the same shape: a 32-byte swarm topic plus a 32-byte shared secret
//   that the topic cannot be worked backwards to. From there both sides run one round:
//
//        mine   = remoteProof(secret, socket.handshakeHash, myRole)
//        ok     = remoteProofValid(secret, socket.handshakeHash, peerRole(myRole), theirs)
//        digits = remoteSas(secret, socket.handshakeHash)   -> shown on both screens
//
// WHY A PROOF AT ALL. A topic is a public rendezvous and anyone may answer on it —
// sdk/pairing.js:13-19 spells out the same hazard for the service pairing code.
// Hyperswarm's Noise handshake authenticates the peer KEYPAIR, which tells us nothing
// here: these are two of the viewer's own devices, they have never met, and neither has
// a pinned key for the other. The only thing that separates the real peer from a
// stranger on the topic is knowledge of the shared secret, so both sides must show it.
//
// WHY IT IS BOUND TO THE HANDSHAKE HASH. Without a per-connection binding, a proof is a
// bearer token: a relay that talks to the TV on one connection and to the phone on
// another forwards each side's proof to the other and sits in the middle of both. Every
// proof therefore commits to `socket.handshakeHash` — the Noise transcript hash, which
// both endpoints of ONE connection compute identically and which no two connections
// share, because it commits to both parties' fresh ephemeral keys. That also removes
// the need for a challenge round-trip: the handshake hash IS a nonce both sides
// contributed to, agreed before either of them speaks.
//
//   VERIFIED, not assumed: @hyperswarm/secret-stream 6.9.1 (the version hyperswarm
//   4.17.0 pins here) exposes it as the public `handshakeHash` property, set in
//   _setupSecretStream() from the Noise `h` variable. Measured on a loopback pair: 64
//   bytes, byte-identical on both ends, different on every connection. It is NULL until
//   the handshake completes — a caller that proves before the socket's 'connect' event
//   would otherwise bind to nothing, so a missing or wrong-sized hash throws here
//   rather than producing a plausible proof.
//
//   Do not put the handshake hash itself on the wire. secret-stream derives its
//   unordered-message keys from it (_setupSecretSend). Only ever send MACs OF it, which
//   is all this module produces.
//
// WHY KEYED BLAKE2b AND NOT HMAC. sodium-native gives us three options: crypto_auth
// (HMAC-SHA512-256), crypto_kdf, and crypto_generichash with a key. We use the last.
// Keyed BLAKE2b is a PRF/MAC by construction — it needs no HMAC wrapper, because
// BLAKE2b has no length-extension weakness to work around — and it is the primitive
// every other file in this package already runs on (password.js wrapKeyFrom, keybox.js,
// pairing.js). That matters more than the choice itself: core/ ships into the Bare
// worklet on Android, and "the function the rest of core already calls" is the one that
// is certain to be there. Verification is sodium_memcmp, the same constant-time compare
// core/password.js verify() uses.
//
// TWO ORIENTATIONS, DELIBERATELY.
//   subkey  — key = the public label, message = the secret. Splitting one high-entropy
//             secret into labelled children; the shape of password.js wrapKeyFrom.
//   MAC     — key = the shared secret, message = the public transcript. The only sound
//             orientation for authentication, and the one every proof below uses.
//
// DOMAIN SEPARATION (core/pairing.js:45-49 — no output of one construction may ever be
// an input another would accept). Seven labels, all distinct from 'aliran-pairing-code-v1',
// 'aliran-pair-v1' and 'aliran-wrapkey-v1', and from each other:
//
//   aliran-signin-code-v1     Argon2id salt: the sign-in code -> one master secret
//   aliran-signin-topic-v1    master -> the sign-in swarm topic
//   aliran-signin-secret-v1   master -> the sign-in shared secret
//   aliran-remote-secret-v1   account X25519 private key -> the account shared secret
//   aliran-remote-topic-v1    account shared secret -> the account swarm topic
//   aliran-remote-proof-v1    shared secret + handshake hash + role -> a proof
//   aliran-remote-sas-v1      shared secret + handshake hash -> the compared digits
//
// The topic and the secret come from the SAME master under different labels rather than
// the topic coming from the secret's plaintext, so publishing a topic — which joining
// a swarm does — never publishes the proof key. The account pair works the same way:
// remoteTopic hashes the secret, one-way, and never the reverse.
//
// A sign-in code and a service pairing code are the same 12-character string space on
// purpose (see below), so separation here is enforced entirely by the derivations, not
// by the strings. test-remote.mjs pins that: the same code never reaches the same topic
// through pairingTopic() and signinTopic().
//
// WHY 12 CHARACTERS. The threat is not the pairing code's. That code is public,
// permanent and derived from a key, and the attack is grinding a COLLIDING keypair over
// unlimited time. This one is a random secret that lives ~3 minutes and is spent once,
// and guessing it IS the whole attack — an attacker who lands on a live code answers on
// its topic, proves knowledge of it (they hold it), and is handed account key material.
// There is no second check behind it the way pairingCodeMatches() sits behind a pairing
// code. Three numbers set the length:
//
//   1. PRECOMPUTATION is the binding constraint, and it is what the KDF is for. The
//      Argon2id salt has to be a fixed constant — the phone holds nothing but the code
//      — so an attacker may build the whole code -> topic table once and then find every
//      live code with a lookup. At 8 characters (40 bits) that table is 35 TB and about
//      2400 core-years to build: a determined group's weekend on rented hardware. At 12
//      characters (60 bits) it is 37 exabytes and 2.6 billion core-years. The memory-hard
//      KDF is not belt-and-braces here; without it the table is a rounding error at any
//      length we could ask a viewer to type.
//   2. ONLINE GUESSING, against one live code. Take the strongest adversary this is
//      worth defending against: ~10^5 Argon2id-INTERACTIVE evaluations per second, which
//      is 64 MiB x ~7000 live slots (≈450 GiB) at tens of TB/s — a rack of top-end GPUs.
//      In one 180 s window that is 1.8x10^7 candidates against 1.15x10^18 codes: one in
//      64 billion sign-ins. (We do not even count the DHT lookup each candidate also
//      needs, which is the far harder half.)
//   3. THE WHOLE FLEET AT ONCE. An attacker grinding blindly hits ANY code live at that
//      moment, and the number live worldwide is the sign-in rate times the TTL. So the
//      TTL earns its keep twice — it bounds one session's exposure and it bounds the
//      global target set. Even at an implausible 10 sign-ins per second everywhere
//      (1800 codes live at any instant), that adversary averages 200 years of
//      uninterrupted flat-out grinding per stolen account — for an account worth a few
//      dollars a month. At 8 characters the same sum comes out under two hours.
//
//   Given a floor near 48-50 bits from (1), why 12 and not 10? Because the display
//   grouping is four characters — the pairing code's, and the one that reads correctly
//   off a screen across a room — which makes the real menu 8 characters or 12, and 8 is
//   under the floor. Twelve then costs nothing extra: normalizePairingCode() and
//   formatPairingCode() apply verbatim, so a security-critical Crockford folder does not
//   get a second, subtly different copy in this file. SIGNIN_CODE_LENGTH is derived from
//   PAIRING_CODE_LENGTH below rather than written out, because that coupling is real.
//
// Crockford base32 for the same reason pairing.js uses it: nothing is misread off a TV
// screen and nothing spells anything. Generation is uniform — 32 symbols is exactly 5
// bits, so slicing a random byte stream into 5-bit groups needs no rejection step.

import sodium from 'sodium-native'
import b4a from 'b4a'
import {
  CROCKFORD_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_KDF_DEFAULT,
  normalizePairingCode,
  formatPairingCode
} from './pairing.js'

// Equal to the pairing code's length BY DEPENDENCY, not by coincidence: this module
// normalizes and formats sign-in codes with pairing.js's own functions, which are
// written for exactly that many characters.
export const SIGNIN_CODE_LENGTH = PAIRING_CODE_LENGTH
export const SIGNIN_CODE_BITS = SIGNIN_CODE_LENGTH * 5

// Long enough to walk to the phone and type; short enough that the set of codes live
// worldwide at any instant stays tiny. The caller owns the clock — this is only the
// default stamped into newSigninCode().
export const SIGNIN_CODE_TTL_MS = 3 * 60 * 1000

// Sizes. Topics and secrets are 32 bytes because a Hyperswarm topic is; proofs are 32
// bytes because a 256-bit MAC is past the point of caring.
export const REMOTE_TOPIC_BYTES = 32
export const REMOTE_SECRET_BYTES = 32
export const REMOTE_PROOF_BYTES = 32

// The two ends of one connection. They must differ, or a peer that knows nothing
// reflects the proof it just received straight back as its own and passes.
export const REMOTE_ROLES = { initiator: 'initiator', responder: 'responder' }

// --- domain separation -------------------------------------------------------------
// Seven labels, all distinct from each other and from pairing.js's two. The four that
// serve as BLAKE2b KEYS (the subkey() ones) are each >= crypto_generichash_KEYBYTES_MIN
// (16 bytes) — shorten one below that and sodium throws at first use. The proof and SAS
// labels are message prefixes, and the KDF one is hashed down to an Argon2id salt.
const SIGNIN_KDF_SALT = deriveSalt('aliran-signin-code-v1')
const SIGNIN_TOPIC_LABEL = b4a.from('aliran-signin-topic-v1')
const SIGNIN_SECRET_LABEL = b4a.from('aliran-signin-secret-v1')
const ACCOUNT_SECRET_LABEL = b4a.from('aliran-remote-secret-v1')
const ACCOUNT_TOPIC_LABEL = b4a.from('aliran-remote-topic-v1')
const PROOF_LABEL = b4a.from('aliran-remote-proof-v1')
const SAS_LABEL = b4a.from('aliran-remote-sas-v1')

const KDF_BYTES = 32 // >= crypto_pwhash_BYTES_MIN

// Same construction as pairing.js's private deriveSalt: a label hashed down to
// crypto_pwhash_SALTBYTES. A different label is a different salt, which is the point.
function deriveSalt (label) {
  const out = b4a.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.crypto_generichash(out, b4a.from(label))
  return out
}

// Split a high-entropy secret into a labelled child. key = the public label, message =
// the secret — the orientation password.js wrapKeyFrom() uses.
function subkey (label, secret) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, secret, label)
  return out
}

// MAC a public transcript under a secret. key = the secret, message = the transcript —
// the only orientation that authenticates anything.
function mac (secret, ...parts) {
  const out = b4a.alloc(REMOTE_PROOF_BYTES)
  sodium.crypto_generichash(out, b4a.concat(parts), secret)
  return out
}

function isBytes (x) {
  return b4a.isBuffer(x) || x instanceof Uint8Array
}

// 32 bytes, given either as the raw buffer or as the 64 hex characters everything in
// this codebase travels as. Anything else throws: a caller that lets a malformed secret
// through would otherwise get a perfectly plausible topic that nobody else derives.
function bytes32 (value, what) {
  if (typeof value === 'string') {
    if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new TypeError(what + ' must be 64 hex characters')
    return b4a.from(value.toLowerCase(), 'hex')
  }
  if (isBytes(value)) {
    if (value.length !== 32) throw new TypeError(what + ' must be 32 bytes')
    return b4a.from(value)
  }
  throw new TypeError(what + ' must be a hex string or a 32-byte buffer')
}

// secret-stream 6.9.1 hands us 64 bytes. 32 is accepted so a future BLAKE2b-256
// transcript would not need a core release; nothing else is, and in particular null is
// not — that is what a socket returns before its handshake finishes, and it is the one
// caller mistake that would silently unbind every proof in this file.
function handshakeHashBytes (h) {
  if (!isBytes(h)) throw new TypeError('handshakeHash must be a buffer — read it after the socket connects')
  if (h.length !== 32 && h.length !== 64) throw new TypeError('handshakeHash must be 32 or 64 bytes, got ' + h.length)
  return h
}

function roleBytes (role) {
  if (role !== REMOTE_ROLES.initiator && role !== REMOTE_ROLES.responder) {
    throw new TypeError("role must be 'initiator' or 'responder'")
  }
  return b4a.from(role)
}

/**
 * The other end's role. Each side proves as ITSELF and verifies the peer as the peer:
 *
 *   const me = socket.isInitiator ? REMOTE_ROLES.initiator : REMOTE_ROLES.responder
 *   send(remoteProof(secret, socket.handshakeHash, me))
 *   remoteProofValid(secret, socket.handshakeHash, peerRole(me), received)
 */
export function peerRole (role) {
  roleBytes(role) // throws on anything that is not one of the two
  return role === REMOTE_ROLES.initiator ? REMOTE_ROLES.responder : REMOTE_ROLES.initiator
}

// --- A. sign-in codes ---------------------------------------------------------------

/**
 * A fresh sign-in code and its lifecycle stamps. Pure data — nothing here schedules
 * anything; the caller decides when to look at the clock.
 *
 *   { code: 'A3K7-9QF2-M4XR', canonical: 'A3K79QF2M4XR', issuedAt, expiresAt, usedAt: null }
 */
export function newSigninCode (opts = {}) {
  // Absent means "use the default"; present-but-wrong is a caller bug and throws. A
  // silently-defaulted ttlMs is how a code ends up living far longer than the screen
  // that shows it claims.
  const now = opts.now === undefined ? Date.now() : opts.now
  const ttlMs = opts.ttlMs === undefined ? SIGNIN_CODE_TTL_MS : opts.ttlMs
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite timestamp')
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive number of milliseconds')

  // 32 symbols is exactly 5 bits, so a uniform byte stream sliced into 5-bit groups is
  // uniform over the code space with no rejection step. Big-endian, most significant
  // bit first — the same bit order pairingCode() emits, so the two agree on what a
  // 12-character Crockford string means.
  const digest = b4a.alloc(Math.ceil(SIGNIN_CODE_BITS / 8))
  sodium.randombytes_buf(digest)
  let acc = 0
  let bits = 0
  let canonical = ''
  for (let i = 0; canonical.length < SIGNIN_CODE_LENGTH; i++) {
    acc = (acc << 8) | digest[i]
    bits += 8
    while (bits >= 5 && canonical.length < SIGNIN_CODE_LENGTH) {
      bits -= 5
      canonical += CROCKFORD_ALPHABET[(acc >>> bits) & 31]
    }
  }

  return { code: formatPairingCode(canonical), canonical, issuedAt: now, expiresAt: now + ttlMs, usedAt: null }
}

export const SIGNIN_CODE_STATES = {
  live: 'live', // usable right now
  expired: 'expired', // the TTL ran out — show a new one
  used: 'used', // already spent; one shot means one shot
  malformed: 'malformed' // not a record newSigninCode() produced
}

/** Which of SIGNIN_CODE_STATES this record is in, by the caller's clock. */
export function signinCodeState (rec, now = Date.now()) {
  if (!rec || typeof rec !== 'object') return SIGNIN_CODE_STATES.malformed
  if (normalizePairingCode(rec.canonical) !== rec.canonical) return SIGNIN_CODE_STATES.malformed
  if (!Number.isFinite(rec.expiresAt)) return SIGNIN_CODE_STATES.malformed
  if (rec.usedAt != null) return SIGNIN_CODE_STATES.used
  if (now >= rec.expiresAt) return SIGNIN_CODE_STATES.expired
  return SIGNIN_CODE_STATES.live
}

/**
 * Spend the code. Returns a NEW record stamped used, or null if it was not live — the
 * check and the state change are one call on purpose, so a caller cannot test liveness,
 * await a peer, and spend a code that expired in between. The caller stores what comes
 * back; this function mutates nothing.
 */
export function consumeSigninCode (rec, now = Date.now()) {
  if (signinCodeState(rec, now) !== SIGNIN_CODE_STATES.live) return null
  return { ...rec, usedAt: now }
}

/**
 * The rendezvous topic and the shared secret for a sign-in code, from ONE Argon2id.
 * ~70 ms — call it once and keep both halves. Throws on anything that is not a code.
 *
 * The topic is only a rendezvous: whoever answers there is untrusted until they prove
 * the secret (remoteProofValid below).
 */
export function signinKeys (code, opts = PAIRING_KDF_DEFAULT) {
  const canonical = normalizePairingCode(code)
  if (!canonical) throw new TypeError('not a sign-in code')
  const master = b4a.alloc(KDF_BYTES)
  sodium.crypto_pwhash(master, b4a.from(canonical), SIGNIN_KDF_SALT, opts.opslimit, opts.memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13)
  const out = { topic: subkey(SIGNIN_TOPIC_LABEL, master), secret: subkey(SIGNIN_SECRET_LABEL, master) }
  // The master reconstructs both halves; the caller only ever needs the halves.
  sodium.sodium_memzero(master)
  return out
}

/** The sign-in swarm topic. A full Argon2id — prefer signinKeys() if you need both. */
export function signinTopic (code, opts = PAIRING_KDF_DEFAULT) {
  return signinKeys(code, opts).topic
}

/** The sign-in shared secret. A full Argon2id — prefer signinKeys() if you need both. */
export function signinSecret (code, opts = PAIRING_KDF_DEFAULT) {
  return signinKeys(code, opts).secret
}

// --- B. account rendezvous ----------------------------------------------------------

/**
 * The account's remote-control secret, from its X25519 private key (core/keybox.js).
 *
 * One-way: the secret cannot be walked back to the private key, so it is safe to keep
 * for the lifetime of a session while the private key stays where login recovered it.
 * WP2/WP3 call this inside sdk/login.js so the private key never leaves that scope.
 */
export function remoteSecret (privateKey) {
  return subkey(ACCOUNT_SECRET_LABEL, bytes32(privateKey, 'privateKey'))
}

/**
 * The swarm topic two devices on the same account meet at. Unguessable to anyone
 * without the account private key, and one-way from the secret — announcing on the
 * topic, which is public by definition, does not publish the proof key.
 */
export function remoteTopic (secret) {
  return subkey(ACCOUNT_TOPIC_LABEL, bytes32(secret, 'secret'))
}

// --- mutual proof ---------------------------------------------------------------------

/**
 * This side's proof for THIS connection: MAC(secret, label || role || handshakeHash).
 *
 * The three fields cannot be re-split — the label is a constant, the role is one of two
 * strings of equal length, and the hash is the remainder — so no other input produces
 * these bytes. Send it; verify the peer's with peerRole().
 */
export function remoteProof (secret, handshakeHash, role) {
  return mac(bytes32(secret, 'secret'), PROOF_LABEL, roleBytes(role), handshakeHashBytes(handshakeHash))
}

/**
 * Does `proof` prove the peer holds the secret, on THIS connection, in THAT role?
 * Constant-time (sodium_memcmp, as core/password.js verify() does), and false rather
 * than a throw for every malformed input — this runs on bytes a stranger sent.
 */
export function remoteProofValid (secret, handshakeHash, role, proof) {
  if (!isBytes(proof) || proof.length !== REMOTE_PROOF_BYTES) return false
  let expected = null
  try { expected = remoteProof(secret, handshakeHash, role) } catch { return false }
  return sodium.sodium_memcmp(expected, b4a.from(proof))
}

// --- short authenticated string -------------------------------------------------------

export const REMOTE_SAS_DIGITS = 4
const SAS_MODULUS = 10 ** REMOTE_SAS_DIGITS
// Rejection sampling, because 10,000 does not divide a power of two. Reducing a raw draw
// modulo 10,000 makes the low residues likelier than the high ones — on a 16-bit draw
// that is a 17% excess for 0000-5535, which a comparison code cannot afford. So: take a
// 32-bit draw, discard the ragged tail above the last whole multiple, and reduce what is
// left. Exactly uniform rather than nearly, and the tail is 7296 values in 2^32, so a
// draw is rejected about once in 589,000. Both constants follow REMOTE_SAS_DIGITS, so
// moving to six digits stays correct without touching the arithmetic.
const SAS_DRAW_WIDTH = 0x100000000
const SAS_DRAW_LIMIT = Math.floor(SAS_DRAW_WIDTH / SAS_MODULUS) * SAS_MODULUS

/**
 * The digits both screens show, for the viewer to compare: '0473'. Identical on two
 * honest peers of one connection, unrelated under a relay, and uniform over 0000-9999.
 *
 * Role-free on purpose — the two sides are comparing, not challenging.
 *
 * What it is for. The automated check above already refuses a relay outright: a MITM
 * cannot produce a valid proof without the secret, so the connection dies before anyone
 * reads a digit. The SAS is the human-legible version of that same binding — it turns
 * "trust the code" into "confirm this is the TV in front of you", and it is what a
 * viewer can act on when something is wrong. Four digits leaves a MITM a blind 1-in-
 * 10,000 coincidence per attempt, with no way to steer toward it (the digits depend on
 * the secret it does not have) and a visibly failed sign-in for every try; the code's
 * TTL and one-shot semantics cap how many tries it gets.
 */
export function remoteSas (secret, handshakeHash) {
  const key = bytes32(secret, 'secret')
  const hh = handshakeHashBytes(handshakeHash)
  // Counter-extended stream, so rejection can never run out of bytes and the result
  // stays a pure function of (secret, handshakeHash). One block is 8 draws; all 2048
  // rejecting has probability below 10^-11000, which is why the fall-through below is a
  // throw rather than a fallback that would quietly reintroduce the bias.
  for (let counter = 0; counter < 256; counter++) {
    const block = mac(key, SAS_LABEL, b4a.from([counter]), hh)
    for (let i = 0; i + 3 < block.length; i += 4) {
      const draw = block[i] * 0x1000000 + block[i + 1] * 0x10000 + block[i + 2] * 0x100 + block[i + 3]
      if (draw < SAS_DRAW_LIMIT) return String(draw % SAS_MODULUS).padStart(REMOTE_SAS_DIGITS, '0')
    }
  }
  throw new Error('SAS derivation exhausted') // unreachable
}
