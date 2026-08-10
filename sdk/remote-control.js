// "Play on my TV" — the account rendezvous, and the control channel that rides it.
// Runtime-agnostic (runs in Bare and in Node), like its sibling sdk/signin-pair.js.
//
// Casting makes the phone the origin server: it decrypts, serves HLS over the LAN, and
// has to stay awake and on the network for as long as the viewer watches. Handoff is the
// better shape wherever the television can run the operator's own app — the phone says
// only WHICH CHANNEL, the TV joins the swarm and pulls P2P itself at full quality, and
// the phone can then walk out of the house. Nothing decrypted ever touches the LAN.
//
//   WHY THERE IS NO CODE AND NOTHING TO TYPE. Both devices are already signed in to the
//   SAME account, so they already share the account's X25519 private key and can derive a
//   rendezvous nobody else can reach (core/remote.js case B). That is the whole difference
//   from sdk/signin-pair.js, where the TV is NOT yet signed in and the two devices share
//   nothing but twelve characters a viewer can carry across a room. Read the two files
//   together: same primitives, opposite starting conditions, and therefore very different
//   amounts of ceremony.
//
//   THE EXCHANGE, IN ORDER
//
//   1. BOTH   secret = remoteSecret(accountPrivateKey, tokenVersion), derived inside
//             sdk/login.js so the private key never leaves that scope.
//   2. TV     announce on remoteTopic(secret, epoch) — current AND previous epoch.
//      Phone  look up the same two topics. It never announces (see JOIN MODES below).
//   3. BOTH   one round of mutual proof, bound to the Noise handshake hash
//             (remoteProof / remoteProofValid). A peer that cannot prove is refused and
//             its channel is closed. There is no SAS and no PIN here, and that is not an
//             omission — see WHAT THIS DOES NOT NEED below.
//   4. Phone  play / stop. TV: status, pushed on change.
//
// WHAT THIS DOES NOT NEED, and why saying so is not hand-waving. sdk/signin-pair.js runs a
// compared-digits round and a typed-PIN round on top of the same mutual proof. Both exist
// because its shared secret is derived from a code that is READ OFF A SCREEN: anything
// that can see that screen holds the secret, so the proof authenticates a CODE and not a
// DEVICE, and a relay or a static lure passes it honestly. Here the shared secret is
// derived from the account's private key. An adversary that holds it holds the account
// itself, and has no reason to relay a channel-change command. The proof is therefore the
// whole check, exactly as core/remote.js says it can be when the secret is the account's.
//
// JOIN MODES ARE ASYMMETRIC, ON PURPOSE. The TV joins { server: true, client: false } and
// the controller { client: true, server: false }. Joining a topic as a server ANNOUNCES an
// IP:port on it; the controller never has to be found, only to find, so it never publishes
// one. A phone is the device that moves between home, work, a café and a friend's flat, so
// its address history is the one worth not writing into the DHT. This also means two TVs
// on one account never connect to each other (neither dials), which is correct: nothing in
// this protocol is TV-to-TV.
//
// THE EPOCH. remoteTopic(secret, epoch) takes an optional coarse epoch precisely so this
// module can bound a linkage window, and WHETHER to use it is this module's decision. It
// uses it, at ONE DAY (REMOTE_EPOCH_MS), joining the current and previous epoch as
// core/remote.js instructs. The argument, in full, because "we picked a day" is not one:
//
//   WHAT A PERMANENT TOPIC COSTS. Joining announces. The ~20 DHT nodes nearest the topic
//   key learn the IP:port of every device on the account, and with no epoch that key never
//   changes: those nodes hold a permanent correlator linking one account's devices to each
//   other across time and across networks, plus a standing handle for dialling any of them.
//   Nothing about the account has to be known to collect it — a Sybil presence spread over
//   the keyspace harvests it passively, the same mechanism core/remote.js prices for
//   sign-in codes.
//
//   WHAT AN EPOCH BUYS. The key moves, unpredictably (it is a keyed hash), once per period.
//   No single vantage point accumulates history, and an adversary that learned the topic
//   once loses the ability to dial those devices within two periods. That is the property
//   worth having; the precise period is second-order.
//
//   WHAT IT COSTS. Exactly one full period of tolerated clock skew, because the
//   join-current-and-previous pattern is what covers a boundary: a device at epoch N covers
//   {N, N-1} and one at N+1 covers {N+1, N}, so they always overlap on N. Two devices whose
//   clocks disagree by MORE than one period land on disjoint topic pairs and simply never
//   meet — which is the hardest failure in this area to diagnose, because both devices look
//   perfectly healthy and each says the other is not there.
//
//   WHY A DAY AND NOT AN HOUR. The privacy gain from shortening the period is sublinear: an
//   observer near a key sees whatever devices appear while they watch it, and shortening the
//   period does not shrink that — it only shortens how long ONE key is the account's. What
//   shortening definitely does do is cut the skew budget proportionally. A day is far past
//   any device with working time sync, and it is also past what the rest of the system
//   already demands: session tokens carry a wall-clock expiresAt that sdk/login.js
//   checkSession() enforces, so a device whose clock is out by more than a session TTL has
//   already lost its session and has nothing to control anything with. An hour would trade a
//   privacy improvement that is close to nothing for a real failure mode on a television
//   that boots before its NTP client answers.
//
//   WHY NOT LONGER. A week would leave one key naming an account's devices for a fortnight,
//   which starts to be the permanent correlator again.
//
//   THE ROLL IS NOT FREE AND IS NOT OPTIONAL. Leaving the topic that has aged out is what
//   actually closes the window; a caller that only ever joined would keep every epoch's
//   topic announced and the epoch would have bought nothing. _rotate() below joins the new
//   current and destroys the aged-out session on a one-minute tick.
//
//   A CLOCK BEFORE 1970 (a negative Date.now()) would make counterBytes() throw, so the
//   epoch floors at 0 — a device that thinks it is 1970 is on epoch 0 and meets other
//   devices that think so too. It is a degenerate case, not an error.
//
// THE PROOF IS BOUND TO THE HANDSHAKE HASH and the raw hash never goes on the wire —
// core/remote.js explains both (secret-stream derives its own message keys from that hash).
// What travels is one MAC of it per side.
//
// BOTH SIDES OPEN, AND BOTH SIDES ANSWER. The `hello` round is symmetric, and that is what
// makes this work on a BORROWED swarm. Hyperswarm keeps one connection per peer across all
// topics, so two devices of one account are often ALREADY connected (both re-seed feed
// topics under the default upload policy) before either starts a remote session — and a
// connection that already exists never fires 'connection' again, so a module that only
// handled new connections would never meet its peer. Hence:
//
//   - on start, every EXISTING connection is offered the channel, and every later one too;
//   - both roles both SEND and ANSWER `hello`, so whichever device starts its session
//     second is the one that opens, and the first only has to answer;
//   - and a protomux `pair` notify stays registered for the life of the session, so a peer
//     that opens after our own eager channel was rejected still finds a responder here.
//
// Offering the channel to every connected peer sounds indiscriminate and is not, because
// of what protomux does with it: a peer with no remote session has no handler for this
// protocol, so its mux REJECTS the channel on arrival (protomux _requestSession) and our
// end closes immediately. The standing set is therefore the account's own devices, and a
// stranger pays one rejected channel open. What it does reveal to that stranger is that
// this device has the feature and is looking for account peers; it reveals nothing about
// WHICH account, because the proof is a MAC under a secret they do not have.
//
// NO CONNECTION CAP, deliberately, where sdk/signin-pair.js has one. That cap exists to
// bound a birthday search against a four-digit comparison behind a 60-bit code. There is
// no comparison here and the secret is 256 bits, so an unproven peer can neither grind
// anything nor spend anything; the only thing a flood costs is a channel per socket, which
// hyperswarm's own maxPeers already bounds. A cap here would buy nothing and would give a
// stranger a way to knock a household's own devices off their rendezvous.
//
// A REVOKED DEVICE KEEPS WORKING. remoteSecret() mixes tokenVersion, so "log out all
// devices", a password reset and disabling an account all rotate the rendezvous and drop
// every device that does not re-login. revokeDevice() deliberately does NOT bump
// tokenVersion (panel/src/ops.js — it is documented there as cooperative session hygiene so
// one device can be dropped without logging the household out), so a device revoked one at
// a time KEEPS deriving this secret and KEEPS meeting the account's other devices until
// something else rotates it. Nothing in this module says or implies otherwise, and an
// operator-facing page must not either: the lever that removes a device from this
// rendezvous is "log out all devices", not "revoke".
//
// WHAT A `play` MAY AND MAY NOT DO. The streamId a peer sends is a NAME, never a
// capability: the TV looks it up in ITS OWN entitlements (the onPlay callback, wired in
// sdk/player.js to the engine's own _entitled map) and refuses anything that is not there.
// No key, no feed key, no URL and no catalog record ever crosses this channel — so one
// device of an account cannot make another fetch content it was not granted, and the worst
// a compromised controller can do is change the channel to one the television could
// already show.
//
// TAKE-OVER IS THE DEFAULT, WITH A SWITCH. An accepted `play` interrupts whatever the
// television is showing, the way Spotify Connect does, because the two devices are one
// viewer's and a confirmation prompt on a TV has to be answered with the remote control
// this feature exists to avoid picking up. It is a switch and not a law: acceptPlay
// (setAcceptPlay() at runtime) refuses play and stop with `refused` and reports the attempt
// through onRefused, so a later work package can put "allow my phone to change channels" in
// Settings without touching this file.
//
// STATUS IS NOT TELEMETRY. See publishStatus(): a push happens when the CHANNEL or the
// STATE changes and at no other time, coalesced to at most one message per second, plus one
// message to a peer the moment it verifies so a phone that arrives late still knows what is
// on. `position` rides along when the host supplies one and is never itself a reason to
// send — a scrubber that follows a live playhead is a message per second per phone for the
// length of a film, which is what this rule exists to refuse.
//
// Nothing here logs. The wire helpers below (jsonBody/parseBody/refusalFor/guardSocket/…)
// are deliberately a COPY of sdk/signin-pair.js's rather than an extraction: they are
// per-protocol (their own WIRE_VERSION, their own size bound), and that file has been
// through three security reviews that a refactor would invalidate for a convenience nobody
// asked for.

