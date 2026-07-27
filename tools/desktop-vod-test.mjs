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
// Run: node tools/desktop-vod-test.mjs   (npm run test:desktop-vod)
import {
  listMovies, getMovieInfo, extractMovieInfo, resolveCredentials, clearVodCache,
  pickList, stripItem, redact, fillToken
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

if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1) }
console.log('\ndesktop-vod: ALL PASS')
