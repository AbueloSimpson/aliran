// "Let my devices change this TV" — the per-set take-over switch (residual 10).
//
// TWO PROPERTIES, AND THE SECOND ONE IS THE WHOLE POINT.
//
//   It is TELEVISION-ONLY. A phone is the device that sends; there is nothing on it for
//   this switch to protect, and the row must not appear there.
//
//   It NEVER FLIPS OPTIMISTICALLY, unlike every other toggle on that screen. This row is a
//   security control, and a control that reads "off" over a preference which never reached
//   the disk is worse than no control: the viewer stops looking for the real lever ("log
//   out all devices"), and the set takes commands again at the next boot. The worklet sends
//   'prefs' only once the write landed, so this row paints what a reboot would restore.
//
// The worklet half — the write itself, and startRemote() reading it back as `acceptPlay` —
// is backend.mjs, and is asserted where the join is: SendToTvCast's "the join does not
// overrule the persisted take-over switch".
//
// Platform.isTV is faked with ordered require()s rather than jest.isolateModules: an
// isolated registry hands screen tests a SECOND React, and hooks then throw.
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'

// Settings mounts the parental PIN modals; RN's own Modal mock requireActual()s ESM this
// preset cannot parse (the SmoothZappingToggle/ReportSheet pattern).
jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: ({ visible, children }: { visible?: boolean; children?: unknown }) => (visible ? children : null)
}))

const navigation = { reset: jest.fn() } as any
const route = {} as any

// theme.ts reads Platform.isTV ONCE, at module load, so the fake has to be in place before
// anything that reaches it is required. ES imports are hoisted; these are not.
const { Platform } = require('react-native')
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
const { SettingsScreen } = require('../src/screens/SettingsScreen')
const { backend } = require('../src/worklet')

const LABEL = 'Let my devices change this TV'

function sentMessages (): any[] { return (backend as any).pending }
function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }

function textOf (node: any): string {
  return node.findAllByType(Text).map((t: any) => [t.props.children].flat(9).map(String).join('')).join(' ')
}

/** The switch row carrying LABEL — matched by its own copy, so adding another toggle to
 *  the screen (or reordering the groups) cannot silently point this suite at that one. */
function acceptRow (tree: RendererInstance) {
  const rows = tree.root.findAll((n: any) => n.props?.accessibilityRole === 'switch' && typeof n.props?.onPress === 'function')
  const row = rows.find((r: any) => textOf(r).includes(LABEL))
  if (!row) throw new Error(`no "${LABEL}" switch rendered (${rows.length} switch row(s) on screen)`)
  return row
}

function pillState (tree: RendererInstance): string {
  const texts = acceptRow(tree).findAllByType(Text).map((t: any) => [t.props.children].flat(9).map(String).join(''))
  const state = texts.find((s: string) => s === 'ON' || s === 'OFF')
  if (!state) throw new Error('no ON/OFF pill rendered')
  return state
}

async function mount (): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<SettingsScreen navigation={navigation} route={route} />) })
  return tree
}

beforeEach(() => {
  sentMessages().length = 0
  backend.remoteAccept = null
})

test('a television shows the switch, and it is ON until the viewer says otherwise', async () => {
  const tree = await mount()
  expect(pillState(tree)).toBe('ON')
})

// THE HONESTY PROPERTY. The press asks; it does not decide.
test('a press sends the request and paints NOTHING until the worklet confirms the write', async () => {
  const tree = await mount()
  await ReactTestRenderer.act(() => { acceptRow(tree).props.onPress() })

  expect(sentMessages()).toEqual(expect.arrayContaining([{ type: 'remote-accept', ok: false }]))
  expect(pillState(tree)).toBe('ON')   // the write has not landed yet
  expect(backend.remoteAccept).toBeNull() // …and the mirror did not run ahead of it either

  // The worklet wrote it, and says so the only way it ever does.
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [], remoteAccept: false }) })
  expect(pillState(tree)).toBe('OFF')
  expect(backend.remoteAccept).toBe(false)
})

// A FAILED WRITE MUST NOT READ AS "OFF". writePrefs() returning false is the one path that
// sends no 'prefs' at all, and the row has to sit still through it.
test('a write the worklet never confirms leaves the switch ON', async () => {
  const tree = await mount()
  await ReactTestRenderer.act(() => { acceptRow(tree).props.onPress() })
  await ReactTestRenderer.act(() => { workletSays({ type: 'error', message: 'prefs write failed: ENOSPC' }) })
  expect(pillState(tree)).toBe('ON')
})

test('switching it back on is the same round trip', async () => {
  backend.remoteAccept = false
  const tree = await mount()
  expect(pillState(tree)).toBe('OFF')

  await ReactTestRenderer.act(() => { acceptRow(tree).props.onPress() })
  expect(sentMessages()).toEqual(expect.arrayContaining([{ type: 'remote-accept', ok: true }]))
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [], remoteAccept: true }) })
  expect(pillState(tree)).toBe('ON')
})

// An older worklet bundle has no such field. "Never chose" is ON, which is the same answer
// startRemote() gives when the prefs file has nothing to say.
test('a prefs reply without the field reads as ON, not as OFF', async () => {
  backend.remoteAccept = false
  const tree = await mount()
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [] }) })
  expect(pillState(tree)).toBe('ON')
  expect(backend.remoteAccept).toBeNull()
})
