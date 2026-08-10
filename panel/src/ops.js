// Shared admin operations over the panel store — the single implementation behind
// BOTH the admin CLI (src/admin-cli.js) and the admin HTTP API (src/admin-server.js),
// so the two cannot drift.
//
// Every op takes a `ctx` = { config, keys, db, assets, updates, dataDir }. Ops throw OpsError
// with a `code` ('bad-request' | 'not-found' | 'exists') that callers map to exit
// codes / HTTP statuses. Stream encryption keys stay in the panel-private secrets
// file; admin credentials live in DATA_DIR/secrets/admins.json — neither is ever
// written to the replicated Hyperbee.

import fs from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair
} from '@aliran/core'
import { writeJsonAtomic } from '@aliran/core/atomic-write.js'
import { argonOpts, loadSecrets, saveSecrets } from './store.js'

export class OpsError extends Error {
  constructor (code, message) { super(message); this.code = code }
}
const bad = (m) => { throw new OpsError('bad-request', m) }
const notFound = (m) => { throw new OpsError('not-found', m) }
const exists = (m) => { throw new OpsError('exists', m) }

// ids/usernames end up in Hyperbee keys, asset paths and API URLs — keep them tame.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
export function checkName (name, what) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) bad(`invalid ${what} (allowed: letters, digits, _ . - ; max 64)`)
  return name
}

// ---------------------------------------------------------------- users

// OPRF-enroll a password: derive the record fields shared by create-user and
// set-password. Returns the fresh user keypair so grants can be re-sealed.
function enroll (ctx, password) {
  if (typeof password !== 'string' || password.length < 1) bad('password required')
  const rwd = evaluateFull(ctx.keys.oprf, password)
  const salt = randomSalt()
  const argon = argonOpts(ctx.config)
  const kp = userKeyPair()
  const auth = authKeyPair()
  const wk = wrapKeyFrom(rwd)
  return {
    kp,
    fields: {
      salt: b4a.toString(salt, 'hex'),
      verifier: b4a.toString(deriveVerifier(rwd, salt, argon), 'hex'),
      argon,
      pub: b4a.toString(kp.publicKey, 'hex'),
      encPriv: wrap(wk, kp.secretKey),
      authPub: b4a.toString(auth.publicKey, 'hex'),
      authPrivEnc: wrap(wk, auth.secretKey)
    }
  }
}

export async function createUser (ctx, username, password) {
  checkName(username, 'username')
  if (await ctx.db.get('user/' + username)) exists(`user "${username}" already exists (use set-password to rotate)`)
  const { fields } = enroll(ctx, password)
  const record = {
    ...fields,
    wrapped: {},
    manualGrants: [], // grant provenance (S44): ids granted one-by-one …
    packages: [], // … and assigned bouquets — wrapped = seal(manual ∪ resolved members)
    devices: [],
    tokenVersion: 1,
    maxDevices: ctx.config.maxDevicesDefault,
    status: 'active'
  }
  await ctx.db.put('user/' + username, record)
  return userSummary(username, record)
}

export async function setPassword (ctx, username, password) {
  const user = await requireUser(ctx, username)
  const { kp, fields } = enroll(ctx, password)
  // Re-seal existing grants to the new keypair (the panel holds the stream secrets).
  const secrets = loadSecrets(ctx.dataDir)
  const wrapped = {}
  for (const streamId of Object.keys(user.wrapped || {})) {
    const encKeyHex = secrets[streamId]
    if (encKeyHex) wrapped[streamId] = sealTo(kp.publicKey, b4a.from(encKeyHex, 'hex'))
  }
  Object.assign(user, fields)
  user.wrapped = wrapped
  user.devices = []
  user.tokenVersion = (user.tokenVersion || 1) + 1 // invalidate old sessions
  await ctx.db.put('user/' + username, user)
  return userSummary(username, user)
}

export async function setUserStatus (ctx, username, status) {
  if (status !== 'active' && status !== 'disabled') bad('status must be active|disabled')
  const user = await requireUser(ctx, username)
  user.status = status
  if (status === 'disabled') { // kill live sessions too, not just future logins
    user.devices = []
    user.tokenVersion = (user.tokenVersion || 1) + 1
  }
  await ctx.db.put('user/' + username, user)
  return userSummary(username, user)
}

export async function setMaxDevices (ctx, username, n) {
  const max = parseInt(n, 10)
  if (!Number.isInteger(max) || max < 1 || max > 1000) bad('maxDevices must be an integer >= 1')
  const user = await requireUser(ctx, username)
  user.maxDevices = max
  await ctx.db.put('user/' + username, user)
  return userSummary(username, user)
}

export async function logoutAll (ctx, username) {
  const user = await requireUser(ctx, username)
  user.tokenVersion = (user.tokenVersion || 1) + 1
  user.devices = []
  await ctx.db.put('user/' + username, user)
  return userSummary(username, user)
}

// Provenance updates (S44) deliberately touch manualGrants only when the record
// already HAS the field. A pre-S44 record is migrated in exactly one place —
// packages.js reconcilePackages (panel boot / any package op), which can tell a
// hand-granted id from an autoGrant-source one. Updating a still-unmigrated
// record here stays wrapped-only, and the id is attributed correctly at the next
// reconcile precisely BECAUSE the field is still absent.

export async function grant (ctx, username, streamId) {
  const user = await requireUser(ctx, username)
  const secrets = loadSecrets(ctx.dataDir)
  const encKeyHex = secrets[streamId]
  if (!encKeyHex) notFound(`no secret for stream "${streamId}" (add-stream first)`)
  user.wrapped = user.wrapped || {}
  user.wrapped[streamId] = sealTo(b4a.from(user.pub, 'hex'), b4a.from(encKeyHex, 'hex'))
  if (Array.isArray(user.manualGrants) && !user.manualGrants.includes(streamId)) user.manualGrants.push(streamId)
  await ctx.db.put('user/' + username, user)
  return userSummary(username, user)
}

// NOTE: revoking removes the sealed key from the record, so the user cannot recover
// it on a future login. A client that already unsealed the key may have it cached —
// full revocation of live content requires rotating the stream key.
//
// With packages (S44) this removes the MANUAL entitlement: if one of the user's
// packages still covers the id (or an autoGrant source owns it), the API/CLI
// callers run a per-user package reconcile right after, which re-seals it — the
// user keeps access, now attributed to the package alone.
export async function revoke (ctx, username, streamId) {
  const user = await requireUser(ctx, username)
  if (!user.wrapped || !user.wrapped[streamId]) notFound(`user "${username}" has no grant for "${streamId}"`)
  delete user.wrapped[streamId]
  if (Array.isArray(user.manualGrants)) user.manualGrants = user.manualGrants.filter((id) => id !== streamId)
  await ctx.db.put('user/' + username, user)
  return userSummary(username, user)
}

export async function listDevices (ctx, username) {
  const user = await requireUser(ctx, username)
  const now = Date.now()
  return (user.devices || []).map((d) => ({
    deviceId: d.deviceId,
    label: d.label || '',
    issuedAt: d.issuedAt || null,
    expiresAt: d.expiresAt || null,
    expired: !!(d.expiresAt && d.expiresAt <= now)
  }))
}

// Remove ONE device enrollment without bumping tokenVersion (that would log out
// every device). Cooperative session hygiene: the SDK's online check (sdk
// sessionLive) sees the enrollment is gone and drops to login, but a hostile
// client with a cached token + unsealed keys is unaffected — real access
// revocation is grant revoke + stream-key rotation.
export async function revokeDevice (ctx, username, deviceId) {
  const user = await requireUser(ctx, username)
  const devices = user.devices || []
  const idx = devices.findIndex((d) => d.deviceId === deviceId)
  if (idx < 0) notFound(`user "${username}" has no device "${deviceId}"`)
  devices.splice(idx, 1)
  user.devices = devices
  await ctx.db.put('user/' + username, user)
  return userSummary(username, user)
}

