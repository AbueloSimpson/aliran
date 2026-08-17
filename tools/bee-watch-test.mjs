// Unit lane for core/bee-watch.js — the fork-surviving Hyperbee range watch.
//
// WHY THIS EXISTS SEPARATELY FROM THE FORK E2E. tools/e2e-panel-compact-client-test.mjs proves
// the property that matters operationally (a warm SDK viewer keeps its live lineup across a
// panel bee compaction), but it needs a DHT testnet, a login and a mini-broadcaster, and it
// takes minutes. The defect it caught is a four-line race in a loop, so it also deserves a lane
// that runs in seconds and can be run a hundred times while changing that loop.
//
// No DHT, no swarm: a writer core and a replica core wired by a direct duplex pair. The fork is
// produced by truncating the writer back to a length at which the bee was VALID and bumping the
// fork — which is what a shadow rebuild installed at fork+1 looks like to a replica: the log
// gets shorter and the fork number goes up.
//
// THE THREE PROPERTIES, and why each one is its own lane:
//
//   L1  survives a fork at all. This is the headline defect: hyperbee's Watcher either throws
//       SNAPSHOT_NOT_AVAILABLE or parks silently for ever, and its own apparent fork guard
//       cannot fire (hypercore reads `fork` live off the shared core, so the two snapshots
//       always agree). A `while (!closed)` wrapper repairs only the throwing face.
//   L2  survives a fork whose truncate lands while onChange is STUCK. The re-arm lives in the
//       same loop that awaits onChange, so a callback parked on an unbounded bee.get would
//       hold the re-arm behind it — the same permanent deafness, one layer up. This lane
//       parks onChange for ever on purpose; a watch that needs it to return cannot pass.
//   L3  a re-arm CATCHES UP. A fresh watcher's baseline snapshot is taken when it is armed, so
//       a change that lands between the truncate and the re-arm is already "current" to it and
//       is never reported. Missing this is invisible in L1, which changes a record after the
//       dust settles.
//
// Exits 0 only if every lane passed.
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import os from 'os'; import fs from 'fs'; import path from 'path'
import { watchRange } from '../core/bee-watch.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { if (await fn()) return true } catch {} await sleep(20) }
  throw new Error('TIMEOUT after ' + ms + 'ms: ' + label)
}
function must (cond, msg) { if (!cond) throw new Error(typeof msg === 'function' ? msg() : msg) }

const CHURN = 200 // enough that the post-fork log is far SHORTER than the pre-fork one, which
const PAD = 1024 //  is the condition that makes hyperbee's watcher park rather than throw

const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } }

