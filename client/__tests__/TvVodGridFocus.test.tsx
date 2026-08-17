// The Movies & Series poster grid's TELEVISION clipping rule — the channel list's focus
// fault (TvChannelListPager, "the rows stay attached") on the third and last list that
// carried it, and the only one of the three a viewer meets on a set TODAY.
//
// removeClippedSubviews DETACHES the mounted-but-off-screen cells from the native view
// tree, and on Android a detached view is also out of FOCUS SEARCH. The poster tiles ARE
// this grid's focusables — they carry the open press, the My-List long press and the
// first tile's TV preferred focus — so with the flag on, a DOWN press on the last visible
// row finds nothing below it and focus wraps back to the top of the grid, taking the
// scroll with it: the operator's "it goes down four or five channels and jumps back up",
// on posters.
//
// What the fix must NOT change is the mounted WINDOW: windowSize and initialNumToRender
// are what govern how many tiles (and poster downloads) are alive at once, and they were
// never what broke the focus.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'

jest.mock('../src/vod/zencontent', () => ({
  listMovies: jest.fn(),
  listSeries: jest.fn(),
  listCategories: jest.fn(),
  getMovieInfo: jest.fn()
}))

// The FlatList stand-in (RN's pulls in untranspiled ESM this preset cannot parse — the
// VodScreen suite's lesson): renders every row, and keeps the props where the test can
// read them, which is the only way to see a prop that has no rendered consequence.
const mockList: { props: any } = { props: null }
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = require('react')
  const MockView = require('react-native/Libraries/Components/View/View').default
  const MockFlatList = ReactActual.forwardRef((props: any, ref: any) => {
    ReactActual.useImperativeHandle(ref, () => ({ scrollToIndex: jest.fn(), scrollToOffset: jest.fn() }), [])
    mockList.props = props
    const data = props.data || []
    return ReactActual.createElement(MockView, null, data.map((item: any, index: number) =>
      ReactActual.createElement(
        MockView,
        { key: props.keyExtractor ? props.keyExtractor(item, index) : String(index) },
        props.renderItem({ item, index })
      )))
  })
  return { __esModule: true, default: MockFlatList }
})

// theme.ts reads Platform.isTV ONCE, at module load, so the fake has to be in place
// before anything that reaches it is required. ES imports are hoisted; these are not.
// (Ordered require()s rather than jest.isolateModules: an isolated registry hands screen
// tests a SECOND React and hooks then throw — AcceptRemoteToggle's lesson.)
const { Platform } = require('react-native')
const realIsTV = Object.getOwnPropertyDescriptor(Platform, 'isTV')!
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
const { VodScreen } = require('../src/screens/VodScreen')
const { listMovies, listSeries, listCategories } = require('../src/vod/zencontent')
const { backend } = require('../src/worklet')
const { theme } = require('../src/theme')

afterAll(() => { Object.defineProperty(Platform, 'isTV', realIsTV) })

const VOD = {
  enabled: true as const,
  apiBase: 'https://provider.example/api',
  service: 'svc',
  sources: { movies: 'movies-src' },
  params: {}
}
const ITEMS = [
  { id: '1', name: 'Amélie', nameOriginal: 'Le Fabuleux Destin', icon: '', added: 900, anio: '2001', categories: [0] },
  { id: '2', name: 'Heat', nameOriginal: 'Heat', icon: '', added: 800, anio: '1995', categories: [0] },
  { id: '3', name: 'Zulu', nameOriginal: 'Zulu', icon: '', added: 700, anio: '2013', categories: [1] }
]

const nav = { navigate: jest.fn(), goBack: jest.fn() }
const screenProps = { navigation: nav, route: { params: undefined } } as any

const mounted: RendererInstance[] = []
/** The landing tab is Recommended (a stack of carousels) — the poster GRID is the All
 *  tab, so every case here enters it first. */
async function grid (): Promise<RendererInstance> {
  ;(backend as any).vod = VOD
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<VodScreen {...screenProps} />) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  const all = tree.root.findAll((n: any) => n.props?.accessibilityRole === 'button' && typeof n.props?.onPress === 'function')
    .find((n: any) => n.findAllByType(Text).some((x: any) => String(x.props.children) === 'ALL'))
  if (!all) throw new Error('no ALL tab on the VOD screen')
  await ReactTestRenderer.act(async () => { all.props.onPress() })
  return tree
}
beforeEach(() => {
  ;(listMovies as jest.Mock).mockResolvedValue({ ok: true, items: ITEMS })
  ;(listSeries as jest.Mock).mockResolvedValue({ ok: true, items: [] })
  ;(listCategories as jest.Mock).mockResolvedValue({ ok: true, categories: ['Action', 'Drama'] })
})
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  ;(listMovies as jest.Mock).mockReset(); (listSeries as jest.Mock).mockReset(); (listCategories as jest.Mock).mockReset()
  nav.navigate.mockClear()
  mockList.props = null
  ;(backend as any).vod = null
  ;(backend as any).vodList = []
  ;(backend as any).vodHistory = []
})

test('television poster tiles are never DETACHED — off-screen tiles have to stay findable by focus search', async () => {
  await grid()
  expect(theme.isTV).toBe(true) // the fake landed: without it this lane proves nothing
  expect(mockList.props.data.map((i: any) => i.id)).toEqual(ITEMS.map((i) => i.id)) // the grid, not a carousel
  expect(mockList.props.removeClippedSubviews).toBe(false)
  // The mounted window itself is unchanged: that is what governs how many tiles (and
  // poster downloads) are alive at once, and it was never what broke the focus.
  // initialNumToRender still tracks the derived column count (four rows of posters),
  // rather than having been pinned to a constant on the way past.
  expect(mockList.props.windowSize).toBe(5)
  expect(mockList.props.numColumns).toBeGreaterThanOrEqual(2)
  expect(mockList.props.initialNumToRender).toBe(mockList.props.numColumns * 4)
})

test('…and the tiles ARE the focusables, which is the whole reason the flag has to go', async () => {
  const tree = await grid()
  // Each tile is a Pressable of its own, carrying both gestures — nothing here is a
  // virtual-focus row the way the guide grid's are, which is why the guide keeps the flag
  // and this grid cannot.
  const tiles = tree.root.findAll((n: any) =>
    n.props?.accessibilityRole === 'button' &&
    typeof n.props?.onPress === 'function' &&
    typeof n.props?.onLongPress === 'function')
  expect(tiles.length).toBeGreaterThanOrEqual(ITEMS.length)
  // …and the grid asks the remote for the first of them, so the D-pad enters the grid
  // rather than the tiles being merely tappable.
  expect(tiles.some((n: any) => n.props.hasTVPreferredFocus === true)).toBe(true)
})
