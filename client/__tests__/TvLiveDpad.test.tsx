// The Live screen's D-pad grammar on a television — the sideways half of it.
//
// Every direction here is answered by an INVISIBLE focus strip, because react-native-tvos
// on Android does not dispatch HW key events to a view that holds focus (the S7 lesson):
// a press moves native focus onto a strip, and the strip's onFocus IS the key handler.
// Up/down (zap) had strips from the start. LEFT got one, and RIGHT — channel detail for
// what is playing — is the last direction on the pad that answered to nothing at all.
//
// What this pins:
//   * RIGHT opens channel detail for the channel being watched;
//   * BACK out of detail reached THAT way returns to the picture, not to a channel list
//     the viewer never opened (detail is normally reached FROM the list and goes back to
//     it, which is why the two entries have to be told apart);
//   * the catcher band leaves room on BOTH edges — it is the geometry the whole rig
//     depends on, and a catcher spanning to an edge leaves the focus engine nothing to
//     find on a press that way.
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
const { Platform, BackHandler } = require('react-native')
const realIsTV = Object.getOwnPropertyDescriptor(Platform, 'isTV')!
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
const { LiveScreen } = require('../src/screens/LiveScreen')
const { ChannelInfoPanel } = require('../src/components/ChannelInfoPanel')
const { backend } = require('../src/worklet')
const { t } = require('@aliran/i18n')
const { theme } = require('../src/theme')

afterAll(() => { Object.defineProperty(Platform, 'isTV', realIsTV) })

const playing: Stream = { id: 'moon-cat', title: 'Moon Cat', isLive: true, description: 'via demotv' }
const other: Stream = { id: 'shop-tv', title: 'Shop TV', isLive: true, description: 'via demotv' }

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

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map((n: any) => [n.props.children].flat(9).map(String).join('')).join(' | ')
}

const flat = (n: any) => (StyleSheet.flatten(n.props.style) || {}) as Record<string, any>

// The screen's hardware-BACK handlers, captured as it registers them. The spy has to be
// in place BEFORE the mount that registers one (SendToTvSignIn's pattern).
let backHandlers: Array<() => boolean> = []

async function live (): Promise<RendererInstance> {
  backHandlers = []
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_e: string, h: () => boolean) => {
    backHandlers.push(h)
    return { remove () {} }
  }) as any)
  ;(backend as any).streams = [playing, other]
  const navigation: any = { isFocused: () => true, navigate: jest.fn() }
  const route: any = { params: { streamId: 'moon-cat' } }
  return createTree(<LiveScreen navigation={navigation} route={route} />)
}

/** The focus strip pinned to one edge of the screen — the rig's stand-in for a key. */
function edgeStrip (tree: RendererInstance, edge: 'left' | 'right') {
  const strips = tree.root.findAll((n: any) =>
    typeof n.props?.onFocus === 'function' && n.props?.style && flat(n).position === 'absolute' && flat(n)[edge] === 0 && flat(n).width === 80)
  if (!strips.length) throw new Error(`no ${edge} focus strip — that direction answers to nothing`)
  return strips[0]
}

/** Fire the registered hardware BACK, and report whether the screen consumed it. */
function pressBack (): boolean {
  if (!backHandlers.length) throw new Error('no BACK handler registered')
  return backHandlers[backHandlers.length - 1]()
}

test('RIGHT opens channel detail for what is playing', async () => {
  const tree = await live()
  // "Watching" is the detail panel's own word for the channel already on — the bar
  // below never says it, so it tells the two surfaces apart.
  expect(texts(tree)).not.toContain('Watching')
  await ReactTestRenderer.act(async () => { edgeStrip(tree, 'right').props.onFocus() })
  expect(texts(tree)).toContain('Moon Cat')
  expect(texts(tree)).toContain('Watching')
})

test('BACK out of detail opened by RIGHT returns to the picture, not to a channel list', async () => {
  const tree = await live()
  await ReactTestRenderer.act(async () => { edgeStrip(tree, 'right').props.onFocus() })
  let consumed = false
  await ReactTestRenderer.act(async () => { consumed = pressBack() })
  expect(consumed).toBe(true)
  // The channel list heading is what would show had this fallen back to 'list'. The
  // viewer came from fullscreen and never opened a list, so they must not land in one.
  expect(texts(tree)).not.toContain('CHANNELS')
})

test('BACK out of detail opened FROM the list still returns to the list', async () => {
  const tree = await live()
  // LEFT raises the channel list, the way detail is normally reached.
  await ReactTestRenderer.act(async () => { edgeStrip(tree, 'left').props.onFocus() })
  expect(texts(tree)).toContain('CHANNELS')
  // Long-press a row for its detail (the list's own route into it). A channel row
  // carries no accessibility label — it prints the title as a child — so it is found by
  // the text inside it.
  const row = tree.root.findAll((n: any) => typeof n.props?.onLongPress === 'function')
    .find((n: any) => n.findAllByType(Text)
      .map((x: any) => [x.props.children].flat(9).map(String).join('')).join(' ').includes('Shop TV'))
  if (!row) throw new Error('no Shop TV row in the channel list')
  await ReactTestRenderer.act(async () => { row.props.onLongPress() })
  expect(texts(tree)).toContain('Shop TV')
  await ReactTestRenderer.act(async () => { pressBack() })
  expect(texts(tree)).toContain('CHANNELS') // back where it came from
})

