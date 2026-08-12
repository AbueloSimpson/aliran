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

const props = { number: 1, clock: '17:45', favorite: false, onSearch: () => {}, onInfo: () => {}, onToggleFavorite: () => {}, onReport: () => {} }
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

// --- no live thumb on the bar (WS11) ---
// The bar sits under/next to the ACTUAL live video, so a rolling feed frame here only
// duplicated the picture. The engine still hands out thumbBase for every channel; the
// bar must ignore it — station logo only, no probe, ever.

const LOGO = 'http://127.0.0.1:1234/assets/news/logo.png'
const THUMB = 'http://127.0.0.1:1234/feedthumb/news'

test('the bar shows only the station logo — thumbBase never probes, nothing rolls', async () => {
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, description: 'via demotv', logo: LOGO, thumbBase: THUMB }
  const tree = await createTree(<NowPlayingBar stream={stream} {...props} />)
  const images = tree.root.findAllByType(Image)
  expect(images).toHaveLength(1) // the identity logo, nothing else
  expect(images[0].props.source.uri).toBe(LOGO)
  expect(images[0].props.resizeMode).toBe('contain')
})

// --- the remote legend is TELEVISION ONLY ---
// This suite runs at jest's default, which is a PHONE (Platform.isTV false), so it is
// the natural place to pin the negative half. The positive half — every direction of
// the pad named on screen — is TvRemoteLegend.test.tsx, which fakes isTV before load.
// A phone needs no legend: the actions the legend names are labelled BUTTONS on this
// very bar, and a row of key caps beside them would be noise about keys it has none of.

test('a phone renders no remote legend, even when the host asks for one', async () => {
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, description: 'via demotv' }
  const shown = texts(await createTree(<NowPlayingBar stream={stream} {...props} hint />))
  expect(shown).not.toContain('◀ OK')
  expect(shown).not.toContain('▲ ▼')
  expect(shown).toContain('via demotv') // …and the bar itself is untouched
})
