// VOD list shaping — sorting, the A–Z buckets and the tile label (S54b, design D4/D5/D8).
//
// The PROVIDER has exactly one order (newest-added first) and no query API, so every
// ordering the mockup offers is done here, in memory, over the already-downloaded list.
// This module is deliberately pure: no React, no backend, no provider — screens call
// `sortItems` inside a useMemo and the desktop twin (S54d) mirrors the same rules.
//
// The sort set is the MOCKUP's, not a superset: Recently added (default) / A-Z /
// Newest releases / Oldest releases / Recently watched. There is no Z–A.

import type { VodItem } from './zencontent'
import type { VodHistoryEntry } from '@aliran/react-native'

export type VodSortKey = 'added' | 'az' | 'yearDesc' | 'yearAsc' | 'watched'

export interface VodSortOption { key: VodSortKey; label: string }

/** The menu, in the order the SortMenu renders it. English only (S54 user decision:
 *  no i18n machinery in this segment). */
export const VOD_SORTS: readonly VodSortOption[] = [
  { key: 'added', label: 'Recently added' },
  { key: 'az', label: 'A-Z' },
  { key: 'yearDesc', label: 'Newest releases' },
  { key: 'yearAsc', label: 'Oldest releases' },
  { key: 'watched', label: 'Recently watched' }
]

export const DEFAULT_SORT: VodSortKey = 'added'

export function sortLabel (key: VodSortKey): string {
  return VOD_SORTS.find((o) => o.key === key)?.label ?? VOD_SORTS[0].label
}

/** Case- and diacritic-insensitive fold ("Sick Girl" ≡ "sick girl", "Amélie" ≡
 *  "amelie"). Hermes ships String.normalize; the try/catch keeps a stale runtime
 *  without it working (it just stops folding accents). */
// Combining diacritical marks (U+0300–U+036F), assembled with fromCharCode so the
// source file carries no bare combining characters — written literally they attach
// themselves to the preceding bracket in most editors and diff viewers.
const COMBINING_MARKS = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036F) + ']', 'g')

export function fold (s: string): string {
  const lower = (s || '').toLowerCase()
  try { return lower.normalize('NFD').replace(COMBINING_MARKS, '') } catch { return lower }
}

/** A year the UI can order by. The provider states years as strings and uses "0" (and
 *  '') for "unknown" — those sort LAST in BOTH directions, because a wall of unknowns
 *  at the top is not what "oldest releases" means to anyone. */
function yearOf (it: VodItem): number {
  const n = Number(it.anio)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** id -> the newest `at` in the watch history that counts for it. An EPISODE entry
 *  counts for its parent series (seriesId), which is how a series shows up under
 *  "Recently watched" even though a series itself never plays. */
export function watchedAt (history?: readonly VodHistoryEntry[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const h of history || []) {
    if (!h || typeof h.id !== 'string') continue
    const id = h.kind === 'episode' ? (h.seriesId || h.id) : h.id
    if (!id) continue
    const at = Number(h.at) || 0
    if (at > (out.get(id) ?? 0)) out.set(id, at)
  }
  return out
}

/** Order `items` by `key`. NEVER mutates the input (the provider list is cached and
 *  shared by every tab). `added` is the provider's own order, so it is a plain copy.
 *  Ties everywhere fall back to that provider order, which keeps the grid stable when
 *  a viewer flips sorts back and forth. */
export function sortItems (items: readonly VodItem[], key: VodSortKey, history?: readonly VodHistoryEntry[]): VodItem[] {
  const out = items.slice()
  if (key === 'added') return out

  // Provider-order rank, for deterministic tie-breaks.
  const rank = new Map<string, number>()
  items.forEach((it, i) => { if (!rank.has(it.id)) rank.set(it.id, i) })
  const byRank = (a: VodItem, b: VodItem) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)

  if (key === 'az') {
    out.sort((a, b) => {
      const fa = fold(a.name)
      const fb = fold(b.name)
      if (fa < fb) return -1
      if (fa > fb) return 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    return out
  }

  if (key === 'yearDesc' || key === 'yearAsc') {
    out.sort((a, b) => {
      const ya = yearOf(a)
      const yb = yearOf(b)
      if (ya === 0 || yb === 0) {
        if (ya === yb) return byRank(a, b)
        return ya === 0 ? 1 : -1 // unknown year last, whichever direction we are going
      }
      if (ya !== yb) return key === 'yearDesc' ? yb - ya : ya - yb
      return byRank(a, b)
    })
    return out
  }

  // 'watched': most recently watched first, everything never watched behind it in the
  // provider's own order (an unwatched catalog therefore looks exactly like `added`).
  const seen = watchedAt(history)
  out.sort((a, b) => {
    const wa = seen.get(a.id) ?? 0
    const wb = seen.get(b.id) ?? 0
    if (wa !== wb) return wb - wa
    return byRank(a, b)
  })
  return out
}

// ---------------------------------------------------------------------------
// A–Z rail buckets (D5)
// ---------------------------------------------------------------------------

/** The rail letter a title belongs under. Anything that does not start with a–z
 *  (digits, "#Alive", punctuation, CJK) buckets under '#'. */
export function letterOf (name: string): string {
  const c = fold(name).trim().charAt(0)
  return c >= 'a' && c <= 'z' ? c.toUpperCase() : '#'
}

export interface AlphaBucket {
  letter: string
  /** Index of that letter's FIRST item in the list handed in. */
  index: number
}

/** Rail buckets for an ALREADY-SORTED list, in the list's own order — so '#' comes
 *  out first for free (folded non-letters sort below 'a'), and the rail can never
 *  point at a letter the grid does not actually contain. */
export function letterBuckets (items: readonly VodItem[]): AlphaBucket[] {
  const out: AlphaBucket[] = []
  const seen = new Set<string>()
  items.forEach((it, i) => {
    const l = letterOf(it.name)
    if (seen.has(l)) return
    seen.add(l)
    out.push({ letter: l, index: i })
  })
  return out
}

// ---------------------------------------------------------------------------
// Tile label (D8)
// ---------------------------------------------------------------------------

// Provider names usually already carry the year ("Sick Girl (2023)"); appending a
// second one reads as a bug. Only titles WITHOUT a trailing "(dddd)" get one, and only
// when the provider actually stated a year (series with no aired_first have none — D2).
const YEAR_SUFFIX = /\(\d{4}\)\s*$/

/** The single line of text under a poster: "Name (Year)". */
export function titleWithYear (item: Pick<VodItem, 'name' | 'anio'>): string {
  const name = item.name || ''
  if (!item.anio || YEAR_SUFFIX.test(name)) return name
  return `${name} (${item.anio})`
}
