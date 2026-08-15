// groupByCategory: 'All' is a real everything-rail pinned FIRST (P2P + CDN mix there),
// genre categories follow; uncategorized channels live only in 'All'.
// vod (S8a): library titles get category rails like any channel, but stay OUT of the
// channel-shaped machinery — numbers, the CH+/CH- zap ring, and the hero pick.

import { groupByCategory, categoryModel, splitCategory, subLabel, displayTitle, channelNumbers, zapOrder, zapRing, zapStep, pickHero, formatDuration } from '../src/catalog'
import type { Stream } from '../src/worklet'

const s = (id: string, category?: string[], extra: Partial<Stream> = {}): Stream => ({ id, title: id, category, ...extra })

test('All is first and contains every channel; genres follow', () => {
  const streams = [
    s('world-news', ['News']), // P2P news
    s('news-24', ['News']), // CDN news (same rail)
    s('moon-cat', ['Anime']),
    s('shop-tv') // uncategorized
  ]
  const groups = groupByCategory(streams)
  const keys = Object.keys(groups)
  expect(keys[0]).toBe('All') // pinned first
  expect(groups.All.map(x => x.id).sort()).toEqual(['moon-cat', 'news-24', 'shop-tv', 'world-news']) // everything
  // P2P (world-news) and CDN (news-24) mix in the same genre rail
  expect(groups.News.map(x => x.id).sort()).toEqual(['news-24', 'world-news'])
  expect(groups.Anime.map(x => x.id)).toEqual(['moon-cat'])
  // uncategorized channel appears ONLY in All, not as its own bucket
  expect(keys).not.toContain('shop-tv')
})

test('All exists even when every channel is categorized', () => {
  const groups = groupByCategory([s('a', ['X']), s('b', ['Y'])])
  expect(Object.keys(groups)[0]).toBe('All')
  expect(groups.All).toHaveLength(2)
})

test('splitCategory / subLabel parse the Parent/Sub hierarchy', () => {
  expect(splitCategory('Anime/Español')).toEqual(['Anime', 'Español'])
  expect(splitCategory('News')).toEqual(['News', undefined])
  expect(subLabel('Anime/Español')).toBe('Español')
  expect(subLabel('News')).toBe('News')
})

test('vod titles rail like channels but take no channel number and stay out of the zap ring', () => {
  const streams = [
    s('ch1', ['News'], { order: 1, isLive: true }),
    s('movie', ['Library'], { order: 2, type: 'vod', durationSec: 5525 }),
    s('ch2', ['News'], { order: 3, isLive: true })
  ]
  // The Library rail comes from the category machinery like any other rail.
  expect(categoryModel(streams).top).toEqual(['All', 'News', 'Library'])
  expect(categoryModel(streams).groups.Library.map(x => x.id)).toEqual(['movie'])
  // Numbers cover the LIVE lineup only — adding titles must not renumber channels.
  const nums = channelNumbers(streams)
  expect(nums.get('ch1')).toBe(1)
  expect(nums.get('ch2')).toBe(2)
  expect(nums.has('movie')).toBe(false)
  // CH+/CH- ring: live only.
  expect(zapOrder(streams).map(x => x.id)).toEqual(['ch1', 'ch2'])
})

test('pickHero never auto-plays a vod title while any channel exists', () => {
  const vodFirst = [
    s('movie', ['Library'], { order: 1, type: 'vod', durationSec: 100 }),
    s('idle-ch', ['News'], { order: 2, isLive: false })
  ]
  expect(pickHero(vodFirst)?.id).toBe('idle-ch') // idle channel still beats a title
  expect(pickHero([s('movie', ['Library'], { type: 'vod' })])?.id).toBe('movie') // all-vod catalog: first title
})

test('formatDuration: h:mm:ss over an hour, m:ss under, empty when unknown', () => {
  expect(formatDuration(5525)).toBe('1:32:05')
  expect(formatDuration(1425)).toBe('23:45')
  expect(formatDuration(59.6)).toBe('1:00') // rounds, never shows 0:60
  expect(formatDuration(null)).toBe('')
  expect(formatDuration(undefined)).toBe('')
  expect(formatDuration(0)).toBe('')
})

test('categoryModel: parent/sub tree; a channel joins BOTH its parent and sub groups', () => {
  const m = categoryModel([
    s('moon-cat', ['Anime/Español'], { order: 1 }),
    s('ninja-run', ['Anime/English'], { order: 2 }),
    s('world-news', ['News/English'], { order: 3 }),
    s('news-24', ['News/Español'], { order: 4 }),
    s('variety-1', ['Entertainment'], { order: 5 }) // no sub
  ])
  expect(m.top).toEqual(['All', 'Anime', 'News', 'Entertainment']) // All first, parents in curated order
  expect([...m.subs.Anime].sort()).toEqual(['Anime/English', 'Anime/Español'])
  expect([...m.subs.News].sort()).toEqual(['News/English', 'News/Español'])
  expect(m.subs.Entertainment).toBeUndefined() // parent with no subs
  expect(m.groups.Anime.map((x) => x.id).sort()).toEqual(['moon-cat', 'ninja-run']) // parent = union of subs
  expect(m.groups['Anime/Español'].map((x) => x.id)).toEqual(['moon-cat']) // sub = just that one
  expect(m.groups.All).toHaveLength(5)
})

