// ChannelChangeIndicator (tuning pill) — presentation contract: an optimistic ramp
// whose only hard-truthful point is the end (100% == the tune's first real playback,
// active -> false), honest self-heal labels instead of a frozen percentage, and a
// slow-crawl budget so a slow-starting feed doesn't park at 90% within seconds.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import { ChannelChangeIndicator } from '../src/components/ChannelChangeIndicator'

function texts (tree: RendererInstance): string[] {
  return tree.root.findAllByType(Text).map(t => t.props.children).flat().map(String)
}

function pct (tree: RendererInstance): number | null {
  // The percentage renders as its own <Text> ("82%") — match that node exactly, or the
  // channel number ("009") bleeds into the digits.
  for (const t of tree.root.findAllByType(Text)) {
    const s = [t.props.children].flat(9).map(String).join('')
    const m = s.match(/^(\d+)%$/)
    if (m) return Number(m[1])
  }
  return null
}

beforeEach(() => { jest.useFakeTimers() })
afterEach(() => { jest.useRealTimers() })

test('ramps slowly toward ~85 and snaps to 100 on completion, then hides', async () => {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ChannelChangeIndicator active number={9} title="OAN Plus" />)
  })
  expect(texts(tree).join(' ')).toContain('Tuning')
  expect(texts(tree).join(' ')).toContain('009')

  // Quick attack: visibly moving within a second…
  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(1000) })
  const at1s = pct(tree)!
  expect(at1s).toBeGreaterThan(20)
  // …then a slow crawl: still meaningfully below the asymptote at 30 s (the old ramp
  // parked at ~90% after ~3 s and sat there for a minute on slow feeds).
  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(29000) })
  const at30s = pct(tree)!
  expect(at30s).toBeGreaterThan(at1s)
  expect(at30s).toBeLessThan(85)

  // Completion (active -> false): snap to 100, hold briefly, hide.
  await ReactTestRenderer.act(async () => { tree.update(<ChannelChangeIndicator active={false} number={9} title="OAN Plus" />) })
  expect(pct(tree)).toBe(100)
  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(500) })
  expect(tree.toJSON()).toBeNull()
})

test('self-heal phases relabel the pill and hide the meaningless percentage', async () => {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ChannelChangeIndicator active phase="tuning" number={12} />)
  })
  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(2000) })
  expect(pct(tree)).not.toBeNull()

  await ReactTestRenderer.act(async () => { tree.update(<ChannelChangeIndicator active phase="retune" number={12} />) })
  expect(texts(tree).join(' ')).toContain('Retuning')
  expect(pct(tree)).toBeNull()

  await ReactTestRenderer.act(async () => { tree.update(<ChannelChangeIndicator active phase="reconnect" number={12} />) })
  expect(texts(tree).join(' ')).toContain('Reconnecting')
  expect(pct(tree)).toBeNull()

  // Completion still shows the truthful 100%.
  await ReactTestRenderer.act(async () => { tree.update(<ChannelChangeIndicator active={false} phase="reconnect" number={12} />) })
  expect(pct(tree)).toBe(100)
})
