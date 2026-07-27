// The Movies & Series section (S53 / D3, rebuilt to the mockups in S54b / D4·D5·D8).
// Pins the product decisions:
//   - the tile EXISTS ONLY when the panel says so (no vod payload -> the Menu has no
//     Movies & Series entry at all, which is the whole point of the enabled bit);
//   - the left pane is a MENU (Movies / Series / Search) — there is no always-visible
//     search box any more, and the search view's input never autofocuses (TV focus trap);
//   - the tab bar (Recommended · My List · Genres · All) applies to the active kind;
//   - the sort chip drives the whole grid, "recently watched" reads device-local
//     history, and the A–Z rail exists ONLY in the alphabetical sort;
//   - a rail jump is a ROW index (FlatList packs numColumns items per virtualized row);
//   - tile labels carry "(year)" inline, once;
//   - a series opens the VodSeries detail route, never the player.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Image, Text, TextInput } from 'react-native'

jest.mock('../src/vod/zencontent', () => ({
  listMovies: jest.fn(),
  listSeries: jest.fn(),
  listCategories: jest.fn(),
  getMovieInfo: jest.fn()
}))

// RN's FlatList pulls in @react-native-tvos/virtualized-lists, which ships untranspiled
// ESM this preset cannot parse (the same class of problem as Modal in ReportSheet's
// suite). Replace it with a plain "render every row" list that still exposes the
// imperative handle the A–Z rail drives — the grid's virtualization is RN's business,
// what this suite tests is which rows it is asked to render and where it is told to jump.
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = require('react')
  const MockView = require('react-native/Libraries/Components/View/View').default
  const spy: any = { scrollToIndex: jest.fn(), scrollToOffset: jest.fn(), props: null }
  const MockFlatList = ReactActual.forwardRef((props: any, ref: any) => {
    ReactActual.useImperativeHandle(ref, () => spy, [])
    spy.props = props
    const data = props.data || []
    return ReactActual.createElement(MockView, null, data.map((item: any, index: number) =>
      ReactActual.createElement(
        MockView,
        { key: props.keyExtractor ? props.keyExtractor(item, index) : String(index) },
        props.renderItem({ item, index })
      )))
  })
  return { __esModule: true, default: MockFlatList, __spy: spy }
})

import { VodScreen, VOD_ROW_H } from '../src/screens/VodScreen'
import { AlphaRail } from '../src/components/AlphaRail'
import { MenuScreen } from '../src/screens/MenuScreen'
import { listMovies, listSeries, listCategories, getMovieInfo } from '../src/vod/zencontent'
import { backend } from '../src/worklet'

const listSpy = (require('react-native/Libraries/Lists/FlatList') as any).__spy

const mockList = listMovies as unknown as jest.Mock
const mockSeries = listSeries as unknown as jest.Mock
const mockCats = listCategories as unknown as jest.Mock
const mockInfo = getMovieInfo as unknown as jest.Mock

const VOD = {
  enabled: true as const,
  apiBase: 'https://provider.example/api',
  service: 'svc',
  sources: { movies: 'movies-src' },
  params: {}
}
const VOD_BOTH = { ...VOD, sources: { movies: 'movies-src', series: 'series-src' } }

// Provider order = newest added first. Categories are INDEXES into CATEGORIES.
const ITEMS = [
  { id: '1', name: 'Amélie', nameOriginal: 'Le Fabuleux Destin', icon: 'https://art.example/1.jpg', added: 900, anio: '2001', categories: [0] },
  { id: '2', name: 'Sick Girl (2023)', nameOriginal: 'Sick Girl', icon: '', added: 800, anio: '2023', categories: [1] },
  { id: '3', name: 'Heat', nameOriginal: 'Heat', icon: 'https://art.example/3.jpg', added: 700, anio: '1995', categories: [0, 1] },
  { id: '4', name: 'Zulu', nameOriginal: 'Zulu', icon: '', added: 600, anio: '2013', categories: [1] },
  { id: '5', name: '#Alive', nameOriginal: '#Alive', icon: '', added: 500, anio: '2020', categories: [] }
]
const CATEGORIES = ['Action', 'Drama', 'Empty Genre']

