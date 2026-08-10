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
//      The topic is PUBLIC and more than one peer can answer on it. Nothing in this file
//      excludes anything: consumeSigninCode() is a pure function, so two connection
//      handlers that both call it before either result is stored both succeed, and both
//      peers are handed account key material. The TV must hold its own lock around
//      read -> consume -> store and allow ONE handover in flight per code. See
//      consumeSigninCode().
//
//   B. Account handover. Both devices are already signed in to the SAME account, so
//      they already share the account's X25519 private key and need no code at all.
//
//        secret = remoteSecret(accountPrivateKey, tokenVersion)  -> inside sdk/login.js
//        topic  = remoteTopic(secret)                            -> or (secret, epoch)
//
//   Both arrive at the same shape: a 32-byte swarm topic plus a 32-byte shared secret
//   that the topic cannot be worked backwards to. From there both sides run one round of
//   mutual proof:
//
//        mine   = remoteProof(secret, socket.handshakeHash, myRole)
//        ok     = remoteProofValid(secret, socket.handshakeHash, peerRole(myRole), theirs)
//
//   The sign-in handover adds TWO human checks on top of that, because the mutual proof
//   authenticates a CODE and not a DEVICE. They are complementary and BOTH must pass
//   before key material moves — neither one is a substitute for the other:
//
//        remoteCommittedSas  both screens show the same four digits and the viewer
//                        confirms ON THE PHONE that they match. A relay terminates two
//                        Noise connections, so the two screens disagree; this is the check
//                        that sees it. The digits depend on a fresh 32-byte nonce from
//                        EACH side, exchanged commit-then-reveal so that neither side can
//                        choose its contribution after seeing the other's — which is what
//                        stops a code-holding relay grinding the comparison. See the SAS
//                        note below for the attack this replaced.
//        remotePinProof  the phone draws four digits the TV cannot derive and the viewer
//                        TYPES them into the TV. This is the check that a real device
//                        with a human at it is in the session at all, which is what a
//                        static lure ("enter this code on your TV") does not have.
//
//   Read the two notes below for exactly what each one does and does not buy. The short
//   version: the SAS catches the relay and the PIN does not; the PIN catches the static
//   lure and the SAS does not.
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
//   SUFFICIENT FOR THE PROOF, NOT FOR THE COMPARED SAS — the exact distinction the two
//   earlier revisions missed. The proof's adversary is a peer WITHOUT the secret, and a
//   bearer-token forward is all such a peer could try; binding to the handshake hash kills
//   it. The SAS's adversary HOLDS the secret (a relay with the code), and it can read this
//   same handshake hash off a RAW socket before any channel exists — so a value derived
//   from (secret, handshake hash) alone is one it can precompute and grind. That is why the
//   SAS mixes in a committed nonce from each side on top of the hash; see remoteCommittedSas.
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
// an input another would accept). Nine labels, all distinct from 'aliran-pairing-code-v1',
// 'aliran-pair-v1' and 'aliran-wrapkey-v1', and from each other:
//
//   aliran-signin-code-v1          Argon2id salt: the sign-in code -> one master secret
//   aliran-signin-topic-v1         master -> the sign-in swarm topic
//   aliran-signin-secret-v1        master -> the sign-in shared secret
//   aliran-remote-secret-v1        account X25519 private key + tokenVersion -> the secret
//   aliran-remote-topic-v1         account shared secret (+ epoch) -> the account topic
//   aliran-remote-proof-v1         shared secret + role + handshake hash -> a proof
//   aliran-remote-nonce-commit-v1  shared secret + nonce + handshake hash -> a binding,
//                                  hiding commitment to one side's SAS nonce
//   aliran-remote-sas-nonce-v1     shared secret + both nonces + handshake hash -> the
//                                  compared digits (commit-reveal; see remoteCommittedSas)
//   aliran-remote-pin-v1           shared secret + role + typed digits + handshake hash ->
//                                  proof that the prover LEARNED the digits
//
//   RETIRED, never to be reused: aliran-remote-sas-v1 keyed a compared-digits value that
//   was a pure function of (secret, handshake hash). Because the handshake hash is legible
//   on a RAW NoiseSecretStream before any channel exists, a relay holding the code could
//   precompute a leg's SAS off the bare socket — opening nothing, so counting nothing — and
//   grind a birthday collision. It is gone; the nonce-committed SAS above replaces it, and
//   NO derivation in this file is a function of (secret, handshake hash) alone any more.
//
// The two labels that take a COMPOUND message (secret + tokenVersion, topic + epoch)
// stay unambiguous by fixed widths, not by delimiters: 32 bytes of key material then
// exactly 8 bytes of big-endian counter. A message can therefore only be re-split one
// way, and the optional-epoch form (40 bytes) can never collide with the plain form (32
// bytes) except by breaking BLAKE2b.
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
// code. Three numbers set the length. Read them in order: (1) is a floor that holds
// whatever the deployment looks like, (3) raises that floor in proportion to how busy
// the fleet is, and (2) is (3)'s single-target special case.
//
//   1. PRECOMPUTATION — a floor of roughly 48-50 bits, and what the KDF is for. The
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
//      64 billion sign-ins.
//   3. THE WHOLE FLEET AT ONCE — the binding constraint at any realistic scale, and the
//      one a proposal to shorten the code has to answer. An attacker grinding blindly
//      hits ANY code live at that moment, and the number live worldwide is the sign-in
//      rate times the TTL. Nothing makes the attacker work per candidate to find those
//      targets, either: HyperDHT stores an announce record on the ~20 nodes closest to
//      the topic (kademlia-routing-table's default k, which dht-rpc's query converges
//      on), so a Sybil presence spread over the keyspace HARVESTS live sign-in topics
//      passively and then tests each candidate offline against every harvested topic at
//      once. There is no second, harder half to the work. So the TTL earns its keep
//      twice — it bounds one session's exposure and it bounds the global target set.
//      Even at an implausible 10 sign-ins per second everywhere (1800 codes live at any
//      instant), that adversary averages 200 years of uninterrupted flat-out grinding
//      per stolen account — for an account worth a few dollars a month. At 8 characters
//      the same sum comes out under two hours.
//
//      This item is the one that MOVES with the deployment, so quote the rate with it.
//      Its arithmetic is (1)'s plus the number of simultaneous targets: expected time to
//      hit ANY live code is 2^L / (codes live x guess rate), so the demand is (1)'s
//      demand plus log2(codes live). Codes live = sign-in rate x TTL. That makes THIS
//      item the binding one for any fleet doing more than one sign-in per TTL — more
//      than one every three minutes, worldwide — and it costs another bit for every
//      doubling of that rate. At 10 sign-ins/s (1800 live) it wants ~60 bits against
//      (1)'s ~49; only a fleet quieter than one sign-in per TTL falls back to (1) alone.
//      An argument for ten characters has to name the rate it assumes and show this sum.
//
//   Given all three, why 12 and not 10? Because the display grouping is four characters
//   — the pairing code's, and the one that reads correctly off a screen across a room —
//   which makes the real menu 8 characters or 12, and 8 is under every floor above.
//   Twelve then costs nothing extra: normalizePairingCode() and formatPairingCode()
//   apply verbatim, so a security-critical Crockford folder does not get a second,
//   subtly different copy in this file. SIGNIN_CODE_LENGTH is derived from
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

