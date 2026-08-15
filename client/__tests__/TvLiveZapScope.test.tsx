// Category-aware zap + OK-restores-context (Phase 4, operator feedback) — the
// television flow, end to end through the real LiveScreen.
//
// What this pins:
//   * a channel tuned FROM a scoped list makes CH+/CH- ring over THAT category in
//     its own order (wrapping), not the global channel-number order — the reversal
//     of the old documented "the rail scopes the browse list, not the zap";
//   * OK from fullscreen reopens the left panel IN CONTEXT: scoped to the tuned-from
//     category, DRILLED into it when it is a 'Parent/Sub' (the "‹ Parent" header up,
//     the 'PARENT  ›  SUB' heading on the list), and the BACK-unwind ladder walks
//     the restored state exactly as if the viewer had drilled there by hand;
//   * an 'All' tune keeps the old global surfing feel — CH+ follows channel numbers.
//
// The harness is TvLiveDpad's: Platform.isTV faked before any module reads it, the
// focus strips stand in for D-pad presses, and the remote's CHANNEL keys arrive the
// way they really do — the Activity's DeviceEventEmitter event (channelKeys.ts).
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, StyleSheet } from 'react-native'
import type { Stream } from '../src/worklet'

jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: ({ visible, children }: { visible?: boolean; children?: unknown }) => (visible ? children : null)
}))

// The channel list and category rail behind the overlays are FlatLists, and RN's pulls
// in untranspiled ESM this preset cannot parse (the VodScreen suite's lesson) — replace
// it with a plain "render every row" list.
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = require('react')
  const MockView = require('react-native/Libraries/Components/View/View').default
  const MockFlatList = ReactActual.forwardRef((props: any, ref: any) => {
    ReactActual.useImperativeHandle(ref, () => ({ scrollToIndex: jest.fn(), scrollToOffset: jest.fn() }), [])
    const data = props.data || []
    return ReactActual.createElement(MockView, null, data.map((item: any, index: number) =>
      ReactActual.createElement(
        MockView,
        { key: props.keyExtractor ? props.keyExtractor(item, index) : String(index) },
        props.renderItem({ item, index })
      )))
  })
  return { __esModule: true, default: MockFlatList }
})

// theme.ts reads Platform.isTV ONCE, at module load — the fake goes in before anything
// that reaches it is required (ordered require()s, not isolateModules: an isolated
// registry hands screen tests a second React and hooks throw).
const { Platform, BackHandler, DeviceEventEmitter } = require('react-native')
const realIsTV = Object.getOwnPropertyDescriptor(Platform, 'isTV')!
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
const { LiveScreen, resetLiveSessionMemory } = require('../src/screens/LiveScreen')
const { backend } = require('../src/worklet')

afterAll(() => { Object.defineProperty(Platform, 'isTV', realIsTV) })

// A lineup where the global (channel-number) neighbor of every MLB game is a NEWS
// channel: a zap that follows the numbers and a zap that follows the category can
// never be confused for one another.
//
//   001 Alpha News   News
//   002 MLB One      Live Events/MLB
//   003 Beta News    News
//   004 MLB Two      Live Events/MLB
//   --- Movie Night  Library (vod — no number, in NO zap ring)
const lineup: Stream[] = [
  { id: 'alpha-news', title: 'Alpha News', isLive: true, order: 1, category: ['News'] },
  { id: 'mlb-one', title: 'MLB One', isLive: true, order: 2, category: ['Live Events/MLB'] },
  { id: 'beta-news', title: 'Beta News', isLive: true, order: 3, category: ['News'] },
  { id: 'mlb-two', title: 'MLB Two', isLive: true, order: 4, category: ['Live Events/MLB'] },
  { id: 'movie-night', title: 'Movie Night', type: 'vod', order: 9, category: ['Library'] } as Stream
]

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
  // Order independence: lastStreamId/lastTuneScope are module-level session memory
  // (deliberately — the Menu-trip restore) and would otherwise leak between tests.
  resetLiveSessionMemory()
})

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map((n: any) => [n.props.children].flat(9).map(String).join('')).join(' | ')
}

const flat = (n: any) => (StyleSheet.flatten(n.props.style) || {}) as Record<string, any>

let backHandlers: Array<() => boolean> = []