// Deleting a user removes the whole record — and with it every sealed grant and
// device enrollment. Session tokens already issued keep validating OFFLINE until
// they expire (inherent to signed tokens); online checks and future logins fail
// immediately.
export async function deleteUser (ctx, username) {
  await requireUser(ctx, username)
  await ctx.db.del('user/' + username)
  return { username, deleted: true }
}

export async function getUser (ctx, username) {
  return userSummary(username, await requireUser(ctx, username))
}

// Prefix search + cursor paging over user records: `after` is the last username of
// the previous page (exclusive), `next` is the cursor for the following page (null
// on the last one). Prefix-only by design — substring search would be a full scan
// of the replicated Hyperbee.
export async function listUsers (ctx, { prefix = '', after = '', limit = 50 } = {}) {
  if (typeof prefix !== 'string' || typeof after !== 'string') bad('prefix/after must be strings')
  const lim = parseInt(limit, 10)
  if (!Number.isInteger(lim) || lim < 1 || lim > 500) bad('limit must be an integer 1-500')
  const range = { lt: 'user/' + prefix + '\xff' } // usernames are ASCII (NAME_RE), so \xff bounds the prefix
  if (after && after >= prefix) range.gt = 'user/' + after
  else range.gte = 'user/' + prefix
  const users = []
  let next = null
  for await (const { key, value } of ctx.db.createReadStream(range)) {
    if (users.length === lim) { next = users[lim - 1].username; break }
    users.push(userSummary(key.slice('user/'.length), value))
  }
  return { users, next }
}

async function requireUser (ctx, username) {
  checkName(username, 'username')
  const node = await ctx.db.get('user/' + username)
  if (!node) notFound(`no such user: ${username}`)
  return node.value
}

// Public-safe view of a user record: no salt/verifier/wrapped ciphertext blobs.
// `grants` stays the EFFECTIVE list (every wrapped id — what the user can open);
// manualGrants/packages are the provenance split behind it (S44). A record from
// before S44 has no provenance fields yet — reported as all-manual until the
// first reconcile persists the real attribution (which excludes autoGrant-source
// grants); an approximation only ever visible before the upgraded panel's first
// boot reconcile.
export function userSummary (username, u) {
  return {
    username,
    status: u.status || 'active',
    grants: Object.keys(u.wrapped || {}),
    manualGrants: Array.isArray(u.manualGrants) ? u.manualGrants : Object.keys(u.wrapped || {}),
    packages: Array.isArray(u.packages) ? u.packages : [],
    maxDevices: u.maxDevices,
    devices: (u.devices || []).length,
    tokenVersion: u.tokenVersion || 1
  }
}

// ---------------------------------------------------------------- streams

export async function addStream (ctx, id, opts = {}) {
  checkName(id, 'stream id')
  if (await ctx.db.get('catalog/' + id)) exists(`stream "${id}" already exists (use set-meta to edit)`)
  if (opts.key != null && !/^[0-9a-f]{64}$/i.test(opts.key)) bad('key must be 32 bytes hex')
  const url = opts.url != null ? normRedirectUrl(opts.url) : null
  if (opts.redirect != null && normBool(opts.redirect) !== !!url) bad("redirect must match url — pass an https 'url' to create a redirect channel")
  if (url && opts.feedKey) bad('a redirect channel cannot have a feedKey — it plays the url instead of a P2P feed')
  // Playback headers belong TO the url (see normRedirectHeaders): a P2P channel has no
  // request of its own to hang them on, so the pair is refused instead of stored dead.
  const headers = opts.headers != null ? normRedirectHeaders(opts.headers) : null
  if (headers && !url) bad("headers require a redirect url — pass an https 'url', or drop the headers")
  const secrets = loadSecrets(ctx.dataDir)
  const encKeyHex = opts.key || b4a.toString(crypto.randomBytes(32), 'hex')
  secrets[id] = encKeyHex
  saveSecrets(ctx.dataDir, secrets)
  const catalog = {
    title: opts.title || id,
    description: opts.description || '',
    category: normCategory(opts.category),
    type: 'live',
    protection: 'self',
    feedKey: opts.feedKey || null,
    blobsKey: null, // filled asynchronously by the enricher once a feed is live (S20a)
    // Redirect channels (S23) play `url` instead of a P2P feed. No broadcaster
    // heartbeat will ever flip their liveness, so they start live/on by default.
    redirect: !!url,
    url,
    headers: url ? headers : null,
    isLive: !!url,
    poster: null,
    backdrop: null,
    logo: null,
    order: opts.order != null ? normOrder(opts.order) : null,
    featured: normBool(opts.featured),
    // Access control: players treat a restricted channel as parental-PIN-gated
    // by default. Catalog metadata only — entitlements are unaffected.
    restricted: normBool(opts.restricted),
    epgUrl: opts.epgUrl != null ? normEpgUrl(opts.epgUrl) : null, // S27 program-guide pointers (optional)
    epgId: opts.epgId != null ? normEpgId(opts.epgId) : null,
    status: opts.feedKey || url ? 'live' : 'idle'
  }
  await ctx.db.put('catalog/' + id, catalog)
  return { id, catalog, encryptionKey: encKeyHex } // encryptionKey returned ONCE, for the broadcaster
}

const META_FIELDS = ['title', 'description', 'feedKey', 'status']

