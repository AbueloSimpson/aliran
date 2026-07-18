// Remote channel sources (S27) — pull a provider-prepared JSON of channels and
// materialize it as a CATEGORY of redirect channels (S23) in the catalog, kept in
// sync on a schedule. One source = one feed URL + one rail label ("Anime"); each
// feed entry becomes `<prefix><feedId>` playing its https url instead of a P2P
// feed. P2P channels tagged with the same category share the rail — the category
// field is ordinary catalog metadata either way.
//
// Trust boundary: the feed is THIRD-PARTY DATA, never instructions. Every entry
// passes the same validators as admin input (normRedirectUrl/normArt/checkName),
// oversized feeds and entry floods are capped, and ownership is explicit: an
// imported entry carries `source: <name>` and a sync may only create, update or
// delete entries stamped with ITS name — a broken or malicious feed cannot touch
// manual channels or another source's namespace (collisions are skipped and
// reported as conflicts).
//
// Sync policy (operator decisions, 2026-07-18):
//   - feed wins on the fields it maps (title/url/logo/order/category); operator-owned
//     fields it does not overwrite — featured, isLive overrides, and the DESCRIPTION
//     (seeded once on import, then an admin's synopsis sticks) — stay untouched.
//   - an entry missing from the feed is REMOVED (full deleteStream purge).
//   - autoGrant: every user gets every imported channel — reconciled on EVERY
//     sync (even 304s), so users created between syncs converge; user creation
//     also calls grantSourcesToUser for same-moment convergence. New channels
//     still reach devices on the next LOGIN (wrapped keys are fetched then).
//   - EPG stays OUT of the replicated catalog (a day of schedule per category
//     would append-grow every client's bee forever). Entries carry epgUrl/epgId
//     pointers so a future client can fetch the schedule over https on demand.
//
// Bee frugality: unchanged entries are compared and NOT re-put — a sync of an
// unchanged feed (or a 304) appends nothing to the Hyperbee.
//
// Registry: DATA_DIR/sources.json (plain — nothing secret in it; secrets/ stays
// reserved for credential material).

import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { sealTo } from '@aliran/core'
import { loadSecrets, saveSecrets } from './store.js'
import { OpsError, checkName, deleteStream, normArt, normRedirectUrl } from './ops.js'

const bad = (m) => { throw new OpsError('bad-request', m) }
const notFound = (m) => { throw new OpsError('not-found', m) }
const exists = (m) => { throw new OpsError('exists', m) }
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const normBool = (v) => v === true || /^(1|true|yes)$/i.test(String(v))

const TITLE_MAX = 200
const SKIP_REPORT_MAX = 20
const EXCLUDE_MAX = 1000

// ---------------------------------------------------------------- registry

function sourcesPath (dataDir) { return path.join(dataDir, 'sources.json') }

export function loadSources (dataDir) {
  const p = sourcesPath(dataDir)
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

function saveSources (dataDir, sources) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(sourcesPath(dataDir), JSON.stringify(sources, null, 2))
}

// Effective limits: ctx.config.sources with per-field defaults, so minimal test
// configs and pre-S27 deployments need no config changes.
function scfg (ctx) {
  const c = (ctx.config && ctx.config.sources) || {}
  return {
    defaultIntervalMs: c.defaultIntervalMs ?? 86400000, // daily
    fetchTimeoutMs: c.fetchTimeoutMs ?? 30000,
    maxBytes: c.maxBytes ?? 5 * 1024 * 1024,
    maxChannels: c.maxChannels ?? 500
  }
}

// The feed URL: https required — except plain http on loopback, so tests and
// local dev can serve a feed without certificates. (Only the PANEL fetches this
// URL; viewers never see it except as the epgUrl pointer.)
export function normSourceUrl (v) {
  const s = String(v ?? '').trim()
  if (!s) bad('url required — the feed JSON the panel pulls')
  if (s.length > 2048) bad('url must be at most 2048 characters')
  if (/[\r\n]/.test(s)) bad('url must not contain line breaks')
  let u
  try { u = new URL(s) } catch { bad('url must be an absolute URL') }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    bad('url must be https:// (plain http:// is allowed only on loopback, for local testing)')
  }
  return s
}

