// The Movies & Series section (S53 / D3). Pins the product decisions:
//   - the tile EXISTS ONLY when the panel says so (no vod payload -> the Menu has no
//     Movies & Series entry at all, which is the whole point of the enabled bit);
//   - the grid renders provider items, not catalog streams;
//   - search filters both titles, case- and accent-insensitively, client-side;
//   - Series is honest ("No series yet") rather than hidden, and so is a provider
//     enabled with no movies source.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Image, Text, TextInput } from 'react-native'

jest.mock('../src/vod/zencontent', () => ({
  listMovies: jest.fn(),
  getMovieInfo: jest.fn()
}))

// RN's FlatList pulls in @react-native-tvos/virtualized-lists, which ships untranspiled
// ESM this preset cannot parse (the same class of problem as Modal in ReportSheet's
// suite). Replace it with a plain "render every row" list — the grid's virtualization
// is RN's business, what this suite tests is which rows it is asked to render.
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = require('react')
  const MockView = require('react-native/Libraries/Components/View/View').default
  function MockFlatList (props: any) {
    const data = props.data || []
    return ReactActual.createElement(MockView, null, data.map((item: any, index: number) =>
      ReactActual.createElement(
        MockView,
        { key: props.keyExtractor ? props.keyExtractor(item, index) : String(index) },
        props.renderItem({ item, index })
      )))
  }
  return { __esModule: true, default: MockFlatList }
})

import { VodScreen } from '../src/screens/VodScreen'
import { MenuScreen } from '../src/screens/MenuScreen'
import { listMovies, getMovieInfo } from '../src/vod/zencontent'
import { backend } from '../src/worklet'

const mockList = listMovies as unknown as jest.Mock
const mockInfo = getMovieInfo as unknown as jest.Mock

const VOD = {
  enabled: true as const,
  apiBase: 'https://provider.example/api',
  service: 'svc',
  sources: { movies: 'movies-src' },
  params: {}
}

const ITEMS = [
  { id: '1', name: 'Amélie', nameOriginal: 'Le Fabuleux Destin', icon: 'https://art.example/1.jpg', added: 900, anio: '2001', categories: [] },
  { id: '2', name: 'Sick Girl (2023)', nameOriginal: 'Sick Girl', icon: '', added: 800, anio: '2023', categories: [4] },
  { id: '3', name: 'Heat', nameOriginal: 'Heat', icon: 'https://art.example/3.jpg', added: 700, anio: '1995', categories: [] }
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
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  nav.navigate.mockClear()
  mockList.mockReset(); mockInfo.mockReset()
  ;(backend as any).vod = null
})

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
}

// The Pressable COMPOSITE carries onPress; its host layers only carry the role.
function pressableLabelled (tree: RendererInstance, label: string) {
  return tree.root.findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => String(t.props.children) === label))
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

// --- the grid --------------------------------------------------------------------

test('the grid renders the provider items with their year badges', async () => {
  ;(backend as any).vod = VOD
  mockList.mockResolvedValue({ ok: true, items: ITEMS })
  const t = texts(await createTree(<VodScreen {...props} />))
  expect(t).toContain('Amélie')
  expect(t).toContain('Sick Girl (2023)')
  expect(t).toContain('Heat')
  expect(t).toContain('1995')
  expect(mockList).toHaveBeenCalledWith(VOD)
})

test('an item with no poster falls back to its initial, not a grey hole', async () => {
  ;(backend as any).vod = VOD
  mockList.mockResolvedValue({ ok: true, items: [ITEMS[1]] }) // icon: ''
  const tree = await createTree(<VodScreen {...props} />)
  const initial = tree.root.findAllByType(Text).filter(t => t.props.children === 'S') // "Sick Girl"
  expect(initial).toHaveLength(1)
  expect(tree.root.findAllByType(Image)).toHaveLength(0)
})

