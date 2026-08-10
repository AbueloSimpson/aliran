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
//   4. Phone  draws four RANDOM digits and shows them. The viewer types them into the TV.
//   5. TV     proves it learned the digits (remotePinProof, bound to the same hash).
//   6. Phone  verifies, once, then releases { username, priv, authPriv, panelPubKey }.
//   7. TV     loginWithKeys() -> its own deviceId, its own token.
//
// WHY STEPS 4-6 EXIST AT ALL, AND WHAT THEY ARE WORTH. Step 3 authenticates the CODE,
// not the DEVICE: the code is read off a screen, so anything that can see that screen —
// or that talked the viewer into reading it out — passes step 3 honestly. The digits are
// the other direction: the phone draws them from a CSPRNG, so the receiving device
// cannot derive them, and it can only prove them if a human standing at it typed them
// in. That is why the SAS is NOT used here (core/remote.js remoteSas spells this out):
// both ends can compute a SAS, so a hostile TV would simply claim the viewer matched it.
//
// Be exact about the gain. This does not make the flow phish-proof. An attacker running
// a LIVE interactive pretext can still ask the viewer to type the digits into their own
// screen. What it kills is the cheap, scalable version — a static "enter this code" lure
// — by requiring the attacker to be present in real time for both halves of a two-step
// exchange whose second step has an obviously right answer on a device in the viewer's
// hand. Say that, and not more, when this is written up for operators.
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
// produces. Nothing here logs — not the code, not the digits, not a byte of key
// material; the PIN reaches a SCREEN through onState and nowhere else.