// Art fields are typed (hybrid art): an 'assets/…' drive path (P2P, written by
// uploadArt) OR an absolute https:// URL served by the operator's own web host.
// https is REQUIRED for remote art — Android blocks cleartext off-loopback, so an
// http:// poster would render on some clients and silently fail on others.
// Empty string clears the field.
export function normArt (v, kind) {
  const s = String(v).trim()
  if (s === '') return null
  if (s.length > 1024) bad(kind + ' must be at most 1024 characters')
  if (/[\r\n]/.test(s)) bad(kind + ' must not contain line breaks')
  if (/^assets\//.test(s)) return s
  if (/^https:\/\/./i.test(s)) return s
  bad(kind + " must be an 'assets/…' drive path or an https:// URL")
}

// A redirect channel's playback URL: an absolute https:// URL delivered to viewers
// INSTEAD of a P2P feed (the channel has no broadcaster). https is REQUIRED for the
// same reason as remote art; deliberately NO file-extension requirement — tokenized
// CDN URLs carry query strings. Empty string clears (the entry stops being a
// redirect channel).
//
// One carve-out by default, mirroring normSourceUrl (sources.js): plain http on
// LOOPBACK. The Android-cleartext rule that makes https mandatory everywhere else does
// not reach 127.0.0.1 — the SDK already serves its own HLS over http on localhost by
// design — and without it a local provider stub cannot be imported end-to-end, which is
// the only way to prove the header path really carries playback.
//
// The SECOND carve-out is opt-in and SOURCE-SCOPED: `allowCleartext` lets a provider the
// operator has explicitly trusted (sources.js, per-source flag) import http entries on
// ANY host — the exemption the operator turns on to take a provider that serves some
// events over cleartext http. It is NEVER fleet-wide: addStream/setMeta call this with no
// options, so the default (allowCleartext=false) keeps every MANUAL redirect channel
// https-or-loopback-only, exactly as before. Only sources.js, and only for a source that
// carries the flag, passes { allowCleartext:true }. Cleartext still only PLAYS where the
// client permits it (the phone/TV app's network-security posture) — this validator only
// governs what the panel is willing to STORE.
export function normRedirectUrl (v, { allowCleartext = false } = {}) {
  const s = String(v).trim()
  if (s === '') return null
  if (s.length > 2048) bad('url must be at most 2048 characters')
  if (/[\r\n]/.test(s)) bad('url must not contain line breaks')
  if (/^https:\/\/./i.test(s)) return s
  if (/^http:\/\/./i.test(s)) {
    if (allowCleartext) return s // source-scoped opt-in: any http host is accepted
    let u
    try { u = new URL(s) } catch { u = null }
    if (u && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]')) return s
  }
  bad('url must be an https:// URL (plain http:// is allowed only on loopback, for local testing)')
}

// Playback request headers for a redirect channel: the Referer / Origin / User-Agent
// a hotlink-protected provider checks before it serves the url. The HOST PLAYER sends
// them (the desktop app injects them in its main process, the phone hands them to
// ExoPlayer) — the P2P path has nothing to send them with, so a record with headers
// and no url is refused at every call site instead of being stored as dead weight.
//
// The key list is a strict ALLOWLIST rather than a filter. These three are exactly the
// forbidden headers a player cannot set for itself, which is the whole reason the
// catalog has to carry them; an open map would let anyone with catalog write access
// smuggle an Authorization or Cookie header into every viewer's player. `referrer`
// (the correctly spelled variant of the famously misspelled header) is accepted and
// folded onto `referer`, and keys are stored lowercase so the record has ONE canonical
// shape to compare, inject and byte-compare.
//
// Trust boundary: FEED DATA passes through here too — sources.js applies it one key at
// a time so a single broken #EXTVLCOPT line degrades to a missing header instead of
// dropping the event — so the value rules match every other free-text catalog field:
// length capped, no CR/LF (header injection) and no other control characters.
//
// An EMPTY value is SKIPPED rather than refused, deliberately: the admin dialogs always
// send all three keys and leave the unused ones blank, so "" has to mean "not set", or
// filling in one header would be an error about the other two.
const REDIRECT_HEADER_KEYS = {
  referer: 'referer',
  referrer: 'referer',
  origin: 'origin',
  'user-agent': 'user-agent'
}
export function normRedirectHeaders (v) {
  if (v == null || v === '') return null
  if (typeof v !== 'object' || Array.isArray(v)) bad('headers must be an object, e.g. {"referer":"https://provider.example/"}')
  const out = {}
  for (const [rawKey, rawVal] of Object.entries(v)) {
    const key = REDIRECT_HEADER_KEYS[String(rawKey).trim().toLowerCase()]
    if (!key) bad(`unknown header "${rawKey}" — headers may only set referer, origin and user-agent (the forbidden headers a player cannot set itself)`)
    const s = String(rawVal ?? '').trim()
    if (s === '') continue // an empty value is "not set" — never a header with no value
    if (s.length > 1024) bad(`headers.${key} must be at most 1024 characters`)
    if (/[\r\n]/.test(s)) bad(`headers.${key} must not contain line breaks`)
    if (/[\u0000-\u001f\u007f]/.test(s)) bad(`headers.${key} must not contain control characters`)
    out[key] = s
  }
  return Object.keys(out).length ? out : null // an empty object is never stored — null IS "no headers"
}

// EPG feed URL: a public https JSON of channels+schedules the CLIENT fetches (never
// the panel), so https is required for the same Android-cleartext reason as art.
// Empty clears. EXPORTED because a source can put this field on every channel it imports
// (sources.js): it is one catalog field, so it gets one rule, whoever writes it.
export function normEpgUrl (v) {
  const s = String(v ?? '').trim()
  if (s === '') return null
  if (s.length > 2048) bad('epgUrl must be at most 2048 characters')
  if (/[\r\n]/.test(s)) bad('epgUrl must not contain line breaks')
  if (!/^https:\/\/./i.test(s)) bad('epgUrl must be an https:// URL')
  return s
}

// This channel's id inside the epgUrl feed (matches a feed `channels[].id`). A free
// string — the feed's id space is the provider's, not our stream-id charset. Empty clears.
function normEpgId (v) {
  const s = String(v ?? '').trim()
  if (s === '') return null
  if (s.length > 128) bad('epgId must be at most 128 characters')
  if (/[\r\n]/.test(s)) bad('epgId must not contain line breaks')
  return s
}

export async function setMeta (ctx, id, fields = {}) {
  const c = await requireStream(ctx, id)
  const prevFeedKey = c.feedKey
  for (const f of META_FIELDS) {
    if (fields[f] != null) c[f] = String(fields[f])
  }
  // blobsKey belongs to the feedKey beside it — an admin feedKey edit invalidates it
  // (the enricher re-fills it on the next register/sweep of the real feed).
  if (fields.feedKey != null && c.feedKey !== prevFeedKey) c.blobsKey = null
  for (const kind of ART_KINDS) {
    if (fields[kind] != null) c[kind] = normArt(fields[kind], kind)
  }
  if (fields.category != null) c.category = normCategory(fields.category)
  if (fields.isLive != null) c.isLive = normBool(fields.isLive)
  if (fields.order !== undefined) c.order = normOrder(fields.order) // null clears
  if (fields.featured != null) c.featured = normBool(fields.featured)
  if (fields.restricted != null) c.restricted = normBool(fields.restricted)
  // EPG pointers (S27): a public https feed URL + this channel's id inside it. The app
  // fetches the guide on demand; the schedule never enters the catalog. Works on ANY
  // channel (P2P or redirect) — sources set these automatically on imported channels.
  // Empty string clears. epgUrl without epgId (or vice versa) yields no guide, so both
  // matter; we validate independently and let the client require both.
  if (fields.epgUrl !== undefined) c.epgUrl = normEpgUrl(fields.epgUrl)
  if (fields.epgId !== undefined) c.epgId = normEpgId(fields.epgId)
  // Playback headers for the redirect url (S23 + hotlink-protected providers). null or
  // an empty object clears. Set BEFORE the url block below on purpose: a request that
  // clears the url in the same call must end with no headers, whatever order the fields
  // arrived in — stale provider headers must not survive a redirect→P2P conversion.
  if (fields.headers !== undefined) c.headers = normRedirectHeaders(fields.headers)
  // Redirect channels (S23): `url` drives the pair atomically — a non-empty https URL
  // makes the entry a redirect channel (liveness defaults on, unless set explicitly in
  // the same request); an empty string clears both (liveness defaults off — a feedless
  // non-redirect entry has nothing to play). A bare `redirect` field is only accepted
  // when consistent, so the two can never disagree in the record.
  if (fields.url !== undefined || fields.redirect !== undefined) {
    const url = fields.url !== undefined ? normRedirectUrl(fields.url) : (c.url ?? null)
    if (fields.redirect != null && normBool(fields.redirect) !== !!url) {
      bad("redirect must match url — set an https 'url' to make a redirect channel, an empty one to clear")
    }
    c.redirect = !!url
    c.url = url
    if (!url) c.headers = null // no url, nothing to send headers with
    if (fields.url !== undefined) {
      if (fields.isLive == null) c.isLive = !!url
      if (fields.status == null) c.status = url ? 'live' : 'idle'
    }
  }
  // Catches headers-set-on-a-P2P-channel whichever order the fields came in (headers
  // alone on a feed channel, or headers plus a url that another rule already refused).
  if (c.headers && !c.url) bad("headers require a redirect url — set an https 'url' first, or clear the headers")
  if (c.redirect && c.feedKey) bad('a redirect channel cannot have a feedKey — clear the url or the feedKey first')
  await ctx.db.put('catalog/' + id, c)
  return { id, catalog: c }
}

// FULL purge of a stream: its art files, every user's sealed grant, the
// panel-private secret, and finally the catalog record. Clients converge on the
// next catalog push (their display list is grants ∩ catalog). A client that
// already unsealed the key may have it cached — real revocation of live content
// is a key rotation — and re-adding the id later mints a FRESH key.
export async function deleteStream (ctx, id) {
  await requireStream(ctx, id)
  try {
    for await (const entry of ctx.assets.list('/' + id + '/')) await ctx.assets.del(entry.key)
  } catch {} // an empty/never-used assets drive must not block the purge
  let grantsRevoked = 0
  for await (const { key, value } of ctx.db.createReadStream({ gt: 'user/', lt: 'user0' })) {
    const hadWrapped = value.wrapped && value.wrapped[id] !== undefined
    const hadManual = Array.isArray(value.manualGrants) && value.manualGrants.includes(id)
    if (hadWrapped || hadManual) {
      if (hadWrapped) delete value.wrapped[id]
      if (hadManual) value.manualGrants = value.manualGrants.filter((g) => g !== id) // provenance dies with the stream
      await ctx.db.put(key, value)
      if (hadWrapped) grantsRevoked++
    }
  }
  const secrets = loadSecrets(ctx.dataDir)
  if (secrets[id] !== undefined) { delete secrets[id]; saveSecrets(ctx.dataDir, secrets) }
  await ctx.db.del('catalog/' + id)
  return { id, deleted: true, grantsRevoked }
}

export const ART_KINDS = ['poster', 'backdrop', 'logo']
const ART_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bin']

export async function uploadArt (ctx, id, kind, data, ext = '.bin') {
  if (!ART_KINDS.includes(kind)) bad('kind must be ' + ART_KINDS.join('|'))
  if (!ART_EXTS.includes(ext)) bad('unsupported art extension: ' + ext)
  if (!b4a.isBuffer(data) || data.length === 0) bad('empty art payload')
  const c = await requireStream(ctx, id)
  const p = `/${id}/${kind}${ext}`
  await ctx.assets.put(p, data)
  c[kind] = 'assets' + p
  await ctx.db.put('catalog/' + id, c)
  return { id, [kind]: c[kind], bytes: data.length }
}

export async function listStreams (ctx) {
  const out = []
  for await (const { key, value } of ctx.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    out.push({ id: key.slice('catalog/'.length), ...value })
  }
  return out
}

async function requireStream (ctx, id) {
  checkName(id, 'stream id')
  const node = await ctx.db.get('catalog/' + id)
  if (!node) notFound(`no such stream: ${id}`)
  return node.value
}

// ---------------------------------------------------------------- app updates (OTA)
//
// The panel-owned "updates" Hyperdrive (store.js, advertised as meta/updatesKey =
// { key, blobsKey }) carries the app installers viewer apps download over P2P:
//   /manifest.json                       { [appId]: entry } — ONE entry per app id
//   /pkg/<appId>-<versionCode>.<apk|exe> the artifact blobs
// entry = { platform, versionCode, versionName, sha256, size, file,
//           minVersionCode?, notes?, releasedAt }
// The drive is world-readable to anyone holding the panel key — internal/dev builds
// must NEVER be published through it (admin-ui + docs repeat this).

export const UPDATE_PLATFORMS = { android: '.apk', windows: '.exe' }
const UPDATE_MANIFEST = '/manifest.json'
// Android applicationIds and the desktop app id are dot-separated reverse-DNS names;
// no '-' allowed, so '<appId>-<versionCode>' stays unambiguous in artifact paths.
const UPDATE_APPID_RE = /^[a-z][a-z0-9_.]{2,254}$/i

// Validates the addressing triple and derives the artifact path. Exported so the
// admin server can refuse a bad request BEFORE it opens a drive write stream.
export function updateTarget (appId, platform, versionCode) {
  if (typeof appId !== 'string' || !UPDATE_APPID_RE.test(appId)) bad('invalid app id (allowed: letters, digits, _ . ; 3-255 chars, starts with a letter)')
  if (!UPDATE_PLATFORMS[platform]) bad('platform must be ' + Object.keys(UPDATE_PLATFORMS).join('|'))
  const vc = Number(versionCode)
  if (!Number.isInteger(vc) || vc < 1) bad('versionCode must be an integer >= 1')
  return { appId, platform, versionCode: vc, file: `/pkg/${appId}-${vc}${UPDATE_PLATFORMS[platform]}` }
}

// Manifest writes are read-modify-write over one drive file — two interleaved
// publishes would drop an entry, so every mutation runs through this chain
// (uploadArt has no such hazard: a single put per call).
let updatesChain = Promise.resolve()
function serializeUpdates (fn) {
  const run = updatesChain.then(fn)
  updatesChain = run.then(() => {}, () => {})
  return run
}

async function readUpdateManifest (drive) {
  const buf = await drive.get(UPDATE_MANIFEST)
  if (!buf) return {}
  // Written only by the ops below — a parse failure is real corruption; surface it.
  return JSON.parse(b4a.toString(buf))
}

const appIdArtifactRe = (appId) => new RegExp('^/pkg/' + appId.replace(/\./g, '\\.') + '-(\\d+)\\.[a-z0-9]+$')

// The metadata half of the publish validation — everything except sha256/size,
// which only exist once the artifact has streamed. Shared by precheckUpdate (the
// fail-fast pass BEFORE any byte lands) and putUpdate (the authoritative one).
function validateUpdateMeta (t, meta) {
  const versionName = typeof meta.versionName === 'string' ? meta.versionName.trim() : ''
  if (!versionName || versionName.length > 64 || /[\r\n]/.test(versionName)) bad('versionName is required (max 64 characters, one line)')
  let minVersionCode
  if (meta.minVersionCode !== undefined && meta.minVersionCode !== null && meta.minVersionCode !== '') {
    minVersionCode = Number(meta.minVersionCode)
    if (!Number.isInteger(minVersionCode) || minVersionCode < 1) bad('minVersionCode must be an integer >= 1')
    // Above the shipped versionCode, even a freshly updated install would sit below
    // the floor — every device banner-locked forever, including the newest build.
    if (minVersionCode > t.versionCode) bad('minVersionCode must not exceed versionCode')
  }
  let notes
  if (meta.notes !== undefined && meta.notes !== null && String(meta.notes).length > 0) {
    notes = String(meta.notes)
    if (notes.length > 2000) bad('notes must be at most 2000 characters')
  }
  return { versionName, minVersionCode, notes }
}

// The manifest half: platform is sticky per app id, and versionCode must move
// forward unless the operator forces a republish.
function checkAgainstManifest (manifest, t, force) {
  const existing = manifest[t.appId]
  if (existing && existing.platform !== t.platform) bad(`app "${t.appId}" is published for ${existing.platform} — delete the entry before republishing for ${t.platform}`)
  if (existing && t.versionCode <= existing.versionCode && !force) {
    bad(`versionCode ${t.versionCode} does not exceed the published ${existing.versionCode} (pass force to republish)`)
  }
}

// Fail-fast publish gate for the admin server, run BEFORE the artifact stream is
// opened. This matters beyond latency: without force, the target path can be the
// very file the live manifest references (a same-versionCode re-upload) — refusing
// here means the stream never overwrites a published artifact, and the abort
// cleanup never has one to destroy. putUpdate re-checks all of it under the
// serialization lock; this pass is advisory, that one is authoritative.
export function precheckUpdate (ctx, appId, meta = {}) {
  return serializeUpdates(async () => {
    const t = updateTarget(appId, meta.platform, meta.versionCode)
    validateUpdateMeta(t, meta)
    checkAgainstManifest(await readUpdateManifest(ctx.updates), t, meta.force)
    return t
  })
}

// Disk bound: per app id keep the artifact the manifest references plus the newest
// other one (a rollback cushion); everything else is cleared out of the blobs core
// AND dropped from the drive — del alone would keep the bytes. keepFile (the entry
// just written) is protected UNCONDITIONALLY: a forced downgrade publishes a
// versionCode below files already on disk, and a plain two-highest-vc rule would
// delete the exact artifact the manifest now points at.
async function pruneUpdateArtifacts (drive, appId, keepFile) {
  const re = appIdArtifactRe(appId)
  const files = []
  for await (const entry of drive.list('/pkg/')) {
    const m = re.exec(entry.key)
    if (m) files.push({ key: entry.key, vc: parseInt(m[1], 10) })
  }
  files.sort((a, b) => b.vc - a.vc)
  const keep = new Set([keepFile])
  for (const f of files) {
    if (keep.size >= 2) break
    keep.add(f.key)
  }
  const removed = []
  for (const f of files) {
    if (keep.has(f.key)) continue
    try { await drive.clear(f.key) } catch {}
    await drive.del(f.key)
    removed.push(f.key)
  }
  return removed
}

// meta = { platform, versionCode, versionName, sha256, size, minVersionCode?, notes?,
// force? }. sha256/size come from the server-side stream hash, never from the client.
export function putUpdate (ctx, appId, meta = {}) {
  return serializeUpdates(async () => {
    const t = updateTarget(appId, meta.platform, meta.versionCode)
    const { versionName, minVersionCode, notes } = validateUpdateMeta(t, meta)
    if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) bad('sha256 must be 64 hex characters')
    const size = Number(meta.size)
    if (!Number.isInteger(size) || size < 1) bad('size must be an integer >= 1')
    const manifest = await readUpdateManifest(ctx.updates)
    checkAgainstManifest(manifest, t, meta.force)
    const entry = {
      platform: t.platform,
      versionCode: t.versionCode,
      versionName,
      sha256: meta.sha256,
      size,
      file: t.file,
      ...(minVersionCode !== undefined ? { minVersionCode } : {}),
      ...(notes !== undefined ? { notes } : {}),
      releasedAt: new Date().toISOString()
    }
    manifest[t.appId] = entry
    await ctx.updates.put(UPDATE_MANIFEST, b4a.from(JSON.stringify(manifest)))
    const pruned = await pruneUpdateArtifacts(ctx.updates, t.appId, t.file)
    return { appId: t.appId, entry, pruned }
  })
}

