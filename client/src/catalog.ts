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
function memo1<T> (cache: WeakMap<Stream[], Keyed<T>>, label: string, streams: Stream[], compute: () => T): T {
  const locale = getLocale()
  const hit = cache.get(streams)
  if (hit && hit.locale === locale) return hit.out
  // Boot trace (see '[boot-ui]' in the screens): a derivation that costs real time is
  // a JS-thread stall every screen feels — name the one that did and what it cost.
  const t0 = Date.now()
  const out = compute()
  const ms = Date.now() - t0
  if (ms > 50) console.log(`[boot-ui] catalog ${label} computed in ${ms}ms (${streams.length} streams)`)
  cache.set(streams, { locale, out })
  return out
}
const curationCache = new WeakMap<Stream[], Keyed<Stream[]>>()
const modelCache = new WeakMap<Stream[], Keyed<CategoryModel>>()
const zapCache = new WeakMap<Stream[], Keyed<Stream[]>>()
const numbersCache = new WeakMap<Stream[], Keyed<Map<string, number>>>()

// ONE collator per locale, never one per comparison. `localeCompare(b, locale)` looks
// like a plain string op but on Hermes/Android every call crosses into platform ICU and
// resolves the locale from scratch — milliseconds each, and a sort makes O(n log n) of
// them: ~15k comparisons over a 1400-channel lineup pegged the Terraza TCL's JS thread
// for tens of seconds per sort (the vc13 "42 s menu render"). Intl.Collator pays the
// locale resolution once and its bound compare is a straight ICU call. The fallback
// keeps engines without Intl exactly where they were: localeCompare's own fallback is
// code-point order, and per-call cost was never a problem there.
let collatorCache: { locale: string; compare: (a: string, b: string) => number } | null = null
function titleCompare (a: string, b: string): number {
  const locale = getLocale()
  if (!collatorCache || collatorCache.locale !== locale) {
    let compare: (a: string, b: string) => number
    try {
      compare = new Intl.Collator(locale).compare
    } catch {
      compare = (x, y) => x.localeCompare(y, locale)
    }
    collatorCache = { locale, compare }
  }
  return collatorCache.compare(a, b)
}

