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
import os from 'os'
import path from 'path'
import { createHmac, timingSafeEqual } from 'crypto'
import { fileURLToPath } from 'url'
import { signToken, tokenValid } from '@aliran/core'
import { ControlError } from './errors.js'
import { readJsonFile, writeJsonFile } from './store.js'
import {
  makeThrottle, controlKeys, makePrincipalVerifier, principalTokenLive, loadPrincipals,
  addPrincipal, removePrincipal, listPrincipals, getPrincipal, principalSummary,
  setPrincipalPassword, setPrincipalStatus, setPrincipalLimits
} from './control-auth.js'
import { can, requireCap, requireManage, canManage, accountScope, inAccountScope, effectiveMaxDevices, ROLES } from './roles.js'

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
  const trustProxyHeader = (opts.trustProxyHeader || '').trim().toLowerCase()
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
    // White-label endpoints — public like the static files: the brand name and
    // the operator's theme-token overrides (layered AFTER style.css's shared
    // block, so the byte-identity the theme test enforces is untouched).
    if (seg.length === 1 && req.method === 'GET' && seg[0] === 'branding.json') {
      return sendJson(res, 200, brandingInfo(ctx))
    }
    if (seg.length === 1 && req.method === 'GET' && seg[0] === 'branding.css') {
      return sendBrandingCss(ctx, res)
    }
    if (seg.length === 2 && seg[0] === 'branding' && req.method === 'GET' && (seg[1] === 'logo' || seg[1] === 'favicon')) {
      return sendBrandingImage(ctx, res, seg[1])
    }
    if (seg[0] !== 'api') {
      if (req.method !== 'GET') return sendJson(res, 404, { error: 'not found (API lives under /api)' })
      return serveStatic(res, url.pathname)
    }
    const [, r1, r2, r3] = seg

    if (r1 === 'login' && req.method === 'POST' && seg.length === 2) {
      const body = await readJson(req)
      const ip = clientIp(req, trustProxyHeader)
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

    // Machine-to-machine: HMAC-authenticated credit top-ups (payment webhooks).
    // Sits BEFORE the Bearer gate — the signature is its own authentication.
    if (r1 === 'webhooks' && r2 === 'credits' && seg.length === 3 && req.method === 'POST') {
      return handleTopupWebhook(ctx, req, res)
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
          // The device policy is admin-set + inherited — non-admin creators
          // cannot seed an explicit value; their children simply inherit.
          if (b.maxDevicesLimit !== undefined) requireCap(me, 'principal:limits:devices')
          // A super can never hand a child more trial room than it has itself.
          if (me.role === 'super') {
            if (b.trialDailyCap !== undefined && b.trialDailyCap > me.trialDailyCap) throw new ControlError('forbidden', 'child trialDailyCap may not exceed your own')
          }
          const created = await ctx.mutex(() => addPrincipal(ctx, {
            username: b.username,
            password: b.password,
            role: b.role,
            parent: me.name,
            maxDevicesLimit: b.maxDevicesLimit,
            trialDailyCap: b.trialDailyCap,
            createdBy: me.name,
            note: b.note
          }))
          return sendJson(res, 201, decoratePrincipal(ctx, created))
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
        // Supers tune trial caps only; the device policy is admin-set.
        if (b.maxDevicesLimit !== undefined) requireCap(me, 'principal:limits:devices')
        if (me.role === 'super') {
          if (b.trialDailyCap !== undefined && b.trialDailyCap > me.trialDailyCap) throw new ControlError('forbidden', 'child trialDailyCap may not exceed your own')
        }
        return sendJson(res, 200, decoratePrincipal(ctx, setPrincipalLimits(ctx, r2, b)))
      }
    }

    if (r1 === 'panel' && seg.length === 3 && r2 === 'status' && req.method === 'GET' && ctx.panel) {
      requireCap(me, 'panel:status')
      return sendJson(res, 200, await ctx.panel.status())
    }

    // Operator diagnostics: host + service process + a LIVE panel-link probe (the
    // one place a panel round-trip is timed). Admin tiers only — host paths and
    // machine stats are operator information.
    if (r1 === 'system' && seg.length === 2 && req.method === 'GET') {
      requireCap(me, 'system:view')
      return sendJson(res, 200, await systemView(ctx))
    }

    // Catalog passthrough for the grants picker — any role, 60 s server cache so a
    // busy dashboard never hammers the panel.
    if (r1 === 'streams' && seg.length === 2 && req.method === 'GET' && ctx.panel) {
      if (!streamsCache.data || Date.now() - streamsCache.at > 60000) {
        streamsCache.data = await ctx.panel.streams()
        streamsCache.at = Date.now()
      }
      return sendJson(res, 200, streamsCache.data)
    }

    if (r1 === 'accounts' && ctx.accounts) {
      requireCap(me, 'accounts:manage')
      if (seg.length === 2) {
        if (req.method === 'GET') {
          const q = url.searchParams
          const scope = accountScope(loadPrincipals(ctx.dataDir), me)
          return sendJson(res, 200, ctx.accounts.list({
            q: q.get('q') || undefined,
            owner: q.get('owner') || undefined,
            filter: q.get('filter') || undefined,
            sort: q.get('sort') || undefined,
            dir: q.get('dir') || undefined,
            offset: q.get('offset') ? parseInt(q.get('offset'), 10) : undefined,
            limit: q.get('limit') ? parseInt(q.get('limit'), 10) : undefined
          }, scope))
        }
        if (req.method === 'POST') {
          const b = await readJson(req)
          return sendJson(res, 201, await ctx.mutex(() => ctx.accounts.activate(me, b)))
        }
      }
      if (seg.length >= 3) {
        const acct = r2
        requireAccountScope(ctx, me, acct)
        if (seg.length === 3) {
          if (req.method === 'GET') {
            const out = ctx.accounts.get(acct)
            try {
              const live = await ctx.panel.req('GET', `/api/users/${encodeURIComponent(acct)}`)
              out.live = { status: live.status, grants: live.grants, maxDevices: live.maxDevices, devices: live.devices }
            } catch { out.live = null }
            return sendJson(res, 200, out)
          }
          if (req.method === 'DELETE') return sendJson(res, 200, await ctx.mutex(() => ctx.accounts.remove(me, acct)))
        }
        if (seg.length === 4) {
          if (r3 === 'renew' && req.method === 'POST') {
            const b = await readJson(req)
            return sendJson(res, 200, await ctx.mutex(() => ctx.accounts.renew(me, acct, b.months)))
          }
          if (r3 === 'status' && req.method === 'POST') {
            const b = await readJson(req)
            return sendJson(res, 200, await ctx.mutex(() => ctx.accounts.setStatus(me, acct, b.status)))
          }
          if (r3 === 'password' && req.method === 'POST') {
            const b = await readJson(req)
            return sendJson(res, 200, await ctx.mutex(() => ctx.accounts.setPassword(me, acct, b.password)))
          }
          if (r3 === 'max-devices' && req.method === 'POST') {
            const b = await readJson(req)
            return sendJson(res, 200, await ctx.mutex(() => ctx.accounts.setMaxDevices(me, acct, b.maxDevices)))
          }
          if (r3 === 'grants' && req.method === 'POST') {
            const b = await readJson(req)
            return sendJson(res, 200, await ctx.mutex(() => ctx.accounts.addGrant(me, acct, b.streamId)))
          }
          if (r3 === 'devices' && req.method === 'GET') return sendJson(res, 200, await ctx.accounts.devices(me, acct))
          if (r3 === 'logout-all' && req.method === 'POST') return sendJson(res, 200, await ctx.accounts.logoutAll(me, acct))
        }
        if (seg.length === 5) {
          if (r3 === 'grants' && req.method === 'DELETE') return sendJson(res, 200, await ctx.mutex(() => ctx.accounts.removeGrant(me, acct, seg[4])))
          if (r3 === 'devices' && req.method === 'DELETE') return sendJson(res, 200, await ctx.accounts.revokeDevice(me, acct, seg[4]))
        }
      }
    }

    if (r1 === 'trials' && seg.length === 2 && req.method === 'POST' && ctx.accounts) {
      requireCap(me, 'trials:create')
      const b = await readJson(req)
      return sendJson(res, 201, await ctx.mutex(() => ctx.accounts.trial(me, b)))
    }

    if (r1 === 'ops' && seg.length === 3 && ctx.sweeps) {
      if (r2 === 'sweep' && req.method === 'POST') {
        requireCap(me, 'ops:sweep')
        return sendJson(res, 200, await ctx.sweeps.sweepNow())
      }
      if (r2 === 'reconcile' && req.method === 'POST') {
        requireCap(me, 'ops:reconcile')
        return sendJson(res, 200, await ctx.sweeps.reconcileNow())
      }
      if (r2 === 'reconcile' && req.method === 'GET') {
        requireCap(me, 'ops:reconcile')
        return sendJson(res, 200, ctx.sweeps.lastReport() || { never: true })
      }
    }

    if (r1 === 'credits' && seg.length === 3 && req.method === 'POST' && ctx.ledger) {
      const b = await readJson(req)
      if (r2 === 'mint') return sendJson(res, 200, await ctx.mutex(() => mint(ctx, me, b)))
      if (r2 === 'transfer') return sendJson(res, 200, await ctx.mutex(() => transfer(ctx, me, b)))
      if (r2 === 'reclaim') return sendJson(res, 200, await ctx.mutex(() => reclaim(ctx, me, b)))
      if (r2 === 'adjust') return sendJson(res, 200, await ctx.mutex(() => adjust(ctx, me, b)))
    }

    if (r1 === 'ledger' && seg.length === 2 && req.method === 'GET' && ctx.ledger) {
      const q = url.searchParams
      const scope = can(me, 'ledger:view-all') ? '*' : accountScope(loadPrincipals(ctx.dataDir), me)
      const before = q.get('before') ? parseInt(q.get('before'), 10) : undefined
      const limit = q.get('limit') ? parseInt(q.get('limit'), 10) : undefined
      return sendJson(res, 200, ctx.ledger.list({
        principal: q.get('principal') || undefined,
        account: q.get('account') || undefined,
        type: q.get('type') || undefined,
        before: Number.isInteger(before) ? before : undefined,
        limit: Number.isInteger(limit) ? limit : undefined
      }, scope))
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

// --- white-label branding ---

// Only the 11 shared theme tokens, only 6-digit hex — the file is operator-
// controlled, but validating keeps a typo from injecting arbitrary CSS.
const THEME_TOKENS = ['bg', 'panel', 'panel-2', 'border', 'text', 'muted', 'accent', 'accent-dim', 'danger', 'ok', 'warn']

function brandingTokens (ctx) {
  const file = ctx.config.branding && ctx.config.branding.themeFile
  if (!file) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const out = {}
    for (const k of THEME_TOKENS) {
      if (typeof raw[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw[k])) out[k] = raw[k]
    }
    return out
  } catch { return {} } // unreadable/invalid file = no overrides, never a 500
}

