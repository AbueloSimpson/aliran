// Aliran panel admin API — authed HTTP+JSON over the shared ops (src/ops.js).
//
// Runs INSIDE the panel process (see src/index.js, ADMIN_ENABLED=1): the Corestore is
// single-writer, so a separate admin process would ELOCKED against the running panel.
//
// Auth: POST /api/login {username,password} → verified against the panel-private
// admins file (Argon2id, ops.makeAdminVerifier — the verify runs in a worker
// thread, never on the event loop: a login flood must not stall the login RPC or
// catalog replication; one verify at a time, concurrent attempts get an immediate
// 503) → a panel-signed session token (core/token.js, payload {role:'admin',
// adminId, tokenVersion, expiresAt}). Every other /api route requires
// `Authorization: Bearer <token>`; revocation = bump the admin's tokenVersion.
// Login attempts share the fixed-window throttle from rpc.js.
//
// Binding: 127.0.0.1 by default. If you bind 0.0.0.0 on a VPS, put TLS in front
// (reverse proxy) — the API itself speaks plain HTTP.
//
//   POST   /api/login                        {username,password} → {token,expiresAt}
//   GET    /api/status
//   GET    /api/observability                uptime/mem/swarm/data + activity ring
//   GET    /api/users?prefix&after&limit     → {users,next} (prefix search + cursor)
//   POST   /api/users                        {username,password}
//   GET    /api/users/:u
//   DELETE /api/users/:u                     delete the account record
//   GET    /api/users/:u/devices
//   DELETE /api/users/:u/devices/:deviceId   drop one enrollment (no tokenVersion bump)
//   POST   /api/users/:u/password            {password}
//   POST   /api/users/:u/status              {status:'active'|'disabled'}
//   POST   /api/users/:u/logout-all
//   POST   /api/users/:u/max-devices         {maxDevices}
//   POST   /api/users/:u/grants              {streamId}
//   DELETE /api/users/:u/grants/:streamId
//   GET    /api/streams
//   POST   /api/streams                      {id,title?,description?,category?,feedKey?,key?,order?,featured?,url?}
//                                            url (https) makes it a REDIRECT channel: viewers play the url, no P2P feed
//   PATCH  /api/streams/:id                  {title?,description?,category?,feedKey?,isLive?,status?,order?,featured?,url?,...}
//   DELETE /api/streams/:id                  FULL purge (catalog+secret+grants+art)
//   POST   /api/streams/:id/art/:kind        raw image body (content-type → extension)
//   GET    /api/assets/:id/:file             art bytes from the assets drive (authed)
//   GET    /api/admins
//   POST   /api/admins                       {username,password}
//   DELETE /api/admins/:name
//   POST   /api/admins/:name/password        {password} (bumps tokenVersion → re-login)
//   GET    /api/publishers                   enrolled broadcaster identities (S26)
//   POST   /api/publishers                   {name,scopes?} → keypair; secretKey returned ONCE
//   DELETE /api/publishers/:name             hard delete (prefer revoke — keeps the audit trail)
//   POST   /api/publishers/:name/status      {status:'active'|'revoked'}
//   POST   /api/publishers/:name/scopes      {scopes:['east-*',…]} (streamId globs)
//   GET    /api/sources                      remote channel sources (S27) + owned-channel counts
//   POST   /api/sources                      {name,url,category,prefix?,autoGrant?,enabled?,intervalMs?}
//   PATCH  /api/sources/:name                edit any of the above fields
//   DELETE /api/sources/:name                purges its channels; ?keepChannels=1 detaches them instead
//   POST   /api/sources/:name/sync           pull + diff + grant NOW; returns the sync report
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
import * as sources from './sources.js'

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin-ui')

const JSON_BODY_LIMIT = 1024 * 1024 // 1 MiB
const ART_BODY_LIMIT = 10 * 1024 * 1024 // 10 MiB

const CONTENT_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

