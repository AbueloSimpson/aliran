// Viewer-account operations: the registry (accounts.json — THE subscription clock,
// because the panel has no expiry concept) plus the fail-closed op sequences that
// pair a panel admin-API call with a ledger movement. Every mutating method here
// MUST run inside the service mutex (the routes wrap it): balance check, panel
// call, ledger append and registry write happen as one uninterleaved sequence.
//
// Fail-closed ordering (the FireShare lesson): the PANEL is called first, and
// money/registry commit only on its OK — a 402/panel-rejection leaves NOTHING
// behind. The one softening: after a successful create, a failed decoration call
// (extra grant, max-devices) still commits locally with panel.lastError set —
// the reconcile sweep finishes the decoration rather than stranding a paid-for
// account half-made.
//
// Account names are PLAIN panel usernames — no prefixes (user decision: names are
// a global first-come-first-served space; a clash with an existing panel user
// surfaces as the panel's own `exists` error). Ownership and scoping never depend
// on the name: the registry's `owner` field is authoritative, and a reseller can
// only ever operate on accounts the registry says are theirs. Because nothing in a
// panel username marks it as reseller-created, crash recovery uses an INTENT
// JOURNAL instead: the intent is recorded before the panel call and cleared after
// the registry commit, so a crash in between leaves a stale intent the reconcile
// sweep can chase. Viewer passwords are pass-through only — never stored here.

import path from 'path'
import { ControlError } from './errors.js'
import { readJsonFile, writeJsonFile } from './store.js'
import { loadPrincipals } from './control-auth.js'
import { effectiveMaxDevices } from './roles.js'

// Same shape the panel itself enforces (panel/src/ops.js NAME_RE).
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const MONTHS_MAX = 120

