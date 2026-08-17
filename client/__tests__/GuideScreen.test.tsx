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

// WS-event additions: a guide-less row no longer spends its whole strip on "No program
// information" — it carries the station's full name and the channel list's LIVE badge
// over that note, and dims off air. On phone that cell is the ONLY place either can be
// read: this grid's 72dp channel column is a number and a logo, with no name at all.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, Image, StyleSheet } from 'react-native'
// The badge string comes from the catalog, not an English literal — `common.live` is
// "LIVE" in en but "EN VIVO"/"IN DIRETTA" elsewhere, and these lanes are about the
// badge, not the wording. Aliased: several tests below bind a local `t` to a text dump.
import { t as tr } from '@aliran/i18n'

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

/** Every Text node printing EXACTLY this string (a count, not a substring hit). */
function printing (tree: RendererInstance, exact: string) {
  return tree.root.findAllByType(Text)
    .filter((n: any) => [n.props.children].flat(9).map(String).join('') === exact)
}
const flat = (n: any) => (StyleSheet.flatten(n.props.style) || {}) as Record<string, any>

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
  // param effect (re-tuning the channel Live is already on). category: the panel's
  // active chip at tap time (Phase 4) — Live scopes its zap ring and its
  // OK-reopens-the-list context to the category the viewer tuned from.
  expect(navigate).toHaveBeenCalledWith('Live', { streamId: 'shop-tv', tuneKey: expect.any(Number), category: 'All' })
})

