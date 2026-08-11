// Parental gate — the AUTOMATIC tune paths. ParentalControls.test.tsx pins the
// visibility rules (needsPin / visibleStreams); this suite pins the two places
// LiveScreen starts a channel with NO viewer action behind it:
//
//   1. the cold-start hero, on the first 'streams' push after navigating in
//   2. the fallback after a DECLINED PIN challenge (the modal's own onClose)
//
// Both used to call pickHero() over the whole list. On the one configuration where
// restricted channels are LISTED on purpose — PIN set, "hide" OFF, gated rather than
// hidden — that pick can itself be restricted, so the app tuned it with no prompt;
// and cancelling the prompt handed over a DIFFERENT restricted channel. play() had
// the guard all along, but neither of these paths went through it (found 2026-08-11,
// two lines dating to 2026-07-14 and 2026-07-28). Both now pick the hero over
// autoTunable() — the PIN-free subset — which is the shared guard.
//
// The player is the observable: LiveScreen renders <AliranVideo streamId={playingId}>
// only while something plays, so NO video element in the tree IS "nothing is playing".
//
// ⚠ THE MOUNTING TESTS ARE ORDER-DEPENDENT — see the note above them before adding,
// reordering, or removing any of them.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'

// RN's own Modal mock requireActual()s virtualized-lists ESM this preset cannot parse
// (the ParentalControls/ReportSheet pattern). The PIN modal is the subject of half
// this suite, so it has to render and expose its handlers.
jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: ({ visible, children }: { visible?: boolean; children?: unknown }) => (visible ? children : null)
}))

// FlatList pulls in untranspiled ESM too (the GuideScreen suite's lesson) — plain rows.
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

// Stub the native player one level DOWN (the AliranVideoTune pattern) instead of
// mocking @aliran/react-native: a partial mock of the SDK needs requireActual, which
// drags a second copy of react in and nulls the hook dispatcher for the whole tree.
// <AliranVideo> stays real, so it is still the element that carries streamId.
// Only its default export and the SelectedTrackType enum are runtime values.
jest.mock('react-native-video', () => ({
  __esModule: true,
  default: function MockVideo () { return null },
  SelectedTrackType: { DISABLED: 'disabled', INDEX: 'index', LANGUAGE: 'language', TITLE: 'title' }
}))

import { AliranVideo } from '@aliran/react-native'
import { LiveScreen } from '../src/screens/LiveScreen'
import { PinEntryModal } from '../src/components/PinModal'
import { backend, type Stream } from '../src/worklet'
import { autoTunable, markUnlocked, visibleStreams } from '../src/parental'
import { pickHero } from '../src/catalog'

// A restricted channel that WINS the hero pick two different ways: `featured + isLive`
// (pickHero's first branch) and, for `adult`, lowest `order` among what is left.
const lateRestricted = { id: 'late', title: 'Late Night', restricted: true, featured: true, isLive: true, order: 10 } as unknown as Stream
const adultRestricted = { id: 'adult', title: 'Adult', restricted: true, isLive: true, order: 1 } as unknown as Stream
const news = { id: 'news', title: 'News', isLive: true, order: 20 } as unknown as Stream
const kids = { id: 'kids', title: 'Kids', isLive: true, order: 2 } as unknown as Stream

const navigation = { navigate: jest.fn(), isFocused: () => true } as any

const mounted: RendererInstance[] = []
async function mountLive (params: Record<string, unknown> = {}): Promise<RendererInstance> {
  let tree!: RendererInstance
  const el = <LiveScreen route={{ params } as any} navigation={navigation} />
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  for (const t of mounted.splice(0)) await ReactTestRenderer.act(async () => t.unmount())
})

// What the player was handed — null when nothing plays (the element is not rendered).
function playing (tree: RendererInstance): string | null {
  const found = tree.root.findAllByType(AliranVideo)
  return found.length ? (found[0].props.streamId as string) : null
}
function pinModal (tree: RendererInstance) { return tree.root.findAllByType(PinEntryModal)[0] }

// PIN set, "hide" OFF — the one configuration where restricted channels are listed.
function gatedCatalog (streams: Stream[]) {
  backend.parental = { hide: false }
  ;(backend as any).streams = streams
}

// ─── the rule ────────────────────────────────────────────────────────────────────

test('autoTunable skips what pickHero would have tuned: the restricted featured channel', () => {
  gatedCatalog([lateRestricted, news])
  const list = visibleStreams(backend.streams)
  // The trap is real: the unguarded pick IS the restricted channel.
  expect(pickHero(list)?.id).toBe('late')
  expect(pickHero(autoTunable(list))?.id).toBe('news')
})

