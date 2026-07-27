// The desktop external-VOD provider client (S53c / design D2) — pure unit tests, no
// network, no Electron. It is the twin of client/src/vod/zencontent.ts and runs the
// SAME fixtures as that module's jest suite (client/__tests__/vodProvider.test.ts),
// so the two copies cannot drift silently. The desktop renderer has no jest harness
// (tsc + the esbuild bundle are its checks), which is why this lives here.
//
// It pins the four things that make this module safe to point at somebody else's
// server:
//   1. credential resolution — the dev override wins, otherwise the LOGGED-IN pair
//      (app username -> username, app PASSWORD -> token) — and the example file's
//      placeholder words are NOT a credential;
//   2. the token never escapes into an error or a log line — its only two outlets
//      are the outgoing query string and the playable URL (the provider's `path`
//      embeds a `{token}` placeholder that fillToken substitutes: the player cannot
//      dial the stream without it);
//   3. the giant list payload is stripped to the grid's fields and sorted
//      newest-first, and both the bare-array and wrapped-object shapes are accepted;
//   4. extractMovieInfo answers over the REAL captured response (S53d, 2026-07-27:
//      a flat object, url in `path`/`path_1080`/`path_720`, runtime as `duration`
//      "hh:mm:ss") — plus the pre-capture wide-guess shapes, kept as a fallback for
//      other Xtream-style providers. Fixture hosts are sanitized; the real capture
//      structure is preserved verbatim.
//
// S54a adds the SERIES half, pinned in exactly the same cases as the jest suite:
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
//
// Run: node tools/desktop-vod-test.mjs   (npm run test:desktop-vod)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listMovies, listSeries, listCategories, getMovieInfo, getSeriesInfo,
  extractMovieInfo, extractSeriesInfo, resolveCredentials, clearVodCache,
  pickList, pickSeriesList, pickCategories, stripItem, stripSeriesItem, redact, fillToken
} from '../desktop/main/vod-provider.js'

let failures = 0
const ok = (cond, msg) => { if (cond) { console.log('  ok  ', msg) } else { console.error('  FAIL', msg); failures++ } }
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`}`)

const CONFIG = {
  enabled: true,
  apiBase: 'https://provider.example/vod/api',
  service: 'svc',
  sources: { movies: 'movies-src' },
  params: { hm: '1', hs: '2' }
}

const DEV = { username: 'DEV_USER', token: 'DEV_TOKEN' }
const SAVED = { username: 'viewer1', password: 'viewer-password' }

