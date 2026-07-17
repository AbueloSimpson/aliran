// Panel login RPC handler (shared by src/index.js and the e2e test).
import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { evaluate, powVerify, authVerify, signToken } from '@aliran/core'
import { loadSecrets, saveSecrets } from './store.js'

const json = (o) => b4a.from(JSON.stringify(o))

// Fixed-window rate limiter on OPRF evaluations per (username, peer).
export function makeThrottle (threshold, windowSec) {
  const map = new Map()
  return (key) => {
    const now = Date.now()
    let e = map.get(key)
    if (!e || now - e.windowStart > windowSec * 1000) { e = { count: 0, windowStart: now }; map.set(key, e) }
    e.count++
    if (e.count > threshold) return { locked: true, retryAfter: Math.ceil((e.windowStart + windowSec * 1000 - now) / 1000) }
    return { locked: false }
  }
}

// Attach `hello` + `login` + `session` responders to a connection. `throttle` is shared
// across connections. `keys` = { oprf, signing }; `db` is the signed account Hyperbee;
// `sessionTtlMs` is the token lifetime; `devicePolicy` is 'evict' (default) or 'reject';
// `activity` is an optional ring (src/activity.js) fed for the observability feed;
// `enrich` is the optional blobsKey enricher (src/blobs-key.js) nudged by register.
export function attachLoginRpc (socket, { keys, oprfKey, difficulty, throttle, db, dataDir, sessionTtlMs = 30 * 86400000, devicePolicy = 'evict', activity = null, enrich = null }) {
  const oprf = oprfKey || (keys && keys.oprf)
  const rpc = new ProtomuxRPC(socket)
  const peerHex = socket.remotePublicKey ? b4a.toString(socket.remotePublicKey, 'hex') : 'anon'
  let challenge = hcrypto.randomBytes(16)
  let sessionChallenge = null // issued in the login response, consumed by `session`

  rpc.respond('hello', () => json({ challenge: b4a.toString(challenge, 'hex'), difficulty }))

  rpc.respond('login', (reqBuf) => {
    let req
    try { req = JSON.parse(b4a.toString(reqBuf)) } catch { return json({ error: 'bad request' }) }
    const { username, blinded, powNonce } = req || {}
    const ok = powNonce && powVerify(challenge, b4a.from(powNonce, 'hex'), difficulty)
    challenge = hcrypto.randomBytes(16) // rotate → one PoW per attempt
    if (!ok) return json({ error: 'bad proof-of-work' })
    const t = throttle((username || '') + '|' + peerHex)
    if (t.locked) return json({ error: 'locked', retryAfter: t.retryAfter })
    try {
      const evaluated = b4a.toString(evaluate(oprf, b4a.from(blinded, 'hex')), 'hex')
      sessionChallenge = hcrypto.randomBytes(16) // client will sign this to prove login
      return json({ evaluated, sessionChallenge: b4a.toString(sessionChallenge, 'hex') })
    } catch { return json({ error: 'eval failed' }) }
  })

  // Prove login (Ed25519 signature over sessionChallenge) → device-limit enforcement +
  // a panel-signed session token. Requires `db` + `keys.signing`.
  rpc.respond('session', async (reqBuf) => {
    if (!db || !keys || !keys.signing) return json({ error: 'sessions unavailable' })
    let req
    try { req = JSON.parse(b4a.toString(reqBuf)) } catch { return json({ error: 'bad request' }) }
    const { username, deviceId, deviceLabel, sig } = req || {}
    const chal = sessionChallenge
    sessionChallenge = null // one-shot
    if (!chal) return json({ error: 'no session challenge (login first)' })
    const node = await db.get('user/' + username)
    if (!node) return json({ error: 'unknown user' })
    const user = node.value
    if (user.status && user.status !== 'active') return json({ error: 'account disabled' })
    if (!user.authPub || !sig || !authVerify(b4a.from(user.authPub, 'hex'), chal, b4a.from(sig, 'hex'))) {
      return json({ error: 'auth failed' })
    }
    if (!deviceId) return json({ error: 'missing deviceId' })

    const now = Date.now()
    let devices = (user.devices || []).filter((d) => !d.expiresAt || d.expiresAt > now)
    const expiresAt = now + sessionTtlMs
    const existing = devices.find((d) => d.deviceId === deviceId)
    if (existing) {
      existing.expiresAt = expiresAt; existing.tokenVersion = user.tokenVersion
    } else {
      if (devices.length >= (user.maxDevices || 2)) {
        if (devicePolicy === 'reject') return json({ error: 'device-limit', devices: devices.map((d) => ({ deviceId: d.deviceId, label: d.label })) })
        devices.sort((a, b) => (a.issuedAt || 0) - (b.issuedAt || 0))
        devices.shift() // evict oldest
      }
      devices.push({ deviceId, label: deviceLabel || '', issuedAt: now, expiresAt, tokenVersion: user.tokenVersion, status: 'active' })
    }
    user.devices = devices
    await db.put('user/' + username, user)

    const token = signToken(keys.signing.secretKey, { userId: username, deviceId, issuedAt: now, expiresAt, tokenVersion: user.tokenVersion })
    if (activity) activity.record('session', { user: username, deviceId })
    return json({ token, expiresAt, tokenVersion: user.tokenVersion })
  })

  // Broadcaster registers a stream. Authenticated with the publisher key (Ed25519):
  // the broadcaster signs hash(challenge || payload). The panel writes the PUBLIC catalog
  // record (no encryptionKey) and stores the encryption key in its private secrets file.
  rpc.respond('register', async (reqBuf) => {
    if (!db || !keys || !keys.publisher || !dataDir) return json({ error: 'registration unavailable' })
    let req
    try { req = JSON.parse(b4a.toString(reqBuf)) } catch { return json({ error: 'bad request' }) }
    const { payload, sig } = req || {}
    const chal = challenge
    challenge = hcrypto.randomBytes(16) // one-shot
    if (!payload || !payload.streamId || !sig) return json({ error: 'bad request' })
    const msg = hcrypto.hash(b4a.concat([chal, b4a.from(JSON.stringify(payload))]))
    if (!authVerify(keys.publisher.publicKey, msg, b4a.from(sig, 'hex'))) return json({ error: 'unauthorized' })

    const { streamId, encryptionKey } = payload
    if (encryptionKey) {
      const secrets = loadSecrets(dataDir); secrets[streamId] = encryptionKey; saveSecrets(dataDir, secrets)
    }
    const existing = (await db.get('catalog/' + streamId))?.value || {}
    const feedKey = payload.feedKey ?? existing.feedKey ?? null
    await db.put('catalog/' + streamId, {
      title: payload.title ?? existing.title ?? streamId,
      description: payload.description ?? existing.description ?? '',
      category: payload.category ?? existing.category ?? [],
      type: 'live',
      protection: payload.protection ?? existing.protection ?? 'self',
      feedKey,
      // blobsKey rides beside the feedKey it belongs to: preserved while the feedKey is
      // unchanged, cleared on rotation. The enricher (src/blobs-key.js) refills it
      // ASYNCHRONOUSLY — a register reply never waits on a drive open.
      blobsKey: (feedKey && feedKey === existing.feedKey ? existing.blobsKey : null) ?? null,
      isLive: payload.isLive !== false,
      poster: existing.poster ?? null, backdrop: existing.backdrop ?? null, logo: existing.logo ?? null,
      // curation is admin-owned — a re-register must never erase it
      order: existing.order ?? null,
      featured: existing.featured ?? false,
      status: payload.status ?? (payload.isLive !== false ? 'live' : 'idle')
    })
    if (activity) activity.record('register', { streamId, isLive: payload.isLive !== false })
    if (enrich && feedKey) enrich.enqueue(streamId)
    return json({ ok: true })
  })

  return rpc
}
