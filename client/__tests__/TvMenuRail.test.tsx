// The TV main menu's LEFT rail (2026-08-15): the section tiles moved from the old
// horizontal top bar to the phone's vertical left-rail grammar, keeping the TV focus
// contract — entries are FOCUS-driven Pressables (accent ring via onFocus, preferred
// focus on the first) inside a VERTICAL ScrollView, and the wordmark moved into the
// hero area (the old absolute bottom-left footer would sit under the rail).

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { ScrollView } from 'react-native'
import { MenuScreen } from '../src/screens/MenuScreen'
import { backend } from '../src/worklet'
import { theme } from '../src/theme'

const navigation = { navigate: jest.fn() } as any

const mounted: RendererInstance[] = []
async function mount () {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<MenuScreen navigation={navigation} route={{} as any} />) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}

const wasTV = theme.isTV
beforeEach(() => { (theme as { isTV: boolean }).isTV = true })
afterEach(async () => {
  (theme as { isTV: boolean }).isTV = wasTV
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  backend.streams = []
  navigation.navigate.mockClear()
})

test('TV renders the sections as a focus-driven VERTICAL rail, not a top bar', async () => {
  const tree = await mount()

  // One ScrollView, and it scrolls vertically — the horizontal top bar is gone.
  const scrollers = tree.root.findAllByType(ScrollView)
  expect(scrollers).toHaveLength(1)
  expect(scrollers[0].props.horizontal).toBeFalsy()

  // The entries are the FOCUS-driven kind: onFocus/onBlur handlers (the accent-ring
  // grammar a remote navigates by), never the phone rail's press-only tiles.
  const entries = scrollers[0].findAll(n => typeof n.props?.onFocus === 'function' && typeof n.props?.onPress === 'function')
  expect(entries.length).toBeGreaterThanOrEqual(3) // Live TV + Settings (+ Guide/Search/Exit per descriptor)

  // The first tile takes preferred focus; the rest must not fight it.
  expect(entries[0].props.hasTVPreferredFocus).toBe(true)
  for (const e of entries.slice(1)) expect(e.props.hasTVPreferredFocus).toBeFalsy()

  // OK on the first tile (Live TV) navigates.
  await ReactTestRenderer.act(async () => { entries[0].props.onPress() })
  expect(navigation.navigate).toHaveBeenCalledWith('Live', {})
})
