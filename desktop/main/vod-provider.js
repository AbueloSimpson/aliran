// External VOD provider client (S53, design D2) — the desktop twin of the phone
// app's client/src/vod/zencontent.ts.
//
// WHY THIS LIVES IN THE MAIN PROCESS. The renderer is loaded from file://, so every
// cross-origin fetch it makes is blocked by CORS — the provider is somebody else's
// server and will never send us an Access-Control-Allow-Origin header. Main has no
// such restriction, and it is also where the decrypted saved credentials live
// (safeStorage, engine.js) — the renderer is never given the viewer's password. So
// the screens ask over IPC ('vod-list' / 'vod-info') and this module does the work.
//
// The two copies are DELIBERATELY duplicated rather than shared (D2:
// "duplicate-and-assert") — the RN one is TypeScript inside a React Native bundle,
// this one is plain ESM in Electron main. They are kept behaviourally identical and
// both are pinned by fixtures (client/__tests__/vodProvider.test.ts and
// tools/desktop-vod-test.mjs share the same cases).
//
// CREDENTIAL PASS-OFF. In production the provider account IS the app account: the
// viewer's username goes over as `username` and their app PASSWORD as `token` (the
// operator provisions matching accounts on both sides). A dev build may override
// that with a `vod.dev {username, token}` block in the gitignored
// desktop/config/service.json — that block must never ship (see service.example.json).
//
// SECRETS. The token is a viewer password. It appears in exactly two places — the
// query string of the outgoing request, and the playable URL the provider hands back
// (its `path` fields carry a literal `{token}` placeholder this module fills in; the
// player cannot dial the stream without it) — and NOWHERE else: every error this
// module surfaces is a bare typed code, and the one diagnostic line it logs is
// redacted of query strings AND of the token itself. Nothing here ever throws;
// callers get `{ok:false, error}` and the screen renders an honest state.

// A browser-shaped User-Agent: the provider answers plainly to one and is unreliable
// without it. Pinned verbatim (D2 / S53-DESIGN "Provider API").
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const ACCEPT = 'application/json, text/plain, */*'

// The movie list can be tens of megabytes — generous, but bounded so a black-holed
// provider cannot leave the grid spinning forever.
const TIMEOUT_MS = 20000

// Session cache: re-entering the section inside the TTL renders instantly instead of
// re-downloading the whole catalog. In memory only — it dies with the process, and a
// new login rebuilds it (config changes land at login anyway).
const CACHE_TTL_MS = 60 * 60 * 1000

// S54a — SERIES. The provider answers movies AND series from the SAME getMovies.php
// wrapper (`{movies:[…], series:[…], categories:[…strings]}`), so ONE download feeds
// the movie grid, the series grid and the genre names: the session cache holds all
// three per account (design D1). Series rows are movie rows plus `aired_first`, which
// stands in for the year when the provider left `anio` at "0" (D2). A series never
// plays directly — its detail call is the same getMovieInfo.php endpoint against the
// SERIES source and answers seasons + episodes, whose paths carry the same literal
// `{token}` the movie paths do (D3).

/** @typedef {{ id: string, name: string, nameOriginal: string, icon: string, added: number, anio: string, categories: number[] }} VodItem */
/** @typedef {'auth'|'network'|'bad-response'} VodErrorCode */
/** @typedef {{ id: string, number: number, title: string, icon: string, airDate: string, episodeCount: number }} VodSeason */
/** @typedef {{ id: string, seasonId: string, number: number, title: string, plot: string, icon: string, url: string, durationSec: number|null }} VodEpisode */
/** @typedef {{ plot: string, genre: string, director: string, cast: string, rating: string, releasedate: string, icon: string, seasons: VodSeason[], episodes: VodEpisode[] }} VodSeriesDetail */

// ONE entry per account holds everything the single list download carries: the movie
// rows, the series rows and the genre names (D1). Whichever screen asks first pays for
// the download; the other two render instantly off the same entry.
/** @typedef {{ at: number, movies: VodItem[], series: VodItem[], categories: string[] }} CacheEntry */
const listCache = new Map()

/** Drop every cached list (tests, and a sign-out that changes the account). */
export function clearVodCache () { listCache.clear() }

