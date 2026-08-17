// aliran-kit ↔ React Native player parity — the drift lane for a deliberate PORT.
//
// sdk/android/aliran-kit is a Kotlin re-implementation of sdk/react-native/src/
// AliranVideo.tsx: the same bounded error and stall ladders, the same offline
// watchdog, the same container hint. Both are covered by their own tests — 19 lanes in
// RecoveryLaddersTest, and AliranVideoTune.test.tsx on the RN side — and each suite is
// perfectly happy with a ladder that no longer matches the other platform. A viewer on
// a Kotlin host and a viewer on the phone would then wait different amounts of time for
// the same dead channel, and the only thing that ever noticed would be a human reading
// two files side by side.
//
// So this lane pins the SHARED NUMBERS AND PREDICATES across the two copies — the
// tools/desktop-*-test.mjs twin-guard idea applied to a port rather than a mirror. It
// reads source, never runs it, so it needs no bundler, no JVM and no Android:
//
//   A. the six ladder constants agree (2.5 s first retry, give up at the 4th error;
//      12 s first stall window, give up at the 4th resync; 15 s no-answer, 30 s
//      cdn-tune) — and the schedules they DERIVE are the ones the docs promise;
//   B. the backoff really is "double per attempt" on both sides, written each
//      platform's way (`2 ** n` / `1L shl n`);
//   C. the error give-up predicate is character-for-character the same expression
//      once `.current` and `===` are normalized away — including the cdn refusal
//      grades, where 404/410/451 give up one attempt earlier than 401/403;
//   D. those two HTTP grades name the same status codes;
//   E. the transport-teardown rung is the same rung (resync 2);
//   F. the offline watchdog's two arms are the same predicate;
//   G. the container-extension rule accepts and rejects the same urls — both regexes
//      are re-derived from source and run over one fixture table;
//   H. every give-up spends BOTH ladders.
//
// ⚠ KNOWN, DELIBERATE DIVERGENCE — the Kotlin port is STRICTER than its source. The
// RN stall ladder's give-up branch does not go through giveUp(): it sets tuning = false
// and calls onError directly, leaving `failures` armed and any pending error retry
// alive. The Kotlin side routes the same give-up through giveUp() -> spend(), so it
// cannot leave a lane armed behind the error UI. The parity gap runs RN-wards, and this
// lane reports it as a note rather than a failure — do NOT "fix" Kotlin to match it.
//
// Run: node tools/kit-parity-test.mjs   (npm run test:kit-parity)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (cond, msg) => { if (cond) { console.log('  ok  ', msg) } else { console.error('  FAIL', msg); failures++ } }
const eq = (a, b, msg) => ok(a === b, `${msg}${a === b ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
// The cross-platform comparisons are symmetric — neither side is "expected" — so they
// report which platform said what instead of got/want.
const agree = (rn, kt, msg) => {
  const same = JSON.stringify(rn) === JSON.stringify(kt)
  ok(same, `${msg}${same ? '' : `\n        rn: ${JSON.stringify(rn)}\n        kt: ${JSON.stringify(kt)}`}`)
}
const same = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
const note = (msg) => console.log('  note', msg)

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n')
const RN_PATH = 'sdk/react-native/src/AliranVideo.tsx'
const LADDERS_PATH = 'sdk/android/aliran-kit/src/main/java/aliran/kit/RecoveryLadders.kt'
const VIEW_PATH = 'sdk/android/aliran-kit/src/main/java/aliran/kit/AliranPlayerView.kt'
const SOURCETYPE_PATH = 'sdk/android/aliran-kit/src/main/java/aliran/kit/SourceType.kt'

const rn = read(RN_PATH)
const ladders = read(LADDERS_PATH)
const view = read(VIEW_PATH)
const sourceTypeKt = read(SOURCETYPE_PATH)

// Every extractor below returns null when its anchor is gone, and `pin` turns that into
// a named failure rather than a silent pass — a renamed constant or a reworked
// expression must break this lane loudly, not quietly stop being checked. That is the
// failure mode a source-reading guard has to defend against above all others.
function pin (value, what) {
  if (value === null || value === undefined) { console.error('  FAIL', `anchor not found: ${what}`); failures++ }
  return value
}
const num = (s) => Number(String(s).replace(/_/g, ''))
function match1 (src, re, what) {
  const m = src.match(re)
  return pin(m ? m[1] : null, what)
}

// ---- A. the six ladder constants ----
console.log(`A. the ladder constants agree (${RN_PATH} <-> RecoveryLadders.kt)`)
const CONSTANTS = [
  // [meaning, RN name, Kotlin name, expected]
  ['first error-retry delay', 'RETRY_MS', 'RETRY_MS', 2500],
  ['error give-up attempt', 'ERROR_GIVE_UP', 'ERROR_GIVE_UP', 4],
  ['stall give-up resync', 'STALL_GIVE_UP', 'STALL_GIVE_UP', 4],
  ['no-answer watchdog', 'NO_ANSWER_TIMEOUT_MS', 'NO_ANSWER_TIMEOUT_MS', 15000],
  ['cdn-tune watchdog', 'CDN_TUNE_TIMEOUT_MS', 'CDN_TUNE_TIMEOUT_MS', 30000]
]
const rnConst = (name) => {
  const v = match1(rn, new RegExp(`^const ${name} = (\\d[\\d_]*)$`, 'm'), `${RN_PATH}: const ${name}`)
  return v === null ? null : num(v)
}
const ktConst = (name) => {
  const v = match1(ladders, new RegExp(`^ +const val ${name} = (\\d[\\d_]*)L?$`, 'm'), `RecoveryLadders.kt: const val ${name}`)
  return v === null ? null : num(v)
}
const values = {}
for (const [meaning, rnName, ktName, expected] of CONSTANTS) {
  const a = rnConst(rnName)
  const b = ktConst(ktName)
  values[rnName] = a // the EXTRACTED value, so section B derives the real schedule
  agree(a, b, `${meaning}: RN ${rnName} === Kotlin ${ktName}`)
  eq(a, expected, `${meaning}: still the documented ${expected}`)
}
// The stall window is the one constant that is not a constant on the Kotlin side — it
// is the host-settable first rung of the ladder (AliranPlayerView.stallTimeoutMs), and
// its DEFAULT is what has to match RN's STALL_MS.
{
  const a = rnConst('STALL_MS')
  const raw = match1(view, /^ +var stallTimeoutMs: Long = (\d[\d_]*)$/m, 'AliranPlayerView.kt: var stallTimeoutMs default')
  const b = raw === null ? null : num(raw)
  values.STALL_MS = a
  agree(a, b, 'first stall window: RN STALL_MS === Kotlin stallTimeoutMs default')
  eq(a, 12000, 'first stall window: still the documented 12000')
}

// ---- B. the derived schedules, and the doubling that produces them ----
console.log('\nB. the schedules those constants derive')
{
  // The error ladder waits before each RETRY; the give-up rung has no wait of its own
  // (an error IS the failure signal, so the last rung reports instead of waiting).
  const errorWaits = Array.from({ length: values.ERROR_GIVE_UP - 1 }, (_, i) => values.RETRY_MS * 2 ** i)
  same(errorWaits, [2500, 5000, 10000], 'error ladder waits 2.5 / 5 / 10 s, then gives up on the 4th error')
  eq(errorWaits.reduce((a, b) => a + b, 0), 17500, 'error ladder spends 17.5 s of waits before the give-up')
  // The stall ladder DOES wait out its last window — a resync can only learn it failed
  // by letting the next one expire.
  const stallWindows = Array.from({ length: values.STALL_GIVE_UP }, (_, i) => values.STALL_MS * 2 ** i)
  same(stallWindows, [12000, 24000, 48000, 96000], 'stall ladder waits 12 / 24 / 48 / 96 s, then gives up')
  eq(stallWindows.reduce((a, b) => a + b, 0), 180000, 'stall ladder runs ~3 min end to end')
  // CDN_TUNE must sit just PAST the error ladder's give-up, so whichever signal arrives
  // first ends the tune (both files say so in prose; this is the arithmetic).
  ok(values.CDN_TUNE_TIMEOUT_MS > 17500, 'cdn-tune watchdog sits past the error ladder give-up (~27 s with ExoPlayer\'s own retries)')
  ok(values.NO_ANSWER_TIMEOUT_MS < values.CDN_TUNE_TIMEOUT_MS, 'no-answer bound is the tighter of the two watchdogs')

  // …and that both sides really compute the wait by DOUBLING, written each platform's
  // way. Numbers agreeing is not enough: a linear backoff with the same first rung
  // would pass section A and give up ~40 s later on a real dead channel. Whitespace is
  // tolerated throughout — the claim is the shape of the arithmetic, not its formatting.
  ok(/RETRY_MS\s*\*\s*2\s*\*\*\s*failures\.current/.test(rn), 'RN error backoff doubles per consecutive failure')
  ok(/RETRY_MS\s*\*\s*\(1L shl failures\)/.test(ladders), 'Kotlin error backoff doubles per consecutive failure')
  ok(/stallTimeoutMs\s*\*\s*2\s*\*\*\s*resyncs\.current/.test(rn), 'RN stall backoff doubles per failed resync')
  ok(/stallTimeoutMs\s*\*\s*\(1L shl resyncs\)/.test(ladders), 'Kotlin stall backoff doubles per failed resync')
}

// ---- C. the error give-up predicate, expression for expression ----
console.log('\nC. the error give-up predicate')
{
  // Normalize away the things that legitimately differ between a React ref and a
  // Kotlin field, and nothing else: the ladder shape itself must survive intact.
  const norm = (s) => s
    .replace(/failures\.current/g, 'failures')
    .replace(/===/g, '==')
    .replace(/\s+/g, ' ')
    .trim()
  const rnExpr = match1(rn, /if \((failures\.current === ERROR_GIVE_UP - 1 \|\|[^\n]*?)\) \{/, `${RN_PATH}: the error give-up condition`)
  const ktExpr = match1(ladders, /if \((failures == ERROR_GIVE_UP - 1 \|\|[^\n]*?)\) \{/, 'RecoveryLadders.kt: the error give-up condition')
  if (rnExpr && ktExpr) {
    agree(norm(rnExpr), norm(ktExpr), 'give-up condition is the same expression on both sides')
    // Spelled out, so a future reader sees WHAT was pinned and not just that it matched.
    eq(
      norm(ktExpr),
      'failures == ERROR_GIVE_UP - 1 || (cdn && ((gone && failures >= 1) || (refused && failures >= 2)))',
      'give-up condition still reads: last rung, or a cdn refusal short-circuit'
    )
  }
  // The spend-nothing guard that must precede it on both sides: once the ladder is
  // spent, an error is ignored — only real playback re-arms.
  ok(/if \(failures\.current >= ERROR_GIVE_UP\) return/.test(rn), 'RN ignores errors once the ladder is spent')
  ok(/if \(failures >= ERROR_GIVE_UP\) return ErrorAction\.Ignore/.test(ladders), 'Kotlin ignores errors once the ladder is spent')
}

// ---- D. the two HTTP refusal grades ----
console.log('\nD. the cdn refusal grades')
{
  const codes = (s) => (s.match(/\d{3}/g) ?? []).map(Number).sort((a, b) => a - b)
  const rnGone = match1(rn, /^ *const gone = (.+)$/m, `${RN_PATH}: const gone`)
  const rnRefused = match1(rn, /^ *const refused = (.+)$/m, `${RN_PATH}: const refused`)
  const ktGone = match1(view, /^ *gone = (.+)$/m, 'AliranPlayerView.kt: gone =')
  const ktRefused = match1(view, /^ *refused = (.+)$/m, 'AliranPlayerView.kt: refused =')
  agree(codes(rnGone), codes(ktGone), 'gone (one retry, then give up) grades the same status codes')
  same(codes(rnGone), [404, 410, 451], 'gone is still 404/410/451')
  agree(codes(rnRefused), codes(ktRefused), 'refused (two retries — event playlists rotate tokens) grades the same codes')
  same(codes(rnRefused), [401, 403], 'refused is still 401/403')
  // The grades must not collide: a code in both sets would make the shorter grade
  // unreachable and quietly cost token-rotating event channels an attempt.
  ok(codes(rnGone).every((c) => !codes(rnRefused).includes(c)), 'the two grades share no status code')
}

// ---- E. the transport-teardown rung ----
console.log('\nE. the transport-teardown rung')
{
  const rnRung = match1(rn, /if \(resyncs\.current >= (\d+)\) backend\.reconnect\(\)/, `${RN_PATH}: the reconnect rung`)
  const ktRung = match1(ladders, /StallAction\.Resync\(reconnect = resyncs >= (\d+)\)/, 'RecoveryLadders.kt: the reconnect rung')
  agree(Number(rnRung), Number(ktRung), 'backend.reconnect() joins the ladder at the same rung')
  eq(Number(ktRung), 2, 'reconnect still joins at resync 2 (rung 1 stays a plain rebuild)')
}

// ---- F. the offline watchdog's two arms ----
console.log('\nF. the offline watchdog')
{
  // Same normalization idea as section C: strip the platform's own accessors for the
  // four inputs (tune-is-live, this-mount-has-played, the engine's current source),
  // keep the logic.
  const norm = (s) => s
    .replace(/t\.live/g, 'live')
    .replace(/progress\.current\.played/g, 'played')
    .replace(/backend\.source === 'cdn'/g, 'cdn')
    .replace(/\s+/g, ' ')
    .trim()
  const rnNoAnswer = match1(rn, /^ *const noAnswer = (.+)$/m, `${RN_PATH}: const noAnswer`)
  const ktNoAnswer = match1(ladders, /^ *val noAnswer = (.+)$/m, 'RecoveryLadders.kt: val noAnswer')
  const rnCdnDead = match1(rn, /^ *const cdnDead = (.+)$/m, `${RN_PATH}: const cdnDead`)
  const ktCdnDead = match1(ladders, /^ *val cdnDead = (.+)$/m, 'RecoveryLadders.kt: val cdnDead')
  if (rnNoAnswer && ktNoAnswer) {
    agree(norm(rnNoAnswer), norm(ktNoAnswer), 'NO_ANSWER arm is the same predicate')
    eq(norm(ktNoAnswer), 'autoPlay && !live && waited >= NO_ANSWER_TIMEOUT_MS', 'NO_ANSWER is still gated on autoPlay and NOT on prior playback')
  }
  if (rnCdnDead && ktCdnDead) {
    agree(norm(rnCdnDead), norm(ktCdnDead), 'CDN_TUNE arm is the same predicate')
    eq(norm(ktCdnDead), 'live && !played && cdn && waited >= CDN_TUNE_TIMEOUT_MS', 'CDN_TUNE is still cdn-only and gated on no first frame')
  }
  // p2p is out of scope on BOTH arms — the engine's own tune watchdog owns that class.
  // Neither predicate may ever name it, or the two watchdogs race on one stream.
  ok(!/p2p/.test(String(ktNoAnswer) + String(ktCdnDead)), 'neither Kotlin arm claims the p2p class')
  ok(!/'p2p'/.test(String(rnNoAnswer) + String(rnCdnDead)), 'neither RN arm claims the p2p class')
}

// ---- G. the container hint accepts and rejects the same urls ----
console.log('\nG. the container-extension rule')
{
  // Re-derive both regexes FROM SOURCE and run them over one table. The two are written
  // differently on purpose (JS takes the /i flag, Kotlin spells out a-zA-Z), so
  // comparing the literals would be noise; comparing their verdicts is the claim.
  const rnLit = match1(rn, /return (\/.+?\/[a-z]*)\.test\(segment\)/, `${RN_PATH}: sourceType()'s extension regex`)
  const ktLit = match1(sourceTypeKt, /^private val CONTAINER_EXTENSION = Regex\("""(.+?)"""\)$/m, 'SourceType.kt: CONTAINER_EXTENSION')
  let rnRe = null
  let ktRe = null
  if (rnLit) {
    const cut = rnLit.lastIndexOf('/')
    rnRe = new RegExp(rnLit.slice(1, cut), rnLit.slice(cut + 1))
  }
  if (ktLit) ktRe = new RegExp(ktLit)
  // Last path segment with query/fragment stripped — the input both implementations
  // build before testing (RN: split(/[?#]/)[0] then slice(lastIndexOf('/') + 1);
  // Kotlin: substringBefore('?').substringBefore('#').substringAfterLast('/')).
  const segment = (url) => {
    const p = url.split(/[?#]/)[0]
    return p.slice(p.lastIndexOf('/') + 1)
  }
  const URLS = [
    ['http://127.0.0.1:9000/index.m3u8', true], // the SDK's own server, always self-describing
    ['https://cdn.example.com/live/event.m3u8?token=abc', true],
    ['https://cdn.example.com/live/event.mpd', true], // must stay DASH, never forced to HLS
    ['https://jmp2.uk/stvp-1234', false], // the Samsung TV Plus KR class — 177 channels failed on this
    ['https://jmp2.uk/stvp-1234?x=1#frag', false],
    ['https://provider.example/8080/STREAM/1234/playlist', false],
    ['https://provider.example/live/1234.TS', true], // uppercase extension still counts
    ['https://provider.example/live/stream.', false], // a bare dot names nothing
    ['https://provider.example/v1.2.3/channel', false], // dots earlier in the PATH are not the segment's
    // Both ends of the 1-5 character bound, so a narrowed or widened quantifier on
    // either side shows up as a disagreement instead of passing unnoticed.
    ['https://provider.example/vod/title.a', true], // 1 char: the low bound
    ['https://provider.example/vod/title.movie', true], // 5 chars: the high bound
    ['https://provider.example/vod/title.mpegts', false], // 6 chars: past it
    ['https://provider.example/a.verylongext', false], // and well past it
    ['https://provider.example/', false],
    ['https://provider.example/feed.m3u8/', false] // trailing slash: the segment is empty
  ]
  if (rnRe && ktRe) {
    const rnVerdicts = URLS.map(([u]) => rnRe.test(segment(u)))
    const ktVerdicts = URLS.map(([u]) => ktRe.test(segment(u)))
    agree(rnVerdicts, ktVerdicts, 'both regexes give the same verdict on every fixture url')
    same(rnVerdicts, URLS.map(([, want]) => want), 'and the verdicts are the intended ones')
  }
  // Polarity: NO extension is what earns the forced HLS hint. Inverting this is the one
  // mistake that would still pass every check above.
  ok(/\.test\(segment\) \? undefined : 'm3u8'/.test(rn), "RN forces 'm3u8' only when the segment names no container")
  ok(/if \(!hasContainerExtension\(u\)\) item\.setMimeType\(MimeTypes\.APPLICATION_M3U8\)/.test(view), 'Kotlin forces APPLICATION_M3U8 only when the segment names no container')
}

// ---- H. every give-up spends BOTH ladders ----
console.log('\nH. a give-up spends both ladders')
{
  // Both assignments, adjacent, in one give-up body — spending only `failures` is the
  // exact bug this pair guards (a give-up mid-stall-ladder whose next rung resurrects
  // the tune over the host's error UI). Whitespace-tolerant: the pairing is the claim.
  ok(
    /failures\.current = ERROR_GIVE_UP\s*resyncs\.current = STALL_GIVE_UP/.test(rn),
    'RN giveUp() spends the error ladder AND the stall ladder'
  )
  ok(
    /fun spend\s*\(\)\s*\{\s*failures = ERROR_GIVE_UP;?\s*resyncs = STALL_GIVE_UP\s*\}/.test(ladders),
    'Kotlin spend() spends the error ladder AND the stall ladder'
  )
  ok(/ladders\.spend\(\)/.test(view), 'Kotlin giveUp() routes through spend()')
  // Re-arming is playback-only on both sides: a rebuild that merely succeeds must not
  // buy back attempts, or a host that keeps the player mounted loops at the boundary.
  // Both anchors are STRUCTURAL — the reset sits immediately after the platform's
  // playhead-motion record, inside the motion branch, and not on any mount path. (An
  // anchor on the comment beside it would fail on a reword, which is not drift.)
  ok(
    /progress\.current = \{ time: e\.currentTime[^\n]*\}\s*failures\.current = 0/.test(rn),
    'RN re-arms the error ladder on playhead motion only'
  )
  ok(
    /fun playing\s*\(\)\s*\{[^}]*?failures = 0/.test(ladders),
    'Kotlin re-arms the error ladder on playhead motion only'
  )

  // ⚠ The known divergence, reported and not asserted — see this file's header. If the
  // RN side is ever fixed to route its stall give-up through giveUp(), this note stops
  // printing and the header's ⚠ can go with it.
  const rnStallGiveUpBypasses = /if \(resyncs\.current >= STALL_GIVE_UP\) \{[\s\S]{0,600}?cb\.current\.onError\?\.\(`playback stalled/.test(rn)
  if (rnStallGiveUpBypasses) {
    note(`the RN stall give-up still bypasses giveUp() (${RN_PATH}) — it ends the tune and`)
    note('calls onError directly, leaving `failures` armed and any pending retry alive. The Kotlin')
    note('port routes the same give-up through giveUp() -> spend(). Kotlin is the STRICTER side')
    note('here: this is an RN bug to fix, never a Kotlin behaviour to relax.')
  } else {
    note('the RN stall give-up no longer bypasses giveUp() — drop the ⚠ note in this file\'s header.')
  }
}

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall aliran-kit <-> react-native parity checks passed')
