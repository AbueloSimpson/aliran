// In-player channel search (WS15/WS16, components/SearchPanel.tsx): the LEFT
// alphabet BOX is QUICK INPUT (a multi-column letter grid — tap appends; digits,
// backspace), the box's script follows the GUI locale with an English A-Z toggle,
// matching is case/diacritic-insensitive on the title plus a number-prefix match,
// cards are LOGO-only (never live thumbs — WS11), and tapping a result hands the
// stream to onTune (the host tunes AND closes; PIN gating stays the host's play()
// path). Layout (S22 round 5): letters live in the left box, the field + results
// grid in the right pane; the results columns derive from the PANE width.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, TextInput, Image } from 'react-native'

// RN's FlatList pulls in untranspiled ESM this preset cannot parse (the VodScreen
// suite's lesson) — replace it with a plain "render every row" list.
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = require('react')
  const MockView = require('react-native/Libraries/Components/View/View').default
  const MockFlatList = ReactActual.forwardRef((props: any, _ref: any) => {
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

import { SearchPanel, searchChannels, searchGridGeometry, boxColumns } from '../src/components/SearchPanel'
import { backend } from '../src/worklet'
import { channelNumbers } from '../src/catalog'
import { setLocale } from '@aliran/i18n'
import type { Stream } from '../src/worklet'

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
}

// The Pressable COMPOSITE carries onPress — find it by walking up from its Text.
function pressableWithText (tree: RendererInstance, label: string) {
  const txt = tree.root.findAllByType(Text).find((x) => [x.props.children].flat().join('') === label)!
  let n: any = txt.parent
  while (n && typeof n.props.onPress !== 'function') n = n.parent
  return n
}

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
  jest.restoreAllMocks()
  ;(backend as any).streams = []
  setLocale('en')
})

const moonCat: Stream = { id: 'moon-cat', title: 'Moon Cat', isLive: true, order: 1 }
const news: Stream = { id: 'news', title: 'News 24', isLive: true, order: 2 }
const cafe: Stream = { id: 'cafe', title: 'Café TV', isLive: true, order: 3, logo: 'http://127.0.0.1:1234/assets/cafe/logo.png' }
const ALL = [moonCat, news, cafe] // curated order = numbers 001/002/003

async function panel (onTune = jest.fn()) {
  ;(backend as any).streams = ALL
  const tree = await createTree(<SearchPanel playingId="moon-cat" onTune={onTune} />)
  return { tree, onTune }
}

async function type (tree: RendererInstance, value: string) {
  const input = tree.root.findAllByType(TextInput)[0]
  await ReactTestRenderer.act(async () => { input.props.onChangeText(value) })
}

// --- the pure matcher -------------------------------------------------------------

test('searchChannels: case/diacritic-insensitive title substring', () => {
  const numbers = channelNumbers(ALL)
  expect(searchChannels(ALL, numbers, 'cafe').map(s => s.id)).toEqual(['cafe'])
  expect(searchChannels(ALL, numbers, 'CAFÉ').map(s => s.id)).toEqual(['cafe'])
  expect(searchChannels(ALL, numbers, 'oon c').map(s => s.id)).toEqual(['moon-cat'])
  expect(searchChannels(ALL, numbers, 'zzz')).toEqual([])
})

test('searchChannels: digits match the channel number as a prefix (padded or not)', () => {
  const numbers = channelNumbers(ALL)
  expect(searchChannels(ALL, numbers, '00').map(s => s.id)).toEqual(['moon-cat', 'news', 'cafe'])
  expect(searchChannels(ALL, numbers, '002').map(s => s.id)).toEqual(['news'])
  expect(searchChannels(ALL, numbers, '3').map(s => s.id)).toEqual(['cafe'])
  // Digits still match titles too ("24" is in a name, not a number here).
  expect(searchChannels(ALL, numbers, '24').map(s => s.id)).toEqual(['news'])
})

test('searchChannels: empty query = the whole catalog in curated order', () => {
  expect(searchChannels(ALL, channelNumbers(ALL), ' ').map(s => s.id)).toEqual(['moon-cat', 'news', 'cafe'])
})

// --- the layout geometry (S22 round 5) --------------------------------------------

test('boxColumns: per-script counts; portrait compresses every script to 4', () => {
  expect(boxColumns('latin', false)).toBe(5)
  expect(boxColumns('kana', false)).toBe(5) // gojūon rows stay 5-wide
  expect(boxColumns('hangul', false)).toBe(5)
  expect(boxColumns('cyrillic', false)).toBe(6)
  expect(boxColumns('devanagari', false)).toBe(6)
  expect(boxColumns('thai', false)).toBe(6)
  for (const s of ['latin', 'cyrillic', 'devanagari', 'kana', 'hangul', 'thai'] as const) {
    expect(boxColumns(s, true)).toBe(4)
  }
})

