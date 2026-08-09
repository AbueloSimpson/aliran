// Pluggable guide ingest. Providers turn a source (provider JSON, XMLTV, or a
// manual local file) into the ONE normalized shape the distribution layer writes:
//
//   NormalizedGuide = Map<providerChannelId, Map<'YYYY-MM-DD', Program[]>>
//   Program         = { title, start, stop, desc? }   (start/stop ISO strings, UTC split)
//
// The scheduler below runs each provider on its cadence (jittered so a fleet of
// services does not thunder at a provider on the hour), resolves provider ids to
// stream ids through the GuideManager's catalog mapping (config `overrides` win),
// and writes per-channel-per-day files. All growth discipline (byte-compare,
// sliding window) lives in GuideManager — a provider only ever produces data.
//
// Trust: provider feeds are third-party data. Malformed entries are skipped, never
// fatal (same stance as the viewer's EpgService parser, sdk/react-native/src/epg.ts).

import fs from 'fs'
import zlib from 'zlib'
import { utcDay } from './guide.js'

const DAY_MS = 24 * 3600 * 1000

// Split a program list into UTC day buckets, windowed to [yesterday, +guideDays).
// A program straddling midnight lands in the day it STARTS — now/next selection
// reads consecutive days, so nothing is lost at the boundary.
export function bucketByDay (programs, { now = Date.now(), guideDays = 7 } = {}) {
  const floor = Date.parse(utcDay(now - DAY_MS))
  const ceil = Date.parse(utcDay(now)) + guideDays * DAY_MS
  const days = new Map()
  for (const p of programs) {
    const start = Date.parse(p?.start)
    const stop = Date.parse(p?.stop)
    if (!p?.title || Number.isNaN(start) || Number.isNaN(stop) || stop <= start) continue
    if (stop <= floor || start >= ceil) continue
    const day = utcDay(start)
    if (!days.has(day)) days.set(day, [])
    days.get(day).push({ title: String(p.title), start: new Date(start).toISOString(), stop: new Date(stop).toISOString(), ...(p.desc ? { desc: String(p.desc) } : {}) })
  }
  return days
}

// Parse the provider-JSON feed shape ({channels:[{id, epg:[...]}]} or a bare array)
// into the normalized guide. Mirrors the viewer parser's tolerance exactly.
export function parseProviderJson (feed, opts) {
  const list = Array.isArray(feed) ? feed : Array.isArray(feed?.channels) ? feed.channels : []
  const guide = new Map()
  for (const ch of list) {
    const id = ch && ch.id != null ? String(ch.id) : ''
    if (!id || !Array.isArray(ch.epg)) continue
    const days = bucketByDay(ch.epg, opts)
    if (days.size) guide.set(id, days)
  }
  return guide
}

// --- XMLTV ---

// Decompressed-size ceiling for gzipped feeds. A country guide is a few MB; the
// cap only exists so a hostile or misconfigured URL cannot balloon the heap.
const XMLTV_MAX_BYTES = 64 * 1024 * 1024

// XMLTV timestamps: "YYYYMMDDHHMMSS +HHMM" (offset and trailing fields optional;
// no offset means UTC). Returns epoch ms, NaN when unparseable.
export function parseXmltvDate (s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*(?:([+-])(\d{2})(\d{2}))?$/.exec(String(s ?? '').trim())
  if (!m) return NaN
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))
  if (m[7]) {
    const off = (+m[8] * 60 + +m[9]) * 60000
    t += m[7] === '-' ? off : -off
  }
  return t
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXmlEntities (s) {
  return s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, (whole, hex, dec, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    if (dec) return String.fromCodePoint(+dec)
    return XML_ENTITIES[name] ?? whole
  })
}

function xmlAttr (attrs, name) {
  const m = attrs.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')'))
  return m ? decodeXmlEntities(m[1] ?? m[2]) : ''
}

function xmlTag (body, name) {
  const m = body.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'))
  return m ? decodeXmlEntities(m[1].trim()) : ''
}

