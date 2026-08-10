// Remote channel sources (S27) — pull a provider channel list and materialize it as a
// CATEGORY of redirect channels (S23) in the catalog, kept in sync on a schedule. One
// source = one feed URL + one rail label ("Anime"); each feed entry becomes
// `<prefix><feedId>` playing its https url instead of a P2P feed. P2P channels tagged
// with the same category share the rail — the category field is ordinary catalog
// metadata either way.
//
// Two feed FORMATS (`format` on the source record):
//   - 'json' (default): the provider-prepared shape mapFeed reads. Feed ids are the
//     provider's, and the feed url doubles as the entries' EPG pointer.
//   - 'm3u': a plain playlist (parseM3U + mapM3U). Ids are SLUGGED FROM THE NAME
//     because playlist tvg-ids are routinely dummies, `#EXTVLCOPT` lines import as
//     per-channel playback `headers` (hotlink-protected providers), a `groups` filter
//     selects which group-titles this source takes, and the entries carry NO EPG
//     pointer — a playlist is not a program guide.
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
import { writeJsonAtomic } from '@aliran/core/atomic-write.js'
import { loadSecrets, saveSecrets } from './store.js'
import { OpsError, checkName, deleteStream, normArt, normRedirectUrl, normRedirectHeaders } from './ops.js'
import { reconcilePackages } from './packages.js'

const bad = (m) => { throw new OpsError('bad-request', m) }
const notFound = (m) => { throw new OpsError('not-found', m) }
const exists = (m) => { throw new OpsError('exists', m) }
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const normBool = (v) => v === true || /^(1|true|yes)$/i.test(String(v))

const TITLE_MAX = 200
const SKIP_REPORT_MAX = 20
const EXCLUDE_MAX = 1000
const GROUP_MAX = 64
const GROUPS_MAX = 50
const ID_MAX = 64 // NAME_RE's ceiling (ops.js) — prefix + slug must fit inside it

// ---------------------------------------------------------------- registry

function sourcesPath (dataDir) { return path.join(dataDir, 'sources.json') }

