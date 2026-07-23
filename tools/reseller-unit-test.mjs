// Reseller panel unit tests — pure logic, no network, no DHT: the role/capability
// map, the credit ledger (seq, torn tail, invariants, scoping), the store helpers,
// and principal-record validation. The end-to-end flow against a real panel lives
// in tools/e2e-reseller-test.mjs.
import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert'
import { CAPS, ROLES, can, inSubtree, canManage, accountScope, inAccountScope, effectiveMaxDevices } from '../reseller/src/roles.js'
import { openLedger } from '../reseller/src/ledger.js'
import { makeMutex, readJsonFile, writeJsonFile } from '../reseller/src/store.js'
import { addPrincipal } from '../reseller/src/control-auth.js'
import { makeAccounts } from '../reseller/src/accounts.js'

let failures = 0
const ok = (cond, msg) => { if (cond) { console.log('  ok  ', msg) } else { console.error('  FAIL', msg); failures++ } }
// Silent variant for per-item checks inside big loops (logs only failures).
const ok2 = (cond) => { if (!cond) { console.error('  FAIL (loop item)'); failures++ } }
const throws = (fn, re, msg) => {
  try { fn(); ok(false, msg + ' (no throw)') } catch (e) { ok(re.test(e.message || ''), `${msg} (${e.message})`) }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reseller-unit-'))

// ---- A. roles / capability map ----
console.log('A. roles')
{
  ok(Object.values(CAPS).every((d) => d.roles.every((r) => ROLES.includes(r))), 'CAPS lists only known roles')
  const root = { name: 'boss', role: 'admin', root: true }
  const co = { name: 'dep', role: 'co-admin', root: false }
  const sup = { name: 'sup1', role: 'super', root: false }
  const rsl = { name: 'res1', role: 'reseller', root: false }
  ok(can(root, 'principal:create:co-admin') && !can(co, 'principal:create:co-admin'), 'co-admin creation is rootOnly')
  ok(can(co, 'credits:mint') && !can(sup, 'credits:mint') && !can(rsl, 'credits:mint'), 'mint = admin tiers only')
  ok(can(sup, 'credits:transfer') && !can(rsl, 'credits:transfer'), 'transfer excludes resellers')
  ok(can(rsl, 'accounts:manage') && can(rsl, 'trials:create'), 'resellers hold account caps')
  ok(!can(rsl, 'ops:sweep') && !can(sup, 'ops:reconcile'), 'ops caps are admin-tier')

  const P = {
    boss: { role: 'admin', root: true, parent: null },
    dep: { role: 'co-admin', parent: 'boss' },
    dep2: { role: 'co-admin', parent: 'boss' },
    sup1: { role: 'super', parent: 'dep' },
    res1: { role: 'reseller', parent: 'sup1' },
    res2: { role: 'reseller', parent: 'boss' }
  }
  ok(inSubtree(P, 'sup1', 'res1') && !inSubtree(P, 'sup1', 'res2'), 'inSubtree walks the parent chain')
  ok(inSubtree(P, 'res1', 'res1'), 'a principal is in its own subtree')
  const CYC = { a: { parent: 'b' }, b: { parent: 'a' } }
  ok(!inSubtree(CYC, 'x', 'a'), 'parent cycle terminates (guarded)')

  const actorSup = { name: 'sup1', ...P.sup1 }
  const actorCo = { name: 'dep', ...P.dep }
  const actorRoot = { name: 'boss', ...P.boss }
  ok(canManage(P, actorSup, 'res1') && !canManage(P, actorSup, 'res2'), 'super manages own subtree only')
  ok(!canManage(P, actorSup, 'sup1'), 'super does not manage itself (self-service is /api/me)')
  ok(!canManage(P, actorCo, 'dep2') && canManage(P, actorRoot, 'dep2'), 'co-admins are root-only territory')
  ok(!canManage(P, actorCo, 'boss') && !canManage(P, actorRoot, 'boss'), 'nobody manages the root')

  const scope = accountScope(P, actorSup)
  ok(scope instanceof Set && scope.has('sup1') && scope.has('res1') && !scope.has('res2'), 'accountScope = self + descendants')
  ok(accountScope(P, actorCo) === '*', 'admin tiers scope everything')
  ok(inAccountScope('*', 'anyone') && inAccountScope(scope, 'res1') && !inAccountScope(scope, 'res2'), 'inAccountScope')

  // Device policy: admin-set + inherited (user decision 2026-07-23).
  ok(!can(sup, 'principal:limits:devices') && can(co, 'principal:limits:devices'), 'device policy is admin-tier only')
  const D = {
    boss: { parent: null, maxDevicesLimit: null },
    sup1: { parent: 'boss', maxDevicesLimit: 2 },
    res1: { parent: 'sup1', maxDevicesLimit: null },
    res2: { parent: 'boss', maxDevicesLimit: null }
  }
  ok(effectiveMaxDevices(D, 'sup1', 3) === 2, 'explicit value wins')
  ok(effectiveMaxDevices(D, 'res1', 3) === 2, 'null inherits the nearest ancestor')
  ok(effectiveMaxDevices(D, 'res2', 3) === 3, 'no explicit anywhere → configured fallback')
  ok(effectiveMaxDevices(D, 'ghost', 3) === 3, 'unknown principal → fallback')
  ok(effectiveMaxDevices({ a: { parent: 'b', maxDevicesLimit: null }, b: { parent: 'a', maxDevicesLimit: null } }, 'a', 7) === 7, 'parent cycle terminates → fallback')
}

// ---- B. ledger ----
console.log('B. ledger')
{
  const dir = tmp()
  const l = openLedger(dir)
  const a = l.append({ type: 'MINT', actor: 'boss', entries: [{ principal: 'sup1', delta: 10 }], note: '' })
  const b = l.append({ type: 'TRANSFER', actor: 'sup1', entries: [{ principal: 'sup1', delta: -6 }, { principal: 'res1', delta: 6 }] })
  ok(a.seq === 1 && b.seq === 2, 'seq is globally monotonic from 1')
  ok(l.balance('sup1') === 4 && l.balance('res1') === 6 && l.balance('ghost') === 0, 'balances derive from entries')
  throws(() => l.append({ type: 'TRANSFER', actor: 'x', entries: [{ principal: 'a', delta: -2 }, { principal: 'b', delta: 3 }] }), /zero-sum/, 'unbalanced TRANSFER rejected')
  throws(() => l.append({ type: 'ADJUST', actor: 'boss', entries: [{ principal: 'res1', delta: 1 }] }), /note/, 'ADJUST requires a note')
  throws(() => l.append({ type: 'TRIAL', actor: 'res1', entries: [{ principal: 'res1', delta: 1 }] }), /no credit movement/, 'TRIAL carries no deltas')
  throws(() => l.append({ type: 'BOGUS', actor: 'x', entries: [] }), /unknown ledger type/, 'unknown type rejected')
  l.append({ type: 'TRIAL', actor: 'res1', entries: [] })
  ok(l.trialsToday('res1') === 1 && l.trialsToday('res2') === 0, 'trialsToday counts per actor')
  ok(l.totalOutstanding() === 10, 'totalOutstanding sums positive balances')
  ok(l.healthInfo().invariantOk, 'invariant holds')

  // Reopen re-derives identical state.
  const l2 = openLedger(dir)
  ok(l2.balance('sup1') === 4 && l2.balance('res1') === 6 && l2.healthInfo().seq === 3, 'reopen re-derives balances + seq')

  // Torn FINAL line is truncated with a warning; the ledger stays usable.
  const file = path.join(dir, 'ledger', 'ledger.jsonl')
  fs.appendFileSync(file, '{"seq":4,"ts":1,"type":"MINT","actor":"boss","entr')
  const l3 = openLedger(dir)
  ok(l3.healthInfo().seq === 3 && l3.balance('sup1') === 4, 'torn tail truncated, state intact')
  const l3b = openLedger(dir)
  ok(l3b.healthInfo().entries === 3, 'file actually rewritten without the torn line')

  // Corruption ANYWHERE else aborts.
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  lines[0] = '{corrupt'
  fs.writeFileSync(file, lines.join('\n') + '\n')
  throws(() => openLedger(dir), /corrupt at line 1/, 'mid-file corruption refuses startup')

  // Scoped listing + cursor.
  const dir2 = tmp()
  const m = openLedger(dir2)
  for (let i = 0; i < 5; i++) m.append({ type: 'MINT', actor: 'boss', entries: [{ principal: i % 2 ? 'a' : 'b', delta: 1 }], note: '' })
  ok(m.list({ limit: 2 })[0].seq === 5, 'list is newest-first')
  ok(m.list({ before: 3 }).length === 2, 'before-cursor pages older lines')
  const scoped = m.list({}, new Set(['a']))
  ok(scoped.length === 2 && scoped.every((tx) => tx.entries[0].principal === 'a'), 'scope filtering hides other principals')
}

// ---- C. store helpers ----
console.log('C. store')
{
  const dir = tmp()
  const f = path.join(dir, 'nested', 'x.json')
  writeJsonFile(f, { a: 1 })
  ok(readJsonFile(f, null).a === 1, 'atomic write + read-back')
  ok(readJsonFile(path.join(dir, 'missing.json'), 'fb') === 'fb', 'readJsonFile fallback')
  ok(!fs.existsSync(f + '.tmp'), 'no tmp file left behind')

  const mutex = makeMutex()
  const order = []
  await Promise.all([
    mutex(async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1) }),
    mutex(async () => { order.push(2) }),
    mutex(async () => { order.push(3) }).then(() => order.push('done'))
  ])
  ok(order.join(',') === '1,2,3,done', `mutex serializes in order (${order.join(',')})`)
  // A rejection must not break the chain.
  await mutex(() => { throw new Error('boom') }).catch(() => {})
  const after = await mutex(() => 'alive')
  ok(after === 'alive', 'mutex survives a rejected job')
}