// --- arriving from the Guide lands on the PICTURE ---
// The Guide tunes by navigating here with the channel's id. Picking the channel that is
// already playing left this screen showing whatever overlay it had been left on — in
// practice the channel list, which the viewer never opened. The tune has nothing to do;
// the INTENT was "watch this", and that is what has to be honoured.

async function liveWithParams (params: any): Promise<{ tree: RendererInstance; rerender: (p: any) => Promise<void> }> {
  backHandlers = []
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_e: string, h: () => boolean) => {
    backHandlers.push(h)
    return { remove () {} }
  }) as any)
  ;(backend as any).streams = [playing, other]
  const navigation: any = { isFocused: () => true, navigate: jest.fn() }
  const el = (p: any) => <LiveScreen navigation={navigation} route={{ params: p } as any} />
  const tree = await createTree(el(params))
  return {
    tree,
    rerender: async (p: any) => { await ReactTestRenderer.act(async () => { tree.update(el(p)) }) }
  }
}

test('a Guide pick of the channel ALREADY playing still collapses to the picture', async () => {
  const { tree, rerender } = await liveWithParams({ streamId: 'moon-cat' })
  // Put the screen on the channel list, which is where it used to strand the viewer.
  await ReactTestRenderer.act(async () => { edgeStrip(tree, 'left').props.onFocus() })
  expect(texts(tree)).toContain('CHANNELS')
  // The Guide navigates back naming the SAME channel. tuneKey is the fresh stamp that
  // makes a value-equal streamId register as a new intent at all.
  await rerender({ streamId: 'moon-cat', tuneKey: 12345 })
  expect(texts(tree)).not.toContain('CHANNELS')
  expect(texts(tree)).toContain('Moon Cat') // the bar over the picture
})

// --- the controls the television's bottom bar cannot carry ---
// Subtitles/audio are buttons on the phone's NowPlayingBar, and that row cannot exist on
// a television: a focusable over the video captures the D-pad and the zap strips never
// see the press. So the set had no route to subtitles at all. They live in the panel
// RIGHT opens, which is already outside the zap path.

const infoProps = {
  stream: playing,
  number: 1,
  favorite: false,
  playing: true,
  onWatch: () => {},
  onToggleFavorite: () => {}
}

test('the channel panel carries subtitles and search on a television', async () => {
  const shown = texts(await createTree(
    <ChannelInfoPanel {...infoProps} hasTracks onSubtitles={jest.fn()} onSearch={jest.fn()} />
  ))
  expect(shown).toContain(t('live.bar.subtitles'))
  expect(shown).toContain(t('menu.search'))
})

test('every action label is readable on the bed it actually sits on', async () => {
  // THE BUG THIS PINS: all labels used `onPrimary` — the colour for text sitting ON a
  // primary fill (SolTV: #201204). Only ONE button has that fill; the rest are on
  // `surface`, so they were near-black on near-black. They worked when pressed and
  // looked disabled, and the operator reported them as disabled.
  const tree = await createTree(
    <ChannelInfoPanel {...infoProps} hasTracks onSubtitles={jest.fn()} onSearch={jest.fn()} onReport={jest.fn()} />
  )
  const buttons = tree.root.findAll((n: any) => n.props?.accessibilityRole === 'button' || typeof n.props?.onPress === 'function')
    .filter((n: any) => n.findAllByType(Text).length > 0 && flat(n).borderRadius === 8)
  expect(buttons.length).toBeGreaterThan(1)
  for (const b of buttons) {
    const bed = flat(b).backgroundColor
    const label = b.findAllByType(Text)[0]
    const ink = flat(label).color
    // onPrimary is reserved for the button that HAS the primary bed. Anywhere else it
    // is the same colour family as the surface behind it.
    if (bed !== theme.colors.primary) expect(ink).not.toBe(theme.colors.onPrimary)
    else expect(ink).toBe(theme.colors.onPrimary)
  }
})

test('no subtitle button when the stream has no tracks to choose between', async () => {
  // An empty picker is worse than no button.
  const shown = texts(await createTree(
    <ChannelInfoPanel {...infoProps} hasTracks={false} onSubtitles={jest.fn()} />
  ))
  expect(shown).not.toContain(t('live.bar.subtitles'))
})

// --- the rail-walk debounce (RAIL_SCOPE_DEBOUNCE_MS) ---
// Walking the D-pad down the rail scopes the channel list on every focus stop, and on
// the 32-bit boxes each stop was a full list rebuild landing under the next queued key
// press. So the split: the rail highlight answers the focus INSTANTLY (it is one pill
// style), and the list re-scopes only after a ~200 ms trailing debounce — a walk
// swallows the intermediate stops, a viewer settling on a category never notices.

