// ChannelRow (S27): the now-playing line shows the current EPG program for channels
// with a guide, and falls back to the channel description otherwise.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import { ChannelRow } from '../src/components/ChannelRow'
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

// S8a: vod rows swap the LIVE badge for the runtime; no channel number; and an
// unavailable title (library took it down) renders grayed out like an off-air channel.
test('vod row: runtime badge instead of LIVE, no channel number', async () => {
  const stream: Stream = { id: 'vod-heat', title: 'Heat', type: 'vod', durationSec: 5525, status: 'available', description: 'Crime saga' }
  const tree = await createTree(<ChannelRow stream={stream} onPress={() => {}} />)
  const t = texts(tree)
  expect(t).toContain('1:32:05')
  expect(t).not.toContain('LIVE')
  expect(t).toContain('—') // the number slot: vod titles are not in the lineup
  // Not dimmed: 'available' renders at full opacity (no isLive on vod records).
  const title = tree.root.findAllByType(Text).find(x => [x.props.children].flat().join('') === 'Heat')!
  expect(JSON.stringify(title.props.style)).not.toContain('0.5')
})

test('vod row: status unavailable grays the title out', async () => {
  const stream: Stream = { id: 'vod-gone', title: 'Gone Title', type: 'vod', durationSec: 100, status: 'unavailable' }
  const tree = await createTree(<ChannelRow stream={stream} onPress={() => {}} />)
  const title = tree.root.findAllByType(Text).find(x => [x.props.children].flat().join('') === 'Gone Title')!
  expect(JSON.stringify(title.props.style)).toContain('0.5') // styles.dimmed
})
