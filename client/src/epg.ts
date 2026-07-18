// Remote EPG (S27): the program guide for a source-imported channel lives in the
// SAME provider JSON the panel pulls — the catalog never carries schedule data (it
// would grow the replicated bee forever). Each imported Stream carries pointers:
// `epgUrl` (the public https feed) + `epgId` (its id inside that feed). The app
// fetches the feed on demand, indexes channels[].id, and reads now/next locally.
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

export class EpgService {
  private cache = new Map<string, FeedCache>()
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

  // now/next for one channel. Ensures the feed is fresh enough (fetches/revalidates
  // if needed), then selects locally. Returns empty ({now:null,next:[]}) rather than
  // throwing — a guide is never allowed to break the Info panel.
  async getNowNext (epgUrl?: string, epgId?: string): Promise<NowNext> {
    const empty: NowNext = { now: null, next: [] }
    if (!epgUrl || !epgId) return empty
    try { await this.ensureFresh(epgUrl) } catch { /* keep any stale cache; fall through */ }
    const entry = this.cache.get(epgUrl)
    const programs = entry?.byId.get(epgId)
    if (!programs || !programs.length) return empty
    return this.select(programs)
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