// One provider row, verbatim in the documented shape (extra fields on purpose —
// they must be dropped).
function row (over = {}) {
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
function seriesRow (over = {}) {
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
function wrapper (over = {}) {
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

const BOTH = { ...CONFIG, sources: { movies: 'movies-src', series: 'series-src' } }

// A fetch stub that records its calls and answers one canned body.
function fetchReturning (body, status = 200) {
  const calls = []
  const fn = async (url, init) => {
    calls.push([url, init])
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
  }
  fn.calls = calls
  return fn
}

// Capture console.warn for the redaction checks (the module's ONE diagnostic line).
function captureWarn (fn) {
  const lines = []
  const orig = console.warn
  console.warn = (...args) => lines.push(args.map(String).join(' '))
  return fn().finally(() => { console.warn = orig }).then(() => lines.join('\n'))
}

// ---- A. credential resolution ----
console.log('A. credential resolution')
{
  eq(resolveCredentials({ dev: DEV, saved: SAVED }), { username: 'DEV_USER', token: 'DEV_TOKEN' }, 'the dev override wins over the logged-in pair')
  eq(resolveCredentials({ dev: null, saved: SAVED }), { username: 'viewer1', token: 'viewer-password' }, 'without a dev block the LOGIN pair is the provider pair (password -> token)')
  ok(resolveCredentials({ dev: null, saved: null }) === null, 'no dev block and nobody logged in = no credentials at all')
  // The example file ships these words; a config copied but never filled in must
  // fall through to the viewer pass-off instead of sending them to the provider.
  eq(resolveCredentials({ dev: { username: 'YOUR_USERNAME', token: 'YOUR_TOKEN' }, saved: SAVED }), { username: 'viewer1', token: 'viewer-password' }, 'the example placeholders are ignored, not sent')
  ok(resolveCredentials({ dev: { username: 'someone' }, saved: null }) === null, 'a half-filled dev block is not a credential')
}

// ---- B. the list call ----
console.log('B. getMovies')
{
  clearVodCache()
  const fetchImpl = fetchReturning([])
  const res = await listMovies(CONFIG, { dev: null, saved: null, fetchImpl })
  eq(res, { ok: false, error: 'auth' }, 'no credentials = auth, without dialing')
  ok(fetchImpl.calls.length === 0, 'nothing was fetched')
}
{
  clearVodCache()
  const fetchImpl = fetchReturning([row()])
  await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl })
  const [url, init] = fetchImpl.calls[0]
  ok(url.startsWith('https://provider.example/vod/api/getMovies.php?'), 'composes the documented endpoint')
  ok(url.includes('service=svc') && url.includes('source=movies-src'), 'carries service + source')
  ok(url.includes('username=DEV_USER') && url.includes('token=DEV_TOKEN'), 'carries the credential pair')
  ok(url.includes('hm=1') && url.includes('hs=2'), 'appends the panel params verbatim')
  ok(init.headers['User-Agent'].includes('Mozilla/5.0'), 'browser-shaped User-Agent')
  ok(init.headers.Accept === 'application/json, text/plain, */*', 'documented Accept header')
  ok(!!init.signal, 'the request is abortable (20 s timeout)')
}
{
  clearVodCache()
  const fetchImpl = fetchReturning([row()])
  const res = await listMovies({ ...CONFIG, apiBase: 'http://provider.example/api' }, { dev: DEV, saved: null, fetchImpl })
  ok(res.ok === false, 'a non-https apiBase is refused')
  ok(fetchImpl.calls.length === 0, '...before ever dialing')
}
{
  clearVodCache()
  const fetchImpl = fetchReturning([
    row({ id: '1', name: 'Older', added: '100' }),
    row({ id: '2', name: 'Newest', added: '900' }),
    row({ id: '3', name: 'Middle', added: '500' }),
    row({ id: '4', name: '', added: '999' }) // unnameable -> dropped
  ])
  const res = await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl })
  eq(res.items.map((i) => i.name), ['Newest', 'Middle', 'Older'], 'sorted newest-added first, unnameable row dropped')
  eq(Object.keys(res.items[0]).sort(), ['added', 'anio', 'categories', 'icon', 'id', 'name', 'nameOriginal'], 'stripped to exactly the grid fields')
  ok(res.items[0].added === 900 && res.items[0].nameOriginal === 'Sick Girl' && res.items[0].anio === '2023', 'the kept fields survive intact')
  ok(res.items[0].plot === undefined, 'the synopsis (and everything else) is gone')
}
{
  clearVodCache()
  const fetchImpl = fetchReturning({ status: 'ok', movies: [row({ id: '7', name: 'Wrapped' })] })
  const res = await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl })
  ok(res.ok && res.items.length === 1 && res.items[0].id === '7', 'a wrapped list object is accepted as well as a bare array')
}
{
  clearVodCache()
  const fetchImpl = fetchReturning([row()])
  await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl })
  await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl })
  ok(fetchImpl.calls.length === 1, 'the second call inside the TTL is served from the session cache')
  clearVodCache()
  await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl })
  ok(fetchImpl.calls.length === 2, 'clearVodCache() forces a refetch')
}
{
  clearVodCache()
  const fetchImpl = fetchReturning([row()])
  const res = await listMovies({ ...CONFIG, sources: {} }, { dev: DEV, saved: null, fetchImpl })
  eq(res, { ok: true, items: [] }, 'no movies source = an empty catalog, not an error')
  ok(fetchImpl.calls.length === 0, '...and no call')
}
{
  const deps = { dev: DEV, saved: null }
  clearVodCache(); eq(await listMovies(CONFIG, { ...deps, fetchImpl: fetchReturning([], 401) }), { ok: false, error: 'auth' }, '401 is auth')
  clearVodCache(); eq(await listMovies(CONFIG, { ...deps, fetchImpl: fetchReturning([], 500) }), { ok: false, error: 'network' }, '500 is network')
  clearVodCache(); eq(await listMovies(CONFIG, { ...deps, fetchImpl: fetchReturning('<html>nope</html>') }), { ok: false, error: 'bad-response' }, 'non-JSON is bad-response')
  clearVodCache(); eq(await listMovies(CONFIG, { ...deps, fetchImpl: fetchReturning('invalid login') }), { ok: false, error: 'auth' }, 'a plain-text rejection reads as auth')
}