// The placeholders service.example.json ships. Someone who copies the example to
// config/service.json and fills in only the panel key would otherwise send these
// literal words to the provider INSTEAD of the viewer's own account — a dev block
// that was never filled in must fall through to the real pass-off, not break it.
// (Same spirit as index.js refusing a 'REPLACE_…' panel key.)
const PLACEHOLDER = /^(YOUR_|REPLACE_)/

/** Dev-block override WINS when present and complete; otherwise the logged-in pair
 *  (app username -> `username`, app password -> `token`). null = cannot call at all.
 *  @param {{dev?: {username?: string, token?: string}|null, saved?: {username: string, password: string}|null}} deps
 *  @returns {{username: string, token: string}|null} */
export function resolveCredentials (deps = {}) {
  const dev = deps.dev || null
  if (dev && usable(dev.username) && usable(dev.token)) return { username: dev.username, token: dev.token }
  const saved = deps.saved || null
  if (saved && saved.username && saved.password) return { username: saved.username, token: saved.password }
  return null
}

function usable (v) { return typeof v === 'string' && !!v && !PLACEHOLDER.test(v) }

/** The source value the ONE list call is made with. The provider returns the same
 *  wrapper either way, so a movies-only, series-only or both-kinds operator all get
 *  the whole catalog from a single download. */
function listSourceOf (config) {
  const s = (config && config.sources) || {}
  return s.movies || s.series || ''
}

/** Download (or reuse) the wrapper and shape all three lists out of it.
 *  @returns {Promise<{ok: true, entry: CacheEntry}|{ok: false, error: VodErrorCode}>} */
async function loadCatalog (config, deps) {
  const source = listSourceOf(config)
  if (!source) return { ok: false, error: 'bad-response' } // callers gate first; belt-and-braces
  const creds = resolveCredentials(deps)
  if (!creds) return { ok: false, error: 'auth' }

  const key = `${config.apiBase}|${config.service}|${source}|${creds.username}`
  const hit = listCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, entry: hit }

  const url = composeUrl(config, 'getMovies.php', { source }, creds)
  if (!url) return { ok: false, error: 'network' } // non-https apiBase — refused, never dialed
  const res = await getJson(url, creds.token, deps.fetchImpl)
  if (!res.ok) return res
  const list = pickList(res.json)
  if (!list) return { ok: false, error: 'bad-response' }
  // Strip FIRST, then let the parsed payload go: holding tens of MB of raw objects
  // alive behind a few fields each is how this screen would balloon the app's heap.
  const entry = {
    at: Date.now(),
    movies: sortedItems(list, stripItem),
    series: sortedItems(pickSeriesList(res.json), stripSeriesItem),
    categories: pickCategories(res.json)
  }
  listCache.set(key, entry)
  return { ok: true, entry }
}

function sortedItems (list, strip) {
  const items = list.map(strip).filter((it) => it !== null)
  items.sort((a, b) => b.added - a.added)
  return items
}

/** The whole movie list, newest-added first. `sources.movies` absent = the operator
 *  enabled the provider without a movies source: an empty list, not an error.
 *  @returns {Promise<{ok: true, items: VodItem[]}|{ok: false, error: VodErrorCode}>} */
export async function listMovies (config, deps = {}) {
  if (!(config && config.sources && config.sources.movies)) return { ok: true, items: [] }
  const res = await loadCatalog(config, deps)
  return res.ok ? { ok: true, items: res.entry.movies } : res
}

/** The whole series list, newest-added first. Same download as listMovies — and the
 *  same "no source configured = an empty list, not an error" rule, which is what an
 *  operator who never set a series source gets.
 *  @returns {Promise<{ok: true, items: VodItem[]}|{ok: false, error: VodErrorCode}>} */
export async function listSeries (config, deps = {}) {
  if (!(config && config.sources && config.sources.series)) return { ok: true, items: [] }
  const res = await loadCatalog(config, deps)
  return res.ok ? { ok: true, items: res.entry.series } : res
}

/** The provider's genre names, in ITS order — item.categories are numeric indexes
 *  into this array, so the order is load-bearing and must not be sorted.
 *  @returns {Promise<{ok: true, categories: string[]}|{ok: false, error: VodErrorCode}>} */
export async function listCategories (config, deps = {}) {
  if (!listSourceOf(config)) return { ok: true, categories: [] }
  const res = await loadCatalog(config, deps)
  return res.ok ? { ok: true, categories: res.entry.categories } : res
}