async function liveWith (params: any, streams: Stream[] = lineup): Promise<RendererInstance> {
  backHandlers = []
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_e: string, h: () => boolean) => {
    backHandlers.push(h)
    return { remove () {} }
  }) as any)
  ;(backend as any).streams = streams
  const navigation: any = { isFocused: () => true, navigate: jest.fn() }
  return createTree(<LiveScreen navigation={navigation} route={{ params } as any} />)
}

// Mounting ON a News channel: the mount derives 'News' as the tune scope (rule c),
// so every test below must OVERRIDE it by actually browsing — which is the point.
async function live (): Promise<RendererInstance> {
  return liveWith({ streamId: 'alpha-news' })
}

function pressBack (): boolean {
  if (!backHandlers.length) throw new Error('no BACK handler registered')
  return backHandlers[backHandlers.length - 1]()
}

/** The LEFT focus strip — a LEFT press from fullscreen (opens the channel list). */
function leftStrip (tree: RendererInstance) {
  const strips = tree.root.findAll((n: any) =>
    typeof n.props?.onFocus === 'function' && n.props?.style && flat(n).position === 'absolute' && flat(n).left === 0 && flat(n).width === 80)
  if (!strips.length) throw new Error('no left focus strip')
  return strips[0]
}

/** The fullscreen catcher — OK from fullscreen lands here. */
function catcher (tree: RendererInstance) {
  const c = tree.root.findAll((n: any) => n.props?.hasTVPreferredFocus && typeof n.props?.onPress === 'function')[0]
  if (!c) throw new Error('no fullscreen catcher')
  return c
}

/** A rail pill / back header found by its EXACT (upper-cased) label. */
function railPill (tree: RendererInstance, label: string) {
  const pill = tree.root.findAll((n: any) => typeof n.props?.onPress === 'function')
    .find((n: any) => n.findAllByType(Text).some((x: any) => [x.props.children].flat(9).map(String).join('') === label))
  if (!pill) throw new Error(`no ${label} rail pill`)
  return pill
}

/** A channel row (the only long-pressables) found by the title inside it. */
function channelRow (tree: RendererInstance, title: string) {
  const row = tree.root.findAll((n: any) => typeof n.props?.onLongPress === 'function')
    .find((n: any) => n.findAllByType(Text)
      .map((x: any) => [x.props.children].flat(9).map(String).join('')).join(' ').includes(title))
  if (!row) throw new Error(`no ${title} row in the channel list`)
  return row
}

/** The channel list's rows by title — counts the LIST's scope directly. */
function listTitles (tree: RendererInstance): string[] {
  return tree.root.findAll((n: any) => typeof n.props?.onLongPress === 'function')
    .map((n: any) => n.findAllByType(Text).map((x: any) => [x.props.children].flat(9).join('')).join(' '))
}

/** The remote's CHANNEL key, arriving the real way (channelKeys.ts). */
async function channelKey (direction: 'up' | 'down') {
  await ReactTestRenderer.act(async () => { DeviceEventEmitter.emit('aliranChannelKey', direction) })
}

/** Drill LIVE EVENTS › MLB and tune MLB One from that scoped list. */
async function tuneMlbOneFromDrilledList (tree: RendererInstance) {
  await ReactTestRenderer.act(async () => { leftStrip(tree).props.onFocus() })
  await ReactTestRenderer.act(async () => { railPill(tree, 'LIVE EVENTS').props.onPress() }) // OK: drill in
  await ReactTestRenderer.act(async () => { railPill(tree, 'MLB').props.onPress() }) // OK: the sub
  expect(texts(tree)).toContain('LIVE EVENTS  ›  MLB')
  await ReactTestRenderer.act(async () => { channelRow(tree, 'MLB One').props.onPress() }) // tune + collapse
}

test('CH+ after a scoped tune rings the CATEGORY, wrapping — never the next channel number', async () => {
  const tree = await live()
  await tuneMlbOneFromDrilledList(tree)
  // Fullscreen on MLB One. The next channel NUMBER is 003 Beta News; the next
  // channel in the tuned-from category is MLB Two.
  await channelKey('up')
  expect(texts(tree)).toContain('MLB Two')
  expect(texts(tree)).not.toContain('Beta News')
  // …and from the LAST game the ring WRAPS to the first, still inside the category.
  await channelKey('up')
  expect(texts(tree)).toContain('MLB One')
  expect(texts(tree)).not.toContain('Alpha News')
  // Down wraps the other way.
  await channelKey('down')
  expect(texts(tree)).toContain('MLB Two')
  expect(texts(tree)).not.toContain('Beta News')
})

