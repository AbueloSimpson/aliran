// Client login protocol — runtime-agnostic (runs in Bare and in Node).
// Canonical home since the SDK extract; client/backend/login.mjs re-exports this file.
//
// Given an RPC call function to the panel and the replicated signed DB, performs the
// OPRF login and returns the streams the user may watch (with their decryption keys).
// No plaintext password ever leaves the device; only a blinded point does.
//
// TWO DOORS INTO ONE SESSION. login() takes a password and recovers the account's two
// private keys from the signed record. loginWithKeys() takes those keys directly — the
// TV half of "send to TV", where a phone that is already signed in hands them across
// (sdk/signin-pair.js). Everything after the keys are in hand is the same code and the
// same result: each device registers ITS OWN deviceId and is issued its own
// panel-signed token, so the operator's device limit and per-device revocation keep
// working exactly as they do for a typed password.

import ProtomuxRPC from 'protomux-rpc'
import b4a from 'b4a'
import { blind, finalize, verify, wrapKeyFrom, unwrap, sealTo, sealOpen, powSolve, authSign, verifyToken, remoteSecret } from '@aliran/core'

// Boot-trace hook: per-phase timings for the engine's boot trace (sdk/player.js _mark).
// The protocol is strictly serial, so "time since the previous phase" IS that phase's
// cost. Always returns a function (no-op without a trace) so no call site needs a guard,
// and a throwing trace callback can never fail a login.
function tracer (trace) {
  if (typeof trace !== 'function') return () => {}
  let last = Date.now()
  return (name, extra) => {
    const now = Date.now()
    try { trace(name, now - last, extra) } catch {}
    last = now
  }
}

// Wrap a connection to the panel as a JSON RPC caller.
export function panelClient (socket) {
  const rpc = new ProtomuxRPC(socket)
  const call = async (method, payload) => {
    const buf = payload === undefined ? b4a.alloc(0) : b4a.from(JSON.stringify(payload))
    const res = await rpc.request(method, buf)
    return JSON.parse(b4a.toString(res))
  }
  return { rpc, call }
}

export async function login (call, db, username, password, { deviceId, deviceLabel, handover, remoteSecret, trace, catalogWaitMs } = {}) {
  const mark = tracer(trace)
  // 1. proof-of-work challenge from the panel
  const hello = await call('hello')
  mark('hello')
  const nonce = powSolve(b4a.from(hello.challenge, 'hex'), hello.difficulty)
  mark('pow', 'difficulty ' + hello.difficulty)

  // 2. blinded OPRF round-trip (panel never sees the password)
  const { blinded, r } = blind(password)
  const res = await call('login', { username, blinded: b4a.toString(blinded, 'hex'), powNonce: b4a.toString(nonce, 'hex') })
  mark('login-rpc')
  if (res.error) throw new Error('login failed: ' + res.error + (res.retryAfter ? ` (retry ${res.retryAfter}s)` : ''))
  const rwd = finalize(password, r, b4a.from(res.evaluated, 'hex'))

  // 3. verify against the replicated signed record (local)
  const node = await db.get('user/' + username)
  mark('user-get')
  if (!node) throw new Error('unknown user')
  const user = node.value
  const ok = verify(rwd, b4a.from(user.salt, 'hex'), b4a.from(user.verifier, 'hex'), user.argon)
  // The Argon2id grind, at the cost the panel STAMPED INTO THIS RECORD (user.argon) —
  // marked before the throw so a wrong password still reports what the grind cost.
  mark('verify', user.argon ? `mem ${user.argon.memlimit} ops ${user.argon.opslimit}` : 'default cost')
  if (!ok) throw new Error('invalid credentials')

  // 4. recover private keys and open the granted stream keys
  const wk = wrapKeyFrom(rwd)
  const priv = unwrap(wk, user.encPriv)
  if (!priv) throw new Error('key recovery failed')
  const authPriv = user.authPrivEnc ? unwrap(wk, user.authPrivEnc) : null
  return openSession(call, db, username, user, priv, authPriv, res.sessionChallenge, { deviceId, deviceLabel, handover, remoteSecret, trace, catalogWaitMs })
}

