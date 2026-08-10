// Phone -> TV sign-in handover — runtime-agnostic (runs in Bare and in Node).
//
// Signing in on a television means spelling out a username and a password with a D-pad.
// This replaces that with: the TV shows twelve characters, the viewer types them on a
// phone that is already signed in, the phone shows four digits, the viewer types THOSE
// into the TV, and the TV is signed in. No password is typed on the TV, and none is sent
// anywhere — the phone hands over the two private keys a login already recovered
// (sdk/login.js), and the TV finishes the ordinary protocol as itself.
//
// EACH DEVICE STAYS ITS OWN DEVICE. What crosses is account key material, not a session.
// The TV registers its OWN deviceId and takes its OWN panel-signed token
// (loginWithKeys), so `maxDevices`, the device list and per-device revocation all keep
// working exactly as they do for a typed password. Nothing here asks the panel for a new
// capability: this runs against an unmodified deployment.
//
//   THE EXCHANGE, IN ORDER
//
//   1. TV     newSigninCode() -> {topic, secret} = signinKeys(code); announce; show code.
//   2. Phone  same derivation from the typed code; join; connect.
//   3. BOTH   the WP1 mutual proof, bound to the Noise handshake hash. A peer that
//             cannot show knowledge of the code is dropped. (core/remote.js)
//   4. BOTH   remoteSas(secret, handshakeHash) — the SAME four digits on both screens.
//             The viewer confirms ON THE PHONE that the TV shows those digits. "No"
//             aborts and the code is spent. CHECK ONE.
//   5. Phone  draws four RANDOM digits and shows them. The viewer types them into the TV.
//   6. TV     proves it learned the digits (remotePinProof, bound to the same hash).
//   7. Phone  verifies, once. CHECK TWO. Both checks having passed, and only then, it
//             releases { username, priv, authPriv, panelPubKey }.
//   8. TV     loginWithKeys() -> its own deviceId, its own token.
//
// TWO CHECKS, NOT ONE, AND WHY NEITHER IS OPTIONAL. Step 3 authenticates the CODE, not
// the DEVICE: the code is read off a screen, so anything that can see that screen — or
// that talked the viewer into reading it out — passes step 3 honestly. Steps 4 and 5 are
// aimed at two DIFFERENT attackers, and each is blind to the other's:
//
//   THE RELAY, caught by step 4 only. An attacker that holds the code can sit between the
//   two real devices, terminating one Noise connection to each. It passes step 3 on both
//   legs honestly. It does NOT fail step 5: the PIN proof is a MAC under a key derived
//   from the code, which this attacker holds, so it recovers the four digits the viewer
//   typed into the real TV by MACing all ten thousand candidates offline (~56 ms) and
//   re-issues the proof bound to its own leg. That is not theory — it was built and run
//   end to end on a local DHT testnet against the revision of this file that shipped
//   without step 4, and it walked away with both private keys while both screens said
//   the sign-in had worked. Two connections mean two transcripts mean two different SAS
//   values, and there is nothing the relay can do to make ONE pair of screens agree.
//
//   THE BIRTHDAY REFINEMENT of that relay, and the connection cap it forces. Any one
//   pair of legs collides with probability 10^-4, but the relay holds the code, so it
//   can open MANY connections to each device, read every leg's handshake hash, work out
//   each leg's SAS, and — proving on none of them — prove only on a pair whose four
//   digits happen to match. That is a birthday search: ~100 connections per side, not
//   10,000 tries. MAX_SIGNIN_CONNECTIONS prices it out by burning the code once too many
//   connections have opened this channel, on BOTH roles. Its reach is bounded and the
//   constant says how: the handshake hash is legible on the raw socket, so the counter
//   sees a channel-opening flood but not a relay that harvests hashes on the side it
//   dials without opening a channel. It raises the cost; core/remote.js remoteSas holds
//   the honest ceiling.
//
//   THE STATIC LURE, caught by step 5 only. A printed code, a forwarded screenshot, a
//   page that says "enter this on your TV" — an attacker that shows a code with no real
//   TV in the session at all. Step 4 does not see it: the attacker draws its own SAS and
//   displays whatever it likes on its own page. Step 5 does: the digits have to be typed
//   into a device that is in the session, and there isn't one.
//
// Be exact about the gain. This is NOT phish-proof and adding step 4 did not make it so.
// An attacker running a LIVE interactive pretext — a fake support session, a screen-shared
// "setup wizard" — can walk the viewer through both steps: read these digits out, now
// confirm the ones on this page match. That pretext stays open by design, because the
// person being convinced is the one holding both devices. What the two steps remove is
// the cheap version and the invisible version. Say that, and not more, when this is
// written up for operators.
//
// Neither step is a knob. A future revision that drops one for a smoother flow re-opens
// exactly one of the two attacks above, and core/remote.js records which.
//
// ONE SHOT, AND WHAT ENFORCES IT. core/remote.js is explicit that consumeSigninCode() is
// a PURE function and not a lock: two callers on one record both succeed. The topic is
// public and more than one peer can answer, so exclusion has to live here, in the two
// places that own state:
//
//   TV     claim() below runs read -> consumeSigninCode -> store with NO await between
//          the liveness test and the write, inside a handler that is itself synchronous.
//          The first peer to pass the mutual proof spends the code; every later peer
//          reads `used` and is refused. It is never un-spent — a failed PIN, a dropped
//          socket and a cancel all leave it spent, so there is no retry on one code.
//   Phone  the payload comes from HERE, so this is the side that actually decides how
//          many devices get key material. One `chosen` socket is latched the moment a
//          peer's proof verifies, the PIN is drawn exactly once for it, and no other
//          peer is ever spoken to again. (A brief that only guards the TV side leaves
//          the sending side unguarded, which is the half that hands out the keys.)
//
// NO EXTRA SEAL, DELIBERATELY. The payload rides the Noise channel as it is, with no
// second envelope sealed to an ephemeral X25519 key. The reasoning, since it is the
// obvious thing to add:
//
//   - What secret-stream already provides is confidentiality, integrity and forward
//     secrecy from per-connection ephemeral keys. A second X25519 layer over the same
//     connection would be the same property, keyed the same way, twice.
//   - What it does NOT provide is proof that the peer is the right DEVICE — and a seal
//     does not provide that either. An ephemeral key from an unauthenticated peer is
//     exactly the man-in-the-middle's opening; it is only worth anything once it is
//     bound into a transcript that was authenticated by something else, which here is
//     the shared secret and the handshake hash. Bind it to those and it is provably
//     redundant with them: same key, same transcript, no adversary excluded.
//   - The real gap is the DEVICE, and the PIN round closes as much of it as a protocol
//     can. Spending the review budget there rather than on a second key exchange is the
//     deliberate trade.
//   - And the tempting variant — encrypt the payload UNDER the PIN so the TV must know
//     it — is strictly worse: four digits are 13.3 bits, so a captured ciphertext falls
//     to an offline search in ten thousand tries. A MAC keeps the guess ONLINE, where
//     the phone counts it, and the phone allows exactly one.
//
// If a future revision does add a seal, the ephemeral public key MUST be committed to in
// the proof transcript before it is used. An unbound one is worse than none.
//
// The raw handshake hash never goes on the wire (core/remote.js says why: secret-stream
// derives its own message keys from it). Only MACs of it travel, which is all this file
// produces. The SAS travels nowhere at all — both ends DERIVE it from the transcript they
// already share, so step 4 costs no message. Nothing here logs — not the code, not the
// digits, not a byte of key material; the code, the SAS and the PIN reach a SCREEN
// through onState and nowhere else.
//
//   NOTE FOR WP2b, THE HOST HALF. This module is careful because everything it handles is
//   a live secret for the next three minutes. That care ends at the IPC boundary, which
//   WP2b owns. sdk/react-native/src/backend.ts logs any IPC line shorter than 200
//   characters when `debug` is on; every message this feature sends is far shorter than
//   that, so a debug build would put the sign-in code and both sets of digits into
//   `adb logcat`. Exclude the 'signin-pair' channel from that logger before wiring the
//   screens — not after.

