// ChannelInfoPanel EPG slot (S27): a channel carrying epgUrl/epgId shows a live
// now/next guide (fetched via the shared EpgService, mocked here); a channel without
// one keeps the honest "No program information" placeholder.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Image, StyleSheet, Text } from 'react-native'
import { ChannelInfoPanel } from '../src/components/ChannelInfoPanel'
import { epg } from '@aliran/react-native'
import type { Stream } from '../src/worklet'

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
}

const baseStream: Stream = { id: 'anime.moon-cat', title: 'Moon Cat', isLive: true, category: ['Anime'] }
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
    now: { title: 'Moon Cat A', start: now - 600_000, stop: now + 1_200_000 },
    next: [
      { title: 'Moon Cat B', start: now + 1_200_000, stop: now + 4_800_000 },
      { title: 'Moon Cat C', start: now + 4_800_000, stop: now + 8_400_000 }
    ]
  })
  const stream: Stream = { ...baseStream, epgUrl: 'https://epg.example/anime.json', epgId: 'moon-cat' }
  const tree = await createTree(<ChannelInfoPanel stream={stream} {...props} />)
  const t = texts(tree)
  expect(t).toContain('Moon Cat A')
  expect(t).toContain('UP NEXT')
  expect(t).toContain('Moon Cat B')
  expect(t).toContain('Moon Cat C')
  expect(t).not.toContain('No program information')
  expect(epg.getNowNext).toHaveBeenCalledWith('https://epg.example/anime.json', 'moon-cat', undefined)
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

// WS12 (S22 feedback): on PHONE (Platform.isTV is false under jest) the resolved art
// is a full-panel BACKGROUND under a scrim, the identity compacts to a small logo +
// single title line, and the guide renders in the foreground — no 16:9 art box that
// pushes the now-program below the fold.
test('phone: art becomes the panel background and the guide stays in the foreground', async () => {
  const now = Date.now()
  jest.spyOn(epg, 'getNowNext').mockResolvedValue({
    now: { title: 'Moon Cat A', start: now - 600_000, stop: now + 1_200_000 },
    next: [{ title: 'Moon Cat B', start: now + 1_200_000, stop: now + 4_800_000 }]
  })
  const stream: Stream = {
    ...baseStream,
    poster: 'https://art.example/poster.jpg',
    logo: 'https://art.example/logo.png',
    // The engine hands thumbBase to EVERY channel — the panel must ignore it (S22
    // round-4 policy: live thumbs live in the guide preview card and the Menu hero
    // only; the panel never probes, least of all for the playing channel).
    thumbBase: 'http://127.0.0.1:1234/feedthumb/moon-cat',
    epgUrl: 'https://epg.example/anime.json',
    epgId: 'moon-cat'
  }
  const tree = await createTree(<ChannelInfoPanel stream={stream} {...props} />)

  // The art chain resolves to the CURATED poster — thumbBase never probes.
  const bg = tree.root.findAllByType(Image).filter(i => i.props.testID === 'info-art-bg')
  expect(bg).toHaveLength(1)
  expect(bg[0].props.source.uri).toBe('https://art.example/poster.jpg')
  expect(bg[0].props.style).toBe(StyleSheet.absoluteFill)

  // Identity row: the SMALL channel logo, not the old stacked 16:9 art box.
  const logo = tree.root.findAllByType(Image).filter(i => i.props.testID === 'info-logo')
  expect(logo).toHaveLength(1)
  expect(logo[0].props.source.uri).toBe('https://art.example/logo.png')

  // One title line only — the phone identity is compact by design.
  const title = tree.root.findAllByType(Text).find(t => t.props.children === 'Moon Cat')
  expect(title!.props.numberOfLines).toBe(1)

  // And the program guide still renders over the background.
  const t = texts(tree)
  expect(t).toContain('Moon Cat A')
  expect(t).toContain('UP NEXT')
})