// One writer + one replica, churned and replicated, ready to be forked.
async function makePair () {
  const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), 'bw-w-')), fs.mkdtempSync(path.join(os.tmpdir(), 'bw-r-'))]
  const wStore = new Corestore(dirs[0]); await wStore.ready()
  const rStore = new Corestore(dirs[1]); await rStore.ready()
  const wCore = wStore.get({ name: 'bee' }); await wCore.ready()
  const wBee = new Hyperbee(wCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await wBee.ready()
  for (let i = 0; i < 20; i++) await wBee.put('catalog/ch' + i, { title: 'ch' + i })
  const goodLength = wCore.length // the bee is VALID here; the fork below returns the log to it

  const rCore = rStore.get({ key: wCore.key }); await rCore.ready()
  const rBee = new Hyperbee(rCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await rBee.ready()
  const s1 = wStore.replicate(true); const s2 = rStore.replicate(false)
  s1.pipe(s2).pipe(s1)
  await waitFor(async () => rCore.length === wCore.length, 15000, 'initial replication')

  // Churn, the shape of the production growth driver: one fat record rewritten over and over.
  for (let i = 0; i < CHURN; i++) await wBee.put('user/alice', { pad: 'x'.repeat(PAD) + i })
  await waitFor(async () => rCore.length === wCore.length, 15000, 'churn replicated')

  const pair = { wBee, rBee, wCore, rCore, goodLength }
  cleanups.push(async () => {
    try { s1.destroy() } catch {} ; try { s2.destroy() } catch {}
    try { await wStore.close() } catch {} ; try { await rStore.close() } catch {}
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  })
  return pair
}

// Truncate the writer back to a length at which the bee was VALID, bumping the fork. That is
// what a shadow rebuild installed at fork+1 looks like to a replica: a shorter log and a
// higher fork number. Nothing may write while the truncate is in flight — it deadlocks on the
// core's own lock — so callers put after this returns.
async function fork (p) {
  const before = p.wCore.length
  await p.wCore.truncate(p.goodLength, 1)
  await waitFor(async () => p.rCore.fork === 1 && p.rCore.length >= p.goodLength, 20000, 'the replica reorged onto fork 1')
  return before
}

const lanes = []
async function runLane (n, name, fn) {
  const rec = { n, name, ok: null, note: '' }
  lanes.push(rec)
  try { rec.note = (await fn()) || ''; rec.ok = true; log(`  PASS  L${n} ${name}` + (rec.note ? '\n        ' + rec.note : '')) } catch (err) {
    rec.ok = false; rec.note = String(err.message)
    log(`  FAIL  L${n} ${name}\n        ` + String(err.message).split('\n').join('\n        '))
  }
}

try {
  log('=== bee-watch: does a Hyperbee range watch survive a fork? ===\n')

  await runLane(1, 'a range watch keeps delivering across a fork', async () => {
    const p = await makePair()
    const seen = []
    const h = watchRange(p.rBee, { gt: 'catalog/', lt: 'catalog0' }, async () => {
      seen.push((await p.rBee.get('catalog/ch7'))?.value?.title || null)
    })
    await p.wBee.put('catalog/ch7', { title: 'pre' })
    await waitFor(async () => seen.includes('pre'), 15000, 'the PRE-fork control tick (without it the lane proves nothing)')
    const before = await fork(p)
    // Several, with pauses: one delivered change could be a resync rather than a live watcher.
    for (let k = 0; k < 3; k++) {
      await p.wBee.put('catalog/ch7', { title: 'post' + k })
      await waitFor(async () => seen.includes('post' + k), 15000,
        `post-fork change #${k} was never delivered — the watch is deaf after the fork (log went ${before} -> ${p.rCore.length} blocks)`)
      await sleep(150)
    }
    await h.close()
    return `${before} -> ${p.rCore.length} blocks at fork ${p.rCore.fork}; 3 post-fork changes all delivered`
  })

  await runLane(2, 'the re-arm does not wait for a STUCK onChange', async () => {
    const p = await makePair()
    const seen = []
    let stuck = 0
    const h = watchRange(p.rBee, { gt: 'catalog/', lt: 'catalog0' }, async () => {
      // The first tick never returns — an unbounded bee.get for a block the rebuilt log will
      // not contain behaves exactly like this. A loop that awaits it cannot re-arm.
      if (stuck === 0) { stuck = 1; await new Promise(() => {}) }
      seen.push((await p.rBee.get('catalog/ch7'))?.value?.title || null)
    })
    await p.wBee.put('catalog/ch7', { title: 'pre' })
    await waitFor(async () => stuck === 1, 15000, 'the first tick must have started and parked')
    await fork(p)
    await p.wBee.put('catalog/ch7', { title: 'after-stuck' })
    await waitFor(async () => seen.includes('after-stuck'), 15000,
      'the watch never recovered from a fork that landed while onChange was parked. The stuck call is still ' +
      'parked (by design — it is unbounded), so a re-arm that waits for it is deaf for the life of the process.')
    await h.close()
    return 'a fork landing on a permanently parked onChange still re-armed and delivered the next change'
  })

  // The catch-up exists because a re-armed watcher takes its baseline snapshot when it is
  // ARMED: anything that landed between the truncate and the re-arm is already "current" to
  // it and would never be reported. That window cannot be opened on demand from outside the
  // module — whether a given write lands inside it is a replication race — so this lane
  // asserts the CONTRACT that closes it instead of trying to lose the race on purpose: the
  // catch-up callback runs once per arm, with no write to prompt it.
  await runLane(3, 'every arm runs the catch-up, and it is onResync that runs (not onChange)', async () => {
    const p = await makePair()
    let changes = 0
    let resyncs = 0
    const h = watchRange(p.rBee, { gt: 'catalog/', lt: 'catalog0' },
      async () => { changes++ },
      { catchUp: true, onResync: async () => { resyncs++ } })
    // Nothing has been written, so a tick cannot explain this one: only `catchUp` can.
    await waitFor(async () => resyncs === 1, 15000,
      'catchUp:true did not run the catch-up after the first arm. Every arming point has a blind window behind it ' +
      '(a purge rebuilds the replica, a backgrounded phone misses appends) and the catch-up is what closes it.')
    must(changes === 0, `onChange ran ${changes} time(s) for a catch-up. The two are separable precisely because ` +
      'they are not the same work: sdk/player.js catches up OUTSIDE its recovery wrapper on purpose.')
    const atFork = resyncs
    await fork(p)
    await waitFor(async () => resyncs > atFork, 15000,
      'the re-arm after a fork did not catch up. The fresh watcher\'s baseline is the bee AS IT IS when armed, so ' +
      'anything that landed during the reorg is invisible to it for ever unless the re-arm re-reads the range.')
    must(changes === 0, `onChange ran ${changes} time(s) across a fork with no write — the re-arm must route ` +
      'through onResync, or the grant watch would recover through _recover() and could spin purge -> arm -> fail.')
    await h.close()
    return `catch-up ran on the first arm and again after the fork (${resyncs} total), and never through onChange`
  })

  await runLane(4, 'close() stops the watch (no re-arm afterwards)', async () => {
    const p = await makePair()
    let ticks = 0
    const h = watchRange(p.rBee, { gt: 'catalog/', lt: 'catalog0' }, async () => { ticks++ })
    await p.wBee.put('catalog/ch7', { title: 'pre' })
    await waitFor(async () => ticks > 0, 15000, 'a tick before close')
    await h.close()
    const after = ticks
    await fork(p) // a truncate AFTER close must not resurrect the loop
    await p.wBee.put('catalog/ch7', { title: 'post' })
    await sleep(1500)
    must(ticks === after, `the watch kept ticking after close(): ${ticks - after} tick(s), including across a fork. ` +
      'A closed handle that re-arms on truncate would keep a torn-down engine reading a bee it no longer owns.')
    await h.close() // idempotent
    return `silent after close(), across a fork and a further change (${after} tick(s) before close)`
  })

  log('')
  for (const l of lanes) log(`  ${l.ok ? 'PASS' : 'FAIL'}  L${l.n}  ${l.name}`)
  const failed = lanes.filter((l) => !l.ok)
  await cleanup()
  if (failed.length) { log('\nRESULT: FAIL  (' + failed.length + ' of ' + lanes.length + ' lanes)'); process.exit(1) }
  log('\nRESULT: PASS ✅  (a Hyperbee range watch survives a fork, re-arms without waiting for a stuck callback, ' +
    'catches up on the reorg window, and stays stopped once closed)')
  process.exit(0)
} catch (err) {
  log('\nRESULT: FAIL  (harness error — no verdict on the lanes)')
  log('ERROR:', err.stack || err.message)
  await cleanup()
  process.exit(1)
}
