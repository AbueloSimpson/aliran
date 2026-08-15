// Desktop catalog shaping — the twin lane for desktop/renderer/src/catalog.ts.
// The desktop renderer has no jest harness (tsc + the esbuild bundle are its
// checks), so — like tools/desktop-guide-test.mjs and desktop-parental-test.mjs —
// the drift guards live here:
//
//   A. displayTitle (wrapper + computeDisplayTitle), zapRing, zapStep,
//      deriveTuneScope, splitCategory and computeCategoryModel are MIRRORED from
//      client/src/catalog.ts (the parental.ts precedent: only the shared RULE
//      functions are compared — the files around them legitimately differ in
//      memoization plumbing). The CODE of the two copies must stay identical, so
//      the same catalog strips the same prefixes, files the same groups (the
//      parent-dedupe fix included) and rings the same channels on a TV and on a
//      desktop. Compared with comments/blank lines stripped; a signature-format
//      miss is a FAIL, never an uncaught throw. The same lane also pins
//      OVERFLOW_EPS across the two focused-row marquees (client MarqueeText /
//      desktop ChannelList) — one product decision, two platforms.
//   B. the functions run for real (esbuild bundle of the DESKTOP copy), over cases
//      mirrored VERBATIM from client/__tests__/catalog.test.ts (and the RN
//      TvLiveZapScope matrix for zapStep):
//        - the displayTitle matrix: strip on a matching own-sub leaf; keep without
//          one; keep an over-SUBCAT_MAX descriptive bracket; casing fold both
//          sides; untagged untouched; the panel's '/'+whitespace normalization;
//          never an empty name;
//        - the computeCategoryModel parent-group dedupe (two subs of ONE parent =
//          one parent membership — the duplicate dead-ended the parent-scoped zap
//          ring and doubled React keys);
//        - zapRing: scoped order live-only, 'All' identity with zapOrder, unknown
//          scope fallback, a vod-emptied group comes back EMPTY (zapStep owns the
//          degradation now);
//        - zapStep: the whole ladder — scoped walk + wrap with NO scope write, the
//          vod-exit global fallback (land on 001, scope 'All'), the one-ring
//          widening rungs (sub → parent → global) with the scope following, and
//          the single-live-channel NO-OP landing (next undefined, scope
//          undefined);
//        - deriveTuneScope: full-sub preference, bare-parent fallback, 'All';
//        - memoization identity (array-keyed caches).
//   C. styles.css pins (the desktop-vod reduced-motion precedent): the focused-row
//      marquee's animation AND its ellipsis→clip trade both live INSIDE the
//      prefers-reduced-motion: no-preference gate — "remove animations" must keep
//      a plain ellipsized title, and nothing marquee-shaped may leak out ungated.
//
// Run: node tools/desktop-catalog-test.mjs   (npm run test:desktop-catalog)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (cond, msg) => { if (cond) { console.log('  ok  ', msg) } else { console.error('  FAIL', msg); failures++ } }
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)

const DESKTOP_SRC = 'desktop/renderer/src/catalog.ts'
const CLIENT_SRC = 'client/src/catalog.ts'

