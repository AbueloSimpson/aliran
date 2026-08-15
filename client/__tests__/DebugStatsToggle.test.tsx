// "Debug overlay" settings toggle — UI contract, the SmoothZappingToggle suite's
// sibling: the switch reflects the persisted pref, flips optimistically on press,
// sends debug-stats-set to the worklet, and settles on whatever the worklet's
// 'prefs' reply confirms. The worklet side (persist + prefs echo) is plain prefs
// plumbing; the HUD itself is covered by StatsHud.test.tsx.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'

// RN's own jest mock for Modal requireActual()s virtualized-lists ESM this preset
// cannot parse — replace it with a visibility-honoring passthrough (ReportSheet
// pattern; Settings mounts the parental PIN modals).
jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: ({ visible, children }: { visible?: boolean; children?: unknown }) => (visible ? children : null)
}))
import { SettingsScreen } from '../src/screens/SettingsScreen'
import { backend } from '../src/worklet'

function rowTexts (row: ReturnType<RendererInstance['root']['findAll']>[number]): string[] {
  return row.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join(''))
}

// There is more than one switch on this screen (Smooth zapping sits above) — find
// OURS by its rendered label, not by index, so a new row cannot silently retarget
// this suite.
function toggleRow (tree: RendererInstance) {
  const rows = tree.root.findAll(n => n.props?.accessibilityRole === 'switch' && typeof n.props?.onPress === 'function')
  const row = rows.find(r => rowTexts(r).some(s => s === 'Debug overlay'))
  if (!row) throw new Error('no debug-overlay switch rendered')
  return row
}

function pillState (tree: RendererInstance): string {
  const state = rowTexts(toggleRow(tree)).find(s => s === 'ON' || s === 'OFF')
  if (!state) throw new Error('no ON/OFF pill rendered')
  return state
}

function sentMessages (): any[] { return (backend as any).pending }
function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }

const navigation = { reset: jest.fn() } as any
const route = {} as any

beforeEach(() => {
  sentMessages().length = 0
  backend.debugStats = null
})

test('renders OFF by default, flips optimistically and persists through the worklet', async () => {
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<SettingsScreen navigation={navigation} route={route} />) })
  expect(pillState(tree)).toBe('OFF')

  await ReactTestRenderer.act(() => { toggleRow(tree).props.onPress() })
  expect(pillState(tree)).toBe('ON') // optimistic
  expect(sentMessages()).toEqual(expect.arrayContaining([{ type: 'debug-stats-set', debugStats: true }]))

  await ReactTestRenderer.act(() => { toggleRow(tree).props.onPress() })
  expect(pillState(tree)).toBe('OFF')
  expect(sentMessages()).toEqual(expect.arrayContaining([{ type: 'debug-stats-set', debugStats: false }]))
})

test('reflects the worklet-confirmed pref (and the backend mirrors it)', async () => {
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<SettingsScreen navigation={navigation} route={route} />) })
  expect(pillState(tree)).toBe('OFF')

  // Worklet echoes a persisted ON — e.g. the TV remote's INFO key flipped it in the
  // player; this row must repaint without being touched.
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [], debugStats: true }) })
  expect(pillState(tree)).toBe('ON')
  expect(backend.debugStats).toBe(true)

  // A prefs reply without the field (older worklet bundle) degrades to OFF, not crash.
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [] }) })
  expect(pillState(tree)).toBe('OFF')
  expect(backend.debugStats).toBeNull()
})

test('a screen mounted after boot seeds from the mirrored pref', async () => {
  backend.debugStats = true // mirrored from an earlier prefs reply
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<SettingsScreen navigation={navigation} route={route} />) })
  expect(pillState(tree)).toBe('ON')
})