// The per-side SAS nonce. 32 bytes is not a MAC size here but an ENTROPY floor: the
// commitment below is a MAC the adversary can also compute (it holds the secret), so the
// only thing keeping the committed nonce hidden until it is revealed is that the nonce is
// too large to brute-force. A short nonce would let a code-holding relay open the
// commitment and grind the SAS again — see remoteCommittedSas.
export const REMOTE_NONCE_BYTES = 32

// The two ends of one connection. They must differ, or a peer that knows nothing
// reflects the proof it just received straight back as its own and passes.
export const REMOTE_ROLES = { initiator: 'initiator', responder: 'responder' }

// --- domain separation -------------------------------------------------------------
// Nine labels, all distinct from each other and from pairing.js's two. The four that
// serve as BLAKE2b KEYS (the subkey() ones) are each >= crypto_generichash_KEYBYTES_MIN
// (16 bytes) — shorten one below that and sodium throws at first use. The proof, commit,
// SAS and PIN labels are message prefixes, and the KDF one is hashed down to an Argon2id
// salt. aliran-remote-sas-v1 is RETIRED (see the header) and deliberately absent here.
const SIGNIN_KDF_SALT = deriveSalt('aliran-signin-code-v1')
const SIGNIN_TOPIC_LABEL = b4a.from('aliran-signin-topic-v1')
const SIGNIN_SECRET_LABEL = b4a.from('aliran-signin-secret-v1')
const ACCOUNT_SECRET_LABEL = b4a.from('aliran-remote-secret-v1')
const ACCOUNT_TOPIC_LABEL = b4a.from('aliran-remote-topic-v1')
const PROOF_LABEL = b4a.from('aliran-remote-proof-v1')
const NONCE_COMMIT_LABEL = b4a.from('aliran-remote-nonce-commit-v1')
const SAS_LABEL = b4a.from('aliran-remote-sas-nonce-v1')
const PIN_LABEL = b4a.from('aliran-remote-pin-v1')

const KDF_BYTES = 32 // >= crypto_pwhash_BYTES_MIN
const COUNTER_BYTES = 8 // the fixed width every compound message ends with

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