// Image files: extension whitelist doubles as the content-type map — anything
// else is refused rather than sniffed.
const BRAND_IMAGE_TYPES = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
}

function brandImageFile (ctx, kind) {
  const b = ctx.config.branding || {}
  const file = kind === 'logo' ? b.logoFile : b.faviconFile
  if (!file || !BRAND_IMAGE_TYPES[path.extname(file).toLowerCase()]) return null
  return fs.existsSync(file) ? file : null
}

function brandingInfo (ctx) {
  const tokens = brandingTokens(ctx)
  return {
    name: (ctx.config.branding && ctx.config.branding.name) || 'Aliran reseller',
    accent: tokens.accent || '#22D3EE',
    logo: !!brandImageFile(ctx, 'logo'),
    favicon: !!brandImageFile(ctx, 'favicon')
  }
}

function sendBrandingImage (ctx, res, kind) {
  const file = brandImageFile(ctx, kind)
  if (!file) return sendJson(res, 404, { error: 'not found' })
  let data
  try { data = fs.readFileSync(file) } catch { return sendJson(res, 404, { error: 'not found' }) }
  if (res.destroyed || res.writableEnded || res.headersSent) return
  try {
    res.writeHead(200, {
      'content-type': BRAND_IMAGE_TYPES[path.extname(file).toLowerCase()],
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff'
    })
    res.end(data)
  } catch {}
}