/** Detail for one title: the playable URL (+ runtime when the provider states one).
 *  @returns {Promise<{ok: true, url: string, durationSec: number|null}|{ok: false, error: VodErrorCode}>} */
export async function getMovieInfo (config, id, deps = {}) {
  const source = config && config.sources ? config.sources.movies : null
  if (!source || !id) return { ok: false, error: 'bad-response' }
  const creds = resolveCredentials(deps)
  if (!creds) return { ok: false, error: 'auth' }
  const url = composeUrl(config, 'getMovieInfo.php', { source, id: String(id), version: '2' }, creds)
  if (!url) return { ok: false, error: 'network' }
  const res = await getJson(url, creds.token, deps.fetchImpl)
  if (!res.ok) return res
  const info = extractMovieInfo(res.json)
  if (!info.ok) return info
  const playable = fillToken(info.url, creds.token)
  if (!playable) return { ok: false, error: 'bad-response' }
  return { ok: true, url: playable, durationSec: info.durationSec }
}

/** Detail for one SERIES: metadata + seasons + episodes, with every episode URL
 *  already playable. Same endpoint as a movie, against the SERIES source (getSeriesInfo.php
 *  is a 500 and getSeries.php an "Invalid request" — verified live, do not use them).
 *  No series source configured = a refusal that never dials: there is nothing to ask
 *  for, and the request would otherwise go out against the MOVIES source and answer
 *  about a completely different title.
 *  @returns {Promise<{ok: true, detail: VodSeriesDetail}|{ok: false, error: VodErrorCode}>} */
export async function getSeriesInfo (config, id, deps = {}) {
  const source = config && config.sources ? config.sources.series : null
  if (!source || !id) return { ok: false, error: 'bad-response' }
  const creds = resolveCredentials(deps)
  if (!creds) return { ok: false, error: 'auth' }
  const url = composeUrl(config, 'getMovieInfo.php', { source, id: String(id), version: '2' }, creds)
  if (!url) return { ok: false, error: 'network' }
  const res = await getJson(url, creds.token, deps.fetchImpl)
  if (!res.ok) return res
  const info = extractSeriesInfo(res.json)
  if (!info.ok) return info
  // Episode paths embed the same literal {token} the movie paths do. Filling it HERE
  // means no screen and no IPC message ever has to carry the credential — and a
  // cleartext path comes back as '' (fillToken), which the UI renders as a notice.
  return {
    ok: true,
    detail: {
      ...info.detail,
      episodes: info.detail.episodes.map((ep) => ({ ...ep, url: ep.url ? fillToken(ep.url, creds.token) : '' }))
    }
  }
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

// Shape VERIFIED against the live provider (S53d, 2026-07-27). The real response is
// one FLAT object: metadata (`director`/`plot`/`cast`/`genre`/`rating`/…), a runtime
// as `duration` "hh:mm:ss", and the playable URL in `path` (an HLS master) with
// per-quality variants `path_1080`/`path_720` — every path embeds a literal `{token}`
// placeholder the caller substitutes (see fillToken; extractMovieInfo itself stays a
// pure json->fields function so the fixtures need no credential). The pre-capture
// wide-guess fields are KEPT below the real ones as a fallback: a white-label build
// may point at a different Xtream-style provider, and an unrecognized shape must
// still be a typed 'bad-response', never a throw.
const URL_FIELDS = ['path', 'path_1080', 'path_720', 'url', 'stream_url', 'streamUrl', 'movie_url', 'direct_source', 'play_url', 'playUrl', 'link', 'file', 'src', 'source_url']
const DURATION_FIELDS = ['duration_secs', 'durationSecs', 'duration_sec', 'durationSec', 'duration']
const INFO_CONTAINERS = ['movie_data', 'movieData', 'info', 'movie', 'data', 'result']

export function extractMovieInfo (json) {
  const root = asRecord(json)
  if (!root) return { ok: false, error: 'bad-response' }
  const containers = [root]
  for (const k of INFO_CONTAINERS) {
    const nested = asRecord(root[k])
    if (nested) containers.push(nested)
  }
  let url = ''
  for (const c of containers) {
    for (const f of URL_FIELDS) {
      const v = c[f]
      if (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim())) { url = v.trim(); break }
    }
    if (url) break
  }
  if (!url) return { ok: false, error: 'bad-response' }
  let durationSec = null
  for (const c of containers) {
    for (const f of DURATION_FIELDS) {
      const d = parseDuration(c[f])
      if (d != null) { durationSec = d; break }
    }
    if (durationSec != null) break
  }
  return { ok: true, url, durationSec }
}

