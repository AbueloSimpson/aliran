// Desktop parental controls (device-local PIN + the restricted-channel visibility rule) —
// pure unit tests, no Electron, no network. The twin of client/src/parental.ts, whose jest
// suite is client/__tests__/ParentalControls.test.tsx; the desktop renderer has no jest
// harness (tsc + the esbuild bundle are its checks), which is why this lives here — the
// same reason tools/desktop-vod-test.mjs does.
//
// This matters because the flag is LIVE: a channel marked `restricted` in the panel is
// hidden from viewers by these two functions and nothing else. Verified by hand once
// (2026-07-30, against production: 366 streams in, 365 rendered, the restricted one gated
// behind the PIN) — this lane is the regression guard that keeps it that way.
//
// What it pins:
//   1. the two SHARED rule functions are byte-identical across the phone and desktop
//      copies, so a channel hidden on one is hidden on the other (the storage layers
//      DIFFER by design — RN keeps the digest in the worklet prefs file, desktop in
//      localStorage — so only these two functions can be compared);
//   2. visibleStreams: no PIN hides restricted channels, a PIN reveals them, and the
//      hide toggle folds them away again;
//   3. needsPin: only a restricted channel, only with a PIN, only while locked;
//   4. one unlock covers the session, and clearing the PIN re-locks it;
//   5. the digest round-trips — the right PIN verifies, a wrong one does not — and the
//      stored record never contains the PIN itself;
//   6. FAIL-CLOSED: absent or corrupt storage reads as "no PIN", which HIDES restricted
//      channels rather than exposing them.
//
// Run: node tools/desktop-parental-test.mjs   (npm run test:desktop-parental)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { console.error('  FAIL', msg); failures++ } }
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)

const DESKTOP_SRC = 'desktop/renderer/src/parental.ts'
const PHONE_SRC = 'client/src/parental.ts'

// ---------------------------------------------------------------- lane A: the twins
// Only the two functions that carry the RULES; everything around them is storage, which
// legitimately differs between the two runtimes.
function ruleSource (rel) {
  const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n')
  const grab = (name) => {
    const m = src.match(new RegExp(`export function ${name}\\s*\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}`, 'm'))
    if (!m) throw new Error(`${rel}: could not find ${name}`)
    return m[0].split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').trim()
  }
  return { visibleStreams: grab('visibleStreams'), needsPin: grab('needsPin') }
}

const deskRules = ruleSource(DESKTOP_SRC)
const phoneRules = ruleSource(PHONE_SRC)
ok(deskRules.visibleStreams === phoneRules.visibleStreams, 'visibleStreams is identical on desktop and phone')
ok(deskRules.needsPin === phoneRules.needsPin, 'needsPin is identical on desktop and phone')
ok(/streams\.filter\(\(s\) => !s\.restricted\)/.test(deskRules.visibleStreams), 'visibleStreams filters on the restricted flag itself')

// ---------------------------------------------------------------- load the module
// The renderer is TypeScript, so transpile it the same way the app's own build does.
// A fresh import per case, because sessionUnlocked is module-level state.
const tsSource = fs.readFileSync(path.join(repoRoot, DESKTOP_SRC), 'utf8')
const js = esbuild.transformSync(tsSource, { loader: 'ts', format: 'esm' }).code
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-parental-'))
const outFile = path.join(outDir, 'parental.mjs')
fs.writeFileSync(outFile, js)

let bump = 0
function fakeStorage () {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _raw: map
  }
}
async function freshModule () {
  globalThis.localStorage = fakeStorage()
  return import(pathToFileURL(outFile).href + '?v=' + ++bump)
}

const LINEUP = [
  { id: 'news-1', title: 'News', restricted: false },
  { id: 'scares', title: 'Scares by Shudder' }, // no flag at all
  { id: 'screambox', title: 'Screambox TV', restricted: true }
]
const ids = (list) => list.map((s) => s.id)

// ---------------------------------------------------------------- lane B: visibility
{
  const p = await freshModule()
  eq(ids(p.visibleStreams(LINEUP)), ['news-1', 'scares'], 'no PIN: the restricted channel does not exist in the list')
  ok(!p.hasPin(), 'no PIN on a fresh device')

  await p.setPin('1234')
  ok(p.hasPin(), 'setPin registers a PIN')
  eq(ids(p.visibleStreams(LINEUP)), ['news-1', 'scares', 'screambox'], 'PIN set: the restricted channel is listed')

  p.setHideRestricted(true)
  ok(p.hideRestricted(), 'hide toggle stored')
  eq(ids(p.visibleStreams(LINEUP)), ['news-1', 'scares'], 'PIN + hide: it folds away again')

  p.setHideRestricted(false)
  eq(ids(p.visibleStreams(LINEUP)), ['news-1', 'scares', 'screambox'], 'un-hiding brings it back')
  eq(ids(p.visibleStreams([])), [], 'an empty lineup stays empty')
}

