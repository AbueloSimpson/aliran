// The one road to the panel: a token-cached client for the panel admin HTTP API
// (panel/src/admin-server.js). Everything the reseller service does to a viewer
// account goes through here, as the ONE dedicated panel admin the operator
// enrolled for this service.
//
// The panel's login throttle is 10 attempts / 900 s keyed username|ip, so the
// cardinal rule is: NEVER burn logins. The Bearer token (12 h TTL) is cached in
// memory AND persisted to DATA_DIR/state/panel-token.json (0600) so a crash-loop
// reuses the live token instead of re-logging every boot; login is single-flight;
// a 401 on any call drops the token, re-logins ONCE and retries ONCE (that's the
// tokenVersion-bump / expiry path); a login 429 surfaces as `panel-locked` with
// no retry loop; a login 503 (the panel's single-flight verifier) gets ONE retry
// after a short jitter.
//
// Error contract: network/timeout → PanelError 'panel-unreachable' (HTTP 502
// through our control server); panel 4xx/5xx → PanelError carrying the panel's
// own status and its error text prefixed `PANEL:` — a reseller reading the
// message knows which side said no.

import path from 'path'
import { PanelError } from './errors.js'
import { readJsonFile, writeJsonFile } from './store.js'

export function makePanelClient (config) {
  const base = config.panel.url
  const timeoutMs = config.panel.timeoutMs || 10000
  const tokenFile = path.join(config.dataDir || './data', 'state', 'panel-token.json')

  let token = null // { token, expiresAt }
  let loginInflight = null
  let lastOkAt = null
  let lastError = null
  const saved = readJsonFile(tokenFile, null)
  if (saved && saved.token && saved.expiresAt > Date.now() + 60000) token = saved

  async function rawFetch (method, apiPath, body, bearer) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    if (timer.unref) timer.unref()
    try {
      const res = await fetch(base + apiPath, {
        method,
        signal: ac.signal,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
      let json = null
      try { json = await res.json() } catch {}
      return { status: res.status, json }
    } catch (err) {
      lastError = { at: Date.now(), message: String(err && err.message || err) }
      throw new PanelError('panel-unreachable', `panel unreachable at ${base} (${err && err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message})`)
    } finally {
      clearTimeout(timer)
    }
  }

  async function login () {
    if (loginInflight) return loginInflight
    loginInflight = (async () => {
      if (!config.panel.username || !config.panel.password) {
        throw new PanelError('panel-config', 'PANEL_ADMIN_USER / PANEL_ADMIN_PASS not configured')
      }
      let r = await rawFetch('POST', '/api/login', { username: config.panel.username, password: config.panel.password })
      if (r.status === 503) {
        // The panel's verifier is single-flight; one polite retry.
        await new Promise((res) => setTimeout(res, 1000 + Math.random() * 1000))
        r = await rawFetch('POST', '/api/login', { username: config.panel.username, password: config.panel.password })
      }
      if (r.status === 429) throw new PanelError('panel-locked', `panel login throttled (retry in ${r.json && r.json.retryAfter}s) — never hammer /api/login`)
      if (r.status === 401) throw new PanelError('panel-auth', 'panel rejected the service admin credentials — check PANEL_ADMIN_USER/PASS')
      if (r.status !== 200 || !r.json || !r.json.token) throw new PanelError('panel-login', `panel login failed (${r.status})`)
      token = { token: r.json.token, expiresAt: r.json.expiresAt }
      writeJsonFile(tokenFile, token, { mode: 0o600 })
      return token
    })()
    try {
      return await loginInflight
    } finally {
      loginInflight = null
    }
  }

  // Authenticated request with the once-each 401-relogin-retry.
  async function req (method, apiPath, body) {
    if (!token || token.expiresAt < Date.now() + 60000) await login()
    let r = await rawFetch(method, apiPath, body, token.token)
    if (r.status === 401) {
      token = null
      await login()
      r = await rawFetch(method, apiPath, body, token.token)
    }
    if (r.status >= 200 && r.status < 300) {
      lastOkAt = Date.now()
      return r.json
    }
    const msg = (r.json && r.json.error) || `status ${r.status}`
    throw new PanelError('panel-rejected', msg, r.status)
  }

  function healthInfo () {
    const reachable = lastOkAt !== null && (!lastError || lastOkAt >= lastError.at)
    return { reachable: lastOkAt === null && lastError === null ? null : reachable, lastOkAt, lastError: lastError ? lastError.message : null }
  }

  return {
    req,
    login,
    status: () => req('GET', '/api/status'),
    streams: () => req('GET', '/api/streams'),
    healthInfo
  }
}