// ---- D. principal validation ----
console.log('D. principal validation')
{
  const dir = tmp()
  const ctx = { dataDir: dir, config: { argon2: { memKiB: 8192, time: 1 }, maxDevicesLimitDefault: 3, trialDailyCapDefault: 3 } }
  const boss = addPrincipal(ctx, { username: 'boss', password: 'boss-pass-123', role: 'admin', root: true })
  ok(boss.root === true, 'root admin seeded')
  throws(() => addPrincipal(ctx, { username: 'b2', password: 'boss-pass-123', role: 'admin', root: true }), /root admin already exists/, 'second root refused')
  throws(() => addPrincipal(ctx, { username: 'x y', password: 'boss-pass-123', role: 'reseller' }), /invalid principal name/, 'bad name rejected')
  throws(() => addPrincipal(ctx, { username: 'r1', password: 'short', role: 'reseller' }), /at least 8/, 'short password rejected')
  throws(() => addPrincipal(ctx, { username: 'r1', password: 'res1-pass-123', role: 'bogus' }), /invalid role/, 'unknown role rejected')
  addPrincipal(ctx, { username: 'r1', password: 'res1-pass-123', role: 'reseller', parent: 'boss' })
  throws(() => addPrincipal(ctx, { username: 'r1', password: 'res1-pass-123', role: 'reseller' }), /already exists/, 'duplicate name rejected')
}