const SERIES = [
  { id: 's1', name: 'Rick and Morty', nameOriginal: 'Rick and Morty', icon: 'https://art.example/s1.jpg', added: 990, anio: '2013', categories: [1] }
]

const nav = { navigate: jest.fn(), goBack: jest.fn() }
const props = { navigation: nav, route: { params: undefined } } as any

const mounted: RendererInstance[] = []
async function createTree (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}
beforeEach(() => {
  mockList.mockResolvedValue({ ok: true, items: ITEMS })
  mockSeries.mockResolvedValue({ ok: true, items: [] })
  mockCats.mockResolvedValue({ ok: true, categories: CATEGORIES })
})
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  nav.navigate.mockClear()
  mockList.mockReset(); mockSeries.mockReset(); mockCats.mockReset(); mockInfo.mockReset()
  listSpy.scrollToIndex.mockClear(); listSpy.scrollToOffset.mockClear(); listSpy.props = null
  ;(backend as any).vod = null
  ;(backend as any).vodList = []
  ;(backend as any).vodHistory = []
})

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
}

// The Pressable COMPOSITE carries onPress; its host layers only carry the role.
function pressablesLabelled (tree: RendererInstance, label: string) {
  return tree.root.findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .filter(n => n.findAllByType(Text).some(t => String(t.props.children) === label))
}
function pressableLabelled (tree: RendererInstance, label: string) {
  return pressablesLabelled(tree, label)[0]
}
async function press (tree: RendererInstance, label: string, nth = 0) {
  const p = pressablesLabelled(tree, label)[nth]
  expect(p).toBeTruthy()
  await ReactTestRenderer.act(async () => { await p!.props.onPress() })
}
/** Long press = the My List toggle (S54c). It lives on the SAME Pressable as the open
 *  gesture, which is the whole point: the grid gains no extra focusable on TV. */
async function longPress (tree: RendererInstance, label: string, nth = 0) {
  const p = pressablesLabelled(tree, label)[nth]
  expect(p).toBeTruthy()
  expect(typeof p!.props.onLongPress).toBe('function')
  await ReactTestRenderer.act(async () => { p!.props.onLongPress() })
}
/** Press a letter INSIDE the A–Z rail (a bare "Z" also matches a poster fallback
 *  initial, so the rail subtree is the only safe place to look). */
async function railPress (tree: RendererInstance, letter: string) {
  const rail = tree.root.findByType(AlphaRail)
  const hit = rail.findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => String(t.props.children) === letter))
  expect(hit).toBeTruthy()
  await ReactTestRenderer.act(async () => { hit!.props.onPress() })
}
/** The rows the grid was last asked to render, in order. */
function gridIds (): string[] {
  return (listSpy.props?.data || []).map((i: any) => i.id)
}

async function mount (vod: any = VOD) {
  ;(backend as any).vod = vod
  return createTree(<VodScreen {...props} />)
}

// --- the Menu gate ---------------------------------------------------------------

test('no vod payload from the panel = no Movies & Series tile', async () => {
  ;(backend as any).vod = null
  expect(texts(await createTree(<MenuScreen {...props} />))).not.toContain('MOVIES & SERIES')
})

test('an enabled provider puts the tile on the Menu', async () => {
  ;(backend as any).vod = VOD
  expect(texts(await createTree(<MenuScreen {...props} />))).toContain('MOVIES & SERIES')
})

test('the tile appears when the streams message brings the config in later', async () => {
  ;(backend as any).vod = null
  const tree = await createTree(<MenuScreen {...props} />)
  expect(texts(tree)).not.toContain('MOVIES & SERIES')
  await ReactTestRenderer.act(async () => {
    ;(backend as any).onData(JSON.stringify({ type: 'streams', streams: [], vod: VOD }) + '\n')
  })
  expect(texts(tree)).toContain('MOVIES & SERIES')
})

// --- the frame: menu + tabs -------------------------------------------------------

