// Unit test for client/backend/reclaim-log.mjs — the rule that makes the hole-punch
// capability verdict observable on an ORDINARY build without turning logcat into a 3 s
// heartbeat. Pure functions, so this runs anywhere (no DHT, no store, no device).
//
// The second half is a SOURCE GATE, and it is the half that matters most: the module can
// stay perfectly correct while the two lines that call it are deleted, and the result is
// exactly the state this feature exists to end — a verdict computed, exposed, and printed
// by nobody. The engine end (sdk/serve.js status()) has its own coverage in
// tools/serve-reclaim-test.mjs; what is pinned here is the wire from it to a log line.
//
// Exits 0 on PASS.
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { reclaimVerdictLine, createReclaimVerdictLog } from '../client/backend/reclaim-log.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// EOL-normalised: this repo is developed on Windows with core.autocrlf, so a source gate
// that matched on '\n' would pass on CI and fail on the machine the change was written on.
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n')

// A reclaimStatus() as sdk/serve.js status() renders it (see the Reclaim class there).
function status (over = {}) {
  return {
    budgetBytes: 128 * 1024 * 1024,
    budgetActive: true,
    metaBudgetBytes: 64 * 1024 * 1024,
    metaBudgetActive: true,
    unmeasurable: false,
    punchTries: 1,
    punch: null,
    ...over
  }
}

// --- nothing to say -------------------------------------------------------------------
// Before the loopback server exists there is no handler; before a feed is SERVED there is
// no reclaim tick and so no verdict. Both are the normal state of a booting app, and
// neither may produce a line.
assert.strictEqual(reclaimVerdictLine(null), null, 'no handler yet -> nothing to print')
assert.strictEqual(reclaimVerdictLine(undefined), null)
assert.strictEqual(reclaimVerdictLine(status()), null, 'a status whose probe has not answered -> nothing to print')
assert.strictEqual(reclaimVerdictLine(status({ punch: null, punchTries: 0 })), null)

// --- the two verdicts that decide the disk story ---------------------------------------
// PROVED IT CAN PUNCH: clear() frees bytes, so the blob budget has latched OFF and the
// metadata budget (which no punch can help — the Hyperbee is not a blob) is the one bound
// left standing. This is the line that says "this device is fine".
{
  const line = reclaimVerdictLine(status({
    budgetActive: false,
    punch: { ok: true, canPunch: true, reason: 'measured', freed: 262144, wideFreed: 262144 }
  }))
  const v = JSON.parse(line)
  assert.strictEqual(v.ok, true)
  assert.strictEqual(v.canPunch, true, 'the verdict itself is on the line')
  assert.strictEqual(v.freed, 262144, 'and the bytes it measured — the number that PROVES it')
  assert.strictEqual(v.wideFreed, 262144, 'including the wide (> 4 GiB) stage')
  assert.strictEqual(v.budgetActive, false, 'so the blob rotation is off for this session')
  assert.strictEqual(v.metaBudgetActive, true, '…and the metadata rotation is what remains')
  assert.strictEqual(v.punchTries, 1, 'a measured verdict is never re-probed')
}

// PROVED IT CANNOT: the 32-bit ABI case this whole bound exists for. The budget stays armed.
{
  const v = JSON.parse(reclaimVerdictLine(status({
    punch: { ok: true, canPunch: false, reason: 'measured', freed: 0 }
  })))
  assert.strictEqual(v.canPunch, false)
  assert.strictEqual(v.freed, 0, 'zero freed is a MEASUREMENT and must survive to the line')
  assert.strictEqual(v.budgetActive, true, 'so the byte budget plus rotation is all this device has')
}

// ⚠ THE ADDON-WITH-THE-size_t-BUG CLASS, which is only visible in the two numbers TOGETHER:
// the small punch freed, the wide one did not. wideFreed: 0 is falsy and is exactly the
// evidence — a renderer that drops falsy fields would erase the distinction it exists for.
{
  const v = JSON.parse(reclaimVerdictLine(status({
    punch: { ok: true, canPunch: false, reason: 'wide-measured', freed: 262144, wideFreed: 0 }
  })))
  assert.strictEqual(v.freed, 262144)
  assert.strictEqual(v.wideFreed, 0, 'a wide punch that freed NOTHING is the whole finding')
}

// …while an ABSENT wideFreed stays absent rather than becoming null: the wide stage simply
// never ran, and "not measured" is a different claim from "measured zero".
{
  const v = JSON.parse(reclaimVerdictLine(status({
    punch: { ok: false, canPunch: false, reason: 'probe-timeout' }
  })))
  assert.ok(!('wideFreed' in v), 'a stage that never ran contributes no field')
  assert.ok(!('freed' in v), '…nor does a probe that never got as far as measuring')
  assert.strictEqual(v.ok, false, 'and the line says so: this is not a verdict, it is a shrug')
  assert.strictEqual(v.reason, 'probe-timeout', 'with the reason an operator reads')
}