export function loadSources (dataDir) {
  const p = sourcesPath(dataDir)
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

// Atomic (tmp + fsync + rename): a truncated file loses every configured feed.
function saveSources (dataDir, sources) {
  writeJsonAtomic(sourcesPath(dataDir), sources)
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

// Which parser reads the feed. 'json' is the original provider-JSON shape (mapFeed);
// 'm3u' is a plain playlist (parseM3U + mapM3U) — the format every IPTV provider hands
// out for live-event lists. An ABSENT field means json, so every source configured
// before M3U support keeps working with no migration and no registry rewrite.
function normFormat (v) {
  const s = v == null || String(v).trim() === '' ? 'json' : String(v).trim().toLowerCase()
  if (s !== 'json' && s !== 'm3u') bad("format must be 'json' or 'm3u'")
  return s
}

// M3U group filter: the `group-title` values to import — every other entry is left out
// (counted as `filtered`, which is not an error). null / [] = import everything.
// Matching at sync time is TRIMMED, CASE-INSENSITIVE and EXACT: a rule an operator can
// check by eye against the playlist, where a substring rule would quietly drag
// "Live Events (VIP)" into a "Live Events" source. One playlist can therefore feed
// SEVERAL sources — same url, disjoint groups, its own category and prefix each —
// which is how a provider list that mixes events with ordinary channels is split into
// the right rails without any per-group mapping in the record.
// Accepts an array or a comma string (CLI parity with normExclude).
function normGroups (v) {
  if (v == null || v === '') return null
  const list = Array.isArray(v) ? v : String(v).split(',')
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const g = String(raw ?? '').trim()
    if (!g) continue
    if (g.length > GROUP_MAX) bad(`group must be at most ${GROUP_MAX} characters`)
    if (/[\r\n]/.test(g)) bad('group must not contain line breaks')
    const k = g.toLowerCase()
    if (seen.has(k)) continue // the match is case-insensitive, so two casings are one group
    seen.add(k)
    out.push(g)
  }
  if (out.length > GROUPS_MAX) bad(`at most ${GROUPS_MAX} groups per source`)
  return out.length ? out : null
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
    format: normFormat(opts.format),
    category: normCategoryLabel(opts.category),
    prefix: normPrefix(opts.prefix, name),
    autoGrant: opts.autoGrant == null ? true : normBool(opts.autoGrant),
    enabled: opts.enabled == null ? true : normBool(opts.enabled),
    // Source-scoped cleartext exemption (see normRedirectUrl in ops.js): OFF by default,
    // so a source imports https-only until the operator deliberately opts a provider in.
    allowCleartext: opts.allowCleartext == null ? false : normBool(opts.allowCleartext),
    intervalMs: normInterval(opts.intervalMs, scfg(ctx).defaultIntervalMs),
    exclude: normExclude(opts.exclude),
    groups: normGroups(opts.groups),
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
  if (fields.format != null) {
    // A format change is a different PARSE of bytes that may be byte-identical, so the
    // cached validator must not answer 304 and skip the very re-read that was asked for.
    const f = normFormat(fields.format)
    if (f !== (s.format || 'json')) s.etag = null
    s.format = f
  }
  if (fields.category != null) s.category = normCategoryLabel(fields.category)
  if (fields.prefix != null) s.prefix = normPrefix(fields.prefix, name)
  if (fields.autoGrant != null) s.autoGrant = normBool(fields.autoGrant)
  if (fields.enabled != null) s.enabled = normBool(fields.enabled)
  if (fields.allowCleartext != null) {
    // Like format/groups/exclude, this changes how the SAME feed bytes MAP: an http entry
    // that was skipped as a bad url now imports (or, turned off, is dropped again). A cached
    // ETag would let the next sync answer 304 and skip the very re-map the operator just
    // asked for — the events source flips this ON while already synced — so reset it.
    const next = normBool(fields.allowCleartext)
    if (next !== !!s.allowCleartext) s.etag = null
    s.allowCleartext = next
  }
  if (fields.intervalMs != null) s.intervalMs = normInterval(fields.intervalMs, scfg(ctx).defaultIntervalMs)
  if (fields.exclude !== undefined) {
    const next = normExclude(fields.exclude)
    // An exclusion change must not be masked by ETag revalidation: the next sync
    // needs the full body to apply it, so force a fresh 200.
    if (JSON.stringify(next.map((e) => e.id)) !== JSON.stringify((s.exclude || []).map((e) => e.id))) s.etag = null
    s.exclude = next
  }
  if (fields.groups !== undefined) {
    const next = normGroups(fields.groups)
    // Same reason as exclude: the next sync needs the full body to apply a filter change.
    if (JSON.stringify(next) !== JSON.stringify(s.groups ?? null)) s.etag = null
    s.groups = next
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

// What an m3u source will accept back. Providers serve playlists under three
// interchangeable content types and some under text/plain, so the list is broad and
// ends in a wildcard — the body is what we judge, not the header.
const M3U_ACCEPT = 'application/vnd.apple.mpegurl, audio/mpegurl, application/x-mpegurl, text/plain;q=0.9, */*;q=0.8'

// Size-capped, timeout-guarded fetch with ETag revalidation. The cap is enforced
// while STREAMING the body — a feed that lies about content-length cannot balloon
// panel memory. Everything except the accept header and the final body handling is
// format-agnostic; `format` decides whether the caller gets parsed JSON (`feed`) or
// the raw playlist text (`text`), and parsing an m3u is deliberately left to mapM3U
// so a playlist syntax error travels the same reporting path as a bad entry.
async function fetchFeed (url, etag, { fetchTimeoutMs, maxBytes }, format = 'json') {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), fetchTimeoutMs)
  try {
    const headers = { accept: format === 'm3u' ? M3U_ACCEPT : 'application/json' }
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
    const body = b4a.toString(b4a.concat(chunks), 'utf8')
    // Cross-format sniff: a playlist on a json source (or JSON on an m3u one) is nearly
    // always the `format` field set wrong, and the generic parse error would send the
    // operator hunting through the provider's file instead. Name the fix here.
    const head = body.trimStart().slice(0, 16) // trimStart also eats a leading BOM (U+FEFF is JS whitespace)
    if (format === 'm3u') {
      if (head.startsWith('{') || head.startsWith('[')) throw new Error('feed is not an M3U playlist — this looks like JSON; set the source format to json')
      return { text: body, etag: res.headers.get('etag') || null }
    }
    if (head.startsWith('#EXTM3U')) throw new Error('feed is not valid JSON — this looks like an M3U playlist; set the source format to m3u')
    let feed
    try { feed = JSON.parse(body) } catch { throw new Error('feed is not valid JSON') }
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
    try { url = normRedirectUrl(ch.url, { allowCleartext: source.allowCleartext }) } catch { skip('invalid url'); continue }
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
  // `filtered` is the m3u group filter's count; a json feed has no group concept, so it
  // reports zero and both mappers hand applyFeed/doSync the same shape.
  return { entries, skipped, truncated, excluded, filtered: 0 }
}

// ---------------------------------------------------------------- m3u
//
// The #EXTVLCOPT lines a playlist uses to declare the request headers a
// hotlink-protected provider demands, mapped onto the catalog's canonical keys.
// (`http-referer` is a common misspelling in the wild; accept both.)
const VLCOPT_HEADERS = {
  'http-referrer': 'referer',
  'http-referer': 'referer',
  'http-origin': 'origin',
  'http-user-agent': 'user-agent'
}

// An #EXTINF line is `<duration> <attr="value" …>,<display name>`, so the display name
// is everything after the FIRST comma that sits OUTSIDE quotes — and it may itself
// contain commas, which is why "everything after" and not "up to the next one".
// Both naive readings are wrong on real playlists: indexOf(',') cuts inside an
// attribute value (`tvg-name="Lakers, Game 3"`), and lastIndexOf(',') beheads any
// event title that carries a comma (`Lakers vs Celtics, Game 3` → `Game 3`), which
// would also change the slugged id. So scan once with an in-quotes flag and stop at
// the first comma seen while outside quotes.
// Returns the index of that comma, or -1. Callers need the POSITION and not just the
// name, because it is also the end of the attribute region: the title is free text and
// may itself read `group-title="Movies"`, which an attribute scan over the whole line
// would happily believe and use to override the entry's real group.
function extinfSplit (rest) {
  let quoted = false
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ',' && !quoted) return i
  }
  return -1
}

