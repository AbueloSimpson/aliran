// Aliran panel admin API — authed HTTP+JSON over the shared ops (src/ops.js).
//
// Runs INSIDE the panel process (see src/index.js, ADMIN_ENABLED=1): the Corestore is
// single-writer, so a separate admin process would ELOCKED against the running panel.
//
// Auth: POST /api/login {username,password} → verified against the panel-private
// admins file (Argon2id, ops.verifyAdmin) → a panel-signed session token
// (core/token.js, payload {role:'admin', adminId, tokenVersion, expiresAt}). Every
// other /api route requires `Authorization: Bearer <token>`; revocation = bump the
// admin's tokenVersion. Login attempts share the fixed-window throttle from rpc.js.
//
// Binding: 127.0.0.1 by default. If you bind 0.0.0.0 on a VPS, put TLS in front
// (reverse proxy) — the API itself speaks plain HTTP.
//
//   POST   /api/login                        {username,password} → {token,expiresAt}
//   GET    /api/status
//   GET    /api/users
//   POST   /api/users                        {username,password}
//   GET    /api/users/:u
//   GET    /api/users/:u/devices
//   POST   /api/users/:u/password            {password}
//   POST   /api/users/:u/status              {status:'active'|'disabled'}
//   POST   /api/users/:u/logout-all
//   POST   /api/users/:u/max-devices         {maxDevices}
//   POST   /api/users/:u/grants              {streamId}
//   DELETE /api/users/:u/grants/:streamId
//   GET    /api/streams
//   POST   /api/streams                      {id,title?,description?,category?,feedKey?,key?}
//   PATCH  /api/streams/:id                  {title?,description?,category?,feedKey?,isLive?,status?,...}
//   POST   /api/streams/:id/art/:kind        raw image body (content-type → extension)
//   GET    /api/assets/:id/:file             art bytes from the assets drive (authed)
//
// Everything outside /api serves the static dashboard from panel/admin-ui/ (flat
// directory, GET only — see serveStatic for the traversal guard).

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { signToken, tokenValid } from '@aliran/core'
import { makeThrottle } from './rpc.js'
import * as ops from './ops.js'

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin-ui')

const JSON_BODY_LIMIT = 1024 * 1024 // 1 MiB
const ART_BODY_LIMIT = 10 * 1024 * 1024 // 10 MiB

const CONTENT_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

