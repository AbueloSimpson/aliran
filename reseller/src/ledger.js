// The credit ledger: an append-only JSON-Lines file, one transaction per line.
// This is the durable audit trail (the panel's activity ring is in-memory) AND the
// only place balances exist — a balance is always SUM(deltas) for a principal,
// derived from a boot scan and updated per append, never persisted. That kills the
// FireShare panel's two ledger bugs by construction: no per-user MAX+1 id races
// (one global monotonic seq, appends serialized by the service's single mutex) and
// no cached-balance over-spend (the check and the debit happen under that mutex
// against the live map).
//
// Line shape: { seq, ts, type, actor, entries:[{principal,delta}], account?,
// months?, coverageStart?, coverageEnd?, note? }
//   MINT     +N on target, from nothing (admin tiers; the credit source)
//   TRANSFER paired [-N parent, +N child] — downward allocation
//   RECLAIM  paired [-N child, +N parent] — pull-back, capped at child balance
//   ACTIVATE/RENEW  -months on the paying actor, carries account + coverage
//   REFUND   +months back on account delete
//   TRIAL    zero-value audit line — also the per-reseller daily-cap counter
//   ADJUST   ±N admin correction, note mandatory
//
// Crash tolerance: a torn FINAL line (killed mid-append) is truncated on boot with
// a warning; a parse failure anywhere else aborts startup — corruption gets looked
// at, not skipped.

import fs from 'fs'
import path from 'path'
import { ControlError } from './errors.js'

const TYPES = new Set(['MINT', 'TRANSFER', 'RECLAIM', 'ACTIVATE', 'RENEW', 'REFUND', 'TRIAL', 'ADJUST'])
const PAIRED = new Set(['TRANSFER', 'RECLAIM'])

export function openLedger (dataDir) {
  const file = path.join(dataDir, 'ledger', 'ledger.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const lines = []
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8')
    const parts = raw.split('\n').filter((l) => l.length > 0)
    for (let i = 0; i < parts.length; i++) {
      try {
        lines.push(JSON.parse(parts[i]))
      } catch {
        if (i === parts.length - 1) {
          console.warn(`[ledger] truncating torn final line (seq would be ${lines.length ? lines[lines.length - 1].seq + 1 : 1}) — crash mid-append`)
          fs.writeFileSync(file, parts.slice(0, -1).map((l) => l + '\n').join(''))
          break
        }
        throw new Error(`ledger corrupt at line ${i + 1} of ${parts.length} (${file}) — refusing to start; inspect the file`)
      }
    }
  }

  let nextSeq = lines.length ? lines[lines.length - 1].seq + 1 : 1
  const balances = new Map()
  const applyEntries = (map, tx) => {
    for (const e of tx.entries || []) map.set(e.principal, (map.get(e.principal) || 0) + e.delta)
  }
  for (const tx of lines) applyEntries(balances, tx)

  function balance (name) { return balances.get(name) || 0 }

  // Append one transaction. Validation is shape-level; BUSINESS rules (who may
  // mint, can the payer afford it) live in the callers, which run under the
  // service mutex so check-then-append can never interleave.
  function append (tx) {
    if (!TYPES.has(tx.type)) throw new ControlError('bad-request', `unknown ledger type: ${tx.type}`)
    if (!Array.isArray(tx.entries)) throw new ControlError('bad-request', 'ledger entries must be an array')
    for (const e of tx.entries) {
      if (typeof e.principal !== 'string' || !Number.isInteger(e.delta) || e.delta === 0) {
        throw new ControlError('bad-request', 'each ledger entry needs a principal and a non-zero integer delta')
      }
    }
    if (PAIRED.has(tx.type)) {
      const sum = tx.entries.reduce((a, e) => a + e.delta, 0)
      if (tx.entries.length !== 2 || sum !== 0) throw new ControlError('bad-request', `${tx.type} must be a zero-sum pair`)
    }
    if (tx.type === 'TRIAL' && tx.entries.length !== 0) throw new ControlError('bad-request', 'TRIAL lines carry no credit movement')
    if (tx.type === 'ADJUST' && (typeof tx.note !== 'string' || !tx.note.trim())) throw new ControlError('bad-request', 'ADJUST requires a note')
    const line = { seq: nextSeq, ts: Date.now(), ...tx }
    fs.appendFileSync(file, JSON.stringify(line) + '\n')
    nextSeq++
    lines.push(line)
    applyEntries(balances, line)
    return line
  }

  // Zero-value audit counter: trials a reseller has started in the current UTC day.
  function trialsToday (name) {
    const dayStart = new Date().setUTCHours(0, 0, 0, 0)
    let n = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const tx = lines[i]
      if (tx.ts < dayStart) break
      if (tx.type === 'TRIAL' && tx.actor === name) n++
    }
    return n
  }

  // Credits currently sitting in principal balances (what the admin has "issued
  // but not yet consumed").
  function totalOutstanding () {
    let sum = 0
    for (const v of balances.values()) if (v > 0) sum += v
    return sum
  }

  // Newest-first view with a seq cursor. `scope` is '*' or a Set of principal
  // names — a line is visible when its actor or any entry principal is in scope.
  function list ({ principal, account, type, before, limit } = {}, scope = '*') {
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50
    const out = []
    for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
      const tx = lines[i]
      if (before !== undefined && tx.seq >= before) continue
      if (type && tx.type !== type) continue
      if (principal && tx.actor !== principal && !(tx.entries || []).some((e) => e.principal === principal)) continue
      if (account && tx.account !== account) continue
      if (scope !== '*' && !scope.has(tx.actor) && !(tx.entries || []).some((e) => scope.has(e.principal))) continue
      out.push(tx)
    }
    return out
  }

  // Recompute-from-scratch equals the incremental map — the healthz invariant.
  function invariantOk () {
    const fresh = new Map()
    for (const tx of lines) applyEntries(fresh, tx)
    if (fresh.size !== balances.size) return false
    for (const [k, v] of fresh) if (balances.get(k) !== v) return false
    return true
  }

  function healthInfo () {
    return { seq: nextSeq - 1, entries: lines.length, invariantOk: invariantOk() }
  }

  return { file, append, balance, trialsToday, totalOutstanding, list, healthInfo }
}