import Hyperswarm from 'hyperswarm'
import ProtomuxRPC from 'protomux-rpc'
import b4a from 'b4a'
import {
  remoteTopic, remoteProof, remoteProofValid, peerRole, REMOTE_ROLES, REMOTE_PROOF_BYTES
} from '@aliran/core'

// Its own protomux protocol, so this channel can never be confused with the panel's RPC or
// with sdk/signin-pair.js's on a socket that carries all three — which it does whenever the
// engine's swarm is borrowed (sdk/player.js replicates its corestore on every connection).
export const REMOTE_PROTOCOL = 'aliran-remote'

// Bumped only for a change the other end cannot parse. Two devices of one household are
// routinely on different app versions, so both sides check it and refuse rather than guess.
// A mismatch fails CLOSED and is NAMED where it can be: parseEnvelope() reads the `v` off a
// message this version cannot accept, so the newer side can say "update the app" instead of
// reporting a silence. The older side cannot be made to say that retrospectively — its
// parser predates this file — so plan a bump on the assumption that ONE side reports a bare
// timeout for one release cycle. The same asymmetry sdk/signin-pair.js documents.
const WIRE_VERSION = 1

/** How long one rendezvous key names an account. See THE EPOCH in the header. */
export const REMOTE_EPOCH_MS = 24 * 60 * 60 * 1000
// How often the epoch is re-read. Cheap (one integer compare in the common case) and far
// finer than the period, so the roll lands within a minute of the boundary on both devices.
const EPOCH_TICK_MS = 60 * 1000
// A hello round on an already-open connection, and the bound on one command. Generous: the
// far end is a television that may be busy opening a feed.
const RPC_MS = 15000
// Forced re-lookup cadence for the CONTROLLER while it has found nobody. Hyperswarm
// re-queries a client topic only every ~10 minutes on its own, and "the TV I just switched
// on is not in the list" is the whole feature failing. Once a peer has verified the cadence
// drops to RELOOKUP_IDLE_TICKS × this, because a session lasts hours and a standing lookup
// every 15 s for all of them is a cost the DHT should not pay for nothing.
const RELOOKUP_MS = 15000
const RELOOKUP_IDLE_TICKS = 20 // 20 × 15 s = one lookup every 5 minutes once a peer is known
// The floor between two status pushes. See publishStatus().
const STATUS_MIN_MS = 1000

