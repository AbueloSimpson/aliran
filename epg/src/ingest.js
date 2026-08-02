// Pluggable guide ingest. Providers turn a source (provider JSON today, XMLTV or a
// manual push later) into the ONE normalized shape the distribution layer writes:
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

// --- providers ---

// provider-json: https fetch of the same feed shape epgUrl points at today, with
// ETag revalidation so a quiet poll costs a 304 and produces an EMPTY guide (the
// scheduler then touches nothing — zero drive appends).
export function providerJson (spec) {
  let etag = null
  return {
    id: spec.id,
    refreshMs: (spec.refreshHours || 0) * 3600 * 1000 || null, // null = service default
    overrides: spec.overrides || {},
    async fetch ({ guideDays, fetchImpl = fetch }) {
      const headers = { accept: 'application/json' }
      if (etag) headers['if-none-match'] = etag
      const res = await fetchImpl(spec.url, { headers })
      if (res.status === 304) return new Map() // unchanged upstream — nothing to write
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      etag = res.headers.get('etag')
      return parseProviderJson(await res.json(), { guideDays })
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
    async fetch ({ guideDays }) {
      const st = fs.statSync(spec.file)
      if (st.mtimeMs === mtime) return new Map()
      mtime = st.mtimeMs
      return parseProviderJson(JSON.parse(fs.readFileSync(spec.file, 'utf8')), { guideDays })
    }
  }
}

export function buildProvider (spec) {
  if (spec.type === 'provider-json') return providerJson(spec)
  if (spec.type === 'manual') return providerManual(spec)
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
        const streamId = this.guide.resolveStreamId(providerId, p.overrides)
        if (!streamId) {
          run.unmatched++
          this.guide.noteUnmatched(providerId, [...days.values()].reduce((n, d) => n + d.length, 0))
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