test('OK from fullscreen reopens the panel DRILLED into the tuned-from sub-category', async () => {
  const tree = await live()
  await tuneMlbOneFromDrilledList(tree)
  expect(texts(tree)).not.toContain('LIVE EVENTS') // fullscreen — no panel
  // OK: the panel must come back IN CONTEXT — drilled, sub active, playing row's list.
  await ReactTestRenderer.act(async () => { catcher(tree).props.onPress() })
  expect(texts(tree)).toContain('LIVE EVENTS  ›  MLB') // the list heading
  expect(texts(tree)).toContain('‹ LIVE EVENTS') // the drill's back header
  expect(listTitles(tree).join(' ')).toContain('MLB One')
  expect(listTitles(tree)).toHaveLength(2) // the MLB games, nothing global
  // …and the PLAYING row is where the focus goes: the scope containing the channel
  // is exactly what lets ChannelListPanel's preferred-focus/requestTVFocus find it
  // (the 'All' open was why it never could before).
  expect(channelRow(tree, 'MLB One').props.hasTVPreferredFocus).toBe(true)
  expect(channelRow(tree, 'MLB Two').props.hasTVPreferredFocus).toBeFalsy()
  // The BACK-unwind ladder walks the RESTORED state exactly as a hand-made drill:
  // sub → the whole parent…
  await ReactTestRenderer.act(async () => { pressBack() })
  expect(texts(tree)).not.toContain('LIVE EVENTS  ›  MLB')
  expect(texts(tree)).toContain('‹ LIVE EVENTS') // still drilled, parent scope
  // …→ the top-level rail…
  await ReactTestRenderer.act(async () => { pressBack() })
  expect(texts(tree)).not.toContain('‹ LIVE EVENTS')
  // …→ fullscreen.
  await ReactTestRenderer.act(async () => { pressBack() })
  expect(listTitles(tree)).toHaveLength(0)
})

test('an All tune keeps the global channel-number ring', async () => {
  const tree = await live()
  await ReactTestRenderer.act(async () => { leftStrip(tree).props.onFocus() })
  await ReactTestRenderer.act(async () => { railPill(tree, 'ALL').props.onPress() }) // deliberate 'All'
  await ReactTestRenderer.act(async () => { channelRow(tree, 'MLB One').props.onPress() })
  // Tuned from 'All': CH+ follows the NUMBERS — 002 MLB One → 003 Beta News.
  await channelKey('up')
  expect(texts(tree)).toContain('Beta News')
  expect(texts(tree)).not.toContain('MLB Two')
})

test('a PARENT-scoped tune reopens WITHOUT the drill header — even off a lingering drill', async () => {
  const tree = await live()
  await ReactTestRenderer.act(async () => { leftStrip(tree).props.onFocus() })
  // OK on the parent DRILLS (drillParent set) and scopes to the whole parent —
  // tune from THAT list, so the drill state is still standing at tune time.
  await ReactTestRenderer.act(async () => { railPill(tree, 'LIVE EVENTS').props.onPress() })
  await ReactTestRenderer.act(async () => { channelRow(tree, 'MLB One').props.onPress() })
  // OK: a bare-parent scope deliberately reopens the TOP rail (no drill — one BACK
  // to close, not two). A dropped setDrillParent(null) shows up right here.
  await ReactTestRenderer.act(async () => { catcher(tree).props.onPress() })
  expect(texts(tree)).toContain('LIVE EVENTS') // the parent heading
  expect(texts(tree)).not.toContain('‹ LIVE EVENTS') // NOT drilled
  expect(texts(tree)).not.toContain('LIVE EVENTS  ›  MLB') // no sub path in the heading
  expect(listTitles(tree)).toHaveLength(2) // the parent group's channels
  // One BACK closes — the top-rail state has no drill to unwind.
  await ReactTestRenderer.act(async () => { pressBack() })
  expect(listTitles(tree)).toHaveLength(0)
})

test('zapping OUT of a vod title is a global zap: channel 001, and the scope resets to All', async () => {
  const tree = await live()
  await ReactTestRenderer.act(async () => { leftStrip(tree).props.onFocus() })
  await ReactTestRenderer.act(async () => { railPill(tree, 'LIBRARY').props.onPress() })
  await ReactTestRenderer.act(async () => { channelRow(tree, 'Movie Night').props.onPress() })
  // A title is in NO ring (its Library group filters to empty): CH+ is how you
  // leave it back into live TV — the GLOBAL ring, landing on channel 001.
  await channelKey('up')
  expect(texts(tree)).toContain('Alpha News')
  // …and the scope followed the global ring: OK reopens the plain CHANNELS list,
  // not the Library the title was picked from.
  await ReactTestRenderer.act(async () => { catcher(tree).props.onPress() })
  expect(texts(tree)).toContain('CHANNELS')
  expect(texts(tree)).not.toContain('‹')
})