export function listUpdates (ctx) {
  return serializeUpdates(() => readUpdateManifest(ctx.updates))
}

export function deleteUpdate (ctx, appId) {
  return serializeUpdates(async () => {
    if (typeof appId !== 'string' || !UPDATE_APPID_RE.test(appId)) bad('invalid app id')
    const manifest = await readUpdateManifest(ctx.updates)
    if (!manifest[appId]) notFound(`no update entry for "${appId}"`)
    delete manifest[appId]
    await ctx.updates.put(UPDATE_MANIFEST, b4a.from(JSON.stringify(manifest)))
    const re = appIdArtifactRe(appId)
    let filesRemoved = 0
    for await (const entry of ctx.updates.list('/pkg/')) {
      if (!re.test(entry.key)) continue
      try { await ctx.updates.clear(entry.key) } catch {}
      await ctx.updates.del(entry.key)
      filesRemoved++
    }
    return { appId, deleted: true, filesRemoved }
  })
}

// Abort-path cleanup for the streaming upload (admin-server.js): reclaim the blob
// and drop the entry. Never throws — cleanup must not mask the original failure.
// GUARD: a file the CURRENT manifest references is never touched. Cleanup runs on
// paths a failed publish streamed to, and with force (or a lost race) that path can
// be the live artifact — deleting it would leave the fleet a manifest entry it can
// never download. Unreadable manifest = cannot prove it is safe = leak, not delete.
export async function discardUpdateArtifact (ctx, file) {
  let manifest
  try { manifest = await readUpdateManifest(ctx.updates) } catch { return }
  for (const e of Object.values(manifest)) if (e && e.file === file) return
  try { await ctx.updates.clear(file) } catch {}
  try { await ctx.updates.del(file) } catch {}
}

