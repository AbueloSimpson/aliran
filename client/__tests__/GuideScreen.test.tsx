// GuideScreen, phone presentation (WS7): the same zoomed-out TIME-GRID as the TV
// guide, built for touch (components/GuidePanel.tsx) — program cells from the shared
// cellRect math inside the 2 h window, the honest "No program information" cell for
// guide-less channels (D2 — no fake data), and tapping a row tunes it (the same Live
// jump Favorites makes). The TV grid's D-pad rules live in guide.test.ts (pure
// reducer); this suite only pins the phone grid's rendering contract.
//
// WS11 additions: the channel column is IDENTITY (station logo, never the live
// thumb), and the panel's 'overlay' preview mode (LiveScreen landscape) runs the
// two-tier tap — first tap selects a row and raises the upper-right preview card
// (the live thumb's ONE surface), the second tap on the same row tunes.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, Image } from 'react-native'

// RN's FlatList pulls in untranspiled ESM this preset cannot parse (the VodScreen
// suite's lesson) — replace it with a plain "render every row" list.
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = require('react')
  const MockView = require('react-native/Libraries/Components/View/View').default
  const spy: any = { scrollToIndex: jest.fn(), scrollToOffset: jest.fn(), props: null }
  const MockFlatList = ReactActual.forwardRef((props: any, ref: any) => {
    ReactActual.useImperativeHandle(ref, () => spy, [])
    spy.props = props
    const data = props.data || []
    return ReactActual.createElement(MockView, null, data.map((item: any, index: number) =>
      ReactActual.createElement(
        MockView,
        { key: props.keyExtractor ? props.keyExtractor(item, index) : String(index) },
        props.renderItem({ item, index })
      )))
  })
  return { __esModule: true, default: MockFlatList, __spy: spy }
})

import { GuideScreen } from '../src/screens/GuideScreen'
import { GuidePanel } from '../src/components/GuidePanel'
import { backend } from '../src/worklet'
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
  ;(backend as any).streams = []
})

const guided: Stream = { id: 'moon-cat', title: 'Moon Cat', isLive: true, epgUrl: 'https://epg.example/a.json', epgId: 'moon-cat' }
const guideless: Stream = { id: 'shop-tv', title: 'Shop TV', isLive: true }

function screen (navigate = jest.fn()) {
  const navigation: any = { navigate }
  const route: any = { params: { streamId: 'moon-cat' } }
  return <GuideScreen navigation={navigation} route={route} />
}

test('phone grid: airing + upcoming cells on guided rows, the honest placeholder on guide-less ones', async () => {
  const now = Date.now()
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([
    { title: 'El caso del hombre topo (II)', start: now - 6e5, stop: now + 6e5 },
    { title: 'Up Next Show', start: now + 6e5, stop: now + 12e5 }
  ])
  ;(backend as any).streams = [guided, guideless]
  const t = texts(await createTree(screen()))
  expect(t).toContain('GUIDE')
  // Both programs sit inside the 2 h window — each is its OWN timeline cell now
  // (the old list showed only now/next lines; the on-device feedback that drove
  // the grid rebuild).
  expect(t).toContain('El caso del hombre topo (II)') // the airing cell
  expect(t).toContain('Up Next Show') // the upcoming cell in the same window
  expect(t).toContain('No program information') // guide-less row, never fake data
  expect(t).toContain('NOW') // the floating jump-back pill
})

test('phone rows: skeleton cells while the first fetch runs — the honest placeholder only once ready (WS17)', async () => {
  // A deferred fetch: the guided row's answer stays in flight until WE resolve it.
  let resolve!: (p: any[]) => void
  jest.spyOn(epg, 'getPrograms').mockReturnValue(new Promise((r) => { resolve = r }))
  ;(backend as any).streams = [guided, guideless]
  const tree = await createTree(<GuidePanel playingId={null} onTune={jest.fn()} />)
  const placeholders = () => texts(tree).split('No program information').length - 1
  // Guide-less row: nothing will ever be fetched → its honest answer shows at once.
  // Guided row: the fetch is IN FLIGHT → skeleton cells, never the wrong message.
  expect(placeholders()).toBe(1)
  await ReactTestRenderer.act(async () => { resolve([]) })
  // Resolved empty → now the guided row's honest answer joins the guide-less one.
  expect(placeholders()).toBe(2)
})

