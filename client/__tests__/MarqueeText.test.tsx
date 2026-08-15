// MarqueeText: the focused-row title scroller (Phase 3 of the TV GUI round).
// Mode matrix, driven by hand-fed onLayout events (jest lays nothing out) and fake
// timers (the scroller MOUNT is deferred behind startDelayMs of held focus — during
// D-pad transit nothing but the static line ever exists):
//   inactive                    -> the plain ellipsized single line (numberOfLines=1)
//   active held + overflowing   -> the scrolling Animated.Text (a translateX transform)
//   active held + fits          -> back to the plain line (no loop for a title that fits)
//   active but released early   -> the scroller never mounts at all
//   reduced motion              -> plain line even when active + overflowing (OS setting)

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance, ReactTestInstance } from 'react-test-renderer'
import { StyleSheet } from 'react-native'
import { MarqueeText } from '../src/components/MarqueeText'
import { prefersReducedMotion } from '../src/motion'

// Controllable reduced-motion answer (the real module caches an async OS setting).
jest.mock('../src/motion', () => ({ prefersReducedMotion: jest.fn(() => false) }))

jest.useFakeTimers()

const ARM_MS = 800 // the component's startDelayMs default — the held-focus threshold

const mounted: RendererInstance[] = []
async function createTree (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  jest.clearAllTimers()
  ;(prefersReducedMotion as jest.Mock).mockReturnValue(false)
})

const advance = async (ms: number) => {
  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(ms) })
}

// Host <Text> elements (react-test-renderer type string), composite wrappers skipped.
const hostTexts = (tree: RendererInstance): ReactTestInstance[] =>
  tree.root.findAll(n => (n.type as unknown) === 'Text', { deep: true })

const layout = async (node: ReactTestInstance, width: number) => {
  await ReactTestRenderer.act(async () => {
    node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 20 } } })
  })
}

/** The outer clip View — the one host View carrying our onLayout. */
const clipView = (tree: RendererInstance): ReactTestInstance =>
  tree.root.findAll(n => (n.type as unknown) === 'View' && typeof n.props.onLayout === 'function')[0]

/** The measuring/scrolling text: a host Text with an onLayout of its own. */
const scrollText = (tree: RendererInstance): ReactTestInstance | undefined =>
  hostTexts(tree).find(n => typeof n.props.onLayout === 'function')

const hasTransform = (tree: RendererInstance): boolean =>
  hostTexts(tree).some(n => !!(StyleSheet.flatten(n.props.style) as any)?.transform)

const expectStatic = (tree: RendererInstance) => {
  const texts = hostTexts(tree)
  expect(texts).toHaveLength(1)
  expect(texts[0].props.numberOfLines).toBe(1)
  expect(texts[0].props.ellipsizeMode).toBe('tail')
  expect(hasTransform(tree)).toBe(false)
}

/** Focus, hold past the arm threshold, and feed the measurements. */
async function armAndMeasure (tree: RendererInstance, containerW: number, textW: number) {
  await layout(clipView(tree), containerW)
  await advance(ARM_MS)
  await layout(scrollText(tree)!, textW)
}

test('inactive: the plain ellipsized single line, no animation machinery — however long it sits', async () => {
  const tree = await createTree(<MarqueeText text="A very long live event title" />)
  // A resting row pays NOTHING — not even the container measurement: the clip
  // View's onLayout is attached only while `active` (containerW is consulted only
  // after arming), so ~15 mounted rows don't each pay a bridge callback + a state
  // write on mount/scroll-in.
  expect(clipView(tree)).toBeUndefined()
  await advance(5000) // nothing arms without `active`
  expectStatic(tree)
})

test('holding focus on an overflowing title: the scroller mounts AFTER the arm delay, with a translateX transform', async () => {
  const tree = await createTree(<MarqueeText text="A very long live event title" active />)
  await layout(clipView(tree), 100)
  // Before the threshold: the focus frame mounted NOTHING new (deferred mount).
  expect(scrollText(tree)).toBeUndefined()
  await advance(ARM_MS)
  await layout(scrollText(tree)!, 300) // full text measures past the 100px slot
  expect(hasTransform(tree)).toBe(true)
  // numberOfLines=1 on the scroller forbids WRAPPING only (a \n in a feed title must
  // not break the pinned row height) — inside the unbounded ScrollView the available
  // width is infinite, so nothing re-truncates and no ellipsis appears.
  expect(scrollText(tree)!.props.numberOfLines).toBe(1)
  expect(scrollText(tree)!.props.ellipsizeMode).toBeUndefined()
})

test('active + fits: back to the plain line — a title that fits never loops', async () => {
  const tree = await createTree(<MarqueeText text="Short" active />)
  await armAndMeasure(tree, 100, 80) // measures INSIDE the slot
  expectStatic(tree)
})

test('a sub-pixel overhang is rounding, not overflow: no loop inside the epsilon', async () => {
  const tree = await createTree(<MarqueeText text="Nearly fits" active />)
  await armAndMeasure(tree, 100, 105) // within the ~8px epsilon
  expectStatic(tree)
})

test('fast focus flip: released before the threshold, the scroller never mounts', async () => {
  const tree = await createTree(<MarqueeText text="A very long live event title" active />)
  await layout(clipView(tree), 100)
  await advance(300) // a D-pad transit dwell, well under the threshold
  expect(scrollText(tree)).toBeUndefined()
  await ReactTestRenderer.act(async () => { tree.update(<MarqueeText text="A very long live event title" />) })
  await advance(5000) // the cleared timer must never fire
  expectStatic(tree)
})

test('reduced motion: static even when active + overflowing (OS "remove animations")', async () => {
  ;(prefersReducedMotion as jest.Mock).mockReturnValue(true)
  const tree = await createTree(<MarqueeText text="A very long live event title" active />)
  await layout(clipView(tree), 100)
  await advance(ARM_MS)
  // Armed, but no measuring pass even runs — the static line is the whole render.
  expect(scrollText(tree)).toBeUndefined()
  expectStatic(tree)
})

test('deactivating returns to the ellipsized line (blur stops the loop)', async () => {
  const tree = await createTree(<MarqueeText text="A very long live event title" active />)
  await armAndMeasure(tree, 100, 300)
  expect(hasTransform(tree)).toBe(true)
  await ReactTestRenderer.act(async () => { tree.update(<MarqueeText text="A very long live event title" />) })
  expectStatic(tree)
})

test('text change mid-loop: stale measurement rejected, re-defers, then re-measures the new title', async () => {
  const tree = await createTree(<MarqueeText text="The first very long event title" active />)
  await armAndMeasure(tree, 100, 300)
  expect(hasTransform(tree)).toBe(true)
  // New title while still focused: the old width must not answer for it.
  await ReactTestRenderer.act(async () => { tree.update(<MarqueeText text="A different long event title" active />) })
  expect(hasTransform(tree)).toBe(false) // back to the static line immediately
  expect(scrollText(tree)).toBeUndefined() // and the mount defers AGAIN from zero
  await advance(ARM_MS)
  await layout(scrollText(tree)!, 300)
  expect(hasTransform(tree)).toBe(true)
})

test('container growth re-decides the mode: the same measured text stops looping when it fits', async () => {
  const tree = await createTree(<MarqueeText text="A very long live event title" active />)
  await armAndMeasure(tree, 100, 300)
  expect(hasTransform(tree)).toBe(true)
  await layout(clipView(tree), 400) // the slot now swallows the 300px title
  expectStatic(tree)
})