function normCategoryLabel (v) {
  const s = String(v ?? '').trim()
  if (!s) bad('category required — the rail label viewers see (e.g. "Anime")')
  if (s.length > 64) bad('category must be at most 64 characters')
  if (/[\r\n]/.test(s)) bad('category must not contain line breaks')
  return s
}

// Prefix namespaces the imported ids (`<prefix><feedId>`). Leading char must be
// id-safe because it starts the stream id.
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/
function normPrefix (v, name) {
  const s = v == null || String(v).trim() === '' ? name + '.' : String(v).trim()
  if (!PREFIX_RE.test(s)) bad('prefix must be 1-32 chars: letters, digits, _ . - (starting with a letter or digit)')
  return s
}

// Deselected channels: FEED ids (unprefixed) the operator excluded. Stored as
// {id, title} — the title is the label captured at exclusion time so the channels
// dialog can name entries that no longer exist in the catalog (it may drift from
// the feed's current name; harmless, refreshed if re-included and re-excluded).
// Accepts an array of strings / {id,title} objects, or a comma string (CLI).
function normExclude (v) {
  const list = Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(',')
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const isObj = raw !== null && typeof raw === 'object'
    const id = String(isObj ? raw.id ?? '' : raw).trim()
    if (!id) continue
    if (id.length > 128) bad('excluded channel id must be at most 128 characters')
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, title: isObj ? String(raw.title ?? '').trim().slice(0, TITLE_MAX) : '' })
  }
  if (out.length > EXCLUDE_MAX) bad(`at most ${EXCLUDE_MAX} excluded channels per source`)
  return out
}

function normInterval (v, dflt) {
  if (v == null || v === '') return dflt
  const n = typeof v === 'number' ? v : parseInt(v, 10)
  if (!Number.isInteger(n) || n < 60000 || n > 30 * 86400000) bad('intervalMs must be an integer between 60000 (1 min) and 2592000000 (30 days)')
  return n
}

export function addSource (ctx, name, opts = {}) {
  checkName(name, 'source name')
  const sources = loadSources(ctx.dataDir)
  if (hasOwn(sources, name)) exists(`source "${name}" already exists (use set-source to edit)`)
  sources[name] = {
    url: normSourceUrl(opts.url),
    category: normCategoryLabel(opts.category),
    prefix: normPrefix(opts.prefix, name),
    autoGrant: opts.autoGrant == null ? true : normBool(opts.autoGrant),
    enabled: opts.enabled == null ? true : normBool(opts.enabled),
    intervalMs: normInterval(opts.intervalMs, scfg(ctx).defaultIntervalMs),
    exclude: normExclude(opts.exclude),
    etag: null,
    lastSync: null,
    lastError: null,
    lastReport: null,
    addedAt: Date.now()
  }
  saveSources(ctx.dataDir, sources)
  return { name, ...sources[name] }
}

// Edit a source. Changing the url resets the etag (different resource); changing
// the prefix re-creates every entry under the new ids on the next sync (the old
// ones are stamped and no longer in the mapped set, so they are removed).
export function setSource (ctx, name, fields = {}) {
  const sources = loadSources(ctx.dataDir)
  const s = hasOwn(sources, name) ? sources[name] : null
  if (!s) notFound(`no such source: ${name}`)
  if (fields.url != null) { const u = normSourceUrl(fields.url); if (u !== s.url) { s.url = u; s.etag = null } }
  if (fields.category != null) s.category = normCategoryLabel(fields.category)
  if (fields.prefix != null) s.prefix = normPrefix(fields.prefix, name)
  if (fields.autoGrant != null) s.autoGrant = normBool(fields.autoGrant)
  if (fields.enabled != null) s.enabled = normBool(fields.enabled)
  if (fields.intervalMs != null) s.intervalMs = normInterval(fields.intervalMs, scfg(ctx).defaultIntervalMs)
  if (fields.exclude !== undefined) {
    const next = normExclude(fields.exclude)
    // An exclusion change must not be masked by ETag revalidation: the next sync
    // needs the full body to apply it, so force a fresh 200.
    if (JSON.stringify(next.map((e) => e.id)) !== JSON.stringify((s.exclude || []).map((e) => e.id))) s.etag = null
    s.exclude = next
  }
  saveSources(ctx.dataDir, sources)
  return { name, ...s }
}

