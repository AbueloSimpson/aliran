// Channel packages / "bouquets" (S44) — named bundles of channels an admin grants
// as ONE unit ("Basic", "Sports", "Cine"), instead of chip-by-chip per stream.
//
// The model constraint that shapes everything here: a grant is CRYPTOGRAPHIC, not
// an ACL. `user.wrapped[streamId]` is the stream secret sealed to that user's
// public key, and clients unseal at LOGIN — so a package cannot be a runtime
// check the panel evaluates per request. It has to MATERIALIZE into sealed
// per-stream grants, exactly like the S27 source autoGrant reconcile does
// (sources.js reconcileGrants). This module is that machinery, generalized.
//
// Registry: DATA_DIR/packages.json (plain, like sources.json — package names and
// member selectors are not secret; secrets/ stays reserved for credential
// material):
//
//   { name: { label, members: [...], default: bool, addedAt } }
//
// A member is either an explicit stream id, a streamId GLOB (`sports-*`, same
// matcher as publisher scopes), or a selector resolved against the catalog at
// reconcile time:
//
//   category:<slug>   channels whose category array carries the slug — or a
//                     child of it ('category:Nacional' covers 'Nacional/Chile')
//   source:<name>     channels imported by that S27 source
//
// Because selectors resolve at RECONCILE time, a newly tagged / imported /
// created channel joins the bouquet on the next reconcile with no package edit.
// An explicit id may name a stream that does not exist yet: it seals nothing
// until the stream (and its secret) exists, then materializes on the add-stream
// reconcile.
//
// Provenance (THE user-record change, S44): grants now carry why they exist.
//   manualGrants: [ids]   granted one-by-one (ops.grant) — never touched by
//                         package reconciles
//   packages:     [names] assigned bouquets
//   wrapped               stays the wire format: seal(manual ∪ resolved members)
// Records from before S44 have neither field; the first reconcile MIGRATES them:
// every existing wrapped id is adopted into manualGrants EXCEPT those owned by
// an autoGrant source — the source engine granted (and keeps re-sealing) those,
// so adopting them would misattribute the whole imported lineup as hand-grants.
// Either way the pass is strictly additive: adopted ids are entitled, autoGrant
// ids are carved out below, so an upgrade can never revoke anything a user had.
// (Ids owned by an autoGrant-OFF source ARE adopted — a stale auto-grant is
// indistinguishable from a hand-grant there, and keeping it is the safe read.)
//
// Removal rule: a reconcile removes a wrapped entry only when NO provenance
// covers it — not manual, not any of the user's packages, and not owned by an
// autoGrant source. That last carve-out is what keeps S27 autoGrant working
// unchanged: those grants are "everyone gets this" by the source engine (which
// re-seals them on every sync), so a package reconcile must neither remove nor
// own them. A source with autoGrant OFF gets no carve-out — bundle it with a
// `source:<name>` member and the package governs its channels.
//
// Revocation stays cooperative (unchanged): removing a package deletes the
// sealed keys from the record, but a client that already unsealed a key may
// have it cached — a hard lockout is a stream-key rotation, the known gap.
//
// ZERO wire/SDK/app impact: clients receive `wrapped` at login exactly as
// before; nothing outside the panel reads the provenance fields.

import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import { sealTo } from '@aliran/core'
import { loadSecrets } from './store.js'
import { OpsError, checkName, normSlug, scopeMatch, userSummary } from './ops.js'
import { loadSources } from './sources.js'

const bad = (m) => { throw new OpsError('bad-request', m) }
const notFound = (m) => { throw new OpsError('not-found', m) }
const exists = (m) => { throw new OpsError('exists', m) }
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const normBool = (v) => v === true || /^(1|true|yes)$/i.test(String(v))

const LABEL_MAX = 64
const MEMBERS_MAX = 512

// ---------------------------------------------------------------- registry

function packagesPath (dataDir) { return path.join(dataDir, 'packages.json') }