// ---------------------------------------------------------------- categories
//
// Categories live ON each catalog record as a plain string array
// (`category: ['Nacional/Norte']`) and that STAYS the wire format — the RN app and the
// SDK read those strings, so nothing in here needs a client change. What was missing is
// a VOCABULARY: no list of which categories exist, no ordering, no hierarchy, and a
// rename meant editing every channel by hand.
//
// `catmeta/<slug>` adds that vocabulary without touching the wire format. It owns only
// PRESENTATION (label / parent / order / hidden). MEMBERSHIP — which channels carry a
// category — stays on the catalog records, which is exactly what an S27 source rewrites
// on every sync. The two can never fight, because they write different keys: a provider
// feed stays authoritative over who is in its rail, the operator over how it looks.
//
// ⚠ KEY ORDERING: every catalog scan is bounded `gt:'catalog/' lt:'catalog0'`, and
// 'catmeta/' sorts ABOVE 'catalog0' (compare position 3: 'a' < 'm'), so this keyspace is
// invisible to all of them. That was verified before adding it — if you ever rename the
// prefix, re-check it does not land BETWEEN those bounds or listStreams starts returning
// categories as if they were channels.

const CAT_MAX = 64

// Mirrors sources.js normCategoryLabel, plus the hierarchy rules: two-level rails
// (S27h/i) encode parent/child as 'Parent/Child', so a slug must not start with, end
// with, or double up the separator, or the tree cannot be parsed back out.
// (Exported for packages.js — a `category:<slug>` member is validated with the
// same vocabulary rules.)
export function normSlug (s, what = 'category') {
  const v = s == null ? '' : String(s).trim()
  if (!v) bad(`${what} is required`)
  if (v.length > CAT_MAX) bad(`${what} must be at most ${CAT_MAX} characters`)
  if (/[\r\n]/.test(v)) bad(`${what} must not contain line breaks`)
  if (v.startsWith('/') || v.endsWith('/') || v.includes('//')) bad(`${what} must not start, end or double up on "/"`)
  if (v.split('/').length > 2) bad(`${what} supports at most two levels (Parent/Child)`)
  return v
}

const parentOf = (slug) => (slug.includes('/') ? slug.slice(0, slug.indexOf('/')) : null)
// Renaming 'Nacional' has to carry 'Nacional/Norte' with it or the children orphan.
const isSelfOrChild = (slug, root) => slug === root || slug.startsWith(root + '/')
const reslug = (slug, from, to) => (slug === from ? to : to + slug.slice(from.length))

// Union of the registry and what the catalog ACTUALLY uses: a category in use but never
// registered still has to appear, or an operator cannot manage what is really there.
export async function listCategories (ctx) {
  const reg = new Map()
  for await (const { key, value } of ctx.db.createReadStream({ gt: 'catmeta/', lt: 'catmeta0' })) {
    reg.set(key.slice('catmeta/'.length), value)
  }
  const counts = new Map()
  for await (const { value } of ctx.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    for (const c of value.category || []) counts.set(c, (counts.get(c) || 0) + 1)
  }
  return [...new Set([...reg.keys(), ...counts.keys()])].sort().map((slug) => {
    const m = reg.get(slug) || {}
    return {
      slug,
      label: m.label ?? slug,
      parent: m.parent ?? parentOf(slug),
      order: m.order ?? null,
      hidden: !!m.hidden,
      ownedBy: m.ownedBy ?? null,
      channels: counts.get(slug) || 0,
      registered: reg.has(slug)
    }
  })
}

export async function upsertCategory (ctx, slug, fields = {}) {
  const s = normSlug(slug)
  const node = await ctx.db.get('catmeta/' + s)
  const cur = node ? node.value : {}
  const next = {
    label: fields.label != null ? String(fields.label).trim().slice(0, CAT_MAX) : (cur.label ?? s),
    parent: parentOf(s),
    order: fields.order !== undefined ? normOrder(fields.order) : (cur.order ?? null),
    hidden: fields.hidden !== undefined ? normBool(fields.hidden) : !!cur.hidden,
    ownedBy: fields.ownedBy != null ? String(fields.ownedBy) : (cur.ownedBy ?? 'operator')
  }
  // S29 idempotency (rpc.js, 5312fbd): the bee is append-only with no compaction, so a
  // no-op write is pure growth. Compare before putting.
  if (!node || JSON.stringify(next) !== JSON.stringify(cur)) await ctx.db.put('catmeta/' + s, next)
  return { slug: s, ...next }
}

