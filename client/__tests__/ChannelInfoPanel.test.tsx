// ChannelInfoPanel EPG slot (S27): a channel carrying epgUrl/epgId shows a live
// now/next guide (fetched via the shared EpgService, mocked here); a channel without
// one keeps the honest "No program information" placeholder.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import { ChannelInfoPanel } from '../src/components/ChannelInfoPanel'
import { epg } from '../src/epg'
import type { Stream } from '../src/worklet'

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
}

const baseStream: Stream = { id: 'anime.conan', title: 'Detective Conan', isLive: true, category: ['Anime'] }
const props = { number: 1, favorite: false, playing: false, onWatch: () => {}, onToggleFavorite: () => {} }

// The guide starts a 30 s refresh interval; unmount in afterEach so it doesn't
// outlive the test (jest worker teardown + "import after teardown" warnings).
const mounted: RendererInstance[] = []
async function createTree (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  await ReactTestRenderer.act(async () => {}) // flush the resolved fetch
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  jest.restoreAllMocks()
})

test('renders now + up-next when the channel has an EPG', async () => {
  const now = Date.now()
  jest.spyOn(epg, 'getNowNext').mockResolvedValue({
    now: { title: 'Conan A', start: now - 600_000, stop: now + 1_200_000 },
    next: [
      { title: 'Conan B', start: now + 1_200_000, stop: now + 4_800_000 },
      { title: 'Conan C', start: now + 4_800_000, stop: now + 8_400_000 }
    ]
  })
  const stream: Stream = { ...baseStream, epgUrl: 'https://epg.example/anime.json', epgId: 'conan' }
  const tree = await createTree(<ChannelInfoPanel stream={stream} {...props} />)
  const t = texts(tree)
  expect(t).toContain('Conan A')
  expect(t).toContain('UP NEXT')
  expect(t).toContain('Conan B')
  expect(t).toContain('Conan C')
  expect(t).not.toContain('No program information')
  expect(epg.getNowNext).toHaveBeenCalledWith('https://epg.example/anime.json', 'conan')
})

test('keeps the honest placeholder for a channel with no EPG (and never fetches)', async () => {
  const spy = jest.spyOn(epg, 'getNowNext')
  const tree = await createTree(<ChannelInfoPanel stream={baseStream} {...props} />)
  expect(texts(tree)).toContain('No program information')
  expect(spy).not.toHaveBeenCalled()
})

test('an EPG channel that resolves empty falls back to the placeholder', async () => {
  jest.spyOn(epg, 'getNowNext').mockResolvedValue({ now: null, next: [] })
  const stream: Stream = { ...baseStream, epgUrl: 'https://epg.example/anime.json', epgId: 'ghost' }
  const tree = await createTree(<ChannelInfoPanel stream={stream} {...props} />)
  expect(texts(tree)).toContain('No program information')
})