/**
 * The same session, entered with the ACCOUNT KEYS instead of the password — the TV half
 * of "send to TV" (sdk/signin-pair.js), where a phone that already logged in hands over
 * the two private keys a login recovers and the TV finishes the protocol as itself.
 *
 * The keys are the whole credential. Anything that holds them IS the account until the
 * panel's tokenVersion moves, so they only ever travel over a connection that has passed
 * BOTH rounds of sdk/signin-pair.js — never as a stored artefact, never over a channel
 * this function knows anything about.
 *
 * WHAT MAKES THIS WORK AGAINST AN UNMODIFIED PANEL. The panel mints its one-shot
 * `sessionChallenge` inside the `login` responder, so there is no way to reach `session`
 * without a `login` round first. But that round is OBLIVIOUS — the panel evaluates a
 * blinded point and cannot tell a correct password from any other (a wrong one fails
 * later, on the client, against the replicated verifier). So this sends a well-formed
 * blinded point over a placeholder secret purely to be issued a challenge, and discards
 * the evaluation. Nothing is bypassed: the account is proved to the panel exactly as an
 * ordinary login proves it, by signing that challenge with the account's Ed25519 key.
 * A panel deploy is therefore NOT a prerequisite for this feature.
 *
 * @param {object} keys  { priv, authPriv } — hex or buffers, as sdk/signin-pair.js
 *                       delivers them: X25519 secret (32 bytes) + Ed25519 secret (64).
 */
export async function loginWithKeys (call, db, username, keys, { deviceId, deviceLabel, handover, remoteSecret, trace, catalogWaitMs } = {}) {
  const mark = tracer(trace)
  const priv = secretKeyBytes(keys && keys.priv, 'priv', 32) // crypto_box_SECRETKEYBYTES
  const authPriv = secretKeyBytes(keys && keys.authPriv, 'authPriv', 64) // crypto_sign_SECRETKEYBYTES

  const hello = await call('hello')
  mark('hello')
  const nonce = powSolve(b4a.from(hello.challenge, 'hex'), hello.difficulty)
  mark('pow', 'difficulty ' + hello.difficulty)
  // A uniformly random blinded point: `blind` multiplies by a fresh random scalar, and
  // ristretto255 has prime order, so the point on the wire is independent of the string
  // below whatever it is. It is a constant only because there is nothing to hide behind
  // — this is a request for a challenge, not an attempt at a password.
  const { blinded } = blind(CHALLENGE_ONLY_SECRET)
  const res = await call('login', { username, blinded: b4a.toString(blinded, 'hex'), powNonce: b4a.toString(nonce, 'hex') })
  mark('login-rpc')
  if (res.error) throw new Error('login failed: ' + res.error + (res.retryAfter ? ` (retry ${res.retryAfter}s)` : ''))
  if (!res.sessionChallenge) throw new Error('the panel issued no session challenge — it is too old for a key handover')

  const node = await db.get('user/' + username)
  mark('user-get')
  if (!node) throw new Error('unknown user')
  const user = node.value

  // Does this X25519 key actually belong to THIS account? Nothing downstream would say
  // so: a wrong `priv` simply fails to open every sealed stream key and produces an
  // empty, perfectly plausible catalog. Seal a probe to the record's public key and open
  // it — one anonymous box, and the difference between a loud failure and a TV that
  // signs in to a channel list with nothing in it.
  const probe = b4a.from('aliran-key-handover-probe')
  const opened = user.pub ? sealOpen(b4a.from(user.pub, 'hex'), priv, sealTo(b4a.from(user.pub, 'hex'), probe)) : null
  if (!opened || !b4a.equals(opened, probe)) throw new Error('key handover does not match this account')

  const out = await openSession(call, db, username, user, priv, authPriv, res.sessionChallenge, { deviceId, deviceLabel, handover, remoteSecret, trace, catalogWaitMs })
  // Unlike the password path, a missing token here is fatal rather than degraded: the
  // ONLY reason to run this is to enrol a device and be issued one.
  if (!out.token) throw new Error('the panel issued no session token — the key handover did not sign this device in')
  return out
}