export function loadPackages (dataDir) {
  const p = packagesPath(dataDir)
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

function savePackages (dataDir, packages) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(packagesPath(dataDir), JSON.stringify(packages, null, 2))
}

function normLabel (v, name) {
  const s = v == null || String(v).trim() === '' ? name : String(v).trim()
  if (s.length > LABEL_MAX) bad(`label must be at most ${LABEL_MAX} characters`)
  if (/[\r\n]/.test(s)) bad('label must not contain line breaks')
  return s
}

// Mirrors ops.js SCOPE_RE — a member glob is the same shape as a publisher scope
// (stream-id characters plus `*`), and scopeMatch is the shared matcher.
const ID_GLOB_RE = /^[A-Za-z0-9_.*-]{1,64}$/

// Accepts an array or a comma string (CLI parity, like normScopes/normExclude).
// Every member is validated by KIND at write time so a typo fails the request,
// not silently at reconcile time; resolution happens later, against the catalog.
export function normMembers (v) {
  const list = Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(',')
  const out = []
  for (const raw of list) {
    const m = String(raw).trim()
    if (m === '') continue
    if (m.startsWith('category:')) {
      normSlug(m.slice('category:'.length), 'category selector')
    } else if (m.startsWith('source:')) {
      checkName(m.slice('source:'.length), 'source selector')
    } else if (m.includes('*')) {
      if (!ID_GLOB_RE.test(m)) bad(`invalid member glob "${m}" (allowed: letters, digits, _ . - and * wildcards; max 64)`)
    } else {
      checkName(m, 'member stream id')
    }
    if (!out.includes(m)) out.push(m)
  }
  if (out.length > MEMBERS_MAX) bad(`at most ${MEMBERS_MAX} members per package`)
  return out
}

export async function addPackage (ctx, name, opts = {}) {
  checkName(name, 'package name')
  const packages = loadPackages(ctx.dataDir)
  if (hasOwn(packages, name)) exists(`package "${name}" already exists (use set-package to edit)`)
  packages[name] = {
    label: normLabel(opts.label, name),
    members: normMembers(opts.members),
    default: normBool(opts.default),
    addedAt: Date.now()
  }
  savePackages(ctx.dataDir, packages)
  // A fresh package has no holders, so this materializes nothing — it runs for
  // uniformity (every package CRUD reconciles) and to converge stragglers early.
  const rec = await reconcilePackages(ctx)
  return { name, ...packages[name], reconciled: rec }
}

// Edit label/members/default. Member edits materialize immediately for every
// holder; flipping `default` affects FUTURE createUser only (it never walks
// back — or forward — existing users' assignments).
export async function setPackage (ctx, name, fields = {}) {
  const packages = loadPackages(ctx.dataDir)
  const p = hasOwn(packages, name) ? packages[name] : null
  if (!p) notFound(`no such package: ${name}`)
  if (fields.label != null) p.label = normLabel(fields.label, name)
  if (fields.members !== undefined) p.members = normMembers(fields.members)
  if (fields.default != null) p.default = normBool(fields.default)
  savePackages(ctx.dataDir, packages)
  const rec = await reconcilePackages(ctx)
  return { name, ...p, reconciled: rec }
}

// Remove a package: registry entry + every user's assignment. The reconcile
// removes the sealed keys it alone covered; grants also held manually or via
// another package (or an autoGrant source) survive.
export async function removePackage (ctx, name) {
  const packages = loadPackages(ctx.dataDir)
  if (!hasOwn(packages, name)) notFound(`no such package: ${name}`)
  delete packages[name]
  savePackages(ctx.dataDir, packages)
  // The registry no longer has the name, so the reconcile prunes it from every
  // user record and drops the now-uncovered wrapped entries in the same pass.
  const rec = await reconcilePackages(ctx)
  return { name, removed: true, reconciled: rec }
}