// A counter as exactly COUNTER_BYTES big-endian bytes. Fixed width so a compound message
// can be re-split only one way, and written by hand rather than through a Buffer method
// so it behaves the same in the Bare worklet. Safe-integer range is far past anything a
// tokenVersion or an epoch reaches.
function counterBytes (n, what, min) {
  if (!Number.isSafeInteger(n) || n < min) throw new TypeError(what + ' must be an integer >= ' + min)
  const out = b4a.alloc(COUNTER_BYTES)
  let v = n
  for (let i = COUNTER_BYTES - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256) }
  return out
}

// The caller's clock. Absent means "now"; present-but-not-finite is a caller bug and
// throws, exactly as it does in newSigninCode(). Deliberately a throw and not a quiet
// 'expired':
//
//   - This value is the CALLER's own, never a stranger's. Bytes off the wire and records
//     off disk are what the malformed state is for, and those still fail closed.
//   - One rule for one class of bug. It would be indefensible for newSigninCode(NaN) to
//     throw while signinCodeState(rec, NaN) quietly answered.
//   - The TTL is load-bearing, not cosmetic: item 3 of the length analysis above uses it
//     to bound the set of codes live worldwide, which is what makes 60 bits enough. A
//     clock that has stopped being a number has stopped enforcing that bound, and a
//     silent 'expired' would hide it while the same broken clock kept stamping records.
function clockNow (now) {
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite timestamp')
  return now
}

