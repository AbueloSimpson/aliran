// Remote EPG (S27) — part of the @aliran/react-native SDK surface, so any app on the
// SDK gets the program-guide data layer for free (only the visuals stay app-specific).
// The guide for a channel lives in the SAME provider JSON the panel's catalog points
// at via each Stream's `epgUrl`/`epgId` (the catalog never carries schedule data — it
// would grow the replicated bee forever). This service fetches that feed on demand,
// indexes channels[].id, and reads now/next locally.
//
// Trust/cost: exactly the stance of remote art and redirect URLs — a public https
// fetch the viewer's device makes directly. ONE fetch covers a whole category (all
// its channels share the URL), so it is cached per-URL and revalidated with ETag;
// a quiet refresh that finds nothing new costs a 304. Playback never depends on
// this — a missing/unreachable/malformed feed just yields no guide.

export interface EpgProgram {
  title: string
  start: number // epoch ms (parsed from the feed's ISO start)
  stop: number // epoch ms
}

export interface NowNext {
  now: EpgProgram | null
  next: EpgProgram[]
}

// One cached feed: programs indexed by feed channel id, plus revalidation state.
interface FeedCache {
  fetchedAt: number
  etag: string | null
  byId: Map<string, EpgProgram[]> // sorted by start
  coversUntil: number // max stop across all channels — when now passes this, the data is spent
  inflight: Promise<void> | null
}

export interface EpgServiceOpts {
  fetchImpl?: typeof fetch
  now?: () => number
  maxBytes?: number // reject a feed larger than this (default 8 MiB)
  minRefetchMs?: number // never refetch a given URL more often than this (default 5 min)
  maxAgeMs?: number // refetch when the cache is older than this even if still covering (default 3 h)
  fetchTimeoutMs?: number // per-fetch timeout (default 15 s)
  nextCount?: number // how many upcoming programs now/next returns (default 4)
}

const DEFAULTS = {
  maxBytes: 8 * 1024 * 1024,
  minRefetchMs: 5 * 60 * 1000,
  maxAgeMs: 3 * 60 * 60 * 1000,
  fetchTimeoutMs: 15000,
  nextCount: 4
}

// One cached P2P guide: per-day programs fetched from the engine's loopback
// /epg/v1/<id>/<day>.json (backed by the replicated guide drive). ETags come from
// the drive version, so a poll of an unchanged guide costs a loopback 304 and zero
// network. `absent` records a channel the drive does not cover (today's file
// 404ed) — remembered until the next refetch window so every tick does not re-404.
interface P2pCache {
  fetchedAt: number
  etags: Map<string, string> // day -> etag
  byDay: Map<string, EpgProgram[]>
  coversUntil: number
  absent: boolean
  inflight: Promise<void> | null
}

export class EpgService {
  private cache = new Map<string, FeedCache>()
  private p2p = new Map<string, P2pCache>()
  private fetchImpl: typeof fetch
  private now: () => number
  private opts: typeof DEFAULTS

  constructor (opts: EpgServiceOpts = {}) {
    // Bind so a global fetch isn't called with the wrong receiver on some engines.
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
    this.now = opts.now ?? Date.now
    this.opts = {
      maxBytes: opts.maxBytes ?? DEFAULTS.maxBytes,
      minRefetchMs: opts.minRefetchMs ?? DEFAULTS.minRefetchMs,
      maxAgeMs: opts.maxAgeMs ?? DEFAULTS.maxAgeMs,
      fetchTimeoutMs: opts.fetchTimeoutMs ?? DEFAULTS.fetchTimeoutMs,
      nextCount: opts.nextCount ?? DEFAULTS.nextCount
    }
  }

  // now/next for one channel. The P2P guide (loopback, backed by the replicated
  // drive) is tried FIRST when the engine handed out a guideBase; a channel the
  // drive does not cover — or any loopback failure — falls back to the https
  // provider feed exactly as before. Returns empty ({now:null,next:[]}) rather
  // than throwing — a guide is never allowed to break the Info panel.
  async getNowNext (epgUrl?: string, epgId?: string, guideBase?: string): Promise<NowNext> {
    const empty: NowNext = { now: null, next: [] }
    if (guideBase) {
      try {
        const programs = await this.p2pPrograms(guideBase)
        if (programs && programs.length) return this.select(programs)
      } catch { /* engine down / malformed — fall through to https */ }
    }
    if (!epgUrl || !epgId) return empty
    try { await this.ensureFresh(epgUrl) } catch { /* keep any stale cache; fall through */ }
    const entry = this.cache.get(epgUrl)
    const programs = entry?.byId.get(epgId)
    if (!programs || !programs.length) return empty
    return this.select(programs)
  }

