// MenuScreen (WS5): the hub wallpaper becomes the featured channel's LIVE feed thumb
// when one is rolling — layered over the backdrop, which stays the fallback while the
// thumb loads and when it 404s (the ordinary "no thumbnail right now" answer). The
// footer gains a now-playing line (EPG now title, omitted without a guide) whose LIVE
// chip only appears with live evidence (the thumb actually showing). And the section
// bar gains a GUIDE tile, default-on, hidden by sections.guide:false.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, Image, StyleSheet } from 'react-native'
import { MenuScreen } from '../src/screens/MenuScreen'
import { backend, type Stream } from '../src/worklet'
import { loadServiceDescriptor } from '../src/config'
import { theme } from '../src/theme'
import { epg } from '@aliran/react-native'

const BACKDROP = 'http://127.0.0.1:1234/assets/news/backdrop.jpg'
const THUMB = 'http://127.0.0.1:1234/feedthumb/news'

function heroStream (extra: Partial<Stream> = {}): Stream {
  return { id: 'news', title: 'News 24', isLive: true, featured: true, backdrop: BACKDROP, ...extra } as Stream
}

const navigation = { navigate: jest.fn() } as any

function texts (tree: RendererInstance): string[] {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join(''))
}

const mounted: RendererInstance[] = []
async function mount (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  jest.restoreAllMocks()
  backend.streams = []
  // loadServiceDescriptor hands out the ONE shared descriptor object (the module-level
  // service.json) — the same reference MenuScreen captured at import, so tests toggle
  // sections through it and must put it back.
  delete (loadServiceDescriptor() as any).sections
  navigation.navigate.mockClear()
})

// --- live-aware hero ---

test('hero: the featured channel\'s feed thumb layers over the backdrop', async () => {
  backend.streams = [heroStream({ thumbBase: THUMB })]
  const tree = await mount(<MenuScreen navigation={navigation} route={{} as any} />)
  const images = tree.root.findAllByType(Image)
  expect(images).toHaveLength(2)
  expect(images[0].props.source.uri).toBe(BACKDROP) // backdrop stays mounted underneath
  // Cache-busted: the thumbnail rolls in place, so the URL must change per refresh.
  expect(images[1].props.source.uri).toMatch(new RegExp('^' + THUMB + '\\?t='))
  expect(images[1].props.resizeMode).toBe('cover')
  expect(images[1].props.accessibilityLabel).toContain('News 24')
}, 15000) // first suite render pays the cold transform cache under parallel load

test('hero: no thumbBase leaves today\'s exact backdrop-only wallpaper', async () => {
  backend.streams = [heroStream()]
  const tree = await mount(<MenuScreen navigation={navigation} route={{} as any} />)
  const images = tree.root.findAllByType(Image)
  expect(images).toHaveLength(1)
  expect(images[0].props.source.uri).toBe(BACKDROP)
})

test('hero: a thumb 404 falls back to the backdrop (never a broken image)', async () => {
  backend.streams = [heroStream({ thumbBase: THUMB })]
  const tree = await mount(<MenuScreen navigation={navigation} route={{} as any} />)
  const thumb = tree.root.findAllByType(Image)[1]
  await ReactTestRenderer.act(async () => { thumb.props.onError() })
  const images = tree.root.findAllByType(Image)
  expect(images).toHaveLength(1)
  expect(images[0].props.source.uri).toBe(BACKDROP)
})

// --- now-playing line + LIVE chip ---

test('footer: EPG now title with a LIVE chip once a thumb frame loads', async () => {
  const now = Date.now()
  jest.spyOn(epg, 'getNowNext').mockResolvedValue({ now: { title: 'Evening Bulletin', start: now - 6e5, stop: now + 6e5 }, next: [] })
  backend.streams = [heroStream({ thumbBase: THUMB, epgUrl: 'https://epg.example/a.json', epgId: 'news' })]
  const tree = await mount(<MenuScreen navigation={navigation} route={{} as any} />)
  // The chip latches on a decoded frame, not URL truthiness (the 30 s re-probe
  // flips the URL truthy on 404ing feeds too) — so no chip before onLoad...
  expect(texts(tree)).toContain('Evening Bulletin')
  expect(texts(tree)).not.toContain('LIVE') // exact — the hero line's marker is '● LIVE'
  // ...and the chip appears once the thumb actually paints.
  const thumb = tree.root.findAllByType(Image)[1]
  await ReactTestRenderer.act(async () => { thumb.props.onLoad() })
  expect(texts(tree)).toContain('LIVE')
})

