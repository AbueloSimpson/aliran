// Panel login RPC handler (shared by src/index.js and the e2e test).
import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { evaluate, powVerify, authVerify, signToken, verifyToken, sessionLive } from '@aliran/core'
import { loadSecrets, saveSecrets } from './store.js'
import { loadPublishers, scopeMatch } from './ops.js'

const json = (o) => b4a.from(JSON.stringify(o))

// Hard cap on a `report` request buffer, enforced BEFORE JSON.parse. A report is the
// only responder a viewer can push arbitrary text into, and JSON.parse on a huge
// buffer is the cheap way to burn the panel's event loop. 16 KiB is ~50× the largest
// legitimate report (300 chars of text + 50 capped events).
const MAX_REPORT_BYTES = 16384

// Decode a client-supplied hex field to a Buffer, or return null when it is absent,
// not a string, or not valid (even-length) hex — optionally pinning the exact decoded
// byte length. EVERY b4a.from(x, 'hex') on an attacker-controlled RPC field MUST go
// through this. b4a.from throws a TypeError when x is a non-string (a JSON object,
// number or boolean in the payload survives JSON.parse); protomux-rpc hands a thrown
// handler error to safety-catch, and safety-catch RETHROWS TypeError/RangeError into a
// microtask — an uncaught exception that crashes the whole panel (there is no
// uncaughtException handler, by design). Returning null lets each responder fail
// closed with a JSON error. Wire-compatible: a real client always sends correct hex.
function hexField (v, bytes) {
  if (typeof v !== 'string') return null
  if (bytes !== undefined ? v.length !== bytes * 2 : (v.length === 0 || (v.length & 1))) return null
  if (!/^[0-9a-fA-F]+$/.test(v)) return null
  return b4a.from(v, 'hex')
}

// Fixed-window rate limiter on OPRF evaluations per (username, peer). The key space is
// attacker-influenced (usernames are arbitrary and peer keys are per-connection), so the
// map is BOUNDED rather than growing forever: once it reaches maxKeys a call first drops
// every entry whose window has already elapsed (those reset on next use anyway) and, if
// still at the cap, evicts the oldest-inserted entries (Map keeps insertion order) down to
// half the cap. Pruning is O(1) amortized (it runs at most once per ~maxKeys/2 inserts),
// needs no timer, and makes a flood of junk usernames unable to exhaust memory. The cap is
// generous — a real deployment never approaches it; only an active flood ever trips it.
export function makeThrottle (threshold, windowSec, { maxKeys = 20000 } = {}) {
  const map = new Map()
  const windowMs = windowSec * 1000
  const throttle = (key) => {
    const now = Date.now()
    if (map.size >= maxKeys) {
      for (const [k, v] of map) if (now - v.windowStart > windowMs) map.delete(k)
      if (map.size >= maxKeys) { const keep = maxKeys >> 1; for (const k of map.keys()) { if (map.size <= keep) break; map.delete(k) } }
    }
    let e = map.get(key)
    if (!e || now - e.windowStart > windowMs) { e = { count: 0, windowStart: now }; map.set(key, e) }
    e.count++
    if (e.count > threshold) return { locked: true, retryAfter: Math.ceil((e.windowStart + windowMs - now) / 1000) }
    return { locked: false }
  }
  // Live key count — exposed (non-enumerable) for observability + the boundedness test.
  Object.defineProperty(throttle, 'size', { get: () => map.size })
  return throttle
}