import Hyperswarm from 'hyperswarm'
import ProtomuxRPC from 'protomux-rpc'
import b4a from 'b4a'
import {
  normalizePairingCode,
  newSigninCode, signinKeys, signinCodeState, consumeSigninCode, SIGNIN_CODE_STATES,
  remoteProof, remoteProofValid, peerRole, REMOTE_ROLES, REMOTE_PROOF_BYTES,
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
// The viewer has to look up from the phone, find the remote and press four buttons.
const DEFAULT_PIN_MS = 120000
// After the digits check out, the payload is one small message on an open connection.
const DEFAULT_PAYLOAD_MS = 20000
// A hello round on an already-open connection.
const RPC_MS = 15000
// The goodbye. Short: nothing waits on it but the wording of the TV's screen.
const ABORT_MS = 3000

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

// The reasons a caller (and a UI) needs to tell apart. `pin` is the interesting one: the
// peer answered, held the code, and could not show the digits — that is either a mistyped
// PIN or a device that never had them, and the two are deliberately indistinguishable
// from here.
export const SIGNIN_PAIR_ERRORS = {
  malformed: 'malformed', // not a sign-in code, or a payload that is not one — nothing was sent
  timeout: 'timeout', // nobody answered, or a step ran out of time
  expired: 'expired', // the code's TTL ran out before anyone linked
  used: 'used', // the code was already spent — one shot means one shot
  busy: 'busy', // a handover is already in flight for this code
  unauthorized: 'unauthorized', // the peer could not prove it holds the code
  pin: 'pin', // the peer could not prove it learned the digits
  cancelled: 'cancelled', // this side gave up
  refused: 'refused' // the peer answered, but refused the step
}

/** The states reported through `onState`, in the order each role passes through them. */
export const SIGNIN_PAIR_STATES = {
  code: 'code', // TV: the code exists and is on screen (carries code/expiresAt)
  announced: 'announced', // TV: the rendezvous is live on the DHT
  searching: 'searching', // phone: joined the topic, looking
  linked: 'linked', // both: the mutual proof passed — this peer holds the code
  pin: 'pin', // phone: here are the digits to show (carries pin)
  pinEntry: 'pin-entry', // TV: the phone is waiting for the digits
  received: 'received', // TV: the payload arrived and verified
  sent: 'sent', // phone: the payload was accepted
  failed: 'failed' // both: over (carries reason)
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

// Hyperswarm hands connections to the application WITHOUT a standing 'error' listener
// (its own noop guards are removed once a connection is handed over), and a
// NoiseSecretStream that emits 'error' with no listener takes the whole process down.
// The engine never notices, because corestore.replicate() attaches one on every socket
// — but this module also runs on a swarm it created itself (the `swarm` option is
// optional), where nothing else would, and a peer resetting the connection mid-handover
// is completely ordinary. One idempotent no-op per socket; on a borrowed swarm it simply
// sits behind corestore's.
function guardSocket (socket) {
  try { socket.on('error', () => {}) } catch {}
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
 * @param {number} [opts.pinMs]      how long the viewer has to type the digits
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
  let pinAsked = false // the phone has asked for the digits (once per handover)
  let pinSent = false // …and we have answered (once, whatever the answer)
  let submitted = null // resolve() of the pending digits, while the phone is waiting
  let pending = null // digits typed BEFORE the phone asked for them
  let deadline = null
  let discovery = null
  const rpcs = new Set()

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
    if (settled) return
    guardSocket(socket)
    // A stranger may connect for any reason (this swarm is shared with the panel and the
    // feeds). Offer the channel and let the mutual proof decide who is real.
    let rpc = null
    try { rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL }) } catch { return }
    rpcs.add(rpc)
    socket.once('close', () => { rpcs.delete(rpc) })

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
      socket.once('close', () => { if (!settled && peer && peer.socket === socket) fail(SIGNIN_PAIR_ERRORS.timeout, 'the phone disconnected before the sign-in finished') })
      onState({ state: SIGNIN_PAIR_STATES.linked })
      rearm(pinMs, SIGNIN_PAIR_ERRORS.timeout, 'the digits were not entered in time')
      return jsonBody({ v: WIRE_VERSION, ok: true, proof: hex(remoteProof(secret, hh, me)) })
    })

    // Step 5. The phone asks; this answers when the viewer has pressed four buttons, so
    // the response is deliberately held open. ONE answer per handover, right or wrong:
    // the digits get a single attempt by construction, not by a counter.
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

    // Step 6. Only from the claimed peer, and only AFTER the digits round — a sender that
    // skipped it never showed the viewer was standing here, and this is the device that
    // ends up holding the account.
    rpc.respond('signin-payload', (buf) => {
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

    // The phone giving up (a wrong PIN, mostly). Fire-and-forget from its side; here it
    // turns a two-minute silence into an immediate, accurate screen.
    rpc.respond('signin-abort', (buf) => {
      if (!peer || peer.socket !== socket) return jsonBody({ v: WIRE_VERSION, ok: true })
      const body = parseBody(buf)
      const reason = body && typeof body.reason === 'string' && SIGNIN_PAIR_ERRORS[body.reason] ? body.reason : SIGNIN_PAIR_ERRORS.cancelled
      setTimeout(() => fail(reason, reason === SIGNIN_PAIR_ERRORS.pin ? 'the digits did not match — start again with a new code' : 'the phone cancelled the sign-in'), 0)
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
     * as it goes without spending the one attempt. A well-formed submission is FINAL:
     * right or wrong, it is the only answer this handover sends.
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
 * @param {string} code       what the viewer typed ('a3k7 9qf2 m4xr' is fine)
 * @param {object} payload    { username, priv, authPriv, panelPubKey } — see
 *                            normalizeSigninPayload. This IS the account: it is drawn
 *                            from sdk/login.js's opt-in `handover` field and must not be
 *                            stored, logged or passed anywhere else.
 * @param {object} [opts]     swarm/bootstrap/onState as above, plus:
 * @param {number} [opts.timeoutMs] how long to look for the TV (default 30 s)
 * @param {number} [opts.pinMs]     how long the viewer has to type the digits
 * @returns {Promise<{username: string}>}
 * @throws {SigninPairError}
 */
export async function sendSignIn (code, payload, opts = {}) {
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {}
  const canonical = normalizePairingCode(code)
  if (!canonical) throw new SigninPairError(SIGNIN_PAIR_ERRORS.malformed, 'that is not a sign-in code — it is 12 characters, like A3K7-9QF2-M4XR')
  const body = normalizeSigninPayload(payload)
  if (!body) throw new SigninPairError(SIGNIN_PAIR_ERRORS.malformed, 'the sign-in payload is not this account (username, priv, authPriv, panelPubKey)')

  const timeoutMs = opts.timeoutMs ?? DEFAULT_LINK_MS
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
  let onConnection = null
  let discovery = null
  let timer = null
  let relookup = null
  const rpcs = new Set()
  // Set when a peer answered the mutual proof with a REFUSAL we can name — 'used',
  // 'expired', 'busy'. Reported instead of a bare timeout, because "that code has already
  // been used" is a completely different thing to tell a viewer than "nothing answered".
  let refusal = null

  try {
    return await new Promise((resolve, reject) => {
      const done = (fn, arg) => {
        if (settled) return
        settled = true
        if (fn === reject) onState({ state: SIGNIN_PAIR_STATES.failed, reason: arg.code })
        fn(arg)
      }
      const fail = (c, m) => done(reject, new SigninPairError(c, m))

      timer = setTimeout(() => {
        fail(refusal || SIGNIN_PAIR_ERRORS.timeout, refusal
          ? 'that TV refused the code (' + refusal + ') — show a new one and try again'
          : 'no TV answered that code — re-check it, and check that both devices are online')
      }, timeoutMs)

      // One candidate. Concurrent with every other candidate, exactly as sdk/pairing.js
      // runs its `describe` probes: a peer that answers wrongly, slowly or not at all
      // must never be able to deny the real TV its turn.
      const attempt = async (socket) => {
        const hh = await handshakeHash(socket)
        if (chosen || settled) return
        let rpc = null
        try { rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL }) } catch { return }
        rpcs.add(rpc)
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
        socket.once('close', () => fail(SIGNIN_PAIR_ERRORS.timeout, 'the TV disconnected before the sign-in finished'))
        onState({ state: SIGNIN_PAIR_STATES.linked })

        // Step 4. Drawn once, for this peer, from the CSPRNG — never derived, or the TV
        // could compute it (core/remote.js newRemotePin). It leaves this function only
        // through onState, on its way to a screen.
        const pin = newRemotePin()
        onState({ state: SIGNIN_PAIR_STATES.pin, pin })

        const answer = await ask(rpc, 'signin-pin', {}, pinMs)
        if (settled) return
        if (!answer || answer.error) {
          await abort(rpc, SIGNIN_PAIR_ERRORS.cancelled)
          return fail(answer && answer.error === SIGNIN_PAIR_ERRORS.used ? SIGNIN_PAIR_ERRORS.refused : SIGNIN_PAIR_ERRORS.timeout,
            'the TV did not send the digits back in time')
        }
        // Step 5, verified ONCE. There is no retry here and there must never be one: a
        // second attempt against the same connection would turn a 1-in-10,000 guess into
        // a 2-in-10,000 one, and a loop would turn it into a certainty. A mismatch ends
        // the exchange, and the TV has already spent the code.
        const shown = hexBytes(answer.proof, REMOTE_PROOF_BYTES)
        if (!shown || !remotePinProofValid(secret, hh, peerRole(me), pin, shown)) {
          await abort(rpc, SIGNIN_PAIR_ERRORS.pin)
          return fail(SIGNIN_PAIR_ERRORS.pin, 'the digits entered on the TV do not match — show a new code and start again')
        }

        // Step 6.
        const ack = await ask(rpc, 'signin-payload', { payload: body }, payloadMs)
        if (!ack) return fail(SIGNIN_PAIR_ERRORS.timeout, 'the TV did not confirm the sign-in')
        if (ack.error) return fail(SIGNIN_PAIR_ERRORS.refused, 'the TV refused the sign-in (' + ack.error + ')')
        onState({ state: SIGNIN_PAIR_STATES.sent })
        done(resolve, { username: body.username })
      }

      onConnection = (socket) => {
        if (chosen || settled) return
        guardSocket(socket)
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
    })
  } finally {
    settled = true
    clearTimeout(timer)
    clearInterval(relookup)
    if (onConnection) swarm.off('connection', onConnection)
    for (const rpc of rpcs) destroy(rpc)
    rpcs.clear()
    // Leave the rendezvous behind whatever happened — a sign-in code is a one-shot, and
    // staying on the topic only advertises a device that has nothing left to give.
    try { if (discovery) await discovery.destroy() } catch {}
    if (ownSwarm) { try { await swarm.destroy() } catch {} }
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