// Registry entry only — channels KEEP their membership. Deleting a label must never
// silently untag content; use rename/merge to move channels.
export async function deleteCategory (ctx, slug) {
  const s = normSlug(slug)
  const node = await ctx.db.get('catmeta/' + s)
  if (!node) notFound(`no such category: ${s}`)
  await ctx.db.del('catmeta/' + s)
  return { slug: s, deleted: true }
}

// Rewrites membership across the catalog AND carries the registry entries (root plus
// children) over. Every put is idempotency-gated, so a no-op rename costs zero appends.
export async function renameCategory (ctx, from, to) {
  const a = normSlug(from, 'from')
  const b = normSlug(to, 'to')
  if (a === b) return { from: a, to: b, channels: 0, registry: 0 }
  let channels = 0
  for await (const { key, value } of ctx.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    const cats = value.category || []
    if (!cats.some((c) => isSelfOrChild(c, a))) continue
    const next = []
    for (const c of cats) {
      const n = isSelfOrChild(c, a) ? reslug(c, a, b) : c
      if (!next.includes(n)) next.push(n) // a rename can collide with a tag already there
    }
    const rec = { ...value, category: next }
    if (JSON.stringify(rec) === JSON.stringify(value)) continue
    await ctx.db.put(key, rec)
    channels++
  }
  const moves = []
  for await (const { key, value } of ctx.db.createReadStream({ gt: 'catmeta/', lt: 'catmeta0' })) {
    const slug = key.slice('catmeta/'.length)
    if (isSelfOrChild(slug, a)) moves.push([slug, reslug(slug, a, b), value])
  }
  for (const [oldSlug, newSlug, value] of moves) {
    await ctx.db.del('catmeta/' + oldSlug)
    // A label that was just the slug follows the rename; a hand-written one is kept.
    await ctx.db.put('catmeta/' + newSlug, {
      ...value,
      parent: parentOf(newSlug),
      label: value.label === oldSlug ? newSlug : value.label
    })
  }
  return { from: a, to: b, channels, registry: moves.length }
}

export async function mergeCategories (ctx, from, to) {
  const list = [...new Set((Array.isArray(from) ? from : [from]).map((f) => normSlug(f, 'from')))]
  const target = normSlug(to, 'to')
  let channels = 0
  for await (const { key, value } of ctx.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    const cats = value.category || []
    if (!cats.some((c) => list.includes(c))) continue
    const next = []
    for (const c of cats) {
      const n = list.includes(c) ? target : c
      if (!next.includes(n)) next.push(n)
    }
    const rec = { ...value, category: next }
    if (JSON.stringify(rec) === JSON.stringify(value)) continue
    await ctx.db.put(key, rec)
    channels++
  }
  let registry = 0
  for (const f of list) {
    if (f === target) continue
    if (await ctx.db.get('catmeta/' + f)) { await ctx.db.del('catmeta/' + f); registry++ }
  }
  return { from: list, to: target, channels, registry }
}

function normCategory (cat) {
  if (cat == null) return []
  if (Array.isArray(cat)) return cat.map(String)
  return [String(cat)]
}

// Curation hints for client UIs (rail sort / hero pick). order is nullable.
function normOrder (v) {
  if (v === null || v === '' || v === 'null') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 9999) bad('order must be an integer 0-9999, or null to clear')
  return n
}

const normBool = (v) => v === true || /^(1|true|yes)$/i.test(String(v))

// ---------------------------------------------------------------- VOD provider (S53)
//
// `svcmeta/vod` — ONE replicated record describing an EXTERNAL VOD provider that the
// END-USER CLIENT calls DIRECTLY. The panel never proxies provider calls or media: it
// owns the SWITCH (`enabled`) and the COORDINATES (apiBase / service / per-kind source
// values / extra query params), and the apps read the record at login. Nothing in here
// is a secret — a viewer reaches the provider with their OWN account, so no viewer
// credential is ever stored panel-side for this feature.
//
// ⚠ KEY ORDERING, same discipline as catmeta/: every catalog scan is bounded
// `gt:'catalog/' lt:'catalog0'` and every category scan `gt:'catmeta/' lt:'catmeta0'`.
// 'svcmeta/' sorts ABOVE both ranges ('s' > 'c'), so this keyspace is invisible to all
// of them. Re-check that before renaming the prefix.
//
// Config changes apply at the viewer's NEXT login (the record is read there, not
// watched) — the dashboard and the docs say so.

const VOD_KEY = 'svcmeta/vod'
const VOD_TEXT_MAX = 128
const VOD_PARAM_KEY_RE = /^[a-z0-9_]{1,32}$/i
const VOD_PARAMS_MAX = 16
// `movies` and `series` (S54a — the provider answers BOTH lists from one movies-style
// endpoint, so a series source is just a second source value the apps pass through).
// An unknown key is still REFUSED rather than stored, so a typo can never sit silently
// in the record pretending to be a feature.
const VOD_SOURCE_KINDS = ['movies', 'series']

// The provider's API root. https is required for the same reason as remote art and
// redirect URLs — Android blocks cleartext, and the CLIENT is the one fetching it.
// No query string (per-call params belong in `params`, which the client composes) and
// no userinfo (credentials in a URL would land in the replicated record, in logs and
// in every client's memory). Trailing slashes are stripped so `${apiBase}/getMovies.php`
// is deterministic on every client copy. Empty string = unset.
export function normVodApiBase (v) {
  const s = String(v ?? '').trim()
  if (s === '') return ''
  if (s.length > 2048) bad('apiBase must be at most 2048 characters')
  if (/[\r\n]/.test(s)) bad('apiBase must not contain line breaks')
  let u
  try { u = new URL(s) } catch { bad('apiBase must be an absolute https:// URL') }
  if (u.protocol !== 'https:') bad('apiBase must be an https:// URL (the apps block cleartext)')
  if (u.username || u.password) bad('apiBase must not embed credentials (no user:pass@host)')
  if (u.search || s.includes('?')) bad('apiBase must not carry a query string — put extra query params in `params`')
  if (u.hash || s.includes('#')) bad('apiBase must not carry a fragment')
  return s.replace(/\/+$/, '')
}

function normVodText (v, what) {
  const s = String(v ?? '').trim()
  if (s.length > VOD_TEXT_MAX) bad(`${what} must be at most ${VOD_TEXT_MAX} characters`)
  if (/[\r\n]/.test(s)) bad(`${what} must not contain line breaks`)
  return s
}

// Per-kind source values (`{movies:'movies_hd'}`). Supplying `sources` REPLACES the
// whole map — that is the only way to clear a kind, and the map is two entries at most.
function normVodSources (v) {
  if (v == null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) bad('sources must be an object, e.g. {"movies":"movies_hd"}')
  const out = {}
  for (const [k, val] of Object.entries(v)) {
    if (!VOD_SOURCE_KINDS.includes(k)) bad(`unknown source kind "${k}" (supported: ${VOD_SOURCE_KINDS.join(', ')})`)
    const s = normVodText(val, `sources.${k}`)
    if (s) out[k] = s
  }
  return out
}

// Extra query params the client appends verbatim to every provider call (the observed
// provider wants `hm`/`hs`; their semantics are the provider's business). Supplying
// `params` REPLACES the whole map.
function normVodParams (v) {
  if (v == null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) bad('params must be an object, e.g. {"hm":"1","hs":"2"}')
  const entries = Object.entries(v)
  if (entries.length > VOD_PARAMS_MAX) bad(`at most ${VOD_PARAMS_MAX} params`)
  const out = {}
  for (const [k, val] of entries) {
    if (!VOD_PARAM_KEY_RE.test(k)) bad(`invalid param name "${k}" (letters, digits, _ ; max 32)`)
    out[k] = normVodText(val, `params.${k}`)
  }
  return out
}