// Registry + a live count of owned catalog entries per source (one catalog scan).
export async function listSources (ctx) {
  const sources = loadSources(ctx.dataDir)
  const counts = {}
  for await (const { value } of ctx.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    if (value && value.source) counts[value.source] = (counts[value.source] || 0) + 1
  }
  return Object.entries(sources).map(([name, s]) => ({ name, ...s, channels: counts[name] || 0 }))
}

// Remove a source. Default PURGES its channels (deleteStream: catalog + secret +
// grants + art). keepChannels detaches them instead — the source stamp (and epg
// pointers) are stripped and they live on as ordinary manual redirect channels.
export async function removeSource (ctx, name, opts = {}) {
  const sources = loadSources(ctx.dataDir)
  if (!hasOwn(sources, name)) notFound(`no such source: ${name}`)
  const owned = await ownedIds(ctx, name)
  let removed = 0
  let detached = 0
  for (const id of owned) {
    if (opts.keepChannels) {
      const node = await ctx.db.get('catalog/' + id)
      if (node) {
        const c = node.value
        delete c.source; delete c.epgUrl; delete c.epgId
        await ctx.db.put('catalog/' + id, c)
        detached++
      }
    } else {
      await deleteStream(ctx, id)
      removed++
    }
  }
  delete sources[name]
  saveSources(ctx.dataDir, sources)
  return { name, removed, detached }
}

async function ownedIds (ctx, name) {
  const ids = []
  for await (const { key, value } of ctx.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    if (value && value.source === name) ids.push(key.slice('catalog/'.length))
  }
  return ids
}

// ---------------------------------------------------------------- fetch + map

// Size-capped, timeout-guarded fetch with ETag revalidation. The cap is enforced
// while STREAMING the body — a feed that lies about content-length cannot balloon
// panel memory.
async function fetchFeed (url, etag, { fetchTimeoutMs, maxBytes }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), fetchTimeoutMs)
  try {
    const headers = { accept: 'application/json' }
    if (etag) headers['if-none-match'] = etag
    let res
    try { res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' }) } catch (err) {
      throw new Error(ac.signal.aborted ? `feed fetch timed out after ${fetchTimeoutMs}ms` : `feed fetch failed: ${err.cause?.message || err.message}`)
    }
    if (res.status === 304) return { notModified: true, etag }
    if (!res.ok) throw new Error(`feed fetch failed: HTTP ${res.status}`)
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > maxBytes) throw new Error(`feed too large: ${declared} bytes (cap ${maxBytes})`)
    const chunks = []
    let total = 0
    const reader = res.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch {}
        throw new Error(`feed too large: exceeds ${maxBytes} bytes`)
      }
      chunks.push(b4a.from(value))
    }
    let feed
    try { feed = JSON.parse(b4a.toString(b4a.concat(chunks), 'utf8')) } catch { throw new Error('feed is not valid JSON') }
    return { feed, etag: res.headers.get('etag') || null }
  } finally { clearTimeout(timer) }
}