// The 60-bit argument above is an argument about Argon2id COST as much as about code
// length: at INTERACTIVE the precomputed code -> topic table is 2.6 billion core-years,
// and a few notches down it is a weekend on rented hardware. So INTERACTIVE is a FLOOR
// here, not just a default — a WP2 caller who trims it to make a slow TV box feel
// snappier would collapse that argument with nothing in the system to notice. Heavier is
// allowed, but benchmark it on the weakest target first: the viewer waits for it.
function kdfLimits (opts) {
  const { opslimit, memlimit } = opts || {}
  if (!Number.isInteger(opslimit) || opslimit < sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE) {
    throw new RangeError('opslimit must be at least crypto_pwhash_OPSLIMIT_INTERACTIVE (' + sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE + ')')
  }
  if (!Number.isInteger(memlimit) || memlimit < sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE) {
    throw new RangeError('memlimit must be at least crypto_pwhash_MEMLIMIT_INTERACTIVE (' + sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE + ' bytes)')
  }
  return { opslimit, memlimit }
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
  const now = clockNow(opts.now === undefined ? Date.now() : opts.now)
  const ttlMs = opts.ttlMs === undefined ? SIGNIN_CODE_TTL_MS : opts.ttlMs
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

/**
 * Which of SIGNIN_CODE_STATES this record is in, by the caller's clock. Throws on a
 * clock that is not a finite number (see clockNow above); every other refusal is a
 * state, because records arrive off disk and off the wire.
 */
export function signinCodeState (rec, now = Date.now()) {
  clockNow(now)
  if (!rec || typeof rec !== 'object') return SIGNIN_CODE_STATES.malformed
  if (normalizePairingCode(rec.canonical) !== rec.canonical) return SIGNIN_CODE_STATES.malformed
  if (!Number.isFinite(rec.expiresAt)) return SIGNIN_CODE_STATES.malformed
  // usedAt is null or a finite stamp — nothing else. Belt and braces now that
  // consumeSigninCode() validates its clock, but it is the cheap half of a nasty pair:
  // a NaN stamp JSON-serializes to null, so a TV that persisted one and reloaded it
  // would read a SPENT code as live and hand the account out twice.
  if (rec.usedAt !== null && rec.usedAt !== undefined && !Number.isFinite(rec.usedAt)) return SIGNIN_CODE_STATES.malformed
  if (rec.usedAt != null) return SIGNIN_CODE_STATES.used
  if (now >= rec.expiresAt) return SIGNIN_CODE_STATES.expired
  return SIGNIN_CODE_STATES.live
}

/**
 * Spend the code. Returns a NEW record stamped used, or null if it was not live. Pure:
 * it mutates nothing and the caller stores what comes back.
 *
 * WHAT THIS DOES GIVE YOU. The liveness check and the state change are one call, so a
 * caller cannot test liveness, await a peer, and spend a code that expired in between.
 *
 * WHAT IT DOES NOT. It is not a lock and it excludes nothing. Two calls on the same
 * input record both return a used record — that is what "pure" means. The realistic WP2
 * failure is not the await above; it is that the sign-in topic is public and more than
 * one peer can answer on it. If the TV runs this in two connection handlers before
 * either result is written back, BOTH succeed and both peers are handed account key
 * material, which is precisely the one-shot property the code depends on.
 *
 *   THE CALLER MUST SERIALIZE read -> consumeSigninCode -> store, and must allow only
 *   one handover in flight per code. Exclusion belongs to whoever owns the storage; this
 *   file has no storage, no timers and no state, so it cannot provide it.
 */
export function consumeSigninCode (rec, now = Date.now()) {
  clockNow(now) // a NaN here would otherwise stamp usedAt: NaN — see signinCodeState
  if (signinCodeState(rec, now) !== SIGNIN_CODE_STATES.live) return null
  return { ...rec, usedAt: now }
}

/**
 * The rendezvous topic and the shared secret for a sign-in code, from ONE Argon2id.
 * ~70 ms — call it once and keep both halves. Throws on anything that is not a code,
 * and on KDF limits below INTERACTIVE (kdfLimits above).
 *
 * The topic is only a rendezvous: whoever answers there is untrusted until they prove
 * the secret (remoteProofValid below).
 */
export function signinKeys (code, opts = PAIRING_KDF_DEFAULT) {
  const canonical = normalizePairingCode(code)
  if (!canonical) throw new TypeError('not a sign-in code')
  const { opslimit, memlimit } = kdfLimits(opts)
  const master = b4a.alloc(KDF_BYTES)
  try {
    sodium.crypto_pwhash(master, b4a.from(canonical), SIGNIN_KDF_SALT, opslimit, memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13)
    return { topic: subkey(SIGNIN_TOPIC_LABEL, master), secret: subkey(SIGNIN_SECRET_LABEL, master) }
  } finally {
    // The master reconstructs BOTH halves, so it outranks either of them and must not
    // outlive the call on any path. In `finally` rather than after the return so that
    // adding a step between the pwhash and the return cannot quietly leave it behind.
    sodium.sodium_memzero(master)
  }
}

/**
 * The sign-in swarm topic. A full Argon2id — prefer signinKeys() if you need both.
 * The secret half is zeroed here rather than dropped: a caller that asked for the topic
 * has said it does not want the proof key, and leaving it in a freed buffer contradicts
 * the reason signinKeys() zeroes the master at all.
 */
export function signinTopic (code, opts = PAIRING_KDF_DEFAULT) {
  const { topic, secret } = signinKeys(code, opts)
  sodium.sodium_memzero(secret)
  return topic
}

/** The sign-in shared secret. A full Argon2id — prefer signinKeys() if you need both. */
export function signinSecret (code, opts = PAIRING_KDF_DEFAULT) {
  const { topic, secret } = signinKeys(code, opts)
  sodium.sodium_memzero(topic)
  return secret
}

// --- B. account rendezvous ----------------------------------------------------------

/**
 * The account's remote-control secret, from its X25519 private key (core/keybox.js) and
 * the account's current `tokenVersion`.
 *
 * One-way: the secret cannot be walked back to the private key, so it is safe to keep
 * for the lifetime of a session while the private key stays where login recovered it.
 * WP2/WP3 call this inside sdk/login.js so the private key never leaves that scope.
 *
 * WHY tokenVersion IS PART OF IT. The private key alone is a PERMANENT rendezvous
 * secret. A device that signed in once and cached it keeps deriving the live topic for
 * ever, and the operator's levers do not all take it away:
 *
 *   setPassword     panel/src/ops.js — mints a fresh keypair AND bumps tokenVersion, so
 *                   it already rotated this. But a password reset is not routine.
 *   logoutAll       panel/src/ops.js — bumps tokenVersion and clears every device
 *                   enrollment. Without the mix-in it left the rendezvous untouched;
 *                   with it, every device re-logs in and lands on the new secret while
 *                   a device holding only the old material stays on the old one.
 *   setUserStatus   'disabled' bumps tokenVersion the same way.
 *   revokeDevice    deliberately does NOT bump tokenVersion — that is documented there
 *                   as cooperative session hygiene, so one device can be dropped without
 *                   logging the household out. It therefore does NOT rotate this either,
 *                   and WP3 must not tell an operator that it does. The lever that
 *                   rotates the rendezvous is "log out all devices" (or a password
 *                   reset); revoking one device relies on the same cooperative client
 *                   behaviour as the rest of the session layer.
 *
 * The value to pass is the account's tokenVersion as the panel reports it — the login
 * reply carries it (panel/src/rpc.js) and it is inside the signed session token. It
 * starts at 1 and only ever increases, so pass the panel's number verbatim; a caller
 * that substitutes 0 or its own default silently lands the two devices on different
 * topics and they simply never meet, which is why anything below 1 throws.
 */
export function remoteSecret (privateKey, tokenVersion) {
  const message = b4a.concat([
    bytes32(privateKey, 'privateKey'),
    counterBytes(tokenVersion, 'tokenVersion', 1)
  ])
  return subkey(ACCOUNT_SECRET_LABEL, message)
}

/**
 * The swarm topic two devices on the same account meet at. Unguessable to anyone
 * without the account private key, and one-way from the secret — announcing on the
 * topic, which is public by definition, does not publish the proof key.
 *
 * THE OPTIONAL EPOCH, AND WHY IT IS HERE. Joining a topic announces it: the ~20 DHT
 * nodes nearest that key learn the IP:port of every device on the account. With no
 * epoch the key never changes, so those nodes hold a permanent public correlator —
 * every device on one account, linked to each other across time and across networks,
 * and a handle for opening a connection to any of them at will. An epoch bounds that
 * window: derive one from the wall clock, e.g.
 *
 *   const epoch = Math.floor(Date.now() / EPOCH_MS)
 *
 * and the correlator only holds within a single period.
 *
 * CLOCK SKEW MAKES THIS A TWO-TOPIC PATTERN. Two devices near a boundary compute
 * different epochs, so a device that joins only its own epoch can miss a peer that is
 * minutes out or simply crossed the boundary first. Join the CURRENT and the PREVIOUS
 * epoch, both sides:
 *
 *   for (const e of [epoch, epoch - 1]) swarm.join(remoteTopic(secret, e))
 *
 * A device at epoch N covers {N, N-1} and one at N+1 covers {N+1, N}, so they always
 * overlap on N — one full period of tolerated skew, and never more than two topics
 * announced at a time. Leave the old topic when the epoch rolls, or the window the
 * epoch was supposed to bound never actually closes.
 *
 * WHETHER to epoch, and how coarse, is WP3's call: it is a straight trade of linkage
 * window against how long two devices may disagree about the time and still meet.
 * Omitting the argument keeps the permanent topic, which is why omitting it is a
 * decision and not a default.
 */
export function remoteTopic (secret, epoch = null) {
  const s = bytes32(secret, 'secret')
  if (epoch === null || epoch === undefined) return subkey(ACCOUNT_TOPIC_LABEL, s)
  return subkey(ACCOUNT_TOPIC_LABEL, b4a.concat([s, counterBytes(epoch, 'epoch', 0)]))
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

// --- short authenticated string (commit-reveal) ---------------------------------------
//
// The four digits both screens show for the viewer to compare. Getting this right is the
// whole difference between this file and the two revisions that shipped it broken, so the
// reasoning is spelled out at length.
//
// WHY THE EARLIER SAS WAS BROKEN. It was remoteSas(secret, handshakeHash): a pure function
// of the shared secret and the Noise transcript hash, nothing else. The threat model of
// the sign-in handover is a relay that HOLDS the code, therefore the secret. The handshake
// hash is legible on a raw NoiseSecretStream the instant the Noise handshake completes,
// BEFORE any protomux channel exists. So a relay could dial the TV as a raw client over and
// over, read each connection's handshake hash, and compute what SAS that leg would show —
// all without opening the aliran-signin channel, which is the only thing sdk/signin-pair.js's
// connection cap counts. It harvested (leg, SAS) pairs for free, drove the phone to a fixed
// leg-A SAS, kept dialing until a raw leg-B's precomputed SAS matched, and CLAIMED on
// exactly that socket. Both screens then showed the same digits, an honest viewer confirmed
// TRUTHFULLY, and the account crossed to the relay. Built and run end to end on a local DHT
// testnet against the revision that shipped it; the cap counted nothing, because the harvest
// opened nothing.
//
// THE FIX: make the SAS depend on a fresh nonce from EACH side, committed before either is
// revealed. Then a leg's SAS does not exist until a full in-channel round has run on that
// leg, and there is nothing to precompute off a raw socket. The exchange (standard
// commit-then-reveal, mapped onto this protocol in sdk/signin-pair.js — the TV is the RPC
// server, so it is the party that can speak first without being asked):
//
//   responder (the TV) draws nonce_R and sends remoteNonceCommit of it in its hello reply.
//     The commitment binds it: it cannot change nonce_R afterwards.
//   initiator (the phone) then sends nonce_I in clear. It chose nonce_I knowing only the
//     COMMITMENT to nonce_R — which hides it — so it could not steer the outcome; and the
//     responder chose nonce_R before ever seeing nonce_I.
//   responder reveals nonce_R; the initiator checks it against the commitment.
//   both compute remoteCommittedSas(secret, handshakeHash, nonce_I, nonce_R).
//
// Neither side can pick its contribution after seeing the other's. A relay that terminates
// both legs therefore cannot force leg A's digits to equal leg B's: on each leg it commits
// (or sends) its own nonce before it learns the honest side's, and the honest nonce lands
// uniformly. Any one pair of legs collides with probability 10^-4 — and, crucially, there is
// no longer a cheap way to draw MANY candidate SAS values and keep only a colliding pair,
// because every candidate now costs a full in-channel round.
//
// WHY THE COMMITMENT IS KEYED, AND WHY THE NONCE IS 32 BYTES. A bare hash of the nonce is
// not enough: the adversary holds the secret, so a commitment it can also recompute is only
// hiding if the committed value is too large to brute-force. The commitment is
// MAC(secret, label || nonce || handshakeHash) — keyed under the shared secret, bound to
// this connection, with its own domain-separation label — and the nonce is 256 bits. A
// code-holding relay can therefore neither invert the commitment to learn nonce_R early (a
// 256-bit search) nor open it to a different nonce later (a second-preimage on keyed
// BLAKE2b, which it cannot find even holding the key). A four-digit nonce here would
// collapse straight back to the broken version — the relay would brute-force the commitment
// and grind as before — which is exactly why REMOTE_NONCE_BYTES is an entropy floor.
//
// WHAT BOUNDS A GRIND NOW, AND THE CAP'S PART IN IT. Two independent limits sit on the
// birthday search, and BOTH are worth stating:
//   - THE LATCHES (the primary bound). The TV commits its nonce only for the ONE peer that
//     wins claim() — which spends the code — and the phone runs the reveal only with the
//     ONE peer it latches as `chosen`. So the SAS each screen actually DISPLAYS is a single
//     value per side, fixed by nonces the relay neither chose nor foresaw. That is a flat
//     10^-4, with no birthday amplification at all (sdk/signin-pair.js).
//   - THE CONNECTION CAP (the backstop — now load-bearing where it used to be decorative).
//     Set the latches aside and imagine a future refactor that loosened them: producing one
//     candidate SAS still costs a commit-reveal round, which OPENS the aliran-signin channel,
//     which is exactly what MAX_SIGNIN_CONNECTIONS counts. At a cap of 8 per side a birthday
//     search over the channels a code will entertain expects 8*8/10^4 = 6.4e-3 colliding
//     pairs. Before the nonces the SAS came free off the raw handshake hash and the cap
//     bounded nothing that mattered; now the search cannot leave the channel, so the cap
//     bounds it. Read this with sdk/signin-pair.js MAX_SIGNIN_CONNECTIONS.
//
// WHAT THE COMPARISON STILL DOES NOT BUY, stated so nobody has to rediscover it. It does
// not tell the viewer which screen they read the code off — both honest ends share one
// connection and agree — and it does not stop a LIVE interactive pretext (a fake support
// session that walks the viewer through both prompts). Those are unchanged: what defends
// them is the code itself (60 bits, a ~3-minute TTL, one use — see WHY 12 CHARACTERS) and,
// in the handover, remotePinProof below. This function's one job is to make a silent
// relay's two screens disagree, and to make grinding that disagreement away cost a counted
// channel per attempt.

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

// 32 bytes, given as a raw buffer or as 64 hex characters — the same rule bytes32 applies
// to a secret. A nonce that is any other length throws: it is one of this side's own
// values, so a malformed one is a caller bug, not a stranger's input.
function nonceBytes (nonce) {
  return bytes32(nonce, 'nonce')
}

/**
 * A fresh 32-byte SAS nonce from the system CSPRNG. Each side draws one per connection and
 * the SAS commits to both. NOT derived — the whole point is that neither side can predict
 * the other's (see the section note). Returned as raw bytes; the wire carries it as hex.
 */
export function remoteNonce () {
  const out = b4a.alloc(REMOTE_NONCE_BYTES)
  sodium.randombytes_buf(out)
  return out
}

/**
 * A binding, hiding commitment to one side's SAS nonce, on THIS connection:
 * MAC(secret, label || nonce || handshakeHash).
 *
 * Keyed under the shared secret and bound to the handshake hash on purpose (see the section
 * note): the adversary holds the secret, so only the 256-bit nonce keeps the commitment
 * hiding, and the handshake-hash binding stops a commitment made on one connection from
 * meaning anything on another. Re-splittable exactly one way — the label is a constant, the
 * nonce is a fixed REMOTE_NONCE_BYTES, the hash is the remainder.
 */
export function remoteNonceCommit (secret, handshakeHash, nonce) {
  return mac(bytes32(secret, 'secret'), NONCE_COMMIT_LABEL, nonceBytes(nonce), handshakeHashBytes(handshakeHash))
}

/**
 * Does `commit` commit to `nonce` on THIS connection? Constant-time (sodium_memcmp), and
 * false rather than a throw for a malformed COMMITMENT — that is the value a peer sent. A
 * malformed nonce or handshake hash still throws: those are this side's own inputs.
 */
export function remoteNonceCommitValid (secret, handshakeHash, nonce, commit) {
  if (!isBytes(commit) || commit.length !== REMOTE_PROOF_BYTES) return false
  let expected = null
  try { expected = remoteNonceCommit(secret, handshakeHash, nonce) } catch { return false }
  return sodium.sodium_memcmp(expected, b4a.from(commit))
}

/**
 * The digits both screens show, for the viewer to compare: '0473'. A function of the shared
 * secret, THIS connection's handshake hash, and BOTH sides' nonces — identical on two honest
 * peers of one connection (same secret, same transcript, same two nonces), and uncorrelated
 * across a relay's two legs because neither leg's nonces can be steered to match the other's
 * (see the section note). Uniform over 0000-9999.
 *
 * The two nonces enter in a fixed canonical order — the INITIATOR's, then the RESPONDER's —
 * so both ends concatenate the same bytes regardless of which one they happened to draw.
 * Role-free in meaning: the two sides compare, they do not challenge; the ordering is only
 * so the two computations agree.
 *
 * Were the account rendezvous (case B) ever to compare digits, it would use THIS function
 * and its own nonce exchange — there is deliberately one SAS construction in this file, not
 * two. (Case B's secret is the account's, which no untrusted party holds, so the raw-harvest
 * trap never applied there; the commit-reveal shape is kept anyway for that single source.)
 */
export function remoteCommittedSas (secret, handshakeHash, initiatorNonce, responderNonce) {
  const key = bytes32(secret, 'secret')
  const hh = handshakeHashBytes(handshakeHash)
  const ni = nonceBytes(initiatorNonce)
  const nr = nonceBytes(responderNonce)
  // Counter-extended stream, so rejection can never run out of bytes and the result stays a
  // pure function of (secret, handshakeHash, ni, nr). One block is 8 draws; all 2048
  // rejecting has probability below 10^-11000, which is why the fall-through is a throw
  // rather than a fallback that would quietly reintroduce the bias.
  for (let counter = 0; counter < 256; counter++) {
    const block = mac(key, SAS_LABEL, b4a.from([counter]), ni, nr, hh)
    for (let i = 0; i + 3 < block.length; i += 4) {
      const draw = block[i] * 0x1000000 + block[i + 1] * 0x10000 + block[i + 2] * 0x100 + block[i + 3]
      if (draw < SAS_DRAW_LIMIT) return String(draw % SAS_MODULUS).padStart(REMOTE_SAS_DIGITS, '0')
    }
  }
  throw new Error('SAS derivation exhausted') // unreachable
}

// --- the entry PIN --------------------------------------------------------------------
//
// WHAT THIS ROUND IS FOR, AND WHAT IT IS NOT FOR. The mutual proof above authenticates a
// CODE: it says "the peer on this connection knows the twelve characters". It cannot say
// "the peer on this connection is the box in front of the viewer", because the code is
// read off a screen and anything that can read that screen — or that talked the viewer
// into reading it out — knows it too. The PIN closes the gap in the one direction that a
// derivation can: the digits are drawn at RANDOM by the phone and TYPED INTO the target
// device, so a device that can prove it holds them is a device someone with a remote
// control in their hand is standing at. That is what defeats the STATIC LURE — a printed
// code, a forwarded screenshot, a page that says "enter this on your TV" — where there is
// no real receiving device in the session for a human to type into.
//
// IT DOES NOT DEFEAT A RELAY, AND IT NEVER DID. A relay holds the code, therefore it
// holds `secret`, therefore it holds the MAC key below. Four digits are 13.3 bits, so
// given the real TV's answer it recovers them offline in ten thousand MACs (~56 ms) and
// re-issues the proof under its own leg's transcript. Binding to the handshake hash
// prevents a proof being REPLAYED across legs; it does not prevent one being INVERTED and
// re-MACed, and inversion needs nothing the relay does not already have. What sees the
// relay is the compared SAS above, which is why sdk/signin-pair.js runs BOTH rounds and
// why removing either one is a security change and not a UX simplification.
//
// BE PRECISE ABOUT WHAT THAT BUYS. It does not close the wrong-screen case
// unconditionally, and neither does adding the SAS comparison beside it. An attacker
// running a LIVE interactive pretext — a fake support session, a screen-shared "setup
// wizard" — can still walk the viewer through BOTH steps: read these digits out, now
// confirm the ones on this page match. The viewer who was willing to type a sign-in code
// into a stranger's page will be willing to answer two more prompts from the same page.
// That pretext remains open BY DESIGN; no protocol round closes it, because the viewer is
// the one being convinced. What the two rounds remove is the cheap and the invisible
// versions: the static lure, which has no device for the digits to be typed into, and the
// silent relay, which has two transcripts and cannot make two screens agree. The attacker
// must now be present, in real time, for the whole exchange. That is a real reduction in
// attack surface and it is the whole of the claim. Do not let it be written up as
// "phishing-proof".
//
// WHY A MAC AND NOT AN ENCRYPTED PAYLOAD. The obvious alternative is to encrypt the
// handover under a key derived from the digits, so a TV that does not know them cannot
// read it. That is strictly WORSE: four digits are 13.3 bits, so an attacker who
// captures the ciphertext recovers the payload offline in ten thousand guesses at zero
// cost. A MAC keeps the guess ONLINE, where the sender counts the attempts — and the
// sender must allow exactly ONE (a mismatch aborts and burns the code, sdk/signin-pair.js).
// One attempt is what makes 1-in-10,000 the real number instead of a warm-up. (Note that
// the sender's one-attempt budget is what bounds a GUESSING device — the lure with nobody
// standing at a real TV. It does nothing against a relay, which does not have to guess.)
//
// The proof is bound to the handshake hash for the same reason every other proof in this
// file is: so that a proof produced on one connection is not valid on another. Read the
// paragraph above before quoting that as anti-relay protection — a peer that holds the
// key does not need to move a proof between transcripts, it just makes a new one.

export const REMOTE_PIN_DIGITS = 4
const PIN_MODULUS = 10 ** REMOTE_PIN_DIGITS
// Rejection sampling, with the same argument as the SAS above but on its OWN constants.
// The two counts are equal today and must stay free to move apart: they answer different
// questions (how many digits a viewer COMPARES across two screens, against how many a
// viewer TYPES on a D-pad), and a shared constant would silently couple a UX change on
// one to a security-relevant change on the other. Take a 32-bit draw, discard the ragged
// tail above the last whole multiple of 10,000, reduce what is left: exactly uniform
// rather than nearly, with a draw rejected about once in 589,000.
const PIN_DRAW_WIDTH = 0x100000000
const PIN_DRAW_LIMIT = Math.floor(PIN_DRAW_WIDTH / PIN_MODULUS) * PIN_MODULUS
const PIN_RE = new RegExp('^[0-9]{' + REMOTE_PIN_DIGITS + '}$')

/**
 * Four uniform digits for the viewer to carry to the TV: '0473'. Drawn from the system
 * CSPRNG, NOT derived — that is the entire point (see the section note above): the
 * receiving device must not be able to compute this from anything it holds.
 *
 * A string with its leading zeros, never a number: '0473' and 473 are different PINs to
 * everything downstream, and a caller that lets one become the other would produce
 * proofs the other side cannot reproduce.
 */
export function newRemotePin () {
  const buf = b4a.alloc(4)
  for (let i = 0; i < 256; i++) {
    sodium.randombytes_buf(buf)
    const draw = buf[0] * 0x1000000 + buf[1] * 0x10000 + buf[2] * 0x100 + buf[3]
    if (draw < PIN_DRAW_LIMIT) return String(draw % PIN_MODULUS).padStart(REMOTE_PIN_DIGITS, '0')
  }
  // 256 consecutive rejections has probability below 10^-1300. A fallback here would
  // quietly reintroduce the bias the rejection step exists to remove, so: throw.
  throw new Error('PIN derivation exhausted') // unreachable
}

// Exactly REMOTE_PIN_DIGITS ASCII digits, as a string. Fixed width, so it can sit in the
// middle of a proof message without a delimiter. A number, a short string or a padded
// one throws rather than being coerced: silently accepting 473 for '0473' would make one
// device's proof unreproducible on the other, which presents as "the PIN is wrong" for
// every viewer who happens to draw a leading zero — one pairing in ten.
function pinBytes (pin) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
    throw new TypeError('pin must be exactly ' + REMOTE_PIN_DIGITS + ' ASCII digits, leading zeros included')
  }
  return b4a.from(pin)
}

