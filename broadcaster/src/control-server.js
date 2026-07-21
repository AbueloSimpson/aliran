// Aliran broadcaster control API — authed HTTP+JSON over the ChannelManager.
// Same skeleton as the panel admin server (panel/src/admin-server.js).
//
// Auth: POST /api/login against DATA_DIR/secrets/admins.json (control-cli add-admin)
// → session token signed with the broadcaster-local control keypair. Every other
// /api route requires `Authorization: Bearer <token>`. Login is rate-limited AND
// single-flight: the Argon2id verify runs in a worker thread (never on the event
// loop — a login flood must not stall media/replication), one verify at a time,
// concurrent attempts get an immediate 503.
// Binding: 127.0.0.1 by default; put TLS in front if you expose it.
//
//   POST   /api/login                    {username,password} → {token,expiresAt}
//   GET    /api/status
//   GET    /api/capabilities             ffmpeg probe: protocols + deep-verified encoders
//   GET    /api/channels                 list + live status (state/ffmpeg/peers/registered/ingest)
//   POST   /api/channels                 {id,title?,description?,category?,input?,transcode?,buffer?,hlsTime?,hlsListSize?}
//   GET    /api/channels/:id
//   PATCH  /api/channels/:id             meta/input/transcode changes (applied on next start)
//   DELETE /api/channels/:id             remove from registry (must be stopped; data kept)
//   POST   /api/channels/:id/start
//   POST   /api/channels/:id/stop
//   POST   /api/channels/:id/rotate       disk mode: mint a fresh feed generation now
//                                          (bounds merkle-tree growth; viewers follow live)
//   GET    /api/channels/:id/logs?lines=N  ffmpeg stderr ring → {lines,running,restarts,state}
//   GET    /api/admins
//   POST   /api/admins                   {username,password}
//   DELETE /api/admins/:name
//   POST   /api/admins/:name/password    {password} (bumps tokenVersion → re-login)
//
// Non-/api GETs serve the control UI from broadcaster/control-ui/ (S12b).

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { signToken, tokenValid } from '@aliran/core'
import { ControlError } from './channel.js'
import { makeThrottle, controlKeys, makeAdminVerifier, adminTokenLive, addAdmin, removeAdmin, listAdmins, setAdminPassword } from './control-auth.js'

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'control-ui')
const JSON_BODY_LIMIT = 1024 * 1024 // 1 MiB

