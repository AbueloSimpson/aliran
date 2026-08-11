// "Play on a TV" — WHAT A TELEVISION TELLS THE CONTROLLERS ABOUT ITSELF.
//
// The engine publishes the channel and "playing" on its own: it learns both from resolve().
// Two things it cannot see, and they are the two this screen owes it — a PAUSE, and the
// PLAYHEAD. Both belong to a VOD title; a live channel has neither here.
//
// THE CASE THAT IS EASY TO MISS is the retraction. Once a set has said 'paused', that word
// stands until something replaces it, so leaving a paused title has to say 'playing' — and
// leaving playback altogether has to say 'stopped'. A phone showing "paused" for a
// television that is playing something else is not a cosmetic bug: it is the one screen a
// viewer in another room has for what that set is doing.
//
// A position on its own never sends a message — the engine stores it and lets it ride the
// next push a real change causes (sdk/player.js updateRemoteStatus). So this suite asserts
// the position that RIDES a pause, and does not count the ticks between.
//
// TELEVISION-ONLY, because phones never announce themselves on the rendezvous and so have
// nobody to tell. Platform.isTV is faked with ordered require()s rather than
// jest.isolateModules: an isolated registry hands screen tests a SECOND React, and hooks
// then throw.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'

// RN's own Modal mock requireActual()s virtualized-lists ESM this preset cannot parse
// (the ParentalHeroFallback/ReportSheet pattern).
jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: ({ visible, children }: { visible?: boolean; children?: unknown }) => (visible ? children : null)
}))

// FlatList pulls in untranspiled ESM too — plain rows (the GuideScreen suite's lesson).
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = require('react')
  const MockView = require('react-native/Libraries/Components/View/View').default
  const MockFlatList = ReactActual.forwardRef((props: any, _ref: any) => {
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

// Stub the native player one level DOWN rather than mocking @aliran/react-native: a
// partial mock of the SDK needs requireActual, which drags a second copy of react in and
// nulls the hook dispatcher for the whole tree (the AliranVideoTune pattern).
jest.mock('react-native-video', () => ({
  __esModule: true,
  default: function MockVideo () { return null },
  SelectedTrackType: { DISABLED: 'disabled', INDEX: 'index', LANGUAGE: 'language', TITLE: 'title' }
}))

// theme.ts reads Platform.isTV ONCE, at module load, so the fake has to be in place before
// anything that reaches it is required. ES imports are hoisted; these are not.
const { Platform } = require('react-native')
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
const { LiveScreen } = require('../src/screens/LiveScreen')
const { backend } = require('../src/worklet')
type Stream = import('../src/worklet').Stream

const NEWS = { id: 'news', title: 'News', isLive: true, order: 1 } as unknown as Stream
const SPORT = { id: 'sport', title: 'Sport', isLive: true, order: 2 } as unknown as Stream
const FILM = { id: 'film', title: 'A Film', type: 'vod', order: 3 } as unknown as Stream

const navigation = { navigate: jest.fn(), isFocused: () => true } as any

function sent (): any[] { return (backend as any).pending }
/** Every host-owned status this set has published, oldest first. */
function statuses (): any[] { return sent().filter((m) => m?.type === 'remote-status') }
/**
 * The last status that SAYS something — one carrying a `state`.
 *
 * Not simply the last message: a position on its own is stored by the engine and rides the
 * next real change, so the playhead ticking makes position-only messages the most recent
 * thing on the wire almost always. Reading those as "what this set last said" would assert
 * the opposite of the contract.
 */
function lastState (): any { return [...statuses()].reverse().find((m) => 'state' in m) }

const screen = (params: Record<string, unknown>) =>
  <LiveScreen route={{ params } as any} navigation={navigation} />

const mounted: RendererInstance[] = []
async function mountLive (params: Record<string, unknown> = {}): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(screen(params)) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}

/** Zap while the screen stays mounted, the way the Guide does it: fresh params plus a
 *  tuneKey stamp, which is what re-fires LiveScreen's param effect into play(). */
let stamp = 0
async function tune (tree: RendererInstance, streamId: string) {
  await ReactTestRenderer.act(async () => { tree.update(screen({ streamId, tuneKey: ++stamp })) })
  await ReactTestRenderer.act(async () => {})
}
afterEach(async () => {
  for (const t of mounted.splice(0)) await ReactTestRenderer.act(async () => t.unmount())
})

beforeEach(() => {
  sent().length = 0
  backend.parental = null
  ;(backend as any).streams = [NEWS, SPORT, FILM]
})

test('a set with nothing tuned yet claims nothing — "stopped" is the ENGINE\'s to say', async () => {
  ;(backend as any).streams = []
  await mountLive()
  expect(statuses()).toEqual([])
})

test('a live channel reports plain playing, with no playhead attached to it', async () => {
  await mountLive({ streamId: 'news' })
  expect(lastState()).toEqual({ type: 'remote-status', state: 'playing' })
})

test('leaving playback says so — the one thing the engine cannot see', async () => {
  const tree = await mountLive({ streamId: 'news' })
  sent().length = 0
  await ReactTestRenderer.act(async () => tree.unmount())
  mounted.length = 0
  expect(lastState()).toEqual({ type: 'remote-status', state: 'stopped' })
})

test('a title carries the playhead on the message that says something', async () => {
  await mountLive({ streamId: 'film' })
  expect(lastState()).toMatchObject({ state: 'playing', position: 0 })
})

// THE RETRACTION. 'paused' stands until something replaces it, and the thing that replaces
// it here is a channel this screen tuned itself — no controller asked, so nothing else in
// the system has a reason to push.
test('zapping off a paused title retracts the pause', async () => {
  const tree = await mountLive({ streamId: 'film' })
  // The host owns the pause; the bar's transport is what flips it.
  const bar = tree.root.findAll((n: any) => typeof n.props?.onTogglePause === 'function')[0]
  await ReactTestRenderer.act(async () => { bar.props.onTogglePause() })
  expect(lastState()).toMatchObject({ state: 'paused' })

  await tune(tree, 'news')
  expect(lastState()).toMatchObject({ state: 'playing' })
})

// …and a live channel never carries one, so a phone cannot draw a scrubber over something
// that has no playhead to scrub.
test('the retracting push carries no playhead', async () => {
  const tree = await mountLive({ streamId: 'film' })
  const bar = tree.root.findAll((n: any) => typeof n.props?.onTogglePause === 'function')[0]
  await ReactTestRenderer.act(async () => { bar.props.onTogglePause() })
  await tune(tree, 'news')
  expect(lastState()).not.toHaveProperty('position')
})
