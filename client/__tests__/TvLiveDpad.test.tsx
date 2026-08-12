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
const { backend } = require('../src/worklet')

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

test('the catcher band clears BOTH side edges, or a sideways press finds nothing', async () => {
  const tree = await live()
  // The catcher is the wide middle band that holds native focus; the strips live in
  // the gutters it leaves. Inset on one side only was the old bug — RIGHT had no strip
  // to land on because the catcher ran to the screen edge.
  const catcher = tree.root.findAll((n: any) => n.props?.hasTVPreferredFocus && n.props?.style)[0]
  expect(flat(catcher).left).toBeGreaterThan(0)
  expect(flat(catcher).right).toBeGreaterThan(0)
})
