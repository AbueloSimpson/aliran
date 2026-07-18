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

// Group into category rails/groups (a stream in N categories appears in N groups),
// each group curation-sorted. 'All' is a real everything-rail pinned FIRST (every
// channel, so P2P and CDN mix there regardless of genre); the genre categories
// follow in first-seen (curated) order. Uncategorized channels live only in 'All'.
export function groupByCategory (streams: Stream[]): Record<string, Stream[]> {
  const sorted = sortByCuration(streams)
  const out: Record<string, Stream[]> = { All: sorted }
  for (const s of sorted) {
    for (const c of s.category ?? []) {
      if (c && c !== 'All') (out[c] ??= []).push(s)
    }
  }
  return out
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