import Hyperswarm from 'hyperswarm'
import ProtomuxRPC from 'protomux-rpc'
import b4a from 'b4a'
import {
  normalizePairingCode,
  newSigninCode, signinKeys, signinCodeState, consumeSigninCode, SIGNIN_CODE_STATES,
  remoteProof, remoteProofValid, peerRole, REMOTE_ROLES, REMOTE_PROOF_BYTES,
  remoteSas,
  newRemotePin, remotePinProof, remotePinProofValid, REMOTE_PIN_DIGITS
} from '@aliran/core'

// Its own protomux protocol, so the sign-in channel can never be confused with the
// panel's RPC channel on a socket that carries both — which it does whenever the engine's
// swarm is borrowed (sdk/player.js replicates its corestore on every connection).
const SIGNIN_PROTOCOL = 'aliran-signin'
// Bumped only for a change the other end cannot parse. A phone and a TV are routinely on
// different app versions, so both sides check it and refuse rather than guess.
const WIRE_VERSION = 1

// How long the phone looks for a peer before giving up. Generous for the same reason
// sdk/pairing.js's is: a cold DHT lookup from a phone on a slow link is the normal case,
// and the viewer has already typed the code.
const DEFAULT_LINK_MS = 30000
// Forced re-lookup cadence while nobody has answered — one lookup round legitimately
// comes back empty when the TV announced a moment ago. Same self-heal as sdk/pairing.js.
const RELOOKUP_MS = 5000
// The viewer has to look across at the TV, find the same four digits on it and answer
// yes or no on the phone. Generous, because a "no" here is the answer that stops a relay
// and a viewer who is unsure should have time to walk over and look properly.
const DEFAULT_MATCH_MS = 120000
// The viewer has to look up from the phone, find the remote and press four buttons.
const DEFAULT_PIN_MS = 120000
// After the digits check out, the payload is one small message on an open connection.
const DEFAULT_PAYLOAD_MS = 20000
// A hello round on an already-open connection.
const RPC_MS = 15000
// The goodbye. Short: nothing waits on it but the wording of the TV's screen.
const ABORT_MS = 3000

// THE CONNECTION CAP. One sign-in code entertains at most this many connections
// that OPEN the aliran-signin channel, per role, TOTAL over the code's life — then
// it burns the code and fails closed. The legitimate flow uses exactly ONE
// connection per side; the other seven are headroom for the ordinary ways a second
// one appears with no attacker present: a NAT rebind mid-lookup that makes
// hyperswarm redial under a fresh session, a TV that dropped and reconnected inside
// the TTL, a viewer's second phone (or a double-press) answering the same code by
// accident. TOTAL rather than concurrent, because a relay can open its connections
// one after another across the whole TTL, so a concurrency limit alone would be no
// limit at all.
//
// Eight is chosen against the compared SAS, which is four digits (core/remote.js
// remoteSas). A relay that holds the code can open N connections to each device,
// read each leg's handshake hash, work out what its SAS would be, and prove only on
// a pair whose four digits happen to agree — a birthday search that expects
// N^2 / 10^4 colliding pairs. At N = 8 that is 6.4e-3, under 1%: a grind that has to
// complete inside one viewer's sign-in is priced out. At the ~100 per side an
// UNBOUNDED grind uses, the same expression is a near-certainty — which is the whole
// case for a cap over a longer SAS. Six digits would cut the per-pair odds but make
// every honest viewer compare a longer string, and a viewer who tires of comparing
// and taps "yes" has defeated the only check that sees a relay. The cap costs the
// legitimate pairing nothing.
//
// READ core/remote.js FOR THE LIMIT before quoting the 6.4e-3 as the whole story.
// It bounds a relay that reaches the protocol by OPENING THE CHANNEL. The handshake
// hash is legible on the raw NoiseSecretStream before any channel exists, so a relay
// can harvest hashes on the side it DIALS (the TV) without opening a channel this
// counter can see. The cap raises the attacker's cost and stops a channel-level
// flood; on the borrowed swarm it is not, by itself, the end of the birthday search.
const MAX_SIGNIN_CONNECTIONS = 8

// Every message here is a small JSON object; the biggest is the payload at roughly 400
// bytes of hex. Anything larger is not one of ours.
const MAX_BODY_BYTES = 4096
// The panel's own username rule (panel/src/ops.js NAME_RE). Mirrored as a SHAPE check —
// the panel remains the authority on whether the account exists and what it may do; this
// only keeps a hostile peer from putting a control character or a path separator into
// the `user/<name>` bee key a handover is about to read.
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
// Built from the core constant rather than written out, so a change to the digit count
// cannot leave a UI-facing validator behind agreeing with the proof.
const PIN_RE = new RegExp('^[0-9]{' + REMOTE_PIN_DIGITS + '}$')

export class SigninPairError extends Error {
  constructor (code, message) { super(message); this.name = 'SigninPairError'; this.code = code }
}