function sendBrandingCss (ctx, res) {
  const tokens = brandingTokens(ctx)
  const body = Object.keys(tokens).length
    ? ':root {\n' + Object.entries(tokens).map(([k, v]) => `  --${k}: ${v};`).join('\n') + '\n}\n'
    : '/* no white-label theme configured */\n'
  if (res.destroyed || res.writableEnded || res.headersSent) return
  try {
    res.writeHead(200, {
      'content-type': 'text/css; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff'
    })
    res.end(body)
  } catch {}
}

// --- credit top-up webhook (payment-provider integration) ---
//
// POST /api/webhooks/credits — the automation path for selling credits: the
// operator's payment success handler signs and posts { id, to, amount, note? }
// and the credits land as a normal MINT ledger line (actor "webhook", the note
// carries the event id — the audit trail stays complete).
//
// Security model (the Stripe webhook shape):
//   - HMAC-SHA256 over `${timestamp}.${rawBody}` with WEBHOOK_SECRET, sent as
//     x-topup-signature (hex) + x-topup-timestamp (unix seconds); constant-time
//     compare; ±5 min tolerance kills replays outside the window.
//   - IDEMPOTENT by event id: a retried delivery (providers retry on timeouts)
//     answers 200 {duplicate:true} and mints nothing. Seen ids persist in
//     state/webhook-events.json, pruned oldest-first past 5000 entries.
//   - No secret configured → 404, indistinguishable from an absent route.
const WEBHOOK_TOLERANCE_SEC = 300
const WEBHOOK_EVENTS_MAX = 5000

