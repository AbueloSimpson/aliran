// The desktop EPG guide (WS4) — the twin lane for desktop/renderer/src/guide.ts and
// GuideScreen.tsx. The desktop renderer has no jest harness (tsc + the esbuild
// bundle are its checks), so — like tools/desktop-vod-test.mjs — the drift guards
// live here:
//
//   A. guide.ts is MIRRORED from client/src/guide.ts (the lang.ts/vod-sort.ts
//      precedent): the CODE of the two copies must stay identical, so the same
//      schedule produces the same grid on a TV and on a desktop. Compared from the
//      first export with comments/blank lines stripped (the section-K discipline —
//      prose and the EpgProgram import path legitimately differ, the math must not).
//   B. the pure math runs for real (esbuild bundle of the DESKTOP copy), over cases
//      mirrored VERBATIM from client/__tests__/guide.test.ts: cellRect clipping and
//      the min-width/row-edge rules, the window overlap filter, snapToNow, and the
//      moveFocus reducer — slot paging with floor/ceiling clamps, time-position-
//      preserving row moves, the header exit, and the i<0 guide-less/off-window
//      branch that pages the window under the placeholder.
//   C. GuideGrid renders for real (esbuild -> react-dom/server, the section-L
//      approach with the createRequire banner): markup basics — heading, the NOW
//      pill and category chips, 4 time-bar slot labels, channel numbers, the honest
//      "No program information" placeholder (D2 — no fake data), the playing-row
//      accent class.
//   D. styles.css pins: the 62px guide row/strip/cell height (guide.ts's
//      GUIDE_ROW_INNER_H — the scroll-slice unit), the 96×54 guide thumb (the
//      client's TV channel column), the hairline slot inside guide cells, the
//      focused-cell light fill, and the past-dim opacity.
//
// Run: node tools/desktop-guide-test.mjs   (npm run test:desktop-guide)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

let failures = 0
const ok = (cond, msg) => { if (cond) { console.log('  ok  ', msg) } else { console.error('  FAIL', msg); failures++ } }
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`}`)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- A. the two-copy identity guard ----
console.log('A. desktop guide.ts is the client guide.ts, code-identical')
{
  const code = (rel) => {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n')
    // Everything above the first export is the file header and the platform's own
    // EpgProgram import — those legitimately differ; the math below must not.
    const body = src.slice(src.indexOf('export const SLOT_MIN'))
    return body.split('\n').filter((l) => {
      const t = l.trim()
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    }).join('\n')
  }
  const client = code('client/src/guide.ts')
  const desktop = code('desktop/renderer/src/guide.ts')
  ok(client.length > 500, 'the client guide module was found')
  ok(client === desktop, 'the client and desktop guide modules are IDENTICAL code (two-copy hazard)')
}