test('a guide opened WITH a category opens on that chip and tunes back with it (Phase 4 round trip)', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [{ ...guided, category: ['News'] }, { ...guideless, category: ['Shopping'] }]
  const navigate = jest.fn()
  const navigation: any = { navigate }
  // Live's two-tier OK carries its tune scope in as `category` — the guide must
  // open scoped to it, so picking a row there records the SAME context back
  // instead of 'All' (which undid the viewer's context in two presses).
  const route: any = { params: { streamId: 'moon-cat', category: 'News' } }
  const tree = await createTree(<GuideScreen navigation={navigation} route={route} />)
  // Scoped open: only the News channel's row is in the grid.
  const rows = tree.root.findAll((n) => typeof n.props.onPress === 'function' && typeof n.props.accessibilityLabel === 'string')
  expect(rows.some((n) => n.props.accessibilityLabel.includes('Moon Cat'))).toBe(true)
  expect(rows.some((n) => n.props.accessibilityLabel.includes('Shop TV'))).toBe(false)
  const row = rows.find((n) => n.props.accessibilityLabel.includes('Moon Cat'))!
  await ReactTestRenderer.act(async () => { row.props.onPress() })
  expect(navigate).toHaveBeenCalledWith('Live', { streamId: 'moon-cat', tuneKey: expect.any(Number), category: 'News' })
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
  // SCOPED TO THE CARD, not "the string is somewhere in the tree": a guide-less row now
  // prints its own name in its empty cell, so a bare substring hit would pass even if
  // the card never rendered. The card's line is the only one pairing NUMBER with name.
  expect(printing(tree, 'Shop TV')).toHaveLength(1) // the row's empty-cell name
  expect(tree.root.findAllByType(Text).some((x: any) =>
    /^\d{3}\s+Shop TV$/.test([x.props.children].flat(9).map(String).join('')))).toBe(true)
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

// ─── What a GUIDE-LESS row says (the television grid's treatment, on phone) ───────
//
// It used to say one thing: "No program information" across a two-hour strip of
// nothing, beside a channel column of a number and a logo. On this operator's lineup
// that is not an edge case — it is the LIVE EVENTS rails, whose channels rotate
// through one fixture after another and carry no EPG at all, so the row's entire
// information is its title and whether it is on air, and the phone grid was printing
// NEITHER. The empty cell now carries what IS known, over the honest no-schedule note,
// which stays (D2 — never fake a program) as a footnote.

const OFF_LOGO = 'http://127.0.0.1:1234/assets/mlb-2/logo.png'
const ON_LOGO = 'http://127.0.0.1:1234/assets/mlb-1/logo.png'
// The rotating events: no epgUrl/epgId/guideBase at all, so nothing is ever fetched for
// them and the strip is empty by construction — the rows this treatment is for.
const event: Stream = { id: 'mlb-1', title: 'Yankees vs Red Sox', isLive: true, logo: ON_LOGO }
const eventOff: Stream = { id: 'mlb-2', title: 'Dodgers vs Giants', isLive: false, logo: OFF_LOGO }

// preview defaults to 'none', so nothing selects and NO preview card mounts — every
// count below is the grid's own rows and nothing else.
async function eventGrid (): Promise<RendererInstance> {
  const now = Date.now()
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([{ title: 'On Air Now', start: now - 6e5, stop: now + 6e5 }])
  ;(backend as any).streams = [guided, event, eventOff]
  return createTree(<GuidePanel playingId="moon-cat" onTune={jest.fn()} />)
}

const imageWithUri = (tree: RendererInstance, uri: string) =>
  tree.root.findAllByType(Image).find((i: any) => i.props.source.uri === uri)!

test('a guide-less row spends its empty strip on the station\'s FULL name', async () => {
  const tree = await eventGrid()
  // ONCE — and that count is the point. The phone's channel column is a number and a
  // logo with no name box at all, so the empty cell is the only place the name prints;
  // this also pins that we did NOT go widen that 72dp column to add one. (The TV grid
  // asserts twice here, because its column does carry a name.)
  expect(printing(tree, 'Yankees vs Red Sox')).toHaveLength(1)
  // A row WITH a schedule shows its programs, not its name — the name belongs in the
  // empty cell only, never pasted over everyone's cells.
  expect(printing(tree, 'Moon Cat')).toHaveLength(0)
  expect(printing(tree, 'On Air Now')).toHaveLength(1)
})

/** The exact strings printed in the same cell line as `name` — i.e. its siblings. */
function lineWith (tree: RendererInstance, name: string): string[] {
  const node = printing(tree, name)[0]
  if (!node) return []
  return node.parent!.findAllByType(Text)
    .map((n: any) => [n.props.children].flat(9).map(String).join(''))
}

test('…and on whether it is on air, in the channel list\'s badge', async () => {
  const tree = await eventGrid()
  // Exactly one badge in the grid…
  expect(printing(tree, tr('common.live'))).toHaveLength(1)
  // …AND it is on the live event's own line. The count alone would pass just as well
  // with the guard inverted — the badge would simply move to the off-air row.
  expect(lineWith(tree, 'Yankees vs Red Sox')).toContain(tr('common.live'))
  expect(lineWith(tree, 'Dodgers vs Giants')).not.toContain(tr('common.live'))
})

test('an off-air channel dims, guide or no guide — the channel list\'s grammar', async () => {
  const tree = await eventGrid()
  const off = printing(tree, 'Dodgers vs Giants')
  const on = printing(tree, 'Yankees vs Red Sox')
  // Both guarded: an unguarded for-of over an empty array is a test that passes
  // because the thing it checks stopped rendering.
  expect(off).toHaveLength(1)
  expect(on).toHaveLength(1)
  for (const node of off) expect(flat(node).opacity).toBe(0.5)
  for (const node of on) expect(flat(node).opacity).toBeUndefined()
  // The column's logo carries it too — with no name there, the logo IS the identity.
  expect(flat(imageWithUri(tree, OFF_LOGO)).opacity).toBe(0.5)
  expect(flat(imageWithUri(tree, ON_LOGO)).opacity).toBeUndefined()
})

// THE TWO STYLE PROPERTIES THE CELL ACTUALLY DEPENDS ON, because nothing else in this
// suite would notice their loss — react-test-renderer runs no layout, so every other
// lane here would stay green with the cell rendering at the wrong size or clipping the
// wrong half of its content.
test('the note is SMALLER than the name above it, and carries its own explicit size', async () => {
  const tree = await eventGrid()
  const note = printing(tree, tr('live.noProgramInfo'))[0]
  const name = printing(tree, 'Yankees vs Red Sox')[0]
  // The trap this pins: `cellEmpty` had no fontSize of its own while it was composed
  // onto the same <Text> as `cellTitle`. On its own line without one, RN falls back to
  // 14dp and the footnote prints LARGER than the station name.
  expect(typeof flat(note).fontSize).toBe('number')
  expect(flat(note).fontSize).toBeLessThan(flat(name).fontSize)
})

test('the NAME is what gives way on a narrow strip, never the badge', async () => {
  const tree = await eventGrid()
  // ChannelRow's rule (its titleLine): the name shrinks, the badge keeps its intrinsic
  // width. `common.live` is 4 characters in en and 10 in it ("IN DIRETTA"), so on the
  // 192dp strip floor a badge without this would be the thing that got ellipsized.
  expect(flat(printing(tree, 'Yankees vs Red Sox')[0]).flexShrink).toBe(1)
  expect(flat(printing(tree, tr('common.live'))[0]).flexShrink).toBeUndefined()
})

test('a record with NO isLive at all is unknown, not off air — it must not dim', async () => {
  // The strict `=== false` guard. Plenty of catalog records carry no isLive; dimming
  // them would mark half a lineup dead on the strength of a missing field.
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  ;(backend as any).streams = [{ id: 'unknown-1', title: 'Silent Channel' }]
  const tree = await createTree(<GuidePanel playingId={null} onTune={jest.fn()} />)
  const name = printing(tree, 'Silent Channel')
  expect(name).toHaveLength(1)
  expect(flat(name[0]).opacity).toBeUndefined()
  // And no badge either — absent is not "live" (the same `stream.isLive &&` guard).
  expect(printing(tree, tr('common.live'))).toHaveLength(0)
})

test('the honest "no schedule" answer is still there — a name is not a program', async () => {
  const tree = await eventGrid()
  // D2: the grid never invents a program. Two guide-less rows, two notes.
  expect(printing(tree, tr('live.noProgramInfo'))).toHaveLength(2)
})

test('a row whose first fetch is still in flight says NOTHING about its schedule (WS17)', async () => {
  // The treatment lives strictly in the `visible.length === 0` arm, never the skeleton
  // one: claiming "no schedule" — in ANY form, including a bare name-and-badge card —
  // while the first EPG fetch runs is the exact bug useEpgProgramsState exists to stop.
  let resolve!: (p: any[]) => void
  jest.spyOn(epg, 'getPrograms').mockReturnValue(new Promise((r) => { resolve = r }))
  ;(backend as any).streams = [guided, event]
  const tree = await createTree(<GuidePanel playingId={null} onTune={jest.fn()} />)
  expect(printing(tree, 'Moon Cat')).toHaveLength(0) // skeleton cells, not the treatment
  expect(printing(tree, tr('live.noProgramInfo'))).toHaveLength(1) // the event row alone
  expect(printing(tree, tr('common.live'))).toHaveLength(1) //  …and its badge alone
  await ReactTestRenderer.act(async () => { resolve([]) })
  // Resolved empty → NOW the guided row is genuinely guide-less and takes the treatment.
  expect(printing(tree, 'Moon Cat')).toHaveLength(1)
  expect(printing(tree, tr('common.live'))).toHaveLength(2)
})
