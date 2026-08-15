// The category rail's TV grammar: FOCUS SCOPES, OK ENTERS.
//
// These were one action, and that was the bug. Moving the D-pad focus called the host's
// select, and select DRILLED into any category that had sub-categories — so simply
// walking down the rail entered the first parent it passed. Measured on a TCL set going
// down from All: the focus landed on Movies, the rail immediately became Movies'
// sub-list, and from there the viewer could reach neither the categories below Movies
// nor Movies itself as a whole.
//
// Focus-selects at all is TV-only: on phone, Android's touch-mode focus lands on a rail
// item right after a tap elsewhere in the rail and would instantly revert the tapped
// selection, so the phone goes through press alone. Both halves are pinned here.
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, StyleSheet } from 'react-native'

const { Platform } = require('react-native')
const realIsTV = Object.getOwnPropertyDescriptor(Platform, 'isTV')!
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
// AFTER the isTV fake, like TvLiveDpad: theme snapshots Platform.isTV at module load,
// and an ESM import would hoist above the override and bake phone metrics into the
// "TV" suite. requires below this line see the TV theme.
const { theme } = require('../src/theme')
const { CategoryRail } = require('../src/components/CategoryRail')

afterAll(() => { Object.defineProperty(Platform, 'isTV', realIsTV) })

const ITEMS = [
  { key: 'All', label: 'All' },
  { key: 'Movies', label: 'Movies', hasChildren: true },
  { key: 'News', label: 'News' }
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
  const onSelect = jest.fn()
  const onActivate = jest.fn()
  const tree = await createTree(
    <CategoryRail items={ITEMS} selected="All" onSelect={onSelect} onActivate={onActivate} {...over} />
  )
  return { tree, onSelect, onActivate }
}

test('moving the focus onto a parent SCOPES it and never enters it', async () => {
  const { tree, onSelect, onActivate } = await rail()
  await ReactTestRenderer.act(async () => { row(tree, 'Movies').props.onFocus() })
  // Scope, yes…
  expect(onSelect).toHaveBeenCalledWith('Movies')
  // …enter, no. This is the whole regression: onActivate is what drills, and walking
  // the focus past a parent must not fire it or the rail below Movies becomes
  // unreachable.
  expect(onActivate).not.toHaveBeenCalled()
})

test('OK on a parent is what enters it', async () => {
  const { tree, onSelect, onActivate } = await rail()
  await ReactTestRenderer.act(async () => { row(tree, 'Movies').props.onPress() })
  expect(onActivate).toHaveBeenCalledWith('Movies')
  expect(onSelect).not.toHaveBeenCalled()
})

test('the focus can walk the whole rail — a parent in the middle is passed, not entered', async () => {
  const { tree, onSelect, onActivate } = await rail()
  for (const label of ['All', 'Movies', 'News']) {
    await ReactTestRenderer.act(async () => { row(tree, label).props.onFocus() })
  }
  expect(onSelect.mock.calls.map((c: any[]) => c[0])).toEqual(['All', 'Movies', 'News'])
  expect(onActivate).not.toHaveBeenCalled()
})

test('a host that gives no onActivate falls back to onSelect', async () => {
  // Phone passes only onSelect — a tap must still do the whole job there.
  const { tree, onSelect } = await rail({ onActivate: undefined })
  await ReactTestRenderer.act(async () => { row(tree, 'Movies').props.onPress() })
  expect(onSelect).toHaveBeenCalledWith('Movies')
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