// The reasons a caller (and a UI) needs to tell apart. Three are worth reading twice:
//
//   pin       the peer answered, held the code, and could not show the digits — that is
//             either a mistyped PIN or a device that never had them, and the two are
//             deliberately indistinguishable from here.
//   mismatch  the viewer said the two screens did not show the same four digits. This is
//             the one failure in the list that means "something was in the middle of
//             this connection", so a UI must not fold it into a generic "try again":
//             the right next step is a new code on a network the viewer trusts, and the
//             wording should say so.
//   flooded   too many devices opened this code's channel and it was burned unspent (see
//             MAX_SIGNIN_CONNECTIONS). One code answered by many is what a grind for a
//             colliding SAS looks like from here, so — like mismatch — this is NOT a bare
//             "try again": the code is gone, and the viewer starts a fresh one on the TV.
export const SIGNIN_PAIR_ERRORS = {
  malformed: 'malformed', // not a sign-in code, or a payload that is not one — nothing was sent
  timeout: 'timeout', // nobody answered, or a step ran out of time
  expired: 'expired', // the code's TTL ran out before anyone linked
  used: 'used', // the code was already spent — one shot means one shot
  busy: 'busy', // a handover is already in flight for this code
  unauthorized: 'unauthorized', // the peer could not prove it holds the code
  mismatch: 'mismatch', // the compared digits differed — see above
  pin: 'pin', // the peer could not prove it learned the digits
  cancelled: 'cancelled', // this side gave up
  refused: 'refused', // the peer answered, but refused the step
  flooded: 'flooded' // too many devices opened this code's channel — burned as a possible grind
}

/** The states reported through `onState`, in the order each role passes through them. */
export const SIGNIN_PAIR_STATES = {
  code: 'code', // TV: the code exists and is on screen (carries code/expiresAt)
  announced: 'announced', // TV: the rendezvous is live on the DHT
  searching: 'searching', // phone: joined the topic, looking
  linked: 'linked', // both: the mutual proof passed — this peer holds the code
  // Both, and it means DIFFERENT things to the two roles (carries sas):
  //   phone  show these digits AND ASK: does the TV show the same four? The answer goes
  //          back through confirmMatch(). Nothing proceeds until it does.
  //   TV     display only. The TV has no say — the confirmation belongs on the device
  //          the viewer already trusts, which is the one holding the account.
  match: 'match',
  pin: 'pin', // phone: here are the digits to show (carries pin)
  pinEntry: 'pin-entry', // TV: the phone is waiting for the digits
  received: 'received', // TV: the payload arrived and verified
  sent: 'sent', // phone: the payload was accepted
  failed: 'failed' // both: over (carries reason)
}

// What the TV says when the PHONE ended the exchange, by the reason the phone gave. Three
// of these are things the viewer did and one is not, and a screen that collapses them
// into "sign-in failed" throws away the only information the viewer can act on. The
// `mismatch` line is deliberately the strongest: it is the only one that means something
// was in the middle of the connection.
const ABORT_MESSAGES = {
  mismatch: 'the four digits on this screen did not match the phone — that can mean something is between these two devices. Start again with a new code.',
  pin: 'the digits did not match — start again with a new code',
  cancelled: 'the phone cancelled the sign-in',
  timeout: 'the phone stopped waiting for this TV'
}

// --- wire helpers ---------------------------------------------------------------------

function jsonBody (obj) { return b4a.from(JSON.stringify(obj)) }

// Every parse in this file runs on bytes a stranger on a public topic sent: bounded
// first, then parsed, then shape-checked. Never throws.
function parseBody (buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length > MAX_BODY_BYTES) return null
  let v
  try { v = JSON.parse(b4a.toString(buf)) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  if (v.v !== WIRE_VERSION) return null
  return v
}

function hexBytes (v, len) {
  if (typeof v !== 'string' || v.length !== len * 2 || !/^[0-9a-fA-F]+$/.test(v)) return null
  return b4a.from(v, 'hex')
}

const hex = (b) => b4a.toString(b, 'hex')

// This connection's Noise transcript hash. NOT readable until the handshake completes —
// it is null before that, and binding a proof to null is the one caller mistake
// core/remote.js calls out by name. Hyperswarm emits 'connection' after the handshake, so
// this normally resolves on the spot; the wait is here so it cannot silently stop being
// true.
function handshakeHash (socket) {
  if (socket.handshakeHash) return Promise.resolve(socket.handshakeHash)
  return new Promise((resolve, reject) => {
    const done = (fn, arg) => {
      socket.off('connect', onConnect); socket.off('close', onClose); socket.off('error', onClose)
      fn(arg)
    }
    const onConnect = () => done(resolve, socket.handshakeHash)
    const onClose = () => done(reject, new SigninPairError(SIGNIN_PAIR_ERRORS.timeout, 'the connection closed before its handshake finished'))
    socket.on('connect', onConnect); socket.on('close', onClose); socket.on('error', onClose)
  })
}

// This side's role on THIS connection. Taken from the Noise handshake, not from which
// product role we are playing: hyperswarm decides who dialled, and both ends must agree.
const myRole = (socket) => (socket.isInitiator ? REMOTE_ROLES.initiator : REMOTE_ROLES.responder)

function destroy (x) { try { if (x) x.destroy() } catch {} }

// Hyperswarm hands connections to the application WITHOUT a standing 'error' listener,
// and a NoiseSecretStream that emits 'error' with no listener takes the whole process
// down. VERIFIED in hyperswarm 4.17.0, both directions: the client path removes its own
// `onerror` at index.js:241, on the line before it emits 'connection'; the server path at
// index.js:402 never adds one at all. The engine never notices, because
// corestore.replicate() attaches one on every socket — but this module also runs on a
// swarm it created itself (the `swarm` option is optional, and sdk/index.js exports these
// functions for hosts driving the protocol themselves), where nothing else would, and a
// peer resetting the connection mid-handover is completely ordinary.
//
// CALL THIS BEFORE ANY OTHER TEST IN A CONNECTION HANDLER. It guards the process, not the
// handover, so a socket this handover has no interest in still needs it — an earlier
// revision guarded only sockets that arrived before the handover latched, which left
// every connection for the next ~140 s unguarded.
//
// Idempotent, by a marker on the socket rather than by hope: repeat `on('error')` calls
// add repeat listeners, and both roles can run on one borrowed swarm. The marker is
// module-local, so two copies of this module in one process would add one listener each —
// bounded, and not worth a global registry to avoid.
const GUARDED = Symbol('aliran.signin.guarded')
function guardSocket (socket) {
  try {
    if (!socket || socket[GUARDED]) return
    socket[GUARDED] = true
    socket.on('error', () => {})
  } catch {}
}

