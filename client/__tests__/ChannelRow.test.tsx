// ChannelRow (S27): the now-playing line shows the current EPG program for channels
// with a guide, and falls back to the channel description otherwise. Live thumbnails:
// the right-edge picture is the channel's rolling feed thumb when one loads, and the
// station logo when it 404s (which is the ordinary answer — see thumbBase in the SDK).

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, Image } from 'react-native'
import { ChannelRow, CHANNEL_ROW_H } from '../src/components/ChannelRow'
import { epg } from '@aliran/react-native'
import { prefersReducedMotion } from '../src/motion'
import type { Stream } from '../src/worklet'

// Controllable reduced-motion answer (the real module caches an async OS setting).
jest.mock('../src/motion', () => ({ prefersReducedMotion: jest.fn(() => false) }))

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
  // Module-mock state survives restoreAllMocks — put full motion back for the next test.
  ;(prefersReducedMotion as jest.Mock).mockReturnValue(false)
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

test('live thumbnail: labelled for screen readers; the label leaves with the thumb', async () => {
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, logo: LOGO, thumbBase: THUMB }
  const tree = await createTree(<ChannelRow stream={stream} number={1} onPress={() => {}} />)
  expect(tree.root.findByType(Image).props.accessibilityLabel).toBe('News 24 — live preview')
  // After the 404 the picture is the station logo — "live preview" would be a lie.
  await ReactTestRenderer.act(async () => { tree.root.findByType(Image).props.onError() })
  expect(tree.root.findByType(Image).props.accessibilityLabel).toBeUndefined()
})

// --- guide UI (WS1) ---

// The getItemLayout contract: this constant IS the phone row geometry (jest runs the
// phone branch) — inner 64 + 2 gap. If it drifts, the list jump lands off a row.
test('row geometry: CHANNEL_ROW_H matches the pinned phone row', () => {
  expect(CHANNEL_ROW_H).toBe(66)
})

// Focus grammar: the light fill always announces focus; the scale lift is a TRANSFORM,
// so the OS reduced-motion setting turns it (and only it) off.
test('focused row: scale transform + zIndex lift, skipped under reduced motion', async () => {
  const stream: Stream = { id: 'news', title: 'News 24', isLive: true, description: 'Rolling headlines' }
  const row = (tree: RendererInstance) =>
    tree.root.findAll(n => typeof n.props.onFocus === 'function' && typeof n.props.onPress === 'function')[0]
  const tree = await createTree(<ChannelRow stream={stream} number={1} onPress={() => {}} />)
  expect(JSON.stringify(row(tree).props.style)).not.toContain('scale')
  await ReactTestRenderer.act(async () => { row(tree).props.onFocus() })
  let style = JSON.stringify(row(tree).props.style)
  expect(style).toContain('scale')
  expect(style).toContain('zIndex')

  ;(prefersReducedMotion as jest.Mock).mockReturnValue(true)
  const still = await createTree(<ChannelRow stream={stream} number={1} onPress={() => {}} />)
  await ReactTestRenderer.act(async () => { row(still).props.onFocus() })
  style = JSON.stringify(row(still).props.style)
  expect(style).not.toContain('scale')
  expect(style).toContain('#E5EEF7') // the focus fill still applies
})

// Jest runs the phone branch, where the lift is an identity transform — the tests
// above prove the GATING only. The TV value itself is pinned here by rebuilding the
// theme under a faked Platform.isTV (the i18n-suite defineProperty trick).
test('focusScale token: identity on phone, 1.025 (Android TV large-element value) on TV', () => {
  expect(require('../src/theme').theme.focusScale).toBe(1)
  // isolateModules re-instantiates react-native too — the isTV fake must be applied
  // to the FRESH instance in the isolated registry, before theme evaluates.
  jest.isolateModules(() => {
    const { Platform } = require('react-native')
    Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
    const tvTheme = require('../src/theme').theme
    expect(tvTheme.focusScale).toBe(1.025)
  })
})
