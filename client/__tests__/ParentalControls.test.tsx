// Parental controls: the visibility rule + the PIN plumbing (device policy).
// Pins the product decisions: NO PIN on the device → restricted channels do not
// exist in any list; PIN set → visible but tuning asks (once per session); PIN +
// hide → hidden again. The worklet owns the digest — the RN layer only mirrors
// { hide } and round-trips verification. The worklet side (salted digest, prefs
// persistence) runs for real in the bundle; here we drive the message protocol.
//
// The AUTOMATIC tune paths — the channel LiveScreen starts by itself on a cold
// navigation or after a declined PIN — live in ParentalHeroFallback.test.tsx.

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
import { backend, type Stream } from '../src/worklet'
import { blockedWithoutPin, hasPin, markUnlocked, needsPin, visibleStreams } from '../src/parental'

// The module-singleton backend has no worklet in jest: send() queues messages in
// `pending`, and onData() simulates worklet replies (SmoothZappingToggle pattern).
function sentMessages (): any[] { return (backend as any).pending }
function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }

const plain: Stream = { id: 'news', title: 'News' } as Stream
const adult: Stream = { id: 'late', title: 'Late Night', restricted: true } as Stream

const mounted: RendererInstance[] = []
async function mount (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  for (const t of mounted.splice(0)) await ReactTestRenderer.act(async () => t.unmount())
})

function texts (tree: RendererInstance): string[] {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join(''))
}

beforeEach(() => {
  sentMessages().length = 0
  backend.parental = null
})

test('no PIN on the device: restricted channels do not exist in any list', () => {
  expect(hasPin()).toBe(false)
  expect(visibleStreams([plain, adult]).map(s => s.id)).toEqual(['news'])
  // …and nothing asks for a PIN either — there is nothing to enter.
  expect(needsPin(adult)).toBe(false)
})

test('PIN set: restricted channels are listed but gated; hide folds them away again', () => {
  backend.parental = { hide: false }
  expect(visibleStreams([plain, adult]).map(s => s.id)).toEqual(['news', 'late'])
  expect(needsPin(adult)).toBe(true)
  expect(needsPin(plain)).toBe(false)
  backend.parental = { hide: true }
  expect(visibleStreams([plain, adult]).map(s => s.id)).toEqual(['news'])
  // hidden ≠ unlocked: any leftover path into playback still asks
  expect(needsPin(adult)).toBe(true)
})

// THE SECOND CLAUSE OF THE RULE. "Hidden" is only half of what no-PIN means: the channel
// does not exist on this device, so nothing may play it either. needsPin() answering false
// is correct — there is no PIN to compare an entry against — and it is exactly why a route
// that names a channel from OUTSIDE the lists (a remote play from another device on the
// account, resolved against the unfiltered catalog) walks straight through the gate.
test('no PIN: a restricted channel is BLOCKED, not merely unlisted', () => {
  expect(blockedWithoutPin(adult.restricted)).toBe(true)
  expect(blockedWithoutPin(plain.restricted)).toBe(false)
})

test('a PIN turns the block into a challenge — including with "hide" on', () => {
  backend.parental = { hide: false }
  expect(blockedWithoutPin(adult.restricted)).toBe(false)
  expect(needsPin(adult)).toBe(true)
  // Hidden is not unreachable: a device with a PIN has a challenge to raise, so a channel
  // it has folded away is still allowed to reach playback and ask.
  backend.parental = { hide: true }
  expect(blockedWithoutPin(adult.restricted)).toBe(false)
  expect(needsPin(adult)).toBe(true)
})

test('one unlock covers the session', () => {
  backend.parental = { hide: false }
  expect(needsPin(adult)).toBe(true)
  markUnlocked()
  expect(needsPin(adult)).toBe(false)
})

test('backend wrapper: set/clear/hide send the typed messages; verify round-trips', async () => {
  backend.parentalSetPin('1234')
  backend.parentalSetHide(true)
  backend.parentalClear()
  expect(sentMessages().map((m: any) => m.type)).toEqual(['parental-set-pin', 'parental-hide-set', 'parental-clear'])

  const verdict = backend.parentalVerify('1234')
  const sent = sentMessages().find((m: any) => m.type === 'parental-verify')
  expect(sent.pin).toBe('1234')
  workletSays({ type: 'parental-verify', ok: true, tag: sent.tag })
  await expect(verdict).resolves.toBe(true)

  const wrong = backend.parentalVerify('0000')
  const sent2 = sentMessages().filter((m: any) => m.type === 'parental-verify').pop()
  workletSays({ type: 'parental-verify', ok: false, tag: sent2.tag })
  await expect(wrong).resolves.toBe(false)
})

test('settings: "Set PIN…" without a PIN; toggle + change/remove once one exists', async () => {
  const navigation = { reset: jest.fn() } as any
  const tree = await mount(<SettingsScreen navigation={navigation} route={{} as any} />)
  expect(texts(tree).join('\n')).toContain('Set PIN…')
  expect(texts(tree).join('\n')).not.toContain('Hide restricted channels')

  // The worklet reports a PIN now exists (e.g. the setup modal saved one).
  await ReactTestRenderer.act(async () => {
    workletSays({ type: 'prefs', creds: null, favorites: [], parental: { hide: false } })
  })
  const all = texts(tree).join('\n')
  expect(all).toContain('Hide restricted channels')
  expect(all).toContain('Change PIN…')
  expect(all).toContain('Remove PIN…')
  expect(all).not.toContain('Set PIN…')
  expect(backend.parental).toEqual({ hide: false })
})
