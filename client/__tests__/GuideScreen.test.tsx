// GuideScreen, phone presentation (WS3): one channel per row — the airing program
// for guided channels, the honest "No program information" line for guide-less ones
// (D2 — no fake data), and tapping a row tunes it (the same Live jump Favorites
// makes). The TV grid's D-pad rules live in guide.test.ts (pure reducer); this
// suite only pins the list's rendering contract.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'

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

import { GuideScreen } from '../src/screens/GuideScreen'
import { backend } from '../src/worklet'
import { epg } from '@aliran/react-native'
import type { Stream } from '../src/worklet'

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
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
})

const guided: Stream = { id: 'moon-cat', title: 'Moon Cat', isLive: true, epgUrl: 'https://epg.example/a.json', epgId: 'moon-cat' }
const guideless: Stream = { id: 'shop-tv', title: 'Shop TV', isLive: true }

function screen (navigate = jest.fn()) {
  const navigation: any = { navigate }
  const route: any = { params: { streamId: 'moon-cat' } }
  return <GuideScreen navigation={navigation} route={route} />
}

test('phone list: airing program on guided rows, the honest placeholder on guide-less ones', async () => {
  const now = Date.now()
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([
    { title: 'El caso del hombre topo (II)', start: now - 6e5, stop: now + 6e5 },
    { title: 'Up Next Show', start: now + 6e5, stop: now + 12e5 }
  ])
  ;(backend as any).streams = [guided, guideless]
  const t = texts(await createTree(screen()))
  expect(t).toContain('GUIDE')
  expect(t).toContain('El caso del hombre topo (II)') // the airing program
  expect(t).toContain('Up Next Show') // next-program line + upcoming cell
  expect(t).toContain('No program information') // guide-less row, never fake data
})

test('tapping a row tunes it (navigates to Live with that channel)', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [guided, guideless]
  const navigate = jest.fn()
  const tree = await createTree(screen(navigate))
  // The Pressable COMPOSITE carries onPress (the VodScreen suite's lesson).
  const row = tree.root.findAll((n) => typeof n.props.onPress === 'function')
    .find((n) => n.findAllByType(Text).some((tx) => [tx.props.children].flat(9).join('') === 'Shop TV'))!
  await ReactTestRenderer.act(async () => { row.props.onPress() })
  // tuneKey: the fresh stamp that makes a value-equal streamId still fire Live's
  // param effect (re-tuning the channel Live is already on).
  expect(navigate).toHaveBeenCalledWith('Live', { streamId: 'shop-tv', tuneKey: expect.any(Number) })
})
