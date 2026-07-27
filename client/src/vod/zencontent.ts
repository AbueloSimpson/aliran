// External VOD provider client (S53, design D2) — the ONE place this app talks to the
// operator's third-party movies/series catalog.
//
// The panel never proxies these calls: it only delivers the COORDINATES (apiBase /
// service / sources / params) on the login payload, and the app fetches the provider
// DIRECTLY with the viewer's own account. React Native has no CORS, so a plain fetch
// is all this needs — the desktop twin (S53c) has to run the same requests in its main
// process instead, which is why the two copies are deliberately duplicated rather than
// shared (see D2: "duplicate-and-assert").
//
// CREDENTIAL PASS-OFF. In production the provider account IS the app account: the
// viewer's username goes over as `username` and their app PASSWORD as `token` (the
// operator provisions matching accounts on both sides). A dev build may override that
// with a `vod.dev {username, token}` block in the gitignored config/service.json —
// that block must never ship (see config/service.example.json).
//
// SECRETS. The token is a viewer password. It appears in exactly one place — the
// query string of the outgoing request — and NOWHERE else: every error this module
// surfaces is a bare typed code, and the one diagnostic line it logs is redacted of
// query strings AND of the token itself. Nothing here ever throws; callers get
// `{ok:false, error}` and render an honest state.

import type { VodConfig } from '@aliran/react-native'
import { backend } from '../worklet'
import { loadServiceDescriptor } from '../config'

/** A catalog item, already stripped down (see `stripItem`). */
export interface VodItem {
  id: string
  name: string
  /** Original-language title; often differs from the localized `name`. */
  nameOriginal: string
  /** Poster URL, or '' when the provider has none. */
  icon: string
  /** Unix seconds the provider added the title (0 when unknown) — the default sort. */
  added: number
  /** Release year as the provider states it (string, may be ''). */
  anio: string
  /** Provider category ids. The mapping is unknown, so v1 carries but ignores them. */
  categories: number[]
}

/** Why a provider call could not be answered. Deliberately coarse: the UI names
 *  "sign-in" vs "connection" and never shows a code or a provider message. */
export type VodErrorCode = 'auth' | 'network' | 'bad-response'

export type VodListResult = { ok: true; items: VodItem[] } | { ok: false; error: VodErrorCode }
export type VodInfoResult =
  | { ok: true; url: string; durationSec: number | null }
  | { ok: false; error: VodErrorCode }

/** The credential pair actually sent to the provider. */
export interface VodCredentials { username: string; token: string }

/** Optional overrides — the screens call these functions with no deps at all and get
 *  the real descriptor + the logged-in pair. Tests inject both ends. */
export interface VodDeps {
  /** `undefined` = read config/service.json; `null` = "no dev block". */
  dev?: { username?: string; token?: string } | null
  /** `undefined` = read the logged-in pair from the backend; `null` = not logged in. */
  saved?: { username: string; password: string } | null
  fetchImpl?: typeof fetch
}

// A browser-shaped User-Agent: the provider answers plainly to one and is unreliable
// without it. Pinned verbatim (D2 / S53-DESIGN "Provider API").
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const ACCEPT = 'application/json, text/plain, */*'

// The movie list can be tens of megabytes over a phone link — generous, but bounded so
// a black-holed provider cannot leave the grid spinning forever.
const TIMEOUT_MS = 20000

// Session cache: re-entering the section inside the TTL renders instantly instead of
// re-downloading the whole catalog. In memory only — it dies with the process, and a
// new login rebuilds it (config changes land at login anyway).
const CACHE_TTL_MS = 60 * 60 * 1000

interface CacheEntry { at: number; items: VodItem[] }
const listCache = new Map<string, CacheEntry>()

/** Drop every cached list (tests, and a sign-out that changes the account). */
export function clearVodCache (): void { listCache.clear() }

/** Dev-block override WINS when present and complete; otherwise the logged-in pair
 *  (app username -> `username`, app password -> `token`). null = cannot call at all. */
export function resolveCredentials (deps: VodDeps = {}): VodCredentials | null {
  const dev = deps.dev !== undefined ? deps.dev : readDevBlock()
  if (dev && typeof dev.username === 'string' && typeof dev.token === 'string' && dev.username && dev.token) {
    return { username: dev.username, token: dev.token }
  }
  const saved = deps.saved !== undefined ? deps.saved : (backend.creds ?? null)
  if (saved && saved.username && saved.password) return { username: saved.username, token: saved.password }
  return null
}

function readDevBlock (): { username?: string; token?: string } | null {
  try { return loadServiceDescriptor().vod?.dev ?? null } catch { return null }
}

/** The whole movie list, newest-added first. `sources.movies` absent = the operator
 *  enabled the provider without a movies source: an empty list, not an error. */