// null when nothing was ever configured — clients treat "no record" exactly like
// "disabled", so absence never needs a separate branch anywhere downstream.
export async function getVodConfig (ctx) {
  const node = await ctx.db.get(VOD_KEY)
  return node ? node.value : null
}

// Partial PATCH: fields present in the patch land on top of the current record, and the
// MERGED WHOLE is validated — so `{enabled:true}` alone is refused while apiBase/service
// are still blank, and setting them in the same request works. S29 idempotency: the bee
// is append-only with no compaction, so an identical PATCH must cost zero appends.
export async function setVodConfig (ctx, patch = {}) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) bad('vod config must be an object')
  const node = await ctx.db.get(VOD_KEY)
  const cur = node ? node.value : {}
  const next = {
    enabled: patch.enabled !== undefined ? normBool(patch.enabled) : !!cur.enabled,
    apiBase: patch.apiBase !== undefined ? normVodApiBase(patch.apiBase) : (cur.apiBase ?? ''),
    service: patch.service !== undefined ? normVodText(patch.service, 'service') : (cur.service ?? ''),
    sources: patch.sources !== undefined ? normVodSources(patch.sources) : normVodSources(cur.sources),
    params: patch.params !== undefined ? normVodParams(patch.params) : normVodParams(cur.params)
  }
  if (next.enabled && (!next.apiBase || !next.service)) {
    bad('cannot enable the VOD provider without an apiBase and a service — set them in the same request, or first')
  }
  if (!node || JSON.stringify(next) !== JSON.stringify(cur)) await ctx.db.put(VOD_KEY, next)
  return next
}

// ---------------------------------------------------------------- status

export async function statusSummary (ctx) {
  let users = 0
  for await (const _ of ctx.db.createReadStream({ gt: 'user/', lt: 'user0' })) users++ // eslint-disable-line no-unused-vars
  const streams = await listStreams(ctx)
  return {
    panelKey: b4a.toString(ctx.keys.signing.publicKey, 'hex'),
    // The 12-character alias for that key (core/pairing.js), derived once at boot and
    // handed in by src/index.js — never computed here, because this endpoint is polled.
    // null when the panel was started without it (tests, embedders).
    pairingCode: ctx.pairingCode || null,
    serviceName: ctx.config?.serviceName || null,
    users,
    streams: streams.length,
    live: streams.filter((s) => s.isLive).length,
    admins: Object.keys(loadAdmins(ctx.dataDir)).length
  }
}

// ---------------------------------------------------------------- admin accounts
// Panel-private (DATA_DIR/secrets/admins.json, mode 0600) — NEVER in the replicated
// DB: the Hyperbee is public, and admin verifiers must not be exposed to offline
// brute-force. Passwords are Argon2id-hashed with the deployment's cost settings.
// Login verification runs in a worker thread, single-flight (makeAdminVerifier) —
// a login flood must never block the event loop (2026-07-16 broadcaster incident;
// same pattern as broadcaster/src/control-auth.js).

function adminsPath (dataDir) { return path.join(dataDir, 'secrets', 'admins.json') }

export function loadAdmins (dataDir) {
  const p = adminsPath(dataDir)
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

// Atomic (tmp + fsync + rename): a truncated admins.json locks every operator out.
function saveAdmins (dataDir, admins) {
  writeJsonAtomic(adminsPath(dataDir), admins, { mode: 0o600, dirMode: 0o700 })
}

export function addAdmin (ctx, name, password) {
  checkName(name, 'admin name')
  if (typeof password !== 'string' || password.length < 8) bad('admin password must be at least 8 characters')
  const admins = loadAdmins(ctx.dataDir)
  if (admins[name]) exists(`admin "${name}" already exists`)
  const salt = randomSalt()
  const argon = argonOpts(ctx.config)
  admins[name] = {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(b4a.from(password), salt, argon), 'hex'),
    argon,
    tokenVersion: 1,
    status: 'active',
    createdAt: Date.now()
  }
  saveAdmins(ctx.dataDir, admins)
  return { name, status: 'active' }
}

export function removeAdmin (ctx, name) {
  const admins = loadAdmins(ctx.dataDir)
  if (!admins[name]) notFound(`no such admin: ${name}`)
  delete admins[name]
  saveAdmins(ctx.dataDir, admins)
  return { name, removed: true }
}

// Public-safe admin listing: names + status only, never salts/verifiers.
export function listAdmins (ctx) {
  return Object.entries(loadAdmins(ctx.dataDir)).map(([name, a]) => ({
    name,
    status: a.status || 'active',
    createdAt: a.createdAt || null
  }))
}

// Rotate an admin password: fresh salt + Argon2id verifier, and a tokenVersion
// bump so every session issued under the old password dies (including the caller's
// own if they rotate themselves — the dashboard must re-login). admins.json is
// file-based and the panel is single-process, so read-modify-write is safe here.
export function setAdminPassword (ctx, name, password) {
  if (typeof password !== 'string' || password.length < 8) bad('admin password must be at least 8 characters')
  const admins = loadAdmins(ctx.dataDir)
  const a = admins[name]
  if (!a) notFound(`no such admin: ${name}`)
  const salt = randomSalt()
  const argon = argonOpts(ctx.config)
  a.salt = b4a.toString(salt, 'hex')
  a.verifier = b4a.toString(deriveVerifier(b4a.from(password), salt, argon), 'hex')
  a.argon = argon
  a.tokenVersion = (a.tokenVersion || 1) + 1
  saveAdmins(ctx.dataDir, admins)
  return { name, tokenVersion: a.tokenVersion }
}

// ---------------------------------------------------------------- publishers
// Enrolled broadcaster identities (S26). Panel-private registry
// (DATA_DIR/secrets/publishers.json, mode 0600, same pattern as admins.json) —
// NEVER in the replicated DB. Each entry is one broadcaster site:
//   { name: { publicKey, scopes: ['east-*','sports-1'], status: 'active'|'revoked', addedAt } }
// The keypair is generated PANEL-side; only the PUBLIC key is stored — the secret
// is returned exactly once by addPublisher for that site's broadcaster .env
// (PUBLISHER_KEY + PUBLISHER_NAME). The register responder (rpc.js) re-reads the
// file per registration (file-based like admins), verifies the payload signature
// against THAT entry's key, and rejects streamIds outside the entry's scopes —
// one site's leaked key can no longer touch another site's channels, and a
// revoke is a status flip here instead of a global re-key of every site.

function publishersPath (dataDir) { return path.join(dataDir, 'secrets', 'publishers.json') }