test('the left pane is a menu and carries no search box of its own', async () => {
  const tree = await mount()
  expect(pressableLabelled(tree, 'MOVIES')).toBeTruthy()
  expect(pressableLabelled(tree, 'SERIES')).toBeTruthy()
  expect(pressableLabelled(tree, 'SEARCH')).toBeTruthy()
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0)
})

test('the tab bar carries the four mockup tabs and All is the landing tab', async () => {
  const tree = await mount()
  for (const label of ['RECOMMENDED', 'MY LIST', 'GENRES', 'ALL']) {
    expect(pressableLabelled(tree, label)).toBeTruthy()
  }
  // All = the full grid with its sort chip
  expect(texts(tree)).toContain('Sort by: Recently added')
  expect(gridIds()).toEqual(['1', '2', '3', '4', '5'])
})

// --- the grid ---------------------------------------------------------------------

test('the grid renders the provider items with the year inline in the label', async () => {
  const tree = await mount()
  const t = texts(tree)
  expect(t).toContain('Amélie (2001)')
  expect(t).toContain('Heat (1995)')
  expect(t).toContain('Sick Girl (2023)') // already carried its year — not doubled
  expect(t).not.toContain('Sick Girl (2023) (2023)')
  expect(mockList).toHaveBeenCalledWith(VOD)
})

test('an item with no poster falls back to its initial, not a grey hole', async () => {
  mockList.mockResolvedValue({ ok: true, items: [ITEMS[1]] }) // icon: ''
  const tree = await mount()
  const initial = tree.root.findAllByType(Text).filter(t => t.props.children === 'S') // "Sick Girl"
  expect(initial).toHaveLength(1)
  expect(tree.root.findAllByType(Image)).toHaveLength(0)
})

test('a failed listing names sign-in vs connection, never a code', async () => {
  mockList.mockResolvedValue({ ok: false, error: 'auth' })
  expect(texts(await mount())).toContain("Couldn't sign in to the movie catalog")

  mockList.mockResolvedValue({ ok: false, error: 'network' })
  const t = texts(await mount())
  expect(t).toContain("Couldn't reach the movie catalog")
  expect(t).not.toContain('network')
})

test('an empty provider catalog says so rather than spinning', async () => {
  mockList.mockResolvedValue({ ok: true, items: [] })
  expect(texts(await mount())).toContain('Nothing here yet')
})

test('a provider with no movies source, and one with no series source, are honest', async () => {
  expect(texts(await mount({ ...VOD, sources: {} }))).toContain('No movies yet')
  const tree = await mount(VOD)
  await press(tree, 'SERIES')
  const t = texts(tree)
  expect(t).toContain('No series yet')
  expect(t).not.toContain('Amélie (2001)') // and not the movie grid under a Series heading
})

// --- search is its own view -------------------------------------------------------

test('Search opens its own view and filters both titles, ignoring case and accents', async () => {
  const tree = await mount()
  await press(tree, 'SEARCH')
  const input = tree.root.findByType(TextInput)

  await ReactTestRenderer.act(async () => { input.props.onChangeText('amelie') }) // accent-insensitive
  let t = texts(tree)
  expect(t).toContain('Amélie (2001)')
  expect(t).not.toContain('Heat (1995)')

  await ReactTestRenderer.act(async () => { input.props.onChangeText('FABULEUX') }) // matches nameOriginal
  t = texts(tree)
  expect(t).toContain('Amélie (2001)')
  expect(t).not.toContain('Sick Girl (2023)')

  await ReactTestRenderer.act(async () => { input.props.onChangeText('zzz') })
  expect(texts(tree)).toContain('No matches')
})

test('the search field never autofocuses (it must not trap a TV remote)', async () => {
  const tree = await mount()
  await press(tree, 'SEARCH')
  expect(tree.root.findByType(TextInput).props.autoFocus).toBe(false)
})

test('leaving Search through the kind menu puts the browse view back', async () => {
  const tree = await mount()
  await press(tree, 'SEARCH')
  expect(tree.root.findAllByType(TextInput)).toHaveLength(1)
  await press(tree, 'MOVIES')
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0)
  expect(texts(tree)).toContain('Sort by: Recently added')
})