// Attach `hello` + `login` + `session` responders to a connection. `throttle` is shared
// across connections. `keys` = { oprf, signing }; `db` is the signed account Hyperbee;
// `sessionTtlMs` is the token lifetime; `devicePolicy` is 'evict' (default) or 'reject';
// `activity` is an optional ring (src/activity.js) fed for the observability feed;
// `analytics` is the optional aggregate-only counter set (src/analytics.js, S48) —
// it receives login outcomes as COUNTS (the ok path also passes the username, which
// analytics reduces to an in-memory uniques Set and never stores; the failed path
// deliberately passes nothing);
// `enrich` is the optional blobsKey enricher (src/blobs-key.js) nudged by register;
// `legacyPublisher` (default true) keeps accepting UNNAMED register payloads signed
// with the shared keys/publisher.json key — set false (LEGACY_PUBLISHER=0) once every
// broadcaster is enrolled as a named publisher (S26);
// `reports` is the optional pseudonymous problem-report store (src/reports.js, S50a) —
// omitted (or disabled) means the `report` method simply does not exist, exactly as on
// a pre-S50 panel; `reportThrottle` is its SHARED per-reporter limiter (created once in
// src/index.js so it spans connections — a viewer reconnecting must not reset it);
// `descriptor` is the public service descriptor answered to `describe` (pairing codes)
// — omitted means that method does not exist either.
export function attachLoginRpc (socket, { keys, oprfKey, difficulty, throttle, db, dataDir, sessionTtlMs = 30 * 86400000, devicePolicy = 'evict', activity = null, analytics = null, enrich = null, legacyPublisher = true, reports = null, reportThrottle = null, descriptor = null }) {
  const oprf = oprfKey || (keys && keys.oprf)
  const rpc = new ProtomuxRPC(socket)
  const peerHex = socket.remotePublicKey ? b4a.toString(socket.remotePublicKey, 'hex') : 'anon'
  let challenge = hcrypto.randomBytes(16)
  let sessionChallenge = null // issued in the login response, consumed by `session`

  rpc.respond('hello', () => json({ challenge: b4a.toString(challenge, 'hex'), difficulty }))

  // "Describe yourself" — the answer to a pairing code (see core/pairing.js). A client
  // that joined the pairing topic knows only the 12 characters the viewer typed; this
  // hands back the panel key those characters are an alias for, plus the display name
  // and branding the Connect screen shows while it dials.
  //
  // Deliberately unauthenticated and free of any secret: everything here is public
  // (the panel key is what every viewer replicates the catalog by), it is answered
  // before any login, and it carries NO credentials — the viewer types their own.
  // The client does not trust it either: it re-derives the code from panelPubKey and
  // discards the answer unless the two match, which is what stops a squatter on the
  // topic from substituting its own panel. Constant, so it is built once per boot and
  // this responder cannot be turned into work.
  if (descriptor) rpc.respond('describe', () => json(descriptor))

  rpc.respond('login', (reqBuf) => {
    let req
    try { req = JSON.parse(b4a.toString(reqBuf)) } catch { return json({ error: 'bad request' }) }
    const { username, blinded, powNonce } = req || {}
    const nonce = hexField(powNonce) // null for a missing / non-string / non-hex nonce
    const ok = nonce && powVerify(challenge, nonce, difficulty)
    challenge = hcrypto.randomBytes(16) // rotate → one PoW per attempt
    if (!ok) return json({ error: 'bad proof-of-work' })
    const t = throttle((username || '') + '|' + peerHex)
    if (t.locked) return json({ error: 'locked', retryAfter: t.retryAfter })
    const B = hexField(blinded, 32) // ristretto255 point — exactly 32 bytes
    if (!B) return json({ error: 'bad request' })
    try {
      const evaluated = b4a.toString(evaluate(oprf, B), 'hex')
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
    // Analytics (S48) counts login OUTCOMES here — the session proof is the panel's
    // only honest ok/failed signal (the OPRF stage is oblivious: a wrong password
    // fails on the client). Failed increments carry NO identity on purpose.
    const node = await db.get('user/' + username)
    if (!node) { if (analytics) analytics.loginFailed(); return json({ error: 'unknown user' }) }
    const user = node.value
    if (user.status && user.status !== 'active') { if (analytics) analytics.loginFailed(); return json({ error: 'account disabled' }) }
    const sigBuf = hexField(sig, 64) // Ed25519 signature — 64 bytes
    const authPubBuf = hexField(user.authPub, 32) // Ed25519 public key — 32 bytes
    if (!authPubBuf || !sigBuf || !authVerify(authPubBuf, chal, sigBuf)) {
      if (analytics) analytics.loginFailed()
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
        if (devicePolicy === 'reject') { if (analytics) analytics.loginFailed(); return json({ error: 'device-limit', devices: devices.map((d) => ({ deviceId: d.deviceId, label: d.label })) }) }
        devices.sort((a, b) => (a.issuedAt || 0) - (b.issuedAt || 0))
        devices.shift() // evict oldest
      }
      devices.push({ deviceId, label: deviceLabel || '', issuedAt: now, expiresAt, tokenVersion: user.tokenVersion, status: 'active' })
    }
    user.devices = devices
    await db.put('user/' + username, user)

    const token = signToken(keys.signing.secretKey, { userId: username, deviceId, issuedAt: now, expiresAt, tokenVersion: user.tokenVersion })
    if (activity) activity.record('session', { user: username, deviceId })
    if (analytics) analytics.sessionIssued(username) // reduced to counts — see analytics.js
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
  // and stores the encryption key in its private secrets file. Payloads carry a
  // record class: `type:'vod'` (library titles — durationSec, no isLive) or the
  // default 'live' (see the class note at the record build). The catalog write is
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
    const sigBuf = hexField(sig, 64) // Ed25519 signature — 64 bytes; null on any bad input
    if (!payload || !payload.streamId || !sigBuf) return json({ error: 'bad request' })

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
      verifyKey = hexField(entry.publicKey, 32) // guard a malformed registry entry too
      if (!verifyKey) return json({ error: 'unknown-publisher' })
      scopes = entry.scopes || []
      origin = name
    } else {
      // Legacy shared-key path (pre-S26 broadcasters, no `publisher` in the payload).
      if (!legacyPublisher || !keys || !keys.publisher) return json({ error: 'unknown-publisher' })
      verifyKey = keys.publisher.publicKey
    }
    const msg = hcrypto.hash(b4a.concat([chal, b4a.from(JSON.stringify(payload))]))
    if (!authVerify(verifyKey, msg, sigBuf)) return json({ error: 'unauthorized' })
    if (scopes !== null && !scopeMatch(scopes, payload.streamId)) return json({ error: 'out-of-scope' })

    const { streamId, encryptionKey } = payload
    if (encryptionKey) {
      const secrets = loadSecrets(dataDir); secrets[streamId] = encryptionKey; saveSecrets(dataDir, secrets)
    }
    const node = await db.get('catalog/' + streamId)
    const existing = node?.value || {}
    const feedKey = payload.feedKey ?? existing.feedKey ?? null
    // Record class (S8a): 'vod' — the library's on-demand titles — or 'live' (the
    // default, so pre-S8a broadcasters need no change; unknown types are refused to
    // 'live' rather than written through). The two classes differ in exactly two
    // fields, both handled at their slots below: vod records carry `durationSec` (a
    // media fact the publisher measures at ingest — payload-owned like feedKey, never
    // admin-curated) and NO `isLive` — liveness is not a property a title has, so the
    // field is OMITTED entirely and clients must not read liveness into vod records.
    // Everything else — grant/sealing via the secret stored above, blobsKey
    // enrichment, panel-authoritative descriptive metadata, curation/redirect/EPG
    // preservation, the S29 idempotent put — applies to both classes verbatim.
    const type = payload.type === 'vod' ? 'vod' : 'live'
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
      type,
      protection: payload.protection ?? existing.protection ?? 'self',
      feedKey,
      // blobsKey rides beside the feedKey it belongs to: preserved while the feedKey is
      // unchanged, cleared on rotation. The enricher (src/blobs-key.js) refills it
      // ASYNCHRONOUSLY — a register reply never waits on a drive open. (vod drives
      // enrich identically — a keyless mirror of a title needs the blobs key too.)
      blobsKey: (feedKey && feedKey === existing.feedKey ? existing.blobsKey : null) ?? null,
      // The one class-conditional slot (kept in isLive's position so a live record's
      // key order — and therefore its S29 byte-compare vs pre-S8a records — is
      // unchanged): live carries isLive, vod carries durationSec instead.
      ...(type === 'vod'
        ? { durationSec: Number.isFinite(payload.durationSec) ? payload.durationSec : (existing.durationSec ?? null) }
        : { isLive: payload.isLive !== false }),
      poster: existing.poster ?? null, backdrop: existing.backdrop ?? null, logo: existing.logo ?? null,
      // curation is admin-owned — a re-register must never erase it
      order: existing.order ?? null,
      featured: existing.featured ?? false,
      // access control (parental PIN) is admin-owned too
      restricted: existing.restricted ?? false,
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
      // vod status vocabulary: 'available' (seeding) / 'unavailable' (the library
      // deleted the title — the record itself is admin-owned, so it stays until an
      // admin removes it and its grants in the panel).
      status: payload.status ?? (type === 'vod' ? 'available' : (payload.isLive !== false ? 'live' : 'idle'))
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
    if (activity && changed) activity.record('register', { streamId, ...(type === 'vod' ? { type: 'vod', status: record.status } : { isLive: payload.isLive !== false }), ...(origin ? { origin } : {}) })
    // Enqueued even when the put was SKIPPED: a stream whose blobsKey never landed
    // (broadcaster offline, or nothing written to the drive yet) parks after maxAttempts
    // and it is precisely this heartbeat that retries it (see src/blobs-key.js).
    if (enrich && feedKey) enrich.enqueue(streamId)
    return json({ ok: true })
  })

  // EPG service publishes its guide-drive pointer → meta/epgKey (the epg/ deployable's
  // ONE panel write; see epg/src/register.js). Same challenge-sign convention as
  // `register`, but named-publisher ONLY (no legacy shared-key path — this RPC is
  // newer than enrollment, so nothing legacy can call it) and the entry's scopes must
  // match the pseudo-id `epg`: a guide key must never be able to touch a stream
  // registration, and vice versa. The pointer follows meta/assetsKey (src/store.js) —
  // the `meta/` prefix sorts outside every catalog/ scan range (see the key-ordering
  // notes in src/ops.js). Byte-compared before the put (S29 frugality): the EPG
  // service re-asserts on every boot, and payload fields are stable per epoch, so a
  // re-assert appends nothing — the bee costs ~one block per rotation.
  rpc.respond('setEpgKey', async (reqBuf) => {
    if (!db || !dataDir) return json({ error: 'unavailable' })
    let req
    try { req = JSON.parse(b4a.toString(reqBuf)) } catch { return json({ error: 'bad request' }) }
    const { payload, sig } = req || {}
    const chal = challenge
    challenge = hcrypto.randomBytes(16) // one-shot, same rotation as register
    const sigBuf = hexField(sig, 64)
    if (!payload || !sigBuf) return json({ error: 'bad request' })
    const keyBuf = hexField(payload.key, 32) // the guide drive key — 32 bytes
    if (!keyBuf || !Number.isInteger(payload.epoch) || payload.epoch < 1) return json({ error: 'bad request' })
    // Optional blobs-core key: lets RAW mirrors (the repeater) serve the guide
    // without opening a hyperdrive. Absent/malformed → stored as null, never refused.
    const blobsBuf = hexField(payload.blobsKey, 32)

    const name = payload.publisher
    const publishers = loadPublishers(dataDir)
    const entry = typeof name === 'string' && Object.prototype.hasOwnProperty.call(publishers, name) ? publishers[name] : null
    if (!entry || !entry.publicKey) return json({ error: 'unknown-publisher' })
    if ((entry.status || 'active') !== 'active') return json({ error: 'revoked' })
    const verifyKey = hexField(entry.publicKey, 32)
    if (!verifyKey) return json({ error: 'unknown-publisher' })
    const msg = hcrypto.hash(b4a.concat([chal, b4a.from(JSON.stringify(payload))]))
    if (!authVerify(verifyKey, msg, sigBuf)) return json({ error: 'unauthorized' })
    if (!scopeMatch(entry.scopes || [], 'epg')) return json({ error: 'out-of-scope' })

    // An older epoch never overwrites a newer pointer — two mis-configured EPG
    // services fighting must fail loudly on one side, not flap the fleet's guide.
    const node = await db.get('meta/epgKey')
    const existing = node?.value || null
    if (existing && Number.isInteger(existing.epoch) && payload.epoch < existing.epoch) {
      return json({ error: 'stale-epoch' })
    }
    const record = {
      key: payload.key.toLowerCase(),
      blobsKey: blobsBuf ? payload.blobsKey.toLowerCase() : null,
      epoch: payload.epoch,
      rotatedAt: Number.isFinite(payload.rotatedAt) ? payload.rotatedAt : Date.now(),
      origin: name
    }
    const changed = !existing || JSON.stringify(record) !== JSON.stringify(existing)
    if (changed) await db.put('meta/epgKey', record)
    if (activity && changed) activity.record('epg-key', { epoch: record.epoch, origin: name })
    return json({ ok: true })
  })

  // Viewer problem report (S50a). Attached ONLY when a reports store is enabled —
  // otherwise the method does not exist and a new client gets protomux-rpc's
  // unknown-method error, which it maps to a friendly "unsupported" toast (exactly
  // what it gets from a pre-S50 panel).
  //
  // This is the lowest-priority responder on the socket and the only one a viewer can
  // push free text into, so it is also the most hostile input surface in the panel.
  // The order below is the contract (S50-DESIGN D2/D3) and must not be rearranged:
  //   raw size cap (BEFORE parse) → JSON.parse in a try → typeof-gate EVERY field →
  //   verifyToken + sessionLive → reduce identity to a pseudonym → per-reporter
  //   throttle → ingest (global breaker + storm collapse live in there) → activity.
  // No naked b4a.from / .slice on a client field anywhere: a thrown TypeError here is
  // rethrown by safety-catch into a microtask and kills the whole panel (see hexField).
  if (reports && reports.enabled) {
    // Shared across connections when src/index.js passes one in. The per-connection
    // fallback exists so a test (or an embedder) can attach the responder standalone;
    // it limits a single socket, which is strictly weaker — always pass one in prod.
    const reportLimiter = reportThrottle || makeThrottle(5, 600)
    rpc.respond('report', async (reqBuf) => {
      if (!db || !keys || !keys.signing) return json({ error: 'reports unavailable' })
      if (!reqBuf || typeof reqBuf.length !== 'number' || reqBuf.length > MAX_REPORT_BYTES) return json({ error: 'too large' })
      let req
      try { req = JSON.parse(b4a.toString(reqBuf)) } catch { return json({ error: 'bad request' }) }
      if (!req || typeof req !== 'object' || Array.isArray(req)) return json({ error: 'bad request' })
      // The token is the ONLY identity input. Fields like `username` in the payload
      // are ignored entirely — a viewer cannot report as someone else.
      if (typeof req.token !== 'string' || !req.token) return json({ error: 'unauthorized' })
      let payload = null
      try { payload = verifyToken(keys.signing.publicKey, req.token) } catch { payload = null }
      if (!payload || typeof payload.userId !== 'string' || typeof payload.deviceId !== 'string') return json({ error: 'unauthorized' })
      if (typeof payload.expiresAt === 'number' && Date.now() >= payload.expiresAt) return json({ error: 'expired' })
      // Revocation-aware: a revoked device / bumped tokenVersion / disabled account
      // stops reporting on the very next report.
      let live = false
      try { live = await sessionLive(db, payload) } catch { live = false }
      if (!live) return json({ error: 'unauthorized' })

      // Identity dies here. Nothing below this line has the username or deviceId.
      const reporter = reports.pseudonym(payload.userId, payload.deviceId)
      if (!reporter) return json({ error: 'unauthorized' })
      const t = reportLimiter(reporter)
      if (t.locked) return json({ error: 'locked', retryAfter: t.retryAfter })

      let res
      try {
        res = reports.ingest({
          reporter,
          category: req.category,
          text: req.text,
          channel: req.channel,
          appVersion: req.appVersion,
          platform: req.platform,
          peers: req.peers,
          events: req.events
        })
      } catch { return json({ error: 'ingest failed' }) }
      if (!res || res.ok !== true) return json({ error: (res && res.error) || 'ingest failed' })

      // The activity ring carries WHAT broke, never WHO said so — no user field, and
      // not even the pseudonym (the ring is a human-readable ops feed, not a log of
      // who complains). Shed reports were never persisted, so they never appear.
      if (activity && !res.shed) activity.record('report', { channel: res.channel || null, category: res.category })

      const reply = { ok: true }
      if (res.id) reply.id = res.id
      if (res.count > 1) reply.count = res.count
      if (res.collapsed) reply.collapsed = true
      if (res.shed) reply.shed = true
      if (res.cooldown) reply.cooldown = res.cooldown
      return json(reply)
    })
  }

  return rpc
}
