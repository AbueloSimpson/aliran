// Guide-grid logic (WS4): geometry + the virtual-focus reducer for the full EPG
// guide screen. Pure functions over the SDK's EpgProgram (epoch-ms start/stop —
// see sdk/react-native/src/epg.ts), react-free so the twin lane
// (tools/desktop-guide-test.mjs) covers them like vod-sort.ts. Desktop has no TV
// focus rig — moveFocus drives the keyboard (Arrow keys) identically, and the same
// reducer also backs the wheel's horizontal paging. MIRRORED in client/src/guide.ts
// — keep the two copies in step.

import type { EpgProgram } from '../../../sdk/react-native/src/epg'

/** One time slot — the grid's paging unit and time-bar label cadence. */
export const SLOT_MIN = 30
export const SLOT_MS = SLOT_MIN * 60_000

/** Visible window: 4 slots (2 h) across the program strip. */
export const GUIDE_SLOTS = 4
export const GUIDE_WINDOW_MIN = GUIDE_SLOTS * SLOT_MIN
export const GUIDE_WINDOW_MS = GUIDE_SLOTS * SLOT_MS

// How far the window may page — the SDK's getPrograms default range (now − 6 h …
// now + 48 h). Paging past it would show slots the data layer never fills.
export const GUIDE_PAST_MS = 6 * 3600_000
export const GUIDE_FUTURE_MS = 48 * 3600_000

// Fixed TV grid row height (thumb 54 + padding, + the 2px row gap) — the FlatList
// getItemLayout unit, same exact-height discipline as CHANNEL_ROW_H / VOD_ROW_H.
export const GUIDE_ROW_INNER_H = 62
export const GUIDE_ROW_MB = 2
export const GUIDE_ROW_H = GUIDE_ROW_INNER_H + GUIDE_ROW_MB

/** A cell never narrows below this (px) — a 5-minute program still shows a sliver
 *  of title instead of an unreadable hairline. */
export const MIN_CELL_W = 48

export interface CellRect {
  x: number
  w: number
  /** The program's start/stop clamped to the window — what the cell actually shows. */
  clippedStart: number
  clippedEnd: number
}

/** Absolute-position rect for one program cell inside a strip of `rowWidth` px
 *  showing the window starting at `windowStart`. Clips both edges to the window;
 *  holds MIN_CELL_W where it fits (the right edge wins over the minimum — a cell
 *  may not overflow the row). A program spanning the whole window fills it. */
export function cellRect (program: EpgProgram, windowStart: number, pxPerMin: number, rowWidth: number): CellRect {
  const windowEnd = windowStart + GUIDE_WINDOW_MS
  const clippedStart = Math.max(program.start, windowStart)
  const clippedEnd = Math.min(program.stop, windowEnd)
  const x = Math.max(0, Math.round(((clippedStart - windowStart) / 60_000) * pxPerMin))
  let w = Math.round(((clippedEnd - clippedStart) / 60_000) * pxPerMin)
  if (w < MIN_CELL_W) w = MIN_CELL_W
  if (x + w > rowWidth) w = Math.max(0, rowWidth - x)
  return { x, w, clippedStart, clippedEnd }
}

/** The programs overlapping [windowStart, windowEnd) — a program merely touching a
 *  boundary (stop === windowStart, or start === windowEnd) is NOT in the window.
 *  Feeds can carry fully-duplicate entries (same start AND stop — seen in prod);
 *  the input is sorted by start, so consecutive-equal spans collapse to one cell
 *  here, keeping cell keys unique and the grid free of stacked twins. */
export function visiblePrograms (programs: EpgProgram[], windowStart: number, windowEnd: number): EpgProgram[] {
  const out: EpgProgram[] = []
  for (const p of programs) {
    if (!(p.stop > windowStart && p.start < windowEnd)) continue
    const prev = out[out.length - 1]
    if (prev && prev.start === p.start && prev.stop === p.stop) continue
    out.push(p)
  }
  return out
}

/** windowStart aligned to the previous half-hour (the NOW pill's reset). */
export function snapToNow (now: number): number {
  return now - (now % SLOT_MS)
}

/** Lowest windowStart the grid may page to (aligned — snapToNow is slot-aligned and
 *  the horizon is a whole number of slots). */
export function windowFloor (now: number): number {
  return snapToNow(now) - GUIDE_PAST_MS
}

/** Highest windowStart — the LAST slot still ends at the future horizon. */
export function windowCeil (now: number): number {
  return snapToNow(now) + GUIDE_FUTURE_MS - GUIDE_WINDOW_MS
}

export interface GuideFocus {
  focusRow: number
  /** The focused PROGRAM's real start (epoch ms) — may sit before windowStart when
   *  the cell is clipped. A guide-less row focuses its single placeholder cell:
   *  focusCellStart === windowStart. */
  focusCellStart: number
  windowStart: number
}

export type GuideDir = 'up' | 'down' | 'left' | 'right'

export interface GuideMoveCtx {
  /** Per-row program lists, sorted by start ([] = guide-less / not yet loaded). */
  rows: EpgProgram[][]
  now: number
}

/** moveFocus result: the next state, or the marker that focus LEAVES the grid
 *  upward into the header zone (category chips / NOW pill — native focus there). */
export type GuideMove = GuideFocus | { exit: 'header' }