// ---- C. the token never escapes ----
// The security property of the whole module: the token IS a viewer password, and the
// only place it may ever appear is the outgoing query string.
console.log('C. secrets')
{
  clearVodCache()
  let res = null
  const boom = async () => { throw new Error('Network request failed: GET https://provider.example/vod/api/getMovies.php?service=svc&source=movies-src&username=viewer1&token=viewer-password&hm=1') }
  const logged = await captureWarn(async () => { res = await listMovies(CONFIG, { dev: null, saved: SAVED, fetchImpl: boom }) })
  eq(res, { ok: false, error: 'network' }, 'a thrown fetch is a typed network failure')
  ok(logged.includes('[vod]'), 'the failure is still diagnosable in the log')
  ok(!logged.includes('viewer-password') && !logged.includes('token='), 'neither the password nor the query string reaches the log')
  ok(!JSON.stringify(res).includes('viewer-password'), 'and nothing leaks through the result')
}
{
  clearVodCache()
  const boom = async () => { throw new Error('failed for DEV_TOKEN while connecting') }
  const logged = await captureWarn(async () => { await listMovies(CONFIG, { dev: DEV, saved: null, fetchImpl: boom }) })
  ok(!logged.includes('DEV_TOKEN'), 'a dev token echoed in a thrown message is scrubbed too')
  ok(redact(new Error('boom https://x/y?token=abc'), 'abc') === 'boom https://x/y?[redacted]', 'redact() strips the query string')
  ok(redact('plain abc text', 'abc') === 'plain [redacted] text', 'redact() also scrubs a bare token')
}