// --- Genres -----------------------------------------------------------------------

test('Genres shows one card per genre that has titles, then filters the grid', async () => {
  const tree = await mount()
  await press(tree, 'GENRES')
  const t = texts(tree)
  expect(t).toContain('Action')
  expect(t).toContain('Drama')
  expect(t).not.toContain('Empty Genre') // no title carries it
  // the card fronts the genre's first title in ADDED order (Amélie for Action)
  expect(listSpy.props.data.map((g: any) => g.name)).toEqual(['Action', 'Drama'])

  await press(tree, 'Action')
  expect(gridIds()).toEqual(['1', '3']) // only the titles carrying category 0
  expect(texts(tree)).toContain('Genre: Action')

  await press(tree, 'Genre: Action') // the chip is the way back to the cards
  expect(listSpy.props.data.map((g: any) => g.name)).toEqual(['Action', 'Drama'])
})

// --- Recommended rails ------------------------------------------------------------

test('Recommended stacks the two rails; a carousel caps at 50 and SEE N MORE jumps to All with that sort', async () => {
  // 55 titles: the carousel carries the first 50, "SEE 5 MORE…" covers the rest.
  const many = Array.from({ length: 55 }, (_, i) => ({
    id: String(i + 1), name: `Movie ${i + 1}`, nameOriginal: '', icon: '',
    added: 1000 - i, anio: String(1970 + i), categories: []
  }))
  mockList.mockResolvedValue({ ok: true, items: many })
  const tree = await mount()
  await press(tree, 'RECOMMENDED')
  const t = texts(tree)
  expect(t).toContain('RECENTLY ADDED')
  expect(t).toContain('NEWEST RELEASES')
  expect(t).toContain('SEE 5 MORE…') // 55 titles − the 50-tile carousel cap
  expect(t).not.toContain('SEE 51 MORE…') // NOT the old fits-one-row arithmetic
  // The shelf really is a carousel: the last-rendered list is horizontal and holds 50.
  expect(listSpy.props.horizontal).toBe(true)
  expect(listSpy.props.data).toHaveLength(50)

  await press(tree, 'SEE 5 MORE…', 1) // the NEWEST RELEASES rail
  expect(texts(tree)).toContain('Sort by: Newest releases')
  expect(gridIds()).toHaveLength(55) // All shows everything…
  expect(gridIds()[0]).toEqual('55') // …newest year (2024) first
})

// --- sort -------------------------------------------------------------------------

test('the sort chip opens the menu, marks the active row and reorders the grid', async () => {
  const tree = await mount()
  await press(tree, 'Sort by: Recently added')
  const menu = texts(tree)
  expect(menu).toContain('SORT BY')
  expect(menu).toContain('SELECTED')
  for (const label of ['Recently added', 'A-Z', 'Newest releases', 'Oldest releases', 'Recently watched']) {
    expect(menu).toContain(label)
  }

  await press(tree, 'A-Z')
  expect(texts(tree)).toContain('Sort by: A-Z')
  expect(texts(tree)).not.toContain('SORT BY') // choosing dismisses
  expect(gridIds()).toEqual(['5', '1', '3', '2', '4']) // #Alive, Amélie, Heat, Sick Girl, Zulu
})

test('Recently watched reads the device-local history, episodes counting for their series', async () => {
  ;(backend as any).vodHistory = [
    { kind: 'movie', id: '3', title: 'Heat', positionSec: 60, durationSec: 5525, at: 500 },
    { kind: 'episode', id: 'ep7', seriesId: '4', title: 'Zulu S1E1', positionSec: 30, durationSec: 3060, at: 900 }
  ]
  const tree = await mount()
  await press(tree, 'Sort by: Recently added')
  await press(tree, 'Recently watched')
  expect(gridIds()).toEqual(['4', '3', '1', '2', '5']) // watched first, then added order
})

// --- the A–Z rail -----------------------------------------------------------------