// Every message here is a small JSON object; the biggest is a hello at roughly 350 bytes.
// Anything larger is not one of ours. Bounded BEFORE JSON.parse, on every parse, because
// every parse in this file runs on bytes a stranger on a public topic sent.
const MAX_BODY_BYTES = 2048
// Free-form host strings that ride on a hello. Capped and control-stripped rather than
// rejected: a peer's label goes on a screen ("Playing from Living Room"), and a device name
// a viewer typed is not a wire format.
const LABEL_MAX = 64
// A streamId is a catalog key. Shape only — the TV's own entitlement map is the authority
// on whether it exists — but shape matters, because this string is about to index a Map and
// be put on a screen.
const STREAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** The two ends of this feature. Not the Noise roles — those come from the socket. */
export const REMOTE_CONTROL_ROLES = { tv: 'tv', controller: 'controller' }

/** What a status push may say. `paused` only ever comes from a host refinement. */
export const REMOTE_STATUS_STATES = { playing: 'playing', paused: 'paused', stopped: 'stopped' }

// The reasons a caller (and a UI) needs to tell apart. Two are worth reading twice:
//
//   refused    the TV ANSWERED and said no — remote control is switched off on it
//              (setAcceptPlay(false)). A UI should say that, not "try again".
//   unentitled the TV answered and that channel is not in ITS catalogue. On one account
//              that normally means the two devices are on different logins, or the
//              controller's catalogue is stale — never that the command was malformed.
//
// And the same timeout/refused line sdk/signin-pair.js draws, for the same reason: `ask()`
// answers null for every silence alike, so each caller has to decide which of the two it is
// reporting. A television that dropped off Wi-Fi did not refuse anything.
export const REMOTE_CONTROL_ERRORS = {
  malformed: 'malformed', // not a message this protocol defines — nothing was acted on
  timeout: 'timeout', // nothing came back, or nothing usable did
  version: 'version', // the peer speaks another wire version — update one of the two apps
  unauthorized: 'unauthorized', // the peer never proved it holds the account secret
  refused: 'refused', // remote control is switched off on that device
  unentitled: 'unentitled', // that device's account cannot play that channel
  unavailable: 'unavailable', // it accepted, and could not start it (nothing broadcasting)
  unknown: 'unknown', // no such device in the list — it may have just gone away
  offline: 'offline' // this device has no rendezvous to talk on
}

export class RemoteControlError extends Error {
  constructor (code, message) { super(message); this.name = 'RemoteControlError'; this.code = code }
}

// --- wire helpers (a deliberate copy — see the header) ---------------------------------

function jsonBody (obj) { return b4a.from(JSON.stringify(obj)) }

// Bounded first, then parsed, then shape-checked. Never throws. The version-agnostic half:
// its ONLY purpose is to read `v` off a message this version cannot accept, so a peer on
// another wire version can be NAMED instead of looking like silence. Nothing acts on what
// it returns — every path that does anything goes through parseBody().
function parseEnvelope (buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length > MAX_BODY_BYTES) return null
  let v
  try { v = JSON.parse(b4a.toString(buf)) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v
}

function parseBody (buf) {
  const v = parseEnvelope(buf)
  if (!v || v.v !== WIRE_VERSION) return null
  return v
}

// Why a message this side could not accept was refused. Naming our version to an unproven
// stranger leaks nothing — every reply this file sends already carries `v`.
function refusalFor (buf) {
  const env = parseEnvelope(buf)
  if (env && typeof env.v === 'number' && env.v !== WIRE_VERSION) return REMOTE_CONTROL_ERRORS.version
  return REMOTE_CONTROL_ERRORS.malformed
}

function hexBytes (v, len) {
  if (typeof v !== 'string' || v.length !== len * 2 || !/^[0-9a-fA-F]+$/.test(v)) return null
  return b4a.from(v, 'hex')
}

const hex = (b) => b4a.toString(b, 'hex')

// A short free-form string off the wire, or null. Control characters out (a device label
// reaches a screen), whitespace collapsed, hard length cap.
function shortLabel (v, max = LABEL_MAX) {
  if (typeof v !== 'string') return null
  const s = v.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}

function destroy (x) { try { if (x) x.destroy() } catch {} }