// --- the dedupe: one line per CHANGE ---------------------------------------------------
// A hundred ticks of an unchanged verdict is one line. This is what makes it safe to ride a
// 3 s ticker in a shipping build.
{
  const note = createReclaimVerdictLog()
  const st = status({ budgetActive: false, punch: { ok: true, canPunch: true, reason: 'measured', freed: 262144, wideFreed: 262144 } })
  const first = note(st)
  assert.ok(first, 'the first verdict prints')
  for (let i = 0; i < 100; i++) assert.strictEqual(note(st), null, 'and never prints again on its own')
  // A DIFFERENT status object with the same content is still the same verdict.
  assert.strictEqual(note({ ...st, budgetBytes: 999 }), null,
    'fields the line does not carry cannot make it print — budgetBytes is configuration, not a verdict')
}

// Ticks BEFORE the probe answers cost nothing and do not arm anything.
{
  const note = createReclaimVerdictLog()
  for (let i = 0; i < 10; i++) assert.strictEqual(note(status()), null)
  assert.strictEqual(note(null), null, 'nor does a missing handler')
  assert.ok(note(status({ punch: { ok: true, canPunch: true, reason: 'measured', freed: 262144, wideFreed: 262144 } })),
    'and the first real verdict still prints after them')
}

// --- the transitions that MUST print ---------------------------------------------------
// ⚠ AN INCONCLUSIVE PROBE IS RETRIED (PROBE_MAX_TRIES, a reclaim tick apart), so the
// sequence is the diagnosis: three tries that kept timing out say something different from
// one that answered. Each retry must be its own line, or the log claims the probe ran once.
{
  const note = createReclaimVerdictLog()
  const seen = []
  const tick = (st) => { const l = note(st); if (l) seen.push(JSON.parse(l)) }
  const inconclusive = (tries) => status({ punchTries: tries, punch: { ok: false, canPunch: false, reason: 'probe-timeout' } })
  tick(inconclusive(1)); tick(inconclusive(1)) // one try, sampled twice by the ticker
  tick(inconclusive(2)); tick(inconclusive(2))
  tick(inconclusive(3)); tick(inconclusive(3))
  assert.strictEqual(seen.length, 3, 'one line per PROBE, not one per tick')
  assert.deepStrictEqual(seen.map((v) => v.punchTries), [1, 2, 3], 'and the count is on each of them')
  assert.ok(seen.every((v) => v.budgetActive === true),
    'an inconclusive probe fails ACTIVE — every one of those lines says the budget is still armed')

  // …and when a later try finally answers, that answer prints too, with the latch it set.
  tick(status({ punchTries: 3, budgetActive: false, punch: { ok: true, canPunch: true, reason: 'measured', freed: 262144, wideFreed: 262144 } }))
  assert.strictEqual(seen.length, 4)
  assert.strictEqual(seen[3].canPunch, true)
  assert.strictEqual(seen[3].budgetActive, false)
}

// A LATCH THAT FLIPS AFTER THE VERDICT is a change worth printing on its own: the verdict
// is only interesting for what it switches off, and 'unmeasurable' (the platform cannot
// report allocated bytes) kills the metadata bound the punch cannot help with.
{
  const note = createReclaimVerdictLog()
  const punch = { ok: true, canPunch: false, reason: 'measured', freed: 0 }
  assert.ok(note(status({ punch })), 'the verdict')
  const after = note(status({ punch, unmeasurable: true, budgetActive: false, metaBudgetActive: false }))
  assert.ok(after, 'and then the day both bounds went away')
  const v = JSON.parse(after)
  assert.strictEqual(v.unmeasurable, true)
  assert.strictEqual(v.budgetActive, false)
  assert.strictEqual(v.metaBudgetActive, false)
}

// Per-engine latches: a service switch builds a new engine whose handler probes from zero,
// and its verdict must not be swallowed as a duplicate of the previous engine's.
{
  const st = status({ punch: { ok: true, canPunch: true, reason: 'measured', freed: 262144, wideFreed: 262144 }, budgetActive: false })
  const a = createReclaimVerdictLog()
  const b = createReclaimVerdictLog()
  assert.ok(a(st))
  assert.strictEqual(a(st), null)
  assert.ok(b(st), 'a second engine prints its own verdict')
}