// --- the payload ----------------------------------------------------------------------

/**
 * The four fields a signed-in device needs to make another device signed in. Validated
 * on BOTH ends: the phone will not send a malformed one, and the TV will not act on one.
 * Returns the normalized object, or null.
 *
 *   username     the account, as the panel spells it
 *   priv         X25519 secret (32 bytes) — opens the sealed per-stream keys
 *   authPriv     Ed25519 secret (64 bytes) — signs the panel's session challenge
 *   panelPubKey  which service this account belongs to, so a TV that has never been
 *                paired with an operator learns that here too
 */
export function normalizeSigninPayload (p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const { username, priv, authPriv, panelPubKey } = p
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) return null
  if (!hexBytes(priv, 32) || !hexBytes(authPriv, 64) || !hexBytes(panelPubKey, 32)) return null
  return {
    username,
    priv: priv.toLowerCase(),
    authPriv: authPriv.toLowerCase(),
    panelPubKey: panelPubKey.toLowerCase()
  }
}

// --- TV role: show a code, wait, prove the digits, receive ------------------------------

/**
 * Start a sign-in handover on the RECEIVING device.
 *
 * Resolves once the code exists and its rendezvous is joined — quickly, because the
 * viewer is waiting to read the code off the screen. The handover itself completes (or
 * fails) on the returned `result` promise.
 *
 * @param {object} [opts]
 * @param {object} [opts.swarm]      an existing Hyperswarm to borrow (left joined to
 *                                   nothing extra on return); one is created otherwise
 * @param {string[]} [opts.bootstrap] custom DHT bootstrap nodes (tests, private DHTs)
 * @param {number} [opts.ttlMs]      how long the code stays live (default: the core TTL)
 * @param {number} [opts.pinMs]      how long the two human steps have, from the moment a
 *                                   phone links: the viewer comparing the SAS on the
 *                                   phone and then typing the digits on the remote
 * @param {number} [opts.payloadMs]  how long the payload may take after the digits check
 * @param {object} [opts.kdf]        Argon2id limits — INTERACTIVE is a FLOOR, see core
 * @param {function} [opts.onState]  ({state, ...}) breadcrumbs for the UI
 * @returns {Promise<{code, canonical, expiresAt, submitPin, cancel, result}>}
 */
