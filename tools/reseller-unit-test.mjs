// Reseller panel unit tests — pure logic, no network, no DHT: the role/capability
// map, the credit ledger (seq, torn tail, invariants, scoping), the store helpers,
// and principal-record validation. The end-to-end flow against a real panel lives
// in tools/e2e-reseller-test.mjs.
import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert'
import { CAPS, ROLES, can, inSubtree, canManage, accountScope, inAccountScope } from '../reseller/src/roles.js'
import { openLedger } from '../reseller/src/ledger.js'
import { makeMutex, readJsonFile, writeJsonFile } from '../reseller/src/store.js'
import { addPrincipal } from '../reseller/src/control-auth.js'

let failures = 0
const ok = (cond, msg) => { if (cond) { console.log('  ok  ', msg) } else { console.error('  FAIL', msg); failures++ } }
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
  ok(boss.root === true && boss.prefix === null, 'root admin seeded, no prefix')
  throws(() => addPrincipal(ctx, { username: 'b2', password: 'boss-pass-123', role: 'admin', root: true }), /root admin already exists/, 'second root refused')
  throws(() => addPrincipal(ctx, { username: 'x y', password: 'boss-pass-123', role: 'reseller', prefix: 'xy' }), /invalid principal name/, 'bad name rejected')
  throws(() => addPrincipal(ctx, { username: 'r1', password: 'short', role: 'reseller', prefix: 'r1' }), /at least 8/, 'short password rejected')
  throws(() => addPrincipal(ctx, { username: 'r1', password: 'res1-pass-123', role: 'reseller' }), /prefix required/, 'reseller without prefix rejected')
  throws(() => addPrincipal(ctx, { username: 'r1', password: 'res1-pass-123', role: 'reseller', prefix: 'R1' }), /prefix required/, 'uppercase prefix rejected')
  throws(() => addPrincipal(ctx, { username: 'c1', password: 'coad-pass-123', role: 'co-admin', prefix: 'c1' }), /does not take a prefix/, 'admin-tier prefix rejected')
  addPrincipal(ctx, { username: 'r1', password: 'res1-pass-123', role: 'reseller', prefix: 'r1', parent: 'boss' })
  throws(() => addPrincipal(ctx, { username: 'r2', password: 'res2-pass-123', role: 'reseller', prefix: 'r1', parent: 'boss' }), /already taken/, 'duplicate prefix rejected')
  throws(() => addPrincipal(ctx, { username: 'r1', password: 'res1-pass-123', role: 'reseller', prefix: 'zz' }), /already exists/, 'duplicate name rejected')
}

if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1) }
console.log('\nreseller-unit: ALL PASS')
