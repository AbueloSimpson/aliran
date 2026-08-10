// Catalog shaping shared by the browse surfaces: curation sort, hero pick, category
// grouping, derived channel numbers. Pure functions over the SDK's display list.
//
// Curation comes from the panel (S16a/S16c): `order` (0-9999, lower first, null/absent
// last) and `featured` (hero / menu-wallpaper pick). Channel numbers are DERIVED from
// the curated sort (1..N), never stored — see the S18 design reference (D3).

import { getLocale } from '@aliran/i18n'
import type { Stream } from './worklet'

// MEMOIZATION (S22 round 8, measured): with a large vod library these derivations
// cost seconds of JS on a phone — the profiler clocked ~3.4 s of mqt_js per guide
// open, all curation sort + grouping over the full catalog. The input array is one
// reference per 'streams' message (and visibleStreams memoizes its output identity),
// so a WeakMap keyed on the array pays each derivation ONCE per catalog update and
// every later mount is O(1). The locale rides the key: the title tie-break collates
// in the viewer's locale, so a language switch must recompute.
interface Keyed<T> { locale: string; out: T }
function memo1<T> (cache: WeakMap<Stream[], Keyed<T>>, streams: Stream[], compute: () => T): T {
  const locale = getLocale()
  const hit = cache.get(streams)
  if (hit && hit.locale === locale) return hit.out
  const out = compute()
  cache.set(streams, { locale, out })
  return out
}
const curationCache = new WeakMap<Stream[], Keyed<Stream[]>>()
const modelCache = new WeakMap<Stream[], Keyed<CategoryModel>>()
const zapCache = new WeakMap<Stream[], Keyed<Stream[]>>()
const numbersCache = new WeakMap<Stream[], Keyed<Map<string, number>>>()

// Panel curation sort: (order ?? Infinity, title). Stable for equal keys.
// The title tie-break sorts in the VIEWER's locale (S56 design D9): collation is not
// universal — Swedish files "ä" after "z", Turkish files "ı" before "i" — and the list
// a viewer scans should be alphabetical to THEM. Engines without a real collator ignore
// the argument and fall back to code-point order, which is what they did before.
export function sortByCuration (streams: Stream[]): Stream[] {
  return memo1(curationCache, streams, () => [...streams].sort((a, b) => {
    const ao = a.order ?? Infinity
    const bo = b.order ?? Infinity
    if (ao !== bo) return ao - bo
    return (a.title || '').localeCompare(b.title || '', getLocale())
  }))
}

// Hero / wallpaper pick: first featured live ?? first live ?? first channel ?? first.
// vod titles are on-demand — never auto-played as the hero while any channel exists.
export function pickHero (streams: Stream[]): Stream | undefined {
  const sorted = sortByCuration(streams)
  return sorted.find(s => s.featured && s.isLive) ?? sorted.find(s => s.isLive) ?? sorted.find(s => !isVod(s)) ?? sorted[0]
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
  return memo1(modelCache, streams, () => computeCategoryModel(streams))
}

function computeCategoryModel (streams: Stream[]): CategoryModel {
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

// A vod library title (S8a). Everything channel-shaped — numbers, CH+/CH- zap,
// LIVE badges, EPG — applies only to the rest of the catalog.
export function isVod (s: Stream): boolean {
  return s.type === 'vod'
}

// The channel ring CH+/CH- walks (and the numbers follow): curated order over the
// LIVE catalog only. vod titles are on-demand — they neither take a channel number
// (adding movies must not renumber the lineup) nor sit in the zap ring.
export function zapOrder (streams: Stream[]): Stream[] {
  // The filter output is a fresh array, so the curation cache can't help through
  // it — cache on the INPUT array instead (one zap ring per catalog update).
  return memo1(zapCache, streams, () => sortByCuration(streams.filter(s => !isVod(s))))
}

// Derived channel numbers (D3): curated sort over the live catalog -> 1..N. The same
// stream keeps its number in every category group; vod titles have none. Zero-pad
// for the 10-foot list.
export function channelNumbers (streams: Stream[]): Map<string, number> {
  return memo1(numbersCache, streams, () => {
    const map = new Map<string, number>()
    zapOrder(streams).forEach((s, i) => map.set(s.id, i + 1))
    return map
  })
}

export function formatChannelNumber (n: number | undefined): string {
  if (!n) return '—'
  return String(n).padStart(3, '0')
}

// "1:32:05" / "23:45" from a vod record's durationSec (null/absent/broken -> '').
export function formatDuration (sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return ''
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
