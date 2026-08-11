// GuideSkeleton (WS17): the static skeleton frame LiveScreen mounts in the guide's
// bed while the real GuidePanel waits for the deferred mount. Render smoke: the
// frame carries the REAL TimeBar (times are known synchronously — authenticity for
// free) and otherwise pure imagery — no other text, no spinner, nothing animated.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, ActivityIndicator } from 'react-native'

import { GuideSkeleton } from '../src/components/GuideSkeleton'
import { hhmm } from '../src/components/GuidePanel'
import { GUIDE_SLOTS, SLOT_MS, snapToNow } from '../src/guide'

const mounted: RendererInstance[] = []
async function createTree (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  jest.restoreAllMocks()
})

test('renders the real time bar over an otherwise text-free, spinner-free frame', async () => {
  // Pin the clock so the expected slot labels can't roll over mid-test.
  const NOW = Date.parse('2026-08-09T18:44:00.000Z')
  jest.spyOn(Date, 'now').mockReturnValue(NOW)
  const tree = await createTree(<GuideSkeleton />)

  const texts = tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join(''))
  // The REAL times: one label per slot, walking from the snapped half-hour.
  const ws = snapToNow(NOW)
  const expected = Array.from({ length: GUIDE_SLOTS }, (_, i) => hhmm(ws + i * SLOT_MS))
  expect(texts).toEqual(expected) // and NOTHING else — the skeleton is imagery only
  // No spinner — this is the guide's frame, not a branded loading screen.
  expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(0)
})