test('rail focus moves the highlight at once; the list re-scopes only after the debounce', async () => {
  jest.useFakeTimers()
  try {
    backHandlers = []
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_e: string, h: () => boolean) => {
      backHandlers.push(h)
      return { remove () {} }
    }) as any)
    ;(backend as any).streams = [
      { id: 'moon-cat', title: 'Moon Cat', isLive: true, category: ['News'] },
      { id: 'shop-tv', title: 'Shop TV', isLive: true, category: ['Shopping'] }
    ]
    const navigation: any = { isFocused: () => true, navigate: jest.fn() }
    const tree = await createTree(<LiveScreen navigation={navigation} route={{ params: { streamId: 'moon-cat' } } as any} />)
    await ReactTestRenderer.act(async () => { edgeStrip(tree, 'left').props.onFocus() })
    // The channel rows are the only long-pressables on this surface — the tuning pill
    // and the rail carry none — so they count the LIST's scope directly (the text dump
    // can't: the pill prints the playing channel's title too).
    const listTitles = () => tree.root.findAll((n: any) => typeof n.props?.onLongPress === 'function')
      .map((n: any) => n.findAllByType(Text).map((x: any) => [x.props.children].flat(9).join('')).join(' '))
    // The panel opens IN CONTEXT (Phase 4, openListInContext): the playing channel's
    // own category — NEWS — not the stale-'All' open this used to make.
    expect(listTitles().join(' ')).toContain('Moon Cat')
    expect(listTitles()).toHaveLength(1)

    // Focus (not OK) the SHOPPING rail item — on TV, focus selects.
    const railItem = tree.root.findAll((n: any) => typeof n.props?.onFocus === 'function' && typeof n.props?.onPress === 'function')
      .find((n: any) => n.findAllByType(Text).some((x: any) => [x.props.children].flat(9).join('') === 'SHOPPING'))
    if (!railItem) throw new Error('no SHOPPING rail item')
    // The FIRST rail focus after an in-context open is the rail's autoFocus
    // artifact and is swallowed one-shot (LiveScreen railAutoFocusSwallow) —
    // consume it, so the focus below measures the debounce, not the swallow.
    await ReactTestRenderer.act(async () => { railItem.props.onFocus() })
    await ReactTestRenderer.act(async () => { railItem.props.onFocus() })

    // Immediately: the highlight is on SHOPPING (the filled accent pill)…
    expect(flat(railItem).backgroundColor).toBe(theme.colors.accent)
    // …but the LIST is still the walk's starting scope — the NEWS channel.
    expect(listTitles()).toHaveLength(1)
    expect(listTitles()[0]).toContain('Moon Cat')

    // The debounce elapses: now the list is scoped to the category under focus.
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(300) })
    expect(listTitles()).toHaveLength(1)
    expect(listTitles()[0]).toContain('Shop TV')
  } finally {
    jest.useRealTimers()
  }
})

test('OK on a rail category scopes the list at once — no debounce on a deliberate pick', async () => {
  jest.useFakeTimers()
  try {
    backHandlers = []
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_e: string, h: () => boolean) => {
      backHandlers.push(h)
      return { remove () {} }
    }) as any)
    ;(backend as any).streams = [
      { id: 'moon-cat', title: 'Moon Cat', isLive: true, category: ['News'] },
      { id: 'shop-tv', title: 'Shop TV', isLive: true, category: ['Shopping'] }
    ]
    const navigation: any = { isFocused: () => true, navigate: jest.fn() }
    const tree = await createTree(<LiveScreen navigation={navigation} route={{ params: { streamId: 'moon-cat' } } as any} />)
    await ReactTestRenderer.act(async () => { edgeStrip(tree, 'left').props.onFocus() })
    const listTitles = () => tree.root.findAll((n: any) => typeof n.props?.onLongPress === 'function')
      .map((n: any) => n.findAllByType(Text).map((x: any) => [x.props.children].flat(9).join('')).join(' '))
    // The panel opened scoped to the playing channel's NEWS (Phase 4) — so the
    // deliberate pick goes the other way: OK on SHOPPING must re-scope at once.
    const railItem = tree.root.findAll((n: any) => typeof n.props?.onFocus === 'function' && typeof n.props?.onPress === 'function')
      .find((n: any) => n.findAllByType(Text).some((x: any) => [x.props.children].flat(9).join('') === 'SHOPPING'))
    if (!railItem) throw new Error('no SHOPPING rail item')
    await ReactTestRenderer.act(async () => { railItem.props.onPress() }) // OK = activateRail
    expect(listTitles()).toHaveLength(1) // scoped without advancing any timer
    expect(listTitles()[0]).toContain('Shop TV')
  } finally {
    jest.useRealTimers()
  }
})

test('the catcher band clears BOTH side edges, or a sideways press finds nothing', async () => {
  const tree = await live()
  // The catcher is the wide middle band that holds native focus; the strips live in
  // the gutters it leaves. Inset on one side only was the old bug — RIGHT had no strip
  // to land on because the catcher ran to the screen edge.
  const catcher = tree.root.findAll((n: any) => n.props?.hasTVPreferredFocus && n.props?.style)[0]
  expect(flat(catcher).left).toBeGreaterThan(0)
  expect(flat(catcher).right).toBeGreaterThan(0)
})