// ---- bundle the DESKTOP copy so the math below runs the shipped code ----
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-guide-'))
const guideFile = path.join(outDir, 'guide.mjs')
await esbuild.build({
  entryPoints: [path.join(repoRoot, 'desktop/renderer/src/guide.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: guideFile,
  logLevel: 'silent'
})
const {
  SLOT_MS, GUIDE_WINDOW_MS, MIN_CELL_W, GUIDE_PAST_MS, GUIDE_FUTURE_MS, GUIDE_ROW_INNER_H, GUIDE_ROW_MB,
  cellRect, visiblePrograms, moveFocus, snapToNow, windowFloor, windowCeil
} = await import(pathToFileURL(guideFile).href)

// ---- B. math parity — cases mirrored VERBATIM from client/__tests__/guide.test.ts ----
console.log('B. guide math parity (client guide.test.ts cases)')

const H = 3600_000
const MIN = 60_000
// A fixed, slot-aligned clock: 2026-08-09 12:00:00 UTC.
const N = Date.UTC(2026, 7, 9, 12, 0, 0)
const p = (title, start, stop) => ({ title, start, stop })
// pxPerMin 2 -> the 2 h window is exactly 240 px wide.
const PX = 2
const ROW_W = 240
const state = (focusRow, focusCellStart, windowStart) => ({ focusRow, focusCellStart, windowStart })

{
  eq(cellRect(p('a', N, N + 30 * MIN), N, PX, ROW_W), { x: 0, w: 60, clippedStart: N, clippedEnd: N + 30 * MIN }, 'cellRect: an in-window program maps start/width 1:1')

  const left = cellRect(p('a', N - 30 * MIN, N + 30 * MIN), N, PX, ROW_W)
  ok(left.x === 0 && left.w === 60 && left.clippedStart === N && left.clippedEnd === N + 30 * MIN, 'cellRect clips the left edge (program started before the window)')

  const right = cellRect(p('a', N + 90 * MIN, N + 3 * H), N, PX, ROW_W)
  ok(right.x === 180 && right.w === 60 && right.clippedEnd === N + GUIDE_WINDOW_MS, 'cellRect clips the right edge (program runs past the window)')

  const span = cellRect(p('marathon', N - 2 * H, N + 5 * H), N, PX, ROW_W)
  ok(span.x === 0 && span.w === ROW_W, 'cellRect: a program spanning the whole window fills the row exactly')

  ok(cellRect(p('short', N, N + 5 * MIN), N, PX, ROW_W).w === MIN_CELL_W, 'cellRect holds the readability minimum width')

  const tail = cellRect(p('tail', N + 118 * MIN, N + 120 * MIN), N, PX, ROW_W)
  ok(tail.x === 236 && tail.x + tail.w <= ROW_W, 'cellRect: the row edge beats the minimum (no overflow)')
}
{
  const programs = [
    p('ended-at-start', N - H, N), // stop === windowStart -> out
    p('clipped-left', N - H, N + 10 * MIN),
    p('inside', N, N + 30 * MIN),
    p('clipped-right', N + 110 * MIN, N + 3 * H),
    p('starts-at-end', N + GUIDE_WINDOW_MS, N + 3 * H) // start === windowEnd -> out
  ]
  eq(visiblePrograms(programs, N, N + GUIDE_WINDOW_MS).map((x) => x.title), ['clipped-left', 'inside', 'clipped-right'], 'visiblePrograms: overlap only — boundary-touching programs are out')
}
{
  const t = Date.UTC(2026, 7, 9, 12, 17, 3)
  const snapped = snapToNow(t)
  ok(snapped % SLOT_MS === 0 && snapped <= t && t - snapped < SLOT_MS && snapToNow(N) === N, 'snapToNow aligns to the previous half-hour (aligned input unchanged)')
}
{
  const rows = [[p('a', N - H, N), p('b', N, N + H), p('c', N + H, N + 2 * H)]]
  eq(moveFocus(state(0, N, N), 'right', { rows, now: N }), state(0, N + H, N), 'right walks to the next program start inside the window')
}
{
  const rows = [[p('b', N, N + H), p('c', N + H, N + 2 * H)]]
  eq(moveFocus(state(0, N + H, N), 'right', { rows, now: N }), state(0, N + H, N), 'right at the last program: no page while its cell ends in-window')
}
{
  const rows = [[p('x', N, N + 2 * H), p('y', N + 2 * H, N + 3 * H)]]
  eq(moveFocus(state(0, N, N), 'right', { rows, now: N }), state(0, N + 2 * H, N + SLOT_MS), 'right pages the window in slot steps to reveal the next program')
}
{
  const rows = [[p('marathon', N, N + 4 * H)]]
  eq(moveFocus(state(0, N, N), 'right', { rows, now: N }), state(0, N, N + SLOT_MS), 'right walks a long program in slot steps (no next program)')
}
{
  const ceil = windowCeil(N)
  ok(ceil === N + GUIDE_FUTURE_MS - GUIDE_WINDOW_MS, 'windowCeil = snapToNow + future horizon − window')
  const rows = [[p('marathon', N, N + 50 * H)]]
  eq(moveFocus(state(0, N, ceil), 'right', { rows, now: N }), state(0, N, ceil), 'right clamps at the future ceiling')
}
{
  const rows = [[p('p0', N - 2 * H, N - H), p('p1', N - H, N + H)]]
  eq(moveFocus(state(0, N - H, N), 'left', { rows, now: N }), state(0, N - 2 * H, N - 2 * H), 'left walks to the previous program, paging back to reveal its start')
}
{
  const rows = [[p('p', N - H, N + H)]]
  eq(moveFocus(state(0, N - H, N), 'left', { rows, now: N }), state(0, N - H, N - SLOT_MS), 'left at the first program pages one slot while its cell is clipped')
}
{
  const floor = windowFloor(N)
  ok(floor === N - GUIDE_PAST_MS, 'windowFloor = snapToNow − past horizon')
  const rows = [[p('p', N - 7 * H, N + H)]]
  eq(moveFocus(state(0, N - 7 * H, floor), 'left', { rows, now: N }), state(0, N - 7 * H, floor), 'left clamps at the past floor')
}
{
  const rows = [
    [p('a', N, N + 30 * MIN)],
    [p('b', N - H, N + 2 * H)],
    [] // guide-less
  ]
  eq(moveFocus(state(0, N, N), 'down', { rows, now: N }), state(1, N - H, N), 'down keeps the time position (the cell COVERING the anchor, real start off-window)')
  eq(moveFocus(state(1, N - H, N), 'up', { rows, now: N }), state(0, N, N), 'up anchors where the clipped cell is VISIBLE (max of start and windowStart)')
}
{
  const rows = [[p('a', N, N + H)], []]
  eq(moveFocus(state(0, N, N), 'down', { rows, now: N }), state(1, N, N), 'down into a guide-less row focuses its placeholder cell')
}
{
  // The i<0 branch: a guide-less row's placeholder IS the window — left/right page it.
  const rows = [[]]
  eq(moveFocus(state(0, N, N), 'right', { rows, now: N }), state(0, N + SLOT_MS, N + SLOT_MS), 'guide-less row: right pages the window under the placeholder')
  eq(moveFocus(state(0, N, N), 'left', { rows, now: N }), state(0, N - SLOT_MS, N - SLOT_MS), 'guide-less row: left pages the window under the placeholder')
  const floor = windowFloor(N)
  eq(moveFocus(state(0, floor, floor), 'left', { rows, now: N }), state(0, floor, floor), 'guide-less row: left clamps at the floor')
  const ceil = windowCeil(N)
  eq(moveFocus(state(0, ceil, ceil), 'right', { rows, now: N }), state(0, ceil, ceil), 'guide-less row: right clamps at the ceiling')
}
{
  // The renderer shows the same placeholder for a guided row whose data all sits
  // OUTSIDE the window, so the keys must page the same way (still the i<0 branch).
  const rows = [[p('later', N + 5 * H, N + 6 * H)]]
  eq(moveFocus(state(0, N, N), 'right', { rows, now: N }), state(0, N + SLOT_MS, N + SLOT_MS), 'a guided row with data entirely outside the window pages like a guide-less one (right)')
  eq(moveFocus(state(0, N, N), 'left', { rows, now: N }), state(0, N - SLOT_MS, N - SLOT_MS), '...and left')
}
{
  const rows = [[p('a', N, N + H)], [p('b', N, N + H)]]
  eq(moveFocus(state(0, N, N), 'up', { rows, now: N }), { exit: 'header' }, 'row 0 + up exits to the header zone')
}
{
  const rows = [[p('a', N, N + H)]]
  eq(moveFocus(state(0, N, N), 'down', { rows, now: N }), state(0, N, N), 'down at the last row is a no-op')
}

// ---- C. GuideGrid static render (markup basics) ----
console.log('C. GuideGrid markup basics (react-dom/server render of the real component)')
{
  const gridFile = path.join(outDir, 'grid.mjs')
  await esbuild.build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import { GuideGrid } from './screens/GuideScreen'",
        "import { categoryModel, channelNumbers } from './catalog'",
        'export const render = (streams, props) => renderToStaticMarkup(React.createElement(GuideGrid, {',
        '  model: categoryModel(streams),',
        "  activeKey: 'All',",
        '  onSelectCategory: () => {},',
        '  list: streams,',
        '  numbers: channelNumbers(streams),',
        '  nowMs: Date.now(),',
        '  onTune: () => {},',
        '  onBack: () => {},',
        '  ...props',
        '}))'
      ].join('\n'),
      resolveDir: path.join(repoRoot, 'desktop/renderer/src'),
      loader: 'js'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: gridFile,
    logLevel: 'silent',
    // react-dom/server is CJS and requires node builtins; esbuild's ESM require
    // shim only forwards when a real `require` is in scope — hand it one.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
  })
  const { render } = await import(pathToFileURL(gridFile).href)

  const streams = [
    { id: 'moon-cat', title: 'Moon Cat', isLive: true, epgUrl: 'https://epg.example/a.json', epgId: 'moon-cat', category: ['News'] },
    { id: 'shop-tv', title: 'Shop TV', isLive: true }
  ]
  const html = render(streams, { playingId: 'moon-cat' })

  ok(html.includes('guide-screen'), 'the grid renders the guide surface')
  ok(html.includes('GUIDE'), 'the heading is present')
  ok(html.includes('guide-now-pill') && html.includes('>NOW<'), 'the NOW pill is in the header chips')
  ok(html.includes('>ALL<') && html.includes('>NEWS<'), 'category chips render upper-cased from the model')
  eq((html.match(/guide-slot-label/g) || []).length, 4, 'the time bar carries exactly GUIDE_SLOTS labels')
  ok((html.match(/>\d\d:\d\d</g) || []).length >= 4, 'slot labels are wall-clock HH:MM')
  // Effects never run in a static render, so every row reads guide-less — exactly
  // the honest placeholder contract (D2 — no fake data).
  eq((html.match(/No program information/g) || []).length, 2, 'unloaded/guide-less rows show the honest placeholder')
  ok(html.includes('guide-row playing'), 'the playing row carries the accent class')
  ok(html.includes('>001<') && html.includes('>002<'), 'channel numbers render zero-padded in curated order')
  ok(html.includes('guide-ch-thumb'), 'the channel column reserves the thumb box')

  // No playing channel (Menu-tile entry): no accent row, and the floating NOW jump
  // only exists once the window paged away — not on the fresh snap.
  const fromMenu = render(streams, { playingId: null })
  ok(!fromMenu.includes('guide-row playing'), 'no playing channel: no accent row')
  ok(!fromMenu.includes('guide-now-float'), 'freshly snapped to now: no floating jump control')
}

