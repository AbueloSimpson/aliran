// The other half of RemoteStatusHost: A PHONE PUBLISHES NO HOST STATUS AT ALL.
//
// Phones never announce themselves on the rendezvous — a phone is the device that SENDS —
// so there is nobody to tell, and a phone reporting its own pauses and playhead would put
// a viewer's private viewing on the account's control channel for every other device to
// read. The gate is `theme.isTV` on both effects in LiveScreen.
//
// Its own file because theme.ts reads Platform.isTV once, at module load: the television
// case has to fake it before the screen is required, and jest.resetModules() to undo that
// mid-file hands the tree a SECOND React whose hook dispatcher is null.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'

jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: ({ visible, children }: { visible?: boolean; children?: unknown }) => (visible ? children : null)
}))

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

jest.mock('react-native-video', () => ({
  __esModule: true,
  default: function MockVideo () { return null },
  SelectedTrackType: { DISABLED: 'disabled', INDEX: 'index', LANGUAGE: 'language', TITLE: 'title' }
}))

import { LiveScreen } from '../src/screens/LiveScreen'
import { backend, type Stream } from '../src/worklet'

const NEWS = { id: 'news', title: 'News', isLive: true, order: 1 } as unknown as Stream
const FILM = { id: 'film', title: 'A Film', type: 'vod', order: 3 } as unknown as Stream

const navigation = { navigate: jest.fn(), isFocused: () => true } as any

test('a phone owns no rendezvous status — not on a channel, not on a paused title', async () => {
  ;(backend as any).streams = [NEWS, FILM]
  ;(backend as any).pending.length = 0
  backend.parental = null

  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<LiveScreen route={{ params: { streamId: 'film' } } as any} navigation={navigation} />)
  })
  await ReactTestRenderer.act(async () => {})

  // Pause the title — on a television this is the push that matters most.
  const bar = tree.root.findAll((n: any) => typeof n.props?.onTogglePause === 'function')[0]
  if (bar) await ReactTestRenderer.act(async () => { bar.props.onTogglePause() })

  // …and leave playback, which is the OTHER thing only a host knows.
  await ReactTestRenderer.act(async () => tree.unmount())

  expect((backend as any).pending.filter((m: any) => m?.type === 'remote-status')).toEqual([])
})