test('footer: no LIVE chip without the thumb; no now line at all without EPG', async () => {
  const now = Date.now()
  jest.spyOn(epg, 'getNowNext').mockResolvedValue({ now: { title: 'Evening Bulletin', start: now - 6e5, stop: now + 6e5 }, next: [] })
  backend.streams = [heroStream({ epgUrl: 'https://epg.example/a.json', epgId: 'news' })]
  const withEpg = texts(await mount(<MenuScreen navigation={navigation} route={{} as any} />))
  expect(withEpg).toContain('Evening Bulletin')
  expect(withEpg).not.toContain('LIVE') // chip needs live evidence ('● LIVE' ≠ 'LIVE')

  backend.streams = [heroStream()]
  const noEpg = texts(await mount(<MenuScreen navigation={navigation} route={{} as any} />))
  expect(noEpg).not.toContain('Evening Bulletin')
})

// --- Guide section tile ---

test('guide tile: present by default (after Live TV); phone opens Live with the guide overlay', async () => {
  backend.streams = [heroStream()]
  const tree = await mount(<MenuScreen navigation={navigation} route={{} as any} />)
  const labels = texts(tree)
  expect(labels.indexOf('GUIDE')).toBeGreaterThan(labels.indexOf('LIVE TV'))
  // The Pressable COMPOSITE carries onPress (TrackMenu pattern) — match on the prop.
  const guide = tree.root.findAll(n => typeof n.props?.onPress === 'function' &&
    n.findAllByType(Text).some(t => [t.props.children].flat().join('') === 'GUIDE'))[0]!
  await ReactTestRenderer.act(async () => { guide.props.onPress() })
  // Jest runs the phone branch: the stream must show ABOVE the grid, so the tile
  // opens Live in guide mode (WS7). The TV branch navigates to 'Guide' instead.
  expect(navigation.navigate).toHaveBeenCalledWith('Live', { guide: true })
})

// --- phone left rail (the S22 redesign: sections run vertically down the left edge) ---

test('rail: every section is a button, in tile order down the rail', async () => {
  backend.streams = [heroStream()]
  const tree = await mount(<MenuScreen navigation={navigation} route={{} as any} />)
  // Host Views carry the forwarded accessibilityRole; composites are filtered out.
  const buttons = tree.root.findAll(n => String(n.type) === 'View' && n.props.accessibilityRole === 'button')
  const labels = buttons.map(b => b.findAllByType(Text)
    .map(t => [t.props.children].flat(9).map(String).join(''))
    .find(s => /[A-Z]/.test(s)))
  // Default phone set: no VOD (provider off), no Exit (TV-only by default).
  expect(labels).toEqual(['LIVE TV', 'GUIDE', 'FAVORITES', 'SEARCH', 'SETTINGS'])
})

test('rail: pressed tile takes the accent border (idle stays transparent)', async () => {
  backend.streams = [heroStream()]
  const tree = await mount(<MenuScreen navigation={navigation} route={{} as any} />)
  // The rail entries pass Pressable a style FUNCTION of the pressed state — evaluate
  // it directly for both states rather than simulating a gesture.
  const entry = tree.root.findAll(n => typeof n.props?.style === 'function' &&
    n.props.accessibilityRole === 'button')[0]!
  const pressed = StyleSheet.flatten(entry.props.style({ pressed: true }))
  expect(pressed.borderColor).toBe(theme.colors.accent)
  const idle = StyleSheet.flatten(entry.props.style({ pressed: false }))
  expect(idle.borderColor).toBe('transparent')
})

test('guide tile: sections.guide:false hides it', async () => {
  ;(loadServiceDescriptor() as any).sections = { guide: false }
  backend.streams = [heroStream()]
  const tree = await mount(<MenuScreen navigation={navigation} route={{} as any} />)
  expect(texts(tree)).not.toContain('GUIDE')
})
