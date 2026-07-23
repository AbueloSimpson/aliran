// The two background loops that keep reality and the registry aligned.
//
// EXPIRY SWEEP — the subscription clock's enforcement arm. The panel has no
// account expiry, so nothing ends a lapsed subscription except this: every tick
// finds active accounts (paid AND trial) with expiresAt <= now and disables them
// panel-side. The work list is DERIVED from expiresAt each tick, so there is no
// queue and retry is free — an account that failed this tick is simply found
// again next tick. Batches are small and spaced (the panel admin API is a
// single-writer server; never burst it), and the first unreachable-panel error
// abandons the tick and doubles the interval (capped 15 min) until a call
// succeeds again.
//
// RECONCILE SWEEP — heals the divergence a crash or partial failure can leave
// between the panel and the local registry. Pages the panel's users under our
// global prefix and diffs. Rules (mutations only when RECONCILE_REPAIR=1;
// everything is ALWAYS reported):
//   - panel user under our prefix, unknown locally → DISABLE panel-side (never
//     delete — that would destroy the only copy of the evidence), report for
//     operator adoption/cleanup.
//   - local non-deleted account missing panel-side → report only: viewer
//     passwords are never stored here, so it cannot be recreated automatically.
//   - status divergence → THE LOCAL CLOCK WINS, both directions: desired panel
//     status is (local active AND unlapsed) ? active : disabled.
//   - maxDevices divergence → local wins.

import path from 'path'
import { readJsonFile, writeJsonFile } from './store.js'

