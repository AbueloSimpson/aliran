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

  function checkDeviceCap (me, maxDevices) {
    if (maxDevices === undefined) return undefined
    const cap = isAdminTier(me) ? 1000 : me.maxDevicesLimit
    if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > cap) {
      throw new ControlError('bad-request', `maxDevices must be an integer 1-${cap}`)
    }
    return maxDevices
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
    const devices = checkDeviceCap(me, maxDevices)
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
      maxDevices: 1,
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
    const devices = checkDeviceCap(me, maxDevices)

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
      maxDevices: 1,
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

  async function setMaxDevices (me, acct, maxDevices) {
    const r = mustGet(acct)
    const devices = checkDeviceCap(me, maxDevices)
    if (devices === undefined) throw new ControlError('bad-request', 'maxDevices required')
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

  function list ({ owner, status, q, after, limit } = {}, scope = '*') {
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100
    const names = Object.keys(registry).sort()
    const out = []
    for (const acct of names) {
      if (out.length >= cap) break
      const r = registry[acct]
      if (r.status === 'deleted') continue
      if (scope !== '*' && !scope.has(r.owner)) continue
      if (owner && r.owner !== owner) continue
      if (status && r.status !== status) continue
      if (q && !acct.includes(q)) continue
      if (after && acct <= after) continue
      out.push(view(acct))
    }
    return out
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
