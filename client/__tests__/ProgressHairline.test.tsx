// ProgressHairline (WS1): the 2px program-progress track under now-playing lines.
// The math is the SDK's programProgress (covered in epg.test.ts) — these tests pin
// the RENDER contract: no program keeps a transparent, never-collapsed track (rows
// are height-pinned for getItemLayout); a mid-program fill is the elapsed fraction;
// a finished program fills the whole track.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { View } from 'react-native'
import { ProgressHairline } from '../src/components/ProgressHairline'

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

test('no program: a transparent track, never collapsed', async () => {
  const tree = await createTree(<ProgressHairline program={null} />)
  const views = tree.root.findAllByType(View)
  expect(views).toHaveLength(1) // track only — no fill
  const style = JSON.stringify(views[0].props.style)
  expect(style).toContain('transparent')
  expect(style).toContain('"height":2') // still 2px tall — fixed row heights hold
})

test('mid-program: the fill is the elapsed fraction of the track', async () => {
  const now = Date.now()
  const tree = await createTree(<ProgressHairline program={{ title: 'Halfway', start: now - 600_000, stop: now + 600_000 }} />)
  const views = tree.root.findAllByType(View)
  expect(views).toHaveLength(2)
  const width = JSON.stringify(views[1].props.style).match(/"width":"([\d.]+)%"/)![1]
  expect(parseFloat(width)).toBeCloseTo(50, 0)
})

test('finished program: the fill spans the whole track', async () => {
  const now = Date.now()
  const tree = await createTree(<ProgressHairline program={{ title: 'Over', start: now - 7_200_000, stop: now - 3_600_000 }} />)
  const fill = tree.root.findAllByType(View)[1]
  expect(JSON.stringify(fill.props.style)).toContain('"width":"100%"')
})

test('color overrides the default live fill', async () => {
  const now = Date.now()
  const tree = await createTree(<ProgressHairline program={{ title: 'On', start: now - 60_000, stop: now + 60_000 }} color="#22D3EE" />)
  const fill = tree.root.findAllByType(View)[1]
  expect(JSON.stringify(fill.props.style)).toContain('#22D3EE')
})