// Map the raw feed to catalog-entry fields. Data-only: invalid entries are
// SKIPPED with a reason, never fatal for the rest of the feed; bad art degrades
// to no art rather than dropping the channel (the url IS the channel, art isn't).
function mapFeed (source, feed, { maxChannels }) {
  const list = Array.isArray(feed) ? feed : Array.isArray(feed?.channels) ? feed.channels : null
  if (!list) throw new Error('feed shape not recognized — expected {"channels":[…]} or a bare array')
  const entries = new Map()
  const skipped = []
  const excludedIds = new Set((source.exclude || []).map((e) => e.id))
  let excluded = 0
  let truncated = 0
  for (let i = 0; i < list.length; i++) {
    if (entries.size >= maxChannels) { truncated = list.length - i; break }
    const ch = list[i] || {}
    const rawId = ch.id != null ? String(ch.id) : ''
    const skip = (reason) => skipped.push({ id: rawId || '(missing id)', reason })
    if (!rawId) { skip('missing id'); continue }
    if (excludedIds.has(rawId)) { excluded++; continue } // operator deselected — not an error
    const id = source.prefix + rawId
    try { checkName(id, 'stream id') } catch { skip('invalid id'); continue }
    if (entries.has(id)) { skip('duplicate id'); continue }
    let url
    try { url = normRedirectUrl(ch.url) } catch { skip('invalid url'); continue }
    if (!url) { skip('missing url'); continue }
    let logo = null
    if (ch.logo != null) { try { logo = normArt(ch.logo, 'logo') } catch { logo = null } }
    const title = String(ch.name ?? '').trim().slice(0, TITLE_MAX) || rawId
    // description is OPERATOR-owned (see applyFeed): seed it from a feed-provided
    // description on first import (most feeds have none → empty), then never overwrite
    // it, so an admin can write a real channel synopsis that sticks across syncs.
    const description = typeof ch.description === 'string' ? ch.description.trim().slice(0, TITLE_MAX) : ''
    entries.set(id, {
      title,
      description,
      category: [source.category],
      url,
      logo,
      order: Math.min(i, 9999),
      epgUrl: source.url, // schedule lives in the same feed — a future client fetches it on demand
      epgId: rawId
    })
  }
  return { entries, skipped, truncated, excluded }
}

// The channels dialog's data: every entry the source knows about — imported ones
// (from the catalog, feed order) followed by excluded ones (from the registry,
// with their captured labels).
export async function sourceChannels (ctx, name) {
  const sources = loadSources(ctx.dataDir)
  if (!hasOwn(sources, name)) notFound(`no such source: ${name}`)
  const s = sources[name]
  const channels = []
  for await (const { key, value } of ctx.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    if (value && value.source === name) {
      channels.push({ feedId: value.epgId || key.slice('catalog/'.length + (s.prefix || '').length), id: key.slice('catalog/'.length), title: value.title, order: value.order ?? null, excluded: false })
    }
  }
  channels.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9))
  for (const e of s.exclude || []) {
    channels.push({ feedId: e.id, id: (s.prefix || '') + e.id, title: e.title || e.id, order: null, excluded: true })
  }
  return { name, channels }
}

// ---------------------------------------------------------------- apply (diff)

