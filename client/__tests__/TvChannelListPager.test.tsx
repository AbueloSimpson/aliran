// The channel list's TELEVISION scrolling contract — the two halves of the operator's
// "the left menu is unusable on a long category" report.
//
// 1. THE CHANNEL KEYS PAGE IT. The guide grid has had a screenful-at-a-time jump on the
//    remote's CHANNEL buttons from the start; the channel list, which is where a viewer
//    actually browses 200 Live Events, had nothing but one-row D-pad steps. The keys
//    reach no focus strip (a strip is only found by a key that MOVES focus), so they
//    arrive from the Activity — channelKeys.ts — and the panel subscribes directly.
//    Pinned here: it pages from where the D-PAD is (not from the top, and not from the
//    playing channel once the viewer has moved), it clamps at both ends, the page is
//    MEASURED from the panel's own height, and the paged-to row is handed the ref that
//    asks for native focus — a scroll that left the focus behind would strand the next
//    D-pad press on an off-screen row.
//
// 2. THE ROWS STAY ATTACHED. removeClippedSubviews DETACHES off-screen rows from the
//    native view tree, and on Android that also takes them out of focus search. These
//    rows ARE the focusables, so a DOWN press on the last visible row found nothing
//    below it and focus wrapped back to the top — the operator's "it goes down four or
//    five channels and jumps back up". It stays on for phone (touch has no focus to
//    lose) and it never governed the EPG cost, which is windowSize's business.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import type { Stream } from '../src/worklet'

// The FlatList stand-in (RN's pulls in untranspiled ESM this preset cannot parse — the
// VodScreen suite's lesson): renders every row, and keeps the props + the imperative
// handle where the tests can read them.
const mockList: { props: any } = { props: null }
const mockScrollToIndex = jest.fn()
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = require('react')
  const MockView = require('react-native/Libraries/Components/View/View').default
  const MockFlatList = ReactActual.forwardRef((props: any, ref: any) => {
    ReactActual.useImperativeHandle(ref, () => ({ scrollToIndex: mockScrollToIndex, scrollToOffset: jest.fn() }), [])
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

// useEpg would otherwise run a 30 s interval per mounted row.
jest.mock('@aliran/react-native', () => ({
  ...jest.requireActual('@aliran/react-native'),
  useEpg: jest.fn(() => ({ data: null, loaded: true }))
}))

// theme.ts and channelKeys.ts both read Platform.isTV — theme once at module load, the
// key subscription at mount. The fake goes in before either is required (ordered
// require()s, not isolateModules: an isolated registry hands screen tests a second React
// and hooks throw).
const { Platform, DeviceEventEmitter } = require('react-native')
const realIsTV = Object.getOwnPropertyDescriptor(Platform, 'isTV')!
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
const { ChannelListPanel } = require('../src/components/ChannelListPanel')
const { CHANNEL_ROW_H } = require('../src/components/ChannelRow')

afterAll(() => { Object.defineProperty(Platform, 'isTV', realIsTV) })

// A row's ref lands on react-native's jest CLASS mock of View (Pressable forwards it
// there), not on a native node — so createNodeMock never gets a look in and the mock
// carries no TV methods. On the set that ref IS a host view and requestTVFocus is on it;
// teaching the mock class the same method is what lets this suite watch the panel ask.
// Contained to this file: jest gives every suite its own module registry.
const mockRequestTVFocus = jest.fn()
require('react-native/Libraries/Components/View/View').default.prototype.requestTVFocus = mockRequestTVFocus

/** Mirrors MainActivity.CHANNEL_KEY_EVENT / channelKeys.ts — the one wire the remote's
 *  CHANNEL buttons arrive on. */
const CHANNEL_KEY_EVENT = 'aliranChannelKey'

const streams: Stream[] = Array.from({ length: 30 }, (_, i) => (
  { id: `ch${i}`, title: `Channel ${i}`, isLive: true }
))
const numbers = new Map(streams.map((s, i) => [s.id, i + 1]))

const mounted: RendererInstance[] = []
async function panel (over: Record<string, unknown> = {}): Promise<RendererInstance> {
  const props = {
    streams,
    heading: 'LIVE EVENTS',
    numbers,
    playingId: 'ch0',
    favorites: [] as string[],
    onSelect: jest.fn(),
    onInfo: jest.fn(),
    onGuide: jest.fn(),
    onActivity: jest.fn(),
    ...over
  }
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<ChannelListPanel {...props} />) })
  await tick()
  mounted.push(tree)
  return tree
}
/** Let the panel's post-render timers (the focus requests) run. */
async function tick (ms = 20) {
  await ReactTestRenderer.act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, ms) }) })
}
async function pressChannel (direction: 'up' | 'down') {
  await ReactTestRenderer.act(async () => { DeviceEventEmitter.emit(CHANNEL_KEY_EVENT, direction) })
  await tick()
}
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  jest.clearAllMocks()
})