// The placeholder secret of loginWithKeys' challenge-only OPRF round. Never a password,
// never compared against anything, and never sent — only a point derived from it is.
const CHALLENGE_ONLY_SECRET = 'aliran-session-challenge-only'

// The catalog fan-out's shape (openSession). Concurrency 8: the gets are replica reads
// dominated by per-leaf round-trips to the panel peer (measured ~11.5 ms each on a TV,
// 16.7 s serial over a 1447-grant lineup), and they all multiplex over ONE socket into
// hypercore's own request pipeline — past this, extra in-flight gets just queue inside
// hypercore while flooding the single-threaded worklet's microtask queue and competing
// with the replication stream delivering the very blocks being awaited. The wait bound
// mirrors sdk/player.js _pushTimeoutMs and exists for the same reason: on a sparse
// replica whose panel socket has died, a get can park FOREVER (the client Corestore is
// built without a core timeout). Overridable per login (catalogWaitMs) so a test can
// prove the timeout without waiting 30 s — the _rpcProbeMs pattern.
const CATALOG_GET_CONCURRENCY = 8
const CATALOG_WAIT_MS = 30000

// A private key as bytes, given as hex or a buffer, at exactly the length its algorithm
// defines. Wrong-length material must not reach sodium: a short X25519 key would be
// padded by nothing and simply fail to open every stream, which reads as "this account
// has no channels" rather than as the handover bug it is.
function secretKeyBytes (value, what, len) {
  const buf = typeof value === 'string'
    ? (/^[0-9a-fA-F]+$/.test(value) ? b4a.from(value, 'hex') : null)
    : (b4a.isBuffer(value) || value instanceof Uint8Array) ? b4a.from(value) : null
  if (!buf || buf.length !== len) throw new Error(what + ' must be ' + len + ' bytes (hex or buffer)')
  return buf
}

