// End-to-end test for the reseller panel (reseller/) against a REAL panel admin
// API booted in-process — loopback HTTP only, no DHT, deterministic: the panel
// store + admin server come up exactly like tools/e2e-admin-api-test.mjs, the
// reseller service is pointed at them, and the whole hierarchy → credits →
// activation → lifecycle → outage story runs over real HTTP. Exits 0 on PASS.
import assert from 'assert'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { createHmac } from 'crypto'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeRing } from '../panel/src/activity.js'
import * as pops from '../panel/src/ops.js'
import { startAdminServer } from '../panel/src/admin-server.js'
import { startReseller } from '../reseller/src/index.js'
import { addPrincipal } from '../reseller/src/control-auth.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SVC_PASSWORD = 'panel-svc-secret-1'
const fastArgon = { memKiB: 8192, time: 1 }

const dirs = {
  panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-panel-')),
  reseller: fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-rsl-'))
}
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Panel: store + the service's dedicated admin + admin server =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db, assets } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const pctx = { config: { argon2: fastArgon, maxDevicesDefault: 2 }, keys, db, assets, dataDir: dirs.panel, activity: makeRing(200) }
  pops.addAdmin(pctx, 'reseller-svc', SVC_PASSWORD)
  await pops.addStream(pctx, 'movie-night', { title: 'Movie Night' })
  await pops.addStream(pctx, 'sports-plus', { title: 'Sports Plus' })

  // High panel lockout so the test's many service logins never trip it; port 0
  // once, then the SAME port on re-listen (the outage test needs that).
  const panelOpts = { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 100, seconds: 60 } }
  let panelSrv = await startAdminServer(pctx, panelOpts)
  const panelPort = panelSrv.port
  cleanups.push(() => panelSrv.close())
  log('panel admin API on 127.0.0.1:' + panelPort)

  // ===== Reseller service pointed at it =====
  const seedCtx = { dataDir: dirs.reseller, config: { argon2: fastArgon, maxDevicesLimitDefault: 3, trialDailyCapDefault: 3 } }
  addPrincipal(seedCtx, { username: 'boss', password: 'boss-pass-123', role: 'admin', root: true, createdBy: 'cli' })

  const svc = await startReseller({
    dataDir: dirs.reseller,
    argon2: fastArgon,
    daysPerMonth: 31,
    trialHours: 24,
    reconcileRepair: true,
    noSweeps: true, // driven through the ops routes, not wall-clock timers
    control: { host: '127.0.0.1', port: 0 },
    lockout: { threshold: 4, seconds: 60 },
    panel: { url: `http://127.0.0.1:${panelPort}`, username: 'reseller-svc', password: SVC_PASSWORD, timeoutMs: 4000 }
  })
  cleanups.push(() => svc.close())
  const base = `http://127.0.0.1:${svc.control.port}`
  const api = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body != null ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body != null ? JSON.stringify(body) : undefined
    })
    let json = null
    try { json = await res.json() } catch {}
    return { status: res.status, body: json }
  }
  const login = async (u, p) => {
    const r = await api('POST', '/api/login', { username: u, password: p })
    assert.strictEqual(r.status, 200, `login ${u}: ${JSON.stringify(r.body)}`)
    return r.body.token
  }
  log('reseller control API on', base)

  // ===== A: auth + lockout =====
  let r = await api('GET', '/healthz')
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.ok, true)
  r = await api('GET', '/api/me')
  assert.strictEqual(r.status, 401, 'no token → 401')
  r = await api('POST', '/api/login', { username: 'boss', password: 'wrong-password' })
  assert.strictEqual(r.status, 401, 'bad creds → 401')
  for (let i = 0; i < 4; i++) await api('POST', '/api/login', { username: 'nobody', password: 'x'.repeat(12) })
  r = await api('POST', '/api/login', { username: 'nobody', password: 'x'.repeat(12) })
  assert.strictEqual(r.status, 429, 'lockout after threshold → 429')
  const boss = await login('boss', 'boss-pass-123')
  log('A: healthz unauthed; 401s; lockout 429; root login ✓')

  // ===== B: hierarchy + the co-admin guardrail =====
  r = await api('POST', '/api/principals', { username: 'dep', password: 'dep-pass-1234', role: 'co-admin' }, boss)
  assert.strictEqual(r.status, 201)
  const dep = await login('dep', 'dep-pass-1234')
  r = await api('POST', '/api/principals', { username: 'dep2', password: 'dep-pass-1234', role: 'co-admin' }, dep)
  assert.strictEqual(r.status, 403, 'co-admin creating co-admin → 403 (root-only)')
  r = await api('DELETE', '/api/principals/boss', null, dep)
  assert.strictEqual(r.status, 403, 'root undeletable')
  r = await api('POST', '/api/principals', { username: 'sup1', password: 'sup1-pass-123', role: 'super' }, dep)
  assert.strictEqual(r.status, 201)
  const sup1 = await login('sup1', 'sup1-pass-123')
  r = await api('POST', '/api/principals', { username: 'res1', password: 'res1-pass-123', role: 'reseller', trialDailyCap: 1 }, sup1)
  assert.strictEqual(r.status, 201)
  assert.strictEqual(r.body.parent, 'sup1')
  const res1 = await login('res1', 'res1-pass-123')
  log('B: root→co-admin→super→reseller chain; guardrails ✓')

  // ===== C: credits =====
  r = await api('POST', '/api/credits/mint', { to: 'sup1', amount: 10 }, dep)
  assert.strictEqual(r.status, 200, 'co-admin mints (full clone)')
  r = await api('POST', '/api/credits/transfer', { to: 'res1', amount: 6 }, sup1)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.balance, 4, 'super keeps 4')
  r = await api('POST', '/api/credits/mint', { to: 'res1', amount: 5 }, sup1)
  assert.strictEqual(r.status, 403, 'super cannot mint')
  r = await api('POST', '/api/credits/transfer', { to: 'sup1', amount: 1 }, res1)
  assert.strictEqual(r.status, 403, 'reseller cannot transfer')
  r = await api('GET', '/api/me', null, res1)
  assert.strictEqual(r.body.balance, 6)
  log('C: mint/transfer + role gates + balances ✓')

  // ===== D: activation — fail-closed both ways =====
  // Device policy: maxDevices is ADMIN-SET + inherited — a reseller cannot pass
  // it (rejected before any panel/ledger effect), and an account simply receives
  // the creator's effective policy value.
  r = await api('POST', '/api/accounts', { name: 'bob', password: 'bob-secret-99', months: 2, maxDevices: 2, grants: ['movie-night'] }, res1)
  assert.strictEqual(r.status, 403, 'reseller-supplied maxDevices → 403 (admin-set policy)')
  r = await api('POST', '/api/accounts', { name: 'bob', password: 'bob-secret-99', months: 2, grants: ['movie-night'] }, res1)
  assert.strictEqual(r.status, 201, 'activate: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.account, 'bob')
  const bobPanel = await pops.getUser(pctx, 'bob')
  assert.ok(bobPanel.grants.includes('movie-night'), 'panel user carries the extra grant')
  assert.strictEqual(bobPanel.maxDevices, 3, 'panel maxDevices = inherited policy (root fallback 3)')
  r = await api('GET', '/api/me', null, res1)
  assert.strictEqual(r.body.balance, 4, 'activation debited 2')

  // Over-balance: NOTHING happens anywhere.
  r = await api('POST', '/api/accounts', { name: 'greedy', password: 'greedy-pass-1', months: 100 }, res1)
  assert.strictEqual(r.status, 402, 'over-balance → 402')
  await assert.rejects(() => pops.getUser(pctx, 'greedy'), /no such user/, '402 left no panel user')
  r = await api('GET', '/api/me', null, res1)
  assert.strictEqual(r.body.balance, 4, '402 left the balance alone')

  // The policy chain is admin-owned and LIVE: supers cannot touch it, and an
  // admin change on sup1 instantly flows to res1 (no cascade writes).
  r = await api('POST', '/api/principals/res1/limits', { maxDevicesLimit: 5 }, sup1)
  assert.strictEqual(r.status, 403, 'super cannot set the device policy')
  r = await api('POST', '/api/principals/sup1/limits', { maxDevicesLimit: 2 }, boss)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.maxDevicesLimit, 2, 'explicit policy on sup1')
  r = await api('GET', '/api/me', null, res1)
  assert.strictEqual(r.body.maxDevicesLimit, 2, 'reseller inherits the new policy through sup1')
  assert.strictEqual(r.body.maxDevicesLimitInherited, true, 'inheritance flagged')
  // scope: a fresh reseller under boss can't see res1's account
  r = await api('POST', '/api/principals', { username: 'resx', password: 'resx-pass-123', role: 'reseller' }, boss)
  const resx = await login('resx', 'resx-pass-123')
  r = await api('GET', '/api/accounts/bob', null, resx)
  assert.strictEqual(r.status, 403, 'foreign account → 403')
  r = await api('GET', '/api/accounts', null, res1)
  assert.strictEqual(r.body.total, 1, 'reseller lists own accounts only (envelope total)')
  assert.strictEqual(r.body.items.length, 1)
  // The high-density query surface: q matches OWNER, server-side filter, paging
  // envelope, junk sort → 400.
  r = await api('GET', '/api/accounts?q=RES1', null, boss)
  assert.ok(r.body.total >= 1 && r.body.items.every((it) => it.owner === 'res1' || it.account.toLowerCase().includes('res1')), 'ci-search matches owner')
  r = await api('GET', '/api/accounts?sort=bogus', null, boss)
  assert.strictEqual(r.status, 400, 'junk sort → 400')
  log('D: fail-closed activation (panel + ledger + registry agree) ✓')

  // ===== E: renew / suspend / resume / passthroughs =====
  const beforeRenew = (await api('GET', '/api/accounts/bob', null, res1)).body.expiresAt
  r = await api('POST', '/api/accounts/bob/renew', { months: 1 }, res1)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.expiresAt, beforeRenew + 31 * 86400000, 'renew extends from current expiry')
  r = await api('GET', '/api/me', null, res1)
  assert.strictEqual(r.body.balance, 3)
  r = await api('POST', '/api/accounts/bob/status', { status: 'disabled' }, res1)
  assert.strictEqual(r.status, 200)
  assert.strictEqual((await pops.getUser(pctx, 'bob')).status, 'disabled', 'panel disabled')
  r = await api('POST', '/api/accounts/bob/status', { status: 'active' }, res1)
  assert.strictEqual((await pops.getUser(pctx, 'bob')).status, 'active', 'panel re-enabled')
  r = await api('GET', '/api/accounts/bob/devices', null, res1)
  assert.strictEqual(r.status, 200)
  assert.ok(Array.isArray(r.body), 'devices passthrough')
  r = await api('POST', '/api/accounts/bob/max-devices', { maxDevices: 1 }, res1)
  assert.strictEqual(r.status, 403, 'per-account maxDevices override is admin-only')
  r = await api('POST', '/api/accounts/bob/max-devices', { maxDevices: 2 }, boss)
  assert.strictEqual(r.status, 200)
  assert.strictEqual((await pops.getUser(pctx, 'bob')).maxDevices, 2, 'admin per-account override applied')
  r = await api('POST', '/api/accounts/bob/password', { password: 'bob-newpass-1' }, res1)
  assert.strictEqual(r.status, 200, 'password passthrough')
  r = await api('POST', '/api/accounts/bob/grants', { streamId: 'sports-plus' }, res1)
  assert.ok((await pops.getUser(pctx, 'bob')).grants.includes('sports-plus'), 'extra grant added')
  r = await api('DELETE', '/api/accounts/bob/grants/sports-plus', null, res1)
  assert.ok(!(await pops.getUser(pctx, 'bob')).grants.includes('sports-plus'), 'grant revoked')
  log('E: renew math, suspend/resume, device/password/grant passthroughs ✓')

  // ===== F: trials — cap, no debit, renew converts =====
  r = await api('POST', '/api/trials', { name: 'taster', password: 'taster-pass-1' }, res1)
  assert.strictEqual(r.status, 201, 'trial: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.kind, 'trial')
  assert.strictEqual((await pops.getUser(pctx, 'taster')).maxDevices, 2, 'trial received the inherited policy (sup1=2)')
  r = await api('GET', '/api/me', null, res1)
  assert.strictEqual(r.body.balance, 3, 'trial is free')
  assert.strictEqual(r.body.trialsUsedToday, 1)
  r = await api('POST', '/api/trials', { name: 'taster2', password: 'taster-pass-1' }, res1)
  assert.strictEqual(r.status, 403, 'trial daily cap (1) → 403')
  r = await api('GET', '/api/accounts?filter=trial', null, res1)
  assert.ok(r.body.total === 1 && r.body.items[0].account === 'taster', 'server-side trial filter')
  const page1 = (await api('GET', '/api/accounts?limit=1&offset=0', null, res1)).body
  const page2 = (await api('GET', '/api/accounts?limit=1&offset=1', null, res1)).body
  assert.ok(page1.total === 2 && page2.total === 2 && page1.items[0].account !== page2.items[0].account, 'offset paging walks without dupes')
  r = await api('POST', '/api/accounts/taster/renew', { months: 1 }, res1)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.kind, 'paid', 'renew converts trial → paid')
  r = await api('GET', '/api/me', null, res1)
  assert.strictEqual(r.body.balance, 2, 'conversion charged 1')
  log('F: trial cap + free + renew-converts ✓')

  // ===== G: delete + refund rules =====
  r = await api('DELETE', '/api/accounts/bob', null, res1)
  assert.strictEqual(r.status, 200)
  assert.ok(r.body.refunded >= 2, `refund floor(remaining) (got ${r.body.refunded})`)
  await assert.rejects(() => pops.getUser(pctx, 'bob'), /no such user/, 'panel user gone')
  const balAfterRefund = (await api('GET', '/api/me', null, res1)).body.balance
  assert.strictEqual(balAfterRefund, 2 + r.body.refunded, 'refund landed on the owner')
  // Admin-tier account ops are free and refundless.
  r = await api('POST', '/api/accounts', { name: 'house', password: 'house-pass-12', months: 3, maxDevices: 5 }, boss)
  assert.strictEqual(r.status, 201)
  assert.strictEqual(r.body.account, 'house', 'admin accounts are plain names too')
  assert.strictEqual((await pops.getUser(pctx, 'house')).maxDevices, 5, 'admins may still set an explicit per-account value')
  assert.strictEqual((await api('GET', '/api/me', null, boss)).body.balance, 0, 'admin activation is free')
  r = await api('DELETE', '/api/accounts/house', null, boss)
  assert.strictEqual(r.body.refunded, 0, 'admin delete refunds nothing')
  log('G: delete refund to owner; admin free/refundless ✓')

  // ===== H: principal suspension bites tokens + accounts; delete blocked rules =====
  r = await api('POST', '/api/accounts', { name: 'loyal', password: 'loyal-pass-12', months: 1 }, res1)
  assert.strictEqual(r.status, 201)
  r = await api('POST', '/api/principals/res1/status', { status: 'suspended', mode: 'with-accounts' }, boss)
  assert.strictEqual(r.status, 200)
  r = await api('GET', '/api/me', null, res1)
  assert.strictEqual(r.status, 401, 'suspended reseller token dead')
  assert.strictEqual((await pops.getUser(pctx, 'loyal')).status, 'disabled', 'with-accounts disabled panel-side')
  r = await api('POST', '/api/principals/res1/status', { status: 'active', mode: 'with-accounts' }, boss)
  assert.strictEqual((await pops.getUser(pctx, 'loyal')).status, 'active', 'resume restored unlapsed account')
  r = await api('DELETE', '/api/principals/res1', null, boss)
  assert.strictEqual(r.status, 400, 'delete blocked while accounts exist')
  r = await api('DELETE', '/api/principals/sup1', null, boss)
  assert.strictEqual(r.status, 400, 'delete blocked while children exist')
  log('H: suspension bites live tokens + accounts; delete-block rules ✓')

  // ===== I: panel outage + token rotation =====
  const res1b = await login('res1', 'res1-pass-123')
  await panelSrv.close()
  r = await api('POST', '/api/accounts', { name: 'ghosted', password: 'ghost-pass-12', months: 1 }, res1b)
  assert.strictEqual(r.status, 502, 'panel down → 502')
  assert.match(r.body.error, /PANEL|unreachable/i, 'error names the panel')
  const balAfterOutage = (await api('GET', '/api/me', null, res1b)).body.balance
  assert.strictEqual(balAfterOutage, balAfterRefund - 1, 'outage left the balance alone (only the earlier loyal activation debited)')
  r = await api('GET', '/api/accounts?q=ghosted', null, res1b)
  assert.strictEqual(r.body.total, 0, 'no registry entry from the failed activate')

  // Panel returns on the SAME port (retry the listen — TIME_WAIT can linger).
  for (let i = 0; ; i++) {
    try {
      panelSrv = await startAdminServer(pctx, { ...panelOpts, port: panelPort })
      break
    } catch (err) {
      if (i >= 20) throw err
      await sleep(250)
    }
  }
  r = await api('POST', '/api/accounts', { name: 'phoenix', password: 'rise-pass-1234', months: 1 }, res1b)
  assert.strictEqual(r.status, 201, 'recovery after outage: ' + JSON.stringify(r.body))

  // Rotate the service admin's password to the SAME value: verifier re-derived,
  // tokenVersion bumped → the cached panel token dies; the next op must
  // transparently re-login once.
  pops.setAdminPassword(pctx, 'reseller-svc', SVC_PASSWORD)
  r = await api('POST', '/api/accounts/phoenix/status', { status: 'disabled' }, res1b)
  assert.strictEqual(r.status, 200, '401→re-login→retry path: ' + JSON.stringify(r.body))
  log('I: outage 502 fail-closed; same-port recovery; transparent re-login ✓')

  // ===== J: the subscription clock (expiry sweep) + reconcile =====
  r = await api('POST', '/api/ops/sweep', null, res1b)
  assert.strictEqual(r.status, 403, 'sweep is admin-tier only')

  // Trial from resx (fresh cap) + force-lapse it AND the paid loyal account.
  r = await api('POST', '/api/trials', { name: 'shortlived', password: 'trial-pass-12' }, resx)
  assert.strictEqual(r.status, 201)
  const records = svc.ctx.accounts.records()
  records['loyal'].expiresAt = Date.now() - 1000
  records['shortlived'].expiresAt = Date.now() - 1000
  svc.ctx.accounts.save()

  r = await api('POST', '/api/ops/sweep', null, boss)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.disabled, 2, `sweep disabled both lapsed accounts: ${JSON.stringify(r.body)}`)
  assert.strictEqual((await pops.getUser(pctx, 'loyal')).status, 'disabled', 'paid lapse disabled panel-side')
  assert.strictEqual((await pops.getUser(pctx, 'shortlived')).status, 'disabled', 'trial lapse disabled panel-side')

  // Resume of a lapsed account is refused; renew re-activates with fresh coverage.
  r = await api('POST', '/api/accounts/loyal/status', { status: 'active' }, res1b)
  assert.strictEqual(r.status, 400, 'lapsed resume refused (renew instead)')
  r = await api('POST', '/api/accounts/loyal/renew', { months: 1 }, res1b)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.status, 'active')
  assert.ok(r.body.expiresAt > Date.now() + 30 * 86400000, 'renewal coverage from now')
  assert.strictEqual((await pops.getUser(pctx, 'loyal')).status, 'active', 'panel re-activated by renew')

  // Reconcile. Orphan detection is INTENT-driven now (names carry no marker):
  // simulate a crash between the panel create and the local commit — a panel
  // user exists, a stale intent exists, no registry entry. Also: a status
  // divergence heals toward the local clock, and an operator-created panel user
  // with NO intent must be invisible to the reseller service entirely.
  await pops.createUser(pctx, 'ghost', 'ghost-pass-123')
  svc.ctx.accounts.pendingIntents().ghost = { owner: 'res1', ts: Date.now() - 120000 }
  await pops.createUser(pctx, 'operator-joe', 'joe-pass-12345') // NOT ours, no intent
  await pops.setUserStatus(pctx, 'loyal', 'disabled') // divergence: local active+unlapsed
  r = await api('POST', '/api/ops/reconcile', null, boss)
  assert.strictEqual(r.status, 200)
  assert.ok(r.body.orphanPanel.includes('ghost'), 'stale-intent orphan flagged')
  assert.ok(!r.body.orphanPanel.includes('operator-joe'), 'operator-created user untouched (no intent)')
  assert.strictEqual((await pops.getUser(pctx, 'operator-joe')).status, 'active', 'operator user left active')
  assert.ok(r.body.statusFixed.some((f) => f.account === 'loyal' && f.to === 'active'), 'divergence detected')
  assert.strictEqual((await pops.getUser(pctx, 'ghost')).status, 'disabled', 'orphan disabled, not deleted')
  assert.strictEqual((await pops.getUser(pctx, 'loyal')).status, 'active', 'local clock won')
  r = await api('GET', '/api/ops/reconcile', null, boss)
  assert.ok(r.body.ts && r.body.orphanPanel, 'report persisted + retrievable')
  log('J: expiry sweep (paid + trial), lapsed-renew, reconcile orphan/divergence ✓')

  // ===== K: system diagnostics (host + service + live panel probe) =====
  r = await api('GET', '/api/system', null, res1b)
  assert.strictEqual(r.status, 403, 'system view is admin-tier only')
  r = await api('GET', '/api/system', null, boss)
  assert.strictEqual(r.status, 200, 'system: ' + JSON.stringify(r.body))
  assert.ok(typeof r.body.host.hostname === 'string' && r.body.host.cpuCount >= 1, 'host block populated')
  assert.strictEqual(r.body.service.node, process.version, 'service block reports this node')
  assert.ok(r.body.service.ledger && r.body.service.ledger.invariantOk === true, 'ledger health relayed')
  assert.ok(r.body.panel && r.body.panel.stats && r.body.panel.stats.users >= 1, 'live panel stats relayed')
  assert.ok(typeof r.body.panel.latencyMs === 'number' && r.body.panel.reachable === true, 'panel probe timed + reachable')
  log('K: /api/system 403 for resellers; host+service+panel stats for admins ✓')

  // ===== L: TRUST_PROXY_HEADER — behind a tunnel/proxy the lockout keys on the
  // proxy-supplied client IP, not the (shared) socket address. A second tiny
  // instance runs with the Cloudflare header declared; the main instance keeps
  // the default (socket-keyed) behavior, which A already covered.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-rsl2-'))
  cleanups.push(() => fs.rmSync(dir2, { recursive: true, force: true }))
  addPrincipal({ dataDir: dir2, config: { argon2: fastArgon, maxDevicesLimitDefault: 3, trialDailyCapDefault: 3 } },
    { username: 'boss2', password: 'boss2-pass-12', role: 'admin', root: true, createdBy: 'cli' })
  const WH_SECRET = 'whsec-e2e-0123456789abcdef'
  const theme2 = path.join(dir2, 'brand-theme.json')
  fs.writeFileSync(theme2, JSON.stringify({ accent: '#FF8800', bogus: '#123456', bg: 'not-a-color' }))
  const logo2 = path.join(dir2, 'brand-logo.svg')
  fs.writeFileSync(logo2, '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><text x="0" y="24" fill="#FF8800">ACME</text></svg>')
  const svc2 = await startReseller({
    dataDir: dir2,
    argon2: fastArgon,
    noSweeps: true,
    control: { host: '127.0.0.1', port: 0, trustProxyHeader: 'cf-connecting-ip' },
    lockout: { threshold: 2, seconds: 60 },
    branding: { name: 'Acme TV', themeFile: theme2, logoFile: logo2 },
    webhook: { secret: WH_SECRET },
    panel: { url: `http://127.0.0.1:${panelPort}`, username: 'reseller-svc', password: SVC_PASSWORD, timeoutMs: 4000 }
  })
  cleanups.push(() => svc2.close())
  const proxied = async (ipHeader) => {
    const res = await fetch(`http://127.0.0.1:${svc2.control.port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ipHeader },
      body: JSON.stringify({ username: 'victim', password: 'x'.repeat(12) })
    })
    return res.status
  }
  for (let i = 0; i < 2; i++) await proxied('198.51.100.7')
  assert.strictEqual(await proxied('198.51.100.7'), 429, 'same proxied client IP → locked')
  assert.strictEqual(await proxied('203.0.113.9'), 401, 'different proxied client IP → own fresh counter')
  assert.strictEqual(await proxied('6.6.6.6, 198.51.100.7'), 429, 'rightmost (proxy-appended) list entry is the key')
  log('L: TRUST_PROXY_HEADER keys the lockout on the proxied client IP ✓')

  // ===== M: white-label branding + HMAC-signed idempotent credit top-ups =====
  const base2 = `http://127.0.0.1:${svc2.control.port}`
  let wj = await (await fetch(base2 + '/branding.json')).json()
  assert.strictEqual(wj.name, 'Acme TV', 'brand name served')
  assert.strictEqual(wj.accent, '#FF8800', 'accent follows the theme override')
  assert.ok(wj.logo === true && wj.favicon === false, 'image flags reflect configured files')
  const logoRes = await fetch(base2 + '/branding/logo')
  assert.ok(logoRes.status === 200 && logoRes.headers.get('content-type') === 'image/svg+xml', 'logo served with its type')
  assert.strictEqual((await fetch(base2 + '/branding/favicon')).status, 404, 'unset favicon → 404')
  assert.strictEqual((await fetch(base + '/branding/logo')).status, 404, 'unbranded instance has no logo route')
  const brandCss = await (await fetch(base2 + '/branding.css')).text()
  assert.ok(brandCss.includes('--accent: #FF8800'), 'theme override css emitted')
  assert.ok(!brandCss.includes('bogus') && !brandCss.includes('not-a-color'), 'unknown tokens + junk values filtered')
  assert.ok((await (await fetch(base + '/branding.css')).text()).includes('no white-label'), 'unbranded instance = empty overrides')
  assert.strictEqual((await (await fetch(base + '/branding.json')).json()).name, 'Aliran reseller', 'unbranded default name')

  const whPost = async (body, { ts = Math.floor(Date.now() / 1000), sig } = {}) => {
    const raw = JSON.stringify(body)
    const s = sig ?? createHmac('sha256', WH_SECRET).update(ts + '.' + raw).digest('hex')
    const res = await fetch(base2 + '/api/webhooks/credits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-topup-timestamp': String(ts), 'x-topup-signature': s },
      body: raw
    })
    let json = null
    try { json = await res.json() } catch {}
    return { status: res.status, body: json }
  }
  r = await whPost({ id: 'evt-1', to: 'boss2', amount: 25 }, { sig: 'deadbeef' })
  assert.strictEqual(r.status, 401, 'bad signature → 401')
  r = await whPost({ id: 'evt-1', to: 'boss2', amount: 25 }, { ts: Math.floor(Date.now() / 1000) - 4000 })
  assert.strictEqual(r.status, 401, 'stale timestamp (replay) → 401')
  r = await whPost({ id: 'evt-1', to: 'boss2', amount: 25, note: 'order #1001' })
  assert.strictEqual(r.status, 200, 'signed top-up: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.balance, 25, 'credits landed')
  r = await whPost({ id: 'evt-1', to: 'boss2', amount: 25 })
  assert.ok(r.status === 200 && r.body.duplicate === true && r.body.balance === 25, 'provider retry of the same event id mints nothing')
  r = await whPost({ id: 'evt-2', to: 'nobody9', amount: 5 })
  assert.strictEqual(r.status, 404, 'unknown principal → 404')
  const mainWh = await fetch(base + '/api/webhooks/credits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.strictEqual(mainWh.status, 404, 'no WEBHOOK_SECRET → route indistinguishable from absent')
  log('M: branding endpoints + HMAC top-ups (sig, replay, idempotency, audit MINT) ✓')

  log('\nPASS: reseller e2e (panel + hierarchy + credits + lifecycle + outage + sweeps)')
  await cleanup()
  process.exit(0)
} catch (err) {
  console.error('\nFAIL:', err)
  await cleanup()
  process.exit(1)
}
