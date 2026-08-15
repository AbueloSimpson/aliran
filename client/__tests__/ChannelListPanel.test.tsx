// ChannelListPanel render economics (the list_scroll jank fix, measured on the
// 32-bit TCL boxes): rows are memoized and every prop the panel hands them is
// identity-stable, so a panel re-render must NOT re-run mounted row bodies — only
// the rows whose own data changed. useEpg is the counter: every ChannelRow body
// calls it exactly once per render, so its call count IS the row render count.
// Also pins the two-tier OK dispatch now that it lives in the panel's single
// stable handler rather than a per-row closure: the playing row's press goes to
// onGuide, every other row's to onSelect, long-press to onInfo — each carrying
// the row's own stream.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import type { Stream } from '../src/worklet'

// The panel is a FlatList, and RN's pulls in untranspiled ESM this preset cannot
// parse (the VodScreen suite's lesson) — replace it with a plain "render every row"
// list. It re-renders wholesale whenever the panel does, which is exactly the
// pressure the row memo has to hold against.
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

// useEpg doubles as the render counter (each row body calls it once per render);
// stubbing it also keeps the 30 s refresh interval out of the test entirely.
jest.mock('@aliran/react-native', () => ({
  ...jest.requireActual('@aliran/react-native'),
  useEpg: jest.fn(() => ({ data: null, loaded: true }))
}))

const { ChannelListPanel } = require('../src/components/ChannelListPanel')
const { useEpg } = require('@aliran/react-native')

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
  jest.clearAllMocks()
})

const streams: Stream[] = ['one', 'two', 'three', 'four', 'five'].map((id, i) => (
  { id, title: `Channel ${i + 1}`, isLive: true, description: 'via demotv' }
))
const numbers = new Map(streams.map((s, i) => [s.id, i + 1]))

function panelProps (over: Record<string, unknown> = {}) {
  return {
    streams,
    heading: 'CHANNELS',
    numbers,
    playingId: 'two',
    favorites: [] as string[],
    onSelect: jest.fn(),
    onInfo: jest.fn(),
    onGuide: jest.fn(),
    onActivity: jest.fn(),
    ...over
  }
}

/** The row Pressable that prints this title (rows carry no accessibility label). */
function row (tree: RendererInstance, title: string) {
  const hit = tree.root.findAll((n: any) => typeof n.props?.onPress === 'function' && typeof n.props?.onLongPress === 'function')
    .find((n: any) => n.findAllByType(Text)
      .map((x: any) => [x.props.children].flat(9).map(String).join('')).join(' ').includes(title))
  if (!hit) throw new Error(`no "${title}" row in the panel`)
  return hit
}

test('a panel re-render does not re-run mounted row bodies', async () => {
  const props = panelProps()
  const tree = await createTree(<ChannelListPanel {...props} />)
  const afterMount = (useEpg as jest.Mock).mock.calls.length
  expect(afterMount).toBeGreaterThanOrEqual(streams.length) // every row mounted once

  // Same props, new elements: the memoized panel itself bails.
  await ReactTestRenderer.act(async () => { tree.update(<ChannelListPanel {...props} />) })
  expect((useEpg as jest.Mock).mock.calls.length).toBe(afterMount)

  // A header-only change re-renders the panel AND the list — the rows' props are all
  // identity-stable, so every row body must still be skipped.
  await ReactTestRenderer.act(async () => { tree.update(<ChannelListPanel {...props} heading="NEWS" />) })
  expect((useEpg as jest.Mock).mock.calls.length).toBe(afterMount)
})

test('a favorites change re-renders ONLY the row it touched', async () => {
  const props = panelProps()
  const tree = await createTree(<ChannelListPanel {...props} />)
  const afterMount = (useEpg as jest.Mock).mock.calls.length
  await ReactTestRenderer.act(async () => { tree.update(<ChannelListPanel {...props} favorites={['four']} />) })
  // One row flipped favorite=false→true; the other four keep every prop and skip.
  expect((useEpg as jest.Mock).mock.calls.length).toBe(afterMount + 1)
})

test('two-tier OK through the shared handler: playing row → onGuide, others → onSelect, long-press → onInfo', async () => {
  const props = panelProps()
  const tree = await createTree(<ChannelListPanel {...props} />)
  await ReactTestRenderer.act(async () => { row(tree, 'Channel 2').props.onPress() }) // the playing row
  expect(props.onGuide).toHaveBeenCalledWith(streams[1])
  expect(props.onSelect).not.toHaveBeenCalled()
  await ReactTestRenderer.act(async () => { row(tree, 'Channel 3').props.onPress() })
  expect(props.onSelect).toHaveBeenCalledWith(streams[2])
  await ReactTestRenderer.act(async () => { row(tree, 'Channel 5').props.onLongPress() })
  expect(props.onInfo).toHaveBeenCalledWith(streams[4])
})

test('without onGuide the playing row falls back to onSelect (the error-retry contract)', async () => {
  // LiveScreen passes onGuide={undefined} while a playback error is up so that
  // re-selecting the SAME channel stays the retry the error message promises.
  const props = panelProps({ onGuide: undefined })
  const tree = await createTree(<ChannelListPanel {...props} />)
  await ReactTestRenderer.act(async () => { row(tree, 'Channel 2').props.onPress() })
  expect(props.onSelect).toHaveBeenCalledWith(streams[1])
})