/**
 * Proof that this side LEARNED the digits, on THIS connection, in THAT role:
 * MAC(secret, label || role || pin || handshakeHash).
 *
 * Re-splittable exactly one way — the label is a constant, the role is one of two
 * strings of equal length, the PIN is a fixed REMOTE_PIN_DIGITS bytes, and the hash is
 * the remainder — so no other input produces these bytes, and in particular nothing
 * remoteProof(), remoteNonceCommit() or remoteCommittedSas() emits ever collides with it.
 *
 * The role field is NOT load-bearing in the sign-in handover, where only one end ever
 * emits a PIN proof: it is here because it costs one field, it keeps this function the
 * same shape as remoteProof(), and it makes the primitive safe for any later flow where
 * both ends prove digits to each other — which without a role would be a straight
 * reflection.
 */
export function remotePinProof (secret, handshakeHash, role, pin) {
  return mac(bytes32(secret, 'secret'), PIN_LABEL, roleBytes(role), pinBytes(pin), handshakeHashBytes(handshakeHash))
}

/**
 * Does `proof` show the peer learned `pin`, on THIS connection, in THAT role?
 * Constant-time (sodium_memcmp), and false rather than a throw for every malformed
 * input — this runs on bytes a stranger on a public topic sent.
 *
 * ONE CALL PER PIN. The security of the digits is entirely the caller's attempt budget:
 * this function is happy to be asked ten thousand times. See sdk/signin-pair.js, where a
 * single mismatch ends the exchange and spends the sign-in code.
 */
export function remotePinProofValid (secret, handshakeHash, role, pin, proof) {
  if (!isBytes(proof) || proof.length !== REMOTE_PROOF_BYTES) return false
  let expected = null
  try { expected = remotePinProof(secret, handshakeHash, role, pin) } catch { return false }
  return sodium.sodium_memcmp(expected, b4a.from(proof))
}
