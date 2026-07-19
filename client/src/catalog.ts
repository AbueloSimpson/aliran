// Catalog shaping shared by the browse surfaces: curation sort, hero pick, category
// grouping, derived channel numbers. Pure functions over the SDK's display list.
//
// Curation comes from the panel (S16a/S16c): `order` (0-9999, lower first, null/absent
// last) and `featured` (hero / menu-wallpaper pick). Channel numbers are DERIVED from
// the curated sort (1..N), never stored — see the S18 design reference (D3).

import type { Stream } from './worklet'

// Panel curation sort: (order ?? Infinity, title). Stable for equal keys.
export function sortByCuration (streams: Stream[]): Stream[] {
  return [...streams].sort((a, b) => {
    const ao = a.order ?? Infinity
    const bo = b.order ?? Infinity
    if (ao !== bo) return ao - bo
    return (a.title || '').localeCompare(b.title || '')
  })
}

// Hero / wallpaper pick: first featured live ?? first live ?? first (curated order).
export function pickHero (streams: Stream[]): Stream | undefined {
  const sorted = sortByCuration(streams)
  return sorted.find(s => s.featured && s.isLive) ?? sorted.find(s => s.isLive) ?? sorted[0]
}

// Two-level categories: a category string may be hierarchical, "Parent/Sub" (e.g.
// "Anime/Español"). The part before the first "/" is the top-level rail entry; the
// remainder is a sub-category shown when you drill into that parent.
export const SUBCAT_SEP = '/'

// "Anime/Español" -> ["Anime", "Español"]; "Anime" -> ["Anime", undefined].
export function splitCategory (c: string): [string, string | undefined] {
  const i = c.indexOf(SUBCAT_SEP)
  if (i < 0) return [c.trim(), undefined]
  return [c.slice(0, i).trim(), c.slice(i + 1).trim() || undefined]
}

// The label to show for a category key: the sub name if hierarchical, else the key.
export function subLabel (key: string): string {
  const [, sub] = splitCategory(key)
  return sub ?? key
}

export interface CategoryModel {
  /** Rail level 0, in order: ['All', <top-level parents in first-seen curated order>]. */
  top: string[]
  /** parent -> its full sub-category keys, e.g. 'Anime' -> ['Anime/Español', …]. Only parents that HAVE subs appear. */
  subs: Record<string, string[]>
  /** key -> curation-sorted channels. Keys: 'All' (everything), each parent (union of its
   *  direct + all subs, so P2P and CDN mix there), and each full sub key. */
  groups: Record<string, Stream[]>
}

// Build the whole category tree in one pass. 'All' is the everything-rail pinned FIRST;
// a channel tagged "Anime/Español" lands in BOTH the 'Anime' parent group and the
// 'Anime/Español' sub group. Uncategorized channels live only in 'All'.
export function categoryModel (streams: Stream[]): CategoryModel {
  const sorted = sortByCuration(streams)
  const groups: Record<string, Stream[]> = { All: sorted }
  const top: string[] = ['All']
  const topSeen = new Set(['All'])
  const subs: Record<string, string[]> = {}
  const subSeen: Record<string, Set<string>> = {}
  for (const s of sorted) {
    for (const c of s.category ?? []) {
      if (!c || c === 'All') continue
      const [parent, sub] = splitCategory(c)
      if (!topSeen.has(parent)) { topSeen.add(parent); top.push(parent) }
      ;(groups[parent] ??= []).push(s)
      if (sub) {
        ;(groups[c] ??= []).push(s)
        subSeen[parent] ??= new Set()
        if (!subSeen[parent].has(c)) { subSeen[parent].add(c); (subs[parent] ??= []).push(c) }
      }
    }
  }
  return { top, subs, groups }
}

// Back-compat flat grouping (search, tests): parent + full-sub keys, curation-sorted.
export function groupByCategory (streams: Stream[]): Record<string, Stream[]> {
  return categoryModel(streams).groups
}

// Derived channel numbers (D3): curated sort over the WHOLE catalog -> 1..N. The same
// stream keeps its number in every category group. Zero-pad for the 10-foot list.
export function channelNumbers (streams: Stream[]): Map<string, number> {
  const map = new Map<string, number>()
  sortByCuration(streams).forEach((s, i) => map.set(s.id, i + 1))
  return map
}

export function formatChannelNumber (n: number | undefined): string {
  if (!n) return '—'
  return String(n).padStart(3, '0')
}