export async function receiveSignIn (opts = {}) {
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {}
  const pinMs = opts.pinMs ?? DEFAULT_PIN_MS
  const payloadMs = opts.payloadMs ?? DEFAULT_PAYLOAD_MS

  // The record lives in memory for one pairing and is never written down. That is not an
  // omission: a persisted record would need the malformed-state handling core/remote.js
  // documents (a NaN `usedAt` JSON-serializes to null, which reads back as LIVE), and a
  // code is worthless the moment the screen showing it goes away.
  let rec = newSigninCode(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs })
  const { topic, secret } = signinKeys(rec.canonical, opts.kdf)

  const swarm = opts.swarm || new Hyperswarm(opts.bootstrap ? { bootstrap: opts.bootstrap } : {})
  const ownSwarm = !opts.swarm

  let settled = false
  let finish = null // set below; the single exit
  let peer = null // the ONE claimed socket: { socket, rpc, hh, role }
  let signinConns = 0 // channels a peer has opened on this code — the cap counts these
  let pinAsked = false // the phone has asked for the digits (once per handover)
  let pinSent = false // …and we have answered (once, whatever the answer)
  let submitted = null // resolve() of the pending digits, while the phone is waiting
  let pending = null // digits typed BEFORE the phone asked for them
  let deadline = null
  let discovery = null
  const rpcs = new Set()
  // Every 'close' listener this handover put on a socket, with the undo. On a BORROWED
  // swarm the socket long outlives the handover (it is also carrying replication and the
  // panel RPC), so a listener left behind is a closure retaining this handover's scope for
  // the life of the app. Cleared in finish().
  const unlisten = []
  const onClose = (socket, fn) => {
    socket.once('close', fn)
    unlisten.push(() => { try { socket.off('close', fn) } catch {} })
  }

  const result = new Promise((resolve, reject) => {
    finish = (err, value) => {
      if (settled) return
      settled = true
      // Whatever happened, the code is done. Belt and braces: `settled` already turns
      // every later connection and every responder away, and claim() spent the record
      // for any peer that got as far as the mutual proof. This marks the paths that
      // never got there (cancel, expiry) too, so the record can never be observed live
      // after the handover it belonged to has ended.
      rec = { ...rec, usedAt: rec.usedAt ?? Date.now() }
      if (submitted) { const r = submitted; submitted = null; r(null) }
      clearTimeout(deadline)
      swarm.off('connection', onConnection)
      // Close the CHANNELS, never the sockets. On a borrowed swarm these connections are
      // shared with corestore replication and the panel RPC (sdk/player.js replicates on
      // every socket), so destroying one to end a sign-in would cut a feed the viewer is
      // watching. Leaving the topic is what actually ends the rendezvous.
      for (const rpc of rpcs) destroy(rpc)
      rpcs.clear()
      for (const off of unlisten) off()
      unlisten.length = 0
      ;(async () => {
        try { if (discovery) await discovery.destroy() } catch {}
        if (ownSwarm) { try { await swarm.destroy() } catch {} }
      })()
      if (err) { onState({ state: SIGNIN_PAIR_STATES.failed, reason: err.code }); reject(err) } else resolve(value)
    }
  })
  // Nobody may await this handle before the caller does — a rejection with no listener
  // yet is an unhandled rejection in some runtimes.
  result.catch(() => {})

  const fail = (code, message) => finish(new SigninPairError(code, message))
  const rearm = (ms, code, message) => {
    clearTimeout(deadline)
    deadline = setTimeout(() => fail(code, message), ms)
    if (typeof deadline.unref === 'function') deadline.unref()
  }

  // THE EXCLUSION. Fully synchronous, on purpose: between testing the record and storing
  // the spent one there is no await, no promise and no I/O, so no second connection
  // handler can interleave. core/remote.js is explicit that consumeSigninCode() cannot do
  // this for us — it is pure, and two callers on one record both succeed.
  //
  // Called ONLY after the peer has proved it holds the code, so a stranger on the public
  // topic cannot burn a viewer's code by connecting to it.
  const claim = () => {
    if (peer) return SIGNIN_PAIR_ERRORS.busy // a handover is already under way
    const now = Date.now() // ONE reading, so the refusal reason cannot disagree with the refusal
    const next = consumeSigninCode(rec, now)
    if (!next) return signinCodeState(rec, now) === SIGNIN_CODE_STATES.expired ? SIGNIN_PAIR_ERRORS.expired : SIGNIN_PAIR_ERRORS.used
    rec = next
    return null
  }

  const onConnection = (socket) => {
    // BEFORE the early return, always: see guardSocket(). This handler's own reason to
    // stop is not a reason to hand an unguarded NoiseSecretStream back to the runtime.
    // (Reaching this one WHILE settled is close to impossible, because finish() removes
    // the listener in the same synchronous block that sets the flag — the surviving gap
    // is a co-listener on the same 'connection' emit re-entering finish(), since an
    // emitter snapshots its handler list before dispatching. Written this way regardless,
    // so it stays correct if that changes and so both handlers here read alike.)
    guardSocket(socket)
    if (settled) return
    // A stranger may connect for any reason (this swarm is shared with the panel and the
    // feeds). Offer the channel and let the mutual proof decide who is real.
    let rpc = null
    try { rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL }) } catch { return }
    rpcs.add(rpc)
    onClose(socket, () => { rpcs.delete(rpc) })

    // THE CONNECTION CAP (see MAX_SIGNIN_CONNECTIONS). Count every peer that actually
    // OPENS the aliran-signin channel, proven or not — the grind's connections are
    // unproven by construction, so a counter that waited for a valid proof would count
    // nothing. 'open' fires only when the PEER opens its half of this channel, which is
    // exactly the discriminator the borrowed swarm needs: a replication peer opens
    // corestore channels and never this one, so it is never counted. Over the cap, the
    // code is burned unspent and every later peer is refused.
    rpc.once('open', () => {
      if (settled) return
      if (++signinConns > MAX_SIGNIN_CONNECTIONS) fail(SIGNIN_PAIR_ERRORS.flooded, 'too many devices answered this code — start again on the TV')
    })

    // Step 3, as a SYNCHRONOUS responder. The claim below must not be able to interleave
    // with another connection's, and the surest way to guarantee that is to leave no
    // suspension point in the whole handler.
    rpc.respond('signin-hello', (buf) => {
      if (settled) return jsonBody({ v: WIRE_VERSION, error: SIGNIN_PAIR_ERRORS.cancelled })
      const body = parseBody(buf)
      if (!body) return jsonBody({ v: WIRE_VERSION, error: SIGNIN_PAIR_ERRORS.malformed })
      const hh = socket.handshakeHash // the channel is open, so the handshake is done
      const theirProof = hexBytes(body.proof, REMOTE_PROOF_BYTES)
      const me = myRole(socket)
      if (!hh || !theirProof || !remoteProofValid(secret, hh, peerRole(me), theirProof)) {
        // Not the phone the viewer typed the code into. Answer plainly (it learns nothing
        // it did not already know by finding this topic), then close OUR CHANNEL — not
        // the socket, which on a borrowed swarm is also carrying replication.
        setTimeout(() => { rpcs.delete(rpc); destroy(rpc) }, 0)
        return jsonBody({ v: WIRE_VERSION, error: SIGNIN_PAIR_ERRORS.unauthorized })
      }
      const refused = claim()
      if (refused) return jsonBody({ v: WIRE_VERSION, error: refused })
      peer = { socket, rpc, hh, role: me }
      onClose(socket, () => { if (!settled && peer && peer.socket === socket) fail(SIGNIN_PAIR_ERRORS.timeout, 'the phone disconnected before the sign-in finished') })
      onState({ state: SIGNIN_PAIR_STATES.linked })
      // CHECK ONE, this side's half of it: put the compared digits on the TV screen. This
      // device has no say in the outcome and is told nothing about it — the confirmation
      // happens on the phone, which is the device that already holds the account and is
      // the only one of the two the viewer has a reason to trust. All the TV does is
      // display, honestly, the SAS of the connection IT is on; a relay's other leg has a
      // different transcript and therefore different digits, and that disagreement is the
      // whole check. Derived, never received: nothing a peer sends can influence it.
      onState({ state: SIGNIN_PAIR_STATES.match, sas: remoteSas(secret, hh) })
      // One window for both human steps — comparing on the phone, then typing here.
      // Splitting it would only let a UI count the same viewer twice.
      rearm(pinMs, SIGNIN_PAIR_ERRORS.timeout, 'the sign-in was not completed in time')
      return jsonBody({ v: WIRE_VERSION, ok: true, proof: hex(remoteProof(secret, hh, me)) })
    })

    // Step 6. The phone asks; this answers when the viewer has pressed four buttons, so
    // the response is deliberately held open. ONE answer per handover, right or wrong:
    // the digits get a single attempt by construction, not by a counter.
    //
    // The phone only reaches this after ITS viewer confirmed the compared digits (step 4),
    // but nothing here can verify that and nothing here should pretend to: a peer that
    // skipped the comparison is a peer that chose not to protect its own account, and the
    // only device that can enforce the comparison is the one holding the payload.
    rpc.respond('signin-pin', async (buf) => {
      if (!peer || peer.socket !== socket) return jsonBody({ v: WIRE_VERSION, error: SIGNIN_PAIR_ERRORS.unauthorized })
      if (!parseBody(buf)) return jsonBody({ v: WIRE_VERSION, error: SIGNIN_PAIR_ERRORS.malformed })
      if (pinAsked) return jsonBody({ v: WIRE_VERSION, error: SIGNIN_PAIR_ERRORS.used })
      pinAsked = true
      let digits = pending // the viewer may already have typed them
      if (!digits) {
        onState({ state: SIGNIN_PAIR_STATES.pinEntry })
        digits = await new Promise((resolve) => { submitted = resolve })
      }
      submitted = null
      if (settled || !digits) return jsonBody({ v: WIRE_VERSION, error: SIGNIN_PAIR_ERRORS.cancelled })
      pinSent = true
      rearm(payloadMs, SIGNIN_PAIR_ERRORS.timeout, 'the phone did not finish the sign-in')
      return jsonBody({ v: WIRE_VERSION, ok: true, proof: hex(remotePinProof(secret, peer.hh, peer.role, digits)) })
    })

    // Step 7. Only from the claimed peer, and only AFTER the digits round — a sender that
    // skipped it never showed the viewer was standing here, and this is the device that
    // ends up holding the account.
    rpc.respond('signin-payload', (buf) => {
      // The same guard signin-hello has. Without it a payload that arrives after this
      // handover already failed — a slow peer answering into a cancelled or timed-out
      // exchange — would emit 'received' after 'failed' and hand a caller a payload for
      // a sign-in that is over.
      if (settled) return jsonBody({ v: WIRE_VERSION, error: SIGNIN_PAIR_ERRORS.cancelled })
      if (!peer || peer.socket !== socket) return jsonBody({ v: WIRE_VERSION, error: SIGNIN_PAIR_ERRORS.unauthorized })
      if (!pinSent) return jsonBody({ v: WIRE_VERSION, error: SIGNIN_PAIR_ERRORS.unauthorized })
      const body = parseBody(buf)
      const payload = body && normalizeSigninPayload(body.payload)
      if (!payload) return jsonBody({ v: WIRE_VERSION, error: SIGNIN_PAIR_ERRORS.malformed })
      onState({ state: SIGNIN_PAIR_STATES.received })
      // Answered before finish() tears the socket down, so the phone can tell the viewer
      // it worked rather than reporting a dropped connection.
      setTimeout(() => finish(null, payload), 0)
      return jsonBody({ v: WIRE_VERSION, ok: true })
    })

    // The phone giving up (a wrong PIN or a refused comparison, mostly). Fire-and-forget
    // from its side; here it turns a two-minute silence into an immediate, accurate
    // screen.
    rpc.respond('signin-abort', (buf) => {
      if (!peer || peer.socket !== socket) return jsonBody({ v: WIRE_VERSION, ok: true })
      const body = parseBody(buf)
      // hasOwnProperty, not a bare index: `reason` is a string a stranger sent, and
      // SIGNIN_PAIR_ERRORS['constructor'], ['toString'] and ['__proto__'] are all truthy
      // through the prototype chain. panel/src/rpc.js:202 draws the same line.
      const named = body && typeof body.reason === 'string' &&
        Object.prototype.hasOwnProperty.call(SIGNIN_PAIR_ERRORS, body.reason)
      const reason = named ? body.reason : SIGNIN_PAIR_ERRORS.cancelled
      setTimeout(() => fail(reason, ABORT_MESSAGES[reason] || ABORT_MESSAGES.cancelled), 0)
      return jsonBody({ v: WIRE_VERSION, ok: true })
    })
  }

  swarm.on('connection', onConnection)
  discovery = swarm.join(topic, { server: true, client: false })

  onState({ state: SIGNIN_PAIR_STATES.code, code: rec.code, expiresAt: rec.expiresAt })
  // The code is bounded by its own TTL: if no phone links before it expires there is
  // nothing left to link to.
  rearm(Math.max(1, rec.expiresAt - Date.now()), SIGNIN_PAIR_ERRORS.expired, 'the code expired before a phone answered')
  // Not awaited before returning — the viewer must see the code immediately, and the
  // announce lands a moment later.
  ;(async () => {
    try { await discovery.flushed() } catch {}
    if (!settled && !peer) onState({ state: SIGNIN_PAIR_STATES.announced })
  })()

  return {
    code: rec.code,
    canonical: rec.canonical,
    expiresAt: rec.expiresAt,

    /**
     * The digits the viewer typed on the remote. Returns false for anything that is not
     * REMOTE_PIN_DIGITS digits, or when there is nothing to answer — a UI can validate
     * as it goes without spending the one attempt.
     *
     * PRECISELY WHAT "ONE ATTEMPT" MEANS, because the short version overstates it. The
     * handover sends exactly ONE answer, and once it has been sent nothing here can send
     * another (`pinSent` is checked below and never cleared). Until the phone ASKS,
     * though, a submission is only parked in `pending`, and a second well-formed call
     * overwrites the first and also returns true. That is not a hole — the peer sees one
     * answer either way — but a UI that reads `true` as "that is now locked in" is wrong
     * about the moments before the phone's request arrives.
     */
    submitPin (digits) {
      if (settled || pinSent) return false
      if (typeof digits !== 'string' || !PIN_RE.test(digits)) return false
      if (!peer) return false // nothing has linked yet — there is nothing to prove to
      if (submitted) { const r = submitted; submitted = null; r(digits); return true }
      pending = digits // typed before the phone asked; answered the moment it does
      return true
    },

    /** Give up. The code is spent either way — a new one is the only way forward. */
    cancel () { fail(SIGNIN_PAIR_ERRORS.cancelled, 'the sign-in was cancelled on this device') },

    result
  }
}