// --- displayTitle: stripping the panel's own live-events tag ---
// The strip is SELF-SCOPED to the panel's autoSubcategory output (panel/src/sources.js
// SUBCAT_TAG_RE / SUBCAT_MAX / deriveSubcat): a leading [TAG] goes ONLY when its
// normalized form matches the leaf of one of the stream's own 'Parent/Sub' entries —
// exactly the channels the panel minted a rail for. Decorative brackets survive.

const dt = (title: string, category?: string[]) => displayTitle({ title, category })

test('displayTitle strips the tag the panel turned into this stream\'s own sub-rail', () => {
  expect(dt('[MLB] Mariners vs Yankees (7:05 PM ET)', ['Live Events/MLB'])).toBe('Mariners vs Yankees (7:05 PM ET)')
})

test('displayTitle keeps the tag when no category entry carries a matching leaf', () => {
  // Parent-only category: the panel did NOT mint a rail from this bracket.
  expect(dt('[MLB] Mariners vs Yankees', ['Live Events'])).toBe('[MLB] Mariners vs Yankees')
  // A leaf that names something else is no license either.
  expect(dt('[4K] Cine Max', ['Movies/Estrenos'])).toBe('[4K] Cine Max')
  // No category at all.
  expect(dt('[MLB] Mariners vs Yankees')).toBe('[MLB] Mariners vs Yankees')
})

test('displayTitle keeps a descriptive bracket longer than SUBCAT_MAX (32) — the panel never rails those', () => {
  const long = '[Some very long descriptive bracket over thirty two characters] X'
  // Even alongside a sub-rail the panel DID mint, an over-budget bracket is prose, not a label.
  expect(dt(long, ['Live Events/MLB'])).toBe(long)
})

test('displayTitle folds casing on both sides (the panel folds rail casing too)', () => {
  expect(dt('[mlb] Game of the night', ['Live Events/MLB'])).toBe('Game of the night')
  expect(dt('[MLB] Game of the night', ['Live Events/mlb'])).toBe('Game of the night')
})

test('displayTitle leaves an untagged title untouched', () => {
  expect(dt('News 24', ['News/English'])).toBe('News 24')
})

test('displayTitle mirrors the panel\'s normalization: \'/\' and whitespace fold to single spaces', () => {
  // deriveSubcat turns '/' into a space (two levels, never three) before railing.
  expect(dt('[MLB/Playoffs] Game 7', ['Live Events/MLB Playoffs'])).toBe('Game 7')
  // Runs of whitespace collapse; edges trim.
  expect(dt('[ MLB   Playoffs ] Game 7', ['Live Events/MLB Playoffs'])).toBe('Game 7')
})

test('displayTitle never returns an empty name: a title that IS the tag keeps it', () => {
  expect(dt('[MLB]', ['Live Events/MLB'])).toBe('[MLB]')
  expect(dt('  [MLB]  ', ['Live Events/MLB'])).toBe('  [MLB]  ')
})

test('a channel filed under two subs of ONE parent joins the parent group once', () => {
  const streams = [
    s('doubleheader', ['Live Events/MLB', 'Live Events/NBA'], { order: 1, isLive: true }),
    s('game-2', ['Live Events/MLB'], { order: 2, isLive: true })
  ]
  const m = categoryModel(streams)
  // THE BUG THIS PINS: one parent push per category entry filed the channel in the
  // parent group twice, ADJACENTLY — a parent-scoped zap ring then found the same
  // id at findIndex + 1 (play() no-op'd: CH+ permanently dead on that channel), and
  // every list rendering the parent group got duplicate FlatList keys.
  expect(m.groups['Live Events'].map(x => x.id)).toEqual(['doubleheader', 'game-2'])
  // The sub groups keep exactly one membership each.
  expect(m.groups['Live Events/MLB'].map(x => x.id)).toEqual(['doubleheader', 'game-2'])
  expect(m.groups['Live Events/NBA'].map(x => x.id)).toEqual(['doubleheader'])
  // A literally duplicated category entry never doubles a group either.
  expect(categoryModel([s('twice', ['News', 'News'], { isLive: true })]).groups.News.map(x => x.id)).toEqual(['twice'])
})

// --- zapRing (Phase 4): CH+/CH- walks the category the viewer tuned from ---
// 'All' (and any scope the model has no group for) delegates to the global
// zapOrder ring. A real group keeps ITS OWN curated order, vod excluded — and a
// group the live-only filter EMPTIES comes back empty: zapRing is the plain
// scope→ring lookup, and zapStep owns every degradation (and all scope
// bookkeeping) in one place. PIN gating stays in LiveScreen's play(), never here.

