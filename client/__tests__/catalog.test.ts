// groupByCategory: 'All' is a real everything-rail pinned FIRST (P2P + CDN mix there),
// genre categories follow; uncategorized channels live only in 'All'.
// vod (S8a): library titles get category rails like any channel, but stay OUT of the
// channel-shaped machinery — numbers, the CH+/CH- zap ring, and the hero pick.

import { groupByCategory, categoryModel, splitCategory, subLabel, channelNumbers, zapOrder, pickHero, formatDuration } from '../src/catalog'
import type { Stream } from '../src/worklet'

const s = (id: string, category?: string[], extra: Partial<Stream> = {}): Stream => ({ id, title: id, category, ...extra })

test('All is first and contains every channel; genres follow', () => {
  const streams = [
    s('nhk', ['News']), // P2P news
    s('cnn', ['News']), // CDN news (same rail)
    s('conan', ['Anime']),
    s('qvc') // uncategorized
  ]
  const groups = groupByCategory(streams)
  const keys = Object.keys(groups)
  expect(keys[0]).toBe('All') // pinned first
  expect(groups.All.map(x => x.id).sort()).toEqual(['cnn', 'conan', 'nhk', 'qvc']) // everything
  // P2P (nhk) and CDN (cnn) mix in the same genre rail
  expect(groups.News.map(x => x.id).sort()).toEqual(['cnn', 'nhk'])
  expect(groups.Anime.map(x => x.id)).toEqual(['conan'])
  // uncategorized channel appears ONLY in All, not as its own bucket
  expect(keys).not.toContain('qvc')
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
    s('conan', ['Anime/Español'], { order: 1 }),
    s('naruto', ['Anime/English'], { order: 2 }),
    s('nhk', ['News/English'], { order: 3 }),
    s('cnn', ['News/Español'], { order: 4 }),
    s('mbc', ['Entertainment'], { order: 5 }) // no sub
  ])
  expect(m.top).toEqual(['All', 'Anime', 'News', 'Entertainment']) // All first, parents in curated order
  expect([...m.subs.Anime].sort()).toEqual(['Anime/English', 'Anime/Español'])
  expect([...m.subs.News].sort()).toEqual(['News/English', 'News/Español'])
  expect(m.subs.Entertainment).toBeUndefined() // parent with no subs
  expect(m.groups.Anime.map((x) => x.id).sort()).toEqual(['conan', 'naruto']) // parent = union of subs
  expect(m.groups['Anime/Español'].map((x) => x.id)).toEqual(['conan']) // sub = just that one
  expect(m.groups.All).toHaveLength(5)
})
