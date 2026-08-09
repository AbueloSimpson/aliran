// EpgService (S27): fetch a provider JSON once per URL, index channels[].id, and
// read now/next locally against an injected clock. All network is a fake fetch so
// the test is deterministic and offline.

import { EpgService, programProgress } from '@aliran/react-native'

const HOUR = 3600_000
const BASE = Date.parse('2026-07-18T18:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

// A two-channel feed: 'moon-cat' has 3 back-to-back 1 h programs from BASE; 'ninja-run'
// one. Includes a malformed program (bad stop) that must be skipped.
function feed () {
  return {
    channels: [
      { id: 'moon-cat', epg: [
        { title: 'Moon Cat A', start: iso(BASE), stop: iso(BASE + HOUR) },
        { title: 'Moon Cat B', start: iso(BASE + HOUR), stop: iso(BASE + 2 * HOUR) },
        { title: 'Moon Cat C', start: iso(BASE + 2 * HOUR), stop: iso(BASE + 3 * HOUR) },
        { title: 'Broken', start: iso(BASE + 3 * HOUR), stop: 'not-a-date' }
      ] },
      { id: 'ninja-run', epg: [{ title: 'Ninja Run', start: iso(BASE), stop: iso(BASE + HOUR) }] }
    ]
  }
}

// Fake fetch: counts calls, honors If-None-Match against a settable etag.
function makeFetch (body: object, etag = '"v1"') {
  const state = { calls: 0, lastHeaders: {} as Record<string, string>, etag, body }
  const impl = async (_url: string, init?: any) => {
    state.calls++
    state.lastHeaders = (init?.headers as Record<string, string>) || {}
    if (state.lastHeaders['if-none-match'] && state.lastHeaders['if-none-match'] === state.etag) {
      return { status: 304, ok: false, headers: { get: () => state.etag }, text: async () => '' } as any
    }
    return { status: 200, ok: true, headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? state.etag : null) }, text: async () => JSON.stringify(state.body) } as any
  }
  return Object.assign(impl, { state })
}

test('parses the feed and selects now + next for a channel', async () => {
  const f = makeFetch(feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE + 30 * 60_000 }) // 30 min into program A
  const { now, next } = await svc.getNowNext('https://epg.example/anime.json', 'moon-cat')
  expect(now?.title).toBe('Moon Cat A')
  expect(next.map(p => p.title)).toEqual(['Moon Cat B', 'Moon Cat C']) // Broken skipped
})

test('caches per URL — a second channel from the same feed does not refetch', async () => {
  const f = makeFetch(feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE + 30 * 60_000 })
  await svc.getNowNext('https://epg.example/anime.json', 'moon-cat')
  const other = await svc.getNowNext('https://epg.example/anime.json', 'ninja-run')
  expect(other.now?.title).toBe('Ninja Run')
  expect(f.state.calls).toBe(1) // one fetch served both channels
})

test('missing pointers or unknown channel id yield an empty guide, no fetch', async () => {
  const f = makeFetch(feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE })
  expect(await svc.getNowNext(undefined, 'moon-cat')).toEqual({ now: null, next: [] })
  expect(await svc.getNowNext('https://epg.example/anime.json', undefined)).toEqual({ now: null, next: [] })
  expect(f.state.calls).toBe(0)
  const unknown = await svc.getNowNext('https://epg.example/anime.json', 'no-such') // triggers one fetch, but no match
  expect(unknown).toEqual({ now: null, next: [] })
  expect(f.state.calls).toBe(1)
})

test('revalidates with ETag once coverage is spent; a 304 keeps the cached data', async () => {
  let clock = BASE + 30 * 60_000
  const f = makeFetch(feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => clock, minRefetchMs: 0 })
  await svc.getNowNext('https://epg.example/anime.json', 'moon-cat')
  expect(f.state.calls).toBe(1)

  // Jump past the feed's last stop (coverage spent) → a revalidation fires…
  clock = BASE + 4 * HOUR
  const after = await svc.getNowNext('https://epg.example/anime.json', 'moon-cat')
  expect(f.state.calls).toBe(2)
  expect(f.state.lastHeaders['if-none-match']).toBe('"v1"') // conditional request
  // 304 → data retained (all programs are in the past now, so nothing is "now")
  expect(after.now).toBeNull()
})

test('a fresh cache that still covers the clock does not hit the network again', async () => {
  const f = makeFetch(feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE + 90 * 60_000 }) // in program B
  await svc.getNowNext('https://epg.example/anime.json', 'moon-cat')
  await svc.getNowNext('https://epg.example/anime.json', 'moon-cat')
  expect(f.state.calls).toBe(1)
})

test('a failed fetch degrades to an empty guide, never throws', async () => {
  const failing = Object.assign(async () => { throw new Error('offline') }, { state: {} })
  const svc = new EpgService({ fetchImpl: failing as any, now: () => BASE })
  await expect(svc.getNowNext('https://epg.example/anime.json', 'moon-cat')).resolves.toEqual({ now: null, next: [] })
})