// ---------------------------------------------------------------- lane A: the twins
// Only the shared RULE code is compared: displayTitle, zapRing, splitCategory and
// computeCategoryModel (function bodies — the last one is where the parent-group
// dedupe lives, so a client-side divergence there must not slip through) plus the
// SUBCAT_TAG_RE/SUBCAT_MAX constants displayTitle scopes by. Comment lines and
// blanks are stripped (prose differs; the rules must not). A miss from either
// file (renamed, re-signatured) reports as a FAIL rather than throwing.
console.log('A. displayTitle/zapRing/zapStep/deriveTuneScope/splitCategory/computeCategoryModel are code-identical across the client and desktop copies')
{
  const grabFn = (src, name) => {
    const m = src.match(new RegExp(`(?:export )?function ${name} \\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}`, 'm'))
    return m ? m[0] : null
  }
  const grabConst = (src, name) => {
    const m = src.match(new RegExp(`^const ${name} = .*$`, 'm'))
    return m ? m[0] : null
  }
  const strip = (code) => code.split('\n').filter((l) => {
    const t = l.trim()
    return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')
  const client = fs.readFileSync(path.join(repoRoot, CLIENT_SRC), 'utf8').replace(/\r\n/g, '\n')
  const desktop = fs.readFileSync(path.join(repoRoot, DESKTOP_SRC), 'utf8').replace(/\r\n/g, '\n')
  const compare = (label, grab, names) => {
    for (const name of names) {
      const c = grab(client, name)
      const d = grab(desktop, name)
      if (!c || !d) {
        ok(false, `${name} found in both copies (missing/re-signatured in ${!c ? 'client' : 'desktop'})`)
        continue
      }
      ok(strip(c) === strip(d), label(name))
    }
  }
  compare((n) => `${n} is IDENTICAL code in both copies (two-copy hazard)`, grabFn,
    ['displayTitle', 'computeDisplayTitle', 'zapRing', 'zapStep', 'deriveTuneScope', 'splitCategory', 'computeCategoryModel'])
  compare((n) => `${n} matches the client copy (and thereby panel/src/sources.js)`, grabConst,
    ['SUBCAT_TAG_RE', 'SUBCAT_MAX'])

  // OVERFLOW_EPS: the "a few px of overhang is rounding, not a title worth
  // scrolling" threshold is ONE product decision, implemented once per platform
  // (client MarqueeText / desktop ChannelList MarqueeSpan). Pinned so it cannot
  // drift silently.
  const marqueeClient = fs.readFileSync(path.join(repoRoot, 'client/src/components/MarqueeText.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const marqueeDesktop = fs.readFileSync(path.join(repoRoot, 'desktop/renderer/src/components/ChannelList.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const epsClient = grabConst(marqueeClient, 'OVERFLOW_EPS')
  const epsDesktop = grabConst(marqueeDesktop, 'OVERFLOW_EPS')
  if (!epsClient || !epsDesktop) {
    ok(false, `OVERFLOW_EPS found in both marquees (missing in ${!epsClient ? 'client MarqueeText' : 'desktop ChannelList'})`)
  } else {
    ok(epsClient === epsDesktop, 'OVERFLOW_EPS is the SAME value in the client MarqueeText and the desktop ChannelList (one product decision)')
  }
}

// ---- bundle the DESKTOP copy so everything below runs the shipped code ----
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-catalog-'))
const catalogFile = path.join(outDir, 'catalog.mjs')
await esbuild.build({
  entryPoints: [path.join(repoRoot, DESKTOP_SRC)],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: catalogFile,
  logLevel: 'silent',
  // The i18n workspace resolves from the repo tree directly (the package ships TS
  // source with no build step), so this lane runs even when node_modules lacks
  // the workspace link — the state a fresh/pruned checkout is in.
  alias: { '@aliran/i18n': path.join(repoRoot, 'i18n/src/index.ts') }
})
const { displayTitle, categoryModel, channelNumbers, zapOrder, zapRing, zapStep, deriveTuneScope } = await import(pathToFileURL(catalogFile).href)

// Stream stub — the client catalog.test.ts helper verbatim.
const s = (id, category, extra = {}) => ({ id, title: id, category, ...extra })

// ---------------------------------------------------------------- lane B: behavior
console.log('B1. displayTitle: stripping the panel\'s own live-events tag (client matrix)')
{
  const dt = (title, category) => displayTitle({ title, category })

  eq(dt('[MLB] Mariners vs Yankees (7:05 PM ET)', ['Live Events/MLB']), 'Mariners vs Yankees (7:05 PM ET)',
    'strips the tag the panel turned into this stream\'s own sub-rail')

  // Parent-only category: the panel did NOT mint a rail from this bracket.
  eq(dt('[MLB] Mariners vs Yankees', ['Live Events']), '[MLB] Mariners vs Yankees', 'keeps the tag on a parent-only category')
  // A leaf that names something else is no license either.
  eq(dt('[4K] Cine Max', ['Movies/Estrenos']), '[4K] Cine Max', 'keeps the tag when the leaf names something else')
  eq(dt('[MLB] Mariners vs Yankees', undefined), '[MLB] Mariners vs Yankees', 'keeps the tag with no category at all')

  // Even alongside a sub-rail the panel DID mint, an over-budget bracket is prose.
  const long = '[Some very long descriptive bracket over thirty two characters] X'
  eq(dt(long, ['Live Events/MLB']), long, 'keeps a descriptive bracket longer than SUBCAT_MAX (32)')

  eq(dt('[mlb] Game of the night', ['Live Events/MLB']), 'Game of the night', 'folds tag casing')
  eq(dt('[MLB] Game of the night', ['Live Events/mlb']), 'Game of the night', 'folds leaf casing')

  eq(dt('News 24', ['News/English']), 'News 24', 'leaves an untagged title untouched')

  // deriveSubcat turns '/' into a space (two levels, never three) before railing.
  eq(dt('[MLB/Playoffs] Game 7', ['Live Events/MLB Playoffs']), 'Game 7', 'mirrors the panel: \'/\' folds to a space')
  // Runs of whitespace collapse; edges trim.
  eq(dt('[ MLB   Playoffs ] Game 7', ['Live Events/MLB Playoffs']), 'Game 7', 'mirrors the panel: whitespace collapses')

  eq(dt('[MLB]', ['Live Events/MLB']), '[MLB]', 'never returns an empty name: a title that IS the tag keeps it')
  eq(dt('  [MLB]  ', ['Live Events/MLB']), '  [MLB]  ', 'never returns an empty name (padded tag-only title)')
}

console.log('B2. categoryModel: one parent membership per stream (the zap dead-end fix)')
{
  const streams = [
    s('doubleheader', ['Live Events/MLB', 'Live Events/NBA'], { order: 1, isLive: true }),
    s('game-2', ['Live Events/MLB'], { order: 2, isLive: true })
  ]
  const m = categoryModel(streams)
  // THE BUG THIS PINS: one parent push per category entry filed the channel in the
  // parent group twice, ADJACENTLY — a parent-scoped zap ring then found the same
  // id at findIndex + 1 (play() no-op'd: zap permanently dead on that channel),
  // and every list rendering the parent group got duplicate React keys.
  eq(m.groups['Live Events'].map((x) => x.id), ['doubleheader', 'game-2'], 'two subs of ONE parent join the parent group once')
  eq(m.groups['Live Events/MLB'].map((x) => x.id), ['doubleheader', 'game-2'], 'sub group MLB keeps one membership each')
  eq(m.groups['Live Events/NBA'].map((x) => x.id), ['doubleheader'], 'sub group NBA keeps one membership')
  eq(categoryModel([s('twice', ['News', 'News'], { isLive: true })]).groups.News.map((x) => x.id), ['twice'],
    'a literally duplicated category entry never doubles a group')
}

console.log('B3. zapRing: CH+/CH- walks the category the viewer tuned from (client matrix)')
{
  const streams = [
    s('news-1', ['News'], { order: 1, isLive: true }),
    s('mlb-1', ['Live Events/MLB'], { order: 2, isLive: true }),
    s('news-2', ['News'], { order: 3, isLive: true }),
    s('mlb-2', ['Live Events/MLB'], { order: 4, isLive: true }),
    s('mlb-replay', ['Live Events/MLB'], { order: 5, type: 'vod' })
  ]
  const m = categoryModel(streams)
  // The scoped ring: only the category's channels, in the category's (curated)
  // order — the global neighbors (news-*) are not in it. The vod replay filed on
  // the same rail is excluded exactly as zapOrder excludes it globally.
  eq(zapRing(streams, m, 'Live Events/MLB').map((x) => x.id), ['mlb-1', 'mlb-2'], 'scoped category in its own curated order, live-only')
  eq(zapRing(streams, m, 'Live Events').map((x) => x.id), ['mlb-1', 'mlb-2'], 'a parent scope rings the union of its subs')

  const two = [s('a', ['News'], { order: 1, isLive: true }), s('b', ['Music'], { order: 2, isLive: true })]
  ok(zapRing(two, categoryModel(two), 'All') === zapOrder(two), 'All IS the global ring (identity — the memoized zapOrder)')
  ok(zapRing(two, categoryModel(two), 'Gone/Away') === zapOrder(two), 'unknown scope falls back to the global ring')

  const vodOnly = [
    s('ch', ['News'], { order: 1, isLive: true }),
    s('movie-a', ['Library'], { order: 2, type: 'vod' }),
    s('movie-b', ['Library'], { order: 3, type: 'vod' })
  ]
  const mv = categoryModel(vodOnly)
  // 'Library' exists but holds only vod titles: the ring comes back EMPTY —
  // zapRing is the plain scope→ring lookup now, and zapStep owns the degradation
  // (an empty ring strands the keys, so THERE the global one stands in).
  eq(zapRing(vodOnly, mv, 'Library'), [], 'a vod-emptied group comes back EMPTY (zapStep owns the degradation)')
  const vodStep = zapStep(vodOnly, mv, 'Library', 'movie-a', 1)
  eq(vodStep.next?.id, 'ch', '…and zapStep degrades it to the global ring (the one live channel)')
  eq(vodStep.scope, 'All', '…with the scope following to All')
}

console.log('B3b. zapStep: the whole ladder in one place (the RN TvLiveZapScope matrix)')
{
  // The RN suite's lineup: every MLB game's channel-number neighbor is a NEWS
  // channel, so a scoped walk and a numbers walk can never be confused.
  const lineup = [
    s('alpha-news', ['News'], { order: 1, isLive: true }),
    s('mlb-one', ['Live Events/MLB'], { order: 2, isLive: true }),
    s('beta-news', ['News'], { order: 3, isLive: true }),
    s('mlb-two', ['Live Events/MLB'], { order: 4, isLive: true }),
    s('movie-night', ['Library'], { order: 9, type: 'vod' })
  ]
  const m = categoryModel(lineup)
  // The scoped walk: next in the CATEGORY (never the next channel number), and no
  // scope write — a scoped zap keeps its ring.
  const step1 = zapStep(lineup, m, 'Live Events/MLB', 'mlb-one', 1)
  eq(step1.next?.id, 'mlb-two', 'a scoped step walks the category, not the numbers')
  eq(step1.scope, undefined, '…and records NOTHING (the ring is unchanged)')
  eq(zapStep(lineup, m, 'Live Events/MLB', 'mlb-two', 1).next?.id, 'mlb-one', 'the scoped ring wraps')
  eq(zapStep(lineup, m, 'Live Events/MLB', 'mlb-one', -1).next?.id, 'mlb-two', '…both ways')
  // An 'All' scope keeps the global channel-number surfing feel.
  eq(zapStep(lineup, m, 'All', 'mlb-one', 1).next?.id, 'beta-news', 'an All step follows the channel numbers')
  // Zapping OUT of a vod title: a global zap landing on channel 001, scope 'All'.
  const vodExit = zapStep(lineup, m, 'Library', 'movie-night', 1)
  eq(vodExit.next?.id, 'alpha-news', 'a vod exit lands on channel 001 (the global ring)')
  eq(vodExit.scope, 'All', '…and the scope follows to All')

  // The one-ring ladder, rung 1: a one-game SUB widens to the parent ring.
  const solo = [
    s('alpha-news', ['News'], { order: 1, isLive: true }),
    s('mlb-solo', ['Live Events/MLB'], { order: 2, isLive: true }),
    s('beta-news', ['News'], { order: 3, isLive: true }),
    s('nba-one', ['Live Events/NBA'], { order: 4, isLive: true })
  ]
  const ms = categoryModel(solo)
  const rung1 = zapStep(solo, ms, 'Live Events/MLB', 'mlb-solo', 1)
  eq(rung1.next?.id, 'nba-one', 'a one-game sub ring widens to the PARENT ring')
  eq(rung1.scope, 'Live Events', '…and the scope follows the ring that answered')

  // Rung 2: a one-game PARENT falls through to the global ring.
  const lone = [
    s('alpha-news', ['News'], { order: 1, isLive: true }),
    s('mlb-solo', ['Live Events/MLB'], { order: 2, isLive: true }),
    s('beta-news', ['News'], { order: 3, isLive: true })
  ]
  const ml = categoryModel(lone)
  const rung2 = zapStep(lone, ml, 'Live Events/MLB', 'mlb-solo', 1)
  eq(rung2.next?.id, 'beta-news', 'a one-game parent ring falls back to the global ring')
  eq(rung2.scope, 'All', '…scope All')

  // The NO-OP landing: a single-live-channel catalog — the ladder widens to global
  // and comes back around to the playing channel itself. Nothing tunes, and the
  // scope must NOT be recorded (the picture never changed).
  const single = [
    s('only-live', ['Live Events/MLB'], { order: 1, isLive: true }),
    s('flick', ['Library'], { order: 2, type: 'vod' })
  ]
  const msg = categoryModel(single)
  const noop = zapStep(single, msg, 'Live Events/MLB', 'only-live', 1)
  eq(noop.next, undefined, 'a landing ON the playing channel tunes nothing')
  eq(noop.scope, undefined, '…and records no scope (the tuned-from context stands)')
}

console.log('B3c. deriveTuneScope: the no-context tune takes the channel\'s own filing')
{
  const streams = [
    s('game', ['Live Events/MLB'], { order: 1, isLive: true }),
    s('news', ['News'], { order: 2, isLive: true }),
    s('bare', undefined, { order: 3, isLive: true })
  ]
  const m = categoryModel(streams)
  eq(deriveTuneScope(streams[0], m), 'Live Events/MLB', 'prefers the first full Parent/Sub entry the model has a group for')
  eq(deriveTuneScope(streams[1], m), 'News', 'a bare parent that has a group stands')
  eq(deriveTuneScope(streams[2], m), 'All', 'no category at all -> All')
  eq(deriveTuneScope(null, m), 'All', 'no record at all -> All')
  eq(deriveTuneScope(s('ghost', ['Gone/Away'], {}), m), 'All', 'a filing the catalog has no group for -> All')
}

console.log('B4. memoization: the derivations pay once per catalog array')
{
  const streams = [s('b', ['News'], { order: 2 }), s('a', ['News'], { order: 1 })]
  ok(categoryModel(streams) === categoryModel(streams), 'categoryModel memoizes on array identity')
  ok(channelNumbers(streams) === channelNumbers(streams), 'channelNumbers memoizes on array identity')
  ok(zapOrder(streams) === zapOrder(streams), 'zapOrder memoizes on array identity')
  const clone = [...streams]
  ok(categoryModel(clone) !== categoryModel(streams), 'a fresh array recomputes')
  eq(categoryModel(clone).groups.All.map((x) => x.id), categoryModel(streams).groups.All.map((x) => x.id), '…to the same content')
}

fs.rmSync(outDir, { recursive: true, force: true })

// ------------------------------------------------- lane C: styles.css marquee pins
// The desktop-vod reduced-motion precedent, for the focused-row marquee
// (ChannelList MarqueeSpan): the slide animation AND the ellipsis→clip trade must
// BOTH sit inside the prefers-reduced-motion: no-preference gate — with "remove
// animations" on, the title stays a plain ellipsized span — and nothing
// marquee-shaped may exist outside it.
console.log('C. styles.css: the marquee lives entirely inside the reduced-motion gate')
{
  const css = fs.readFileSync(path.join(repoRoot, 'desktop/renderer/src/styles.css'), 'utf8').replace(/\r\n/g, '\n')
  // Every no-preference media block, brace-matched (a lazy regex would stop at
  // the first close brace inside @keyframes).
  const gateRe = /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{/g
  const inside = []
  let outside = css
  let m
  while ((m = gateRe.exec(css))) {
    let depth = 1
    let i = gateRe.lastIndex
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    const whole = css.slice(m.index, i)
    inside.push(css.slice(gateRe.lastIndex, i - 1))
    outside = outside.replace(whole, '')
  }
  const gated = inside.join('\n')
  ok(inside.length > 0, 'a prefers-reduced-motion: no-preference gate exists')
  ok(/\.row-title\.marquee\s*\{[^}]*text-overflow:\s*clip/.test(gated), 'the ellipsis→clip trade is INSIDE the gate (reduced motion keeps the ellipsis)')
  ok(/\.row-title\.marquee\s+\.marquee-inner\s*\{[^}]*animation:\s*marquee-slide/.test(gated), 'the slide animation is INSIDE the gate')
  ok(/@keyframes\s+marquee-slide/.test(gated), 'the marquee keyframes are INSIDE the gate')
  ok(!/marquee-slide/.test(outside), 'no marquee-slide animation/keyframes outside the gate')
  ok(!/\.row-title\.marquee/.test(outside), 'no ungated .row-title.marquee rule anywhere else')
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall desktop catalog checks passed')
