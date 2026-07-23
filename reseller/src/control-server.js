// Aliran reseller control API — authed HTTP+JSON over the principal/ledger/account
// stores. Same skeleton as library/src/control-server.js (separate deployables each
// ship their own copy; if you fix a bug in the skeleton, fix it in all of them),
// plus two reseller-specific error codes: `forbidden` → 403 and
// `insufficient-credits` → 402, and PanelError passthrough (the downstream panel's
// own status, 502 when unreachable).
//
// Auth: POST /api/login against DATA_DIR/secrets/principals.json (reseller-cli
// add-admin seeds the root) → session token signed with the reseller-local control
// keypair. Every other /api route requires `Authorization: Bearer <token>`; the
// LIVE principal record (never the token payload) drives every role/scope gate.
// Login is rate-limited AND single-flight (worker-thread Argon2id, 503 on overlap).
// Binding: 127.0.0.1 by default; put TLS in front if you expose it.
//
// GET /healthz is UNAUTHENTICATED liveness (cheap, synchronous). Non-/api GETs
// serve the control UI from reseller/control-ui/.

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { signToken, tokenValid } from '@aliran/core'
import { ControlError } from './errors.js'
import {
  makeThrottle, controlKeys, makePrincipalVerifier, principalTokenLive, loadPrincipals,
  addPrincipal, removePrincipal, listPrincipals, getPrincipal, principalSummary,
  setPrincipalPassword, setPrincipalStatus, setPrincipalLimits
} from './control-auth.js'
import { requireCap, requireManage, canManage, accountScope, inAccountScope, ROLES } from './roles.js'

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'control-ui')
const JSON_BODY_LIMIT = 1024 * 1024 // 1 MiB

const STATUS_BY_CODE = {
  'not-found': 404,
  exists: 409,
  forbidden: 403,
  'insufficient-credits': 402
}

