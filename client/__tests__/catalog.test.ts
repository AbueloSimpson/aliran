// groupByCategory: 'All' is a real everything-rail pinned FIRST (P2P + CDN mix there),
// genre categories follow; uncategorized channels live only in 'All'.

import { groupByCategory } from '../src/catalog'
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