test('the rail exists only in the alphabetical sort, and jumps by ROW index', async () => {
  const tree = await mount()
  expect(tree.root.findAllByType(AlphaRail)).toHaveLength(0) // added sort: no rail

  await press(tree, 'Sort by: Recently added')
  await press(tree, 'A-Z')
  // one letter per bucket the grid actually contains, in grid order ('#' leads)
  expect(tree.root.findByType(AlphaRail).props.letters).toEqual(['#', 'A', 'H', 'S', 'Z'])

  // 'Z' is item index 4; with 4 columns that is row 1 — FlatList's scrollToIndex takes
  // the ROW, because numColumns packs `columns` items into one virtualized cell.
  await railPress(tree, 'Z')
  expect(listSpy.scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: true })
  await railPress(tree, '#')
  expect(listSpy.scrollToIndex).toHaveBeenLastCalledWith({ index: 0, animated: true })

  // and back the other way: scrolling the grid moves the rail's highlight
  await ReactTestRenderer.act(async () => {
    listSpy.props.viewabilityConfigCallbackPairs[0].onViewableItemsChanged({ viewableItems: [{ index: 3 }] })
  })
  expect(tree.root.findByType(AlphaRail).props.active).toBe('S')
})

test('the rail is gone again the moment the sort leaves A-Z', async () => {
  const tree = await mount()
  await press(tree, 'Sort by: Recently added')
  await press(tree, 'A-Z')
  expect(tree.root.findAllByType(AlphaRail)).toHaveLength(1)
  await press(tree, 'Sort by: A-Z')
  await press(tree, 'Oldest releases')
  expect(tree.root.findAllByType(AlphaRail)).toHaveLength(0)
})

test('the grid describes exact rows and survives a scrollToIndex miss', async () => {
  const tree = await mount()
  await press(tree, 'Sort by: Recently added')
  await press(tree, 'A-Z')
  expect(listSpy.props.getItemLayout(null, 3)).toEqual({ length: VOD_ROW_H, offset: VOD_ROW_H * 3, index: 3 })
  await ReactTestRenderer.act(async () => { listSpy.props.onScrollToIndexFailed({ index: 2 }) })
  expect(listSpy.scrollToOffset).toHaveBeenCalledWith({ offset: VOD_ROW_H * 2, animated: true })
})

test('the viewability pair keeps its identity (an unstable one makes RN throw mid-list)', async () => {
  const tree = await mount()
  const pairs = listSpy.props.viewabilityConfigCallbackPairs
  expect(pairs[0].viewabilityConfig).toEqual({ itemVisiblePercentThreshold: 5 })
  await press(tree, 'Sort by: Recently added')
  await press(tree, 'A-Z')
  expect(listSpy.props.viewabilityConfigCallbackPairs).toBe(pairs)
})

// --- My List ----------------------------------------------------------------------

test('My List renders the device-local watchlist and is honest when empty', async () => {
  const tree = await mount()
  await press(tree, 'MY LIST')
  expect(texts(tree)).toContain('Your list is empty')

  ;(backend as any).vodList = [{ kind: 'movie', id: '3' }, { kind: 'movie', id: 'gone' }, { kind: 'series', id: 's1' }]
  const two = await mount()
  await press(two, 'MY LIST')
  expect(gridIds()).toEqual(['3']) // the unknown id and the SERIES entry both stay out
})

test('a long press on a tile toggles My List and says what it did', async () => {
  const spy = jest.spyOn(backend, 'setVodList').mockImplementation(() => {})
  const tree = await mount()
  await longPress(tree, 'Heat (1995)')
  expect(spy).toHaveBeenCalledWith([{ kind: 'movie', id: '3' }])
  expect(texts(tree)).toContain('Added to My List: Heat')

  // newest first, and a second long press takes it back out again
  await longPress(tree, 'Amélie (2001)')
  expect(spy).toHaveBeenLastCalledWith([{ kind: 'movie', id: '1' }, { kind: 'movie', id: '3' }])
  await longPress(tree, 'Heat (1995)')
  expect(spy).toHaveBeenLastCalledWith([{ kind: 'movie', id: '1' }])
  expect(texts(tree)).toContain('Removed from My List: Heat')

  // …and the My List tab now shows exactly what was kept
  await press(tree, 'MY LIST')
  expect(gridIds()).toEqual(['1'])
  spy.mockRestore()
})