test('tapping a row tunes it (navigates to Live with that channel)', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [guided, guideless]
  const navigate = jest.fn()
  const tree = await createTree(screen(navigate))
  // The whole grid row is the tap-to-tune surface. The Pressable COMPOSITE carries
  // onPress (the VodScreen suite's lesson); Shop TV's row is found by its
  // accessibility label (the channel column shows number + thumb, not the title).
  const row = tree.root.findAll((n) => typeof n.props.onPress === 'function')
    .find((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.includes('Shop TV'))!
  await ReactTestRenderer.act(async () => { row.props.onPress() })
  // tuneKey: the fresh stamp that makes a value-equal streamId still fire Live's
  // param effect (re-tuning the channel Live is already on).
  expect(navigate).toHaveBeenCalledWith('Live', { streamId: 'shop-tv', tuneKey: expect.any(Number) })
})

// --- WS11: logo-only channel column ---

const LOGO = 'http://127.0.0.1:1234/assets/moon-cat/logo.png'
const THUMB = 'http://127.0.0.1:1234/feedthumb/moon-cat'

test('channel column: station logo (letterboxed), never the live thumb', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [{ ...guided, logo: LOGO, thumbBase: THUMB }, guideless]
  const tree = await createTree(screen())
  const images = tree.root.findAllByType(Image)
  const logo = images.find((i) => i.props.source.uri === LOGO)!
  expect(logo.props.resizeMode).toBe('contain')
  expect(logo.props.accessibilityLabel).toBe('Moon Cat') // the title, not "live preview"
  // The standalone screen has no preview pane — nothing anywhere probes ?t= thumbs.
  expect(images.some((i) => /\?t=/.test(i.props.source.uri))).toBe(false)
})

// --- WS11: the overlay preview mode (LiveScreen landscape 'guide') ---
// First tap SELECTS the row (highlight + the upper-right preview card — the live
// thumbnail's one surface); the second tap on the SAME row tunes. Tapping another
// row moves the selection; a category switch clears it.

function rowFor (tree: RendererInstance, title: string) {
  return tree.root.findAll((n) => typeof n.props.onPress === 'function')
    .find((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.includes(title))!
}

function pressableWithText (tree: RendererInstance, label: string) {
  const txt = tree.root.findAllByType(Text).find((x) => [x.props.children].flat().join('') === label)!
  let n: any = txt.parent
  while (n && typeof n.props.onPress !== 'function') n = n.parent
  return n
}

test('overlay mode: first tap selects (preview card, no tune); second tap on the same row tunes', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [guided, { ...guideless, thumbBase: 'http://127.0.0.1:1234/feedthumb/shop-tv' }]
  const onTune = jest.fn()
  const tree = await createTree(<GuidePanel playingId="moon-cat" preview="overlay" onTune={onTune} />)
  expect(texts(tree)).not.toContain('Tap again to watch') // nothing selected yet

  await ReactTestRenderer.act(async () => { rowFor(tree, 'Shop TV').props.onPress() })
  expect(onTune).not.toHaveBeenCalled()
  const t = texts(tree)
  expect(t).toContain('Shop TV') // the card names the placed channel
  expect(t).toContain('Tap again to watch') // the second-tap teaching line
  // The card carries the live thumb — the ONE ?t= probe in the whole guide.
  expect(tree.root.findAllByType(Image).some((i) => /feedthumb\/shop-tv\?t=/.test(i.props.source.uri))).toBe(true)

  await ReactTestRenderer.act(async () => { rowFor(tree, 'Shop TV').props.onPress() })
  expect(onTune).toHaveBeenCalledTimes(1)
  expect(onTune.mock.calls[0][0].id).toBe('shop-tv')
  expect(texts(tree)).not.toContain('Tap again to watch') // selection cleared on tune
})

test('overlay mode: tapping another row moves the selection instead of tuning', async () => {
  const now = Date.now()
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  // The card's "now info" line — the selected channel's airing program.
  jest.spyOn(epg, 'getNowNext').mockResolvedValue({ now: { title: 'Lunar Grooming Hour', start: now - 6e5, stop: now + 6e5 }, next: [] })
  ;(backend as any).streams = [{ ...guided, logo: LOGO, thumbBase: THUMB }, guideless]
  const onTune = jest.fn()
  const tree = await createTree(<GuidePanel playingId={null} preview="overlay" onTune={onTune} />)
  await ReactTestRenderer.act(async () => { rowFor(tree, 'Shop TV').props.onPress() })
  await ReactTestRenderer.act(async () => { rowFor(tree, 'Moon Cat').props.onPress() })
  expect(onTune).not.toHaveBeenCalled()
  const t = texts(tree)
  expect(t).toContain('Moon Cat') // the card follows the selection
  expect(t).toContain('Lunar Grooming Hour') // and carries the airing program
})