// Owned entries only: create missing, update changed, delete gone. Unchanged
// entries are not re-put (zero bee appends for an unchanged feed). Deletions run
// FIRST because deleteStream rewrites the secrets file itself — minting new
// secrets after keeps our snapshot from resurrecting deleted ones.
async function applyFeed (ctx, name, mapped) {
  const report = { added: 0, updated: 0, removed: 0, unchanged: 0, conflicts: [] }
  const current = new Map()
  for await (const { key, value } of ctx.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    current.set(key.slice('catalog/'.length), value)
  }

  for (const [id, cur] of current) {
    if (cur && cur.source === name && !mapped.entries.has(id)) {
      await deleteStream(ctx, id)
      report.removed++
    }
  }

  const secrets = loadSecrets(ctx.dataDir)
  let secretsDirty = false
  const puts = []
  for (const [id, m] of mapped.entries) {
    const cur = current.get(id)
    if (cur && cur.source !== name) { report.conflicts.push(id); continue } // manual or foreign channel — never touched
    if (!cur) {
      if (secrets[id] === undefined) { secrets[id] = b4a.toString(crypto.randomBytes(32), 'hex'); secretsDirty = true }
      puts.push([id, {
        title: m.title,
        description: m.description,
        category: m.category,
        type: 'live',
        protection: 'self',
        feedKey: null,
        blobsKey: null,
        redirect: true,
        url: m.url,
        isLive: true, // redirect channels have no broadcaster heartbeat — live by default (S23)
        poster: null,
        backdrop: null,
        logo: m.logo,
        order: m.order,
        featured: false,
        status: 'live',
        source: name,
        epgUrl: m.epgUrl,
        epgId: m.epgId
      }, 'added'])
      continue
    }
    const next = {
      ...cur,
      title: m.title,
      // description intentionally NOT set here — it is operator-owned (seeded once on
      // create above); an admin's edited synopsis survives every sync.
      category: m.category,
      redirect: true,
      url: m.url,
      logo: m.logo,
      order: m.order,
      source: name,
      epgUrl: m.epgUrl,
      epgId: m.epgId
    }
    if (JSON.stringify(next) !== JSON.stringify(cur)) puts.push([id, next, 'updated'])
    else report.unchanged++
  }
  // Secrets land on disk BEFORE the catalog references them — a crash in between
  // leaves an unreferenced secret (harmless, reused on the next sync), never a
  // granted channel without a key.
  if (secretsDirty) saveSecrets(ctx.dataDir, secrets)
  for (const [id, record, kind] of puts) {
    await ctx.db.put('catalog/' + id, record)
    report[kind]++
  }
  return report
}

// ---------------------------------------------------------------- grants

// Seal the stream secrets of `ids` to every user missing them (or one user via
// onlyUser). One read pass, one put per user that actually changed.
async function reconcileGrants (ctx, ids, { onlyUser } = {}) {
  if (!ids.length) return 0
  const secrets = loadSecrets(ctx.dataDir)
  let granted = 0
  const range = onlyUser ? { gte: 'user/' + onlyUser, lte: 'user/' + onlyUser } : { gt: 'user/', lt: 'user0' }
  for await (const { key, value } of ctx.db.createReadStream(range)) {
    const user = value
    if (!user || !user.pub) continue
    let dirty = false
    user.wrapped = user.wrapped || {}
    for (const id of ids) {
      if (user.wrapped[id] !== undefined) continue
      const encKeyHex = secrets[id]
      if (!encKeyHex) continue
      user.wrapped[id] = sealTo(b4a.from(user.pub, 'hex'), b4a.from(encKeyHex, 'hex'))
      dirty = true
      granted++
    }
    if (dirty) await ctx.db.put(key, user)
  }
  return granted
}

// Called right after createUser (admin API + CLI): a fresh account converges with
// every autoGrant source immediately instead of waiting for the next sync.
export async function grantSourcesToUser (ctx, username) {
  const sources = loadSources(ctx.dataDir)
  const auto = new Set(Object.entries(sources).filter(([, s]) => s.autoGrant !== false).map(([n]) => n))
  if (auto.size === 0) return 0
  const ids = []
  for await (const { key, value } of ctx.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    if (value && value.source && auto.has(value.source)) ids.push(key.slice('catalog/'.length))
  }
  return reconcileGrants(ctx, ids, { onlyUser: username })
}

// ---------------------------------------------------------------- sync

const inflight = new Map() // `${dataDir}\n${name}` -> Promise (single-flight; a concurrent request joins the running sync)

