// VodScreen orientation split (WS13, S22 feedback). Phone PORTRAIT collapses the
// left menu pane into a horizontal chip row above the grid and gives the poster grid
// the full width — exactly three responsive columns; phone LANDSCAPE (and TV) keep
// the S54b layout: left pane + fixed-width tiles. gridGeometry is the single source
// of the column/tile/row numbers, so this suite pins it directly and then checks each
// orientation renders its own frame.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'

// Window dimensions drive the orientation split — mock the hook so one suite can see
// both orientations (the preset's real window is fixed at 750x1334).
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 800, height: 360, scale: 2, fontScale: 2 }))
}))

jest.mock('../src/vod/zencontent', () => ({
  listMovies: jest.fn(),
  listSeries: jest.fn(),
  listCategories: jest.fn(),
  getMovieInfo: jest.fn()
}))

// Same FlatList stand-in as VodScreen.test.tsx: the real one drags in untranspiled
// ESM (virtualized-lists) this preset cannot parse.
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

import { Text } from 'react-native'
import { VodScreen, gridGeometry, VOD_TILE_H, VOD_ROW_H } from '../src/screens/VodScreen'
import { listMovies, listSeries, listCategories } from '../src/vod/zencontent'
import { backend } from '../src/worklet'

const useDims = require('react-native/Libraries/Utilities/useWindowDimensions').default as jest.Mock

const mockList = listMovies as unknown as jest.Mock
const mockSeries = listSeries as unknown as jest.Mock
const mockCats = listCategories as unknown as jest.Mock

const VOD = {
  enabled: true as const,
  apiBase: 'https://provider.example/api',
  service: 'svc',
  sources: { movies: 'movies-src' },
  params: {}
}
const ITEMS = [
  { id: '1', name: 'Amélie', nameOriginal: '', icon: '', added: 900, anio: '2001', categories: [0] },
  { id: '2', name: 'Heat', nameOriginal: '', icon: '', added: 800, anio: '1995', categories: [0] }
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
  mockCats.mockResolvedValue({ ok: true, categories: ['Action'] })
  ;(backend as any).vod = VOD
})
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  mockList.mockReset(); mockSeries.mockReset(); mockCats.mockReset()
  ;(backend as any).vod = null
  ;(backend as any).vodList = []
  ;(backend as any).vodHistory = []
})

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
}
function menuRow (tree: RendererInstance) {
  // composites only (host layers repeat the testID) — hosts have string types
  return tree.root.findAll(n => n.props.testID === 'vod-menu-row' && typeof n.type !== 'string')
}

// Derived from the exports so no theme constant is restated here: the fixed tile is
// 110 wide on phone, VOD_TILE_H = round(110*3/2) + LABEL_H, VOD_ROW_H adds the margin.
const LABEL_H = VOD_TILE_H - Math.round(110 * 3 / 2)
const TILE_MB = VOD_ROW_H - VOD_TILE_H

// --- the geometry itself -----------------------------------------------------------

test('landscape keeps the fixed tile and the left-pane width math', () => {
  const g = gridGeometry(800, 360, false)
  expect(g.portrait).toBe(false)
  expect(g.tileW).toBe(110)
  expect(g.rowH).toBe(VOD_ROW_H)
  expect(g.columns).toBe(5) // (800-2*16)*0.78 minus pane gap and grid padding, 118/tile
})

test('portrait sizes exactly three columns out of the full width', () => {
  const g = gridGeometry(360, 800, false)
  expect(g.portrait).toBe(true)
  expect(g.columns).toBe(3)
  // full width minus safe margins (2x11) and grid padding (2x3), split 3 ways
  // around 2 gaps of 8: floor((360-22-6-16)/3)
  expect(g.tileW).toBe(105)
  // the row height follows the responsive tile: poster (2:3) + label box + margin
  expect(g.rowH).toBe(Math.round(g.tileW * 3 / 2) + LABEL_H + TILE_MB)
})

test('the A–Z rail costs the portrait tiles width, never a column', () => {
  const bare = gridGeometry(360, 800, false)
  const railed = gridGeometry(360, 800, true)
  expect(railed.columns).toBe(3)
  expect(railed.tileW).toBeLessThan(bare.tileW)
})

// --- the two frames ----------------------------------------------------------------

test('landscape renders the left menu pane, not the chip row', async () => {
  useDims.mockReturnValue({ width: 800, height: 360, scale: 2, fontScale: 2 })
  const tree = await createTree(<VodScreen {...props} />)
  expect(texts(tree)).toContain('MOVIES & SERIES') // the pane header
  expect(menuRow(tree)).toHaveLength(0)
})

test('portrait collapses the menu pane into a horizontal chip row above the grid', async () => {
  useDims.mockReturnValue({ width: 360, height: 800, scale: 2, fontScale: 2 })
  const tree = await createTree(<VodScreen {...props} />)
  expect(menuRow(tree).length).toBeGreaterThan(0)
  expect(texts(tree)).not.toContain('MOVIES & SERIES') // the header belongs to the pane
  // the chips are still the three menu entries, pressable as ever
  for (const label of ['MOVIES', 'SERIES', 'SEARCH']) {
    const hit = tree.root.findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
      .filter(n => n.findAllByType(Text).some(t => String(t.props.children) === label))
    expect(hit.length).toBeGreaterThan(0)
  }
})