  // Full program list for one channel over a time range — getNowNext's big sibling,
  // for guide grids and timelines. Same source order and error posture: the P2P
  // guide first when a guideBase exists, the https provider feed as fallback, and
  // an empty list — never a throw — on any failure. Reuses the same caches, so a
  // guide screen over a category costs the fetches getNowNext already paid. The
  // default window (now − 6 h … now + 48 h) covers everything the two-day P2P
  // guide can hold; a program merely OVERLAPPING the range is included.
  async getPrograms (epgUrl?: string, epgId?: string, guideBase?: string, rangeStart?: number, rangeEnd?: number): Promise<EpgProgram[]> {
    const t = this.now()
    const start = rangeStart ?? t - 6 * 3600_000
    const end = rangeEnd ?? t + 48 * 3600_000
    let programs: EpgProgram[] | null = null
    if (guideBase) {
      try {
        const p = await this.p2pPrograms(guideBase)
        if (p && p.length) programs = p
      } catch { /* engine down / malformed — fall through to https */ }
    }
    if (!programs) {
      if (!epgUrl || !epgId) return []
      try { await this.ensureFresh(epgUrl) } catch { /* keep any stale cache; fall through */ }
      programs = this.cache.get(epgUrl)?.byId.get(epgId) ?? null
    }
    if (!programs || !programs.length) return []
    return programs.filter((p) => p.stop > start && p.start < end)
  }

  // Fresh-enough P2P programs for one channel (today + tomorrow files, merged and
  // sorted), or null when the drive does not cover the channel. Same freshness
  // economics as the https path: minRefetchMs floor, maxAgeMs ceiling, per-file
  // ETag revalidation (the engine answers 304 from the drive version).
  private async p2pPrograms (guideBase: string): Promise<EpgProgram[] | null> {
    let entry = this.p2p.get(guideBase)
    const t = this.now()
    if (entry) {
      if (entry.inflight) await entry.inflight
      const age = t - entry.fetchedAt
      const fresh = (entry.absent || t < entry.coversUntil) && age < this.opts.maxAgeMs
      if (!fresh && age >= this.opts.minRefetchMs) {
        const p = this.fetchP2pInto(guideBase, entry).finally(() => { const e = this.p2p.get(guideBase); if (e && e.inflight === p) e.inflight = null })
        entry.inflight = p
        await p
      }
    } else {
      entry = { fetchedAt: 0, etags: new Map(), byDay: new Map(), coversUntil: 0, absent: false, inflight: null }
      this.p2p.set(guideBase, entry)
      const p = this.fetchP2pInto(guideBase, entry).finally(() => { if (entry!.inflight === p) entry!.inflight = null })
      entry.inflight = p
      await p
    }
    if (entry.absent) return null
    const days = [...entry.byDay.keys()].sort()
    const programs: EpgProgram[] = []
    for (const d of days) programs.push(...entry.byDay.get(d)!)
    return programs
  }