// ctx = { config, keys, db, assets, dataDir, swarm?, activity? } (open panel store;
// swarm + activity ring are optional — observability degrades gracefully without them).
// opts = { host, port, sessionTtlMs, lockout: { threshold, seconds }, loginVerifyTimeoutMs }.
// Resolves to { server, host, port, close } once listening (port 0 → ephemeral).
export function startAdminServer (ctx, opts = {}) {
  const host = opts.host || '127.0.0.1'
  const sessionTtlMs = opts.sessionTtlMs || 12 * 3600000
  const lockout = opts.lockout || { threshold: 10, seconds: 900 }
  const throttle = makeThrottle(lockout.threshold, lockout.seconds)
  const loginVerifier = ops.makeAdminVerifier(ctx, { timeoutMs: opts.loginVerifyTimeoutMs })

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
      // Worker-thread verify; throws 503 immediately if one is already in flight.
      const admin = await loginVerifier.verify(body.username, body.password)
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
    // Feed the observability activity ring on every successful admin mutation
    // (called only after the op resolved — a thrown OpsError records nothing).
    const act = (op, fields = {}) => { if (ctx.activity) ctx.activity.record('admin', { op, admin: payload.adminId, ...fields }) }

    if (r1 === 'status' && req.method === 'GET' && seg.length === 2) {
      return sendJson(res, 200, await ops.statusSummary(ctx))
    }

    if (r1 === 'observability' && req.method === 'GET' && seg.length === 2) {
      return sendJson(res, 200, await observability(ctx))
    }

    if (r1 === 'admins') {
      if (seg.length === 2) {
        if (req.method === 'GET') return sendJson(res, 200, ops.listAdmins(ctx))
        if (req.method === 'POST') {
          const b = await readJson(req)
          const out = ops.addAdmin(ctx, b.username, b.password)
          act('admin-create', { target: b.username })
          return sendJson(res, 201, out)
        }
      }
      if (seg.length === 3 && req.method === 'DELETE') {
        const out = ops.removeAdmin(ctx, r2)
        act('admin-remove', { target: r2 })
        return sendJson(res, 200, out)
      }
      if (seg.length === 4 && r3 === 'password' && req.method === 'POST') {
        const out = ops.setAdminPassword(ctx, r2, (await readJson(req)).password)
        act('admin-password', { target: r2 })
        return sendJson(res, 200, out)
      }
    }

    // Enrolled broadcaster identities (S26). POST returns the secret key ONCE —
    // it goes in that site's broadcaster .env and is never stored panel-side.
    if (r1 === 'publishers') {
      if (seg.length === 2) {
        if (req.method === 'GET') return sendJson(res, 200, ops.listPublishers(ctx))
        if (req.method === 'POST') {
          const b = await readJson(req)
          const out = ops.addPublisher(ctx, b.name, { scopes: b.scopes })
          act('publisher-create', { publisher: b.name, scopes: out.scopes.join(',') })
          return sendJson(res, 201, out)
        }
      }
      if (seg.length === 3 && req.method === 'DELETE') {
        const out = ops.removePublisher(ctx, r2)
        act('publisher-remove', { publisher: r2 })
        return sendJson(res, 200, out)
      }
      if (seg.length === 4 && r3 === 'status' && req.method === 'POST') {
        const out = ops.setPublisherStatus(ctx, r2, (await readJson(req)).status)
        act('publisher-status', { publisher: r2, status: out.status })
        return sendJson(res, 200, out)
      }
      if (seg.length === 4 && r3 === 'scopes' && req.method === 'POST') {
        const out = ops.setPublisherScopes(ctx, r2, (await readJson(req)).scopes)
        act('publisher-scopes', { publisher: r2, scopes: out.scopes.join(',') })
        return sendJson(res, 200, out)
      }
    }

    // Remote channel sources (S27): provider JSON feeds materialized as
    // redirect-channel categories. Sync is synchronous (bounded by the fetch
    // timeout) so the dashboard gets the report back in the same request.
    if (r1 === 'sources') {
      if (seg.length === 2) {
        if (req.method === 'GET') return sendJson(res, 200, await sources.listSources(ctx))
        if (req.method === 'POST') {
          const b = await readJson(req)
          const out = sources.addSource(ctx, b.name, b)
          act('source-create', { source: b.name, category: out.category })
          return sendJson(res, 201, out)
        }
      }
      if (seg.length === 3) {
        if (req.method === 'PATCH') {
          const out = sources.setSource(ctx, r2, await readJson(req))
          act('source-update', { source: r2 })
          return sendJson(res, 200, out)
        }
        if (req.method === 'DELETE') {
          const keep = /^(1|true)$/i.test(url.searchParams.get('keepChannels') || '')
          const out = await sources.removeSource(ctx, r2, { keepChannels: keep })
          act('source-remove', { source: r2, removed: out.removed, detached: out.detached })
          return sendJson(res, 200, out)
        }
      }
      if (seg.length === 4 && r3 === 'sync' && req.method === 'POST') {
        const out = await sources.syncSource(ctx, r2)
        act('source-sync', { source: r2, added: out.added, updated: out.updated, removed: out.removed, granted: out.granted })
        return sendJson(res, 200, out)
      }
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
        if (req.method === 'GET') {
          return sendJson(res, 200, await ops.listUsers(ctx, {
            prefix: url.searchParams.get('prefix') || '',
            after: url.searchParams.get('after') || '',
            limit: url.searchParams.get('limit') || 50
          }))
        }
        if (req.method === 'POST') {
          const b = await readJson(req)
          let out = await ops.createUser(ctx, b.username, b.password)
          // Auto-grant source channels immediately (S27) — best-effort: the user
          // exists either way, and the next source sync reconciles any miss.
          try {
            if (await sources.grantSourcesToUser(ctx, b.username) > 0) out = await ops.getUser(ctx, b.username)
          } catch (err) { console.error('sources auto-grant failed for', b.username + ':', err.message || err) }
          act('user-create', { user: b.username })
          return sendJson(res, 201, out)
        }
      }
      if (seg.length === 3) {
        if (req.method === 'GET') return sendJson(res, 200, await ops.getUser(ctx, r2))
        if (req.method === 'DELETE') {
          const out = await ops.deleteUser(ctx, r2)
          act('user-delete', { user: r2 })
          return sendJson(res, 200, out)
        }
      }
      if (seg.length === 4 && req.method === 'POST') {
        const u = r2
        let out = null
        if (r3 === 'password') { out = await ops.setPassword(ctx, u, (await readJson(req)).password); act('user-password', { user: u }) }
        else if (r3 === 'status') { out = await ops.setUserStatus(ctx, u, (await readJson(req)).status); act('user-status', { user: u, status: out.status }) }
        else if (r3 === 'logout-all') { out = await ops.logoutAll(ctx, u); act('user-logout-all', { user: u }) }
        else if (r3 === 'max-devices') { out = await ops.setMaxDevices(ctx, u, (await readJson(req)).maxDevices); act('user-max-devices', { user: u }) }
        else if (r3 === 'grants') {
          const streamId = ops.checkName((await readJson(req)).streamId, 'stream id')
          out = await ops.grant(ctx, u, streamId); act('grant', { user: u, streamId })
        }
        if (out) return sendJson(res, 200, out)
      }
      if (seg.length === 4 && r3 === 'devices' && req.method === 'GET') {
        return sendJson(res, 200, await ops.listDevices(ctx, r2))
      }
      if (seg.length === 5 && r3 === 'devices' && req.method === 'DELETE') {
        const out = await ops.revokeDevice(ctx, r2, r4)
        act('device-revoke', { user: r2, deviceId: r4 })
        return sendJson(res, 200, out)
      }
      if (seg.length === 5 && r3 === 'grants' && req.method === 'DELETE') {
        const out = await ops.revoke(ctx, r2, r4)
        act('revoke', { user: r2, streamId: r4 })
        return sendJson(res, 200, out)
      }
    }

    if (r1 === 'streams') {
      if (seg.length === 2) {
        if (req.method === 'GET') return sendJson(res, 200, await ops.listStreams(ctx))
        if (req.method === 'POST') {
          const b = await readJson(req)
          const out = await ops.addStream(ctx, b.id, b)
          act('stream-create', { streamId: b.id })
          return sendJson(res, 201, out)
        }
      }
      if (seg.length === 3) {
        if (req.method === 'PATCH') {
          const out = await ops.setMeta(ctx, r2, await readJson(req))
          act('stream-meta', { streamId: r2 })
          return sendJson(res, 200, out)
        }
        if (req.method === 'DELETE') {
          const out = await ops.deleteStream(ctx, r2)
          act('stream-delete', { streamId: r2, grantsRevoked: out.grantsRevoked })
          return sendJson(res, 200, out)
        }
      }
      if (seg.length === 5 && r3 === 'art' && req.method === 'POST') {
        const data = await readBody(req, ART_BODY_LIMIT)
        const ext = CONTENT_EXT[(req.headers['content-type'] || '').split(';')[0].trim()] || '.bin'
        const out = await ops.uploadArt(ctx, r2, r4, data, ext)
        act('stream-art', { streamId: r2, kind: r4 })
        return sendJson(res, 200, out)
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
        close: () => { loginVerifier.close(); return new Promise((r) => server.close(r)) }
      })
    })
  })
}

// Process/network/storage snapshot + the in-memory activity ring. Everything is
// best-effort: no swarm/ring in ctx (tests, exotic setups) degrades to zeros, and
// the activity feed is empty again after every panel restart.
async function observability (ctx) {
  const mem = process.memoryUsage()
  let diskFree = null
  try { const s = fs.statfsSync(ctx.dataDir); diskFree = s.bavail * s.bsize } catch {}
  return {
    uptimeSec: Math.floor(process.uptime()),
    mem: { rss: mem.rss, heapUsed: mem.heapUsed },
    swarm: {
      connections: ctx.swarm ? ctx.swarm.connections.size : 0,
      peers: ctx.swarm ? ctx.swarm.peers.size : 0
    },
    data: { bytes: await dirSize(ctx.dataDir), diskFree },
    activity: ctx.activity ? ctx.activity.list() : []
  }
}

// Recursive on-disk size of DATA_DIR (store + assets + keys). The dir is a handful
// of large append-only files, so the walk is cheap even under dashboard polling.
async function dirSize (dir) {
  let total = 0
  let entries = []
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return total }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(p)
    else if (e.isFile()) { try { total += (await fs.promises.stat(p)).size } catch {} }
  }
  return total
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