// Registry + live resolution: how many channels each package resolves to right
// now, and how many users hold it (one catalog scan + one user scan for all).
export async function listPackages (ctx) {
  const packages = loadPackages(ctx.dataDir)
  const names = Object.keys(packages)
  if (names.length === 0) return []
  const catalog = await catalogSnapshot(ctx)
  const holders = {}
  for await (const { value } of ctx.db.createReadStream({ gt: 'user/', lt: 'user0' })) {
    for (const n of (value && value.packages) || []) holders[n] = (holders[n] || 0) + 1
  }
  return names.map((name) => {
    const resolved = resolveMembers(packages[name].members, catalog)
    return { name, ...packages[name], resolved: [...resolved].sort(), holders: holders[name] || 0 }
  })
}

export async function getPackage (ctx, name) {
  const packages = loadPackages(ctx.dataDir)
  if (!hasOwn(packages, name)) notFound(`no such package: ${name}`)
  const resolved = resolveMembers(packages[name].members, await catalogSnapshot(ctx))
  let holders = 0
  for await (const { value } of ctx.db.createReadStream({ gt: 'user/', lt: 'user0' })) {
    if (((value && value.packages) || []).includes(name)) holders++
  }
  return { name, ...packages[name], resolved: [...resolved].sort(), holders }
}

// ---------------------------------------------------------------- resolution

// One pass over the catalog: id -> the two fields selectors match on.
async function catalogSnapshot (ctx) {
  const catalog = new Map()
  for await (const { key, value } of ctx.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    catalog.set(key.slice('catalog/'.length), { source: (value && value.source) || null, category: (value && value.category) || [] })
  }
  return catalog
}

// 'category:Nacional' covers 'Nacional' and 'Nacional/Chile' — same self-or-child
// rule as the catmeta rename machinery, so a parent selector means the whole rail.
const catMatch = (cats, slug) => cats.some((c) => c === slug || (typeof c === 'string' && c.startsWith(slug + '/')))

// Member list -> Set of stream ids, against a catalog snapshot. Explicit ids are
// included even when absent from the catalog (they seal nothing until the stream
// exists — see the header); selectors and globs match only what is really there.
export function resolveMembers (members, catalog) {
  const ids = new Set()
  for (const m of members || []) {
    if (typeof m !== 'string') continue
    if (m.startsWith('category:')) {
      const slug = m.slice('category:'.length)
      for (const [id, c] of catalog) if (catMatch(c.category, slug)) ids.add(id)
    } else if (m.startsWith('source:')) {
      const name = m.slice('source:'.length)
      for (const [id, c] of catalog) if (c.source === name) ids.add(id)
    } else if (m.includes('*')) {
      for (const id of catalog.keys()) if (scopeMatch([m], id)) ids.add(id)
    } else {
      ids.add(m)
    }
  }
  return ids
}

// ---------------------------------------------------------------- reconcile