// The cell holding the focus in this row: exact program-start match first (that is
// what the reducer stores), else the program airing over the focus position, else
// the first program visible in the window. -1 = nothing focusable.
function cellIndex (programs: EpgProgram[], focusCellStart: number, windowStart: number): number {
  let i = programs.findIndex((p) => p.start === focusCellStart)
  if (i >= 0) return i
  const at = Math.max(focusCellStart, windowStart)
  i = programs.findIndex((p) => p.start <= at && at < p.stop)
  if (i >= 0) return i
  return programs.findIndex((p) => p.stop > windowStart && p.start < windowStart + GUIDE_WINDOW_MS)
}

/** The D-pad reducer. left/right walk program starts within the row, paging
 *  windowStart in SLOT_MIN steps at the window edges (clamped to the floor/ceiling
 *  horizons); up/down move rows keeping the time position (the cell overlapping the
 *  current one in the next row); row 0 + up exits to the header. A guide-less row
 *  has one placeholder cell spanning the window — left/right page the window under
 *  it. Always returns a value, never throws: an impossible move returns `state`. */
/**
 * Move the focus by `delta` ROWS, keeping the time position — the one place that rule
 * lives, so the D-pad's single steps and the CHANNEL keys' page jumps cannot drift apart.
 *
 * CLAMPS rather than exits: running off either end holds at the first/last row. That is
 * the difference between the two callers — a single UP off row 0 leaves for the header
 * (moveFocus decides that before calling here), but a PAGE up is a scroll, and a scroll
 * that threw the viewer out of the grid would be a trap.
 */
export function moveRows (state: GuideFocus, delta: number, ctx: GuideMoveCtx): GuideFocus {
  const { rows } = ctx
  const { windowStart } = state
  const last = Math.max(rows.length - 1, 0)
  const target = Math.min(Math.max(state.focusRow + delta, 0), last)
  if (target === state.focusRow) return state
  const programs = rows[target] ?? []
  // Keep the time position: the anchor is where the focused cell is VISIBLE (a clipped
  // cell's real start sits off-window — the viewer is looking at its in-window part).
  const anchor = Math.max(state.focusCellStart, windowStart)
  const hit = programs.find((p) => p.start <= anchor && anchor < p.stop) ??
    programs.find((p) => p.stop > windowStart && p.start < windowStart + GUIDE_WINDOW_MS)
  return { focusRow: target, focusCellStart: hit ? hit.start : windowStart, windowStart }
}

export function moveFocus (state: GuideFocus, dir: GuideDir, ctx: GuideMoveCtx): GuideMove {
  const { rows, now } = ctx
  const { focusRow, windowStart } = state

  if (dir === 'up' || dir === 'down') {
    const nextRow = dir === 'up' ? focusRow - 1 : focusRow + 1
    // Walking off the TOP leaves for the header; off the bottom simply stops.
    if (nextRow < 0) return { exit: 'header' }
    if (nextRow >= rows.length) return state
    return moveRows(state, dir === 'up' ? -1 : 1, ctx)
  }

  const programs = rows[focusRow] ?? []
  const floor = windowFloor(now)
  const ceil = windowCeil(now)

  const i = programs.length ? cellIndex(programs, state.focusCellStart, windowStart) : -1

  if (i < 0) {
    // Guide-less row — or a guided row whose data all sits OUTSIDE the window (the
    // renderer shows the same placeholder cell either way, so the keys must page the
    // same way): the placeholder IS the window — left/right page it.
    const step = dir === 'left' ? -SLOT_MS : SLOT_MS
    const ws = Math.min(Math.max(windowStart + step, floor), ceil)
    if (ws === windowStart) return state
    return { focusRow, focusCellStart: ws, windowStart: ws }
  }

  if (dir === 'left') {
    const target = i > 0 ? programs[i - 1] : null
    if (!target) {
      // First program of the row. Its cell may still be CLIPPED at the left edge —
      // page the window back a slot to see more of it; at the floor, stay put.
      const cur = programs[Math.max(i, 0)]
      if (cur && cur.start < windowStart && windowStart > floor) {
        return { ...state, windowStart: Math.max(floor, windowStart - SLOT_MS) }
      }
      return state
    }
    // Reveal the target's start when it sits left of the window (slot steps).
    let ws = windowStart
    while (target.start < ws && ws > floor) ws -= SLOT_MS
    return { focusRow, focusCellStart: target.start, windowStart: Math.max(ws, floor) }
  }

  // right
  const target = i >= 0 && i + 1 < programs.length ? programs[i + 1] : null
  if (!target) {
    // Last program of the row. A long program running past the window is walked in
    // slot steps; at the ceiling (or when the cell already ends in-window), stay.
    const cur = i >= 0 ? programs[i] : null
    if (cur && cur.stop > windowStart + GUIDE_WINDOW_MS && windowStart < ceil) {
      return { ...state, windowStart: Math.min(ceil, windowStart + SLOT_MS) }
    }
    return state
  }
  // Page forward until the target's start is inside the window (slot steps).
  let ws = windowStart
  while (target.start >= ws + GUIDE_WINDOW_MS && ws < ceil) ws += SLOT_MS
  return { focusRow, focusCellStart: target.start, windowStart: Math.min(ws, ceil) }
}
