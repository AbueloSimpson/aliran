// The category rail's TV grammar: FOCUS ONLY HIGHLIGHTS, OK ENTERS.
//
// Two regressions ago these were ONE action: moving the D-pad focus drilled into any
// category that had sub-categories, so walking down the rail entered the first parent
// it passed (measured on a TCL set going down from All). The first fix split focus
// into a scope-only select — but that still re-scoped the channel list on every focus
// stop, so a simple scroll kept redrawing the list (the operator's complaint). The
// standing contract: a focus stop fires NOTHING at the host — no select, no activate.
// The light focus pill (component-local state) is the only thing that moves; the
// list, the selection, and the drill all wait for OK.
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, ScrollView, StyleSheet } from 'react-native'

const { Platform } = require('react-native')
const realIsTV = Object.getOwnPropertyDescriptor(Platform, 'isTV')!
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
// AFTER the isTV fake, like TvLiveDpad: theme snapshots Platform.isTV at module load,
// and an ESM import would hoist above the override and bake phone metrics into the
// "TV" suite. requires below this line see the TV theme.
const { theme } = require('../src/theme')
const { CategoryRail } = require('../src/components/CategoryRail')

afterAll(() => { Object.defineProperty(Platform, 'isTV', realIsTV) })

// Labels arrive PRE-CASED: the host (LiveScreen's railItems memo, keyed on the
// locale) applies the S56f viewer-locale uppercasing and the rail renders them
// verbatim — RailItem is memoized with no locale subscription, so casing in the
// component froze the old locale's casing after a language switch.
const ITEMS = [
  { key: 'All', label: 'ALL' },
  { key: 'Movies', label: 'MOVIES', hasChildren: true },
  { key: 'News', label: 'NEWS' }
]

const mounted: RendererInstance[] = []
async function createTree (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
})

/** The rail row printing `label` — matched by its own text, not by index. */
function row (tree: RendererInstance, label: string) {
  const found = tree.root.findAll((n: any) => typeof n.props?.onFocus === 'function' && typeof n.props?.onPress === 'function')
    .find((n: any) => n.findAllByType(Text)
      .map((x: any) => [x.props.children].flat(9).map(String).join('')).join(' ').includes(label.toUpperCase()))
  if (!found) throw new Error(`no "${label}" row in the rail`)
  return found
}

async function rail (over: Partial<Record<string, any>> = {}) {
  const onActivate = jest.fn()
  const tree = await createTree(
    <CategoryRail items={ITEMS} selected="All" onActivate={onActivate} {...over} />
  )
  return { tree, onActivate }
}

test('moving the focus onto a parent fires NOTHING at the host', async () => {
  const { tree, onActivate } = await rail()
  await ReactTestRenderer.act(async () => { row(tree, 'Movies').props.onFocus() })
  // onActivate is the rail's one state-changing callback, and a focus stop must not
  // fire it: entering would make the rail below Movies unreachable, and even a mere
  // re-scope would redraw the channel list under a simple scroll.
  expect(onActivate).not.toHaveBeenCalled()
})

test('OK on a parent is what enters it', async () => {
  const { tree, onActivate } = await rail()
  await ReactTestRenderer.act(async () => { row(tree, 'Movies').props.onPress() })
  expect(onActivate).toHaveBeenCalledWith('Movies')
})

test('the focus can walk the whole rail without a single host callback', async () => {
  const { tree, onActivate } = await rail()
  for (const label of ['All', 'Movies', 'News']) {
    await ReactTestRenderer.act(async () => { row(tree, label).props.onFocus() })
  }
  expect(onActivate).not.toHaveBeenCalled()
})

// ─── Pill grammar (S-Felix): SELECTED = filled accent pill, FOCUSED = light fill ───

/** The rail row's flattened background — the pill fill lives on the pressable itself. */
function pillBg (tree: RendererInstance, label: string) {
  return StyleSheet.flatten(row(tree, label).props.style)?.backgroundColor
}

test('the selected category renders as a filled accent pill', async () => {
  const { tree } = await rail() // selected="All"
  expect(pillBg(tree, 'All')).toBe(theme.colors.accent)
  // Idle, non-selected items carry no fill at all.
  expect(pillBg(tree, 'News')).toBeUndefined()
})

test('a focused, non-selected item gets the light focus pill — and the selected item keeps accent', async () => {
  const { tree } = await rail()
  await ReactTestRenderer.act(async () => { row(tree, 'News').props.onFocus() })
  // The harness keeps selected="All" (selection is the HOST's state), so News is
  // focused-but-not-active → focusFill…
  expect(pillBg(tree, 'News')).toBe(theme.colors.focusFill)
  // …while the selected item still shows the accent pill: active wins the precedence.
  expect(pillBg(tree, 'All')).toBe(theme.colors.accent)
})

test('focusing the selected item keeps the accent pill (active beats focused)', async () => {
  const { tree } = await rail()
  await ReactTestRenderer.act(async () => { row(tree, 'All').props.onFocus() })
  expect(pillBg(tree, 'All')).toBe(theme.colors.accent)
})

// ─── Fit: the rail is bounded by its PANEL, never by its own content ───

test('a parent with more sub-categories than fit scrolls inside the rail, instead of growing past it', async () => {
  // Nacional, on the operator's lineup: far more children than a 540dp television
  // viewport holds.
  const many = Array.from({ length: 40 }, (_, i) => ({ key: `Nacional/${i}`, label: `SUB ${i}` }))
  const { tree } = await rail({ items: many, selected: 'Nacional/0', parentHeader: { label: 'Nacional', onBack: jest.fn() } })
  const scroll = tree.root.findByType(ScrollView)
  // THE REGRESSION, in the only place a unit test can see it: these two were
  // `flexGrow: 0`, and RN defaults flexShrink to 0 as well, so the rail laid out at its
  // CONTENT height — nothing bounded it, and the extra items simply drew past the bottom
  // of the rail's own rounded panel, over the video. The ScrollView could not save it
  // either: a ScrollView scrolls only when a PARENT bounds its height, so at content
  // height there was no overflow to scroll and the spill WAS the scrolling. `flex: 1`
  // (grow and shrink) hands both the pane's height.
  expect(StyleSheet.flatten(scroll.props.style)?.flex).toBe(1)
  expect(StyleSheet.flatten(scroll.parent?.props.style)?.flex).toBe(1)
  // …and the items are all still THERE, reachable by scrolling rather than clipped away.
  expect(row(tree, 'SUB 39')).toBeTruthy()
})