export function loadPublishers (dataDir) {
  const p = publishersPath(dataDir)
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

// Atomic (tmp + fsync + rename): losing this registry unenrolls every broadcaster site.
function savePublishers (dataDir, publishers) {
  writeJsonAtomic(publishersPath(dataDir), publishers, { mode: 0o600, dirMode: 0o700 })
}

// Advisory boot signal: true when the legacy shared-publisher path is STILL enabled
// while at least one named publisher (S26) is enrolled — the operator has migrated to
// per-site keys but left the shared init key open, so unnamed registers still verify
// against it at implicit scope '*'. index.js warns on this so LEGACY_PUBLISHER=0 gets
// set once every broadcaster carries PUBLISHER_NAME. Purely advisory — never breaks
// boot, and a single-broadcaster deployment (no named publishers) is silent by design.
export function legacyPublisherActiveWithNamed (legacyPublisher, publishers) {
  return !!legacyPublisher && !!publishers && Object.keys(publishers).length > 0
}

// Scopes are streamId globs: stream-id characters plus `*` (matches any run,
// including empty). `*` alone = everything. Accepts an array or a comma string.
const SCOPE_RE = /^[A-Za-z0-9_.*-]{1,64}$/
export function normScopes (scopes) {
  const list = Array.isArray(scopes) ? scopes : scopes == null ? [] : String(scopes).split(',')
  const out = []
  for (const raw of list) {
    const s = String(raw).trim()
    if (s === '') continue
    if (!SCOPE_RE.test(s)) bad(`invalid scope "${s}" (allowed: letters, digits, _ . - and * wildcards; max 64)`)
    if (!out.includes(s)) out.push(s)
  }
  if (out.length > 64) bad('at most 64 scopes per publisher')
  return out
}

// True when streamId matches ANY of the scope globs.
export function scopeMatch (scopes, streamId) {
  if (!Array.isArray(scopes) || typeof streamId !== 'string') return false
  for (const s of scopes) {
    if (typeof s !== 'string') continue
    const re = new RegExp('^' + s.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    if (re.test(streamId)) return true
  }
  return false
}

// Enroll a broadcaster site. Generates the Ed25519 keypair panel-side and returns
// the secret ONCE (same UX as `init`/add-stream) — it is never stored here.
export function addPublisher (ctx, name, opts = {}) {
  checkName(name, 'publisher name')
  const scopes = normScopes(opts.scopes)
  const publishers = loadPublishers(ctx.dataDir)
  if (Object.prototype.hasOwnProperty.call(publishers, name)) exists(`publisher "${name}" already exists`)
  const kp = authKeyPair()
  publishers[name] = {
    publicKey: b4a.toString(kp.publicKey, 'hex'),
    scopes,
    status: 'active',
    addedAt: Date.now()
  }
  savePublishers(ctx.dataDir, publishers)
  return {
    name,
    scopes,
    status: 'active',
    publicKey: publishers[name].publicKey,
    secretKey: b4a.toString(kp.secretKey, 'hex') // returned ONCE, for that site's .env
  }
}

// Public-safe listing: never any secret (none is stored), but the public key is
// harmless and useful for cross-checking a site's .env.
export function listPublishers (ctx) {
  return Object.entries(loadPublishers(ctx.dataDir)).map(([name, p]) => ({
    name,
    scopes: p.scopes || [],
    status: p.status || 'active',
    publicKey: p.publicKey,
    addedAt: p.addedAt || null
  }))
}

// Revoke (or re-activate) a site. A revoked entry keeps its name/key/scopes for
// the audit trail; its registrations are rejected with `revoked` until re-activated.
export function setPublisherStatus (ctx, name, status) {
  if (status !== 'active' && status !== 'revoked') bad('status must be active|revoked')
  const publishers = loadPublishers(ctx.dataDir)
  const p = Object.prototype.hasOwnProperty.call(publishers, name) ? publishers[name] : null
  if (!p) notFound(`no such publisher: ${name}`)
  p.status = status
  savePublishers(ctx.dataDir, publishers)
  return { name, status, scopes: p.scopes || [] }
}

// Replace a site's channel scopes. Takes effect on its NEXT registration —
// including the 5-minute heartbeat re-assert of an already-running channel.
export function setPublisherScopes (ctx, name, scopes) {
  const next = normScopes(scopes)
  const publishers = loadPublishers(ctx.dataDir)
  const p = Object.prototype.hasOwnProperty.call(publishers, name) ? publishers[name] : null
  if (!p) notFound(`no such publisher: ${name}`)
  p.scopes = next
  savePublishers(ctx.dataDir, publishers)
  return { name, status: p.status || 'active', scopes: next }
}

// Hard delete (prefer revoke — it keeps the audit trail). Future registrations
// reject with `unknown-publisher`.
export function removePublisher (ctx, name) {
  const publishers = loadPublishers(ctx.dataDir)
  if (!Object.prototype.hasOwnProperty.call(publishers, name)) notFound(`no such publisher: ${name}`)
  delete publishers[name]
  savePublishers(ctx.dataDir, publishers)
  return { name, removed: true }
}

// A dummy record keeps the Argon2 work (and thus response time) the same whether or
// not the admin name exists, so login timing does not confirm admin usernames.
const DUMMY_ADMIN = {
  salt: '00000000000000000000000000000000',
  verifier: '00'.repeat(32)
}

// 503 for "can't verify right now" (busy / timed out / worker died) — admin-server's
// generic err.httpStatus path turns it into the HTTP response.
function unavailable (message) {
  const e = new Error(message)
  e.httpStatus = 503
  return e
}

// Admin login verification for the admin server. The Argon2id grind runs in a
// dedicated worker thread so it can NEVER block the event loop — on the main thread
// a single verify is a synchronous memory-hard pass (memKiB per call), and on a
// swapping small host that pass takes minutes: the 2026-07-16 broadcaster incident
// had 4-5 queued /api/login verifies starve the control API AND swarm replication
// for 25+ minutes; the panel's login route had the identical defect. Policy on top
// of the worker (ported from broadcaster/src/control-auth.js):
//
//   - single-flight: one verify in flight, ever. A concurrent login is rejected
//     immediately with 503 instead of queueing behind the grind.
//   - timeout: a verify that outlives timeoutMs gets its worker terminated (a fresh
//     one spawns for the next attempt) and the login fails 503 — a thrashing box
//     keeps replicating the catalog and answering viewer logins even if admin
//     logins are temporarily impossible.
//   - unknown names still cost the same work as real ones (DUMMY_ADMIN), so login
//     timing does not confirm admin usernames.
export function makeAdminVerifier (ctx, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000
  let worker = null
  let inflight = null // { id, worker, settle } — the one verify we're waiting on
  let seq = 0

  function spawnWorker () {
    const w = new Worker(new URL('./admin-verify-worker.js', import.meta.url))
    w.unref() // must not hold the process open; close() still terminates it
    w.on('message', (m) => {
      if (inflight && inflight.id === m.id) { const f = inflight; inflight = null; f.settle(null, m.ok) }
    })
    const gone = () => {
      if (worker === w) worker = null
      if (inflight && inflight.worker === w) { const f = inflight; inflight = null; f.settle(unavailable('login verification unavailable (worker died)')) }
    }
    w.on('error', gone)
    w.on('exit', gone)
    return w
  }

  function dispatch (job) {
    return new Promise((resolve, reject) => {
      if (!worker) worker = spawnWorker()
      const w = worker
      const id = ++seq
      const timer = setTimeout(() => {
        if (!inflight || inflight.id !== id) return
        inflight = null
        if (worker === w) worker = null
        try { w.terminate() } catch {}
        reject(unavailable(`login verification timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      if (timer.unref) timer.unref()
      inflight = {
        id,
        worker: w,
        settle: (err, ok) => { clearTimeout(timer); err ? reject(err) : resolve(ok) }
      }
      w.postMessage({ id, ...job })
    })
  }

  return {
    get busy () { return !!inflight },

    // Resolves { name, tokenVersion } on success, null on bad credentials; throws
    // httpStatus 503 when busy / timed out / the worker died.
    async verify (name, password) {
      if (typeof name !== 'string' || typeof password !== 'string') return null
      if (inflight) throw unavailable('a login verification is already in flight — retry shortly')
      const admins = loadAdmins(ctx.dataDir)
      const a = admins[name]
      const rec = a || DUMMY_ADMIN
      const argon = rec.argon || argonOpts(ctx.config)
      const ok = await dispatch({ password, saltHex: rec.salt, verifierHex: rec.verifier, argon })
      if (!a || !ok || a.status !== 'active') return null
      return { name, tokenVersion: a.tokenVersion || 1 }
    },

    close () {
      const w = worker
      worker = null
      if (inflight) { const f = inflight; inflight = null; f.settle(unavailable('admin server closing')) }
      if (w) { try { w.terminate() } catch {} }
    }
  }
}

// Token-refresh check used on every authed request: the admin must still exist, be
// active, and the token's version must match (bumping tokenVersion revokes sessions).
export function adminTokenLive (ctx, payload) {
  if (!payload || payload.role !== 'admin' || !payload.adminId) return false
  const a = loadAdmins(ctx.dataDir)[payload.adminId]
  return !!a && a.status === 'active' && (a.tokenVersion || 1) === (payload.tokenVersion || 1)
}
