// The in-player search grid's TELEVISION clipping rule — the channel list's focus fault
// (TvChannelListPager, "the rows stay attached") on the second of the three lists that
// carried it.
//
// removeClippedSubviews DETACHES the mounted-but-off-screen cells from the native view
// tree, and on Android a detached view is also out of FOCUS SEARCH. This grid's result
// cards are Pressables — they ARE the focusables — so with the flag on, a DOWN press on
// the last visible row finds nothing below it and focus wraps back to the top of the
// results, taking the scroll with it: the operator's "it goes down four or five channels
// and jumps back up", on cards.
//
// The panel is still phone-gated in LiveScreen (television keeps its own SearchScreen),
// so this lane guards the D-pad readiness the component's header promises rather than a
// screen a viewer can reach today — the flag has to already be right on the day TV adopts
// the panel, and nothing about the panel says "phone" to whoever adopts it.
//
// What the fix must NOT change is the mounted WINDOW: windowSize and initialNumToRender
// are what govern how many cards are alive at once, and they were never what broke the
// focus.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import type { Stream } from '../src/worklet'

// The FlatList stand-in (RN's pulls in untranspiled ESM this preset cannot parse — the
// VodScreen suite's lesson): renders every row, and keeps the props where the test can
// read them, which is the only way to see a prop that has no rendered consequence.
const mockList: { props: any } = { props: null }
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = require('react')
  const MockView = require('react-native/Libraries/Components/View/View').default
  const MockFlatList = ReactActual.forwardRef((props: any, _ref: any) => {
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
const { SearchPanel } = require('../src/components/SearchPanel')
const { backend } = require('../src/worklet')
const { theme } = require('../src/theme')

afterAll(() => { Object.defineProperty(Platform, 'isTV', realIsTV) })

const streams: Stream[] = [
  { id: 'moon-cat', title: 'Moon Cat', isLive: true, order: 1 },
  { id: 'news', title: 'News 24', isLive: true, order: 2 },
  { id: 'cafe', title: 'Café TV', isLive: true, order: 3 }
]

const mounted: RendererInstance[] = []
async function panel (): Promise<RendererInstance> {
  ;(backend as any).streams = streams
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SearchPanel playingId="moon-cat" onTune={jest.fn()} />)
  })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  mockList.props = null
  ;(backend as any).streams = []
})

test('television result cards are never DETACHED — off-screen cards have to stay findable by focus search', async () => {
  await panel()
  expect(theme.isTV).toBe(true) // the fake landed: without it this lane proves nothing
  expect(mockList.props.removeClippedSubviews).toBe(false)
  // The mounted window itself is unchanged: that is what governs how many cards are alive
  // at once, and it was never what broke the focus. initialNumToRender still tracks the
  // derived column count (four rows of results), rather than having been pinned to a
  // constant on the way past.
  expect(mockList.props.windowSize).toBe(5)
  expect(mockList.props.numColumns).toBeGreaterThanOrEqual(2)
  expect(mockList.props.initialNumToRender).toBe(mockList.props.numColumns * 4)
})

test('…and the cards ARE the focusables, which is the whole reason the flag has to go', async () => {
  const tree = await panel()
  // Every result is a Pressable of its own — nothing here is a virtual-focus row the way
  // the guide grid's are, which is why the guide keeps the flag and this grid cannot.
  const cards = tree.root.findAll((n: any) =>
    typeof n.props?.onPress === 'function' && typeof n.props?.accessibilityLabel === 'string')
    .filter((n: any) => streams.some((s) => n.props.accessibilityLabel.includes(s.title!)))
  expect(cards.length).toBeGreaterThanOrEqual(streams.length)
})