// ---------------------------------------------------------------- lane C: the gate
{
  const p = await freshModule()
  const restricted = LINEUP[2]
  const plain = LINEUP[0]
  ok(!p.needsPin(restricted), 'no PIN: nothing is gated (the channel is hidden instead)')

  await p.setPin('4321')
  ok(p.needsPin(restricted), 'PIN set: a restricted channel is gated')
  ok(!p.needsPin(plain), 'a normal channel is never gated')
  ok(!p.needsPin(LINEUP[1]), 'a channel with no restricted field is never gated')
  ok(!p.needsPin(null) && !p.needsPin(undefined), 'null/undefined are not gated')
}

// ---------------------------------------------------------------- lane D: session unlock
{
  const p = await freshModule()
  await p.setPin('1234')
  ok(p.needsPin(LINEUP[2]) && !p.isUnlocked(), 'locked before the first unlock')
  p.markUnlocked()
  ok(p.isUnlocked(), 'markUnlocked flips the session')
  ok(!p.needsPin(LINEUP[2]), 'one unlock covers the session — no re-prompt per channel')
  eq(ids(p.visibleStreams(LINEUP)), ['news-1', 'scares', 'screambox'], 'unlocking does not change what is LISTED')

  p.clearPin()
  ok(!p.hasPin() && !p.isUnlocked(), 'clearPin removes the PIN and re-locks the session')
  eq(ids(p.visibleStreams(LINEUP)), ['news-1', 'scares'], 'after clearPin the restricted channel is hidden again')
}

// ---------------------------------------------------------------- lane E: the digest
{
  const p = await freshModule()
  for (const good of ['1234', '000000', '12345678']) ok(p.validPinFormat(good), `accepts a ${good.length}-digit PIN`)
  for (const bad of ['123', '123456789', 'abcd', '12a4', '', '12 34']) ok(!p.validPinFormat(bad), `rejects ${JSON.stringify(bad)}`)

  await p.setPin('2468')
  ok(await p.verifyPin('2468'), 'the right PIN verifies')
  ok(!(await p.verifyPin('9999')), 'a wrong PIN does not')
  ok(!(await p.verifyPin('')), 'an empty PIN does not')

  const raw = globalThis.localStorage.getItem('aliran.parental.v1')
  ok(!raw.includes('2468'), 'the stored record does not contain the PIN itself')
  const rec = JSON.parse(raw)
  ok(typeof rec.salt === 'string' && rec.salt.length >= 32, 'a per-device salt is stored')
  ok(typeof rec.hash === 'string' && rec.hash.length === 64, 'the PIN is stored as a SHA-256 digest')

  // A second device with the SAME pin must not produce the same digest.
  const other = await freshModule()
  await other.setPin('2468')
  const rec2 = JSON.parse(globalThis.localStorage.getItem('aliran.parental.v1'))
  ok(rec2.salt !== rec.salt && rec2.hash !== rec.hash, 'the same PIN salts differently per device')

  // Rotating the PIN keeps the hide preference.
  const p3 = await freshModule()
  await p3.setPin('1111')
  p3.setHideRestricted(true)
  await p3.setPin('2222')
  ok(p3.hideRestricted(), 'changing the PIN preserves the hide toggle')
  ok(await p3.verifyPin('2222'), 'the new PIN verifies')
  ok(!(await p3.verifyPin('1111')), 'the old PIN stops working')
}

// ---------------------------------------------------------------- lane F: fail-closed
{
  const p = await freshModule()
  ok(!(await p.verifyPin('1234')), 'verifyPin with no record refuses rather than throwing')

  globalThis.localStorage.setItem('aliran.parental.v1', '{not json')
  ok(!p.hasPin(), 'a corrupt record reads as NO PIN')
  eq(ids(p.visibleStreams(LINEUP)), ['news-1', 'scares'], 'corrupt storage HIDES restricted channels (fail-closed)')
  ok(!p.needsPin(LINEUP[2]), 'and nothing claims to be gated on a device that cannot check a PIN')

  globalThis.localStorage.setItem('aliran.parental.v1', JSON.stringify({ salt: 1, hash: null }))
  ok(!p.hasPin(), 'a wrong-typed record also reads as no PIN')
  eq(ids(p.visibleStreams(LINEUP)), ['news-1', 'scares'], 'and still hides the restricted channel')

  // setHideRestricted must not conjure a PIN record out of nothing.
  const p2 = await freshModule()
  p2.setHideRestricted(true)
  ok(!p2.hasPin(), 'toggling hide without a PIN does not create one')
}

fs.rmSync(outDir, { recursive: true, force: true })
if (failures) { console.error(`\nRESULT: FAIL ❌ (${failures} failed)`); process.exit(1) }
console.log('\nRESULT: PASS ✅  (desktop parental controls: rule twins identical, visibility + gate + session unlock, digest round-trip, fail-closed on corrupt storage)')