// Hyperswarm hands connections to the application WITHOUT a standing 'error' listener, and
// a NoiseSecretStream that emits 'error' with no listener takes the whole process down —
// VERIFIED in hyperswarm 4.17.0 on both paths (the client path removes its own onerror at
// index.js:241; the server path never adds one). The engine never notices because
// corestore.replicate() attaches one on every socket, but this module also runs on a swarm
// it created itself, where nothing else would.
//
// CALL THIS BEFORE ANY OTHER TEST IN A CONNECTION HANDLER: it guards the process, not the
// session, so a socket this session has no interest in still needs it. Idempotent by a
// marker rather than by hope, because repeat on('error') calls add repeat listeners.
const GUARDED = Symbol('aliran.remote.guarded')
function guardSocket (socket) {
  try {
    if (!socket || socket[GUARDED]) return
    socket[GUARDED] = true
    socket.on('error', () => {})
  } catch {}
}

// This connection's Noise transcript hash. NOT readable until the handshake completes — it
// is null before that, and binding a proof to null is the one caller mistake core/remote.js
// calls out by name. Hyperswarm emits 'connection' after the handshake, so this normally
// resolves on the spot; the wait is here so it cannot silently stop being true.
function handshakeHash (socket) {
  if (socket.handshakeHash) return Promise.resolve(socket.handshakeHash)
  return new Promise((resolve, reject) => {
    const done = (fn, arg) => {
      socket.off('connect', onConnect); socket.off('close', onClose); socket.off('error', onClose)
      fn(arg)
    }
    const onConnect = () => done(resolve, socket.handshakeHash)
    const onClose = () => done(reject, new RemoteControlError(REMOTE_CONTROL_ERRORS.timeout, 'the connection closed before its handshake finished'))
    socket.on('connect', onConnect); socket.on('close', onClose); socket.on('error', onClose)
  })
}

// This side's role on THIS connection. Taken from the Noise handshake and NOT from the
// product role: hyperswarm decides who dialled — and on a borrowed swarm the connection may
// have been dialled for a completely different topic — so the two must not be coupled.
const myRole = (socket) => (socket.isInitiator ? REMOTE_ROLES.initiator : REMOTE_ROLES.responder)

// One request, bounded, never throwing: a peer that hangs up mid-question is an ordinary
// event, not an exception for the caller to unwind through. Returns TWO things, and the
// split is the whole point (sdk/signin-pair.js ask() draws the same line):
//
//   body     the parsed message when one came back that THIS version can act on, else null
//   version  the `v` a well-formed reply carried. Non-null with a null body is the one
//            silence-shaped outcome that has a name: a peer on another wire version.
const NO_ANSWER = Object.freeze({ body: null, version: null })
async function ask (rpc, method, body, timeout) {
  let res
  try { res = await rpc.request(method, jsonBody({ v: WIRE_VERSION, ...body }), { timeout }) } catch { return NO_ANSWER }
  const env = parseEnvelope(res)
  if (!env) return NO_ANSWER
  return {
    body: env.v === WIRE_VERSION ? env : null,
    version: typeof env.v === 'number' ? env.v : null
  }
}

// --- identity ---------------------------------------------------------------------------

/**
 * The four fields a device says about itself. Normalized on BOTH ends — this side will not
 * send a malformed one and will not act on one. Returns the normalized object, or null.
 *
 *   deviceId    how a controller ADDRESSES this device in remotePlay/remoteStop. It is the
 *               peer's OWN CLAIM, authenticated only as far as "some device of this
 *               account": two devices that were both given the same id by their host will
 *               both answer to it. The panel's device list is the authority on identity
 *               everywhere else; this is a handle for a picker, not a credential.
 *   label       what a viewer reads on the phone ('Living Room').
 *   platform    'android', 'windows', … — a UI icon, nothing more.
 *   appVersion  so a household can see WHY one device does not answer.
 */
export function normalizeRemoteIdentity (p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const deviceId = shortLabel(p.deviceId)
  if (!deviceId) return null // unaddressable — there would be nothing to send a command to
  return {
    deviceId,
    label: shortLabel(p.label),
    platform: shortLabel(p.platform, 32),
    appVersion: shortLabel(p.appVersion, 32)
  }
}

// --- the session ------------------------------------------------------------------------

/**
 * Join the account rendezvous and run the control channel on it.
 *
 * Returns synchronously-usable handle immediately; the topics are joined on the spot and
 * peers arrive over the following seconds.
 *
 * @param {object} opts
 * @param {string|Uint8Array} opts.secret  the account rendezvous secret (core/remote.js
 *                                         remoteSecret — sdk/login.js derives it)
 * @param {string} opts.role               'tv' (announce, accept commands) or 'controller'
 * @param {object} opts.identity           { deviceId, label, platform, appVersion }
 * @param {object} [opts.swarm]            an existing Hyperswarm to borrow; one is created
 *                                         otherwise (its topics are left on destroy())
 * @param {string[]} [opts.bootstrap]      custom DHT bootstrap nodes (tests, private DHTs)
 * @param {number} [opts.epochMs]          override REMOTE_EPOCH_MS (tests)
 * @param {number} [opts.tickMs]           override the epoch re-read cadence (tests)
 * @param {function} [opts.now]            clock, for tests
 * @param {boolean} [opts.acceptPlay]      TV: accept play/stop at all (default true)
 * @param {function} [opts.onPlay]         TV: async ({streamId, from}) — THROW to refuse,
 *                                         with a RemoteControlError to name the reason
 * @param {function} [opts.onStop]         TV: async ({from})
 * @param {function} [opts.onRefused]      TV: ({type, streamId, from, reason}) — a command
 *                                         arrived and was turned away
 * @param {function} [opts.onStatus]       controller: ({from, streamId, state, position})
 * @param {function} [opts.onPeers]        both: (peers[]) whenever the verified list changes
 * @param {function} [opts.onError]        background failures with no caller to throw to
 */