test('…and when a restricted channel merely sorts first by order', () => {
  gatedCatalog([adultRestricted, kids])
  const list = visibleStreams(backend.streams)
  expect(pickHero(list)?.id).toBe('adult')
  expect(pickHero(autoTunable(list))?.id).toBe('kids')
})

test('every visible channel gated: nothing is auto-tunable', () => {
  gatedCatalog([lateRestricted, adultRestricted])
  const list = visibleStreams(backend.streams)
  expect(pickHero(list)?.id).toBe('late') // pickHero always answers…
  expect(pickHero(autoTunable(list))).toBeUndefined() // …auto-tune declines to
})

test('no PIN on the device: the gate is inert, auto-tune is the plain hero pick', () => {
  backend.parental = null
  const list = visibleStreams([lateRestricted, news])
  expect(list.map((s) => s.id)).toEqual(['news']) // restricted do not exist here
  expect(pickHero(autoTunable(list))?.id).toBe(pickHero(list)?.id)
})

// ─── LiveScreen: the two automatic paths ─────────────────────────────────────────
//
// ORDER MATTERS in this block, and the tests are written to fail loudly rather than
// silently if it changes. LiveScreen keeps `lastStreamId` at module scope so that
// re-entering Live RESUMES the channel instead of re-picking a hero, and nothing
// ever clears it. So:
//   · the two COLD-START tests must run before anything leaves a channel playing —
//     they assert the hero path, which a stale lastStreamId would skip entirely;
//   · the first of them must be the all-gated one, which ends with nothing playing
//     and therefore leaves lastStreamId untouched for the second;
//   · the two DECLINE tests are immune in any position — they pass route.params
//     .streamId, which takes precedence over lastStreamId in the same expression.

test('cold start with every channel gated: nothing plays, and nothing is prompted for', async () => {
  gatedCatalog([lateRestricted, adultRestricted])
  const tree = await mountLive()
  expect(playing(tree)).toBeNull()
  // An automatic pick has no viewer action behind it, so it must not raise the
  // challenge either — the viewer picks a channel and play() gates that.
  expect(pinModal(tree).props.visible).toBe(false)
})

test('cold start does not tune a restricted hero — it starts the best UNGATED channel', async () => {
  gatedCatalog([lateRestricted, news])
  const tree = await mountLive()
  expect(playing(tree)).toBe('news') // 'late' here is the pre-fix bug
  expect(pinModal(tree).props.visible).toBe(false)
})

test('declining the PIN does not hand over a DIFFERENT restricted channel', async () => {
  gatedCatalog([lateRestricted, news, adultRestricted])
  // Enter Live aimed at a restricted channel (the Favorites/Search jump): the mount
  // raises the challenge for it instead of autoplaying it.
  const tree = await mountLive({ streamId: 'adult' })
  expect(pinModal(tree).props.visible).toBe(true)

  // Both mount effects run in ONE commit, so the hero effect still reads the render's
  // pinTarget (null) and starts a channel BEHIND the prompt. That is the sharpest form
  // of this bug: pre-fix the channel behind the modal was 'late' — pickHero's answer
  // for this catalog, and restricted. It must be the ungated pick.
  expect(playing(tree)).toBe('news')

  // Cancelling leaves that ungated channel playing; it never swaps in a gated one.
  await ReactTestRenderer.act(async () => { pinModal(tree).props.onClose() })
  expect(playing(tree)).toBe('news')
})

test('declining with nothing ungated to fall back to leaves the player empty', async () => {
  gatedCatalog([lateRestricted, adultRestricted])
  const tree = await mountLive({ streamId: 'adult' })
  expect(pinModal(tree).props.visible).toBe(true)
  await ReactTestRenderer.act(async () => { pinModal(tree).props.onClose() })
  expect(playing(tree)).toBeNull()
})

// ─── after the unlock ────────────────────────────────────────────────────────────
// LAST on purpose: markUnlocked() sets a module-level session flag with no reset, so
// every test above it would stop seeing a gate.

test('once the session is unlocked the restricted hero is fair game again', () => {
  gatedCatalog([lateRestricted, news])
  const list = visibleStreams(backend.streams)
  markUnlocked() // what a correct PIN does
  expect(pickHero(autoTunable(list))?.id).toBe('late')
  expect(pickHero(autoTunable(list))?.id).toBe(pickHero(list)?.id)
})