  private async fetchP2pInto (guideBase: string, entry: P2pCache): Promise<void> {
    const today = new Date(this.now()).toISOString().slice(0, 10)
    const tomorrow = new Date(this.now() + 86400000).toISOString().slice(0, 10)
    const wanted = [today, tomorrow]
    // The UTC day rolling over changes the file set — drop days that fell out.
    for (const d of [...entry.byDay.keys()]) if (!wanted.includes(d)) { entry.byDay.delete(d); entry.etags.delete(d) }
    let missedToday = false
    for (const day of wanted) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), this.opts.fetchTimeoutMs)
      try {
        const headers: Record<string, string> = { accept: 'application/json' }
        const etag = entry.etags.get(day)
        if (etag) headers['if-none-match'] = etag
        const res = await this.fetchImpl(`${guideBase}/${day}.json`, { headers, signal: ac.signal })
        if (res.status === 304) continue // cached day still valid
        if (res.status === 404) { if (day === today) missedToday = true; entry.byDay.delete(day); entry.etags.delete(day); continue }
        if (!res.ok) throw new Error('epg p2p fetch failed: HTTP ' + res.status)
        const text = await res.text()
        if (text.length > this.opts.maxBytes) throw new Error('epg day file too large')
        const rows = JSON.parse(text)
        const programs: EpgProgram[] = []
        if (Array.isArray(rows)) {
          for (const p of rows) {
            const start = Date.parse(p?.start)
            const stop = Date.parse(p?.stop)
            const title = typeof p?.title === 'string' ? p.title : ''
            if (!title || Number.isNaN(start) || Number.isNaN(stop) || stop <= start) continue
            programs.push({ title, start, stop })
          }
        }
        programs.sort((a, b) => a.start - b.start)
        if (programs.length) entry.byDay.set(day, programs); else entry.byDay.delete(day)
        const e = res.headers.get('etag')
        if (e) entry.etags.set(day, e); else entry.etags.delete(day)
      } finally { clearTimeout(timer) }
    }
    entry.fetchedAt = this.now()
    entry.absent = missedToday && entry.byDay.size === 0
    entry.coversUntil = 0
    for (const programs of entry.byDay.values()) { const last = programs[programs.length - 1]; if (last && last.stop > entry.coversUntil) entry.coversUntil = last.stop }
  }

  // Pick current + upcoming from a start-sorted list. A program is "now" when it
  // straddles the clock; everything starting at/after now is upcoming.
  private select (programs: EpgProgram[]): NowNext {
    const t = this.now()
    let now: EpgProgram | null = null
    const next: EpgProgram[] = []
    for (const p of programs) {
      if (p.start <= t && t < p.stop) now = p
      else if (p.start >= t && next.length < this.opts.nextCount) next.push(p)
    }
    return { now, next }
  }

  // Fetch/revalidate the feed unless a fresh-enough cache already covers "now".
  private ensureFresh (url: string): Promise<void> {
    const entry = this.cache.get(url)
    const t = this.now()
    if (entry) {
      if (entry.inflight) return entry.inflight // coalesce concurrent callers
      const age = t - entry.fetchedAt
      const stillCovers = t < entry.coversUntil
      // Fresh enough: covers the clock AND recently fetched → no network.
      if (stillCovers && age < this.opts.maxAgeMs) return Promise.resolve()
      // Otherwise refetch — but never hammer: honor the minimum interval.
      if (age < this.opts.minRefetchMs) return Promise.resolve()
    }
    const p = this.fetchInto(url, entry ?? null).finally(() => {
      const e = this.cache.get(url)
      if (e && e.inflight === p) e.inflight = null
    })
    if (entry) entry.inflight = p
    else this.cache.set(url, { fetchedAt: 0, etag: null, byId: new Map(), coversUntil: 0, inflight: p })
    return p
  }

  private async fetchInto (url: string, prev: FeedCache | null): Promise<void> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.opts.fetchTimeoutMs)
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (prev?.etag) headers['if-none-match'] = prev.etag
      const res = await this.fetchImpl(url, { headers, signal: ac.signal })
      if (res.status === 304 && prev) { prev.fetchedAt = this.now(); return } // unchanged — refresh the timestamp only
      if (!res.ok) throw new Error('epg fetch failed: HTTP ' + res.status)
      const text = await res.text()
      if (text.length > this.opts.maxBytes) throw new Error('epg feed too large')
      const byId = index(JSON.parse(text))
      let coversUntil = 0
      for (const programs of byId.values()) { const last = programs[programs.length - 1]; if (last && last.stop > coversUntil) coversUntil = last.stop }
      this.cache.set(url, { fetchedAt: this.now(), etag: res.headers.get('etag'), byId, coversUntil, inflight: prev?.inflight ?? null })
    } finally { clearTimeout(timer) }
  }
}

// Clamped 0..1 elapsed fraction of a program at `now` — the guide's progress-bar
// math, kept pure so any renderer can call it per frame. 0 before start, 1 at/after
// stop; a degenerate program (stop <= start) reads as finished once the clock
// reaches its start, never NaN/Infinity.
export function programProgress (program: EpgProgram, now: number): number {
  if (now < program.start) return 0
  if (now >= program.stop || program.stop <= program.start) return 1
  return (now - program.start) / (program.stop - program.start)
}

// Parse a provider feed ({channels:[{id, epg:[{title,start,stop}]}]} or a bare
// array) into id -> sorted programs. Malformed entries are skipped, never fatal:
// the feed is third-party data.
function index (feed: any): Map<string, EpgProgram[]> {
  const list = Array.isArray(feed) ? feed : Array.isArray(feed?.channels) ? feed.channels : []
  const byId = new Map<string, EpgProgram[]>()
  for (const ch of list) {
    const id = ch && ch.id != null ? String(ch.id) : ''
    if (!id || !Array.isArray(ch.epg)) continue
    const programs: EpgProgram[] = []
    for (const p of ch.epg) {
      const start = Date.parse(p?.start)
      const stop = Date.parse(p?.stop)
      const title = typeof p?.title === 'string' ? p.title : ''
      if (!title || Number.isNaN(start) || Number.isNaN(stop) || stop <= start) continue
      programs.push({ title, start, stop })
    }
    if (programs.length) { programs.sort((a, b) => a.start - b.start); byId.set(id, programs) }
  }
  return byId
}

// App-wide singleton — the Info panel shares one cache across every channel so a
// whole category costs one fetch.
export const epg = new EpgService()