export function makeAccounts (ctx) {
  const file = path.join(ctx.dataDir, 'accounts.json')
  const intentsFile = path.join(ctx.dataDir, 'state', 'intents.json')
  const registry = readJsonFile(file, {})
  const intents = readJsonFile(intentsFile, {})
  const monthMs = () => ctx.config.daysPerMonth * 86400000

  function save () { writeJsonFile(file, registry) }
  function saveIntents () { writeJsonFile(intentsFile, intents) }

  function checkName (name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new ControlError('bad-request', 'account name: letters, digits, _ . - ; max 64 chars')
    }
    return name
  }

  // Crash-window bookkeeping: an intent exists exactly while a panel create is in
  // flight but not yet committed locally. A stale one means we may have created a
  // panel user we lost track of — reconcile checks and repairs.
  function openIntent (acct, owner) {
    intents[acct] = { owner, ts: Date.now() }
    saveIntents()
  }
  function closeIntent (acct) {
    if (intents[acct]) { delete intents[acct]; saveIntents() }
  }

  function mustGet (acct) {
    const r = registry[acct]
    if (!r || r.status === 'deleted') throw new ControlError('not-found', `no such account: ${acct}`)
    return r
  }

  const isAdminTier = (me) => me.role === 'admin' || me.role === 'co-admin'

  function view (acct) {
    const r = registry[acct]
    return {
      account: acct,
      owner: r.owner,
      kind: r.kind,
      status: r.status,
      expiresAt: r.expiresAt,
      expiresInDays: Math.ceil((r.expiresAt - Date.now()) / 86400000),
      maxDevices: r.maxDevices,
      extraGrants: r.extraGrants,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      panel: r.panel
    }
  }

  // Decoration calls after a successful create: best-effort, self-healing via
  // reconcile — a paid-for account is never stranded on a grant hiccup.
  async function decorate (acct, r, { grants, maxDevices }) {
    try {
      for (const streamId of grants) {
        await ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/grants`, { streamId })
        if (!r.extraGrants.includes(streamId)) r.extraGrants.push(streamId)
      }
      if (maxDevices !== undefined) {
        await ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/max-devices`, { maxDevices })
        r.maxDevices = maxDevices
      }
      r.panel = { lastSyncAt: Date.now(), lastError: null }
    } catch (err) {
      r.panel = { lastSyncAt: Date.now(), lastError: String(err.message || err) }
    }
  }

  // Device policy (user decision 2026-07-23): maxDevices is ADMIN-SET and
  // inherited down the hierarchy — an account receives its creator's effective
  // policy value, so every account in a subtree is consistent by construction.
  // Only admin tiers may pass an explicit per-account value (an operator
  // exception, not a reseller choice); anyone else supplying one is rejected
  // loudly rather than silently corrected.
  function resolveDevices (me, requested) {
    const policy = effectiveMaxDevices(loadPrincipals(ctx.dataDir), me.name, ctx.config.maxDevicesLimitDefault)
    if (requested === undefined) return policy
    if (!isAdminTier(me)) {
      throw new ControlError('forbidden', `maxDevices is set by your admin (your accounts get ${policy}) — omit it`)
    }
    if (!Number.isInteger(requested) || requested < 1 || requested > 1000) {
      throw new ControlError('bad-request', 'maxDevices must be an integer 1-1000')
    }
    return requested
  }

  // Paid activation. Debits the ACTOR unless they're an admin tier (free, and
  // deliberately no ledger line — admin account ops are operator actions, not
  // credit economy).
  async function activate (me, { name, password, months, maxDevices, grants = [] }) {
    if (!Number.isInteger(months) || months < 1 || months > MONTHS_MAX) throw new ControlError('bad-request', `months must be an integer 1-${MONTHS_MAX}`)
    if (typeof password !== 'string' || password.length < 8) throw new ControlError('bad-request', 'account password must be at least 8 characters')
    if (!Array.isArray(grants) || grants.some((g) => typeof g !== 'string')) throw new ControlError('bad-request', 'grants must be an array of streamIds')
    const acct = checkName(name)
    if (registry[acct] && registry[acct].status !== 'deleted') throw new ControlError('exists', `account "${acct}" already exists`)
    const devices = resolveDevices(me, maxDevices)
    const pays = !isAdminTier(me)
    if (pays && ctx.ledger.balance(me.name) < months) {
      throw new ControlError('insufficient-credits', `balance ${ctx.ledger.balance(me.name)} < ${months}`)
    }

    // Panel first — its create auto-grants the autoGrant-source baseline. The
    // intent brackets the crash window between panel create and registry commit.
    openIntent(acct, me.name)
    try {
      await ctx.panel.req('POST', '/api/users', { username: acct, password })
    } catch (err) {
      closeIntent(acct) // the panel refused — nothing was created anywhere
      throw err
    }

    const now = Date.now()
    const r = registry[acct] = {
      owner: me.name,
      kind: 'paid',
      status: 'active',
      expiresAt: now + months * monthMs(),
      maxDevices: devices,
      extraGrants: [],
      createdAt: now,
      createdBy: me.name,
      panel: { lastSyncAt: now, lastError: null }
    }
    await decorate(acct, r, { grants, maxDevices: devices })
    if (pays) {
      ctx.ledger.append({
        type: 'ACTIVATE',
        actor: me.name,
        entries: [{ principal: me.name, delta: -months }],
        account: acct,
        months,
        coverageStart: now,
        coverageEnd: r.expiresAt
      })
    }
    save()
    closeIntent(acct)
    return view(acct)
  }

  // Free time-boxed trial (locked decision 4). Zero-value TRIAL ledger line = the
  // audit record AND the daily-cap counter; admin tiers are uncapped.
  async function trial (me, { name, password, maxDevices }) {
    if (typeof password !== 'string' || password.length < 8) throw new ControlError('bad-request', 'account password must be at least 8 characters')
    if (!isAdminTier(me) && ctx.ledger.trialsToday(me.name) >= me.trialDailyCap) {
      throw new ControlError('forbidden', `trial daily cap reached (${me.trialDailyCap}/day)`)
    }
    const acct = checkName(name)
    if (registry[acct] && registry[acct].status !== 'deleted') throw new ControlError('exists', `account "${acct}" already exists`)
    const devices = resolveDevices(me, maxDevices)

    openIntent(acct, me.name)
    try {
      await ctx.panel.req('POST', '/api/users', { username: acct, password })
    } catch (err) {
      closeIntent(acct)
      throw err
    }

    const now = Date.now()
    const r = registry[acct] = {
      owner: me.name,
      kind: 'trial',
      status: 'active',
      expiresAt: now + ctx.config.trialHours * 3600000,
      maxDevices: devices,
      extraGrants: [],
      createdAt: now,
      createdBy: me.name,
      panel: { lastSyncAt: now, lastError: null }
    }
    await decorate(acct, r, { grants: [], maxDevices: devices })
    ctx.ledger.append({ type: 'TRIAL', actor: me.name, entries: [], account: acct })
    save()
    closeIntent(acct)
    return view(acct)
  }

  // Renew = extend the clock from max(now, current expiry). Renewing a TRIAL
  // converts it to paid (locked decision 6) — same credentials, coverage from
  // max(now, trial expiry). A LAPSED account is panel-re-activated first; a
  // manually suspended, unlapsed account stays disabled (resume is explicit).
  async function renew (me, acct, months) {
    if (!Number.isInteger(months) || months < 1 || months > MONTHS_MAX) throw new ControlError('bad-request', `months must be an integer 1-${MONTHS_MAX}`)
    const r = mustGet(acct)
    const pays = !isAdminTier(me)
    if (pays && ctx.ledger.balance(me.name) < months) {
      throw new ControlError('insufficient-credits', `balance ${ctx.ledger.balance(me.name)} < ${months}`)
    }
    const now = Date.now()
    const lapsed = r.expiresAt <= now
    if (r.status === 'disabled' && lapsed) {
      await ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/status`, { status: 'active' })
      r.status = 'active'
    }
    const start = Math.max(now, r.expiresAt)
    r.expiresAt = start + months * monthMs()
    r.kind = 'paid'
    if (pays) {
      ctx.ledger.append({
        type: 'RENEW',
        actor: me.name,
        entries: [{ principal: me.name, delta: -months }],
        account: acct,
        months,
        coverageStart: start,
        coverageEnd: r.expiresAt
      })
    }
    r.panel = { lastSyncAt: Date.now(), lastError: null }
    save()
    return view(acct)
  }

  // Manual suspend/resume. Resume of a LAPSED account is refused — that's what
  // renew is for (otherwise a dead subscription could be waved alive for free).
  async function setStatus (me, acct, status) {
    if (status !== 'active' && status !== 'disabled') throw new ControlError('bad-request', 'status must be "active" or "disabled"')
    const r = mustGet(acct)
    if (status === 'active' && r.expiresAt <= Date.now()) {
      throw new ControlError('bad-request', 'account is lapsed — renew it instead of resuming')
    }
    await ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/status`, { status })
    r.status = status
    r.panel = { lastSyncAt: Date.now(), lastError: null }
    save()
    return view(acct)
  }

  async function setPassword (me, acct, password) {
    mustGet(acct)
    await ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/password`, { password })
    return { account: acct, passwordChanged: true }
  }

  // Per-account override — admin tiers only (the policy exception path; a
  // reseller's accounts always carry the inherited policy value).
  async function setMaxDevices (me, acct, maxDevices) {
    const r = mustGet(acct)
    if (maxDevices === undefined) throw new ControlError('bad-request', 'maxDevices required')
    const devices = resolveDevices(me, maxDevices)
    await ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/max-devices`, { maxDevices: devices })
    r.maxDevices = devices
    r.panel = { lastSyncAt: Date.now(), lastError: null }
    save()
    return view(acct)
  }

  async function addGrant (me, acct, streamId) {
    const r = mustGet(acct)
    if (typeof streamId !== 'string' || !streamId) throw new ControlError('bad-request', 'streamId required')
    await ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/grants`, { streamId })
    if (!r.extraGrants.includes(streamId)) r.extraGrants.push(streamId)
    save()
    return view(acct)
  }

  async function removeGrant (me, acct, streamId) {
    const r = mustGet(acct)
    await ctx.panel.req('DELETE', `/api/users/${encodeURIComponent(acct)}/grants/${encodeURIComponent(streamId)}`)
    r.extraGrants = r.extraGrants.filter((g) => g !== streamId)
    save()
    return view(acct)
  }

  async function devices (me, acct) {
    mustGet(acct)
    return ctx.panel.req('GET', `/api/users/${encodeURIComponent(acct)}/devices`)
  }

  async function revokeDevice (me, acct, deviceId) {
    mustGet(acct)
    return ctx.panel.req('DELETE', `/api/users/${encodeURIComponent(acct)}/devices/${encodeURIComponent(deviceId)}`)
  }

  async function logoutAll (me, acct) {
    mustGet(acct)
    return ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/logout-all`)
  }

  // Delete: panel first (404 = already gone, counts as done), then the refund —
  // floor of the remaining months back to the account's OWNER, unless the actor
  // is an admin tier (their deletes are operator actions, no refund written).
  async function remove (me, acct) {
    const r = mustGet(acct)
    try {
      await ctx.panel.req('DELETE', `/api/users/${encodeURIComponent(acct)}`)
    } catch (err) {
      if (err.httpStatus !== 404) throw err
    }
    let refunded = 0
    if (!isAdminTier(me) && r.kind === 'paid') {
      refunded = Math.max(0, Math.floor((r.expiresAt - Date.now()) / monthMs()))
      if (refunded > 0) {
        ctx.ledger.append({ type: 'REFUND', actor: me.name, entries: [{ principal: r.owner, delta: refunded }], account: acct, months: refunded })
      }
    }
    r.status = 'deleted'
    r.deletedAt = Date.now()
    save()
    return { account: acct, deleted: true, refunded }
  }

  // Bulk disable/enable for principal suspension (with-accounts mode). Enable
  // only resurrects accounts that are not lapsed. Best-effort per account —
  // failures land in panel.lastError and reconcile retries.
  async function bulkSetOwnerStatus (owner, status) {
    for (const [acct, r] of Object.entries(registry)) {
      if (r.owner !== owner || r.status === 'deleted') continue
      const target = status === 'active' && r.expiresAt <= Date.now() ? null : status
      if (!target || r.status === target) continue
      try {
        await ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/status`, { status: target })
        r.status = target
        r.panel = { lastSyncAt: Date.now(), lastError: null }
      } catch (err) {
        r.panel = { lastSyncAt: Date.now(), lastError: String(err.message || err) }
      }
    }
    save()
  }

  // --- registry views (no panel I/O) ---

  function count () {
    return Object.values(registry).filter((r) => r.status !== 'deleted').length
  }

  function countOwnedBy (owner) {
    return Object.values(registry).filter((r) => r.owner === owner && r.status !== 'deleted').length
  }

  function kpis (scope) {
    const out = { accountsActive: 0, accountsExpiring7d: 0, accountsDisabled: 0, trialsActive: 0 }
    const soon = Date.now() + 7 * 86400000
    for (const r of Object.values(registry)) {
      if (r.status === 'deleted') continue
      if (scope !== '*' && !scope.has(r.owner)) continue
      if (r.status === 'active') {
        out.accountsActive++
        if (r.expiresAt <= soon) out.accountsExpiring7d++
        if (r.kind === 'trial') out.trialsActive++
      } else {
        out.accountsDisabled++
      }
    }
    return out
  }

  // The list query engine — built for HIGH-DENSITY registries. The registry is
  // one in-memory object, so a full filter → sort → slice pass per request costs
  // a few ms even at ~100k accounts; no index is needed, and `total` (the
  // filtered count before slicing) is what lets the UI say "Showing X of Y".
  // Paging is offset-based because it composes with every sort order; the tiny
  // page drift a concurrent create/delete can cause between two Load-More clicks
  // is acceptable for an ops table.
  const LIST_FILTERS = new Set(['active', 'disabled', 'expiring', 'trial'])
  const LIST_SORTS = new Set(['name', 'expires', 'owner', 'created', 'status'])

  function list ({ q, owner, filter, sort, dir, offset, limit, expiringDays } = {}, scope = '*') {
    if (filter !== undefined && !LIST_FILTERS.has(filter)) throw new ControlError('bad-request', `filter must be one of: ${[...LIST_FILTERS].join(', ')}`)
    if (sort !== undefined && !LIST_SORTS.has(sort)) throw new ControlError('bad-request', `sort must be one of: ${[...LIST_SORTS].join(', ')}`)
    if (dir !== undefined && dir !== 'asc' && dir !== 'desc') throw new ControlError('bad-request', 'dir must be "asc" or "desc"')
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50
    const from = Number.isInteger(offset) && offset > 0 ? offset : 0
    const needle = typeof q === 'string' && q.trim() ? q.trim().toLowerCase() : null
    const soonest = Date.now() + (Number.isInteger(expiringDays) && expiringDays > 0 ? expiringDays : 7) * 86400000

    const matched = []
    for (const [acct, r] of Object.entries(registry)) {
      if (r.status === 'deleted') continue
      if (scope !== '*' && !scope.has(r.owner)) continue
      if (owner && r.owner !== owner) continue
      if (filter === 'active' && r.status !== 'active') continue
      if (filter === 'disabled' && r.status !== 'disabled') continue
      if (filter === 'trial' && r.kind !== 'trial') continue
      if (filter === 'expiring' && !(r.status === 'active' && r.expiresAt <= soonest)) continue
      if (needle && !acct.toLowerCase().includes(needle) && !r.owner.toLowerCase().includes(needle)) continue
      matched.push(acct)
    }

    const sign = dir === 'desc' ? -1 : 1
    matched.sort((a, b) => {
      let cmp = 0
      if (sort === 'expires') cmp = registry[a].expiresAt - registry[b].expiresAt
      else if (sort === 'created') cmp = (registry[a].createdAt || 0) - (registry[b].createdAt || 0)
      else if (sort === 'owner') cmp = registry[a].owner < registry[b].owner ? -1 : registry[a].owner > registry[b].owner ? 1 : 0
      // status asc groups active first ('active' < 'disabled'), desc the reverse.
      else if (sort === 'status') cmp = registry[a].status < registry[b].status ? -1 : registry[a].status > registry[b].status ? 1 : 0
      if (cmp === 0) cmp = a < b ? -1 : a > b ? 1 : 0 // name tiebreak keeps the order total
      return cmp * sign
    })

    return {
      items: matched.slice(from, from + cap).map(view),
      total: matched.length,
      offset: from,
      limit: cap
    }
  }

  function get (acct) {
    mustGet(acct)
    return view(acct)
  }

  // Raw record access for the sweeps (same process, same mutex discipline).
  function records () { return registry }
  function pendingIntents () { return intents }

  return {
    checkName,
    activate,
    trial,
    renew,
    setStatus,
    setPassword,
    setMaxDevices,
    addGrant,
    removeGrant,
    devices,
    revokeDevice,
    logoutAll,
    remove,
    bulkSetOwnerStatus,
    count,
    countOwnedBy,
    kpis,
    list,
    get,
    view,
    records,
    pendingIntents,
    closeIntent,
    save
  }
}
