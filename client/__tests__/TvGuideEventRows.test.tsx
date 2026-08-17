// What a GUIDE-LESS row says on the television grid.
//
// It used to say one thing: "No program information", italic, across a two-hour strip
// of nothing. On this operator's lineup that is not an edge case — it is the LIVE EVENTS
// rails, whose channels rotate through one fixture after another and carry no EPG at
// all, so the row's entire information is its title and whether it is on air. The
// channel column beside the strip is identity at a glance (a logo and as much of the
// name as ~100dp of a two-line box holds), and "Yankees vs Red Sox 8:00 PM" is not a
// name that fits it. The operator's report was exactly that: on the full-screen guide
// there is no way to tell whether an event is live, and the empty guide is no help.
//
// So the empty cell now carries what IS known — the full station name and the channel
// list's own LIVE badge — over the honest no-schedule note, which stays (D2: never fake
// a program) but drops to a footnote. Off-air channels dim in the list's grammar,
// guide or no guide.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, StyleSheet } from 'react-native'
import type { Stream } from '../src/worklet'

// RN's FlatList pulls in untranspiled ESM this preset cannot parse (the VodScreen
// suite's lesson) — replace it with a plain "render every row" list.
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = require('react')
  const MockView = require('react-native/Libraries/Components/View/View').default
  const MockFlatList = ReactActual.forwardRef((props: any, ref: any) => {
    ReactActual.useImperativeHandle(ref, () => ({ scrollToIndex: jest.fn(), scrollToOffset: jest.fn() }), [])
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
// before anything that reaches it is required — and the whole point of this suite is the
// TV grid (GuideScreen branches on it at the top). Ordered require()s rather than
// jest.isolateModules: an isolated registry hands screen tests a second React.
const { Platform, BackHandler } = require('react-native')
const realIsTV = Object.getOwnPropertyDescriptor(Platform, 'isTV')!
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
const { GuideScreen } = require('../src/screens/GuideScreen')
const { backend } = require('../src/worklet')
const { epg } = require('@aliran/react-native')
const { t } = require('@aliran/i18n')

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

// The grid opens on the channel Live handed it, so the guided row takes the focus and
// the preview card — which keeps the card's own text out of the counts below (it prints
// number and title as ONE node, never an exact title match).
const guided: Stream = { id: 'moon-cat', title: 'Moon Cat', isLive: true, epgUrl: 'https://epg.example/a.json', epgId: 'moon-cat' }
// The rotating events: no epgUrl/epgId/guideBase at all, so nothing is ever fetched for
// them and the strip is empty by construction — the row this whole change is about.
const event: Stream = { id: 'mlb-1', title: 'Yankees vs Red Sox', isLive: true }
const eventOff: Stream = { id: 'mlb-2', title: 'Dodgers vs Giants', isLive: false }

/** Every Text node printing EXACTLY this string. */
function printing (tree: RendererInstance, exact: string) {
  return tree.root.findAllByType(Text)
    .filter((n: any) => [n.props.children].flat(9).map(String).join('') === exact)
}
const flat = (n: any) => (StyleSheet.flatten(n.props.style) || {}) as Record<string, any>

async function grid (): Promise<RendererInstance> {
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((() => ({ remove () {} })) as any)
  const now = Date.now()
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([
    { title: 'On Air Now', start: now - 6e5, stop: now + 6e5 }
  ])
  ;(backend as any).streams = [guided, event, eventOff]
  const navigation: any = { navigate: jest.fn() }
  const route: any = { params: { streamId: 'moon-cat' } }
  return createTree(<GuideScreen navigation={navigation} route={route} />)
}

test('a guide-less row spends its empty strip on the station\'s FULL name', async () => {
  const tree = await grid()
  // Twice: the channel column's clipped two-line identity, and the whole name across the
  // strip where there is room for it. A row WITH a schedule shows its name once — the
  // name belongs in the empty cell, not pasted over everyone's programs.
  expect(printing(tree, 'Yankees vs Red Sox')).toHaveLength(2)
  expect(printing(tree, 'Moon Cat')).toHaveLength(1)
  expect(printing(tree, 'On Air Now')).toHaveLength(1)
})

test('…and on whether it is on air, in the channel list\'s badge', async () => {
  const tree = await grid()
  const badges = printing(tree, t('common.live'))
  // Exactly one: the LIVE event. The off-air event has no badge (that is the whole
  // signal), and a row with a schedule says "on air" with its airing cell instead.
  expect(badges).toHaveLength(1)
})

test('an off-air channel dims, guide or no guide — the channel list\'s grammar', async () => {
  const tree = await grid()
  // Both places the off-air name is printed carry the dim; the live event's do not.
  for (const node of printing(tree, 'Dodgers vs Giants')) expect(flat(node).opacity).toBe(0.5)
  for (const node of printing(tree, 'Yankees vs Red Sox')) expect(flat(node).opacity).toBeUndefined()
})

test('the honest "no schedule" answer is still there — a name is not a program', async () => {
  const tree = await grid()
  // D2: the grid never invents a program. Two guide-less rows, two notes.
  expect(printing(tree, t('live.noProgramInfo'))).toHaveLength(2)
})
