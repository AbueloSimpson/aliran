// Client login protocol — runtime-agnostic (runs in Bare and in Node).
// Canonical home since the SDK extract; client/backend/login.mjs re-exports this file.
//
// Given an RPC call function to the panel and the replicated signed DB, performs the
// OPRF login and returns the streams the user may watch (with their decryption keys).
// No plaintext password ever leaves the device; only a blinded point does.

import ProtomuxRPC from 'protomux-rpc'
import b4a from 'b4a'
import { blind, finalize, verify, wrapKeyFrom, unwrap, sealOpen, powSolve, authSign, verifyToken } from '@aliran/core'

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

export async function login (call, db, username, password, { deviceId, deviceLabel } = {}) {
  // 1. proof-of-work challenge from the panel
  const hello = await call('hello')
  const nonce = powSolve(b4a.from(hello.challenge, 'hex'), hello.difficulty)

  // 2. blinded OPRF round-trip (panel never sees the password)
  const { blinded, r } = blind(password)
  const res = await call('login', { username, blinded: b4a.toString(blinded, 'hex'), powNonce: b4a.toString(nonce, 'hex') })
  if (res.error) throw new Error('login failed: ' + res.error + (res.retryAfter ? ` (retry ${res.retryAfter}s)` : ''))
  const rwd = finalize(password, r, b4a.from(res.evaluated, 'hex'))

  // 3. verify against the replicated signed record (local)
  const node = await db.get('user/' + username)
  if (!node) throw new Error('unknown user')
  const user = node.value
  if (!verify(rwd, b4a.from(user.salt, 'hex'), b4a.from(user.verifier, 'hex'), user.argon)) {
    throw new Error('invalid credentials')
  }

  // 4. recover private keys and open the granted stream keys
  const wk = wrapKeyFrom(rwd)
  const priv = unwrap(wk, user.encPriv)
  if (!priv) throw new Error('key recovery failed')
  const streams = []
  for (const id of Object.keys(user.wrapped || {})) {
    const enc = sealOpen(b4a.from(user.pub, 'hex'), priv, user.wrapped[id])
    const cat = await db.get('catalog/' + id)
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
  if (vodNode && vodNode.value && vodNode.value.enabled === true) {
    const v = vodNode.value
    vod = { enabled: true, apiBase: v.apiBase, service: v.service, sources: v.sources || {}, params: v.params || {} }
  }

  // 5. prove login (sign the panel's session challenge with the recovered auth key) to
  //    obtain a panel-signed session token + register this device.
  let token = null; let expiresAt = null
  const authPriv = user.authPrivEnc ? unwrap(wk, user.authPrivEnc) : null
  const did = deviceId || b4a.toString(b4a.from(user.pub, 'hex').subarray(0, 8), 'hex') // fallback dev id
  if (authPriv && res.sessionChallenge) {
    const sig = authSign(authPriv, b4a.from(res.sessionChallenge, 'hex'))
    const sres = await call('session', { username, deviceId: did, deviceLabel, sig: b4a.toString(sig, 'hex') })
    if (sres.error) throw new Error('session failed: ' + sres.error)
    // verify the token with the panel signing public key (= the account DB core key)
    const payload = verifyToken(db.core.key, sres.token)
    if (!payload) throw new Error('panel returned an invalid session token')
    token = sres.token; expiresAt = sres.expiresAt
  }

  return { streams, ...(vod ? { vod } : {}), token, expiresAt, deviceId: did, tokenVersion: user.tokenVersion }
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