export function syncSource (ctx, name) {
  const key = ctx.dataDir + '\n' + name // \n can't appear in a path or a NAME_RE name, so the pair is unambiguous
  const running = inflight.get(key)
  if (running) return running
  const p = doSync(ctx, name).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function doSync (ctx, name) {
  const all = loadSources(ctx.dataDir)
  if (!hasOwn(all, name)) notFound(`no such source: ${name}`)
  const source = all[name]
  const cfg = scfg(ctx)
  const startedAt = Date.now()
  try {
    const fetched = await fetchFeed(source.url, source.etag, cfg)
    let report
    if (fetched.notModified) {
      report = { notModified: true, added: 0, updated: 0, removed: 0, unchanged: null, conflicts: [], skipped: [], skippedCount: 0, truncated: 0, excluded: (source.exclude || []).length }
    } else {
      const mapped = mapFeed(source, fetched.feed, cfg)
      const applied = await applyFeed(ctx, name, mapped)
      report = {
        notModified: false,
        ...applied,
        skipped: mapped.skipped.slice(0, SKIP_REPORT_MAX),
        skippedCount: mapped.skipped.length,
        truncated: mapped.truncated,
        excluded: mapped.excluded
      }
    }
    // Grants reconcile on EVERY sync (304 included): users created since the last
    // sync converge without any feed change.
    report.granted = source.autoGrant !== false ? await reconcileGrants(ctx, await ownedIds(ctx, name)) : 0

    // Re-load before persisting — an admin may have edited the registry while we fetched.
    const fresh = loadSources(ctx.dataDir)
    if (hasOwn(fresh, name)) {
      fresh[name].etag = fetched.etag ?? null
      fresh[name].lastSync = Date.now()
      fresh[name].lastError = null
      fresh[name].lastReport = {
        at: Date.now(),
        notModified: !!report.notModified,
        added: report.added,
        updated: report.updated,
        removed: report.removed,
        conflicts: report.conflicts.length,
        skipped: report.skippedCount,
        truncated: report.truncated,
        excluded: report.excluded,
        granted: report.granted
      }
      saveSources(ctx.dataDir, fresh)
    }
    if (ctx.activity) ctx.activity.record('source', { op: 'sync', source: name, added: report.added, updated: report.updated, removed: report.removed, granted: report.granted, notModified: !!report.notModified })
    return { name, ms: Date.now() - startedAt, ...report }
  } catch (err) {
    const msg = String(err.message || err)
    const fresh = loadSources(ctx.dataDir)
    if (hasOwn(fresh, name)) {
      fresh[name].lastError = msg
      fresh[name].lastErrorAt = Date.now()
      saveSources(ctx.dataDir, fresh)
    }
    if (ctx.activity) ctx.activity.record('source', { op: 'sync-failed', source: name, error: msg })
    if (err instanceof OpsError) throw err
    throw new OpsError('bad-request', `sync "${name}" failed: ${msg}`)
  }
}

// ---------------------------------------------------------------- scheduler

// Runs inside the panel process. A cheap tick scans the registry and syncs every
// ENABLED source whose interval has elapsed (a never-synced source is due
// immediately); failures are logged and retried on a later tick — the last good
// imported state stays live throughout. Manual sync (API/CLI) works regardless
// of enabled, and single-flight dedupes the overlap.
export function makeSourcesScheduler (ctx, opts = {}) {
  const c = (ctx.config && ctx.config.sources) || {}
  const tickMs = opts.tickMs ?? c.tickMs ?? 3600000
  const bootDelayMs = opts.bootDelayMs ?? c.bootDelayMs ?? 15000
  let closed = false
  let running = false

  async function tick () {
    if (closed || running) return
    running = true
    try {
      const sources = loadSources(ctx.dataDir)
      for (const [name, s] of Object.entries(sources)) {
        if (closed) return
        if (s.enabled === false) continue
        const interval = s.intervalMs || scfg(ctx).defaultIntervalMs
        if (Date.now() - (s.lastSync || 0) < interval) continue
        try {
          const r = await syncSource(ctx, name)
          console.log(`[sources] synced "${name}": +${r.added} ~${r.updated} -${r.removed}${r.notModified ? ' (not modified)' : ''}, grants +${r.granted}`)
        } catch (err) {
          console.error(`[sources] sync "${name}" failed: ${err.message || err}`)
        }
      }
    } finally { running = false }
  }

  const boot = setTimeout(tick, bootDelayMs)
  if (boot.unref) boot.unref()
  const timer = setInterval(tick, tickMs)
  if (timer.unref) timer.unref()
  return {
    tick, // exposed for tests
    close () { closed = true; clearTimeout(boot); clearInterval(timer) }
  }
}