// Parse an XMLTV document into the normalized guide. Regex-scan, not a DOM: the
// files are machine-generated and regular, and this keeps the service dependency
// free. Same tolerance stance as parseProviderJson — bad entries are skipped.
export function parseXmltv (xml, opts) {
  const text = String(xml)
  const perChannel = new Map()
  const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi
  let m
  while ((m = progRe.exec(text))) {
    const channel = xmlAttr(m[1], 'channel')
    const start = parseXmltvDate(xmlAttr(m[1], 'start'))
    const stop = parseXmltvDate(xmlAttr(m[1], 'stop'))
    const title = xmlTag(m[2], 'title')
    if (!channel || !title || Number.isNaN(start) || Number.isNaN(stop)) continue
    const desc = xmlTag(m[2], 'desc')
    if (!perChannel.has(channel)) perChannel.set(channel, [])
    perChannel.get(channel).push({ title, start: new Date(start).toISOString(), stop: new Date(stop).toISOString(), ...(desc ? { desc } : {}) })
  }
  const guide = new Map()
  for (const [id, programs] of perChannel) {
    const days = bucketByDay(programs, opts)
    if (days.size) guide.set(id, days)
  }
  return guide
}

// --- providers ---

// Per-request time budget for the fetching providers. Without one, a stalled
// upstream parks a run on undici's default ~5-minute header/body timeouts — and
// a truly hung socket for as long as the OS keeps it open. The abort signal is
// handed to fetchImpl; the race also bounds body reads and impls that ignore it.
const FETCH_TIMEOUT_SECONDS = 60

async function fetchWithTimeout (spec, fn) {
  const ctl = new AbortController()
  let timer
  // Deliberately NOT unref'd (unlike the scheduler's interval timers): it lives
  // only as long as one request and must fire even if the hung fetch is the last
  // thing keeping the event loop alive.
  const timedOut = new Promise((resolve, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(new Error('timeout')) }, (spec.timeoutSeconds || FETCH_TIMEOUT_SECONDS) * 1000)
  })
  try {
    return await Promise.race([fn(ctl.signal), timedOut])
  } catch (err) {
    throw ctl.signal.aborted ? new Error('timeout') : err
  } finally {
    clearTimeout(timer)
  }
}

// provider-json: https fetch of the same feed shape epgUrl points at today, with
// ETag revalidation so a quiet poll costs a 304 and produces an EMPTY guide (the
// scheduler then touches nothing — zero drive appends).
// spec.headers (optional, all fetching providers): extra request headers, e.g. the
// auth secret of a private feed. Never logged; providers.json already holds urls.
// spec.timeoutSeconds (optional, all fetching providers): per-request budget,
// default FETCH_TIMEOUT_SECONDS.
export function providerJson (spec) {
  let etag = null
  return {
    id: spec.id,
    refreshMs: (spec.refreshHours || 0) * 3600 * 1000 || null, // null = service default
    overrides: spec.overrides || {},
    prefix: spec.prefix || '',
    async fetch ({ guideDays, fetchImpl = fetch }) {
      const headers = { accept: 'application/json', ...(spec.headers || {}) }
      if (etag) headers['if-none-match'] = etag
      return fetchWithTimeout(spec, async (signal) => {
        const res = await fetchImpl(spec.url, { headers, signal })
        if (res.status === 304) return new Map() // unchanged upstream — nothing to write
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        etag = res.headers.get('etag')
        return parseProviderJson(await res.json(), { guideDays })
      })
    }
  }
}

// manual: a local JSON file in the provider feed shape — the operator's hand-edited
// guide and the test fixture path. Mtime is the change signal.
export function providerManual (spec) {
  let mtime = 0
  return {
    id: spec.id,
    refreshMs: (spec.refreshHours || 0) * 3600 * 1000 || null,
    overrides: spec.overrides || {},
    prefix: spec.prefix || '',
    async fetch ({ guideDays }) {
      const st = fs.statSync(spec.file)
      if (st.mtimeMs === mtime) return new Map()
      mtime = st.mtimeMs
      return parseProviderJson(JSON.parse(fs.readFileSync(spec.file, 'utf8')), { guideDays })
    }
  }
}