// Everything a login does AFTER the account keys are in hand, shared by the password
// path and the key-handover path: open the granted stream keys, read the VOD config,
// register this device and take a panel-signed token. Both callers reach the same
// result shape, so a caller cannot tell (and must not care) which door was used.
async function openSession (call, db, username, user, priv, authPriv, sessionChallenge, { deviceId, deviceLabel, handover, remoteSecret: wantRemoteSecret, trace, catalogWaitMs = CATALOG_WAIT_MS } = {}) {
  const mark = tracer(trace)
  // The catalog reads, fanned out under CATALOG_GET_CONCURRENCY with one shared
  // deadline — this loop used to be one awaited get per grant IN SERIES, and it was 83%
  // of a measured 20 s login. Results land by index so the projection below walks the
  // ids in their original order: _curatedIds() (sdk/player.js) uses login order as the
  // zap tie-break, and a nondeterministic order would make the lineup flap between
  // logins.
  //
  // ON TIMEOUT THE LOGIN DELIVERS A PARTIAL CATALOG, IT DOES NOT FAIL. Unlike 'not
  // connected to panel' (thrown before any RPC leaves the device), a login that got this
  // far has already spent hello+pow+login against the panel throttle (LOCKOUT_THRESHOLD
  // counts successes too) — surfacing the timeout as a transient error would send the
  // app-side retry ladders re-running PAID logins into the same dead socket until the
  // account locked out. A partial lineup is a working session; the channels the deadline
  // cost are the ones a failed login would not have delivered either. What self-heals
  // and what does not: _watchGrants' catch-up re-reads ids missing from the entitlement
  // map, which repairs REDIRECT channels live, but a P2P channel missed here stays
  // missing until the next login (the engine does not retain `priv`, so it cannot
  // re-open a sealed stream key later — see _refreshEntitlements). Note _pushCatalog
  // makes the OPPOSITE choice on its timeout (abandon without emitting): there a
  // previous list stands and a truncated emit reads as "channels gone"; here there is no
  // previous list, so partial beats nothing. Do not "align" the two.
  const ids = Object.keys(user.wrapped || {})
  const nodes = new Array(ids.length)
  const deadline = Date.now() + catalogWaitMs
  let cursor = 0
  let timedOut = false
  const worker = async () => {
    while (true) {
      const i = cursor++
      if (i >= ids.length) return
      const left = deadline - Date.now()
      if (left <= 0) { timedOut = true; return }
      // Raced, not cancelled — a hyperbee get has no abort. The abandoned get MUST hold
      // a rejection handler: if the bee closes underneath it, an unobserved rejection
      // takes the whole Bare worklet down (docs/kb/bare-worklet.md).
      const get = db.get('catalog/' + ids[i])
      let timer = null
      nodes[i] = await Promise.race([
        get.then((n) => n, () => null),
        new Promise((resolve) => {
          timer = setTimeout(() => { timedOut = true; resolve(null) }, left)
          if (typeof timer.unref === 'function') timer.unref()
        })
      ])
      if (timer) clearTimeout(timer)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CATALOG_GET_CONCURRENCY, ids.length) }, worker))

  // Projection pass: serial and synchronous, in ids order (see above). The sealOpen per
  // entry is cheap CPU — deliberately out of the async fan-out.
  const streams = []
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const enc = sealOpen(b4a.from(user.pub, 'hex'), priv, user.wrapped[id])
    const cat = nodes[i]
    if (enc && cat) {
      streams.push({
        id,
        title: cat.value.title,
        description: cat.value.description,
        category: cat.value.category,
        isLive: cat.value.isLive,
        poster: cat.value.poster,
        backdrop: cat.value.backdrop,
        logo: cat.value.logo,
        order: cat.value.order,
        featured: cat.value.featured,
        restricted: cat.value.restricted === true, // access control: players PIN-gate this channel
        feedKey: cat.value.feedKey,
        redirect: cat.value.redirect === true, // S23 redirect channel: viewers play `url`, no P2P feed
        url: cat.value.url ?? null,
        // Playback headers belonging to that url (a hotlink-protected provider checks
        // Referer/Origin/User-Agent before it serves). Redirect-only and as
        // engine-internal as url itself: the HOST PLAYER gets them back from
        // resolve(), never from the display list.
        headers: cat.value.headers ?? null,
        epgUrl: cat.value.epgUrl ?? null, // S27 EPG pointers (carried into _display)
        epgId: cat.value.epgId ?? null,
        type: cat.value.type ?? null, // S8a record class: 'vod' (library title) | 'live'
        durationSec: cat.value.durationSec ?? null, // vod only — a live record never carries it
        status: cat.value.status ?? null, // 'live'/'idle'; vod: 'available'/'unavailable'
        encryptionKey: b4a.toString(enc, 'hex')
      })
    }
  }
  mark('catalog', streams.length + '/' + ids.length + ' streams' + (timedOut ? ' (timed out)' : ''))

  // 4b. External VOD provider (S53): ONE replicated record the panel writes
  //     (`svcmeta/vod`) carrying the operator's enable SWITCH plus the coordinates the
  //     CLIENT uses to call the provider DIRECTLY — the panel never proxies it. Read
  //     from the same signed DB as the catalog, so it is as trustworthy as a channel
  //     record, and it holds NO secret (a viewer authenticates to the provider with
  //     their own account). Delivered ONLY when the record exists AND is enabled: a
  //     client that sees no `vod` field treats the feature as off with no version
  //     check and no separate "absent vs disabled" branch. Read at login, not watched
  //     — an operator's change lands on the viewer's next login.
  let vod
  const vodNode = await db.get('svcmeta/vod')
  mark('vod-get')
  if (vodNode && vodNode.value && vodNode.value.enabled === true) {
    const v = vodNode.value
    vod = { enabled: true, apiBase: v.apiBase, service: v.service, sources: v.sources || {}, params: v.params || {} }
  }

  // 5. prove login (sign the panel's session challenge with the recovered auth key) to
  //    obtain a panel-signed session token + register this device.
  let token = null; let expiresAt = null
  const did = deviceId || b4a.toString(b4a.from(user.pub, 'hex').subarray(0, 8), 'hex') // fallback dev id
  if (authPriv && sessionChallenge) {
    const sig = authSign(authPriv, b4a.from(sessionChallenge, 'hex'))
    const sres = await call('session', { username, deviceId: did, deviceLabel, sig: b4a.toString(sig, 'hex') })
    mark('session-rpc')
    if (sres.error) throw new Error('session failed: ' + sres.error)
    // verify the token with the panel signing public key (= the account DB core key)
    const payload = verifyToken(db.core.key, sres.token)
    if (!payload) throw new Error('panel returned an invalid session token')
    token = sres.token; expiresAt = sres.expiresAt
  }

  // 6. The account's remote-control rendezvous secret (core/remote.js). Derived HERE, in
  //    the one scope that already holds the private key, so a caller that only wants to
  //    meet the account's other devices never has to be handed the key itself: the
  //    secret is one-way, and it authenticates a peer on the account topic without
  //    being able to sign a session or open a stream.
  //
  //    OPT-IN (`remoteSecret: true`), for the same reason `handover` below is, and it is
  //    worth being exact about why a NON-key needs a gate. It cannot sign a session or
  //    open a stream, so losing it is not losing the account. But it authenticates this
  //    device to every other device on the account, and it is stable until the operator's
  //    "log out all devices" — so it is both a live authenticator and a permanent
  //    correlator for the account, and a build with no rendezvous feature has no business
  //    holding one for the length of a session. An earlier revision of this function
  //    reasoned exactly that about `handover` twelve lines below, then added this field
  //    to every login result unconditionally.
  //
  //    Null, never a guessed default, when the record carries no usable tokenVersion.
  //    remoteSecret() commits to it so that "log out all devices" moves the whole
  //    account to a new rendezvous, and substituting 0 or 1 for a missing value would
  //    silently land two devices of one household on different topics — they would
  //    simply never meet, which is the hardest failure in this area to diagnose. A
  //    pre-tokenVersion record therefore has no remote rendezvous, and the feature that
  //    needs one says so rather than half-working.
  const tokenVersion = user.tokenVersion
  const rs = wantRemoteSecret === true && Number.isSafeInteger(tokenVersion) && tokenVersion >= 1
    ? b4a.toString(remoteSecret(priv, tokenVersion), 'hex')
    : null

  return {
    streams,
    ...(vod ? { vod } : {}),
    token,
    expiresAt,
    deviceId: did,
    tokenVersion,
    ...(wantRemoteSecret === true ? { remoteSecret: rs } : {}),
    // OPT-IN, and off by default, because this field IS the account. Every existing
    // caller's result shape is unchanged, so nothing that logs or serializes a login
    // result today can start leaking key material by accident; only a caller that asked
    // for `handover: true` — sdk/player.js, for sdk/signin-pair.js's phone role — ever
    // materializes it. Hold it in memory, hand it to nothing else, and drop it with the
    // session.
    ...(handover === true
      ? { handover: { username, priv: b4a.toString(priv, 'hex'), authPriv: authPriv ? b4a.toString(authPriv, 'hex') : null } }
      : {})
  }
}

// Offline session check: valid panel signature + not expired. tokenVersion is checked
// against the replicated record when online.
export function checkSession (panelPublicKey, token, now = Date.now()) {
  const p = verifyToken(panelPublicKey, token)
  if (!p) return null
  if (typeof p.expiresAt === 'number' && now >= p.expiresAt) return null
  return p
}

// Online companion to checkSession: with the replicated user record in reach, a
// session is live only while its device is still enrolled in `user.devices[]` with
// a matching tokenVersion. This is what notices an admin per-device revoke (which
// deliberately does NOT bump tokenVersion) — a well-behaved client drops to login.
//
// MOVED to @aliran/core in S50a (core/session.js) — the panel's `report` responder
// needs the same predicate, and the panel must not import the sdk. Re-exported here
// UNCHANGED so `sdk/index.js`, the desktop/RN shells and the e2e tests that import
// it from this path keep working verbatim.
export { sessionLive } from '@aliran/core'