test('overlay mode: the PLAYING channel previews as the logo card, never a thumb probe', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  jest.spyOn(epg, 'getNowNext').mockResolvedValue({ now: null, next: [] })
  ;(backend as any).streams = [{ ...guided, logo: LOGO, thumbBase: THUMB }, guideless]
  const onTune = jest.fn()
  const tree = await createTree(<GuidePanel playingId="moon-cat" preview="overlay" onTune={onTune} />)
  await ReactTestRenderer.act(async () => { rowFor(tree, 'Moon Cat').props.onPress() })
  expect(onTune).not.toHaveBeenCalled()
  const images = tree.root.findAllByType(Image)
  // The card art is the logo (the live picture is already on screen behind the
  // guide) — no ?t= probe anywhere.
  expect(images.some((i) => /\?t=/.test(i.props.source.uri))).toBe(false)
  expect(texts(tree)).toContain('Tap again to watch')
})

test('overlay mode: a category switch clears the selection', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [{ ...guided, category: ['News'] }, guideless]
  const onTune = jest.fn()
  const tree = await createTree(<GuidePanel playingId={null} preview="overlay" onTune={onTune} />)
  await ReactTestRenderer.act(async () => { rowFor(tree, 'Shop TV').props.onPress() })
  expect(texts(tree)).toContain('Tap again to watch')
  await ReactTestRenderer.act(async () => { pressableWithText(tree, 'NEWS').props.onPress() })
  expect(texts(tree)).not.toContain('Tap again to watch')
})

test('standalone phone screen (no preview prop): tap tunes immediately, no card', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [guided, guideless]
  const onTune = jest.fn()
  const tree = await createTree(<GuidePanel playingId={null} onTune={onTune} />)
  await ReactTestRenderer.act(async () => { rowFor(tree, 'Shop TV').props.onPress() })
  expect(onTune).toHaveBeenCalledTimes(1)
  expect(texts(tree)).not.toContain('Tap again to watch')
})

// ─── "Play on a TV" from the guide (the header chip) ─────────────────────────────
//
// The bar's TV button can only send WHAT IS PLAYING, and it lives inside fullscreen behind
// an auto-hide timer — unreachable in portrait, whose resting state is this guide. So the
// chip is the portrait route to the feature, and in landscape it does the thing the bar
// cannot: send the row the viewer has SELECTED, without tuning it on this phone first.

test('guide chip: absent unless the host offers it', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [guided, guideless]
  const tree = await createTree(<GuidePanel playingId="moon-cat" onTune={jest.fn()} />)
  expect(texts(tree)).not.toContain('Play on TV')
})

test('guide chip: with no selection it sends the PLAYING channel', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [guided, guideless]
  const onSendToTv = jest.fn()
  const tree = await createTree(<GuidePanel playingId="moon-cat" onTune={jest.fn()} onSendToTv={onSendToTv} />)
  await ReactTestRenderer.act(async () => { pressableWithText(tree, 'TV PLAY ON TV').props.onPress() })
  expect(onSendToTv).toHaveBeenCalledTimes(1)
  expect(onSendToTv.mock.calls[0][0].id).toBe('moon-cat')
})

// THE POINT OF PUTTING IT HERE. Landscape selects a row before it tunes one, so the chip
// can name a channel this phone is not watching — no local tune, no stream this phone
// never wanted, and the television pulls it off the swarm itself.
test('guide chip: a selected row is what gets sent, not what is playing', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [guided, guideless]
  const onSendToTv = jest.fn()
  const tree = await createTree(<GuidePanel playingId="moon-cat" preview="overlay" onTune={jest.fn()} onSendToTv={onSendToTv} />)
  await ReactTestRenderer.act(async () => { rowFor(tree, 'Shop TV').props.onPress() }) // select, not tune
  await ReactTestRenderer.act(async () => { pressableWithText(tree, 'TV PLAY ON TV').props.onPress() })
  expect(onSendToTv.mock.calls[0][0].id).toBe('shop-tv')
})

// Nothing selected and nothing playing = nothing to send, so the chip does not appear
// rather than appearing and refusing.
test('guide chip: hidden when there is nothing to send', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [guided, guideless]
  const tree = await createTree(<GuidePanel playingId={null} onTune={jest.fn()} onSendToTv={jest.fn()} />)
  expect(texts(tree)).not.toContain('PLAY ON TV')
})