// xmltv: https fetch of an XMLTV document, plain or gzipped (sniffed by magic
// bytes, not extension — public mirrors are inconsistent about both). ETag and
// Last-Modified revalidation, same frugality contract as provider-json.
export function providerXmltv (spec) {
  let etag = null
  let lastModified = null
  return {
    id: spec.id,
    refreshMs: (spec.refreshHours || 0) * 3600 * 1000 || null,
    overrides: spec.overrides || {},
    prefix: spec.prefix || '',
    async fetch ({ guideDays, fetchImpl = fetch }) {
      const headers = { accept: 'application/xml, text/xml, application/gzip;q=0.9, */*;q=0.8', ...(spec.headers || {}) }
      if (etag) headers['if-none-match'] = etag
      if (lastModified) headers['if-modified-since'] = lastModified
      return fetchWithTimeout(spec, async (signal) => {
        const res = await fetchImpl(spec.url, { headers, signal })
        if (res.status === 304) return new Map() // unchanged upstream — nothing to write
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        etag = res.headers.get('etag')
        lastModified = res.headers.get('last-modified')
        let buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > XMLTV_MAX_BYTES) throw new Error('feed exceeds size cap')
        if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
          buf = zlib.gunzipSync(buf, { maxOutputLength: XMLTV_MAX_BYTES })
        }
        return parseXmltv(buf.toString('utf8'), { guideDays })
      })
    }
  }
}

export function buildProvider (spec) {
  if (spec.type === 'provider-json') return providerJson(spec)
  if (spec.type === 'manual') return providerManual(spec)
  if (spec.type === 'xmltv') return providerXmltv(spec)
  throw new Error(`unknown provider type "${spec.type}" (id ${spec.id})`)
}

export function loadProviders (file) {
  if (!fs.existsSync(file)) return []
  const specs = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(specs)) throw new Error('providers file must be a JSON array')
  return specs.map(buildProvider)
}

// --- scheduler ---

export class IngestScheduler {
  constructor (guide, providers, { refreshHours = 6 } = {}) {
    this.guide = guide
    this.providers = providers
    this.defaultRefreshMs = refreshHours * 3600 * 1000
    this.lastRuns = new Map() // provider id -> { at, ok, error, puts, skips, unmatched }
    this._timers = []
    this._closed = false
  }

  start () {
    for (const p of this.providers) {
      const interval = p.refreshMs || this.defaultRefreshMs
      const jitter = Math.floor(Math.random() * Math.min(interval, 10 * 60 * 1000))
      const t = setTimeout(() => {
        this.runProvider(p).catch(() => {})
        const iv = setInterval(() => this.runProvider(p).catch(() => {}), interval)
        if (iv.unref) iv.unref()
        this._timers.push(iv)
      }, 5000 + jitter) // small boot delay: let the catalog replica land its first mapping
      if (t.unref) t.unref()
      this._timers.push(t)
    }
  }

  async runProvider (p) {
    if (this._closed) return
    const run = { at: Date.now(), ok: false, error: null, puts: 0, skips: 0, unmatched: 0 }
    try {
      const normalized = await p.fetch({ guideDays: this.guide.config.guideDays })
      for (const [providerId, days] of normalized) {
        // `overrides` keys are the RAW ids as they appear in the source; the
        // catalog epgId match uses the prefixed id, so with distinct prefixes a
        // channel is claimed by exactly one source (two providers writing the
        // same stream would defeat the byte-compare and grow the drive forever).
        const catalogId = (p.prefix || '') + providerId
        const streamId = Object.prototype.hasOwnProperty.call(p.overrides || {}, providerId)
          ? p.overrides[providerId]
          : this.guide.resolveStreamId(catalogId)
        if (!streamId) {
          run.unmatched++
          this.guide.noteUnmatched(catalogId, [...days.values()].reduce((n, d) => n + d.length, 0))
          continue
        }
        for (const [day, programs] of days) {
          const r = await this.guide.putDay(streamId, day, programs)
          if (r === 'put') run.puts++; else run.skips++
        }
      }
      run.ok = true
    } catch (err) {
      run.error = err?.message || String(err)
      console.warn(`[epg] provider ${p.id} failed: ${run.error}`)
    }
    this.lastRuns.set(p.id, run)
    if (run.ok && (run.puts || run.unmatched)) {
      console.log(`[epg] provider ${p.id}: ${run.puts} day-files written, ${run.skips} unchanged, ${run.unmatched} provider channels unmatched`)
    }
    return run
  }

  status () {
    return Object.fromEntries([...this.lastRuns].map(([id, r]) => [id, r]))
  }

  close () {
    this._closed = true
    for (const t of this._timers) { clearTimeout(t); clearInterval(t) }
    this._timers = []
  }
}