// --- phone role: type the code, show the digits, release --------------------------------

/**
 * Hand this device's account over to a TV showing `code`.
 *
 * A HANDLE, not a bare promise, and for the same reason receiveSignIn() is one: this
 * exchange stops for a human twice, so the caller needs a way in while it is running. It
 * resolves as soon as the rendezvous is joined; the outcome is on `result`.
 *
 * THE CALLER MUST ANSWER confirmMatch(). Nothing after {state:'match'} happens until it
 * does — that is check one of two, and it is the check that sees a relay. A host that
 * wires the screens but forgets the answer gets a timeout, never a silent release.
 *
 * @param {string} code       what the viewer typed ('a3k7 9qf2 m4xr' is fine)
 * @param {object} payload    { username, priv, authPriv, panelPubKey } — see
 *                            normalizeSigninPayload. This IS the account: it is drawn
 *                            from sdk/login.js's opt-in `handover` field and must not be
 *                            stored, logged or passed anywhere else.
 * @param {object} [opts]     swarm/bootstrap/kdf/onState as above, plus:
 * @param {number} [opts.timeoutMs] how long to look for the TV (default 30 s)
 * @param {number} [opts.matchMs]   how long the viewer has to compare the two screens
 * @param {number} [opts.pinMs]     how long the viewer has to type the digits
 * @param {number} [opts.payloadMs] how long the payload may take after the digits check
 * @returns {Promise<{canonical, confirmMatch, cancel, result}>}
 * @throws {SigninPairError} for a malformed code or payload — nothing is joined or sent
 */
