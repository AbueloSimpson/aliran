// The external VOD provider client (S53 / D2). Pins the four things that make this
// module safe to point at somebody else's server:
//   1. credential resolution — the dev override wins, otherwise the LOGGED-IN pair
//      (app username -> username, app PASSWORD -> token);
//   2. the token never escapes into an error, a result or a log line;
//   3. the giant list payload is stripped to the grid's fields and sorted newest-first,
//      and both the bare-array and wrapped-object shapes are accepted;
//   4. extractMovieInfo answers over the shapes we GUESSED (TODO(S53d): these fixtures
//      get swapped for the real captured response — that swap should show up here).

import { listMovies, getMovieInfo, extractMovieInfo, resolveCredentials, clearVodCache, type VodItem } from '../src/vod/zencontent'
import type { VodConfig } from '@aliran/react-native'
import { backend } from '../src/worklet'

const CONFIG: VodConfig = {
  enabled: true,
  apiBase: 'https://provider.example/vod/api',
  service: 'svc',
  sources: { movies: 'movies-src' },
  params: { hm: '1', hs: '2' }
}

const DEV = { username: 'DEV_USER', token: 'DEV_TOKEN' }
const SAVED = { username: 'viewer1', password: 'viewer-password' }

// One provider row, verbatim in the documented shape (extra fields included on
// purpose — they must be dropped).
function row (over: Record<string, unknown> = {}) {
  return {
    id: '55157',
    name: 'Sick Girl (2023)',
    name_original: 'Sick Girl',
    icon: 'https://art.example/55157.jpg',
    added: '1783037028',
    source: 'movies-src',
    anio: '2023',
    categories: [4],
    plot: 'a very long synopsis that must not survive the strip',
    ...over
  }
}

function jsonResponse (body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response
}

function fetchReturning (body: unknown, status = 200) {
  return jest.fn(async () => jsonResponse(body, status)) as unknown as jest.MockedFunction<typeof fetch>
}

beforeEach(() => { clearVodCache(); backend.creds = null })
afterEach(() => { jest.restoreAllMocks() })

test('the dev override wins over the logged-in pair', () => {
  expect(resolveCredentials({ dev: DEV, saved: SAVED })).toEqual({ username: 'DEV_USER', token: 'DEV_TOKEN' })
})

test('without a dev block the LOGIN pair is the provider pair (password -> token)', () => {
  expect(resolveCredentials({ dev: null, saved: SAVED })).toEqual({ username: 'viewer1', token: 'viewer-password' })
})

test('no dev block and nobody logged in = no call is possible', async () => {
  const fetchImpl = fetchReturning([])
  expect(resolveCredentials({ dev: null, saved: null })).toBeNull()
  const res = await listMovies(CONFIG, { dev: null, saved: null, fetchImpl })
  expect(res).toEqual({ ok: false, error: 'auth' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('falls back to the backend singleton when no credentials are injected', async () => {
  backend.creds = { ...SAVED }
  const fetchImpl = fetchReturning([row()])
  await listMovies(CONFIG, { dev: null, fetchImpl })
  const url = String((fetchImpl.mock.calls[0] as unknown[])[0])
  expect(url).toContain('username=viewer1')
  expect(url).toContain('token=viewer-password')
})

test('composes the documented query, with the panel params and browser headers', async () => {
  const fetchImpl = fetchReturning([row()])
  await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl })
  const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
  expect(url.startsWith('https://provider.example/vod/api/getMovies.php?')).toBe(true)
  expect(url).toContain('service=svc')
  expect(url).toContain('source=movies-src')
  expect(url).toContain('username=DEV_USER')
  expect(url).toContain('token=DEV_TOKEN')
  expect(url).toContain('hm=1')
  expect(url).toContain('hs=2')
  const headers = init.headers as Record<string, string>
  expect(headers['User-Agent']).toContain('Mozilla/5.0')
  expect(headers.Accept).toBe('application/json, text/plain, */*')
})

test('a non-https apiBase is refused without ever dialing', async () => {
  const fetchImpl = fetchReturning([row()])
  const res = await listMovies({ ...CONFIG, apiBase: 'http://provider.example/api' }, { dev: DEV, saved: null, fetchImpl })
  expect(res.ok).toBe(false)
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('items are stripped to the grid fields and sorted newest-added first', async () => {
  const fetchImpl = fetchReturning([
    row({ id: '1', name: 'Older', added: '100' }),
    row({ id: '2', name: 'Newest', added: '900' }),
    row({ id: '3', name: 'Middle', added: '500' }),
    row({ id: '4', name: '', added: '999' }) // unnameable -> dropped
  ])
  const res = await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl })
  expect(res.ok).toBe(true)
  const items = (res as { ok: true; items: VodItem[] }).items
  expect(items.map(i => i.name)).toEqual(['Newest', 'Middle', 'Older'])
  expect(Object.keys(items[0]).sort()).toEqual(['added', 'anio', 'categories', 'icon', 'id', 'name', 'nameOriginal'])
  expect(items[0]).toMatchObject({ id: '2', nameOriginal: 'Sick Girl', anio: '2023', categories: [4], added: 900 })
  expect((items[0] as unknown as Record<string, unknown>).plot).toBeUndefined()
})

test('a wrapped list object is accepted as well as a bare array', async () => {
  const fetchImpl = fetchReturning({ status: 'ok', movies: [row({ id: '7', name: 'Wrapped' })] })
  const res = await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl })
  expect(res).toEqual({ ok: true, items: [expect.objectContaining({ id: '7', name: 'Wrapped' })] })
})

