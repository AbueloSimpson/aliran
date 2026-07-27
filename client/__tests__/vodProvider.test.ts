// The external VOD provider client (S53 / D2). Pins the four things that make this
// module safe to point at somebody else's server:
//   1. credential resolution — the dev override wins, otherwise the LOGGED-IN pair
//      (app username -> username, app PASSWORD -> token);
//   2. the token never escapes into an error or a log line — its only two outlets
//      are the outgoing query string and the playable URL (the provider's `path`
//      embeds a `{token}` placeholder that fillToken substitutes: the player cannot
//      dial the stream without it);
//   3. the giant list payload is stripped to the grid's fields and sorted newest-first,
//      and both the bare-array and wrapped-object shapes are accepted;
//   4. extractMovieInfo answers over the REAL captured response (S53d, 2026-07-27:
//      a flat object, url in `path`/`path_1080`/`path_720`, runtime as `duration`
//      "hh:mm:ss") — plus the pre-capture wide-guess shapes, kept as a fallback for
//      other Xtream-style providers. Fixture hosts are sanitized; the real capture
//      structure is preserved verbatim.

// S54a adds the SERIES half, pinned in exactly the same cases as tools/desktop-vod-test.mjs:
//   5. ONE download feeds movies, series AND the genre names (design D1) — the fetch
//      stub proves it by counting calls;
//   6. the series list is picked STRICTLY from the wrapper's `series` key — never the
//      first array it finds, which would render the movie catalog as "Series";
//   7. a series row's year comes from `aired_first` when the provider says `anio:"0"`,
//      and stays EMPTY for anything else (D2);
//   8. getSeriesInfo answers over the real captured series shape (D3): seasons +
//      episodes stripped, "00:51:00" -> 3060, the `{token}` placeholder substituted
//      URL-encoded, a cleartext episode path reduced to '' rather than dialed, and no
//      series source at all refused WITHOUT a request.

import {
  listMovies, listSeries, listCategories, getMovieInfo, getSeriesInfo,
  extractMovieInfo, extractSeriesInfo, resolveCredentials, clearVodCache,
  pickSeriesList, pickCategories, stripSeriesItem, fillToken,
  type VodItem, type VodSeriesDetail
} from '../src/vod/zencontent'
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

// One SERIES row: the movie shape plus aired_first/aired_last, and (as the live
// provider actually answers) anio:"0" — the year has to come from aired_first.
function seriesRow (over: Record<string, unknown> = {}) {
  return {
    id: '900',
    name: 'Serie Uno',
    name_original: 'Serie Uno',
    icon: 'https://art.example/900.jpg',
    added: '800',
    source: 'series',
    anio: '0',
    aired_first: '20260402',
    aired_last: '20260718',
    categories: [7],
    ...over
  }
}

// The ONE wrapper the list endpoint answers: both catalogs and the genre vocabulary in
// a single response (structure verbatim from the live probe, hosts sanitized).
function wrapper (over: Record<string, unknown> = {}) {
  return {
    movies: [row({ id: '1', name: 'Older movie', added: '100' }), row({ id: '2', name: 'Newest movie', added: '900' })],
    series: [seriesRow({ id: '900', name: 'Serie Uno', added: '800' }), seriesRow({ id: '901', name: 'Serie Dos', added: '400' })],
    movies_modified: '1783037028',
    series_modified: '1783037029',
    movies_hash: 'aaaa',
    series_hash: 'bbbb',
    categories: ['Action', 'Adventure', 'Animation'],
    ...over
  }
}

const BOTH: VodConfig = { ...CONFIG, sources: { movies: 'movies-src', series: 'series-src' } }

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