export function startRemoteControl (opts = {}) {
  const role = opts.role
  if (role !== REMOTE_CONTROL_ROLES.tv && role !== REMOTE_CONTROL_ROLES.controller) {
    throw new RemoteControlError(REMOTE_CONTROL_ERRORS.malformed, "role must be 'tv' or 'controller'")
  }
  const me = normalizeRemoteIdentity(opts.identity)
  if (!me) throw new RemoteControlError(REMOTE_CONTROL_ERRORS.malformed, 'identity needs at least a deviceId')
  // bytes32() inside remoteTopic throws on anything that is not 32 bytes or 64 hex
  // characters, which is what we want: a malformed secret would otherwise produce a
  // perfectly plausible topic that no other device on the account derives — two devices of
  // one household that simply never meet, the hardest failure in this area to diagnose.
  // Called here so it throws at the call the caller can see, not on the first rotate tick.
  const secret = opts.secret
  remoteTopic(secret, 0)

  const epochMs = Number.isFinite(opts.epochMs) && opts.epochMs > 0 ? opts.epochMs : REMOTE_EPOCH_MS
  const tickMs = Number.isFinite(opts.tickMs) && opts.tickMs > 0 ? opts.tickMs : EPOCH_TICK_MS
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  const onPlay = typeof opts.onPlay === 'function' ? opts.onPlay : null
  const onStop = typeof opts.onStop === 'function' ? opts.onStop : null
  const onRefused = typeof opts.onRefused === 'function' ? opts.onRefused : () => {}
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {}
  const onPeers = typeof opts.onPeers === 'function' ? opts.onPeers : () => {}
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {}

  const swarm = opts.swarm || new Hyperswarm(opts.bootstrap ? { bootstrap: opts.bootstrap } : {})
  const ownSwarm = !opts.swarm

  let acceptPlay = opts.acceptPlay !== false
  let destroyed = false
  // socket -> { rpc, mux, hh, noiseRole, verified, id, role, unlisten[] }
  const peers = new Map()
  // Every mux this session registered a `pair` notify on. Tracked separately from `peers`
  // because the notify must OUTLIVE a dropped channel — that is the whole point of it: a
  // peer whose session starts after ours finds a responder here even though our own eager
  // channel was rejected and closed minutes ago. Unregistered in destroy(), where leaving
  // one behind would retain this session's whole scope for the life of the socket.
  const paired = new Set()
  // epoch number -> PeerDiscovery session. Exactly the epochs this device is announcing on
  // (or looking up on) right now — the window the epoch exists to bound.
  const joined = new Map()
  let epochTimer = null
  let relookup = null
  let relookupTicks = 0
  // The TV's current status, and the coalescing state behind publishStatus().
  let status = { streamId: null, state: REMOTE_STATUS_STATES.stopped, position: null }
  let statusSentAt = 0
  let statusTimer = null

  const currentEpoch = () => {
    const t = clock()
    if (!Number.isFinite(t)) return 0 // a clock that is not a number is a broken clock, not a throw
    return Math.max(0, Math.floor(t / epochMs))
  }
  // The current epoch and the previous one — one full period of tolerated skew, and never
  // more than two topics announced at a time (core/remote.js remoteTopic). Epoch 0 has no
  // predecessor, and asking for -1 would throw.
  const liveEpochs = () => { const e = currentEpoch(); return e > 0 ? [e, e - 1] : [0] }

  const joinOpts = role === REMOTE_CONTROL_ROLES.tv
    ? { server: true, client: false }
    : { client: true, server: false }

  const rotate = () => {
    if (destroyed) return
    const want = liveEpochs()
    for (const e of want) {
      if (joined.has(e)) continue
      try { joined.set(e, swarm.join(remoteTopic(secret, e), joinOpts)) } catch (err) { onError(err) }
    }
    // LEAVING is the half that makes the epoch worth anything: a session that only ever
    // joined would hold every epoch's topic announced for as long as the app ran, and the
    // window the epoch exists to bound would never close.
    for (const [e, discovery] of [...joined]) {
      if (want.includes(e)) continue
      joined.delete(e)
      Promise.resolve(discovery.destroy()).catch(() => {})
    }
  }

  const verified = () => [...peers.values()].filter((p) => p.verified)
  const peerList = () => verified().map((p) => ({ ...p.id, role: p.role || null }))
  const announcePeers = () => { try { onPeers(peerList()) } catch {} }

  // --- status (TV -> controllers) --------------------------------------------------------

  const sendStatusTo = (entry) => {
    if (!entry || !entry.verified || !entry.rpc) return
    try {
      entry.rpc.event('status', jsonBody({
        v: WIRE_VERSION,
        streamId: status.streamId,
        state: status.state,
        ...(status.position === null ? {} : { position: status.position })
      }))
    } catch { /* a channel that closed under us is not an error worth raising */ }
  }

  const flushStatus = () => {
    statusSentAt = Date.now()
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null }
    for (const entry of peers.values()) sendStatusTo(entry)
  }

  /**
   * TV: what is on. Pushed to every verified controller WHEN IT CHANGES and at no other
   * time — see STATUS IS NOT TELEMETRY in the header.
   *
   * A change means the CHANNEL or the STATE moved. A new `position` alone is not a change:
   * it is stored, and it rides the next push that something else caused. A phone that wants
   * a playhead that follows a film would need a poll, and this deliberately does not
   * provide one — at one message per second per controller for two hours it is the exact
   * shape of firehose the rule exists to refuse, for a number the phone is not showing.
   *
   * Pushes are additionally floored at one per STATUS_MIN_MS with a TRAILING send, so a
   * viewer holding CH+ down produces one message a second carrying where they ended up
   * rather than one per keypress.
   */
  const publishStatus = (next = {}) => {
    if (destroyed) return
    const streamId = next.streamId === undefined ? status.streamId : (next.streamId === null ? null : shortLabel(next.streamId, 128))
    const state = Object.prototype.hasOwnProperty.call(REMOTE_STATUS_STATES, next.state) ? next.state : status.state
    const position = next.position === undefined
      ? status.position
      : (Number.isFinite(next.position) && next.position >= 0 ? Math.round(next.position) : null)
    const changed = streamId !== status.streamId || state !== status.state
    status = { streamId, state, position }
    if (!changed || role !== REMOTE_CONTROL_ROLES.tv) return
    const since = Date.now() - statusSentAt
    if (since >= STATUS_MIN_MS) return flushStatus()
    if (statusTimer) return // a trailing send is already scheduled — it will carry the latest
    statusTimer = setTimeout(() => { statusTimer = null; if (!destroyed) flushStatus() }, STATUS_MIN_MS - since)
    if (typeof statusTimer.unref === 'function') statusTimer.unref()
  }

  // --- one connection --------------------------------------------------------------------

  const dropPeer = (socket) => {
    const entry = peers.get(socket)
    if (!entry) return
    peers.delete(socket)
    for (const off of entry.unlisten) off()
    entry.unlisten.length = 0
    // The CHANNEL, never the socket. On a borrowed swarm this connection also carries
    // corestore replication and the panel RPC (sdk/player.js replicates on every socket), so
    // destroying it to end a remote session would cut a feed the viewer is watching.
    destroy(entry.rpc)
    if (entry.verified) announcePeers()
  }

  // Wire the responders. Called for the eagerly-opened channel AND for one the peer opened
  // (through the mux `pair` notify), so both paths land on identical behaviour.
  const attach = (socket, rpc, hh) => {
    const entry = { rpc, mux: rpc.mux, hh, noiseRole: myRole(socket), verified: false, id: null, role: null, unlisten: [] }
    peers.set(socket, entry)

    // Two closes, and they do NOT mean the same thing. A CHANNEL close is ordinary — a peer
    // whose remote session has not started rejects ours — and the mux must stay paired so
    // that peer can open later. A SOCKET close ends everything, so the mux is dropped from
    // `paired` too; otherwise a long session with churning peers accumulates one dead
    // Protomux per closed connection.
    const onSocketClose = () => { paired.delete(entry.mux); dropPeer(socket) }
    socket.once('close', onSocketClose)
    entry.unlisten.push(() => { try { socket.off('close', onSocketClose) } catch {} })
    const onChannelClose = () => dropPeer(socket)
    rpc.on('close', onChannelClose)
    entry.unlisten.push(() => { try { rpc.off('close', onChannelClose) } catch {} })

    // THE PROOF, as a SYNCHRONOUS responder: there is no await anywhere between testing the
    // peer's proof and setting `verified`, so no second message on this channel can
    // interleave with the latch. (The sign-in work was broken twice by exactly this class of
    // thing; the rule is cheap to keep and expensive to rediscover.)
    rpc.respond('hello', (buf) => {
      // Re-read rather than trusting the closure: a socket whose channel was dropped and
      // re-opened has a NEW entry, and a latch set on a stale one would verify nothing.
      const e = peers.get(socket)
      if (destroyed || !e || e.rpc !== rpc) return jsonBody({ v: WIRE_VERSION, error: REMOTE_CONTROL_ERRORS.offline })
      const body = parseBody(buf)
      // The only door a cross-version stranger reaches: every later message is gated on
      // being a verified peer, so this is the one place worth naming a version mismatch.
      if (!body) return jsonBody({ v: WIRE_VERSION, error: refusalFor(buf) })
      const theirProof = hexBytes(body.proof, REMOTE_PROOF_BYTES)
      const theirId = normalizeRemoteIdentity(body)
      if (!hh || !theirProof || !remoteProofValid(secret, hh, peerRole(e.noiseRole), theirProof)) {
        // Not a device of this account. Answer plainly — it learns nothing it did not know
        // by finding this topic — then close OUR CHANNEL on the next tick, not the socket.
        setTimeout(() => dropPeer(socket), 0)
        return jsonBody({ v: WIRE_VERSION, error: REMOTE_CONTROL_ERRORS.unauthorized })
      }
      if (!theirId) return jsonBody({ v: WIRE_VERSION, error: REMOTE_CONTROL_ERRORS.malformed })
      const first = !e.verified
      e.verified = true
      e.id = theirId
      e.role = body.role === REMOTE_CONTROL_ROLES.tv ? REMOTE_CONTROL_ROLES.tv : REMOTE_CONTROL_ROLES.controller
      if (first) {
        announcePeers()
        // One status to the peer that just arrived, so a phone opened after the television
        // was already playing shows what is on instead of an empty screen. This is the only
        // push that is not caused by a change, and it goes to ONE peer.
        if (role === REMOTE_CONTROL_ROLES.tv) setTimeout(() => sendStatusTo(e), 0)
      }
      return jsonBody({
        v: WIRE_VERSION,
        ok: true,
        role,
        proof: hex(remoteProof(secret, hh, e.noiseRole)),
        ...me
      })
    })

    if (role === REMOTE_CONTROL_ROLES.tv) {
      // A NAME, NEVER A CAPABILITY. onPlay resolves this id against the TELEVISION's own
      // entitlements; nothing the peer sends is trusted beyond the twelve-ish characters of
      // the id itself, and no key or URL ever travels this channel in either direction.
      rpc.respond('play', async (buf) => {
        const e = peers.get(socket)
        if (!e || !e.verified) return jsonBody({ v: WIRE_VERSION, error: REMOTE_CONTROL_ERRORS.unauthorized })
        const body = parseBody(buf)
        if (!body) return jsonBody({ v: WIRE_VERSION, error: refusalFor(buf) })
        const streamId = typeof body.streamId === 'string' && STREAM_ID_RE.test(body.streamId) ? body.streamId : null
        if (!streamId) return jsonBody({ v: WIRE_VERSION, error: REMOTE_CONTROL_ERRORS.malformed })
        if (!acceptPlay || !onPlay) {
          try { onRefused({ type: 'play', streamId, from: { ...e.id }, reason: REMOTE_CONTROL_ERRORS.refused }) } catch {}
          return jsonBody({ v: WIRE_VERSION, error: REMOTE_CONTROL_ERRORS.refused })
        }
        try {
          await onPlay({ streamId, from: { ...e.id } })
        } catch (err) {
          const reason = err && Object.prototype.hasOwnProperty.call(REMOTE_CONTROL_ERRORS, err.code)
            ? err.code
            : REMOTE_CONTROL_ERRORS.unavailable
          try { onRefused({ type: 'play', streamId, from: { ...e.id }, reason }) } catch {}
          return jsonBody({ v: WIRE_VERSION, error: reason })
        }
        // `ok` is ACCEPTANCE, not playback: the television has checked the channel against
        // its own entitlements and told its host to tune. What actually happened arrives on
        // the status channel, which is the surface a UI should believe.
        return jsonBody({ v: WIRE_VERSION, ok: true })
      })

      rpc.respond('stop', async (buf) => {
        const e = peers.get(socket)
        if (!e || !e.verified) return jsonBody({ v: WIRE_VERSION, error: REMOTE_CONTROL_ERRORS.unauthorized })
        if (!parseBody(buf)) return jsonBody({ v: WIRE_VERSION, error: refusalFor(buf) })
        // The same switch as play: "my phone may not change my television" cannot mean
        // "…but it may switch it off".
        if (!acceptPlay || !onStop) {
          try { onRefused({ type: 'stop', from: { ...e.id }, reason: REMOTE_CONTROL_ERRORS.refused }) } catch {}
          return jsonBody({ v: WIRE_VERSION, error: REMOTE_CONTROL_ERRORS.refused })
        }
        try { await onStop({ from: { ...e.id } }) } catch { return jsonBody({ v: WIRE_VERSION, error: REMOTE_CONTROL_ERRORS.unavailable }) }
        return jsonBody({ v: WIRE_VERSION, ok: true })
      })
    } else {
      // An EVENT, not a request: protomux-rpc sends it with id 0, so nothing is expected
      // back and a television whose controller has gone away pays nothing for the push.
      rpc.respond('status', (buf) => {
        const e = peers.get(socket)
        if (!e || !e.verified) return
        const body = parseBody(buf)
        if (!body) return
        const state = Object.prototype.hasOwnProperty.call(REMOTE_STATUS_STATES, body.state) ? body.state : null
        if (!state) return
        try {
          onStatus({
            from: { ...e.id },
            streamId: typeof body.streamId === 'string' ? shortLabel(body.streamId, 128) : null,
            state,
            position: Number.isFinite(body.position) && body.position >= 0 ? body.position : null
          })
        } catch {}
      })
    }
  }

  // Say hello. BOTH roles do this on every channel they end up on, which is what makes the
  // session order-independent on a borrowed swarm (see the header).
  const greet = async (socket) => {
    const entry = peers.get(socket)
    if (!entry || destroyed) return
    const { body: reply } = await ask(entry.rpc, 'hello', {
      proof: hex(remoteProof(secret, entry.hh, entry.noiseRole)),
      role,
      ...me
    }, RPC_MS)
    // The entry is re-read, not carried across the await: a channel that closed and
    // re-opened in the meantime is a DIFFERENT entry, and writing the latch onto the old one
    // would leave a verified peer nobody can reach and an unverified one that answers.
    if (destroyed || peers.get(socket) !== entry) return
    if (!reply || reply.error) return // a stranger, a refusal, or another wire version
    const theirs = hexBytes(reply.proof, REMOTE_PROOF_BYTES)
    const theirId = normalizeRemoteIdentity(reply)
    if (!theirs || !theirId || !remoteProofValid(secret, entry.hh, peerRole(entry.noiseRole), theirs)) return
    // --- the latch: no await between the test and the set ---
    if (entry.verified) return // its own hello already verified it; do not announce twice
    entry.verified = true
    entry.id = theirId
    entry.role = reply.role === REMOTE_CONTROL_ROLES.tv ? REMOTE_CONTROL_ROLES.tv : REMOTE_CONTROL_ROLES.controller
    announcePeers()
    if (role === REMOTE_CONTROL_ROLES.tv) sendStatusTo(entry)
  }

  // Is there room for a channel of ours on this socket? A CLOSED entry is not room taken —
  // an eager open that the peer's mux rejected (because its own session had not started)
  // leaves exactly that, and refusing to try again would strand the two devices.
  const claimable = (socket) => {
    if (destroyed || !socket || socket.destroyed) return false
    const e = peers.get(socket)
    return !(e && e.rpc && !e.rpc.closed)
  }

  const open = async (socket) => {
    if (!claimable(socket)) return
    let hh = null
    try { hh = await handshakeHash(socket) } catch { return }
    if (!claimable(socket)) return
    // --- synchronous from here to peers.set(), so two openers cannot both claim a socket ---
    if (peers.has(socket)) dropPeer(socket) // a closed entry from an earlier attempt
    let rpc = null
    try { rpc = new ProtomuxRPC(socket, { protocol: REMOTE_PROTOCOL }) } catch { return }
    attach(socket, rpc, hh)
    // The peer may open its half at any time — its session may start after ours — so keep a
    // notify registered for as long as this session runs. Without it, a channel we opened
    // too early is rejected and there is nothing left on this socket for the peer to reach.
    const mux = rpc.mux
    if (mux && !paired.has(mux)) {
      try {
        mux.pair({ protocol: REMOTE_PROTOCOL }, () => {
          if (destroyed || !claimable(socket)) return // one channel per socket; a second is refused
          open(socket).catch(() => {})
        })
        paired.add(mux)
      } catch {}
    }
    greet(socket).catch(() => {})
  }

  const onConnection = (socket) => {
    // BEFORE any early return — see guardSocket(). This session's lack of interest in a
    // socket is not a reason to hand an unguarded NoiseSecretStream back to the runtime.
    guardSocket(socket)
    if (destroyed) return
    open(socket).catch(() => {})
  }

  // EXISTING connections first, then new ones. Two devices of one account are frequently
  // already connected (they re-seed each other's feed topics) and hyperswarm never re-emits
  // 'connection' for a peer it already has — a session that only watched the event would
  // never meet the device in the next room. See the header.
  for (const socket of swarm.connections) onConnection(socket)
  swarm.on('connection', onConnection)
  rotate()
  epochTimer = setInterval(rotate, tickMs)
  if (typeof epochTimer.unref === 'function') epochTimer.unref()

  if (role === REMOTE_CONTROL_ROLES.controller) {
    relookup = setInterval(() => {
      if (destroyed) return
      relookupTicks++
      // Hunt hard while nothing has been found — "the television I just switched on is not
      // in the list" is the whole feature failing — then back right off, because a session
      // lasts hours and the peer set rarely changes once it has settled.
      if (verified().length > 0 && relookupTicks % RELOOKUP_IDLE_TICKS !== 0) return
      for (const discovery of joined.values()) {
        // refresh() is async and rejects once the discovery is destroyed, so the catch has
        // to be on the PROMISE — a try/catch around it would never see that.
        try { discovery.refresh().catch(() => {}) } catch {}
      }
    }, RELOOKUP_MS)
    if (typeof relookup.unref === 'function') relookup.unref()
  }

  const findPeer = (deviceId) => {
    const id = shortLabel(deviceId)
    if (!id) return null
    for (const entry of peers.values()) if (entry.verified && entry.id && entry.id.deviceId === id) return entry
    return null
  }

  const command = async (deviceId, method, body) => {
    if (destroyed) throw new RemoteControlError(REMOTE_CONTROL_ERRORS.offline, 'this device is not on the account rendezvous')
    const entry = findPeer(deviceId)
    if (!entry) throw new RemoteControlError(REMOTE_CONTROL_ERRORS.unknown, 'that device is not answering on this account right now')
    const { body: reply, version } = await ask(entry.rpc, method, body, RPC_MS)
    if (!reply) {
      // NOTHING CAME BACK, or nothing this version can read. Reported as a silence and never
      // as a refusal: the commonest cause is a television that dropped off the network, and
      // telling the viewer it "refused" accuses a device that did nothing.
      if (version !== null && version !== WIRE_VERSION) {
        throw new RemoteControlError(REMOTE_CONTROL_ERRORS.version, 'that device runs a different version of this feature — update the app on both')
      }
      throw new RemoteControlError(REMOTE_CONTROL_ERRORS.timeout, 'that device did not answer')
    }
    if (reply.error) {
      const code = Object.prototype.hasOwnProperty.call(REMOTE_CONTROL_ERRORS, reply.error) ? reply.error : REMOTE_CONTROL_ERRORS.unavailable
      throw new RemoteControlError(code, 'that device refused (' + code + ')')
    }
    return { ok: true }
  }

  return {
    role,
    /** The topics this device is on right now, hex — the window the epoch bounds. */
    topics: () => [...joined.keys()].sort((a, b) => a - b).map((e) => hex(remoteTopic(secret, e))),
    /** The epochs behind those topics, for a caller that wants to see a roll happen. */
    epochs: () => [...joined.keys()].sort((a, b) => a - b),
    /**
     * The rendezvous is live on the DHT — for a TV, that its announce has landed. Resolves
     * false rather than throwing when a lookup failed; a caller that has nothing better to
     * do than wait is not a caller that should unwind on a flaky first query.
     */
    flushed: async () => {
      const all = [...joined.values()].map((d) => Promise.resolve(d.flushed()).catch(() => false))
      return (await Promise.all(all)).every(Boolean)
    },
    /** Every device of this account that has PROVED itself on this rendezvous. */
    peers: peerList,
    /** Controller: ask a device to play a channel. Resolves {ok:true} on ACCEPTANCE. */
    play: (deviceId, streamId) => {
      if (typeof streamId !== 'string' || !STREAM_ID_RE.test(streamId)) {
        return Promise.reject(new RemoteControlError(REMOTE_CONTROL_ERRORS.malformed, 'that is not a channel id'))
      }
      return command(deviceId, 'play', { streamId })
    },
    /** Controller: ask a device to stop. */
    stop: (deviceId) => command(deviceId, 'stop', {}),
    publishStatus,
    /** TV: the take-over switch. Off refuses play AND stop, and reports through onRefused. */
    setAcceptPlay: (v) => { acceptPlay = v !== false },
    acceptsPlay: () => acceptPlay,

    /**
     * Leave the rendezvous and take every listener with it. Channels are destroyed; SOCKETS
     * are not, because on a borrowed swarm they are also carrying replication and the panel
     * RPC. A swarm this session created itself is destroyed.
     */
    async destroy () {
      if (destroyed) return
      destroyed = true
      if (epochTimer) { clearInterval(epochTimer); epochTimer = null }
      if (relookup) { clearInterval(relookup); relookup = null }
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null }
      swarm.off('connection', onConnection)
      // Stop answering for a protocol we no longer run. A notify left behind retains this
      // whole session's scope for the life of the socket, which on a borrowed swarm is the
      // life of the app.
      for (const mux of paired) { try { mux.unpair({ protocol: REMOTE_PROTOCOL }) } catch {} }
      paired.clear()
      for (const socket of [...peers.keys()]) dropPeer(socket)
      const leaving = [...joined.values()]
      joined.clear()
      for (const discovery of leaving) { try { await discovery.destroy() } catch {} }
      if (ownSwarm) { try { await swarm.destroy() } catch {} }
    }
  }
}
