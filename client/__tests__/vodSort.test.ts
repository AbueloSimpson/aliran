// VOD list shaping (S54b, D4/D5/D8). Pins the rules the grid, the sort menu and the
// A–Z rail all depend on:
//   - `added` is the provider's order, untouched, and NOTHING mutates the input list;
//   - unknown years sort LAST in both year directions (not first, not interleaved);
//   - "recently watched" credits a series for its EPISODES' history entries;
//   - rail buckets come off the already-sorted list, so '#' leads and no letter can
//     point at a row the grid does not contain;
//   - a title that already ends in "(2023)" never gets a second year stapled on.

import { DEFAULT_SORT, VOD_SORTS, fold, letterBuckets, letterOf, sortItems, sortLabel, titleWithYear, watchedAt } from '../src/vod/sort'
import type { VodItem } from '../src/vod/zencontent'

function item (id: string, name: string, anio = '', categories: number[] = []): VodItem {
  return { id, name, nameOriginal: name, icon: '', added: 0, anio, categories }
}

// Provider order (newest added first) is the order of this array.
const ITEMS: VodItem[] = [
  item('1', 'Zulu', '2013'),
  item('2', 'amelie', '2001'),
  item('3', '#Alive', '2020'),
  item('4', 'Heat', ''), // no year at all
  item('5', 'Balloon', '0') // the provider's "unknown"
]

test('the sort menu is the mockup set, in order, with Recently added the default', () => {
  expect(VOD_SORTS.map(o => o.key)).toEqual(['added', 'az', 'yearDesc', 'yearAsc', 'watched'])
  expect(VOD_SORTS.map(o => o.label)).toEqual(['Recently added', 'A-Z', 'Newest releases', 'Oldest releases', 'Recently watched'])
  expect(DEFAULT_SORT).toBe('added')
  expect(sortLabel('watched')).toBe('Recently watched')
  expect(sortLabel('nonsense' as any)).toBe('Recently added') // never blank the chip
})

test('sorting never mutates the cached provider list', () => {
  const before = ITEMS.map(i => i.id)
  sortItems(ITEMS, 'az')
  sortItems(ITEMS, 'yearDesc')
  expect(ITEMS.map(i => i.id)).toEqual(before)
})

test('added is the provider order verbatim', () => {
  expect(sortItems(ITEMS, 'added').map(i => i.id)).toEqual(['1', '2', '3', '4', '5'])
})

test('A-Z folds case and accents and ignores leading punctuation ordering only by fold', () => {
  // '#Alive' folds to '#alive' which sorts below every letter -> first.
  expect(sortItems(ITEMS, 'az').map(i => i.name)).toEqual(['#Alive', 'amelie', 'Balloon', 'Heat', 'Zulu'])
  expect(fold('Amélie')).toBe('amelie')
})

test('A-Z ties break on id, so the grid never reshuffles under the viewer', () => {
  const dup = [item('b', 'Same'), item('a', 'same')]
  expect(sortItems(dup, 'az').map(i => i.id)).toEqual(['a', 'b'])
})

test('year sorts put unknown years LAST in both directions', () => {
  expect(sortItems(ITEMS, 'yearDesc').map(i => i.anio)).toEqual(['2020', '2013', '2001', '', '0'])
  expect(sortItems(ITEMS, 'yearAsc').map(i => i.anio)).toEqual(['2001', '2013', '2020', '', '0'])
  // and the unknowns keep the provider's own order between themselves
  expect(sortItems(ITEMS, 'yearAsc').slice(3).map(i => i.id)).toEqual(['4', '5'])
})

test('recently watched orders by history, then keeps added order for the rest', () => {
  const history = [
    { kind: 'movie' as const, id: '4', title: 'Heat', positionSec: 10, durationSec: 100, at: 500 },
    { kind: 'movie' as const, id: '2', title: 'amelie', positionSec: 10, durationSec: 100, at: 900 }
  ]
  expect(sortItems(ITEMS, 'watched', history).map(i => i.id)).toEqual(['2', '4', '1', '3', '5'])
  // no history at all = exactly the added order
  expect(sortItems(ITEMS, 'watched', []).map(i => i.id)).toEqual(['1', '2', '3', '4', '5'])
})

test('an episode counts as a view of its parent series', () => {
  const history = [
    { kind: 'episode' as const, id: 'ep-77', seriesId: '5', title: 'Balloon S1E1', positionSec: 60, durationSec: 3060, at: 1200 }
  ]
  expect(sortItems(ITEMS, 'watched', history)[0].id).toBe('5')
  expect(watchedAt(history).get('5')).toBe(1200)
  // an episode with no seriesId falls back to its own id and cannot fake a series
  expect(watchedAt([{ kind: 'episode', id: 'ep-9', title: 'x', positionSec: 0, durationSec: 0, at: 3 }]).get('ep-9')).toBe(3)
})

test('the newest entry for an id wins', () => {
  const at = watchedAt([
    { kind: 'movie', id: '1', title: 'Zulu', positionSec: 0, durationSec: 0, at: 100 },
    { kind: 'movie', id: '1', title: 'Zulu', positionSec: 0, durationSec: 0, at: 700 }
  ])
  expect(at.get('1')).toBe(700)
})

test('rail buckets are the letters the SORTED grid really has, # first', () => {
  const sorted = sortItems(ITEMS, 'az')
  expect(letterBuckets(sorted)).toEqual([
    { letter: '#', index: 0 },
    { letter: 'A', index: 1 },
    { letter: 'B', index: 2 },
    { letter: 'H', index: 3 },
    { letter: 'Z', index: 4 }
  ])
  expect(letterOf('Émile')).toBe('E')
  expect(letterOf('  spaced')).toBe('S')
  expect(letterOf('12 Monkeys')).toBe('#')
  expect(letterOf('')).toBe('#')
})

test('a bucket points at the FIRST row of its letter, not every row', () => {
  const many = sortItems([item('1', 'Alpha'), item('2', 'Able'), item('3', 'Bravo')], 'az')
  expect(many.map(i => i.name)).toEqual(['Able', 'Alpha', 'Bravo'])
  expect(letterBuckets(many)).toEqual([{ letter: 'A', index: 0 }, { letter: 'B', index: 2 }])
})

test('the tile label appends the year only when the name lacks one', () => {
  expect(titleWithYear({ name: 'Heat', anio: '1995' })).toBe('Heat (1995)')
  expect(titleWithYear({ name: 'Sick Girl (2023)', anio: '2023' })).toBe('Sick Girl (2023)')
  expect(titleWithYear({ name: 'Sick Girl (2023) ', anio: '2023' })).toBe('Sick Girl (2023) ')
  expect(titleWithYear({ name: 'Heat', anio: '' })).toBe('Heat')
  expect(titleWithYear({ name: 'Apollo 13', anio: '1995' })).toBe('Apollo 13 (1995)') // a trailing number is not a year suffix
})