export function makeSweeps (ctx) {
  const reportFile = path.join(ctx.dataDir, 'state', 'reconcile.json')
  const baseSweepMs = () => Math.max(1, ctx.config.sweepIntervalSec) * 1000
  const MAX_BACKOFF_MS = 15 * 60000

  let sweepTimer = null
  let reconcileTimer = null
  let stopped = false
  let backoffMs = 0
  let lastRunAt = null
  let lastResult = null
  let lastReconcile = readJsonFile(reportFile, null)

  // One lapsed account: panel first, local flip only on OK. Failures are
  // recorded on the account and retried next tick (derived work list).
  async function disableLapsed (acct, r) {
    try {
      await ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/status`, { status: 'disabled' })
      r.status = 'disabled'
      r.panel = { lastSyncAt: Date.now(), lastError: null }
      return true
    } catch (err) {
      r.panel = { lastSyncAt: Date.now(), lastError: String(err.message || err) }
      err.unreachable = err.code === 'panel-unreachable'
      throw err
    }
  }

  async function sweepNow () {
    const now = Date.now()
    const records = ctx.accounts.records()
    const due = Object.entries(records)
      .filter(([, r]) => r.status === 'active' && r.expiresAt <= now)
      .slice(0, 50)
    const result = { at: now, due: due.length, disabled: 0, errors: [] }
    for (const [acct, r] of due) {
      try {
        await ctx.mutex(() => disableLapsed(acct, r))
        result.disabled++
      } catch (err) {
        result.errors.push({ account: acct, error: String(err.message || err) })
        if (err.unreachable) break // the rest of the batch would fail identically
      }
      await new Promise((res) => setTimeout(res, 100))
    }
    if (due.length > 0) await ctx.mutex(() => ctx.accounts.save())
    // Backoff only on connectivity failure; any successful pass resets it.
    const unreachable = result.errors.some((e) => /unreachable/i.test(e.error))
    backoffMs = unreachable ? Math.min(backoffMs ? backoffMs * 2 : baseSweepMs() * 2, MAX_BACKOFF_MS) : 0
    lastRunAt = now
    lastResult = result
    return result
  }

  async function reconcileNow () {
    const repair = !!ctx.config.reconcileRepair
    const report = { ts: Date.now(), repair, checked: 0, orphanPanel: [], missingPanel: [], statusFixed: [], maxDevicesFixed: [], errors: [] }
    let panelUsers
    try {
      panelUsers = await ctx.panel.listAllUsers(ctx.config.globalPrefix + '.')
    } catch (err) {
      report.errors.push({ error: String(err.message || err) })
      lastReconcile = report
      writeJsonFile(reportFile, report)
      return report
    }
    const records = ctx.accounts.records()
    const byName = new Map(panelUsers.map((u) => [u.username, u]))
    report.checked = panelUsers.length

    for (const u of panelUsers) {
      const local = records[u.username]
      if (!local || local.status === 'deleted') {
        report.orphanPanel.push(u.username)
        if (repair && u.status !== 'disabled') {
          try {
            await ctx.mutex(() => ctx.panel.req('POST', `/api/users/${encodeURIComponent(u.username)}/status`, { status: 'disabled' }))
          } catch (err) {
            report.errors.push({ account: u.username, error: String(err.message || err) })
          }
        }
      }
    }

    for (const [acct, r] of Object.entries(records)) {
      if (r.status === 'deleted') continue
      const live = byName.get(acct)
      if (!live) {
        report.missingPanel.push(acct)
        continue
      }
      const desired = r.status === 'active' && r.expiresAt > Date.now() ? 'active' : 'disabled'
      if (live.status !== desired) {
        report.statusFixed.push({ account: acct, from: live.status, to: desired })
        if (repair) {
          try {
            await ctx.mutex(async () => {
              await ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/status`, { status: desired })
              r.panel = { lastSyncAt: Date.now(), lastError: null }
            })
          } catch (err) {
            report.errors.push({ account: acct, error: String(err.message || err) })
          }
        }
      }
      if (live.maxDevices !== r.maxDevices) {
        report.maxDevicesFixed.push({ account: acct, from: live.maxDevices, to: r.maxDevices })
        if (repair) {
          try {
            await ctx.mutex(() => ctx.panel.req('POST', `/api/users/${encodeURIComponent(acct)}/max-devices`, { maxDevices: r.maxDevices }))
          } catch (err) {
            report.errors.push({ account: acct, error: String(err.message || err) })
          }
        }
      }
    }
    if (repair) await ctx.mutex(() => ctx.accounts.save())
    lastReconcile = report
    writeJsonFile(reportFile, report)
    return report
  }

  function scheduleSweep () {
    if (stopped) return
    const delay = backoffMs || baseSweepMs()
    sweepTimer = setTimeout(async () => {
      try { await sweepNow() } catch (err) { console.error('[sweep] tick failed:', err.message || err) }
      scheduleSweep()
    }, delay)
    if (sweepTimer.unref) sweepTimer.unref()
  }

  function scheduleReconcile () {
    if (stopped || !(ctx.config.reconcileIntervalSec > 0)) return
    reconcileTimer = setTimeout(async () => {
      try { await reconcileNow() } catch (err) { console.error('[reconcile] tick failed:', err.message || err) }
      scheduleReconcile()
    }, ctx.config.reconcileIntervalSec * 1000)
    if (reconcileTimer.unref) reconcileTimer.unref()
  }

  function start () {
    // First expiry pass shortly after boot (catch up on downtime lapses), then
    // steady cadence.
    sweepTimer = setTimeout(async () => {
      try { await sweepNow() } catch (err) { console.error('[sweep] first pass failed:', err.message || err) }
      scheduleSweep()
    }, Math.min(10000, baseSweepMs()))
    if (sweepTimer.unref) sweepTimer.unref()
    scheduleReconcile()
  }

  function stop () {
    stopped = true
    if (sweepTimer) clearTimeout(sweepTimer)
    if (reconcileTimer) clearTimeout(reconcileTimer)
  }

  function healthInfo () {
    return { lastRunAt, backoffMs, lastResult: lastResult ? { due: lastResult.due, disabled: lastResult.disabled, errors: lastResult.errors.length } : null }
  }

  function lastReconcileSummary () {
    if (!lastReconcile) return null
    return {
      ts: lastReconcile.ts,
      repair: lastReconcile.repair,
      checked: lastReconcile.checked,
      orphanPanel: lastReconcile.orphanPanel.length,
      missingPanel: lastReconcile.missingPanel.length,
      statusFixed: lastReconcile.statusFixed.length,
      maxDevicesFixed: lastReconcile.maxDevicesFixed.length,
      errors: lastReconcile.errors.length
    }
  }

  return { start, stop, sweepNow, reconcileNow, healthInfo, lastReconcileSummary, lastReport: () => lastReconcile }
}