test('concurrent calls for the same URL coalesce into one fetch', async () => {
  const f = makeFetch(feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE + 30 * 60_000 })
  await Promise.all([
    svc.getNowNext('https://epg.example/anime.json', 'moon-cat'),
    svc.getNowNext('https://epg.example/anime.json', 'ninja-run')
  ])
  expect(f.state.calls).toBe(1)
})

// ---- getPrograms (WS0) — the guide grid's full-range accessor ----

// Fake fetch that routes like the real world: /<YYYY-MM-DD>.json is the engine's
// loopback P2P guide (404 when the day map has no file), anything else is the https
// provider feed (throws when no body was given — the offline case).
function makeGuideFetch (days: Record<string, object[]>, body?: object) {
  const state = { calls: 0, dayCalls: 0, feedCalls: 0 }
  const impl = async (url: string, _init?: any) => {
    state.calls++
    const m = /\/(\d{4}-\d{2}-\d{2})\.json$/.exec(url)
    if (m) {
      state.dayCalls++
      const rows = days[m[1]]
      if (!rows) return { status: 404, ok: false, headers: { get: () => null }, text: async () => '' } as any
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(rows) } as any
    }
    state.feedCalls++
    if (!body) throw new Error('offline')
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) } as any
  }
  return Object.assign(impl, { state })
}

// BASE is 2026-07-18T18:00Z, so the P2P guide wants 2026-07-18 + 2026-07-19.
const TODAY = '2026-07-18'
const TOMORROW = '2026-07-19'

test('getPrograms serves the P2P guide first — today + tomorrow merged, https untouched', async () => {
  const f = makeGuideFetch({
    [TODAY]: [{ title: 'Drive A', start: iso(BASE), stop: iso(BASE + HOUR) }],
    [TOMORROW]: [{ title: 'Drive B', start: iso(BASE + 24 * HOUR), stop: iso(BASE + 25 * HOUR) }]
  }, feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE + 30 * 60_000 })
  const programs = await svc.getPrograms('https://epg.example/anime.json', 'moon-cat', 'http://127.0.0.1:9999/epg/v1/moon-cat')
  expect(programs.map(p => p.title)).toEqual(['Drive A', 'Drive B']) // both inside now−6h…now+48h
  expect(f.state.feedCalls).toBe(0) // the drive answered — the provider was never asked
})

test('getPrograms falls back to the https feed when the drive does not cover the channel', async () => {
  const f = makeGuideFetch({}, feed()) // every day file 404s → channel absent from the drive
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE + 30 * 60_000 })
  const programs = await svc.getPrograms('https://epg.example/anime.json', 'moon-cat', 'http://127.0.0.1:9999/epg/v1/moon-cat')
  expect(programs.map(p => p.title)).toEqual(['Moon Cat A', 'Moon Cat B', 'Moon Cat C'])
  expect(f.state.feedCalls).toBe(1)
})

test('getPrograms range filter keeps any program OVERLAPPING the range, drops the rest', async () => {
  const f = makeFetch(feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE + 30 * 60_000 })
  // Range straddles the A→B boundary: A overlaps its start edge, B its end edge, C is out.
  const programs = await svc.getPrograms('https://epg.example/anime.json', 'moon-cat', undefined, BASE + 30 * 60_000, BASE + 90 * 60_000)
  expect(programs.map(p => p.title)).toEqual(['Moon Cat A', 'Moon Cat B'])
})

test('getPrograms never throws — network failure on both paths yields []', async () => {
  const failing = Object.assign(async () => { throw new Error('offline') }, { state: {} })
  const svc = new EpgService({ fetchImpl: failing as any, now: () => BASE })
  await expect(svc.getPrograms('https://epg.example/anime.json', 'moon-cat', 'http://127.0.0.1:9999/epg/v1/moon-cat')).resolves.toEqual([])
  // And guide-less inputs are an empty guide with no fetch at all.
  const f = makeFetch(feed())
  const idle = new EpgService({ fetchImpl: f as any, now: () => BASE })
  await expect(idle.getPrograms(undefined, undefined, undefined)).resolves.toEqual([])
  expect(f.state.calls).toBe(0)
})

test('programProgress clamps to 0..1 and survives degenerate programs', () => {
  const p = { title: 'X', start: 1000, stop: 2000 }
  expect(programProgress(p, 500)).toBe(0) // before start
  expect(programProgress(p, 1000)).toBe(0) // at start
  expect(programProgress(p, 1500)).toBe(0.5)
  expect(programProgress(p, 2000)).toBe(1) // at stop
  expect(programProgress(p, 9999)).toBe(1) // after stop
  const zero = { title: 'Z', start: 1000, stop: 1000 } // zero-length: done once reached, never NaN
  expect(programProgress(zero, 999)).toBe(0)
  expect(programProgress(zero, 1000)).toBe(1)
  const inverted = { title: 'I', start: 2000, stop: 1000 } // stop < start: same defensive read
  expect(programProgress(inverted, 1500)).toBe(0)
  expect(programProgress(inverted, 2500)).toBe(1)
})