// The example file ships these words; a config copied but never filled in must fall
// through to the viewer pass-off instead of sending them to the provider.
test('the example placeholders are ignored, not sent', () => {
  expect(resolveCredentials({ dev: { username: 'YOUR_USERNAME', token: 'YOUR_TOKEN' }, saved: SAVED }))
    .toEqual({ username: 'viewer1', token: 'viewer-password' })
  expect(resolveCredentials({ dev: { username: 'YOUR_USERNAME', token: 'YOUR_TOKEN' }, saved: null })).toBeNull()
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

// --- extractMovieInfo: shape verified live (S53d, 2026-07-27) ----------------------

// The real getMovieInfo response, captured live and sanitized: hosts are example
// domains and the free-text metadata is shortened, but every KEY, the `{token}`
// placeholders, and the "hh:mm:ss" duration are structure-verbatim.
function realInfo (over: Record<string, unknown> = {}) {
  return {
    director: 'Cho Il',
    duration: '01:38:32',
    genre: 'Action, Horror, Science Fiction',
    plot: 'a synopsis',
    cast: 'Yoo Ah-in, Park Shin-hye',
    releasedate: '2020',
    rating: '7.214',
    height: '1080',
    trailer: '',
    path: 'https://cdn.example/vod56487Zz/index.m3u8?token={token}',
    tmdb_id: '614696',
    path_1080: 'https://cdn.example/vod56487Zz/vod56487Zz_1080.mp4/index.m3u8?token={token}',
    path_720: 'https://cdn.example/vod56487Zz/vod56487Zz_720.mp4/index.m3u8?token={token}',
    related: [{ type: 'related', list: null }],
    ...over
  }
}

test('extractMovieInfo: the REAL shape — `path` master + "hh:mm:ss" duration, placeholder intact', () => {
  expect(extractMovieInfo(realInfo()))
    .toEqual({ ok: true, url: 'https://cdn.example/vod56487Zz/index.m3u8?token={token}', durationSec: 5912 })
})

test('extractMovieInfo: no master path -> the 1080 variant', () => {
  const res = extractMovieInfo(realInfo({ path: undefined }))
  expect(res).toMatchObject({ ok: true, url: 'https://cdn.example/vod56487Zz/vod56487Zz_1080.mp4/index.m3u8?token={token}' })
})

test('fillToken: substitutes URL-encoded, passes non-placeholder URLs through, refuses cleartext', () => {
  expect(fillToken('https://cdn.example/v/index.m3u8?token={token}', 'p@ss w0rd'))
    .toBe('https://cdn.example/v/index.m3u8?token=p%40ss%20w0rd')
  expect(fillToken('https://cdn.example/x.mp4', 'tok')).toBe('https://cdn.example/x.mp4')
  expect(fillToken('http://cdn.example/v/index.m3u8?token={token}', 'tok')).toBe('')
})

test('getMovieInfo end to end over the REAL shape: path chosen, token filled, runtime parsed', async () => {
  const fetchImpl = fetchReturning(realInfo())
  const res = await getMovieInfo(CONFIG, '56487', { dev: DEV, saved: null, fetchImpl })
  expect(res).toEqual({ ok: true, url: 'https://cdn.example/vod56487Zz/index.m3u8?token=DEV_TOKEN', durationSec: 5912 })
})

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

// --- S54a: one download, three lists (design D1) ------------------------------------

const items = (r: unknown) => (r as { ok: true; items: VodItem[] }).items
const detailOf = (r: unknown) => (r as { ok: true; detail: VodSeriesDetail }).detail

test('ONE download feeds movies, series AND the genre names', async () => {
  const fetchImpl = fetchReturning(wrapper())
  const deps = { dev: DEV, saved: null, fetchImpl }
  const movies = await listMovies(BOTH, deps)
  const series = await listSeries(BOTH, deps)
  const cats = await listCategories(BOTH, deps)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('source=movies-src')
  expect(items(movies).map(i => i.name)).toEqual(['Newest movie', 'Older movie'])
  expect(items(series).map(i => i.name)).toEqual(['Serie Uno', 'Serie Dos'])
  expect(cats).toEqual({ ok: true, categories: ['Action', 'Adventure', 'Animation'] })
  // A series row is stripped to exactly the same grid fields as a movie row.
  expect(Object.keys(items(series)[0]).sort()).toEqual(['added', 'anio', 'categories', 'icon', 'id', 'name', 'nameOriginal'])
})

test('a series-only operator dials the SERIES source, and the movie grid stays empty without a call', async () => {
  const fetchImpl = fetchReturning(wrapper())
  const seriesOnly = { ...CONFIG, sources: { series: 'series-src' } }
  const deps = { dev: DEV, saved: null, fetchImpl }
  expect(await listMovies(seriesOnly, deps)).toEqual({ ok: true, items: [] })
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(items(await listSeries(seriesOnly, deps))).toHaveLength(2)
  expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('source=series-src')
})

test('no series source = an empty series catalog, not an error — and no call', async () => {
  const fetchImpl = fetchReturning(wrapper())
  expect(await listSeries(CONFIG, { dev: DEV, saved: null, fetchImpl })).toEqual({ ok: true, items: [] })
  expect(await listCategories({ ...CONFIG, sources: {} }, { dev: DEV, saved: null, fetchImpl })).toEqual({ ok: true, categories: [] })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('whichever list asks first pays; the other two are cache hits', async () => {
  const fetchImpl = fetchReturning(wrapper())
  const deps = { dev: DEV, saved: null, fetchImpl }
  await listSeries(BOTH, deps)
  await listMovies(BOTH, deps)
  await listCategories(BOTH, deps)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

// --- S54a: the STRICT series pick + the year fallback (D1 / D2) ----------------------

test('pickSeriesList reads only the wrapper`s own key — never the first array it finds', () => {
  expect(pickSeriesList({ movies: [row()] })).toEqual([])
  expect(pickSeriesList([row()])).toEqual([])
  expect(pickSeriesList({ series: 'nope' })).toEqual([])
  expect(pickSeriesList(wrapper())).toHaveLength(2)
})

test('pickCategories keeps only string genre names', () => {
  expect(pickCategories({ categories: ['A', 7, null, 'B'] })).toEqual(['A', 'B'])
  expect(pickCategories({})).toEqual([])
})

test('a bare-array response is still the movie list, and the series grid stays empty', async () => {
  const fetchImpl = fetchReturning([row({ id: '1', name: 'Only movie' })])
  const deps = { dev: DEV, saved: null, fetchImpl }
  expect(items(await listMovies(BOTH, deps))).toHaveLength(1)
  expect(await listSeries(BOTH, deps)).toEqual({ ok: true, items: [] })
})

test('stripSeriesItem: aired_first stands in for a missing year, and junk invents none', () => {
  expect(stripSeriesItem(seriesRow())!.anio).toBe('2026')
  expect(stripSeriesItem(seriesRow({ anio: '' }))!.anio).toBe('2026')
  expect(stripSeriesItem(seriesRow({ anio: '0', aired_first: 'soon' }))!.anio).toBe('')
  expect(stripSeriesItem(seriesRow({ anio: '0', aired_first: '2026' }))!.anio).toBe('')
  expect(stripSeriesItem(seriesRow({ anio: '0', aired_first: undefined }))!.anio).toBe('')
  expect(stripSeriesItem(seriesRow({ anio: '2023' }))!.anio).toBe('2023')
  expect(stripSeriesItem({ name: 'no id' })).toBeNull()
  expect(stripSeriesItem(null)).toBeNull()
})

// --- S54a: the series detail call (D3) ----------------------------------------------

// The real series detail response, captured live (S54, 2026-07-27) and sanitized:
// hosts are example domains and the free text is shortened, but every KEY, the
// `{token}` placeholders and the "hh:mm:ss" durations are structure-verbatim. Note
// `duration:"0"` and `path:""` — a series never plays directly.
function realSeries (over: Record<string, unknown> = {}) {
  return {
    director: 'A Director',
    duration: '0',
    genre: 'Animation, Comedy',
    plot: 'a synopsis',
    cast: 'A Name, Another Name',
    releasedate: '2019-10-05 - 2026-07-18',
    rating: '8.0',
    icon: 'https://art.example/900.jpg',
    path: '',
    seasons: [
      { season_id: '5001', number: '1', title: 'Season 1', cast: '', icon: 'https://art.example/s1.jpg', air_date: '2019-10-05', episodes: '4' },
      { season_id: '5002', number: '2', title: 'Season 2', cast: '', icon: 'https://art.example/s2.jpg', air_date: '2021-03-11', episodes: '2' }
    ],
    episodes: [
      { ep_id: '70001', season_id: '5001', number: '1', title: 'Pilot', plot: 'the first one', director: '', releasedate: '2019-10-05', rating: '7.5', icon: 'https://art.example/e1.jpg', height: '1080', duration: '00:51:00', path: 'https://cdn.example/serie900/S01E01.mp4/index.m3u8?token={token}' },
      { ep_id: '70002', season_id: '5001', number: '2', title: 'Cleartext', plot: '', director: '', releasedate: '', rating: '', icon: '', height: '720', duration: '00:42:30', path: 'http://cdn.example/serie900/S01E02.mp4/index.m3u8?token={token}' }
    ],
    ...over
  }
}

test('extractSeriesInfo: the REAL shape, stripped — and pure (the placeholder stays)', () => {
  const detail = detailOf(extractSeriesInfo(realSeries()))
  expect(detail.seasons[0]).toEqual({ id: '5001', number: 1, title: 'Season 1', icon: 'https://art.example/s1.jpg', airDate: '2019-10-05', episodeCount: 4 })
  expect(detail.releasedate).toBe('2019-10-05 - 2026-07-18')
  expect(detail.episodes[0].url).toContain('{token}')
})

test('extractSeriesInfo: malformed shapes are bad-response, never a throw', () => {
  const bad = { ok: false, error: 'bad-response' }
  expect(extractSeriesInfo({ plot: 'no lists here' })).toEqual(bad)
  expect(extractSeriesInfo(null)).toEqual(bad)
  expect(extractSeriesInfo('a string')).toEqual(bad)
  expect(extractSeriesInfo([1, 2, 3])).toEqual(bad)
})

test('getSeriesInfo end to end: the series source, stripped seasons/episodes, tokens filled', async () => {
  const fetchImpl = fetchReturning(realSeries())
  const res = await getSeriesInfo(BOTH, '900', { dev: DEV, saved: null, fetchImpl })
  const url = String((fetchImpl.mock.calls[0] as unknown[])[0])
  expect(url).toContain('/getMovieInfo.php?')
  expect(url).toContain('source=series-src')
  expect(url).toContain('id=900')
  expect(url).toContain('version=2')
  const detail = detailOf(res)
  expect(detail.seasons).toHaveLength(2)
  expect(detail.seasons[1].episodeCount).toBe(2)
  expect(detail.episodes[0]).toMatchObject({
    id: '70001',
    seasonId: '5001',
    number: 1,
    title: 'Pilot',
    durationSec: 3060,
    url: 'https://cdn.example/serie900/S01E01.mp4/index.m3u8?token=DEV_TOKEN'
  })
  // A cleartext episode path never receives the viewer's password.
  expect(detail.episodes[1].url).toBe('')
})

test('getSeriesInfo substitutes the token URL-encoded', async () => {
  const fetchImpl = fetchReturning(realSeries())
  const res = await getSeriesInfo(BOTH, '900', { dev: null, saved: { username: 'viewer1', password: 'p@ss w0rd' }, fetchImpl })
  expect(detailOf(res).episodes[0].url).toBe('https://cdn.example/serie900/S01E01.mp4/index.m3u8?token=p%40ss%20w0rd')
})

test('getSeriesInfo refuses without a series source — and never dials the movies one instead', async () => {
  const fetchImpl = fetchReturning(realSeries())
  expect(await getSeriesInfo(CONFIG, '900', { dev: DEV, saved: null, fetchImpl })).toEqual({ ok: false, error: 'bad-response' })
  expect(await getSeriesInfo(BOTH, '', { dev: DEV, saved: null, fetchImpl })).toEqual({ ok: false, error: 'bad-response' })
  expect(await getSeriesInfo(BOTH, '900', { dev: null, saved: null, fetchImpl })).toEqual({ ok: false, error: 'auth' })
  expect(await getSeriesInfo({ ...BOTH, apiBase: 'http://provider.example/api' }, '900', { dev: DEV, saved: null, fetchImpl })).toEqual({ ok: false, error: 'network' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('the series path leaks neither the token nor the password', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  const boom = jest.fn(async () => {
    throw new Error('Network request failed: GET https://provider.example/vod/api/getMovieInfo.php?service=svc&source=series-src&id=900&username=viewer1&token=viewer-password')
  }) as unknown as typeof fetch
  const res = await getSeriesInfo(BOTH, '900', { dev: null, saved: SAVED, fetchImpl: boom })
  expect(res).toEqual({ ok: false, error: 'network' })
  const logged = warn.mock.calls.flat().map(String).join(' ')
  expect(logged).not.toContain('viewer-password')
  expect(logged).not.toContain('token=')
  expect(JSON.stringify(res)).not.toContain('viewer-password')
})
