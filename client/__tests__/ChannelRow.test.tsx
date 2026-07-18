// ChannelRow (S27): the now-playing line shows the current EPG program for channels
// with a guide, and falls back to the channel description otherwise.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import { ChannelRow } from '../src/components/ChannelRow'
import { epg } from '../src/epg'
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
})

test('shows the current EPG program on the now-playing line', async () => {
  const now = Date.now()
  jest.spyOn(epg, 'getNowNext').mockResolvedValue({ now: { title: 'El caso del hombre topo (II)', start: now - 6e5, stop: now + 6e5 }, next: [] })
  const stream: Stream = { id: 'anime.conan', title: 'Detective Conan', isLive: true, description: 'via plutotv', epgUrl: 'https://epg.example/a.json', epgId: 'conan' }
  const t = texts(await createTree(<ChannelRow stream={stream} number={1} onPress={() => {}} />))
  expect(t).toContain('El caso del hombre topo (II)')
  expect(t).not.toContain('via plutotv')
})

test('falls back to the description for a channel with no EPG', async () => {
  const spy = jest.spyOn(epg, 'getNowNext')
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, description: 'Rolling headlines' }
  const t = texts(await createTree(<ChannelRow stream={stream} number={2} onPress={() => {}} />))
  expect(t).toContain('Rolling headlines')
  expect(spy).not.toHaveBeenCalled()
})
