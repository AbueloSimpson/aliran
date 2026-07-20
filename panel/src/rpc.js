// Panel login RPC handler (shared by src/index.js and the e2e test).
import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { evaluate, powVerify, authVerify, signToken } from '@aliran/core'
import { loadSecrets, saveSecrets } from './store.js'
import { loadPublishers, scopeMatch } from './ops.js'

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
// `enrich` is the optional blobsKey enricher (src/blobs-key.js) nudged by register;
// `legacyPublisher` (default true) keeps accepting UNNAMED register payloads signed
// with the shared keys/publisher.json key — set false (LEGACY_PUBLISHER=0) once every
// broadcaster is enrolled as a named publisher (S26).
export function attachLoginRpc (socket, { keys, oprfKey, difficulty, throttle, db, dataDir, sessionTtlMs = 30 * 86400000, devicePolicy = 'evict', activity = null, enrich = null, legacyPublisher = true }) {
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

  // Broadcaster registers a stream. Authenticated with a publisher key (Ed25519):
  // the broadcaster signs hash(challenge || payload). A payload carrying
  // `publisher:<name>` verifies against THAT enrolled entry's public key
  // (secrets/publishers.json, re-read per register) and its streamId must match the
  // entry's admin-assigned scopes BEFORE any write — the one gate covers the catalog
  // record, the private secrets file and isLive, since this responder writes all
  // three. An unnamed payload falls back to the legacy shared publisher key at
  // implicit scope `*` while `legacyPublisher` is on. The panel then writes the
  // PUBLIC catalog record (no encryptionKey, origin stamped for named publishers)
  // and stores the encryption key in its private secrets file. The catalog write is
  // IDEMPOTENT — a re-register that changes nothing appends nothing to the bee (see
  // the frugality note at the put); the secrets file is written unconditionally,
  // since it is an ordinary rewritten file, not an append-only log.
  rpc.respond('register', async (reqBuf) => {
    if (!db || !dataDir) return json({ error: 'registration unavailable' })
    let req
    try { req = JSON.parse(b4a.toString(reqBuf)) } catch { return json({ error: 'bad request' }) }
    const { payload, sig } = req || {}
    const chal = challenge
    challenge = hcrypto.randomBytes(16) // one-shot
    if (!payload || !payload.streamId || !sig) return json({ error: 'bad request' })

    // Resolve the verifying identity. Reject codes (unknown-publisher | revoked |
    // out-of-scope) surface verbatim through the broadcaster's registerError.
    let origin = null // stamped on the catalog record + activity for named publishers
    let verifyKey = null
    let scopes = null // null = unscoped (legacy implicit `*`)
    if (payload.publisher !== undefined) {
      const name = payload.publisher
      const publishers = loadPublishers(dataDir)
      const entry = typeof name === 'string' && Object.prototype.hasOwnProperty.call(publishers, name) ? publishers[name] : null
      if (!entry || !entry.publicKey) return json({ error: 'unknown-publisher' })
      if ((entry.status || 'active') !== 'active') return json({ error: 'revoked' })
      verifyKey = b4a.from(entry.publicKey, 'hex')
      scopes = entry.scopes || []
      origin = name
    } else {
      // Legacy shared-key path (pre-S26 broadcasters, no `publisher` in the payload).
      if (!legacyPublisher || !keys || !keys.publisher) return json({ error: 'unknown-publisher' })
      verifyKey = keys.publisher.publicKey
    }
    const msg = hcrypto.hash(b4a.concat([chal, b4a.from(JSON.stringify(payload))]))
    if (!authVerify(verifyKey, msg, b4a.from(sig, 'hex'))) return json({ error: 'unauthorized' })
    if (scopes !== null && !scopeMatch(scopes, payload.streamId)) return json({ error: 'out-of-scope' })

    const { streamId, encryptionKey } = payload
    if (encryptionKey) {
      const secrets = loadSecrets(dataDir); secrets[streamId] = encryptionKey; saveSecrets(dataDir, secrets)
    }
    const node = await db.get('catalog/' + streamId)
    const existing = node?.value || {}
    const feedKey = payload.feedKey ?? existing.feedKey ?? null
    // Descriptive metadata is PANEL-authoritative (S27e): the broadcaster is just the
    // stream, not the arbiter of what viewers see. It SEEDS title/description/category
    // only when it first creates a channel; a re-register onto an existing record never
    // touches them again (same admin-owned rule as art / EPG / curation / redirect).
    // To rename or recategorize a P2P channel, edit it in the panel — broadcaster config
    // changes to these fields no longer propagate after creation.
    const seed = node ? {} : payload
    const record = {
      title: seed.title ?? existing.title ?? streamId,
      description: seed.description ?? existing.description ?? '',
      category: seed.category ?? existing.category ?? [],
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
      // the redirect class (S23) is admin-owned too: preserved verbatim. (If a
      // broadcaster registers onto a redirect id the record ends up with both a
      // feedKey and a url; viewers keep playing the url — redirect wins — until an
      // admin resolves the clash.)
      redirect: existing.redirect ?? false,
      url: existing.url ?? null,
      // EPG pointers (S27) are admin-owned metadata too — a re-register must preserve
      // them (a P2P channel can carry an admin-attached program guide).
      epgUrl: existing.epgUrl ?? null,
      epgId: existing.epgId ?? null,
      // Attribution (S26): which enrolled publisher made THIS write. Deliberately
      // not preserved from the previous record — a legacy (unnamed) register is
      // genuinely unattributed, and an audit field must never guess. Clients
      // ignore unknown catalog fields.
      origin,
      status: payload.status ?? (payload.isLive !== false ? 'live' : 'idle')
    }

    // Bee frugality (S29) — same rule as the source sync (src/sources.js): an unchanged
    // re-register is NOT re-put. The broadcaster re-asserts every RUNNING stream on a
    // 5-min heartbeat (HEARTBEAT_MS in broadcaster/src/panel-link.js), so the vast
    // majority of registers restate a record that is already correct — and because the
    // bee is append-only with no compaction, each of those cost a block FOREVER
    // (43 channels = 12,384 needless appends/day ≈ 5.8 MiB/day measured, monotonic).
    // The comparison is sound because every field above is a pure function of the
    // payload and the stored record — no timestamps, no nonces, and the heartbeat
    // re-sends its payload verbatim — so an unchanged re-register rebuilds a
    // byte-identical record. With valueEncoding:'json' the stored block IS
    // JSON.stringify(value), so this compares exactly the bytes a put would append.
    // Anything that genuinely differs still writes: a feedKey rotation, an isLive /
    // status flip, and a change of `origin` — a different publisher taking over the
    // channel is an attribution change the audit trail must record.
    const changed = !node || JSON.stringify(record) !== JSON.stringify(node.value)
    if (changed) await db.put('catalog/' + streamId, record)

    // The activity ring is a 200-entry in-memory feed of NOTEWORTHY events, so a no-op
    // heartbeat stays out of it: at 43 channels those alone would evict the whole ring
    // (admin mutations, viewer sessions) every ~20 min. Liveness is not lost — it is
    // the catalog record's own isLive/status, plus the broadcaster's status API.
    if (activity && changed) activity.record('register', { streamId, isLive: payload.isLive !== false, ...(origin ? { origin } : {}) })
    // Enqueued even when the put was SKIPPED: a stream whose blobsKey never landed
    // (broadcaster offline, or nothing written to the drive yet) parks after maxAttempts
    // and it is precisely this heartbeat that retries it (see src/blobs-key.js).
    if (enrich && feedKey) enrich.enqueue(streamId)
    return json({ ok: true })
  })

  return rpc
}
