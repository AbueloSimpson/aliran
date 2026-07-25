// The one road to an Aliran Bearer API (panel admin :3210 / broadcaster control
// :3310). Ported in spirit from reseller/src/panel-client.js — same cardinal rule:
// NEVER burn logins. Both services throttle /api/login at 10 attempts / 900 s per
// (username|ip), so:
//
//   - the 12 h Bearer token is cached in memory AND persisted to
//     <dataDir>/state/<name>-token.json (0600) so a restart reuses a live token
//     instead of re-logging;
//   - login is single-flight (one in-flight login, ever);
//   - a 401 on any call drops the token, re-logins ONCE and retries ONCE (the
//     tokenVersion-bump / expiry path);
//   - a login 429 surfaces as `locked` with no retry loop;
//   - a login 503 (the panel's single-flight verifier) gets ONE jittered retry.
//
// Error contract: network/timeout → ApiError 'unreachable'; a service 4xx/5xx →
// ApiError 'rejected' carrying the service's own status + error text, so the model
// (reading the tool result) knows exactly which side said no.

import fs from 'fs'
import path from 'path'

export class ApiError extends Error {
  constructor (code, message, httpStatus = 0) {
    super(message)
    this.code = code
    this.httpStatus = httpStatus
  }
}

// --- tiny atomic JSON persistence for the token cache (0600) ---
function readJsonFile (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJsonFile (file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

// svc = normalized { name, url, username, password, timeoutMs } (config.js).
// baseUrl overrides svc.url (index.js passes a tunnel URL when there is no direct
// url). dataDir is where the token cache lives.
export function makeHttpClient (svc, { baseUrl, dataDir } = {}) {
  const base = (baseUrl || svc.url || '').replace(/\/+$/, '')
  const timeoutMs = svc.timeoutMs || 15000
  const tokenFile = path.join(dataDir || '.', 'state', `${svc.name}-token.json`)

  let token = null // { token, expiresAt }
  let loginInflight = null
  let lastOkAt = null
  let lastError = null
  const saved = readJsonFile(tokenFile, null)
  if (saved && saved.token && saved.expiresAt > Date.now() + 60000) token = saved

  // raw = { buf, contentType }: send the bytes as-is (art uploads) instead of a
  // JSON body. Mutually exclusive with `body`.
  async function rawFetch (method, apiPath, body, bearer, raw) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    if (timer.unref) timer.unref()
    try {
      const res = await fetch(base + apiPath, {
        method,
        signal: ac.signal,
        headers: {
          ...(raw ? { 'content-type': raw.contentType } : body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
        },
        body: raw ? raw.buf : body !== undefined ? JSON.stringify(body) : undefined
      })
      let json = null
      try { json = await res.json() } catch {}
      return { status: res.status, json }
    } catch (err) {
      lastError = { at: Date.now(), message: String((err && err.message) || err) }
      const why = err && err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : (err && err.message) || err
      throw new ApiError('unreachable', `${svc.name} API unreachable at ${base} (${why})`)
    } finally {
      clearTimeout(timer)
    }
  }

  async function login () {
    if (loginInflight) return loginInflight
    loginInflight = (async () => {
      let r = await rawFetch('POST', '/api/login', { username: svc.username, password: svc.password })
      if (r.status === 503) {
        await new Promise((res) => setTimeout(res, 1000 + Math.random() * 1000))
        r = await rawFetch('POST', '/api/login', { username: svc.username, password: svc.password })
      }
      if (r.status === 429) throw new ApiError('locked', `${svc.name} login throttled (retry in ${r.json && r.json.retryAfter}s) — never hammer /api/login`, 429)
      if (r.status === 401) throw new ApiError('auth', `${svc.name} rejected the admin credentials — check the config`, 401)
      if (r.status !== 200 || !r.json || !r.json.token) throw new ApiError('login', `${svc.name} login failed (status ${r.status})`, r.status)
      token = { token: r.json.token, expiresAt: r.json.expiresAt }
      try { writeJsonFile(tokenFile, token) } catch {}
      return token
    })()
    try {
      return await loginInflight
    } finally {
      loginInflight = null
    }
  }

  // Authenticated request with the once-each 401-relogin-retry.
  async function req (method, apiPath, body, raw) {
    if (!token || token.expiresAt < Date.now() + 60000) await login()
    let r = await rawFetch(method, apiPath, body, token.token, raw)
    if (r.status === 401) {
      token = null
      await login()
      r = await rawFetch(method, apiPath, body, token.token, raw)
    }
    if (r.status >= 200 && r.status < 300) {
      lastOkAt = Date.now()
      return r.json
    }
    const msg = (r.json && r.json.error) || `status ${r.status}`
    throw new ApiError('rejected', `${svc.name}: ${msg}`, r.status)
  }

  function healthInfo () {
    const reachable = lastOkAt !== null && (!lastError || lastOkAt >= lastError.at)
    return {
      reachable: lastOkAt === null && lastError === null ? null : reachable,
      lastOkAt,
      lastError: lastError ? lastError.message : null,
      base
    }
  }

  return {
    base,
    login,
    get: (p) => req('GET', p),
    post: (p, body) => req('POST', p, body === undefined ? {} : body),
    // Raw bytes with an explicit content-type (the panel art route reads the
    // content-type to pick the stored extension). Never JSON-wrapped.
    postRaw: (p, buf, contentType) => req('POST', p, undefined, { buf, contentType }),
    patch: (p, body) => req('PATCH', p, body === undefined ? {} : body),
    // A body on DELETE is unusual but real here: the panel's category routes carry
    // the slug in the body (slugs may contain '/'). Existing callers pass no body.
    del: (p, body) => req('DELETE', p, body),
    // Unauthenticated liveness probe (every service exposes /healthz).
    healthz: async () => (await rawFetch('GET', '/healthz')).json,
    healthInfo
  }
}