// --- source gate: the wire from the engine to the log ----------------------------------
// Everything above is dead code if nothing calls it, which is precisely how this ended up
// needing a one-off diagnostics APK the last time.
{
  // The shape this renderer reads is sdk/serve.js's, and a rename there would not break
  // anything loudly — it would quietly render `undefined` for the field that mattered and
  // still print a plausible line. tools/serve-reclaim-test.mjs asserts these fields BEHAVE;
  // this asserts the renderer and the producer still agree on their names.
  const serve = read('sdk/serve.js')
  const body = serve.slice(serve.indexOf('  status () {'))
  const statusBody = body.slice(0, body.indexOf('\n  }\n'))
  assert.ok(statusBody.length > 0 && statusBody.length < 2500, 'found sdk/serve.js status()')
  for (const field of ['punchTries', 'budgetActive', 'metaBudgetActive', 'unmeasurable']) {
    assert.ok(new RegExp('\\n\\s*' + field + ':').test(statusBody), `serve.js status() still reports ${field}`)
  }
  // The fixtures above use the probe's REAL reason strings, and the example line in
  // docs/kb/playback.md prints one of them. 'measured' is what a stage that got as far as
  // comparing two allocation readings says (either verdict); 'wide-measured' is the wide
  // stage refusing after the small punch passed — the truncated-punch addon's signature.
  assert.ok(/reason: 'measured'/.test(serve), "sdk/serve.js still answers a measured verdict with reason 'measured'")
  assert.ok(/reason: 'wide-measured'/.test(serve), "…and a wide refusal with reason 'wide-measured'")
  for (const field of ['ok', 'canPunch', 'reason', 'freed', 'wideFreed']) {
    assert.ok(new RegExp('punch:[\\s\\S]*?\\b' + field + ': this\\._punch\\.' + field).test(statusBody),
      `…and the punch verdict still carries ${field}`)
  }

  const player = read('sdk/player.js')
  assert.ok(/^ {2}reclaimStatus \(\) \{$/m.test(player),
    'sdk/player.js exposes reclaimStatus() — the public end of the serving core\'s verdict')
  assert.ok(/reclaimStatus \(\) \{\s*\n\s*if \(!this\._server \|\| !this\._handler \|\| !this\._handler\.reclaimStatus\) return null/.test(player),
    '…reading the LOOPBACK handler\'s status, and answering null both before that handler exists ' +
    'and after stop() — which drops _server but deliberately KEEPS _handler, so a handler-only ' +
    'guard would report a stopped engine\'s stale verdict for ever')

  // ⚠ THE SAMPLING CONTRACT ITSELF, in the engine. The 3 s ticker this feature rides returns
  // early when no feed drive is served, and that one line is what makes "the log prints only
  // while a probe could have run" true — it is ALSO the crash guard for the four paths that
  // null _feedDrive under a live timer (a redirect zap, a rotation, two evictions), so its
  // behaviour is asserted for real in the disk-rotation lane of tools/e2e-sdk-test.mjs. This
  // gate is the cheap half: it fails in a second if the line is deleted, without a testnet.
  assert.ok(/this\._statusTimer = setInterval\(\(\) => \{\s*\n\s*if \(!this\._feedDrive\) return\s*\n\s*const n = this\._feedDrive\.core\.peers\.length/.test(player),
    "sdk/player.js's 3 s status ticker still SKIPS when no feed is served — without that, 'peers' " +
    'no longer means "a feed is being served" (so the verdict log samples windows the probe cannot ' +
    'run in) and the tick throws a TypeError out of a setInterval on every path that nulls _feedDrive')

  const worklet = read('client/backend/backend.mjs')
  assert.ok(/import \{ createReclaimVerdictLog \} from '\.\/reclaim-log\.mjs'/.test(worklet),
    'the worklet imports the verdict log')
  assert.ok(/const noteReclaimVerdict = createReclaimVerdictLog\(\)/.test(worklet),
    '…builds one per engine (inside ensurePlayer, beside the other listeners)')
  // The ticker it rides is load-bearing: the probe runs only from a reclaim tick, a reclaim
  // tick happens only while a feed is being served, and 'peers' fires exactly then. A move
  // to any other event has to re-argue that, so pin the pairing.
  assert.ok(/player\.on\('peers', \(\) => \{[\s\S]{0,400}?noteReclaimVerdict\(p\.reclaimStatus\(\)\)/.test(worklet),
    '…and samples it on the peers ticker, the one event that fires exactly while a feed is served')
  assert.ok(/console\.log\('\[reclaim\]', line\)/.test(worklet),
    '…printing the line to the app-process stdout tag, where logcat can grep it')
}

console.log('RESULT: PASS ✅  (reclaim-log: verdict rendering, absent-vs-zero fields, one line per change, retry + latch transitions, engine wiring, ticker guard)')