export async function listMovies (config: VodConfig, deps: VodDeps = {}): Promise<VodListResult> {
  const source = config.sources?.movies
  if (!source) return { ok: true, items: [] }
  const creds = resolveCredentials(deps)
  if (!creds) return { ok: false, error: 'auth' }

  const key = `${config.apiBase}|${config.service}|${source}|${creds.username}`
  const hit = listCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, items: hit.items }

  const url = composeUrl(config, 'getMovies.php', { source }, creds)
  if (!url) return { ok: false, error: 'network' } // non-https apiBase — refused, never dialed
  const res = await getJson(url, creds.token, deps.fetchImpl)
  if (!res.ok) return res
  const list = pickList(res.json)
  if (!list) return { ok: false, error: 'bad-response' }
  // Strip FIRST, then let the parsed payload go: holding tens of MB of raw objects
  // alive behind a few fields each is how this screen would OOM a phone.
  const items = list.map(stripItem).filter((it): it is VodItem => it !== null)
  items.sort((a, b) => b.added - a.added)
  listCache.set(key, { at: Date.now(), items })
  return { ok: true, items }
}

/** Detail for one title: the playable URL (+ runtime when the provider states one). */
export async function getMovieInfo (config: VodConfig, id: string, deps: VodDeps = {}): Promise<VodInfoResult> {
  const source = config.sources?.movies
  if (!source || !id) return { ok: false, error: 'bad-response' }
  const creds = resolveCredentials(deps)
  if (!creds) return { ok: false, error: 'auth' }
  const url = composeUrl(config, 'getMovieInfo.php', { source, id, version: '2' }, creds)
  if (!url) return { ok: false, error: 'network' }
  const res = await getJson(url, creds.token, deps.fetchImpl)
  if (!res.ok) return res
  return extractMovieInfo(res.json)
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

// TODO(S53d): the getMovieInfo response shape is UNVERIFIED — no live call has been
// made yet. This is a deliberately wide best guess over the shapes Xtream-style
// providers use (a url-ish field at the top level, or under `movie_data` / `info` /
// `movie` / `data`; runtime as `duration_secs`, `duration_sec` or `duration`, either
// numeric or "h:mm:ss"). S53d captures the REAL response and narrows this — plus the
// fixtures in __tests__/vodProvider.test.ts, which pin today's behavior so the swap is
// visible in a diff. It never throws: an unrecognized shape is 'bad-response'.
const URL_FIELDS = ['url', 'stream_url', 'streamUrl', 'movie_url', 'direct_source', 'play_url', 'playUrl', 'link', 'file', 'src', 'source_url']
const DURATION_FIELDS = ['duration_secs', 'durationSecs', 'duration_sec', 'durationSec', 'duration']
const INFO_CONTAINERS = ['movie_data', 'movieData', 'info', 'movie', 'data', 'result']

export function extractMovieInfo (json: unknown): VodInfoResult {
  const root = asRecord(json)
  if (!root) return { ok: false, error: 'bad-response' }
  const containers: Record<string, unknown>[] = [root]
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
  let durationSec: number | null = null
  for (const c of containers) {
    for (const f of DURATION_FIELDS) {
      const d = parseDuration(c[f])
      if (d != null) { durationSec = d; break }
    }
    if (durationSec != null) break
  }
  return { ok: true, url, durationSec }
}

// "5525" | 5525 | "01:32:05" | "32:05" -> seconds. Anything else (0, negative, junk)
// is "the provider didn't say" rather than a wrong number on the transport bar.
function parseDuration (v: unknown): number | null {
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
function pickList (json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json
  const root = asRecord(json)
  if (!root) return null
  for (const k of ['movies', 'items', 'data', 'result', 'results', 'list', 'channels']) {
    if (Array.isArray(root[k])) return root[k] as unknown[]
  }
  for (const v of Object.values(root)) if (Array.isArray(v)) return v as unknown[]
  return null
}

// One catalog row, reduced to what the grid actually renders. An item with no id and
// no name is dropped — it could never be shown or played.
function stripItem (raw: unknown): VodItem | null {
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

function str (v: unknown): string { return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : '') }
function asRecord (v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Build one provider URL. Returns '' when the config is not https — the app refuses
 *  to put a viewer's password on a cleartext wire, and there is no fallback. */
function composeUrl (config: VodConfig, endpoint: string, extra: Record<string, string>, creds: VodCredentials): string {
  const base = String(config.apiBase || '').replace(/\/+$/, '')
  if (!/^https:\/\/\S+$/i.test(base)) return ''
  const q: Record<string, string> = { service: config.service, ...extra, username: creds.username, token: creds.token }
  for (const [k, v] of Object.entries(config.params || {})) if (!(k in q)) q[k] = String(v)
  const qs = Object.entries(q).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  return `${base}/${endpoint}?${qs}`
}

type JsonResult = { ok: true; json: unknown } | { ok: false; error: VodErrorCode }

async function getJson (url: string, token: string, fetchImpl?: typeof fetch): Promise<JsonResult> {
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) return { ok: false, error: 'network' }
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = setTimeout(() => ctrl?.abort(), TIMEOUT_MS)
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: ACCEPT },
      signal: ctrl?.signal
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
export function redact (err: unknown, token: string): string {
  let s = err instanceof Error ? (err.message || err.name) : String(err)
  s = s.replace(/\?\S*/g, '?[redacted]')
  if (token) s = s.split(token).join('[redacted]')
  return s
}
