// ReportSheet (S51): the in-player report flow. Pins the three product decisions —
// it opens from the PLAYER (so the engine attaches the channel being watched), it
// offers every category EXCEPT 'login' (unreachable mid-playback by construction),
// and it contains NO free-text input anywhere: select a category, press Send, done.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, TextInput } from 'react-native'

// RN's own jest mock for Modal requireActual()s virtualized-lists ESM this preset
// cannot parse — replace it with a visibility-honoring passthrough.
jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: ({ visible, children }: { visible?: boolean; children?: unknown }) => (visible ? children : null)
}))
import { ReportSheet } from '../src/components/ReportSheet'
import { backend } from '../src/worklet'
import { REPORT_CATEGORIES } from '@aliran/react-native'

// The module-singleton backend has no worklet in jest: send() queues messages in
// `pending`, and onData() simulates worklet replies (SmoothZappingToggle pattern).
function sentMessages (): any[] { return (backend as any).pending }
function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }

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
  sentMessages().length = 0
})

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
}

test('offers every category except login, names the channel, and has no text input', async () => {
  const tree = await createTree(<ReportSheet visible channelTitle="News 24" onClose={() => {}} />)
  // Host nodes only — the Pressable composite + its layers all carry the role.
  const rows = tree.root.findAll(n => n.props.accessibilityRole === 'radio' && typeof n.type === 'string')
  expect(rows).toHaveLength(REPORT_CATEGORIES.length - 1) // all but 'login'
  const t = texts(tree)
  expect(t).toContain('News 24')
  expect(t).not.toContain('Trouble signing in')
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0)
})

test('select + Send reports the category over IPC; the result lands in the sheet', async () => {
  const tree = await createTree(<ReportSheet visible channelTitle="News 24" onClose={() => {}} />)
  const buffering = tree.root.findAll(n => n.props.accessibilityRole === 'radio')
    .find(n => n.findAllByType(Text).some(t => String(t.props.children).includes('Keeps buffering')))
  expect(buffering).toBeTruthy()
  await ReactTestRenderer.act(async () => { buffering!.props.onPress() })

  const send = tree.root.findAll(n => n.props.accessibilityRole === 'button')
    .find(n => n.findAllByType(Text).some(t => String(t.props.children) === 'Send report'))
  expect(send).toBeTruthy()
  await ReactTestRenderer.act(async () => { send!.props.onPress() })

  const msg = sentMessages().map(m => (typeof m === 'string' ? JSON.parse(m) : m)).find(m => m.type === 'report')
  expect(msg).toBeTruthy()
  expect(msg.category).toBe('buffering')
  expect(msg.text).toBeUndefined() // structurally no free text

  await ReactTestRenderer.act(async () => { workletSays({ type: 'report-result', ok: true }) })
  expect(texts(tree)).toContain('Thanks — your report was sent.')
})
