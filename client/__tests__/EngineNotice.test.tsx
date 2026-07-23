// EngineNotice — the SDK's ready-made unsupported-device screen for single-APK
// builds. Contract: honest default copy about the Android 10+ engine floor, fully
// brandable, and the action button (the host's "use another method" seam) renders
// ONLY when a handler is provided and fires it on press.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import { EngineNotice } from '@aliran/react-native'

const mounted: RendererInstance[] = []
async function mount (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(el) })
  mounted.push(tree)
  return tree
}

afterEach(async () => {
  for (const t of mounted.splice(0)) await ReactTestRenderer.act(() => { t.unmount() })
})

function texts (tree: RendererInstance): string[] {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join(''))
}

test('defaults: the honest floor message, no title, no action button', async () => {
  const tree = await mount(<EngineNotice />)
  const all = texts(tree)
  expect(all).toContain("This device can't run the P2P engine — Android 10 or newer is required.")
  expect(tree.root.findAll(n => typeof n.props?.onPress === 'function')).toHaveLength(0)
})

test('brandable: custom title, message, and extra child content render', async () => {
  const tree = await mount(
    <EngineNotice title="Acme TV" message="This box is too old for peer-to-peer.">
      <Text>Call support on 555-0100</Text>
    </EngineNotice>
  )
  const all = texts(tree)
  expect(all).toContain('Acme TV')
  expect(all).toContain('This box is too old for peer-to-peer.')
  expect(all).toContain('Call support on 555-0100')
})

test('the fallback seam: action button renders with onAction and fires it', async () => {
  const onAction = jest.fn()
  const tree = await mount(<EngineNotice actionLabel="Watch via app TV mode" onAction={onAction} />)
  expect(texts(tree)).toContain('Watch via app TV mode')
  const btn = tree.root.findAll(n => typeof n.props?.onPress === 'function')
  expect(btn).toHaveLength(1)
  await ReactTestRenderer.act(() => { btn[0].props.onPress() })
  expect(onAction).toHaveBeenCalledTimes(1)
})

test('default action label applies when only onAction is given', async () => {
  const tree = await mount(<EngineNotice onAction={() => {}} />)
  expect(texts(tree)).toContain('Use another method')
})
