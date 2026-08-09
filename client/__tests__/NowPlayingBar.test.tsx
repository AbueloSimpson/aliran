// NowPlayingBar (S27): the subtitle shows the current EPG program ("now playing") for
// channels with a guide, and falls back to the channel description otherwise.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, Image } from 'react-native'
import { NowPlayingBar } from '../src/components/NowPlayingBar'
import { epg } from '@aliran/react-native'
import type { Stream } from '../src/worklet'

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
}

const props = { number: 1, clock: '17:45', favorite: false, onChannels: () => {}, onInfo: () => {}, onToggleFavorite: () => {}, onReport: () => {} }
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

test('shows the current EPG program as the subtitle, not the description', async () => {
  const now = Date.now()
  jest.spyOn(epg, 'getNowNext').mockResolvedValue({ now: { title: 'El caso del hombre topo (I)', start: now - 6e5, stop: now + 6e5 }, next: [] })
  const stream: Stream = { id: 'anime.moon-cat', title: 'Moon Cat', isLive: true, description: 'via demotv', epgUrl: 'https://epg.example/a.json', epgId: 'moon-cat' }
  const t = texts(await createTree(<NowPlayingBar stream={stream} {...props} />))
  expect(t).toContain('El caso del hombre topo (I)')
  expect(t).not.toContain('via demotv')
})

test('falls back to the description when the channel has no EPG', async () => {
  const spy = jest.spyOn(epg, 'getNowNext')
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, description: 'via demotv' }
  const t = texts(await createTree(<NowPlayingBar stream={stream} {...props} />))
  expect(t).toContain('via demotv')
  expect(spy).not.toHaveBeenCalled()
})

// S8a: a vod title grows the transport row — elapsed / runtime around the seek bar,
// and the play/pause glyph tracks the paused state.
test('vod transport: elapsed + runtime render; glyph follows paused', async () => {
  const stream: Stream = { id: 'vod-heat', title: 'Heat', type: 'vod', durationSec: 5525, description: 'Crime saga' }
  const vodProps = { ...props, stream, onTogglePause: () => {}, onSeek: () => {} }
  const playing = texts(await createTree(<NowPlayingBar {...vodProps} vod={{ position: 754, duration: 5525, paused: false }} />))
  expect(playing).toContain('12:34') // elapsed
  expect(playing).toContain('1:32:05') // runtime
  expect(playing).toContain('❚❚') // playing -> the control offers pause
  const paused = texts(await createTree(<NowPlayingBar {...vodProps} vod={{ position: 754, duration: 5525, paused: true }} />))
  expect(paused).toContain('▶') // paused -> the control offers play
})

test('no transport row for live channels', async () => {
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, description: 'via demotv' }
  const t = texts(await createTree(<NowPlayingBar stream={stream} {...props} />))
  expect(t).not.toContain('❚❚')
  expect(t).not.toContain('--:--')
})

// --- live thumbnail (WS1): the bar carries the channel's rolling feed frame next to
// the logo; a 404 (the ordinary "no thumbnail" answer) leaves the bar exactly as
// before — logo only, no broken image.

const LOGO = 'http://127.0.0.1:1234/assets/news/logo.png'
const THUMB = 'http://127.0.0.1:1234/feedthumb/news'

test('live thumb probes off-layout, then takes layout space only after onLoad', async () => {
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, description: 'via demotv', logo: LOGO, thumbBase: THUMB }
  const tree = await createTree(<NowPlayingBar stream={stream} {...props} />)
  let images = tree.root.findAllByType(Image)
  expect(images).toHaveLength(2) // logo stays
  expect(images[0].props.source.uri).toBe(LOGO)
  expect(images[1].props.source.uri).toMatch(new RegExp('^' + THUMB + '\\?t='))
  // Before a frame decodes, the probe is out of the flex flow and invisible —
  // the bar's layout is byte-identical to the no-thumb bar (zap-flash stability).
  expect(images[1].props.style).toMatchObject({ position: 'absolute', opacity: 0 })
  expect(images[1].props.accessibilityLabel).toBeUndefined()
  await ReactTestRenderer.act(async () => { images[1].props.onLoad() })
  images = tree.root.findAllByType(Image)
  expect(images[1].props.style).not.toMatchObject({ opacity: 0 })
  expect(images[1].props.resizeMode).toBe('cover')
  expect(images[1].props.accessibilityLabel).toBe('News 24 — live preview')
})

test('a thumb 404 leaves the bar as it was — logo only', async () => {
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, description: 'via demotv', logo: LOGO, thumbBase: THUMB }
  const tree = await createTree(<NowPlayingBar stream={stream} {...props} />)
  await ReactTestRenderer.act(async () => { tree.root.findAllByType(Image)[1].props.onError() })
  const images = tree.root.findAllByType(Image)
  expect(images).toHaveLength(1)
  expect(images[0].props.source.uri).toBe(LOGO)
})
