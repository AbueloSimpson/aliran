// Focus visibility in the TV guide grid.
//
// This screen has NO native focus ring to fall back on. Focus is virtual — native focus
// is parked on an invisible catcher and four edge strips bounce D-pad presses into the
// moveFocus reducer (the S7 rig) — so focus exists exactly as far as these styles say it
// does, and a colour collision is not cosmetic here, it is the whole indicator.
//
// It HAD one. `cellNow` (this program is on air) used the ACCENT colour, and brands
// routinely set accent and focus to the same value: SolTV sets both to #FBBF24, and the
// stock theme sets both to #22D3EE. Since the airing border is drawn on essentially
// every visible row, five or six rows wore the focus colour at once and the genuinely
// focused row had nothing to single it out. On a TCL set the grid looked like it was
// scrolling by itself and the viewer never appeared to have entered it at all.
//
// So the rule this suite pins is the grammar, not a hex value: the focus colour marks
// the focused row and NOTHING else on the grid, and the row is marked on its CHANNEL
// COLUMN — the part a viewer reads to know where they are — not only on one program
// cell out of the several in a 2 h window.
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, View, StyleSheet } from 'react-native'
import type { Stream } from '../src/worklet'

// RN's FlatList pulls in untranspiled ESM this preset cannot parse (the VodScreen
// suite's lesson) — replace it with a plain "render every row" list.
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

// theme.ts reads Platform.isTV ONCE, at module load, so the fake has to be in place
// before anything that reaches it is required. ES imports are hoisted; these are not.
// (Ordered require()s rather than jest.isolateModules: an isolated registry hands screen
// tests a SECOND React and hooks then throw — AcceptRemoteToggle's lesson.)
const { Platform } = require('react-native')
const realIsTV = Object.getOwnPropertyDescriptor(Platform, 'isTV')!
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
const { GuideScreen } = require('../src/screens/GuideScreen')
const { NowPill } = require('../src/components/GuidePanel')
const { backend } = require('../src/worklet')
const { epg } = require('@aliran/react-native')
const { theme } = require('../src/theme')

afterAll(() => { Object.defineProperty(Platform, 'isTV', realIsTV) })

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
})

const flat = (n: any) => (StyleSheet.flatten(n.props.style) || {}) as Record<string, any>

// Row 1 is the one Live handed us, so the grid opens with the focus on it.
const focusedRow: Stream = { id: 'moon-cat', title: 'Moon Cat', isLive: true, epgUrl: 'https://epg.example/a.json', epgId: 'moon-cat' }
const otherRow: Stream = { id: 'shop-tv', title: 'Shop TV', isLive: true, epgUrl: 'https://epg.example/b.json', epgId: 'shop-tv' }

function screen () {
  const navigation: any = { navigate: jest.fn() }
  const route: any = { params: { streamId: 'moon-cat' } }
  return <GuideScreen navigation={navigation} route={route} />
}

async function grid (): Promise<RendererInstance> {
  const now = Date.now()
  // Every row is airing something — which is the ordinary case, and precisely the one
  // that used to paint the whole screen in the focus colour.
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([
    { title: 'On Air Now', start: now - 6e5, stop: now + 6e5 },
    { title: 'Up Next Show', start: now + 6e5, stop: now + 12e5 }
  ])
  ;(backend as any).streams = [focusedRow, otherRow]
  return createTree(screen())
}

/** The channel-number Text of a row, found by the number it prints. */
function channelNumber (tree: RendererInstance, printed: string) {
  const node = tree.root.findAllByType(Text)
    .find((n: any) => [n.props.children].flat(9).map(String).join('') === printed)
  if (!node) throw new Error(`no channel number "${printed}" on the grid`)
  return node
}

test('the focused row is marked on its CHANNEL COLUMN, not only on one program cell', async () => {
  const tree = await grid()
  // The number a viewer reads to know where they are goes to the focus colour…
  expect(flat(channelNumber(tree, '001')).color).toBe(theme.colors.focus)
  // …and the row below it, which is NOT focused, keeps the dim identity treatment.
  expect(flat(channelNumber(tree, '002')).color).toBe(theme.colors.textDim)
})

test('the focus colour marks the focused row and nothing else on the grid', async () => {
  const tree = await grid()
  // THE REGRESSION GUARD. Every node wearing a focus-coloured border, across a grid
  // where both rows are airing a program: it must be exactly the one focused channel
  // cell. Give the airing border the focus colour again and this count goes up.
  const focusBordered = tree.root.findAllByType(View).filter((n: any) => flat(n).borderColor === theme.colors.focus)
  expect(focusBordered).toHaveLength(1)
})

test('"on air now" is drawn in the live colour, so it can never impersonate focus', async () => {
  const tree = await grid()
  // Program cells are the absolutely-positioned boxes on the timeline strip — which is
  // also what separates them from the NOW pill, the header's other live-coloured thing.
  const airing = tree.root.findAllByType(View)
    .filter((n: any) => flat(n).borderColor === theme.colors.live && flat(n).position === 'absolute')
  // One per row — both rows are airing something.
  expect(airing).toHaveLength(2)
  // And the invariant behind the whole change, stated where a brand edit would break
  // it: a brand may point accent at the focus colour (SolTV does), so the airing
  // border must not be keyed to accent.
  expect(theme.colors.live).not.toBe(theme.colors.focus)
})

test('the NOW pill states itself in outline until the remote is actually on it', async () => {
  // It used to carry a solid live fill at all times, which made it the most saturated
  // thing on a screen whose focus was somewhere else entirely. On this grid a solid
  // fill means focus.
  const tree = await createTree(<NowPill onPress={jest.fn()} />)
  const pill = tree.root.findAll((n: any) => n.props?.accessibilityRole === 'button')[0]
  expect(flat(pill).backgroundColor).toBe('transparent')
  expect(flat(pill).borderColor).toBe(theme.colors.live)
})