// ---- E. accounts list() — the high-density query engine ----
console.log('E. accounts query engine (synthetic 5k registry)')
{
  const dir = tmp()
  const now = Date.now()
  const day = 86400000
  const registry = {}
  const owners = ['res1', 'res2', 'sup1']
  for (let i = 0; i < 5000; i++) {
    registry[`acct${String(i).padStart(4, '0')}`] = {
      owner: owners[i % 3],
      kind: i % 10 === 0 ? 'trial' : 'paid',
      status: i % 7 === 0 ? 'disabled' : i % 11 === 0 ? 'deleted' : 'active',
      expiresAt: now + ((i % 40) - 5) * day, // some lapsed, some expiring, some far out
      maxDevices: 1 + (i % 3),
      extraGrants: [],
      createdAt: now - (i % 90) * day, // varied ages for the created sort
      createdBy: owners[i % 3],
      panel: { lastSyncAt: now, lastError: null }
    }
  }
  registry['zebra-special'] = { owner: 'findme-owner', kind: 'paid', status: 'active', expiresAt: now + 90 * day, maxDevices: 1, extraGrants: [], createdAt: now, createdBy: 'findme-owner', panel: {} }
  writeJsonFile(path.join(dir, 'accounts.json'), registry)
  const accounts = makeAccounts({ dataDir: dir, config: { daysPerMonth: 31 } })

  const live = Object.values(registry).filter((r) => r.status !== 'deleted')
  const r0 = accounts.list()
  ok(r0.items && Number.isInteger(r0.total) && r0.offset === 0 && r0.limit === 50, 'envelope shape {items,total,offset,limit}')
  ok(r0.total === live.length && r0.items.length === 50, `total counts non-deleted (${r0.total}), default page = 50`)

  ok(accounts.list({ q: 'ZEBRA' }).items[0].account === 'zebra-special', 'ci-search matches account name')
  ok(accounts.list({ q: 'FINDME' }).items[0].account === 'zebra-special', 'ci-search matches OWNER too')

  const count = (pred) => live.filter(pred).length
  ok(accounts.list({ filter: 'trial' }).total === count((r) => r.kind === 'trial'), 'trial filter total')
  ok(accounts.list({ filter: 'disabled' }).total === count((r) => r.status === 'disabled'), 'disabled filter total')
  ok(accounts.list({ filter: 'active' }).total === count((r) => r.status === 'active'), 'active filter total')
  ok(accounts.list({ filter: 'expiring' }).total === count((r) => r.status === 'active' && r.expiresAt <= now + 7 * day), 'expiring filter total (7d window)')
  ok(accounts.list({ owner: 'res2' }).total === count((r) => r.owner === 'res2'), 'owner param total')

  const asc = accounts.list({ sort: 'expires', dir: 'asc', limit: 500 }).items
  ok(asc.every((v, i) => i === 0 || asc[i - 1].expiresAt <= v.expiresAt), 'expires asc ordered')
  const desc = accounts.list({ sort: 'expires', dir: 'desc' }).items
  ok(desc[0].expiresAt >= asc[0].expiresAt && desc.every((v, i) => i === 0 || desc[i - 1].expiresAt >= v.expiresAt), 'expires desc ordered')
  const byOwner = accounts.list({ sort: 'owner', limit: 500 }).items
  ok(byOwner.every((v, i) => i === 0 || byOwner[i - 1].owner <= v.owner), 'owner sort groups')
  const byCreated = accounts.list({ sort: 'created', dir: 'desc', limit: 500 }).items
  ok(byCreated.every((v, i) => i === 0 || byCreated[i - 1].createdAt >= v.createdAt), 'created desc = newest first')
  const byStatus = accounts.list({ sort: 'status', limit: 500 }).items
  ok(byStatus[0].status === 'active' && byStatus.every((v, i) => i === 0 || byStatus[i - 1].status <= v.status), 'status asc = active first')
  const byStatusD = accounts.list({ sort: 'status', dir: 'desc' }).items
  ok(byStatusD[0].status === 'disabled', 'status desc = inactive first')

  // Offset walk covers the whole filtered set exactly once.
  const seen = new Set()
  for (let off = 0; off < r0.total; off += 500) {
    for (const it of accounts.list({ offset: off, limit: 500 }).items) {
      ok2(!seen.has(it.account))
      seen.add(it.account)
    }
  }
  ok(seen.size === r0.total, `offset walk = whole set once (${seen.size})`)

  ok(accounts.list({ limit: 9999 }).limit === 500, 'limit capped at 500')
  throws(() => accounts.list({ filter: 'bogus' }), /filter must be/, 'junk filter rejected')
  throws(() => accounts.list({ sort: 'bogus' }), /sort must be/, 'junk sort rejected')
  throws(() => accounts.list({ dir: 'sideways' }), /dir must be/, 'junk dir rejected')

  const scoped = accounts.list({ limit: 500 }, new Set(['res1']))
  ok(scoped.total === count((r) => r.owner === 'res1') && scoped.items.every((it) => it.owner === 'res1'), 'scope restricts to owner set')
}

if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1) }
console.log('\nreseller-unit: ALL PASS')