// Parse an M3U/M3U8 playlist into raw entries. Dependency-free, and deliberately PURE
// TEXT → ARRAY: it validates NOTHING, because mapM3U runs the same validators over the
// result that admin input gets, and the trust boundary has to live in exactly one place.
//
// The dialect it understands is the one every IPTV provider emits:
//
//   #EXTM3U
//   #EXTINF:-1 tvg-id="x" tvg-logo="https://…" group-title="Live Events",Team A vs Team B
//   #EXTVLCOPT:http-referrer=https://provider.example/
//   #EXTVLCOPT:http-user-agent=Mozilla/5.0 …
//   https://cdn.example/event/123.m3u8?token=…
//
// A one-entry state machine: #EXTINF opens a pending entry, #EXTVLCOPT / #EXTGRP
// decorate it, and the first non-comment line closes it as the url. Playlist bugs
// degrade instead of throwing — a second #EXTINF before any url replaces the pending
// entry, and a bare url with no #EXTINF is COUNTED as `stray` and dropped (there is no
// metadata to build a channel out of). The count matters: a playlist that lost its
// #EXTINF lines in transit would otherwise import zero channels and report zero
// problems, which reads like an empty playlist rather than a broken one. Only a missing
// #EXTM3U header is fatal, because that means the panel was handed something that is
// not a playlist at all.
export function parseM3U (text) {
  const lines = String(text).trimStart().split(/\r?\n/) // trimStart also eats a leading BOM
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i >= lines.length || !lines[i].trim().startsWith('#EXTM3U')) throw new Error('feed is not an M3U playlist (missing #EXTM3U)')
  const entries = []
  let pending = null
  let stray = 0
  for (i++; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    if (line.startsWith('#EXTINF:')) {
      const rest = line.slice('#EXTINF:'.length)
      // Attributes live BEFORE the first unquoted comma; the title after it is free text
      // and must never be scanned for them (see extinfSplit).
      const cut = extinfSplit(rest)
      const attrRegion = cut < 0 ? rest : rest.slice(0, cut)
      const attrs = {}
      for (const m of attrRegion.matchAll(/([A-Za-z0-9-]+)="([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2]
      pending = {
        name: cut < 0 ? '' : rest.slice(cut + 1).trim(),
        tvgId: attrs['tvg-id'] || '',
        tvgName: attrs['tvg-name'] || '',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || '',
        url: '',
        headers: {}
      }
      continue
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      if (!pending) continue
      const opt = line.slice('#EXTVLCOPT:'.length)
      const eq = opt.indexOf('=')
      if (eq < 0) continue
      const key = VLCOPT_HEADERS[opt.slice(0, eq).trim().toLowerCase()]
      if (key) pending.headers[key] = opt.slice(eq + 1).trim() // validated per key in mapM3U
      continue
    }
    if (line.startsWith('#EXTGRP:')) {
      // The older group syntax — only honoured when the entry carried no group-title.
      if (pending && !pending.group) pending.group = line.slice('#EXTGRP:'.length).trim()
      continue
    }
    if (line.startsWith('#')) continue // every other directive is playback tuning we do not carry
    if (!pending) { stray++; continue }
    pending.url = line
    entries.push(pending)
    pending = null
  }
  return { entries, stray }
}

// Turn a display name into a stream id. Event playlists have no stable ids to reuse —
// tvg-id is routinely ".dummy." and the same slot carries a different match every hour —
// so the NAME is the identity: the same event keeps the same id from sync to sync, and a
// retitled one churns (delete + create, which pruning and autoGrant already absorb).
// The charset is NAME_RE's (ops.js): letters, digits, _ . - , starting alphanumeric.
function slugify (name, max) {
  return String(name ?? '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, Math.max(0, max))
    .replace(/[^A-Za-z0-9]+$/, '') // the slice can land on a separator
}

// Map a parsed playlist to catalog-entry fields — the mapFeed contract (same return
// shape, same skip-don't-throw discipline, same degrade-art-not-channel rule) plus one
// extra count, `filtered`, for entries left out by the group filter. Filtered entries
// are NOT skips: nothing is wrong with them, the operator asked for other groups.
function mapM3U (source, text, { maxChannels }) {
  const { entries: list, stray } = parseM3U(text)
  const entries = new Map()
  const skipped = []
  const excludedIds = new Set((source.exclude || []).map((e) => e.id))
  const groups = (source.groups || []).map((g) => String(g).trim().toLowerCase())
  const inGroups = (e) => !groups.length || groups.includes(String(e.group || '').trim().toLowerCase())
  const budget = ID_MAX - String(source.prefix || '').length // room left for the slug
  const used = new Set()
  let excluded = 0
  let filtered = 0
  let truncated = 0
  // A url line with no #EXTINF above it is a broken playlist, not an empty one — report
  // it as a skip so the count can never read "0 added, nothing wrong".
  for (let n = 0; n < stray; n++) skipped.push({ id: '(url with no #EXTINF)', reason: 'no channel information above the address' })
  for (let i = 0; i < list.length; i++) {
    if (entries.size >= maxChannels) {
      // Only entries this source would actually IMPORT are "over the cap". Counting the
      // raw tail would blame the cap for every entry the group filter was going to drop
      // anyway — on a playlist where one group is a tenth of the file, that number is
      // almost entirely fiction.
      for (let j = i; j < list.length; j++) if (inGroups(list[j])) truncated++
      break
    }
    const e = list[i]
    const label = (e.name || e.tvgName || e.tvgId || '(unnamed)').slice(0, 128)
    const skip = (reason) => skipped.push({ id: label, reason })
    // Group filter FIRST — cheapest test, and it decides whether this entry is even
    // this source's business (one playlist commonly feeds several sources).
    if (!inGroups(e)) { filtered++; continue }
    let slug = slugify(e.name || e.tvgName, budget)
    if (!slug) { skip('unusable name'); continue }
    if (used.has(slug)) {
      // Two events with the same name inside ONE playlist. Deterministic within a sync;
      // across syncs a reordered playlist can swap which of them gets the -2, which is
      // acceptable for entries that churn hourly anyway.
      let n = 2
      let cand
      do {
        const suffix = '-' + n
        cand = slugify(slug.slice(0, Math.max(1, budget - suffix.length)), budget) + suffix
        n++
      } while (used.has(cand) && n < 100)
      slug = cand
    }
    used.add(slug)
    if (excludedIds.has(slug)) { excluded++; continue } // exclude stores UNPREFIXED feed ids
    const id = source.prefix + slug
    try { checkName(id, 'stream id') } catch { skip('invalid id'); continue }
    if (entries.has(id)) { skip('duplicate id'); continue }
    let url
    try { url = normRedirectUrl(e.url, { allowCleartext: source.allowCleartext }) } catch { skip('invalid url'); continue }
    if (!url) { skip('missing url'); continue }
    // Headers degrade PER KEY, like art: the url is the channel, and one malformed
    // #EXTVLCOPT line must not cost the operator the event it was attached to.
    let headers = null
    for (const [k, v] of Object.entries(e.headers || {})) {
      let one
      try { one = normRedirectHeaders({ [k]: v }) } catch { continue }
      if (one) headers = { ...(headers || {}), ...one }
    }
    let logo = null
    if (e.logo) { try { logo = normArt(e.logo, 'logo') } catch { logo = null } }
    entries.set(id, {
      title: String(e.name || e.tvgName || slug).trim().slice(0, TITLE_MAX),
      description: '', // a playlist carries none; operator-owned from here (see applyFeed)
      category: [source.category],
      url,
      headers,
      logo,
      order: Math.min(i, 9999),
      // A playlist is not a program guide: pointing clients at source.url would have them
      // fetch the very m3u they are already playing. Both pointers stay null, and
      // sourceChannels falls back to "key minus prefix" — which is exactly the slug.
      epgUrl: null,
      epgId: null
    })
  }
  return { entries, skipped, truncated, excluded, filtered }
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
        headers: m.headers ?? null, // provider request headers (m3u #EXTVLCOPT); null for json feeds
        isLive: true, // redirect channels have no broadcaster heartbeat — live by default (S23)
        poster: null,
        backdrop: null,
        logo: m.logo,
        order: m.order,
        featured: false,
        restricted: false, // admin flags after import; the update path spreads ...cur, so the flag survives syncs
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
      // Headers are FEED-OWNED like the url (the provider rotates both together), but
      // only written when there is something to write: unconditionally stamping
      // headers:null onto every record of every existing json source would make the
      // byte-compare below see a change and re-put the whole fleet once, for a field
      // none of those channels uses.
      ...((m.headers ?? null) !== null || (cur.headers ?? null) !== null ? { headers: m.headers ?? null } : {}),
      logo: m.logo,
      order: m.order,
      source: name,
      epgUrl: m.epgUrl,
      epgId: m.epgId
    }
    // Bee frugality, with one eyes-open exception: an event playlist re-issues its urls
    // with a fresh token every rotation, so this guard will NOT suppress those puts —
    // roughly 50 events × 48 syncs/day ≈ 2,400 appends/day. That is deliberate and well
    // within a Hyperbee's budget; it is the price of delivering live tokens to viewers.
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
    const format = source.format || 'json'
    const fetched = await fetchFeed(source.url, source.etag, cfg, format)
    let report
    if (fetched.notModified) {
      // Nothing was re-read, so the counts that describe the BODY are not zero — they are
      // simply unmeasured this round. `unchanged` has always said so with null; `filtered`
      // carries the last measurement forward instead, or the dashboard's "N outside your
      // groups" line would blink off on every 304 and back on at the next real pull.
      report = { notModified: true, added: 0, updated: 0, removed: 0, unchanged: null, conflicts: [], skipped: [], skippedCount: 0, truncated: 0, excluded: (source.exclude || []).length, filtered: source.lastReport?.filtered ?? 0, emptiedByFilter: false }
    } else {
      // One dispatch, two mappers, one contract — everything downstream (applyFeed, the
      // report, the dashboard) is format-blind.
      const mapped = format === 'm3u' ? mapM3U(source, fetched.text, cfg) : mapFeed(source, fetched.feed, cfg)
      const applied = await applyFeed(ctx, name, mapped)
      report = {
        notModified: false,
        ...applied,
        skipped: mapped.skipped.slice(0, SKIP_REPORT_MAX),
        skippedCount: mapped.skipped.length,
        truncated: mapped.truncated,
        excluded: mapped.excluded,
        filtered: mapped.filtered,
        // A group-title the provider renamed (or the operator mistyped) matches nothing,
        // and a sync that matches nothing legitimately prunes the whole rail — the feed IS
        // the membership. That is correct and must keep working, but it must not be
        // SILENT: this is the one shape where "everything gone" and "filter is wrong" look
        // identical from the outside, so flag it and let the dashboard say it out loud.
        emptiedByFilter: mapped.entries.size === 0 && applied.removed > 0 && mapped.filtered > 0
      }
    }
    // Grants reconcile on EVERY sync (304 included): users created since the last
    // sync converge without any feed change.
    report.granted = source.autoGrant !== false ? await reconcileGrants(ctx, await ownedIds(ctx, name)) : 0
    // Package reconcile rides every sync too (S44): a `source:`/`category:`/glob
    // member may cover channels this sync just imported, retagged or removed.
    await reconcilePackages(ctx)

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
        conflictIds: report.conflicts.slice(0, SKIP_REPORT_MAX),
        skipped: report.skippedCount,
        skippedDetail: report.skipped, // already capped at SKIP_REPORT_MAX
        truncated: report.truncated,
        excluded: report.excluded,
        filtered: report.filtered, // m3u only: entries outside the source's groups
        emptiedByFilter: !!report.emptiedByFilter, // the filter matched nothing and the rail was pruned
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
// ENABLED source whose interval has elapsed since its last ATTEMPT (a never-synced
// source is due immediately); failures are logged and retried on their own, floored
// cadence — the last good imported state stays live throughout. Manual sync (API/CLI)
// works regardless of enabled, and single-flight dedupes the overlap.
//
// The default tick is 5 MINUTES, not the source interval: a tick is a registry read
// and a date comparison, never a fetch, so it costs nothing to run often — and an
// hourly tick would silently round every sub-hour `intervalMs` (a 30-minute event
// playlist, say) up to an hour. SOURCES_TICK_MS still overrides it.
export function makeSourcesScheduler (ctx, opts = {}) {
  const c = (ctx.config && ctx.config.sources) || {}
  const tickMs = opts.tickMs ?? c.tickMs ?? 300000
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
        // RETRY CADENCE IS NOT TICK CADENCE. `lastSync` is stamped on SUCCESS only, so a
        // source whose provider is down stays permanently "due" and re-fetches on every
        // single tick — which the 5-minute default turned from 24 attempts a day into 288
        // against a box that is already failing. So the due-check runs against the last
        // ATTEMPT, success or failure. A failure retries sooner than the source's own
        // interval (a daily feed should not wait a day to recover) but never faster than
        // hourly, and never faster than the interval itself for sub-hour sources.
        const lastAttempt = Math.max(s.lastSync || 0, s.lastErrorAt || 0)
        const due = (s.lastErrorAt || 0) > (s.lastSync || 0) ? Math.min(interval, 3600000) : interval
        if (Date.now() - lastAttempt < due) continue
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
