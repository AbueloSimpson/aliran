// reseller_* tools — thin wrappers over the reseller control API
// (reseller/src/control-server.js, :3330). Registered only when the config has a
// `reseller` block; the configured principal should be the ROOT admin (or a
// co-admin) — several of these routes are admin-capability-gated and a lesser
// principal gets a clean 403 from the service.
//
// Scope: the OPERATOR's oversight jobs — enroll resellers, top up credits, audit
// the ledger, oversee accounts and trials, watch the sweeps. Reseller DAILY
// driving (activate/renew/extend accounts, set packages) deliberately stays in
// the resellers' own panel: those are their jobs, in their own UI, under their
// own audit trail.

import { z } from 'zod'
import { genPassword, compactUser } from './panel.js'

const q = (v) => encodeURIComponent(String(v))
const qs = (pairs) => {
  const parts = []
  for (const [k, v] of Object.entries(pairs)) if (v !== undefined && v !== null && v !== '') parts.push(k + '=' + q(v))
  return parts.length ? '?' + parts.join('&') : ''
}

export function registerResellerTools (ctx, h) {
  const { def, ok } = h
  const r = ctx.reseller

  // ---- read (readOnlyHint) ----
  def('reseller_status', {
    title: 'Reseller service status',
    description: 'Reseller-panel KPIs for the configured principal: balance, accounts active/expiring/disabled, trials. Admin tiers additionally get principal count, outstanding credits, the panel-link health and the last reconcile summary.',
    annotations: { readOnlyHint: true }
  }, async () => ok(await r.get('/api/status')))

  def('reseller_system', {
    title: 'Reseller host diagnostics',
    description: 'Operator diagnostics from the reseller box: host stats (cpu/mem/disk/load), service process vitals, sweep + ledger health, and a LIVE timed probe of the downstream panel admin API. Admin tiers only.',
    annotations: { readOnlyHint: true }
  }, async () => ok(await r.get('/api/system')))

  def('reseller_list_principals', {
    title: 'List principals',
    description: 'Every principal the configured login may manage (admins, co-admins, supers, resellers) with role, status, balance, account count and the effective device policy.',
    annotations: { readOnlyHint: true }
  }, async () => ok(await r.get('/api/principals')))

  def('reseller_get_principal', { title: 'Get a principal', description: 'One principal: role, status, parent, balance, owned-account count, limits (effective device policy + trial cap).', inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } },
    async ({ name }) => ok(await r.get('/api/principals/' + q(name))))

  def('reseller_ledger', {
    title: 'Query the credit ledger',
    description: 'The append-only credit ledger (MINT/TRANSFER/ACTIVATE/RENEW/REFUND/RECLAIM/TRIAL/ADJUST lines), newest first. Filter by principal, account, or type; page with before=<seq> + limit. Admin tiers see everything, others their own subtree.',
    inputSchema: { principal: z.string().optional(), account: z.string().optional(), type: z.enum(['MINT', 'TRANSFER', 'ACTIVATE', 'RENEW', 'REFUND', 'RECLAIM', 'TRIAL', 'ADJUST']).optional(), before: z.number().int().optional(), limit: z.number().int().min(1).max(500).optional() },
    annotations: { readOnlyHint: true }
  }, async (a) => ok(await r.get('/api/ledger' + qs(a))))

  def('reseller_list_accounts', {
    title: 'List reseller-managed accounts',
    description: 'Viewer accounts managed through the reseller panel: owner, expiry, status, kind. Filters: q (name search), owner (a principal), filter (active|disabled|expiring|trial), sort/dir, offset/limit.',
    inputSchema: { q: z.string().optional(), owner: z.string().optional(), filter: z.enum(['active', 'disabled', 'expiring', 'trial']).optional(), sort: z.string().optional(), dir: z.enum(['asc', 'desc']).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() },
    annotations: { readOnlyHint: true }
  }, async (a) => ok(await r.get('/api/accounts' + qs(a))))

  def('reseller_get_account', {
    title: 'Get a reseller-managed account',
    description: 'One managed account: the reseller-side registry record (owner, expiry, kind, packages, extraGrants) plus its LIVE panel state (status, grants, packages, devices) when the panel is reachable. The live block\'s long grant lists come back as {count, sample} — full:true for every id.',
    inputSchema: { account: z.string(), full: z.boolean().optional().describe('return the live block\'s complete grants/manualGrants id lists (default: long lists are summarized to {count, sample})') },
    annotations: { readOnlyHint: true }
  }, async ({ account, full }) => {
    const out = await r.get('/api/accounts/' + q(account))
    return ok(out && out.live ? { ...out, live: compactUser(out.live, full) } : out)
  })

  def('reseller_trials', {
    title: 'View trial accounts',
    description: 'The trials view: every time-boxed trial account (kind:trial) in scope, with owner and expiry. Creating trials is reseller daily driving — it stays in the reseller panel.',
    inputSchema: { owner: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
    annotations: { readOnlyHint: true }
  }, async (a) => ok(await r.get('/api/accounts' + qs({ ...a, filter: 'trial' }))))

  def('reseller_ops_status', {
    title: 'Sweeps / reconcile status',
    description: 'The last expiry-sweep + panel-reconcile report ({never:true} if none ran yet): what expired, what was repaired, when. Admin tiers only.',
    annotations: { readOnlyHint: true }
  }, async () => ok(await r.get('/api/ops/reconcile')))

  // ---- principals: enroll / mutate ----
  def('reseller_add_principal', {
    title: 'Enroll a principal',
    description: 'Create a reseller-panel principal under the configured login: role co-admin (root-only), super (a super-reseller who funds/manages its own resellers) or reseller. If password is omitted a strong one is generated and returned so you can hand it over. maxDevicesLimit is admin-set policy; trialDailyCap bounds free trials/day.',
    inputSchema: { username: z.string(), password: z.string().min(8).optional(), role: z.enum(['co-admin', 'super', 'reseller']), maxDevicesLimit: z.number().int().min(1).max(1000).optional(), trialDailyCap: z.number().int().min(0).max(1000).optional(), note: z.string().optional() }
  }, async ({ username, password, ...rest }) => {
    const pw = password || genPassword()
    const out = await r.post('/api/principals', { username, password: pw, ...rest })
    return ok({ ...out, generatedPassword: password ? undefined : pw })
  })

  def('reseller_set_principal_password', {
    title: 'Set a principal password',
    description: 'Rotate a principal\'s login password (their live sessions keep working until token expiry; suspension is the kill switch). Omit password to generate + return one. CAUTION: if this is the principal this MCP itself logs in with (config "reseller.user"), update the operator\'s local mcp config (mcp/config.json) right afterwards.',
    inputSchema: { name: z.string(), password: z.string().min(8).optional() }
  }, async ({ name, password }) => {
    const pw = password || genPassword()
    const out = await r.post('/api/principals/' + q(name) + '/password', { password: pw })
    return ok({ ...out, generatedPassword: password ? undefined : pw })
  })

  def('reseller_set_principal_limits', {
    title: 'Set principal limits',
    description: 'Tune a principal\'s limits: maxDevicesLimit (admin-set device policy, inherited by the subtree; null re-inherits) and trialDailyCap (free trials per day).',
    inputSchema: { name: z.string(), maxDevicesLimit: z.number().int().min(1).max(1000).nullable().optional(), trialDailyCap: z.number().int().min(0).max(1000).optional() }
  }, async ({ name, ...body }) => ok(await r.post('/api/principals/' + q(name) + '/limits', body)))

  def('reseller_set_principal_status', {
    title: 'Suspend/reactivate a principal',
    description: 'Suspend (locks the principal out immediately — tokenVersion bump) or reactivate. mode:"with-accounts" additionally bulk-disables (or re-enables) every viewer account the principal owns, on the panel — that cuts off its whole customer base in one call.',
    inputSchema: { name: z.string(), status: z.enum(['active', 'suspended']), mode: z.enum(['with-accounts']).optional() },
    annotations: { destructiveHint: true }
  }, async ({ name, ...body }) => ok(await r.post('/api/principals/' + q(name) + '/status', body)))

  // ---- credits: the operator-side top-up ----
  def('reseller_grant_credits', {
    title: 'Grant credits (mint)',
    description: 'Mint credits to a principal — the operator-side top-up (credits come from nothing exactly here; admin tiers only). Credits are TIME: 1 credit = 1 month of viewer-account service. Omit `to` to top up the configured login itself. The result echoes the ledger line it appended: seq, actor, principal, amount, and the principal\'s new balance.',
    inputSchema: { to: z.string().optional(), amount: z.number().int().min(1).max(1000000), note: z.string().max(200).optional() }
  }, async ({ to, amount, note }) => {
    const out = await r.post('/api/credits/mint', { to, amount, note })
    return ok({ minted: { seq: out.seq, type: 'MINT', actor: ctx.config.reseller.username, principal: out.to, amount: out.amount, note: note || '' }, newBalance: out.balance })
  })
}