// Series detail, shape VERIFIED live (S54, 2026-07-27): a FLAT object like a movie's
// (director/genre/plot/cast/rating/releasedate) but with `duration:"0"` and `path:""`
// — a series never plays directly — plus `seasons:[{season_id, number, title, icon,
// air_date, episodes:"4"}]` and `episodes:[{ep_id, season_id, number, title, plot,
// icon, duration:"00:51:00", path:"https://…?token={token}"}]`. Pure json->fields, so
// the fixtures need no credential: getSeriesInfo fills the placeholders afterwards.
// A response with neither array is a typed 'bad-response', never a throw.
export function extractSeriesInfo (json) {
  const root = asRecord(json)
  if (!root) return { ok: false, error: 'bad-response' }
  const rawSeasons = Array.isArray(root.seasons) ? root.seasons : null
  const rawEpisodes = Array.isArray(root.episodes) ? root.episodes : null
  if (!rawSeasons && !rawEpisodes) return { ok: false, error: 'bad-response' }
  return {
    ok: true,
    detail: {
      plot: str(root.plot),
      genre: str(root.genre),
      director: str(root.director),
      cast: str(root.cast),
      rating: str(root.rating),
      releasedate: str(root.releasedate),
      icon: str(root.icon) || str(root.poster) || str(root.cover),
      seasons: (rawSeasons || []).map(stripSeason).filter((s) => s !== null),
      episodes: (rawEpisodes || []).map(stripEpisode).filter((e) => e !== null)
    }
  }
}

export function stripSeason (raw) {
  const r = asRecord(raw)
  if (!r) return null
  const id = str(r.season_id) || str(r.id)
  const number = num(r.number)
  if (!id && !number) return null // neither addressable nor labelable
  return {
    id,
    number,
    title: str(r.title) || str(r.name),
    icon: str(r.icon) || str(r.cover),
    airDate: str(r.air_date) || str(r.airDate),
    episodeCount: num(r.episodes)
  }
}

export function stripEpisode (raw) {
  const r = asRecord(raw)
  if (!r) return null
  const id = str(r.ep_id) || str(r.id)
  if (!id) return null
  const path = str(r.path)
  return {
    id,
    seasonId: str(r.season_id),
    number: num(r.number),
    title: str(r.title) || str(r.name),
    plot: str(r.plot),
    icon: str(r.icon),
    // Kept with the placeholder intact — getSeriesInfo substitutes it. Anything that
    // is not a URL at all becomes '' here rather than travelling to the player.
    url: /^https?:\/\/\S+$/i.test(path) ? path : '',
    durationSec: parseDuration(r.duration)
  }
}

/** Fill the provider's literal `{token}` placeholder with the real credential. A URL
 *  without the placeholder passes through untouched; one that HAS it but is not https
 *  is refused ('' -> bad-response upstream) — the token is a viewer password and this
 *  module never puts one on a cleartext wire (same policy as composeUrl). */
export function fillToken (url, token) {
  if (!url.includes('{token}')) return url
  if (!/^https:\/\/\S+$/i.test(url)) return ''
  return url.split('{token}').join(encodeURIComponent(token))
}

// "5525" | 5525 | "01:32:05" | "32:05" -> seconds. Anything else (0, negative, junk)
// is "the provider didn't say" rather than a wrong number on the transport bar.
function parseDuration (v) {
  if (typeof v === 'number' && isFinite(v) && v > 0) return Math.round(v)
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); return n > 0 ? Math.round(n) : null }
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const total = (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3])
  return total > 0 ? total : null
}

// The list endpoint may answer a bare array OR wrap it in an object — accept both,
// preferring the conventional key names before falling back to "the first array in
// there" (defensive: an unverified provider must not be able to blank the grid over a
// wrapper rename).
export function pickList (json) {
  if (Array.isArray(json)) return json
  const root = asRecord(json)
  if (!root) return null
  for (const k of ['movies', 'items', 'data', 'result', 'results', 'list', 'channels']) {
    if (Array.isArray(root[k])) return root[k]
  }
  for (const v of Object.values(root)) if (Array.isArray(v)) return v
  return null
}