// ctx = { config, dataDir, mutex, ledger?, accounts?, panel?, sweeps? } — the
// optional pieces arrive per stage; routes that need a missing piece 404.
// opts = { host, port, sessionTtlMs, lockout, loginVerifyTimeoutMs }.
export function startControlServer (ctx, opts = {}) {
  const host = opts.host || '127.0.0.1'
  const sessionTtlMs = opts.sessionTtlMs || 12 * 3600000
  const lockout = opts.lockout || { threshold: 10, seconds: 900 }
  const throttle = makeThrottle(lockout.threshold, lockout.seconds)
  const loginVerifier = makePrincipalVerifier(ctx, { timeoutMs: opts.loginVerifyTimeoutMs })
  const keys = controlKeys(ctx.dataDir)

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof ControlError) {
        return sendJson(res, STATUS_BY_CODE[err.code] || 400, { error: err.message })
      }
      if (err && err.httpStatus) return sendJson(res, err.httpStatus, { error: err.message })
      console.error('control-api error:', err)
      sendJson(res, 500, { error: 'internal error' })
    })
  })

  async function handle (req, res) {
    const url = new URL(req.url, 'http://x')
    const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

    // Liveness. Unauthenticated and handled FIRST — cheap and synchronous.
    if (seg[0] === 'healthz' && seg.length === 1) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      return sendJson(res, 200, health(ctx))
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
      const who = await loginVerifier.verify(body.username, body.password)
      if (!who) return sendJson(res, 401, { error: 'invalid credentials' })
      const now = Date.now()
      const payload = { role: 'principal', principalId: who.name, issuedAt: now, expiresAt: now + sessionTtlMs, tokenVersion: who.tokenVersion }
      const record = loadPrincipals(ctx.dataDir)[who.name]
      return sendJson(res, 200, { token: signToken(keys.secretKey, payload), expiresAt: payload.expiresAt, role: record ? record.role : null })
    }

    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    const payload = token && tokenValid(keys.publicKey, token)
    // The LIVE record — role/status/tokenVersion re-checked on every request, so a
    // suspension or role change bites immediately, not at token expiry.
    const me = payload && principalTokenLive(ctx, payload)
    if (!me) return sendJson(res, 401, { error: 'unauthorized' })

    if (r1 === 'me' && seg.length === 2 && req.method === 'GET') {
      return sendJson(res, 200, meView(ctx, me))
    }
    if (r1 === 'me' && seg.length === 3 && r2 === 'password' && req.method === 'POST') {
      const b = await readJson(req)
      return sendJson(res, 200, setPrincipalPassword(ctx, me.name, b.password))
    }

    if (r1 === 'status' && seg.length === 2 && req.method === 'GET') {
      return sendJson(res, 200, statusView(ctx, me))
    }

    if (r1 === 'principals') {
      if (seg.length === 2) {
        if (req.method === 'GET') {
          requireCap(me, 'principal:manage')
          const principals = loadPrincipals(ctx.dataDir)
          const all = listPrincipals(ctx)
          const visible = me.role === 'super'
            ? all.filter((p) => p.name !== me.name && canManage(principals, me, p.name))
            : all
          return sendJson(res, 200, visible.map((p) => decoratePrincipal(ctx, p)))
        }
        if (req.method === 'POST') {
          const b = await readJson(req)
          if (!ROLES.includes(b.role)) throw new ControlError('bad-request', `invalid role (one of: ${ROLES.join(', ')})`)
          requireCap(me, 'principal:create:' + b.role)
          // A super can never hand a child more room than it has itself.
          if (me.role === 'super') {
            if (b.maxDevicesLimit !== undefined && b.maxDevicesLimit > me.maxDevicesLimit) throw new ControlError('forbidden', 'child maxDevicesLimit may not exceed your own')
            if (b.trialDailyCap !== undefined && b.trialDailyCap > me.trialDailyCap) throw new ControlError('forbidden', 'child trialDailyCap may not exceed your own')
          }
          const created = await ctx.mutex(() => addPrincipal(ctx, {
            username: b.username,
            password: b.password,
            role: b.role,
            parent: me.name,
            prefix: b.prefix,
            maxDevicesLimit: b.maxDevicesLimit,
            trialDailyCap: b.trialDailyCap,
            createdBy: me.name,
            note: b.note
          }))
          return sendJson(res, 201, created)
        }
      }
      if (seg.length === 3) {
        if (req.method === 'GET') {
          const principals = loadPrincipals(ctx.dataDir)
          if (r2 !== me.name) requireManage(principals, me, r2)
          return sendJson(res, 200, decoratePrincipal(ctx, getPrincipal(ctx, r2)))
        }
        if (req.method === 'DELETE') {
          return sendJson(res, 200, await ctx.mutex(() => deletePrincipal(ctx, me, r2)))
        }
      }
      if (seg.length === 4 && r3 === 'password' && req.method === 'POST') {
        requireManage(loadPrincipals(ctx.dataDir), me, r2)
        const b = await readJson(req)
        return sendJson(res, 200, setPrincipalPassword(ctx, r2, b.password))
      }
      if (seg.length === 4 && r3 === 'status' && req.method === 'POST') {
        requireManage(loadPrincipals(ctx.dataDir), me, r2)
        const b = await readJson(req)
        return sendJson(res, 200, await ctx.mutex(() => setPrincipalStatusDeep(ctx, me, r2, b)))
      }
      if (seg.length === 4 && r3 === 'limits' && req.method === 'POST') {
        requireCap(me, 'principal:limits')
        requireManage(loadPrincipals(ctx.dataDir), me, r2)
        const b = await readJson(req)
        if (me.role === 'super') {
          if (b.maxDevicesLimit !== undefined && b.maxDevicesLimit > me.maxDevicesLimit) throw new ControlError('forbidden', 'child maxDevicesLimit may not exceed your own')
          if (b.trialDailyCap !== undefined && b.trialDailyCap > me.trialDailyCap) throw new ControlError('forbidden', 'child trialDailyCap may not exceed your own')
        }
        return sendJson(res, 200, setPrincipalLimits(ctx, r2, b))
      }
    }

    sendJson(res, 404, { error: 'not found' })
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 3330, host, () => {
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

// --- views + business ops that span stores ---

function health (ctx) {
  const principals = loadPrincipals(ctx.dataDir)
  return {
    ok: true,
    principals: Object.keys(principals).length,
    accounts: ctx.accounts ? ctx.accounts.count() : 0,
    panel: ctx.panel ? ctx.panel.healthInfo() : { reachable: null, lastOkAt: null },
    sweep: ctx.sweeps ? ctx.sweeps.healthInfo() : { lastRunAt: null },
    ledger: ctx.ledger ? ctx.ledger.healthInfo() : { seq: 0, invariantOk: true }
  }
}

function balanceOf (ctx, name) {
  return ctx.ledger ? ctx.ledger.balance(name) : 0
}

function meView (ctx, me) {
  return {
    ...principalSummary(me.name, me),
    balance: balanceOf(ctx, me.name),
    trialsUsedToday: ctx.ledger ? ctx.ledger.trialsToday(me.name) : 0
  }
}

function statusView (ctx, me) {
  const base = { name: me.name, role: me.role, balance: balanceOf(ctx, me.name) }
  if (ctx.accounts) Object.assign(base, ctx.accounts.kpis(accountScope(loadPrincipals(ctx.dataDir), me)))
  if (me.role === 'admin' || me.role === 'co-admin') {
    const principals = loadPrincipals(ctx.dataDir)
    base.principals = Object.keys(principals).length
    if (ctx.ledger) base.outstandingCredits = ctx.ledger.totalOutstanding()
    if (ctx.panel) base.panel = ctx.panel.healthInfo()
    if (ctx.sweeps) base.reconcile = ctx.sweeps.lastReconcileSummary()
  }
  return base
}

function decoratePrincipal (ctx, summary) {
  return {
    ...summary,
    balance: balanceOf(ctx, summary.name),
    accounts: ctx.accounts ? ctx.accounts.countOwnedBy(summary.name) : 0
  }
}

// Delete = locked decision 5: refused while the principal still has child
// principals or non-deleted accounts; on the final delete any remaining balance is
// reclaimed to the deleting actor (ledger arrives in stage 2 — no balance, no line).
function deletePrincipal (ctx, me, name) {
  const principals = loadPrincipals(ctx.dataDir)
  requireManage(principals, me, name)
  const children = Object.entries(principals).filter(([, p]) => p.parent === name)
  if (children.length > 0) {
    throw new ControlError('bad-request', `"${name}" still has ${children.length} child principal(s) — delete or re-parent them first`)
  }
  if (ctx.accounts && ctx.accounts.countOwnedBy(name) > 0) {
    throw new ControlError('bad-request', `"${name}" still owns ${ctx.accounts.countOwnedBy(name)} account(s) — delete them first`)
  }
  if (ctx.ledger) {
    const bal = ctx.ledger.balance(name)
    if (bal > 0) ctx.ledger.append({ type: 'RECLAIM', actor: me.name, entries: [{ principal: name, delta: -bal }, { principal: me.name, delta: bal }], note: `reclaim on delete of ${name}` })
  }
  return removePrincipal(ctx, name)
}

// Suspend/reactivate with the optional with-accounts mode (bulk panel disable) —
// the account half arrives with stage 3; until then mode is accepted and ignored
// beyond the principal flip when the machinery is absent.
async function setPrincipalStatusDeep (ctx, me, name, body) {
  const out = setPrincipalStatus(ctx, name, body.status)
  if (body.mode === 'with-accounts' && ctx.accounts) {
    await ctx.accounts.bulkSetOwnerStatus(name, body.status === 'suspended' ? 'disabled' : 'active')
  }
  return out
}

// --- helpers (same never-throw rationale as the panel/broadcaster/library copies) ---

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