// ctx = { config, manager, dataDir }.
// opts = { host, port, sessionTtlMs, lockout: { threshold, seconds }, loginVerifyTimeoutMs }.
// Resolves to { server, host, port, close } once listening (port 0 → ephemeral).
export function startControlServer (ctx, opts = {}) {
  const host = opts.host || '127.0.0.1'
  const sessionTtlMs = opts.sessionTtlMs || 12 * 3600000
  const lockout = opts.lockout || { threshold: 10, seconds: 900 }
  const throttle = makeThrottle(lockout.threshold, lockout.seconds)
  const loginVerifier = makeAdminVerifier(ctx, { timeoutMs: opts.loginVerifyTimeoutMs })
  const keys = controlKeys(ctx.dataDir)

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof ControlError) {
        const status = err.code === 'not-found' ? 404 : err.code === 'exists' ? 409 : 400
        return sendJson(res, status, { error: err.message })
      }
      if (err && err.httpStatus) return sendJson(res, err.httpStatus, { error: err.message })
      console.error('control-api error:', err)
      sendJson(res, 500, { error: 'internal error' })
    })
  })

  async function handle (req, res) {
    const url = new URL(req.url, 'http://x')
    const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    // Liveness + boot-resume progress. Deliberately UNAUTHENTICATED and handled FIRST, before
    // the /api routing and the auth gate: its entire job is to answer "up and resuming N/total"
    // vs "dead" while a mass resume keeps the authenticated API busy. Cheap and synchronous
    // (manager.health() does no I/O or await), so it responds as long as the loop turns at all.
    if (seg[0] === 'healthz' && seg.length === 1) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      return sendJson(res, 200, ctx.manager.health())
    }
    if (seg[0] !== 'api') {
      if (req.method !== 'GET') return sendJson(res, 404, { error: 'not found (API lives under /api)' })
      return serveStatic(res, url.pathname)
    }
    const [, r1, r2, r3] = seg

    if (r1 === 'login' && req.method === 'POST' && seg.length === 2) {
      const body = await readJson(req)
      const ip = req.socket.remoteAddress || 'unknown'
      const t = throttle((body.username || '') + '|' + ip)
      if (t.locked) return sendJson(res, 429, { error: 'locked', retryAfter: t.retryAfter })
      // Worker-thread verify; throws 503 immediately if one is already in flight.
      const admin = await loginVerifier.verify(body.username, body.password)
      if (!admin) return sendJson(res, 401, { error: 'invalid credentials' })
      const now = Date.now()
      const payload = { role: 'admin', adminId: admin.name, issuedAt: now, expiresAt: now + sessionTtlMs, tokenVersion: admin.tokenVersion }
      return sendJson(res, 200, { token: signToken(keys.secretKey, payload), expiresAt: payload.expiresAt })
    }

    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    const payload = token && tokenValid(keys.publicKey, token)
    if (!payload || !adminTokenLive(ctx, payload)) {
      return sendJson(res, 401, { error: 'unauthorized' })
    }

    if (r1 === 'status' && req.method === 'GET' && seg.length === 2) {
      return sendJson(res, 200, await ctx.manager.statusSummary())
    }

    // What the host ffmpeg can actually do (probed once per process, cached). The UI
    // hides unavailable push protocols and disables unverified encoders off this.
    if (r1 === 'capabilities' && req.method === 'GET' && seg.length === 2) {
      return sendJson(res, 200, await ctx.manager.capabilities())
    }

    // Correlated incidents (see incidents.js): fleet-wide respawn bursts and source
    // failovers, newest first. Ephemeral — a broadcaster restart clears it.
    if (r1 === 'incidents' && req.method === 'GET' && seg.length === 2) {
      return sendJson(res, 200, ctx.manager.incidents.list())
    }

    if (r1 === 'admins') {
      if (seg.length === 2) {
        if (req.method === 'GET') return sendJson(res, 200, listAdmins(ctx))
        if (req.method === 'POST') {
          const b = await readJson(req)
          return sendJson(res, 201, addAdmin(ctx, b.username, b.password))
        }
      }
      if (seg.length === 3 && req.method === 'DELETE') return sendJson(res, 200, removeAdmin(ctx, r2))
      if (seg.length === 4 && r3 === 'password' && req.method === 'POST') {
        return sendJson(res, 200, setAdminPassword(ctx, r2, (await readJson(req)).password))
      }
    }

    if (r1 === 'channels') {
      if (seg.length === 2) {
        if (req.method === 'GET') return sendJson(res, 200, await ctx.manager.list())
        if (req.method === 'POST') {
          const b = await readJson(req)
          return sendJson(res, 201, await ctx.manager.add(b.id, b))
        }
      }
      if (seg.length === 3) {
        if (req.method === 'GET') return sendJson(res, 200, await ctx.manager.get(r2))
        if (req.method === 'PATCH') return sendJson(res, 200, await ctx.manager.update(r2, await readJson(req)))
        if (req.method === 'DELETE') return sendJson(res, 200, await ctx.manager.remove(r2))
      }
      if (seg.length === 4 && req.method === 'POST') {
        if (r3 === 'start') return sendJson(res, 200, await ctx.manager.start(r2))
        if (r3 === 'stop') return sendJson(res, 200, await ctx.manager.stop(r2))
        if (r3 === 'rotate') return sendJson(res, 200, await ctx.manager.rotate(r2))
      }
      // The per-channel ffmpeg stderr ring (S15b) — why a source won't play. Survives
      // watchdog respawns (restart markers); cleared on an operator start.
      if (seg.length === 4 && r3 === 'logs' && req.method === 'GET') {
        const raw = parseInt(url.searchParams.get('lines'), 10)
        const lines = ctx.manager.logs(r2, Number.isInteger(raw) && raw > 0 ? Math.min(raw, 400) : undefined)
        const st = await ctx.manager.get(r2)
        return sendJson(res, 200, { lines, running: st.running, restarts: st.watchdog ? st.watchdog.restarts : 0, state: st.state })
      }
    }

    sendJson(res, 404, { error: 'not found' })
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 3310, host, () => {
      server.removeListener('error', reject)
      const port = server.address().port
      resolve({
        server,
        host,
        port,
        close: () => { loginVerifier.close(); return new Promise((r) => server.close(r)) }
      })
    })
  })
}

// --- helpers (same never-throw rationale as panel/src/admin-server.js) ---

const SAFE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const EXT_CONTENT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

function serveStatic (res, pathname) {
  let name
  try { name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)) } catch { name = null }
  const type = name && SAFE_FILE_RE.test(name) && EXT_CONTENT[path.extname(name).toLowerCase()]
  if (!type) return sendJson(res, 404, { error: 'not found' })
  let data
  try { data = fs.readFileSync(path.join(UI_DIR, name)) } catch { return sendJson(res, 404, { error: 'not found' }) }
  if (res.destroyed || res.writableEnded || res.headersSent) return
  try {
    res.writeHead(200, {
      'content-type': type,
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; img-src 'self' blob: data:"
    })
    res.end(data)
  } catch {}
}

function sendJson (res, status, obj) {
  if (res.destroyed || res.writableEnded || res.headersSent) return
  try {
    const body = JSON.stringify(obj)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  } catch {}
}

function httpError (status, message) {
  const e = new Error(message)
  e.httpStatus = status
  return e
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > JSON_BODY_LIMIT) { req.destroy(); return reject(httpError(413, 'payload too large')) }
      chunks.push(c)
    })
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      if (buf.length === 0) return resolve({})
      try { resolve(JSON.parse(buf.toString('utf8'))) } catch { reject(httpError(400, 'invalid JSON body')) }
    })
    req.on('error', reject)
  })
}