async function handleTopupWebhook (ctx, req, res) {
  const secret = ctx.config.webhook && ctx.config.webhook.secret
  if (!secret || !ctx.ledger) return sendJson(res, 404, { error: 'not found' })
  const raw = await readRaw(req)
  const ts = String(req.headers['x-topup-timestamp'] || '')
  const sig = String(req.headers['x-topup-signature'] || '')
  if (!/^\d+$/.test(ts) || !sig) return sendJson(res, 401, { error: 'missing x-topup-timestamp / x-topup-signature' })
  if (Math.abs(Date.now() / 1000 - Number(ts)) > WEBHOOK_TOLERANCE_SEC) {
    return sendJson(res, 401, { error: `timestamp outside the ${WEBHOOK_TOLERANCE_SEC}s tolerance` })
  }
  const expect = createHmac('sha256', secret).update(ts + '.').update(raw).digest()
  let given = Buffer.alloc(0)
  try { given = Buffer.from(sig, 'hex') } catch {}
  if (given.length !== expect.length || !timingSafeEqual(expect, given)) {
    return sendJson(res, 401, { error: 'bad signature' })
  }

  let b
  try { b = JSON.parse(raw.toString('utf8')) } catch { return sendJson(res, 400, { error: 'invalid JSON body' }) }
  if (typeof b.id !== 'string' || !b.id || b.id.length > 128) return sendJson(res, 400, { error: 'id (the unique event id) is required' })
  checkAmount(b.amount)
  if (!loadPrincipals(ctx.dataDir)[b.to]) return sendJson(res, 404, { error: `no such principal: ${b.to}` })

  const out = await ctx.mutex(() => {
    const file = path.join(ctx.dataDir, 'state', 'webhook-events.json')
    const seen = readJsonFile(file, {})
    if (seen[b.id]) return { duplicate: true, to: b.to, amount: b.amount, balance: ctx.ledger.balance(b.to) }
    const line = ctx.ledger.append({
      type: 'MINT',
      actor: 'webhook',
      entries: [{ principal: b.to, delta: b.amount }],
      note: `top-up ${b.id}` + (typeof b.note === 'string' && b.note ? ` — ${b.note.slice(0, 120)}` : '')
    })
    seen[b.id] = Date.now()
    const ids = Object.keys(seen)
    if (ids.length > WEBHOOK_EVENTS_MAX) {
      ids.sort((x, y) => seen[x] - seen[y])
      for (const old of ids.slice(0, ids.length - WEBHOOK_EVENTS_MAX)) delete seen[old]
    }
    writeJsonFile(file, seen)
    return { seq: line.seq, to: b.to, amount: b.amount, balance: ctx.ledger.balance(b.to) }
  })
  return sendJson(res, 200, out)
}