// THE engine: make every user's `wrapped` equal seal(manualGrants ∪ the resolved
// members of their packages), leaving autoGrant-source grants alone (see the
// header for why they are carved out — the source engine owns and re-seals them).
//
// Triggers (callers): package CRUD (above), user assignment (below), createUser
// defaults, every source sync (sources.js doSync — selectors may match imported
// channels), stream add/delete and category edits (admin-server/admin-cli), and
// panel boot (index.js — which is also when pre-S44 records migrate).
//
// Bee frugality: provenance is normalized in-memory and a record is only put
// when something actually changed, so a converged deployment reconciles with
// zero appends.
export async function reconcilePackages (ctx, { onlyUser } = {}) {
  const packages = loadPackages(ctx.dataDir)
  const sources = loadSources(ctx.dataDir)
  const secrets = loadSecrets(ctx.dataDir)
  const catalog = await catalogSnapshot(ctx)
  const resolved = new Map(Object.entries(packages).map(([name, p]) => [name, resolveMembers(p.members, catalog)]))
  // autoGrant-source channels: granted-to-everyone by the source engine — a
  // package reconcile treats them as covered (removing one would just flap back
  // on the next sync's reconcileGrants).
  const autoNames = new Set(Object.entries(sources).filter(([, s]) => s.autoGrant !== false).map(([n]) => n))
  const autoIds = new Set()
  for (const [id, c] of catalog) if (c.source && autoNames.has(c.source)) autoIds.add(id)

  let sealed = 0
  let removed = 0
  let users = 0
  const range = onlyUser ? { gte: 'user/' + onlyUser, lte: 'user/' + onlyUser } : { gt: 'user/', lt: 'user0' }
  for await (const { key, value } of ctx.db.createReadStream(range)) {
    const user = value
    if (!user || !user.pub) continue
    let dirty = false
    user.wrapped = user.wrapped || {}
    // Provenance migration (pre-S44 records): adopt existing grants as manual,
    // except autoGrant-source ones (see the header) — additive by construction,
    // since adopted ids are entitled and autoGrant ids are carved out below.
    if (!Array.isArray(user.manualGrants)) { user.manualGrants = Object.keys(user.wrapped).filter((id) => !autoIds.has(id)); dirty = true }
    if (!Array.isArray(user.packages)) { user.packages = []; dirty = true }
    // Assignments to packages that no longer exist are pruned (removePackage
    // rewrites users through this same path).
    const live = user.packages.filter((n) => hasOwn(packages, n))
    if (live.length !== user.packages.length) { user.packages = live; dirty = true }

    const entitled = new Set(user.manualGrants)
    for (const n of user.packages) for (const id of resolved.get(n) || []) entitled.add(id)

    for (const id of entitled) {
      if (user.wrapped[id] !== undefined) continue
      const encKeyHex = secrets[id]
      if (!encKeyHex) continue // stream (or its secret) does not exist yet
      user.wrapped[id] = sealTo(b4a.from(user.pub, 'hex'), b4a.from(encKeyHex, 'hex'))
      dirty = true
      sealed++
    }
    for (const id of Object.keys(user.wrapped)) {
      if (entitled.has(id) || autoIds.has(id)) continue
      delete user.wrapped[id]
      dirty = true
      removed++
    }
    if (dirty) { await ctx.db.put(key, user); users++ }
  }
  return { sealed, removed, users }
}

// ---------------------------------------------------------------- assignment

// Replace a user's package list and materialize it. Names must exist in the
// registry — assigning a typo is an error, not a silent no-op.
export async function setUserPackages (ctx, username, names) {
  checkName(username, 'username')
  const list = Array.isArray(names) ? names : names == null || names === '' ? [] : String(names).split(',')
  const packages = loadPackages(ctx.dataDir)
  const next = []
  for (const raw of list) {
    const n = String(raw).trim()
    if (n === '') continue
    if (!hasOwn(packages, n)) notFound(`no such package: ${n}`)
    if (!next.includes(n)) next.push(n)
  }
  const node = await ctx.db.get('user/' + username)
  if (!node) notFound(`no such user: ${username}`)
  const user = node.value
  user.packages = next // a still-unmigrated record keeps manualGrants absent — the reconcile below migrates it correctly
  await ctx.db.put('user/' + username, user)
  await reconcilePackages(ctx, { onlyUser: username })
  return userSummary(username, (await ctx.db.get('user/' + username)).value)
}

// createUser hook (admin API + CLI): assign every `default` package so a fresh
// account starts with the operator's baseline bouquets. Sits BESIDE the S27
// source autoGrant hook (grantSourcesToUser), which keeps working as-is.
export async function applyDefaultPackages (ctx, username) {
  const defaults = Object.entries(loadPackages(ctx.dataDir)).filter(([, p]) => p.default === true).map(([n]) => n)
  if (defaults.length === 0) return null
  return setUserPackages(ctx, username, defaults)
}