test('zapRing walks a scoped category in its own curated order, live-only', () => {
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
  expect(zapRing(streams, m, 'Live Events/MLB').map(x => x.id)).toEqual(['mlb-1', 'mlb-2'])
  // A parent scope rings the union of its subs (the parent group).
  expect(zapRing(streams, m, 'Live Events').map(x => x.id)).toEqual(['mlb-1', 'mlb-2'])
})

test('zapRing on All IS the global ring (identity — the memoized zapOrder)', () => {
  const streams = [s('a', ['News'], { order: 1, isLive: true }), s('b', ['Music'], { order: 2, isLive: true })]
  expect(zapRing(streams, categoryModel(streams), 'All')).toBe(zapOrder(streams))
})

test('zapRing falls back to the global ring for an unknown scope', () => {
  const streams = [s('a', ['News'], { order: 1, isLive: true }), s('b', ['Music'], { order: 2, isLive: true })]
  const m = categoryModel(streams)
  // A scope the catalog no longer has (category renamed/removed under the viewer).
  expect(zapRing(streams, m, 'Gone/Away')).toBe(zapOrder(streams))
})

test('zapRing hands back a vod-emptied group EMPTY — zapStep owns the degradation', () => {
  const streams = [
    s('ch', ['News'], { order: 1, isLive: true }),
    s('movie-a', ['Library'], { order: 2, type: 'vod' }),
    s('movie-b', ['Library'], { order: 3, type: 'vod' })
  ]
  const m = categoryModel(streams)
  // 'Library' exists but holds only vod titles: the plain lookup answers honestly
  // (empty), and zapStep degrades it to the global ring so the keys never strand.
  expect(zapRing(streams, m, 'Library')).toEqual([])
  const step = zapStep(streams, m, 'Library', 'movie-a', 1)
  expect(step.next?.id).toBe('ch')
  expect(step.scope).toBe('All')
})

// --- zapStep: the whole CH+/CH- ladder in one shared place ---
// The full behavior matrix (ladder rungs, vod exit, All ring) is driven end to end
// through the real key path in TvLiveZapScope.test.tsx and mirrored in
// tools/desktop-catalog-test.mjs lane B; these pin the pure function's contract.

test('zapStep: a scoped step walks the category and records NO scope change', () => {
  const streams = [
    s('news-1', ['News'], { order: 1, isLive: true }),
    s('mlb-1', ['Live Events/MLB'], { order: 2, isLive: true }),
    s('news-2', ['News'], { order: 3, isLive: true }),
    s('mlb-2', ['Live Events/MLB'], { order: 4, isLive: true })
  ]
  const m = categoryModel(streams)
  const step = zapStep(streams, m, 'Live Events/MLB', 'mlb-1', 1)
  expect(step.next?.id).toBe('mlb-2') // the category's next, not channel 003
  expect(step.scope).toBeUndefined() // a scoped zap keeps its ring
})

test('zapStep: a landing ON the playing channel is a no-op — nothing tunes, no scope is recorded', () => {
  // A single-live-channel catalog: the ladder widens sub → parent → global and
  // comes back around to the playing channel itself. The picture never changes,
  // so the tuned-from context must stand (never the ladder's 'All').
  const streams = [
    s('only-live', ['Live Events/MLB'], { order: 1, isLive: true }),
    s('flick', ['Library'], { order: 2, type: 'vod' })
  ]
  const m = categoryModel(streams)
  const step = zapStep(streams, m, 'Live Events/MLB', 'only-live', 1)
  expect(step.next).toBeUndefined()
  expect(step.scope).toBeUndefined()
})

// --- memoization (S22 round 8): the derivations pay once per catalog array ---
// A large vod library made every guide/live mount recompute seconds of curation
// sort + grouping; the caches key on the input ARRAY IDENTITY (+ the collation
// locale), so the same catalog reference yields the same result object.

test('categoryModel/channelNumbers memoize on array identity; a new array recomputes', () => {
  const streams = [s('b', ['News'], { order: 2 }), s('a', ['News'], { order: 1 })]
  expect(categoryModel(streams)).toBe(categoryModel(streams)) // same ref in, same OBJECT out
  expect(channelNumbers(streams)).toBe(channelNumbers(streams))
  expect(zapOrder(streams)).toBe(zapOrder(streams))
  const clone = [...streams]
  expect(categoryModel(clone)).not.toBe(categoryModel(streams)) // fresh ref = fresh compute
  expect(categoryModel(clone).groups.All.map(x => x.id)).toEqual(categoryModel(streams).groups.All.map(x => x.id)) // same content
})

test('a locale switch invalidates the memo (the title tie-break collates per locale)', () => {
  const { setLocale, getLocale } = require('@aliran/i18n')
  const prev = getLocale()
  const streams = [s('b', ['News']), s('a', ['News'])]
  const before = categoryModel(streams)
  try {
    setLocale(prev === 'tr' ? 'en' : 'tr')
    expect(categoryModel(streams)).not.toBe(before) // recomputed under the new collation
  } finally { setLocale(prev) }
})