test('search filters both titles, ignoring case and accents', async () => {
  ;(backend as any).vod = VOD
  mockList.mockResolvedValue({ ok: true, items: ITEMS })
  const tree = await createTree(<VodScreen {...props} />)
  const input = tree.root.findByType(TextInput)

  await ReactTestRenderer.act(async () => { input.props.onChangeText('amelie') }) // accent-insensitive
  let t = texts(tree)
  expect(t).toContain('Amélie')
  expect(t).not.toContain('Heat')

  await ReactTestRenderer.act(async () => { input.props.onChangeText('FABULEUX') }) // matches nameOriginal
  t = texts(tree)
  expect(t).toContain('Amélie')
  expect(t).not.toContain('Sick Girl (2023)')

  await ReactTestRenderer.act(async () => { input.props.onChangeText('zzz') })
  expect(texts(tree)).toContain('No matches')
})

test('the search field never autofocuses (it must not trap a TV remote)', async () => {
  ;(backend as any).vod = VOD
  mockList.mockResolvedValue({ ok: true, items: ITEMS })
  const tree = await createTree(<VodScreen {...props} />)
  expect(tree.root.findByType(TextInput).props.autoFocus).toBe(false)
})

test('Series is an honest empty state, and so is a provider with no movies source', async () => {
  ;(backend as any).vod = VOD
  mockList.mockResolvedValue({ ok: true, items: ITEMS })
  const tree = await createTree(<VodScreen {...props} />)
  const series = pressableLabelled(tree, 'SERIES')
  expect(series).toBeTruthy()
  await ReactTestRenderer.act(async () => { series!.props.onPress() })
  expect(texts(tree)).toContain('No series yet')

  ;(backend as any).vod = { ...VOD, sources: {} }
  expect(texts(await createTree(<VodScreen {...props} />))).toContain('No movies yet')
})

test('a failed listing names sign-in vs connection, never a code', async () => {
  ;(backend as any).vod = VOD
  mockList.mockResolvedValue({ ok: false, error: 'auth' })
  expect(texts(await createTree(<VodScreen {...props} />))).toContain("Couldn't sign in to the movie catalog")

  mockList.mockResolvedValue({ ok: false, error: 'network' })
  const t = texts(await createTree(<VodScreen {...props} />))
  expect(t).toContain("Couldn't reach the movie catalog")
  expect(t).not.toContain('network')
})

test('an empty provider catalog says so rather than spinning', async () => {
  ;(backend as any).vod = VOD
  mockList.mockResolvedValue({ ok: true, items: [] })
  expect(texts(await createTree(<VodScreen {...props} />))).toContain('Nothing here yet')
})

// --- selecting a title ------------------------------------------------------------

test('selecting a tile resolves the URL and hands it to the player screen', async () => {
  ;(backend as any).vod = VOD
  mockList.mockResolvedValue({ ok: true, items: ITEMS })
  mockInfo.mockResolvedValue({ ok: true, url: 'https://cdn.example/heat.mp4', durationSec: 5525 })
  const tree = await createTree(<VodScreen {...props} />)
  const tile = pressableLabelled(tree, 'Heat')
  expect(tile).toBeTruthy()
  await ReactTestRenderer.act(async () => { await tile!.props.onPress() })
  expect(mockInfo).toHaveBeenCalledWith(VOD, '3')
  expect(nav.navigate).toHaveBeenCalledWith('VodPlayer', { url: 'https://cdn.example/heat.mp4', title: 'Heat', durationSec: 5525 })
})

test('a title that will not resolve leaves the grid up and explains itself', async () => {
  ;(backend as any).vod = VOD
  mockList.mockResolvedValue({ ok: true, items: ITEMS })
  mockInfo.mockResolvedValue({ ok: false, error: 'network' })
  const tree = await createTree(<VodScreen {...props} />)
  const tile = pressableLabelled(tree, 'Heat')
  await ReactTestRenderer.act(async () => { await tile!.props.onPress() })
  const t = texts(tree)
  expect(t).toContain("Couldn't reach the movie catalog")
  expect(t).toContain('Amélie') // the rest of the catalog is still there
  expect(nav.navigate).not.toHaveBeenCalled()
})
