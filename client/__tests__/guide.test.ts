// Guide-grid logic (WS3): cell geometry (clipping, min-width, full-span), the
// window overlap filter, the virtual D-pad reducer (slot paging at the window edges
// with floor/ceiling clamps, time-position-preserving row moves, the header exit,
// guide-less rows), and the NOW snap. Pure functions, injected clocks — the
// catalog.test.ts discipline.

import {
  SLOT_MS, GUIDE_WINDOW_MS, MIN_CELL_W, GUIDE_PAST_MS, GUIDE_FUTURE_MS,
  cellRect, visiblePrograms, moveFocus, snapToNow, windowFloor, windowCeil,
  type GuideFocus
} from '../src/guide'
import type { EpgProgram } from '@aliran/react-native'

const H = 3600_000
const MIN = 60_000

// A fixed, slot-aligned clock: 2026-08-09 12:00:00 UTC.
const N = Date.UTC(2026, 7, 9, 12, 0, 0)

const p = (title: string, start: number, stop: number): EpgProgram => ({ title, start, stop })

// --- cellRect ---------------------------------------------------------------

// pxPerMin 2 → the 2 h window is exactly 240 px wide.
const PX = 2
const ROW_W = 240

test('cellRect: an in-window program maps start/width 1:1', () => {
  const r = cellRect(p('a', N, N + 30 * MIN), N, PX, ROW_W)
  expect(r).toEqual({ x: 0, w: 60, clippedStart: N, clippedEnd: N + 30 * MIN })
})

test('cellRect clips the left edge (program started before the window)', () => {
  const r = cellRect(p('a', N - 30 * MIN, N + 30 * MIN), N, PX, ROW_W)
  expect(r.x).toBe(0)
  expect(r.w).toBe(60) // only the in-window half
  expect(r.clippedStart).toBe(N)
  expect(r.clippedEnd).toBe(N + 30 * MIN)
})

test('cellRect clips the right edge (program runs past the window)', () => {
  const r = cellRect(p('a', N + 90 * MIN, N + 3 * H), N, PX, ROW_W)
  expect(r.x).toBe(180)
  expect(r.w).toBe(60)
  expect(r.clippedEnd).toBe(N + GUIDE_WINDOW_MS)
})

test('cellRect: a program spanning the whole window fills the row exactly', () => {
  const r = cellRect(p('marathon', N - 2 * H, N + 5 * H), N, PX, ROW_W)
  expect(r.x).toBe(0)
  expect(r.w).toBe(ROW_W)
})

test('cellRect holds the readability minimum width', () => {
  const r = cellRect(p('short', N, N + 5 * MIN), N, PX, ROW_W)
  expect(r.w).toBe(MIN_CELL_W) // 10 px of real width, widened to stay readable
})

test('cellRect: the row edge beats the minimum (no overflow)', () => {
  const r = cellRect(p('tail', N + 118 * MIN, N + 120 * MIN), N, PX, ROW_W)
  expect(r.x).toBe(236)
  expect(r.x + r.w).toBeLessThanOrEqual(ROW_W)
})

// --- visiblePrograms --------------------------------------------------------

test('visiblePrograms: overlap only — boundary-touching programs are out', () => {
  const programs = [
    p('ended-at-start', N - H, N), // stop === windowStart → out
    p('clipped-left', N - H, N + 10 * MIN),
    p('inside', N, N + 30 * MIN),
    p('clipped-right', N + 110 * MIN, N + 3 * H),
    p('starts-at-end', N + GUIDE_WINDOW_MS, N + 3 * H) // start === windowEnd → out
  ]
  const v = visiblePrograms(programs, N, N + GUIDE_WINDOW_MS)
  expect(v.map((x) => x.title)).toEqual(['clipped-left', 'inside', 'clipped-right'])
})

test('visiblePrograms: fully-duplicate entries collapse to one cell (prod feeds carry them)', () => {
  const programs = [
    p('dup', N, N + 30 * MIN),
    p('dup again', N, N + 30 * MIN), // same start AND stop → dropped (key uniqueness)
    p('after', N + 30 * MIN, N + H),
    p('after twin', N + 30 * MIN, N + H)
  ]
  const v = visiblePrograms(programs, N, N + GUIDE_WINDOW_MS)
  expect(v.map((x) => x.title)).toEqual(['dup', 'after'])
})

// --- snapToNow --------------------------------------------------------------

test('snapToNow aligns to the previous half-hour', () => {
  const t = Date.UTC(2026, 7, 9, 12, 17, 3)
  const snapped = snapToNow(t)
  expect(snapped % SLOT_MS).toBe(0)
  expect(snapped).toBeLessThanOrEqual(t)
  expect(t - snapped).toBeLessThan(SLOT_MS)
  expect(snapToNow(N)).toBe(N) // already aligned → unchanged
})

// --- moveFocus --------------------------------------------------------------

const state = (focusRow: number, focusCellStart: number, windowStart: number): GuideFocus =>
  ({ focusRow, focusCellStart, windowStart })

test('right walks to the next program start inside the window', () => {
  const rows = [[p('a', N - H, N), p('b', N, N + H), p('c', N + H, N + 2 * H)]]
  const r = moveFocus(state(0, N, N), 'right', { rows, now: N })
  expect(r).toEqual(state(0, N + H, N))
})