// The series list, STRICTLY: only the wrapper's own `series` key. There is no
// first-array fallback here on purpose — the same wrapper carries `movies`, and a
// loose pick would quietly render the movie catalog as "Series" the day the provider
// renames the key. No key = no series, which is an honest empty grid.
export function pickSeriesList (json) {
  const root = asRecord(json)
  return root && Array.isArray(root.series) ? root.series : []
}

// The genre vocabulary, in the provider's own order (item.categories are INDEXES into
// it). Non-string entries are dropped rather than stringified — a genre card can only
// render a name.
export function pickCategories (json) {
  const root = asRecord(json)
  if (!root || !Array.isArray(root.categories)) return []
  return root.categories.filter((c) => typeof c === 'string')
}

// One catalog row, reduced to what the grid actually renders. An item with no id and
// no name is dropped — it could never be shown or played.
export function stripItem (raw) {
  const r = asRecord(raw)
  if (!r) return null
  const id = str(r.id)
  const name = str(r.name) || str(r.title)
  if (!id || !name) return null
  return {
    id,
    name,
    nameOriginal: str(r.name_original) || str(r.nameOriginal),
    icon: str(r.icon) || str(r.poster) || str(r.cover),
    added: Number(r.added) || 0,
    anio: str(r.anio) || str(r.year),
    categories: Array.isArray(r.categories) ? r.categories.map(Number).filter((n) => isFinite(n)) : []
  }
}

// A series row is a movie row with `aired_first`/`aired_last` — and, on this provider,
// `anio:"0"`. D2: when the year is missing or "0", take it from aired_first's yyyymmdd;
// anything else leaves the year EMPTY rather than inventing one (the tile then simply
// shows no "(year)").
export function stripSeriesItem (raw) {
  const item = stripItem(raw)
  if (!item) return null
  if (item.anio && item.anio !== '0') return item
  const aired = str(asRecord(raw).aired_first)
  return { ...item, anio: /^\d{8}$/.test(aired) ? aired.slice(0, 4) : '' }
}

function str (v) { return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : '') }
function num (v) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0 }
function asRecord (v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Build one provider URL. Returns '' when the config is not https — the app refuses
 *  to put a viewer's password on a cleartext wire, and there is no fallback. */
export function composeUrl (config, endpoint, extra, creds) {
  const base = String((config && config.apiBase) || '').replace(/\/+$/, '')
  if (!/^https:\/\/\S+$/i.test(base)) return ''
  const q = { service: config.service, ...extra, username: creds.username, token: creds.token }
  for (const [k, v] of Object.entries((config && config.params) || {})) if (!(k in q)) q[k] = String(v)
  const qs = Object.entries(q).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  return `${base}/${endpoint}?${qs}`
}

async function getJson (url, token, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) return { ok: false, error: 'network' }
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = setTimeout(() => { if (ctrl) ctrl.abort() }, TIMEOUT_MS)
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: ACCEPT },
      signal: ctrl ? ctrl.signal : undefined
    })
    if (!res.ok) return { ok: false, error: res.status === 401 || res.status === 403 ? 'auth' : 'network' }
    const text = await res.text()
    try {
      return { ok: true, json: JSON.parse(text) }
    } catch {
      // A provider that rejects the account often answers 200 with a plain-text
      // complaint rather than JSON — read that as a sign-in problem, not corruption.
      return { ok: false, error: /auth|invalid|denied|forbidden|login/i.test(text.slice(0, 200)) ? 'auth' : 'bad-response' }
    }
  } catch (err) {
    console.warn('[vod] request failed:', redact(err, token))
    return { ok: false, error: 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/** Error text safe to log. Query strings go entirely (that is where the token lives),
 *  and the token itself is scrubbed again in case a layer echoed it elsewhere. */
export function redact (err, token) {
  let s = err instanceof Error ? (err.message || err.name) : String(err)
  s = s.replace(/\?\S*/g, '?[redacted]')
  if (token) s = s.split(token).join('[redacted]')
  return s
}