// --- views + business ops that span stores ---

// Login-throttle identity. With TRUST_PROXY_HEADER set (Cloudflare Tunnel:
// cf-connecting-ip; Caddy/nginx: x-forwarded-for) the key is the header's
// RIGHTMOST list entry — the one appended by the nearest trusted hop; earlier
// entries are client-supplied and spoofable. Unset (the default), the socket
// address is the identity, exactly as before.
function clientIp (req, trustProxyHeader) {
  if (trustProxyHeader) {
    const v = req.headers[trustProxyHeader]
    if (typeof v === 'string' && v.trim()) {
      const parts = v.split(',')
      const last = parts[parts.length - 1].trim()
      if (last) return last
    }
  }
  return req.socket.remoteAddress || 'unknown'
}

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
    ...devicePolicyView(ctx, principalSummary(me.name, me)),
    balance: balanceOf(ctx, me.name),
    trialsUsedToday: ctx.ledger ? ctx.ledger.trialsToday(me.name) : 0
  }
}

// Every principal view reports the EFFECTIVE device policy (resolved up the
// parent chain), whether it is inherited, and what clearing the explicit value
// WOULD resolve to (the Limits dialog's "inherit (N)" placeholder) — the raw
// record keeps null for "inherit", an implementation detail callers never see.
function devicePolicyView (ctx, summary) {
  const principals = loadPrincipals(ctx.dataDir)
  const fallback = ctx.config.maxDevicesLimitDefault
  return {
    ...summary,
    maxDevicesLimit: effectiveMaxDevices(principals, summary.name, fallback),
    maxDevicesLimitInherited: !Number.isInteger(summary.maxDevicesLimit),
    maxDevicesLimitIfInherited: summary.parent ? effectiveMaxDevices(principals, summary.parent, fallback) : fallback
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

// GET /api/system — never throws for a down panel: the probe failure is data
// (panel.error), so the dashboard can render host/service rows during an outage.
async function systemView (ctx) {
  const mem = process.memoryUsage()
  let disk = null
  try {
    const s = await fs.promises.statfs(ctx.dataDir)
    disk = { totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail }
  } catch {} // statfs can be unavailable on exotic filesystems — the UI shows "—"
  const cpus = os.cpus()
  const out = {
    now: Date.now(),
    service: {
      node: process.version,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      dataDir: path.resolve(ctx.dataDir),
      sweeps: ctx.sweeps ? ctx.sweeps.healthInfo() : null,
      ledger: ctx.ledger ? ctx.ledger.healthInfo() : null,
      webhook: { enabled: !!(ctx.config.webhook && ctx.config.webhook.secret) }
    },
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuModel: cpus.length ? cpus[0].model : 'unknown',
      cpuCount: cpus.length,
      loadavg: os.loadavg(), // all zeros on Windows — the UI shows "—"
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
      uptimeSec: Math.round(os.uptime()),
      disk
    },
    panel: null
  }
  if (ctx.panel) {
    const p = { url: ctx.config.panel.url, latencyMs: null, stats: null, error: null }
    const t0 = Date.now()
    try {
      p.stats = await ctx.panel.status() // { panelKey, users, streams, live, admins }
      p.latencyMs = Date.now() - t0
    } catch (err) {
      p.error = String((err && err.message) || err)
    }
    Object.assign(p, ctx.panel.healthInfo()) // reachable/lastOkAt/lastError, post-probe
    out.panel = p
  }
  return out
}

function decoratePrincipal (ctx, summary) {
  return {
    ...devicePolicyView(ctx, summary),
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

// One per-process catalog cache is enough — a single service instance.
const streamsCache = { at: 0, data: null }

// Account ops need the record's OWNER inside the caller's scope. 404 for a name
// that doesn't exist, 403 for one that exists outside the scope.
function requireAccountScope (ctx, me, acct) {
  const rec = ctx.accounts.records()[acct]
  if (!rec || rec.status === 'deleted') throw new ControlError('not-found', `no such account: ${acct}`)
  const scope = accountScope(loadPrincipals(ctx.dataDir), me)
  if (!inAccountScope(scope, rec.owner)) throw new ControlError('forbidden', `account "${acct}" is outside your scope`)
}

// --- credits (all called under the service mutex: check-then-append can't race) ---

const AMOUNT_MAX = 1000000

function checkAmount (n) {
  if (!Number.isInteger(n) || n <= 0 || n > AMOUNT_MAX) throw new ControlError('bad-request', `amount must be an integer 1-${AMOUNT_MAX}`)
}

function mustExist (ctx, name) {
  const p = loadPrincipals(ctx.dataDir)[name]
  if (!p) throw new ControlError('not-found', `no such principal: ${name}`)
  return p
}

// Credits come from nothing exactly here (and the CLI's offline mint).
function mint (ctx, me, { to, amount, note }) {
  requireCap(me, 'credits:mint')
  checkAmount(amount)
  const target = to || me.name
  mustExist(ctx, target)
  const line = ctx.ledger.append({ type: 'MINT', actor: me.name, entries: [{ principal: target, delta: amount }], note: noteStr(note) })
  return { seq: line.seq, to: target, amount, balance: ctx.ledger.balance(target) }
}

// Downward allocation: strict zero-sum pair, and the payer's balance must cover it
// (admins included — an admin wanting free credits mints first; the ledger stays
// honest about where every credit came from).
function transfer (ctx, me, { to, amount, note }) {
  requireCap(me, 'credits:transfer')
  checkAmount(amount)
  const principals = loadPrincipals(ctx.dataDir)
  const target = principals[to]
  if (!target) throw new ControlError('not-found', `no such principal: ${to}`)
  if (to === me.name) throw new ControlError('bad-request', 'cannot transfer to yourself')
  if (me.role === 'super' && target.parent !== me.name) throw new ControlError('forbidden', 'a super reseller funds only its own resellers')
  if (ctx.ledger.balance(me.name) < amount) throw new ControlError('insufficient-credits', `balance ${ctx.ledger.balance(me.name)} < ${amount}`)
  const line = ctx.ledger.append({ type: 'TRANSFER', actor: me.name, entries: [{ principal: me.name, delta: -amount }, { principal: to, delta: amount }], note: noteStr(note) })
  return { seq: line.seq, to, amount, balance: ctx.ledger.balance(me.name) }
}

// Pull-back, capped at whatever the child still holds.
function reclaim (ctx, me, { from, amount }) {
  requireCap(me, 'credits:reclaim')
  checkAmount(amount)
  const principals = loadPrincipals(ctx.dataDir)
  const source = principals[from]
  if (!source) throw new ControlError('not-found', `no such principal: ${from}`)
  if (from === me.name) throw new ControlError('bad-request', 'cannot reclaim from yourself')
  if (me.role === 'super' && source.parent !== me.name) throw new ControlError('forbidden', 'a super reseller reclaims only from its own resellers')
  const held = ctx.ledger.balance(from)
  const take = Math.min(amount, held)
  if (take <= 0) throw new ControlError('insufficient-credits', `"${from}" holds no credits`)
  const line = ctx.ledger.append({ type: 'RECLAIM', actor: me.name, entries: [{ principal: from, delta: -take }, { principal: me.name, delta: take }], note: '' })
  return { seq: line.seq, from, amount: take, balance: ctx.ledger.balance(me.name) }
}

function adjust (ctx, me, { principal, delta, note }) {
  requireCap(me, 'credits:adjust')
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > AMOUNT_MAX) throw new ControlError('bad-request', `delta must be a non-zero integer within ±${AMOUNT_MAX}`)
  mustExist(ctx, principal)
  const line = ctx.ledger.append({ type: 'ADJUST', actor: me.name, entries: [{ principal, delta }], note: noteStr(note) })
  return { seq: line.seq, principal, delta, balance: ctx.ledger.balance(principal) }
}

function noteStr (note) {
  return typeof note === 'string' ? note.slice(0, 200) : ''
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

// Raw bytes, unparsed — the webhook signature covers the EXACT body as sent
// (parsing-then-restringifying would break byte-for-byte HMAC verification).
function readRaw (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > JSON_BODY_LIMIT) { req.destroy(); return reject(httpError(413, 'payload too large')) }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