test('searchGridGeometry: columns derive from the pane width — smaller cards, more columns', () => {
  const narrow = searchGridGeometry(170) // the right pane at ~360dp portrait
  expect(narrow.columns).toBe(2) // the floor: side-by-side must survive portrait
  const wide = searchGridGeometry(550) // a landscape right pane
  expect(wide.columns).toBeGreaterThanOrEqual(5) // was a fixed 4 over the FULL width
  expect(wide.cardW).toBeLessThan(130) // ~35-40% under the old ~185dp landscape cards
  expect(wide.cardW * wide.columns).toBeLessThanOrEqual(550) // cards always fit the pane
})

// --- the panel --------------------------------------------------------------------

test('layout: letters render inside the left alphabet box, results in the right pane', async () => {
  const { tree } = await panel()
  const box = tree.root.findAll((n) => n.props.testID === 'search-alpha-box')[0]
  const pane = tree.root.findAll((n) => n.props.testID === 'search-results-pane')[0]
  expect(box).toBeTruthy()
  expect(pane).toBeTruthy()
  const boxTexts = box.findAllByType(Text).map((x) => [x.props.children].flat(9).map(String).join(''))
  expect(boxTexts).toContain('A') // letters…
  expect(boxTexts).toContain('9') // …the digits…
  expect(boxTexts).toContain('⌫') // …and backspace all live in the box
  expect(boxTexts.join(' ')).not.toContain('Moon Cat') // no results in the box
  const paneTexts = pane.findAllByType(Text).map((x) => [x.props.children].flat(9).map(String).join(''))
  expect(paneTexts.join(' ')).toContain('Moon Cat') // results in the right pane
  expect(paneTexts).not.toContain('A') // no stray letter keys among the results
})

test('all channels show before any input; typing filters; clear × restores', async () => {
  const { tree } = await panel()
  expect(texts(tree)).toContain('Moon Cat')
  expect(texts(tree)).toContain('News 24')
  await type(tree, 'news')
  expect(texts(tree)).not.toContain('Moon Cat')
  expect(texts(tree)).toContain('News 24')
  await ReactTestRenderer.act(async () => { pressableWithText(tree, '×').props.onPress() })
  expect(texts(tree)).toContain('Moon Cat') // query cleared
}, 15000) // first test in the suite pays the cold module-load cost under parallel workers

test('the letter rail appends to the query; backspace deletes; digits row works', async () => {
  const { tree } = await panel()
  await ReactTestRenderer.act(async () => { pressableWithText(tree, 'N').props.onPress() })
  const q = () => tree.root.findAllByType(TextInput)[0].props.value
  expect(q()).toBe('N')
  expect(texts(tree)).toContain('News 24')
  expect(texts(tree)).not.toContain('Café TV')
  await ReactTestRenderer.act(async () => { pressableWithText(tree, '⌫').props.onPress() })
  expect(q()).toBe('')
  await ReactTestRenderer.act(async () => { pressableWithText(tree, '2').props.onPress() })
  expect(q()).toBe('2')
  expect(texts(tree)).toContain('News 24') // number 2 (unpadded prefix) + the "24" in the title
  expect(texts(tree)).not.toContain('Moon Cat')
})

test('en: plain A-Z rail, no script toggle', async () => {
  const { tree } = await panel()
  const t = texts(tree)
  expect(t).toContain('A | B | C') // the Latin rail, in order
  expect(t).toContain('0 | 1 | 2') // the digits row
  expect(t).not.toContain('АБВ') // no toggle chip on a Latin-script GUI
})

test('ru: Cyrillic rail by default, ABC toggle switches to A-Z and back', async () => {
  setLocale('ru')
  const { tree } = await panel()
  expect(texts(tree)).toContain('А | Б | В') // Cyrillic (U+0410…)
  expect(texts(tree)).toContain('ABC') // the toggle chip offers the English rail
  await ReactTestRenderer.act(async () => { pressableWithText(tree, 'ABC').props.onPress() })
  expect(texts(tree)).toContain('A | B | C') // now the plain English A-Z
  expect(texts(tree)).toContain('АБВ') // and the chip offers the way back
  await ReactTestRenderer.act(async () => { pressableWithText(tree, 'АБВ').props.onPress() })
  expect(texts(tree)).toContain('А | Б | В')
})

test('tapping a result hands the stream to onTune', async () => {
  const { tree, onTune } = await panel()
  const card = tree.root.findAll((n) => typeof n.props.onPress === 'function')
    .find((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.includes('News 24'))!
  await ReactTestRenderer.act(async () => { card.props.onPress() })
  expect(onTune).toHaveBeenCalledTimes(1)
  expect(onTune.mock.calls[0][0].id).toBe('news')
})

test('cards are LOGO-only — never a live thumb probe (WS11 policy)', async () => {
  ;(backend as any).streams = [{ ...cafe, thumbBase: 'http://127.0.0.1:1234/feedthumb/cafe' }]
  const tree = await createTree(<SearchPanel playingId={null} onTune={jest.fn()} />)
  const images = tree.root.findAllByType(Image)
  expect(images).toHaveLength(1)
  expect(images[0].props.source.uri).toBe(cafe.logo)
  expect(images[0].props.resizeMode).toBe('contain')
  expect(images.some((i) => /feedthumb|\?t=/.test(i.props.source.uri))).toBe(false)
})
