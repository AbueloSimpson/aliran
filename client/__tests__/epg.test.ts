// EpgService (S27): fetch a provider JSON once per URL, index channels[].id, and
// read now/next locally against an injected clock. All network is a fake fetch so
// the test is deterministic and offline.

import { EpgService } from '@aliran/react-native'

const HOUR = 3600_000
const BASE = Date.parse('2026-07-18T18:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

// A two-channel feed: 'conan' has 3 back-to-back 1 h programs from BASE; 'naruto'
// one. Includes a malformed program (bad stop) that must be skipped.
function feed () {
  return {
    channels: [
      { id: 'conan', epg: [
        { title: 'Conan A', start: iso(BASE), stop: iso(BASE + HOUR) },
        { title: 'Conan B', start: iso(BASE + HOUR), stop: iso(BASE + 2 * HOUR) },
        { title: 'Conan C', start: iso(BASE + 2 * HOUR), stop: iso(BASE + 3 * HOUR) },
        { title: 'Broken', start: iso(BASE + 3 * HOUR), stop: 'not-a-date' }
      ] },
      { id: 'naruto', epg: [{ title: 'Naruto', start: iso(BASE), stop: iso(BASE + HOUR) }] }
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
  const { now, next } = await svc.getNowNext('https://epg.example/anime.json', 'conan')
  expect(now?.title).toBe('Conan A')
  expect(next.map(p => p.title)).toEqual(['Conan B', 'Conan C']) // Broken skipped
})

test('caches per URL — a second channel from the same feed does not refetch', async () => {
  const f = makeFetch(feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE + 30 * 60_000 })
  await svc.getNowNext('https://epg.example/anime.json', 'conan')
  const other = await svc.getNowNext('https://epg.example/anime.json', 'naruto')
  expect(other.now?.title).toBe('Naruto')
  expect(f.state.calls).toBe(1) // one fetch served both channels
})

test('missing pointers or unknown channel id yield an empty guide, no fetch', async () => {
  const f = makeFetch(feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE })
  expect(await svc.getNowNext(undefined, 'conan')).toEqual({ now: null, next: [] })
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
  await svc.getNowNext('https://epg.example/anime.json', 'conan')
  expect(f.state.calls).toBe(1)

  // Jump past the feed's last stop (coverage spent) → a revalidation fires…
  clock = BASE + 4 * HOUR
  const after = await svc.getNowNext('https://epg.example/anime.json', 'conan')
  expect(f.state.calls).toBe(2)
  expect(f.state.lastHeaders['if-none-match']).toBe('"v1"') // conditional request
  // 304 → data retained (all programs are in the past now, so nothing is "now")
  expect(after.now).toBeNull()
})

test('a fresh cache that still covers the clock does not hit the network again', async () => {
  const f = makeFetch(feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE + 90 * 60_000 }) // in program B
  await svc.getNowNext('https://epg.example/anime.json', 'conan')
  await svc.getNowNext('https://epg.example/anime.json', 'conan')
  expect(f.state.calls).toBe(1)
})

test('a failed fetch degrades to an empty guide, never throws', async () => {
  const failing = Object.assign(async () => { throw new Error('offline') }, { state: {} })
  const svc = new EpgService({ fetchImpl: failing as any, now: () => BASE })
  await expect(svc.getNowNext('https://epg.example/anime.json', 'conan')).resolves.toEqual({ now: null, next: [] })
})

test('concurrent calls for the same URL coalesce into one fetch', async () => {
  const f = makeFetch(feed())
  const svc = new EpgService({ fetchImpl: f as any, now: () => BASE + 30 * 60_000 })
  await Promise.all([
    svc.getNowNext('https://epg.example/anime.json', 'conan'),
    svc.getNowNext('https://epg.example/anime.json', 'naruto')
  ])
  expect(f.state.calls).toBe(1)
})