// ctx = { config, keys, db, assets, dataDir } (open panel store).
// opts = { host, port, sessionTtlMs, lockout: { threshold, seconds } }.
// Resolves to { server, host, port, close } once listening (port 0 → ephemeral).
export function startAdminServer (ctx, opts = {}) {
  const host = opts.host || '127.0.0.1'
  const sessionTtlMs = opts.sessionTtlMs || 12 * 3600000
  const lockout = opts.lockout || { threshold: 10, seconds: 900 }
  const throttle = makeThrottle(lockout.threshold, lockout.seconds)

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof ops.OpsError) {
        const status = err.code === 'not-found' ? 404 : err.code === 'exists' ? 409 : 400
        return sendJson(res, status, { error: err.message })
      }
      if (err && err.httpStatus) return sendJson(res, err.httpStatus, { error: err.message })
      console.error('admin-api error:', err)
      sendJson(res, 500, { error: 'internal error' })
    })
  })

  async function handle (req, res) {
    const url = new URL(req.url, 'http://x')
    const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (seg[0] !== 'api') {
      if (req.method !== 'GET') return sendJson(res, 404, { error: 'not found (API lives under /api)' })
      return serveStatic(res, url.pathname)
    }
    const [, r1, r2, r3, r4] = seg

    // --- login (the only unauthenticated route) ---
    if (r1 === 'login' && req.method === 'POST' && seg.length === 2) {
      const body = await readJson(req)
      const ip = req.socket.remoteAddress || 'unknown'
      const t = throttle((body.username || '') + '|' + ip)
      if (t.locked) return sendJson(res, 429, { error: 'locked', retryAfter: t.retryAfter })
      const admin = ops.verifyAdmin(ctx, body.username, body.password)
      if (!admin) return sendJson(res, 401, { error: 'invalid credentials' })
      const now = Date.now()
      const payload = { role: 'admin', adminId: admin.name, issuedAt: now, expiresAt: now + sessionTtlMs, tokenVersion: admin.tokenVersion }
      return sendJson(res, 200, { token: signToken(ctx.keys.signing.secretKey, payload), expiresAt: payload.expiresAt })
    }

    // --- everything else requires a live admin token ---
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    const payload = token && tokenValid(ctx.keys.signing.publicKey, token)
    if (!payload || !ops.adminTokenLive(ctx, payload)) {
      return sendJson(res, 401, { error: 'unauthorized' })
    }

    if (r1 === 'status' && req.method === 'GET' && seg.length === 2) {
      return sendJson(res, 200, await ops.statusSummary(ctx))
    }

    // Art bytes for the dashboard previews. Authed like everything else — the
    // dashboard fetches with the token and renders blob: URLs.
    if (r1 === 'assets' && req.method === 'GET' && seg.length === 4) {
      if (!SAFE_FILE_RE.test(r2) || !SAFE_FILE_RE.test(r3)) return sendJson(res, 404, { error: 'not found' })
      const buf = await ctx.assets.get(`/${r2}/${r3}`)
      if (!buf) return sendJson(res, 404, { error: 'not found' })
      return sendRaw(res, 200, buf, EXT_CONTENT[path.extname(r3).toLowerCase()] || 'application/octet-stream')
    }

    if (r1 === 'users') {
      if (seg.length === 2) {
        if (req.method === 'GET') return sendJson(res, 200, await ops.listUsers(ctx))
        if (req.method === 'POST') {
          const b = await readJson(req)
          return sendJson(res, 201, await ops.createUser(ctx, b.username, b.password))
        }
      }
      if (seg.length === 3 && req.method === 'GET') return sendJson(res, 200, await ops.getUser(ctx, r2))
      if (seg.length === 4 && req.method === 'POST') {
        const u = r2
        if (r3 === 'password') return sendJson(res, 200, await ops.setPassword(ctx, u, (await readJson(req)).password))
        if (r3 === 'status') return sendJson(res, 200, await ops.setUserStatus(ctx, u, (await readJson(req)).status))
        if (r3 === 'logout-all') return sendJson(res, 200, await ops.logoutAll(ctx, u))
        if (r3 === 'max-devices') return sendJson(res, 200, await ops.setMaxDevices(ctx, u, (await readJson(req)).maxDevices))
        if (r3 === 'grants') return sendJson(res, 200, await ops.grant(ctx, u, ops.checkName((await readJson(req)).streamId, 'stream id')))
      }
      if (seg.length === 4 && r3 === 'devices' && req.method === 'GET') {
        return sendJson(res, 200, await ops.listDevices(ctx, r2))
      }
      if (seg.length === 5 && r3 === 'grants' && req.method === 'DELETE') {
        return sendJson(res, 200, await ops.revoke(ctx, r2, r4))
      }
    }

    if (r1 === 'streams') {
      if (seg.length === 2) {
        if (req.method === 'GET') return sendJson(res, 200, await ops.listStreams(ctx))
        if (req.method === 'POST') {
          const b = await readJson(req)
          return sendJson(res, 201, await ops.addStream(ctx, b.id, b))
        }
      }
      if (seg.length === 3 && req.method === 'PATCH') {
        return sendJson(res, 200, await ops.setMeta(ctx, r2, await readJson(req)))
      }
      if (seg.length === 5 && r3 === 'art' && req.method === 'POST') {
        const data = await readBody(req, ART_BODY_LIMIT)
        const ext = CONTENT_EXT[(req.headers['content-type'] || '').split(';')[0].trim()] || '.bin'
        return sendJson(res, 200, await ops.uploadArt(ctx, r2, r4, data, ext))
      }
    }

    sendJson(res, 404, { error: 'not found' })
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 3210, host, () => {
      server.removeListener('error', reject)
      const port = server.address().port
      resolve({
        server,
        host,
        port,
        close: () => new Promise((r) => server.close(r))
      })
    })
  })
}

// No leading dot (blocks '..' and dotfiles), no separators — traversal-proof.
const SAFE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const EXT_CONTENT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
}

// The dashboard is a flat directory of small files — sync reads keep this simple,
// and the traffic is one admin.
function serveStatic (res, pathname) {
  let name
  try { name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)) } catch { name = null }
  const type = name && SAFE_FILE_RE.test(name) && EXT_CONTENT[path.extname(name).toLowerCase()]
  if (!type) return sendJson(res, 404, { error: 'not found' })
  let data
  try { data = fs.readFileSync(path.join(UI_DIR, name)) } catch { return sendJson(res, 404, { error: 'not found' }) }
  sendRaw(res, 200, data, type)
}

// Never throws (same rationale as sendJson).
function sendRaw (res, status, buf, type) {
  if (res.destroyed || res.writableEnded || res.headersSent) return
  try {
    res.writeHead(status, {
      'content-type': type,
      'content-length': buf.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; img-src 'self' blob: data:"
    })
    res.end(buf)
  } catch {}
}

// Never throws — the socket may already be gone (e.g. destroyed by the body limit),
// and an exception here would reject handle()'s catch and take down the panel.
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

function readBody (req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); return reject(httpError(413, 'payload too large')) }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson (req) {
  const buf = await readBody(req, JSON_BODY_LIMIT)
  if (buf.length === 0) return {}
  try { return JSON.parse(buf.toString('utf8')) } catch { throw httpError(400, 'invalid JSON body') }
}