// The real getMovieInfo response, captured live 2026-07-27 (S53d) and sanitized:
// hosts are example domains and the free-text metadata is shortened, but every KEY,
// the `{token}` placeholders, and the "hh:mm:ss" duration are structure-verbatim.
function realInfo (over = {}) {
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

// ---- D. extractMovieInfo (shape verified live, S53d) ----
console.log('D. extractMovieInfo')
{
  eq(extractMovieInfo(realInfo()), { ok: true, url: 'https://cdn.example/vod56487Zz/index.m3u8?token={token}', durationSec: 5912 }, 'the REAL shape: `path` master + "hh:mm:ss" duration, placeholder intact')
  eq(extractMovieInfo(realInfo({ path: undefined })).url, 'https://cdn.example/vod56487Zz/vod56487Zz_1080.mp4/index.m3u8?token={token}', 'no master -> the 1080 variant')
  ok(extractMovieInfo(realInfo()).url.includes('{token}'), 'extractMovieInfo stays pure: the placeholder is NOT filled here')
}
{
  eq(extractMovieInfo({ url: 'https://cdn.example/movie.mp4', duration: 5525 }), { ok: true, url: 'https://cdn.example/movie.mp4', durationSec: 5525 }, 'a url at the top level')
  eq(extractMovieInfo({ movie_data: { direct_source: 'https://cdn.example/a.mkv', duration_secs: '7200' } }), { ok: true, url: 'https://cdn.example/a.mkv', durationSec: 7200 }, 'movie_data.direct_source + duration_secs')
  eq(extractMovieInfo({ info: { stream_url: 'https://cdn.example/b.m3u8', duration: '01:32:05' } }), { ok: true, url: 'https://cdn.example/b.m3u8', durationSec: 5525 }, 'info.stream_url + an h:mm:ss runtime')
  eq(extractMovieInfo({ movie: { link: 'https://cdn.example/c.mp4' } }), { ok: true, url: 'https://cdn.example/c.mp4', durationSec: null }, 'a url with no runtime at all')
  const bad = { ok: false, error: 'bad-response' }
  eq(extractMovieInfo({ info: { title: 'no url here' } }), bad, 'no url anywhere is bad-response')
  eq(extractMovieInfo({ url: 'not-a-url' }), bad, 'a non-url string is bad-response')
  eq(extractMovieInfo(null), bad, 'null is bad-response')
  eq(extractMovieInfo('a string'), bad, 'a string is bad-response')
  eq(extractMovieInfo([1, 2, 3]), bad, 'an array is bad-response')
}

// ---- D2. fillToken (the {token} placeholder) ----
console.log('D2. fillToken')
{
  eq(fillToken('https://cdn.example/v/index.m3u8?token={token}', 'p@ss w0rd'), 'https://cdn.example/v/index.m3u8?token=p%40ss%20w0rd', 'the placeholder is filled URL-encoded')
  eq(fillToken('https://cdn.example/x.mp4', 'tok'), 'https://cdn.example/x.mp4', 'a URL without the placeholder passes through untouched')
  eq(fillToken('http://cdn.example/v/index.m3u8?token={token}', 'tok'), '', 'a cleartext URL never receives the token')
}

// ---- E. the detail call ----
console.log('E. getMovieInfo')
{
  clearVodCache()
  const fetchImpl = fetchReturning(realInfo())
  const res = await getMovieInfo(CONFIG, '56487', { dev: DEV, saved: null, fetchImpl })
  eq(res, { ok: true, url: 'https://cdn.example/vod56487Zz/index.m3u8?token=DEV_TOKEN', durationSec: 5912 }, 'end to end over the REAL shape: path chosen, token filled, runtime parsed')
}
{
  const fetchImpl = fetchReturning({ movie_data: { url: 'https://cdn.example/x.mp4', duration: '90:00' } })
  const res = await getMovieInfo(CONFIG, '55157', { dev: DEV, saved: null, fetchImpl })
  const url = fetchImpl.calls[0][0]
  ok(url.includes('/getMovieInfo.php?') && url.includes('id=55157') && url.includes('version=2'), 'asks for the documented detail endpoint')
  eq(res, { ok: true, url: 'https://cdn.example/x.mp4', durationSec: 5400 }, 'and shapes the answer')
  eq(await getMovieInfo(CONFIG, '', { dev: DEV, saved: null, fetchImpl }), { ok: false, error: 'bad-response' }, 'an empty id never dials')
  eq(await getMovieInfo(CONFIG, '1', { dev: null, saved: null, fetchImpl }), { ok: false, error: 'auth' }, 'no credentials = auth')
}

// ---- F. the shaping helpers on their own ----
console.log('F. helpers')
{
  eq(pickList([1, 2]), [1, 2], 'a bare array is the list')
  eq(pickList({ data: ['a'] }), ['a'], 'a conventional wrapper key is found')
  eq(pickList({ whatever: ['a'] }), ['a'], 'an unconventional wrapper still yields its array')
  ok(pickList({ a: 1 }) === null && pickList('x') === null, 'no array anywhere = null')
  ok(stripItem({ id: 1, name: 'Numeric id' }).id === '1', 'a numeric id is stringified')
  eq(stripItem({ id: '9', title: 'Alt title', year: '1999', poster: 'https://p/1.jpg' }), { id: '9', name: 'Alt title', nameOriginal: '', icon: 'https://p/1.jpg', added: 0, anio: '1999', categories: [] }, 'alternate field names are accepted')
  ok(stripItem({ name: 'no id' }) === null && stripItem(null) === null, 'unusable rows are dropped')
  eq(stripItem({ id: '1', name: 'x', categories: ['4', 'junk', 6] }).categories, [4, 6], 'category ids are numbers, junk removed')
}

// ---- G. one download, three lists (S54a / design D1) ----
console.log('G. movies + series + genres from ONE call')
{
  clearVodCache()
  const fetchImpl = fetchReturning(wrapper())
  const deps = { dev: DEV, saved: null, fetchImpl }
  const movies = await listMovies(BOTH, deps)
  const series = await listSeries(BOTH, deps)
  const cats = await listCategories(BOTH, deps)
  ok(fetchImpl.calls.length === 1, 'ONE download feeds movies, series AND the genre names')
  ok(fetchImpl.calls[0][0].includes('source=movies-src'), '...made with the movies source')
  eq(movies.items.map((i) => i.name), ['Newest movie', 'Older movie'], 'movies come out newest-added first')
  eq(series.items.map((i) => i.name), ['Serie Uno', 'Serie Dos'], 'series come out newest-added first')
  eq(cats.categories, ['Action', 'Adventure', 'Animation'], 'the genre names survive verbatim, in the provider order')
  eq(Object.keys(series.items[0]).sort(), ['added', 'anio', 'categories', 'icon', 'id', 'name', 'nameOriginal'], 'a series row is stripped to the same grid fields')
}
{
  // Series-only operator: the single call goes out with the SERIES source, and the
  // movie grid is honestly empty without a request of its own.
  clearVodCache()
  const fetchImpl = fetchReturning(wrapper())
  const seriesOnly = { ...CONFIG, sources: { series: 'series-src' } }
  const deps = { dev: DEV, saved: null, fetchImpl }
  eq(await listMovies(seriesOnly, deps), { ok: true, items: [] }, 'no movies source = an empty movie catalog, not an error')
  ok(fetchImpl.calls.length === 0, '...and no call at all')
  const series = await listSeries(seriesOnly, deps)
  ok(series.ok && series.items.length === 2, 'the series list still loads')
  ok(fetchImpl.calls[0][0].includes('source=series-src'), '...through the series source')
}
{
  clearVodCache()
  const fetchImpl = fetchReturning(wrapper())
  eq(await listSeries(CONFIG, { dev: DEV, saved: null, fetchImpl }), { ok: true, items: [] }, 'no series source = an empty series catalog, not an error')
  ok(fetchImpl.calls.length === 0, '...and no call at all')
  eq(await listCategories({ ...CONFIG, sources: {} }, { dev: DEV, saved: null, fetchImpl }), { ok: true, categories: [] }, 'no source of any kind = no genres, no call')
  ok(fetchImpl.calls.length === 0, '...still nothing dialed')
}
{
  // A cache hit must serve all three lists, not just the one that filled it.
  clearVodCache()
  const fetchImpl = fetchReturning(wrapper())
  await listSeries(BOTH, { dev: DEV, saved: null, fetchImpl })
  await listMovies(BOTH, { dev: DEV, saved: null, fetchImpl })
  await listCategories(BOTH, { dev: DEV, saved: null, fetchImpl })
  ok(fetchImpl.calls.length === 1, 'whichever list asks first pays; the other two are cache hits')
}

// ---- H. the strict series pick + the year fallback (D1 / D2) ----
console.log('H. pickSeriesList + pickCategories + stripSeriesItem')
{
  eq(pickSeriesList({ movies: [row()] }), [], 'no `series` key -> EMPTY, never the movie list')
  eq(pickSeriesList([row()]), [], 'a bare array carries no series either')
  eq(pickSeriesList({ series: 'nope' }), [], 'a non-array `series` is no series')
  ok(pickSeriesList(wrapper()).length === 2, 'the wrapper`s own series key IS the list')
  eq(pickCategories({ categories: ['A', 7, null, 'B'] }), ['A', 'B'], 'only string genre names survive')
  eq(pickCategories({}), [], 'no categories -> empty')
}
{
  clearVodCache()
  // A provider that answers a BARE array (the pre-wrapper shape) must yield movies and
  // an empty series grid — never the movies again under a Series heading.
  const fetchImpl = fetchReturning([row({ id: '1', name: 'Only movie' })])
  const deps = { dev: DEV, saved: null, fetchImpl }
  const movies = await listMovies(BOTH, deps)
  const series = await listSeries(BOTH, deps)
  ok(movies.ok && movies.items.length === 1, 'the bare array is still the movie list')
  eq(series, { ok: true, items: [] }, '...and the series list is empty, not a copy of it')
}
{
  eq(stripSeriesItem(seriesRow()).anio, '2026', 'anio "0" + aired_first yyyymmdd -> the aired year')
  eq(stripSeriesItem(seriesRow({ anio: '' })).anio, '2026', 'an EMPTY anio takes the same fallback')
  eq(stripSeriesItem(seriesRow({ anio: '0', aired_first: 'soon' })).anio, '', 'junk aired_first invents no year')
  eq(stripSeriesItem(seriesRow({ anio: '0', aired_first: '2026' })).anio, '', 'a short aired_first is junk too')
  eq(stripSeriesItem(seriesRow({ anio: '0', aired_first: undefined })).anio, '', 'no aired_first at all -> no year')
  eq(stripSeriesItem(seriesRow({ anio: '2023' })).anio, '2023', 'a real anio always wins')
  ok(stripSeriesItem({ name: 'no id' }) === null && stripSeriesItem(null) === null, 'unusable series rows are dropped like movie rows')
}

// The real series detail response, captured live (S54, 2026-07-27) and sanitized:
// hosts are example domains and the free text is shortened, but every KEY, the
// `{token}` placeholders and the "hh:mm:ss" durations are structure-verbatim. Note
// `duration:"0"` and `path:""` — a series never plays directly.
function realSeries (over = {}) {
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

// ---- I. the series detail call (D3) ----
console.log('I. getSeriesInfo')
{
  const pure = extractSeriesInfo(realSeries())
  ok(pure.ok, 'the real shape is understood')
  eq(pure.detail.seasons[0], { id: '5001', number: 1, title: 'Season 1', icon: 'https://art.example/s1.jpg', airDate: '2019-10-05', episodeCount: 4 }, 'a season is stripped to id/number/title/icon/airDate/episodeCount')
  eq(pure.detail.releasedate, '2019-10-05 - 2026-07-18', 'the run range survives verbatim for the detail screen')
  ok(pure.detail.episodes[0].url.includes('{token}'), 'extractSeriesInfo stays pure: the placeholder is NOT filled here')
  const bad = { ok: false, error: 'bad-response' }
  eq(extractSeriesInfo({ plot: 'no lists here' }), bad, 'neither seasons nor episodes is bad-response')
  eq(extractSeriesInfo(null), bad, 'null is bad-response')
  eq(extractSeriesInfo('a string'), bad, 'a string is bad-response')
  eq(extractSeriesInfo([1, 2, 3]), bad, 'an array is bad-response')
}
{
  const fetchImpl = fetchReturning(realSeries())
  const res = await getSeriesInfo(BOTH, '900', { dev: DEV, saved: null, fetchImpl })
  const url = fetchImpl.calls[0][0]
  ok(url.includes('/getMovieInfo.php?') && url.includes('source=series-src') && url.includes('id=900') && url.includes('version=2'), 'asks getMovieInfo.php against the SERIES source')
  ok(res.ok, 'the detail is answered')
  ok(res.detail.seasons.length === 2 && res.detail.seasons[1].episodeCount === 2, 'both seasons with their episode-count badges')
  eq(res.detail.episodes[0].durationSec, 3060, '"00:51:00" is 3060 seconds')
  eq(res.detail.episodes[0].url, 'https://cdn.example/serie900/S01E01.mp4/index.m3u8?token=DEV_TOKEN', 'the episode URL comes back playable')
  eq(res.detail.episodes[0].seasonId, '5001', 'the episode knows its season')
  eq(res.detail.episodes[1].url, '', 'a CLEARTEXT episode path never receives the token')
}
{
  // The credential is a viewer password: it must arrive URL-encoded in the playable URL.
  const fetchImpl = fetchReturning(realSeries())
  const res = await getSeriesInfo(BOTH, '900', { dev: null, saved: { username: 'viewer1', password: 'p@ss w0rd' }, fetchImpl })
  eq(res.detail.episodes[0].url, 'https://cdn.example/serie900/S01E01.mp4/index.m3u8?token=p%40ss%20w0rd', 'the token is substituted URL-encoded')
}
{
  const fetchImpl = fetchReturning(realSeries())
  eq(await getSeriesInfo(CONFIG, '900', { dev: DEV, saved: null, fetchImpl }), { ok: false, error: 'bad-response' }, 'no series source = refused')
  ok(fetchImpl.calls.length === 0, '...WITHOUT dialing the movies source instead')
  eq(await getSeriesInfo(BOTH, '', { dev: DEV, saved: null, fetchImpl }), { ok: false, error: 'bad-response' }, 'an empty id never dials')
  eq(await getSeriesInfo(BOTH, '900', { dev: null, saved: null, fetchImpl }), { ok: false, error: 'auth' }, 'no credentials = auth')
  ok(fetchImpl.calls.length === 0, 'none of the refusals reached the network')
  eq(await getSeriesInfo({ ...BOTH, apiBase: 'http://provider.example/api' }, '900', { dev: DEV, saved: null, fetchImpl }), { ok: false, error: 'network' }, 'a cleartext apiBase is refused')
  ok(fetchImpl.calls.length === 0, '...before ever dialing')
}
{
  // Same security property as the movie path: the token has exactly two outlets.
  let res = null
  const boom = async () => { throw new Error('Network request failed: GET https://provider.example/vod/api/getMovieInfo.php?service=svc&source=series-src&id=900&username=viewer1&token=viewer-password') }
  const logged = await captureWarn(async () => { res = await getSeriesInfo(BOTH, '900', { dev: null, saved: SAVED, fetchImpl: boom }) })
  eq(res, { ok: false, error: 'network' }, 'a thrown fetch is a typed network failure')
  ok(!logged.includes('viewer-password') && !logged.includes('token='), 'the series path leaks neither the password nor the query string')
  ok(!JSON.stringify(res).includes('viewer-password'), 'and nothing leaks through the result')
}

// ---- J. the device-local prefs gates (S54a / design D9) ----
// "My List" and watch history are written by a whole-array message, so the copy that
// owns the disk re-validates and caps whatever it is handed. There are TWO such copies
// — the phone worklet (client/backend/backend.mjs) and the desktop main process
// (desktop/main/engine.js) — and neither is importable here (one needs BareKit, the
// other the player SDK). So the block is lifted as SOURCE from both files: identical
// text is the drift guard, and the cases below run that very text.
console.log('J. vodList / vodHistory prefs gates')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function gateSource (rel) {
  // Line endings are normalized first: a CRLF checkout must compare and run the same.
  const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n')
  const start = src.indexOf('const VOD_LIST_MAX')
  const end = src.indexOf('\n}\n', src.indexOf('function gateVodHistory'))
  return start < 0 || end < 0 ? '' : src.slice(start, end + 3)
}
{
  const worklet = gateSource('client/backend/backend.mjs')
  const desktop = gateSource('desktop/main/engine.js')
  ok(worklet.length > 200, 'the worklet prefs gate was found')
  ok(worklet === desktop, 'the phone and desktop prefs gates are BYTE-IDENTICAL (D9 two-copy hazard)')

  // eslint-disable-next-line no-new-func -- the guard above pins exactly what runs here
  const { gateVodList, gateVodHistory } = new Function(worklet + '\nreturn { gateVodList, gateVodHistory }')()

  eq(gateVodList([{ kind: 'movie', id: '55157' }, { kind: 'series', id: '900' }]), [{ kind: 'movie', id: '55157' }, { kind: 'series', id: '900' }], 'well-formed list entries survive in order')
  eq(gateVodList('not an array'), [], 'a non-array is an empty list, never a throw')
  eq(gateVodList([{ kind: 'episode', id: '1' }, { kind: 'movie' }, { id: '2' }, null, 'x', { kind: 'movie', id: 7 }]), [], 'every malformed entry is dropped (kind AND id are required strings)')
  eq(gateVodList([{ kind: 'movie', id: 'a', extra: 'drop me' }]), [{ kind: 'movie', id: 'a' }], 'unknown fields never reach the disk')
  eq(gateVodList([{ kind: 'movie', id: 'a' }, { kind: 'movie', id: 'a' }, { kind: 'series', id: 'a' }]), [{ kind: 'movie', id: 'a' }, { kind: 'series', id: 'a' }], 'one entry per kind+id, first (newest) wins')
  eq(gateVodList([{ kind: 'movie', id: 'x'.repeat(65) }]), [], 'an absurd id is dropped')
  ok(gateVodList(Array.from({ length: 900 }, (_, i) => ({ kind: 'movie', id: String(i) }))).length === 500, 'the list is capped at 500')

  const h = { kind: 'episode', id: '70001', seriesId: '900', title: 'Pilot', positionSec: 61, durationSec: 3060, at: 1783037028 }
  eq(gateVodHistory([h]), [h], 'a well-formed history entry survives whole')
  eq(gateVodHistory([{ kind: 'movie', id: '1', title: 'x', positionSec: -5, durationSec: 'junk', at: null }]),
    [{ kind: 'movie', id: '1', title: 'x', positionSec: 0, durationSec: 0, at: 0 }], 'negative/junk numbers become 0, and seriesId stays absent')
  eq(gateVodHistory([{ kind: 'series', id: '1', title: 'wrong kind' }]), [], 'history holds movies and episodes only')
  eq(gateVodHistory([{ kind: 'movie', id: '1', title: 'y'.repeat(201), positionSec: 1, durationSec: 2, at: 3 }]),
    [{ kind: 'movie', id: '1', title: '', positionSec: 1, durationSec: 2, at: 3 }], 'an over-long title is dropped, the entry is not')
  eq(gateVodHistory('nope'), [], 'a non-array history is empty, never a throw')
  ok(gateVodHistory(Array.from({ length: 500 }, (_, i) => ({ kind: 'movie', id: String(i), title: 't', positionSec: 0, durationSec: 0, at: i }))).length === 200, 'history is capped at 200')
}

if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1) }
console.log('\ndesktop-vod: ALL PASS')