test('right at the last program: no page while its cell ends in-window', () => {
  const rows = [[p('b', N, N + H), p('c', N + H, N + 2 * H)]]
  const r = moveFocus(state(0, N + H, N), 'right', { rows, now: N })
  expect(r).toEqual(state(0, N + H, N)) // c stops exactly at the window end
})

test('right pages the window in slot steps to reveal the next program', () => {
  const rows = [[p('x', N, N + 2 * H), p('y', N + 2 * H, N + 3 * H)]]
  const r = moveFocus(state(0, N, N), 'right', { rows, now: N })
  expect(r).toEqual(state(0, N + 2 * H, N + SLOT_MS)) // one slot forward puts y's start in view
})

test('right walks a long program in slot steps (no next program)', () => {
  const rows = [[p('marathon', N, N + 4 * H)]]
  const r = moveFocus(state(0, N, N), 'right', { rows, now: N })
  expect(r).toEqual(state(0, N, N + SLOT_MS)) // window advances, focus stays on the program
})

test('right clamps at the future ceiling', () => {
  const ceil = windowCeil(N)
  expect(ceil).toBe(N + GUIDE_FUTURE_MS - GUIDE_WINDOW_MS)
  const rows = [[p('marathon', N, N + 50 * H)]]
  const r = moveFocus(state(0, N, ceil), 'right', { rows, now: N })
  expect(r).toEqual(state(0, N, ceil)) // already at the ceiling → no-op
})

test('left walks to the previous program, paging back to reveal its start', () => {
  const rows = [[p('p0', N - 2 * H, N - H), p('p1', N - H, N + H)]]
  const r = moveFocus(state(0, N - H, N), 'left', { rows, now: N })
  expect(r).toEqual(state(0, N - 2 * H, N - 2 * H)) // slot-stepped down to p0's start
})

test('left at the first program pages one slot while its cell is clipped', () => {
  const rows = [[p('p', N - H, N + H)]]
  const r = moveFocus(state(0, N - H, N), 'left', { rows, now: N })
  expect(r).toEqual(state(0, N - H, N - SLOT_MS))
})

test('left clamps at the past floor', () => {
  const floor = windowFloor(N)
  expect(floor).toBe(N - GUIDE_PAST_MS)
  const rows = [[p('p', N - 7 * H, N + H)]]
  const r = moveFocus(state(0, N - 7 * H, floor), 'left', { rows, now: N })
  expect(r).toEqual(state(0, N - 7 * H, floor)) // at the floor → no-op
})

test('up/down keep the time position (the cell overlapping the focus)', () => {
  const rows = [
    [p('a', N, N + 30 * MIN)],
    [p('b', N - H, N + 2 * H)],
    [] // guide-less
  ]
  // down from a (starts at N) lands on b — the program COVERING N in row 1, even
  // though its real start sits before the window.
  const down = moveFocus(state(0, N, N), 'down', { rows, now: N })
  expect(down).toEqual(state(1, N - H, N))
  // up from b: the anchor is where b is VISIBLE (max of start and windowStart) → a.
  const up = moveFocus(state(1, N - H, N), 'up', { rows, now: N })
  expect(up).toEqual(state(0, N, N))
})

test('down into a guide-less row focuses its placeholder cell', () => {
  const rows = [[p('a', N, N + H)], []]
  const r = moveFocus(state(0, N, N), 'down', { rows, now: N })
  expect(r).toEqual(state(1, N, N)) // placeholder: focusCellStart === windowStart
})

test('guide-less row: left/right page the window under the placeholder', () => {
  const rows = [[]] as EpgProgram[][]
  const right = moveFocus(state(0, N, N), 'right', { rows, now: N })
  expect(right).toEqual(state(0, N + SLOT_MS, N + SLOT_MS))
  const left = moveFocus(state(0, N, N), 'left', { rows, now: N })
  expect(left).toEqual(state(0, N - SLOT_MS, N - SLOT_MS))
  // and both clamp at the horizons
  const floor = windowFloor(N)
  expect(moveFocus(state(0, floor, floor), 'left', { rows, now: N })).toEqual(state(0, floor, floor))
  const ceil = windowCeil(N)
  expect(moveFocus(state(0, ceil, ceil), 'right', { rows, now: N })).toEqual(state(0, ceil, ceil))
})

test('a guided row with data entirely OUTSIDE the window pages like a guide-less one', () => {
  // The renderer shows the same placeholder cell for both, so the keys must not go
  // dead just because the row HAS a schedule somewhere off-screen.
  const rows = [[p('later', N + 5 * H, N + 6 * H)]]
  const right = moveFocus(state(0, N, N), 'right', { rows, now: N })
  expect(right).toEqual(state(0, N + SLOT_MS, N + SLOT_MS))
  const left = moveFocus(state(0, N, N), 'left', { rows, now: N })
  expect(left).toEqual(state(0, N - SLOT_MS, N - SLOT_MS))
})

test('row 0 + up exits to the header zone', () => {
  const rows = [[p('a', N, N + H)], [p('b', N, N + H)]]
  expect(moveFocus(state(0, N, N), 'up', { rows, now: N })).toEqual({ exit: 'header' })
})

test('down at the last row is a no-op', () => {
  const rows = [[p('a', N, N + H)]]
  expect(moveFocus(state(0, N, N), 'down', { rows, now: N })).toEqual(state(0, N, N))
})
