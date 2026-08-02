// ChannelRow (S27): the now-playing line shows the current EPG program for channels
// with a guide, and falls back to the channel description otherwise. Live thumbnails:
// the right-edge picture is the channel's rolling feed thumb when one loads, and the
// station logo when it 404s (which is the ordinary answer — see thumbBase in the SDK).

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, Image } from 'react-native'
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
  const stream: Stream = { id: 'anime.moon-cat', title: 'Moon Cat', isLive: true, description: 'via demotv', epgUrl: 'https://epg.example/a.json', epgId: 'moon-cat' }
  const t = texts(await createTree(<ChannelRow stream={stream} number={1} onPress={() => {}} />))
  expect(t).toContain('El caso del hombre topo (II)')
  expect(t).not.toContain('via demotv')
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

// --- live thumbnails ---
// The engine hands out thumbBase for EVERY channel, so the row must treat a failed load
// as normal (no thumbnail right now) and keep showing art, never a broken image.

const LOGO = 'http://127.0.0.1:1234/assets/news/logo.png'
const THUMB = 'http://127.0.0.1:1234/feedthumb/news'

test('live thumbnail: the row shows the feed thumb ahead of the station logo', async () => {
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, logo: LOGO, thumbBase: THUMB }
  const tree = await createTree(<ChannelRow stream={stream} number={1} onPress={() => {}} />)
  const img = tree.root.findByType(Image)
  // Cache-busted: the thumbnail rolls in place, so the URL must change per refresh.
  expect(img.props.source.uri).toMatch(new RegExp('^' + THUMB + '\\?t='))
  expect(img.props.resizeMode).toBe('cover')
})

test('live thumbnail: a 404 falls back to the station logo', async () => {
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, logo: LOGO, thumbBase: THUMB }
  const tree = await createTree(<ChannelRow stream={stream} number={1} onPress={() => {}} />)
  await ReactTestRenderer.act(async () => { tree.root.findByType(Image).props.onError() })
  const img = tree.root.findByType(Image)
  expect(img.props.source.uri).toBe(LOGO)
  expect(img.props.resizeMode).toBe('contain') // a logo is letterboxed, not cropped
})

test('live thumbnail: a 404 with no logo leaves the initial box', async () => {
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, thumbBase: THUMB }
  const tree = await createTree(<ChannelRow stream={stream} number={1} onPress={() => {}} />)
  await ReactTestRenderer.act(async () => { tree.root.findByType(Image).props.onError() })
  expect(tree.root.findAllByType(Image)).toHaveLength(0)
  expect(texts(tree)).toContain('N')
})

test('live thumbnail: a channel without one keeps its logo and never fetches', async () => {
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, logo: LOGO }
  const tree = await createTree(<ChannelRow stream={stream} number={1} onPress={() => {}} />)
  const img = tree.root.findByType(Image)
  expect(img.props.source.uri).toBe(LOGO)
  expect(img.props.onError).toBeUndefined()
})

test('vod row: status unavailable grays the title out', async () => {
  const stream: Stream = { id: 'vod-gone', title: 'Gone Title', type: 'vod', durationSec: 100, status: 'unavailable' }
  const tree = await createTree(<ChannelRow stream={stream} onPress={() => {}} />)
  const title = tree.root.findAllByType(Text).find(x => [x.props.children].flat().join('') === 'Gone Title')!
  expect(JSON.stringify(title.props.style)).toContain('0.5') // styles.dimmed
})
