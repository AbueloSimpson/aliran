// Catalog shaping shared by the browse surfaces: curation sort, hero pick, category
// grouping, derived channel numbers. Pure functions over the SDK's display list.
// Desktop port of client/src/catalog.ts — keep the two in step when curation rules
// change (they implement the same S16c/S18/S27j/S8a contracts).

import { getLocale } from '@aliran/i18n'
import type { Stream } from './types'

// MEMOIZATION (S22 round 8, ported from the client twin): the derivations cost
// seconds of JS over a large vod library — measured on the phone, and the desktop
// renderer runs the same catalog through the same functions. visibleStreams
// (parental.ts) memoizes its output identity, so a WeakMap keyed on the input array
// pays each derivation ONCE per catalog update and every later call is O(1). The
// locale rides the key: the title tie-break collates in the viewer's locale, so a
// language switch must recompute.
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
// time only; the stored title (search matching, problem reports, anything that names
// the channel to the panel) stays raw.
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
// is a descriptive bracket, not a label. Matching folds casing on BOTH sides with
// plain toLowerCase, mirroring panel/src/sources.js EXACTLY: an argument-less
// toLocaleLowerCase folds in the HOST locale, so a Turkish device's dotless-i would
// strip (or keep) a tag differently from the panel and from every other device —
// the fold must be locale-independent to agree with the panel's. FOUR copies stay
// in step: the panel regex, the panel normalization, the client twin's displayTitle
// (client/src/catalog.ts), and this one — what the panel turns into a rail defines
// what either viewer app may strip, and the two apps must strip identically.
const SUBCAT_TAG_RE = /^\s*\[([^\]\r\n]{1,120})\]/
const SUBCAT_MAX = 32

// PERF: computeDisplayTitle runs a regex + a per-category fold PER CALL, and the
// browse surfaces call displayTitle once per mounted row per render. Stream records
// are REPLACED on every catalog push, never mutated, so a WeakMap keyed on the
// record OBJECT answers for the record's whole lifetime. Plain {title, category}
// literals ride the same cache — every object is a valid WeakMap key.
const displayTitleCache = new WeakMap<object, string>()

export function displayTitle (s: Pick<Stream, 'title' | 'category'>): string {
  const hit = displayTitleCache.get(s)
  if (hit !== undefined) return hit
  const out = computeDisplayTitle(s)
  displayTitleCache.set(s, out)
  return out
}

function computeDisplayTitle (s: Pick<Stream, 'title' | 'category'>): string {
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
  const want = tag.toLowerCase()
  const owned = (s.category ?? []).some((c) => {
    const [, sub] = splitCategory(c)
    // The leaf gets the same whitespace collapse as the tag: a hand-typed
    // 'Live Events/MLB  Playoffs' still names the same rail.
    return sub !== undefined && sub.replace(/\s+/g, ' ').trim().toLowerCase() === want
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
    // no-op and the zap keys went permanently silent on that channel) and handed
    // React duplicate keys in every list that renders a parent group.
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
  return memo1(zapCache, 'zap-order', streams, () => sortByCuration(streams.filter(s => !isVod(s))))
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
//   targets. A group left EMPTY by that filter (a vod-only category) is returned
//   EMPTY — zapStep owns every degradation and all scope bookkeeping, in ONE
//   place, so this stays the plain scope→ring lookup.
//
// Pure and PIN-free on purpose: parental gating stays in LiveScreen's play(), the
// one gate every tune path already passes through, whichever ring handed it the
// channel. Kept code-identical with the client twin (client/src/catalog.ts zapRing).
export function zapRing (streams: Stream[], model: CategoryModel, scope: string): Stream[] {
  const group = scope === 'All' ? undefined : model.groups[scope]
  if (!group) return zapOrder(streams)
  return group.filter(s => !isVod(s))
}

// A tune with NO browsing context — a search result, a Favorites jump, a remote
// play, the hero autoplay, a route param naming a category this catalog doesn't
// have — takes its scope from the channel's own filing (design rule: the viewer
// will be STANDING on that channel, so the rail it lives on is the honest
// context). Prefer the channel's first full 'Parent/Sub' entry that the model
// actually has a group for (the drilled rail a viewer would find it on), fall
// back to a bare parent that does, else 'All'. Shared by both LiveScreen twins;
// kept code-identical (tools/desktop-catalog-test.mjs lane A).
export function deriveTuneScope (s: Stream | null | undefined, model: CategoryModel): string {
  if (!s) return 'All'
  const cats = s.category ?? []
  for (const c of cats) { if (c && c !== 'All' && model.groups[c]) return c }
  for (const c of cats) {
    if (!c || c === 'All') continue
    const [parent] = splitCategory(c)
    if (parent && model.groups[parent]) return parent
  }
  return 'All'
}

/** One CH+/CH- press, resolved: the channel to tune (undefined = the press tunes
 *  nothing) and the scope that tune should RECORD (undefined = unchanged — a
 *  scoped zap keeps its ring). */
export interface ZapStep { next: Stream | undefined; scope: string | undefined }

// The ENTIRE zap ladder, in the one shared place (both LiveScreen twins call this;
// kept code-identical — lane A):
//
//   * the scoped ring (zapRing) — a vod-emptied group degrades to the global ring
//     (a ring with nothing in it strands the keys);
//   * a ring whose ONLY member is the playing channel widens outward instead of
//     going silent — sub → parent → global — and the scope follows the ring that
//     actually answered, so the next press keeps walking it;
//   * the playing channel not being IN the scoped ring at all (zapping FROM a vod
//     title, or the group changed under us) is a GLOBAL zap with the old
//     land-on-001 behavior, and the scope follows it to 'All' — deliberately NOT
//     re-derived from the landed channel: the viewer is surfing everything now;
//   * a press whose landing IS the playing channel (a single-live-channel catalog:
//     the ladder widened to global and came back around) tunes NOTHING — and
//     records no scope, because the picture never changed.
//
// Pure like zapRing: parental gating stays in each screen's play().
export function zapStep (streams: Stream[], model: CategoryModel, scope: string, playingId: string | null, dir: 1 | -1): ZapStep {
  let ring = zapRing(streams, model, scope)
  let nextScope: string | undefined
  if (!ring.length) { ring = zapOrder(streams); nextScope = 'All' }
  const onlyPlaying = (r: Stream[]) => r.length === 1 && r[0].id === playingId
  if (onlyPlaying(ring)) {
    const [parent, sub] = splitCategory(scope)
    if (sub !== undefined) {
      ring = zapRing(streams, model, parent)
      nextScope = parent
    }
    if (!ring.length || onlyPlaying(ring)) { ring = zapOrder(streams); nextScope = 'All' }
  }
  let i = ring.findIndex(s => s.id === playingId)
  if (i < 0) {
    ring = zapOrder(streams)
    i = ring.findIndex(s => s.id === playingId)
    nextScope = 'All'
  }
  if (!ring.length) return { next: undefined, scope: undefined }
  const next = ring[(i < 0 ? 0 : i + dir + ring.length) % ring.length]
  if (!next || next.id === playingId) return { next: undefined, scope: undefined }
  return { next, scope: nextScope }
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
