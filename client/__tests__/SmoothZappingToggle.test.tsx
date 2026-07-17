// "Smooth zapping" settings toggle (S21) — UI contract: the switch reflects the
// persisted pref, flips optimistically on press, sends the runtime toggle to the
// worklet (backend.setZapPrefetch), and settles on whatever the worklet's 'prefs'
// reply confirms. The worklet side (persist + boot override + engine setter) is
// covered by test:sdk / the backend e2e — this suite is the RN plumbing only.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import { SettingsScreen } from '../src/screens/SettingsScreen'
import { backend } from '../src/worklet'

function toggleRow (tree: RendererInstance) {
  // The switch is the node carrying accessibilityRole="switch" AND the onPress
  // handler (the Pressable composite — matching on type breaks through memo/refs).
  const rows = tree.root.findAll(n => n.props?.accessibilityRole === 'switch' && typeof n.props?.onPress === 'function')
  if (!rows.length) throw new Error('no smooth-zapping switch rendered')
  return rows[0]
}

function pillState (tree: RendererInstance): string {
  const row = toggleRow(tree)
  const texts = row.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join(''))
  const state = texts.find(s => s === 'ON' || s === 'OFF')
  if (!state) throw new Error('no ON/OFF pill rendered')
  return state
}

// The module-singleton backend has no worklet in jest: send() queues messages in
// `pending`, which doubles as our IPC assertion surface; onData() lets a test play
// the worklet's side of the protocol.
function sentMessages (): any[] { return (backend as any).pending }
function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }

const navigation = { reset: jest.fn() } as any
const route = {} as any

beforeEach(() => {
  sentMessages().length = 0
  backend.smoothZapping = null
})

test('renders OFF by default, flips optimistically and sends the runtime toggle', async () => {
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<SettingsScreen navigation={navigation} route={route} />) })
  expect(pillState(tree)).toBe('OFF')

  await ReactTestRenderer.act(() => { toggleRow(tree).props.onPress() })
  expect(pillState(tree)).toBe('ON') // optimistic
  expect(sentMessages()).toEqual(expect.arrayContaining([{ type: 'zap-prefetch-set', zapPrefetch: true }]))

  await ReactTestRenderer.act(() => { toggleRow(tree).props.onPress() })
  expect(pillState(tree)).toBe('OFF')
  expect(sentMessages()).toEqual(expect.arrayContaining([{ type: 'zap-prefetch-set', zapPrefetch: false }]))
})

test('reflects the worklet-confirmed pref (and the backend mirrors it)', async () => {
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<SettingsScreen navigation={navigation} route={route} />) })
  expect(pillState(tree)).toBe('OFF')

  // Worklet echoes a persisted ON (e.g. set on a previous run) via the prefs reply.
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [], smoothZapping: true }) })
  expect(pillState(tree)).toBe('ON')
  expect(backend.smoothZapping).toBe(true)

  // A prefs reply without the field (older worklet bundle) degrades to OFF, not crash.
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [] }) })
  expect(pillState(tree)).toBe('OFF')
  expect(backend.smoothZapping).toBeNull()
})

test('a screen mounted after boot seeds from the mirrored pref', async () => {
  backend.smoothZapping = true // mirrored from an earlier prefs reply
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<SettingsScreen navigation={navigation} route={route} />) })
  expect(pillState(tree)).toBe('ON')
})
