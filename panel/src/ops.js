// Shared admin operations over the panel store — the single implementation behind
// BOTH the admin CLI (src/admin-cli.js) and the admin HTTP API (src/admin-server.js),
// so the two cannot drift.
//
// Every op takes a `ctx` = { config, keys, db, assets, dataDir }. Ops throw OpsError
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

export async function grant (ctx, username, streamId) {
  const user = await requireUser(ctx, username)
  const secrets = loadSecrets(ctx.dataDir)
  const encKeyHex = secrets[streamId]
  if (!encKeyHex) notFound(`no secret for stream "${streamId}" (add-stream first)`)
  user.wrapped = user.wrapped || {}
  user.wrapped[streamId] = sealTo(b4a.from(user.pub, 'hex'), b4a.from(encKeyHex, 'hex'))
  await ctx.db.put('user/' + username, user)
  return userSummary(username, user)
}

// NOTE: revoking removes the sealed key from the record, so the user cannot recover
// it on a future login. A client that already unsealed the key may have it cached —
// full revocation of live content requires rotating the stream key.
export async function revoke (ctx, username, streamId) {
  const user = await requireUser(ctx, username)
  if (!user.wrapped || !user.wrapped[streamId]) notFound(`user "${username}" has no grant for "${streamId}"`)
  delete user.wrapped[streamId]
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
function userSummary (username, u) {
  return {
    username,
    status: u.status || 'active',
    grants: Object.keys(u.wrapped || {}),
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
    isLive: !!url,
    poster: null,
    backdrop: null,
    logo: null,
    order: opts.order != null ? normOrder(opts.order) : null,
    featured: normBool(opts.featured),
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
export function normRedirectUrl (v) {
  const s = String(v).trim()
  if (s === '') return null
  if (s.length > 2048) bad('url must be at most 2048 characters')
  if (/[\r\n]/.test(s)) bad('url must not contain line breaks')
  if (!/^https:\/\/./i.test(s)) bad('url must be an https:// URL')
  return s
}

// EPG feed URL: a public https JSON of channels+schedules the CLIENT fetches (never
// the panel), so https is required for the same Android-cleartext reason as art.
// Empty clears.
function normEpgUrl (v) {
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
  // EPG pointers (S27): a public https feed URL + this channel's id inside it. The app
  // fetches the guide on demand; the schedule never enters the catalog. Works on ANY
  // channel (P2P or redirect) — sources set these automatically on imported channels.
  // Empty string clears. epgUrl without epgId (or vice versa) yields no guide, so both
  // matter; we validate independently and let the client require both.
  if (fields.epgUrl !== undefined) c.epgUrl = normEpgUrl(fields.epgUrl)
  if (fields.epgId !== undefined) c.epgId = normEpgId(fields.epgId)
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
    if (fields.url !== undefined) {
      if (fields.isLive == null) c.isLive = !!url
      if (fields.status == null) c.status = url ? 'live' : 'idle'
    }
  }
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
    if (value.wrapped && value.wrapped[id] !== undefined) {
      delete value.wrapped[id]
      await ctx.db.put(key, value)
      grantsRevoked++
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

// ---------------------------------------------------------------- categories
//
// Categories live ON each catalog record as a plain string array
// (`category: ['Nacional/Chile']`) and that STAYS the wire format — the RN app and the
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
function normSlug (s, what = 'category') {
  const v = s == null ? '' : String(s).trim()
  if (!v) bad(`${what} is required`)
  if (v.length > CAT_MAX) bad(`${what} must be at most ${CAT_MAX} characters`)
  if (/[\r\n]/.test(v)) bad(`${what} must not contain line breaks`)
  if (v.startsWith('/') || v.endsWith('/') || v.includes('//')) bad(`${what} must not start, end or double up on "/"`)
  if (v.split('/').length > 2) bad(`${what} supports at most two levels (Parent/Child)`)
  return v
}

const parentOf = (slug) => (slug.includes('/') ? slug.slice(0, slug.indexOf('/')) : null)
// Renaming 'Nacional' has to carry 'Nacional/Chile' with it or the children orphan.
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

// ---------------------------------------------------------------- status

export async function statusSummary (ctx) {
  let users = 0
  for await (const _ of ctx.db.createReadStream({ gt: 'user/', lt: 'user0' })) users++ // eslint-disable-line no-unused-vars
  const streams = await listStreams(ctx)
  return {
    panelKey: b4a.toString(ctx.keys.signing.publicKey, 'hex'),
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

function saveAdmins (dataDir, admins) {
  const p = adminsPath(dataDir)
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }) // owner-only secrets dir
  fs.writeFileSync(p, JSON.stringify(admins, null, 2), { mode: 0o600 })
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
//   { name: { publicKey, scopes: ['east-*','espn2'], status: 'active'|'revoked', addedAt } }
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

function savePublishers (dataDir, publishers) {
  const p = publishersPath(dataDir)
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }) // owner-only secrets dir
  fs.writeFileSync(p, JSON.stringify(publishers, null, 2), { mode: 0o600 })
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