test('a long press on a SERIES tile saves a series entry, not a movie one', async () => {
  const spy = jest.spyOn(backend, 'setVodList').mockImplementation(() => {})
  mockSeries.mockResolvedValue({ ok: true, items: SERIES })
  const tree = await mount(VOD_BOTH)
  await press(tree, 'SERIES')
  await longPress(tree, 'Rick and Morty (2013)')
  expect(spy).toHaveBeenCalledWith([{ kind: 'series', id: 's1' }])
  expect(nav.navigate).not.toHaveBeenCalled() // a long press must not also open it
  spy.mockRestore()
})

test('a prefs message updates My List without a remount', async () => {
  const tree = await mount()
  await press(tree, 'MY LIST')
  expect(texts(tree)).toContain('Your list is empty')
  await ReactTestRenderer.act(async () => {
    ;(backend as any).onData(JSON.stringify({
      type: 'prefs', creds: null, favorites: [], vodList: [{ kind: 'movie', id: '1' }], vodHistory: []
    }) + '\n')
  })
  expect(gridIds()).toEqual(['1'])
})

// --- selecting a title ------------------------------------------------------------

test('selecting a movie tile resolves the URL and hands it to the player screen', async () => {
  mockInfo.mockResolvedValue({ ok: true, url: 'https://cdn.example/heat.mp4', durationSec: 5525 })
  const tree = await mount()
  await press(tree, 'Heat (1995)')
  expect(mockInfo).toHaveBeenCalledWith(VOD, '3')
  // id + kind travel with the url so the player can write the device-local history (D9).
  expect(nav.navigate).toHaveBeenCalledWith('VodPlayer', {
    url: 'https://cdn.example/heat.mp4', title: 'Heat', durationSec: 5525, id: '3', kind: 'movie'
  })
})

test('a movie this device already started is handed its resume position', async () => {
  ;(backend as any).vodHistory = [
    { kind: 'movie', id: '3', title: 'Heat', positionSec: 754, durationSec: 5525, at: 5 },
    { kind: 'movie', id: '1', title: 'Amélie', positionSec: 0, durationSec: 7000, at: 9 }
  ]
  mockInfo.mockResolvedValue({ ok: true, url: 'https://cdn.example/heat.mp4', durationSec: 5525 })
  const tree = await mount()
  await press(tree, 'Heat (1995)')
  expect(nav.navigate.mock.calls[0][1].resumeSec).toBe(754)

  // a finished title is stored as position 0 — it restarts, it does not "resume at 0"
  await press(tree, 'Amélie (2001)')
  expect(nav.navigate.mock.calls[1][1].resumeSec).toBeUndefined()
})

test('a title that will not resolve leaves the grid up and explains itself', async () => {
  mockInfo.mockResolvedValue({ ok: false, error: 'network' })
  const tree = await mount()
  await press(tree, 'Heat (1995)')
  const t = texts(tree)
  expect(t).toContain("Couldn't reach the movie catalog")
  expect(t).toContain('Amélie (2001)') // the rest of the catalog is still there
  expect(nav.navigate).not.toHaveBeenCalled()
})

test('a series tile opens the detail route, never the player', async () => {
  mockSeries.mockResolvedValue({ ok: true, items: SERIES })
  const tree = await mount(VOD_BOTH)
  await press(tree, 'SERIES')
  expect(mockSeries).toHaveBeenCalledWith(VOD_BOTH)
  await press(tree, 'Rick and Morty (2013)')
  expect(nav.navigate).toHaveBeenCalledWith('VodSeries', { id: 's1', name: 'Rick and Morty', icon: 'https://art.example/s1.jpg', anio: '2013' })
  expect(mockInfo).not.toHaveBeenCalled()
})