// --- the one-length-ring ladder: sub → parent → global -----------------------

test('a one-game sub ring widens to the PARENT ring — and the scope follows it', async () => {
  const solo: Stream[] = [
    { id: 'alpha-news', title: 'Alpha News', isLive: true, order: 1, category: ['News'] },
    { id: 'mlb-solo', title: 'MLB Solo', isLive: true, order: 2, category: ['Live Events/MLB'] },
    { id: 'beta-news', title: 'Beta News', isLive: true, order: 3, category: ['News'] },
    { id: 'nba-one', title: 'NBA One', isLive: true, order: 4, category: ['Live Events/NBA'] }
  ]
  const tree = await liveWith({ streamId: 'alpha-news' }, solo)
  await ReactTestRenderer.act(async () => { leftStrip(tree).props.onFocus() })
  await ReactTestRenderer.act(async () => { railPill(tree, 'LIVE EVENTS').props.onPress() })
  await ReactTestRenderer.act(async () => { railPill(tree, 'MLB').props.onPress() })
  await ReactTestRenderer.act(async () => { channelRow(tree, 'MLB Solo').props.onPress() })
  // The MLB ring holds ONLY the playing game — "next channel" must still mean
  // something: the nearest wider circle is LIVE EVENTS, whose ring has the NBA game.
  await channelKey('up')
  expect(texts(tree)).toContain('NBA One')
  expect(texts(tree)).not.toContain('Beta News')
  // The scope moved WITH the ladder: the next press walks the parent ring (wraps
  // back to the MLB game), not the sub's dead one-ring and not the global order.
  await channelKey('up')
  expect(texts(tree)).toContain('MLB Solo')
  expect(texts(tree)).not.toContain('Alpha News')
})

test('a one-game PARENT ring falls back to the global ring — scope All', async () => {
  const lone: Stream[] = [
    { id: 'alpha-news', title: 'Alpha News', isLive: true, order: 1, category: ['News'] },
    { id: 'mlb-solo', title: 'MLB Solo', isLive: true, order: 2, category: ['Live Events/MLB'] },
    { id: 'beta-news', title: 'Beta News', isLive: true, order: 3, category: ['News'] }
  ]
  const tree = await liveWith({ streamId: 'alpha-news' }, lone)
  await ReactTestRenderer.act(async () => { leftStrip(tree).props.onFocus() })
  await ReactTestRenderer.act(async () => { railPill(tree, 'LIVE EVENTS').props.onPress() })
  await ReactTestRenderer.act(async () => { railPill(tree, 'MLB').props.onPress() })
  await ReactTestRenderer.act(async () => { channelRow(tree, 'MLB Solo').props.onPress() })
  // Sub ring = only the game; parent ring = still only the game: the ladder ends on
  // the GLOBAL ring — 002 MLB Solo → 003 Beta News.
  await channelKey('up')
  expect(texts(tree)).toContain('Beta News')
  // …and the scope followed to 'All': OK reopens the plain CHANNELS list.
  await ReactTestRenderer.act(async () => { catcher(tree).props.onPress() })
  expect(texts(tree)).toContain('CHANNELS')
})

test('the tuned-from scope survives a trip out to the Menu (module-level memory)', async () => {
  const tree = await live()
  await tuneMlbOneFromDrilledList(tree)
  // Leave for the Menu: the native stack unmounts Live; the module vars remember.
  await ReactTestRenderer.act(async () => { tree.unmount() })
  mounted.splice(mounted.indexOf(tree), 1)
  // Re-enter Live with NO params (the Menu's LIVE TV tile): lastStreamId resumes
  // the channel and lastTuneScope restores the ring it was tuned from.
  const tree2 = await liveWith({})
  expect(texts(tree2)).toContain('MLB One') // resumed, not the hero
  await channelKey('up')
  expect(texts(tree2)).toContain('MLB Two') // still the MLB ring…
  expect(texts(tree2)).not.toContain('Beta News') // …not the global order
})