export async function sendSignIn (code, payload, opts = {}) {
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {}
  const canonical = normalizePairingCode(code)
  if (!canonical) throw new SigninPairError(SIGNIN_PAIR_ERRORS.malformed, 'that is not a sign-in code — it is 12 characters, like A3K7-9QF2-M4XR')
  const body = normalizeSigninPayload(payload)
  if (!body) throw new SigninPairError(SIGNIN_PAIR_ERRORS.malformed, 'the sign-in payload is not this account (username, priv, authPriv, panelPubKey)')

  const timeoutMs = opts.timeoutMs ?? DEFAULT_LINK_MS
  const matchMs = opts.matchMs ?? DEFAULT_MATCH_MS
  const pinMs = opts.pinMs ?? DEFAULT_PIN_MS
  const payloadMs = opts.payloadMs ?? DEFAULT_PAYLOAD_MS
  const swarm = opts.swarm || new Hyperswarm(opts.bootstrap ? { bootstrap: opts.bootstrap } : {})
  const ownSwarm = !opts.swarm
  const { topic, secret } = signinKeys(canonical, opts.kdf)

  // THE SINGLE-RELEASE LATCH. This side sends the key material, so this is the guard that
  // decides how many devices can receive it. Set synchronously the instant a peer's proof
  // verifies; every other peer on the topic is ignored from then on, whatever it says.
  let chosen = null
  let settled = false
  let signinConns = 0 // channels a peer has opened on this code — the cap counts these
  let finish = null // set below; the single exit
  let onConnection = null // assigned once `attempt` exists; finish() may run before that
  let discovery = null
  let timer = null
  let relookup = null
  // resolve() of the pending comparison answer, while the viewer is looking at the TV.
  // There is nothing to park a pre-answer in, deliberately: the digits do not exist until
  // a peer has linked, so there is no honest way for a viewer to have answered already.
  let matchPending = null
  const rpcs = new Set()
  // Every socket 'close' listener this handover added, with its undo — see the same
  // structure in receiveSignIn(). On a borrowed swarm the socket outlives the handover,
  // and the closure below retains `body`, the normalized { priv, authPriv }.
  const unlisten = []
  // Set when a peer answered the mutual proof with a REFUSAL we can name — 'used',
  // 'expired', 'busy'. Reported instead of a bare timeout, because "that code has already
  // been used" is a completely different thing to tell a viewer than "nothing answered".
  let refusal = null

  const result = new Promise((resolve, reject) => {
    finish = (err, value) => {
      if (settled) return
      settled = true
      if (matchPending) { const r = matchPending; matchPending = null; r(null) }
      clearTimeout(timer); timer = null
      clearInterval(relookup); relookup = null
      if (onConnection) swarm.off('connection', onConnection)
      // Channels, never sockets — sdk/player.js replicates its corestore on every one of
      // these, so destroying a socket to end a sign-in would cut a feed that is playing.
      for (const rpc of rpcs) destroy(rpc)
      rpcs.clear()
      for (const off of unlisten) off()
      unlisten.length = 0
      ;(async () => {
        // Leave the rendezvous behind whatever happened — a sign-in code is a one-shot,
        // and staying on the topic only advertises a device that has nothing left to give.
        try { if (discovery) await discovery.destroy() } catch {}
        if (ownSwarm) { try { await swarm.destroy() } catch {} }
      })()
      if (err) { onState({ state: SIGNIN_PAIR_STATES.failed, reason: err.code }); reject(err) } else resolve(value)
    }
  })
  // A rejection nobody is listening to yet is an unhandled rejection in some runtimes.
  result.catch(() => {})

  const fail = (c, m) => finish(new SigninPairError(c, m))

  timer = setTimeout(() => {
    fail(refusal || SIGNIN_PAIR_ERRORS.timeout, refusal
      ? 'that TV refused the code (' + refusal + ') — show a new one and try again'
      : 'no TV answered that code — re-check it, and check that both devices are online')
  }, timeoutMs)
  // NOT unref'd, unlike the relookup interval below. This timer is the only thing that
  // guarantees `result` settles when no peer ever answers; unref it and a host whose
  // event loop has nothing else in it exits with the promise still pending.

  // One candidate. Concurrent with every other candidate, exactly as sdk/pairing.js
  // runs its `describe` probes: a peer that answers wrongly, slowly or not at all
  // must never be able to deny the real TV its turn.
  const attempt = async (socket) => {
    const hh = await handshakeHash(socket)
    if (chosen || settled) return
    let rpc = null
    try { rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL }) } catch { return }
    rpcs.add(rpc)
    // THE CONNECTION CAP (see MAX_SIGNIN_CONNECTIONS), this side's half. Same rule as the
    // TV: count peers that OPEN this channel, and burn the code past the cap. 'open' fires
    // when the peer (a real TV, or a flooder impersonating one) opens its half; a
    // replication peer this borrowed swarm hands over never opens this channel, so it is
    // never counted. Guarded by `chosen`: once a peer is committed to, late opens on the
    // others are moot and must not burn a handover that has already picked its TV.
    rpc.once('open', () => {
      if (settled || chosen) return
      if (++signinConns > MAX_SIGNIN_CONNECTIONS) fail(SIGNIN_PAIR_ERRORS.flooded, 'too many devices answered this code — start again on the TV')
    })
    const me = myRole(socket)

    const hello = await ask(rpc, 'signin-hello', { proof: hex(remoteProof(secret, hh, me)) }, RPC_MS)
    if (!hello) return
    if (hello.error) {
      // Only a REFUSAL of a code this peer clearly recognises is worth reporting; an
      // 'unauthorized' or a malformed answer is an ordinary stranger on a public
      // topic and must not become an accusation (sdk/pairing.js draws the same line).
      if ([SIGNIN_PAIR_ERRORS.used, SIGNIN_PAIR_ERRORS.expired, SIGNIN_PAIR_ERRORS.busy].includes(hello.error)) refusal = hello.error
      return
    }
    const theirs = hexBytes(hello.proof, REMOTE_PROOF_BYTES)
    if (!theirs || !remoteProofValid(secret, hh, peerRole(me), theirs)) return

    // --- the latch: no await between the test and the set ---
    if (chosen || settled) return
    chosen = socket
    clearTimeout(timer); timer = null
    clearInterval(relookup); relookup = null
    const onSocketClose = () => fail(SIGNIN_PAIR_ERRORS.timeout, 'the TV disconnected before the sign-in finished')
    socket.once('close', onSocketClose)
    unlisten.push(() => { try { socket.off('close', onSocketClose) } catch {} })
    onState({ state: SIGNIN_PAIR_STATES.linked })

    // ===== CHECK ONE: the compared digits =====
    // DERIVED from the transcript of THIS connection, so a relay — which terminates two
    // connections and holds the code, and therefore beats every MAC in this exchange —
    // cannot make this device and the TV show the same four digits. Nothing is sent: the
    // TV computes its own from its own transcript. The viewer answers HERE, on the device
    // that already holds the account, because a hostile receiver would happily answer for
    // itself. See core/remote.js remoteSas for what this does not buy.
    onState({ state: SIGNIN_PAIR_STATES.match, sas: remoteSas(secret, hh) })
    const compareTimer = setTimeout(() => {
      if (matchPending) { const r = matchPending; matchPending = null; r(null) }
    }, matchMs)
    if (typeof compareTimer.unref === 'function') compareTimer.unref()
    const agreed = await new Promise((resolve) => { matchPending = resolve })
    clearTimeout(compareTimer)
    if (settled) return
    if (agreed !== true) {
      // A refusal and a silence are told apart, because they are different events: one is
      // a viewer who looked and said no, the other is a viewer who walked away.
      await abort(rpc, agreed === false ? SIGNIN_PAIR_ERRORS.mismatch : SIGNIN_PAIR_ERRORS.timeout)
      return agreed === false
        ? fail(SIGNIN_PAIR_ERRORS.mismatch, 'those are not the digits the TV is showing. Something may be between this phone and that TV — do not try again on this network without checking. Nothing was sent.')
        : fail(SIGNIN_PAIR_ERRORS.timeout, 'the digits on the two screens were never confirmed — start again with a new code')
    }

    // ===== CHECK TWO: the typed digits =====
    // Drawn once, for this peer, from the CSPRNG — never derived, or the TV could compute
    // it (core/remote.js newRemotePin). It leaves this function only through onState, on
    // its way to a screen.
    const pin = newRemotePin()
    onState({ state: SIGNIN_PAIR_STATES.pin, pin })

    const answer = await ask(rpc, 'signin-pin', {}, pinMs)
    if (settled) return
    if (!answer || answer.error) {
      // Three different things end up here and a viewer can act on only one of them, so
      // the wording is derived from the condition rather than shared. This is the failure
      // an honest viewer hits most often — usually the middle one, after cancelling on
      // the TV, or the first one, after walking away from it.
      await abort(rpc, SIGNIN_PAIR_ERRORS.cancelled)
      if (!answer) return fail(SIGNIN_PAIR_ERRORS.timeout, 'the digits were never entered on the TV — show a new code and start again')
      if (answer.error === SIGNIN_PAIR_ERRORS.cancelled) return fail(SIGNIN_PAIR_ERRORS.cancelled, 'the sign-in was cancelled on the TV')
      if (answer.error === SIGNIN_PAIR_ERRORS.used) return fail(SIGNIN_PAIR_ERRORS.refused, 'that TV has already answered a set of digits for this code — show a new one')
      return fail(SIGNIN_PAIR_ERRORS.refused, 'the TV refused the digits step (' + answer.error + ')')
    }
    // Verified ONCE. There is no retry here and there must never be one: a second attempt
    // against the same connection would turn a 1-in-10,000 guess into a 2-in-10,000 one,
    // and a loop would turn it into a certainty. A mismatch ends the exchange, and the TV
    // has already spent the code.
    const shown = hexBytes(answer.proof, REMOTE_PROOF_BYTES)
    if (!shown || !remotePinProofValid(secret, hh, peerRole(me), pin, shown)) {
      await abort(rpc, SIGNIN_PAIR_ERRORS.pin)
      return fail(SIGNIN_PAIR_ERRORS.pin, 'the digits entered on the TV do not match — show a new code and start again')
    }

    // BOTH CHECKS HAVE PASSED. This line, and nothing before it, is where the account
    // leaves this device.
    const ack = await ask(rpc, 'signin-payload', { payload: body }, payloadMs)
    if (!ack) return fail(SIGNIN_PAIR_ERRORS.timeout, 'the TV did not confirm the sign-in')
    if (ack.error) return fail(SIGNIN_PAIR_ERRORS.refused, 'the TV refused the sign-in (' + ack.error + ')')
    onState({ state: SIGNIN_PAIR_STATES.sent })
    finish(null, { username: body.username })
  }

  onConnection = (socket) => {
    // BEFORE the early return — see guardSocket(). `chosen` latches within a second or
    // two of the first peer answering and `settled` only flips at the very end, so an
    // early return here left every connection arriving over the following two minutes
    // without an 'error' listener, which is a process kill on an ordinary TCP reset.
    guardSocket(socket)
    if (chosen || settled) return
    attempt(socket).catch(() => {})
  }
  swarm.on('connection', onConnection)
  discovery = swarm.join(topic, { client: true, server: false })
  onState({ state: SIGNIN_PAIR_STATES.searching })
  swarm.flush().catch(() => {}) // not awaited: the first peer often answers sooner
  relookup = setInterval(() => {
    if (chosen || settled) return
    // refresh() is async and rejects once the discovery is destroyed, so the catch
    // has to be on the PROMISE — a try/catch around it would never see that.
    try { discovery.refresh().catch(() => {}) } catch {}
  }, RELOOKUP_MS)
  if (typeof relookup.unref === 'function') relookup.unref()

  return {
    canonical,

    /**
     * The viewer's answer to "does the TV show these four digits?" — true or false.
     * Returns false when there is nothing to answer (nothing has linked yet, the window
     * has passed, or it has already been answered), so a UI can call it safely.
     *
     * FALSE IS THE IMPORTANT ANSWER. It means the two screens disagreed, which is what a
     * relay looks like from here, and it must be as easy to give as true. Never default
     * it, never infer it from a dismissed dialog, and never let a "skip" answer it.
     */
    confirmMatch (ok) {
      if (settled || !matchPending) return false
      const r = matchPending; matchPending = null
      r(ok === true)
      return true
    },

    /** Give up. The TV's code is spent either way — a new one is the only way forward. */
    cancel () { fail(SIGNIN_PAIR_ERRORS.cancelled, 'the sign-in was cancelled on this device') },

    result
  }
}

// One request, bounded, never throwing: a peer that hangs up mid-question is an ordinary
// event on a public topic, not an exception for the caller to unwind through.
async function ask (rpc, method, body, timeout) {
  let res
  try { res = await rpc.request(method, jsonBody({ v: WIRE_VERSION, ...body }), { timeout }) } catch { return null }
  return parseBody(res)
}

// Tell the TV why we stopped, so it can put an accurate screen up NOW instead of after
// its own payload timeout — the difference between "those digits were wrong" and twenty
// seconds of nothing. Sent as a request rather than an event so the answer proves it
// landed, bounded hard because the exchange is already over and nothing waits on this
// but the wording of a message. Never throws.
async function abort (rpc, reason) {
  try { await rpc.request('signin-abort', jsonBody({ v: WIRE_VERSION, reason }), { timeout: ABORT_MS }) } catch {}
}