// Panel curation sort: (order ?? Infinity, title). Stable for equal keys.
// The title tie-break sorts in the VIEWER's locale (S56 design D9): collation is not
// universal — Swedish files "ä" after "z", Turkish files "ı" before "i" — and the list
// a viewer scans should be alphabetical to THEM. Engines without a real collator ignore
// the argument and fall back to code-point order, which is what they did before.
export function sortByCuration (streams: Stream[]): Stream[] {
  return memo1(curationCache, 'curation-sort', streams, () => [...streams].sort((a, b) => {
    const ao = a.order ?? Infinity
    const bo = b.order ?? Infinity
    if (ao !== bo) return ao - bo
    return titleCompare(a.title || '', b.title || '')
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

// --- display titles: stripping the panel's own live-events tag -------------------
//
// The panel's `autoSubcategory` (panel/src/sources.js — SUBCAT_TAG_RE, SUBCAT_MAX,
// deriveSubcat) reads the leading "[MLB]" off an events-list entry and mints
// `category: ['Live Events/MLB']` from it, storing the title VERBATIM. So on a rail
// already NAMED "MLB" the prefix is pure repetition, spent on the row's one elastic
// thing — the name a viewer is actually reading. displayTitle() removes it at display
// time only; the stored title (search matching, problem reports, send-to-TV payloads,
// anything that names the channel to the panel) stays raw.
//
// SELF-SCOPED, deliberately: the tag is stripped only when its normalized form equals
// the LEAF of one of the stream's OWN 'Parent/Sub' category entries — the panel's
// autoSubcategory output, plus any hand-filed category whose leaf happens to repeat
// the bracket (a channel filed under 'Movies/4K' and titled "[4K] …" loses the
// bracket too, which is the same redundancy). A decorative bracket with NO matching
// leaf survives untouched; nothing here guesses at provider punctuation.
//
// The regex and the normalization MIRROR deriveSubcat — tag text captured by the same
// pattern, control chars -> space, '/' -> space (the separator is the panel's, two
// levels never three), whitespace collapsed, and a result longer than SUBCAT_MAX (32)
// is a descriptive bracket, not a label. Matching folds casing on BOTH sides
// (toLocaleLowerCase) the way the panel folds rail casing. These three — panel regex,
// panel normalization, this function — must stay in step: what the panel turns into a
// rail defines what the client may strip.
const SUBCAT_TAG_RE = /^\s*\[([^\]\r\n]{1,120})\]/
const SUBCAT_MAX = 32

export function displayTitle (s: Pick<Stream, 'title' | 'category'>): string {
  const title = s.title || ''
  const m = SUBCAT_TAG_RE.exec(title)
  if (!m) return title
  const tag = m[1]
    // eslint-disable-next-line no-control-regex -- mirrors deriveSubcat: control characters never reach a rail label
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!tag || tag.length > SUBCAT_MAX) return title
  const want = tag.toLocaleLowerCase()
  const owned = (s.category ?? []).some((c) => {
    const [, sub] = splitCategory(c)
    // The leaf gets the same whitespace collapse as the tag: a hand-typed
    // 'Live Events/MLB  Playoffs' still names the same rail.
    return sub !== undefined && sub.replace(/\s+/g, ' ').trim().toLocaleLowerCase() === want
  })
  if (!owned) return title
  // Never hand back an empty name: a title that IS the tag keeps it verbatim.
  const rest = title.slice(m[0].length).trimStart()
  return rest || title
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
  return memo1(modelCache, 'category-model', streams, () => computeCategoryModel(streams))
}

function computeCategoryModel (streams: Stream[]): CategoryModel {
  const sorted = sortByCuration(streams)
  const groups: Record<string, Stream[]> = { All: sorted }
  const top: string[] = ['All']
  const topSeen = new Set(['All'])
  const subs: Record<string, string[]> = {}
  const subSeen: Record<string, Set<string>> = {}
  for (const s of sorted) {
    // ONE membership per stream per group. A channel filed under two subs of the
    // same parent (['Live Events/MLB', 'Live Events/NBA']) used to be pushed into
    // groups[parent] once per entry — adjacent duplicates that dead-ended the
    // parent-scoped zap ring (findIndex + 1 landed on the same id, so play() was a
    // no-op and CH+ went permanently silent on that channel) and handed FlatList
    // duplicate keys in every list that renders a parent group.
    const joined = new Set<string>()
    for (const c of s.category ?? []) {
      if (!c || c === 'All') continue
      const [parent, sub] = splitCategory(c)
      if (!topSeen.has(parent)) { topSeen.add(parent); top.push(parent) }
      if (!joined.has(parent)) { joined.add(parent); (groups[parent] ??= []).push(s) }
      if (sub) {
        if (!joined.has(c)) { joined.add(c); (groups[c] ??= []).push(s) }
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
  // Filter the SORTED list, never sort the filtered one: a filter output is a fresh
  // array the curation cache has never seen, so sort-after-filter paid the whole
  // O(n log n) collation a second time per catalog. Filtering preserves order, and
  // sortByCuration(streams) is the same call the category model already made — a
  // cache hit. Memoized on the input array so the ring keeps a stable identity too.
  return memo1(zapCache, 'zap-order', streams, () => sortByCuration(streams).filter(s => !isVod(s)))
}

// The CATEGORY-SCOPED zap ring (Phase 4, operator feedback): CH+/CH- and the D-pad
// zap walk the category the viewer tuned FROM, not the global lineup — a viewer who
// entered from LIVE EVENTS › MLB pressing CH+ wants the next game, not channel 042.
//
//   scope 'All' (or any key the model has no group for) -> zapOrder(streams): the
//   global curated ring, byte-for-byte the old behavior — an 'All' tune keeps the
//   channel-number surfing feel, and an unknown/vanished scope degrades to it
//   rather than to a dead key.
//
//   a real group -> that group in ITS OWN order (the groups are already
//   curation-sorted — the curated order IS the category's order), filtered by the
//   same live-only rule zapOrder applies: vod titles are on-demand, never zap
//   targets. A group left EMPTY by that filter (a vod-only category) falls back to
//   the global ring too — a ring with nothing in it strands the keys.
//
// Pure and PIN-free on purpose: parental gating stays in LiveScreen's play(), the
// one gate every tune path already passes through, whichever ring handed it the
// channel.
export function zapRing (streams: Stream[], model: CategoryModel, scope: string): Stream[] {
  const group = scope === 'All' ? undefined : model.groups[scope]
  if (!group) return zapOrder(streams)
  const ring = group.filter(s => !isVod(s))
  return ring.length ? ring : zapOrder(streams)
}

// Derived channel numbers (D3): curated sort over the live catalog -> 1..N. The same
// stream keeps its number in every category group; vod titles have none. Zero-pad
// for the 10-foot list.
export function channelNumbers (streams: Stream[]): Map<string, number> {
  return memo1(numbersCache, 'channel-numbers', streams, () => {
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