test('the second call inside the TTL is served from the session cache', async () => {
  const fetchImpl = fetchReturning([row()])
  await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl })
  await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('no movies source = an empty catalog, not an error', async () => {
  const fetchImpl = fetchReturning([row()])
  const res = await listMovies({ ...CONFIG, sources: {} }, { dev: DEV, saved: null, fetchImpl })
  expect(res).toEqual({ ok: true, items: [] })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('401 is auth, 500 is network, non-JSON is bad-response', async () => {
  const deps = { dev: DEV, saved: null }
  expect(await listMovies(CONFIG, { ...deps, fetchImpl: fetchReturning([], 401) })).toEqual({ ok: false, error: 'auth' })
  clearVodCache()
  expect(await listMovies(CONFIG, { ...deps, fetchImpl: fetchReturning([], 500) })).toEqual({ ok: false, error: 'network' })
  clearVodCache()
  const html = jest.fn(async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' })) as unknown as typeof fetch
  expect(await listMovies(CONFIG, { ...deps, fetchImpl: html })).toEqual({ ok: false, error: 'bad-response' })
})

// The security property of the whole module: the token IS a viewer password, and the
// only place it may ever appear is the outgoing query string.
test('a failure carrying the full URL leaks neither the token nor the password anywhere', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  const boom = jest.fn(async () => {
    throw new Error('Network request failed: GET https://provider.example/vod/api/getMovies.php?service=svc&source=movies-src&username=viewer1&token=viewer-password&hm=1')
  }) as unknown as typeof fetch
  const res = await listMovies(CONFIG, { dev: null, saved: SAVED, fetchImpl: boom })
  expect(res).toEqual({ ok: false, error: 'network' })
  const logged = warn.mock.calls.flat().map(String).join(' ')
  expect(logged).toContain('[vod]')
  expect(logged).not.toContain('viewer-password')
  expect(logged).not.toContain('token=')
  expect(JSON.stringify(res)).not.toContain('viewer-password')
})

test('a dev token in a thrown message is scrubbed too', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  const boom = jest.fn(async () => { throw new Error('failed for DEV_TOKEN while connecting') }) as unknown as typeof fetch
  await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl: boom })
  expect(warn.mock.calls.flat().map(String).join(' ')).not.toContain('DEV_TOKEN')
})

// --- extractMovieInfo: the one unknown-shape function (TODO(S53d)) -----------------

test('extractMovieInfo: a url at the top level', () => {
  expect(extractMovieInfo({ url: 'https://cdn.example/movie.mp4', duration: 5525 }))
    .toEqual({ ok: true, url: 'https://cdn.example/movie.mp4', durationSec: 5525 })
})

test('extractMovieInfo: movie_data.direct_source + duration_secs', () => {
  expect(extractMovieInfo({ movie_data: { direct_source: 'https://cdn.example/a.mkv', duration_secs: '7200' } }))
    .toEqual({ ok: true, url: 'https://cdn.example/a.mkv', durationSec: 7200 })
})

test('extractMovieInfo: info.stream_url + an h:mm:ss runtime', () => {
  expect(extractMovieInfo({ info: { stream_url: 'https://cdn.example/b.m3u8', duration: '01:32:05' } }))
    .toEqual({ ok: true, url: 'https://cdn.example/b.m3u8', durationSec: 5525 })
})

test('extractMovieInfo: a url with no runtime at all', () => {
  expect(extractMovieInfo({ movie: { link: 'https://cdn.example/c.mp4' } }))
    .toEqual({ ok: true, url: 'https://cdn.example/c.mp4', durationSec: null })
})

test('extractMovieInfo: malformed shapes are bad-response, never a throw', () => {
  expect(extractMovieInfo({ info: { title: 'no url here' } })).toEqual({ ok: false, error: 'bad-response' })
  expect(extractMovieInfo({ url: 'not-a-url' })).toEqual({ ok: false, error: 'bad-response' })
  expect(extractMovieInfo(null)).toEqual({ ok: false, error: 'bad-response' })
  expect(extractMovieInfo('a string')).toEqual({ ok: false, error: 'bad-response' })
  expect(extractMovieInfo([1, 2, 3])).toEqual({ ok: false, error: 'bad-response' })
})

test('getMovieInfo asks for the documented detail endpoint and shapes the answer', async () => {
  const fetchImpl = fetchReturning({ movie_data: { url: 'https://cdn.example/x.mp4', duration: '90:00' } })
  const res = await getMovieInfo(CONFIG, '55157', { dev: DEV, saved: null, fetchImpl })
  const url = String((fetchImpl.mock.calls[0] as unknown[])[0])
  expect(url).toContain('/getMovieInfo.php?')
  expect(url).toContain('id=55157')
  expect(url).toContain('version=2')
  expect(res).toEqual({ ok: true, url: 'https://cdn.example/x.mp4', durationSec: 5400 })
})