fs.rmSync(outDir, { recursive: true, force: true })

// ---- D. styles.css pins (desktop keeps geometry in CSS, not StyleSheets) ----
console.log('D. styles.css pins')
{
  const css = fs.readFileSync(path.join(repoRoot, 'desktop/renderer/src/styles.css'), 'utf8')
  ok(GUIDE_ROW_INNER_H === 62 && GUIDE_ROW_MB === 2, 'guide.ts row unit is 62 + 2 (the client values)')
  ok(/\.guide-row\s*\{[^}]*height:\s*62px/.test(css) && /\.guide-row\s*\{[^}]*margin-bottom:\s*2px/.test(css), 'guide row pinned at 62px + 2px gap (GUIDE_ROW_INNER_H/GUIDE_ROW_MB — the scroll-slice unit)')
  ok(/\.guide-strip\s*\{[^}]*height:\s*62px/.test(css) && /\.guide-cell\s*\{[^}]*height:\s*62px/.test(css), 'strip and cells share the pinned row height')
  ok(/\.guide-ch-thumb\s*\{[^}]*width:\s*96px;\s*height:\s*54px/.test(css), 'guide channel thumb is 96x54 (the client TV column)')
  ok(/\.guide-ch-thumb\.thumb\s*\{[^}]*object-fit:\s*cover/.test(css), 'a live frame fills the box (cover), the logo stays contain')
  ok(/\.guide-cell-hairline\s*\{[^}]*position:\s*absolute[^}]*bottom:\s*4px/.test(css), 'the hairline has its slot inside guide cells (absolute, bottom)')
  ok(/\.guide-cell\.focused\s*\{[^}]*var\(--c-focus-fill\)/.test(css), 'focused cell takes the light fill (the .focused grammar)')
  ok(/\.guide-cell\.past\s+\.guide-cell-title[^{]*\{[^}]*opacity:\s*0\.5/.test(css), 'past programs dim to 0.5 (the client cellPast)')
  ok(/\.guide-now-float\s*\{[^}]*position:\s*absolute/.test(css), 'the floating NOW jump control exists')
}

if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1) }
console.log('\ndesktop-guide: ALL PASS')