/** The row Pressable printing this title (rows carry no accessibility label). */
function row (tree: RendererInstance, title: string) {
  const hit = tree.root.findAll((n: any) => typeof n.props?.onPress === 'function' && typeof n.props?.onLongPress === 'function')
    .find((n: any) => n.findAllByType(Text)
      .map((x: any) => [x.props.children].flat(9).map(String).join('')).join(' ').includes(title))
  if (!hit) throw new Error(`no "${title}" row in the panel`)
  return hit
}
/** Walk the D-pad onto a row, the way the set does — this is what tells the pager where
 *  it is paging FROM. */
async function focusRow (tree: RendererInstance, title: string) {
  await ReactTestRenderer.act(async () => { row(tree, title).props.onFocus() })
}
/** Report a height for the box the list lives in — the panel's only onLayout, and what
 *  a "screenful" is measured against. (Rows carry one only while a focused row's marquee
 *  is measuring itself, which no test here has running; the outermost match is the
 *  composite the panel wrote, its host twin follows it.) */
async function layOut (tree: RendererInstance, height: number) {
  const box = tree.root.findAll((n: any) => typeof n.props?.onLayout === 'function')[0]
  if (!box) throw new Error('the panel measured no box for its list')
  await ReactTestRenderer.act(async () => {
    box.props.onLayout({ nativeEvent: { layout: { height } } })
  })
}
/** The index of the row currently holding the "ask this one for focus" handle. */
function pagedTo (tree: RendererInstance): number | undefined {
  return tree.root.findAll((n: any) => typeof n.props?.onPressStream === 'function')
    .find((n: any) => n.props.innerRef && n.props.index !== 0)?.props.index
}

test('CHANNEL DOWN pages a screenful from the playing row, and takes the focus with it', async () => {
  const tree = await panel()
  mockRequestTVFocus.mockClear() // the panel asks for the playing row on open
  await ReactTestRenderer.act(async () => { DeviceEventEmitter.emit(CHANNEL_KEY_EVENT, 'down') })
  // Nothing has measured the panel's height in this renderer, so the pager runs on its
  // fallback page of 5 — from the playing row (index 0), which is where the list parks.
  expect(mockScrollToIndex).toHaveBeenCalledWith({ index: 5, animated: false, viewPosition: 0.35 })
  // The focus handle goes ON the row it scrolled to: scrolling alone would leave the
  // D-pad behind on a row that is no longer on screen.
  expect(pagedTo(tree)).toBe(5)
  // A frame later that row has been asked to take the focus — and the handle is released
  // again, so a later re-mount of the same row cannot re-fire the request behind the
  // viewer's back.
  await tick()
  expect(mockRequestTVFocus).toHaveBeenCalled()
  expect(pagedTo(tree)).toBeUndefined()
})

test('it pages from where the D-PAD is, not from the playing channel', async () => {
  const tree = await panel()
  await focusRow(tree, 'Channel 8') // the viewer walked down eight rows
  await pressChannel('down')
  expect(mockScrollToIndex).toHaveBeenCalledWith({ index: 13, animated: false, viewPosition: 0.35 })
})

test('CHANNEL UP pages back, and both directions stop at the ends', async () => {
  const tree = await panel()
  await focusRow(tree, 'Channel 7')
  await pressChannel('up')
  expect(mockScrollToIndex).toHaveBeenLastCalledWith({ index: 2, animated: false, viewPosition: 0.35 })
  // At the top the key holds the list still rather than wrapping — a wrap is exactly the
  // "jumped back to the start" behaviour this whole change is here to end.
  await focusRow(tree, 'Channel 0')
  mockScrollToIndex.mockClear()
  await pressChannel('up')
  expect(mockScrollToIndex).not.toHaveBeenCalled()
  // …and the same at the bottom.
  await focusRow(tree, 'Channel 29')
  await pressChannel('down')
  expect(mockScrollToIndex).not.toHaveBeenCalled()
})

test('the page is MEASURED from the panel, not a constant', async () => {
  const tree = await panel()
  // Ten rows fit; a page is a screenful less one row of overlap, so the viewer can see
  // where they came from.
  await layOut(tree, CHANNEL_ROW_H * 10)
  await pressChannel('down')
  expect(mockScrollToIndex).toHaveBeenCalledWith({ index: 9, animated: false, viewPosition: 0.35 })
})

test('an empty list has nothing to page', async () => {
  await panel({ streams: [], playingId: null })
  await pressChannel('down')
  expect(mockScrollToIndex).not.toHaveBeenCalled()
})

test('television rows are never DETACHED — off-screen rows have to stay findable by focus search', async () => {
  await panel()
  expect(mockList.props.removeClippedSubviews).toBe(false)
  // The mounted window itself is unchanged: that is what governs the per-row EPG cost,
  // and it was never what broke the focus.
  expect(mockList.props.windowSize).toBe(5)
  expect(mockList.props.initialNumToRender).toBe(12)
})
