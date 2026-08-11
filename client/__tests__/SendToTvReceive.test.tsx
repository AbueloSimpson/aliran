// "Play on a TV" — THE RECEIVE HALF. What a television does with a play command that
// arrived from another device on the account.
//
// This is the only route in the app that can name a channel the device's own lists do
// not contain: it resolves the incoming id against the UNFILTERED catalog, because the
// engine deliberately does not tune it for you (sdk/player.js, onPlay) — it hands the
// host a command and the host owes it the same parental gate a local zap goes through.
//
// AND THE GATE HAS TWO CLAUSES, NOT ONE. The rule every player in this repo implements
// is "PIN-gate this channel AND hide it entirely while no PIN is configured on the
// device" (sdk/player.js, docs/build-a-player.md, and parental.ts's own header). On a
// device with NO PIN there is nothing to challenge for — needsPin() answers false, which
// is correct for a channel that can never be reached locally and catastrophic the moment
// something outside the lists names one. The family television is the default
// configuration here: no PIN, so a restricted channel does not exist on that set, and a
// phone that has its own PIN must not be able to put one on it.
//
// The engine's own comment says the same thing from the other side: a host with no PIN
// HIDES restricted channels rather than challenging for them, so `restricted: true` is a
// command it has no defined answer for. The defined answer is: refuse.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'

// The remote command arrives from OUTSIDE the tree, so App routes it through a
// navigation container ref rather than any screen's own prop. That ref is the seam: the
// question every case below asks is whether the television was told to tune.
//
// Both navigation packages are stood in for rather than driven, and neither factory
// reaches for the real one: @react-navigation ships an ESM-only `main` that this jest
// config does not transform, so requireActual() on it does not parse. Nothing is lost —
// what is under test is the DECISION App makes with an incoming command, and the
// navigator is stubbed to mount no screen at all so the decision is all that runs.
const mockNavigate = jest.fn()
jest.mock('@react-navigation/native', () => ({
  NavigationContainer: ({ children }: { children?: unknown }) => children ?? null,
  createNavigationContainerRef: () => ({ current: null, isReady: () => true, navigate: mockNavigate })
}))
jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({ Navigator: () => null, Screen: () => null })
}))
// The two things App does on the same catalog push, neither of which is under test here.
// Both open request/reply round trips whose timers would outlive the suite.
jest.mock('../src/sendToTv', () => ({
  joinRendezvous: jest.fn(async () => true),
  watchPeers: jest.fn(() => () => {})
}))
jest.mock('../src/update', () => ({
  checkForUpdate: jest.fn(async () => {}),
  onUpdateAvailable: jest.fn(() => () => {})
}))

import { backend, type Stream } from '../src/worklet'

// Required after the mocks are registered, and it is src/App — client/App.tsx is the
// react-native template's leftover sample screen, which is what App.test.tsx renders.
const App = require('../src/App').default as React.ComponentType

const PLAIN: Stream = { id: 'news', title: 'News 24' } as Stream
const ADULT: Stream = { id: 'late', title: 'Late Night', restricted: true } as Stream

function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }

let tree: ReactTestRenderer.ReactTestRenderer | null = null
async function bootApp (catalog: Stream[] = [PLAIN, ADULT]) {
  // No worklet. Every message below is injected straight into the binding's own reader, so
  // starting one buys nothing and leaves the app-version probe and the engine's own timers
  // running past the end of the suite.
  jest.spyOn(backend, 'boot').mockResolvedValue(undefined)
  jest.spyOn(backend, 'bootIdle').mockResolvedValue(undefined)
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<App />) })
  // The app boots the binding with debug:true (it ships that way — see worklet.ts), and
  // every message below would then print. Nothing here is asserted from the log.
  ;(backend as unknown as { debug: boolean }).debug = false
  await ReactTestRenderer.act(async () => { workletSays({ type: 'streams', streams: catalog }) })
  mockNavigate.mockClear()
}

/** A command as the ENGINE emits it: `restricted` is read off this device's own catalog
 *  record, never off the wire (sdk/player.js refuses outright when it cannot read one). */
async function remotePlay (info: Record<string, unknown>) {
  await ReactTestRenderer.act(async () => {
    workletSays({ type: 'remote-info', role: 'tv', state: 'play', ...info })
  })
}

beforeEach(() => {
  backend.parental = null // no PIN on this device — the default, and the family TV
  mockNavigate.mockClear()
})
afterEach(async () => {
  if (tree) { const t = tree; tree = null; await ReactTestRenderer.act(async () => t.unmount()) }
  jest.clearAllMocks()
})

// --- the control: the feature still works -------------------------------------------

test('an ordinary channel tunes — the whole point of the feature', async () => {
  await bootApp()
  await remotePlay({ streamId: 'news', restricted: false, title: 'News 24' })
  expect(mockNavigate).toHaveBeenCalledWith('Live', expect.objectContaining({ streamId: 'news' }))
})

test('stop still leaves the channel', async () => {
  await bootApp()
  await ReactTestRenderer.act(async () => {
    workletSays({ type: 'remote-info', role: 'tv', state: 'stop' })
  })
  expect(mockNavigate).toHaveBeenCalledWith('Menu')
})

// --- the gate -----------------------------------------------------------------------

test('NO PIN on this set: a restricted channel is REFUSED, not tuned', async () => {
  await bootApp()
  await remotePlay({ streamId: 'late', restricted: true, title: 'Late Night' })
  // A television that hides a channel must not play it because another device asked.
  // There is no challenge to raise here — hasPin() is false, so the PIN modal has
  // nothing to compare against and falling through means it simply plays.
  expect(mockNavigate).not.toHaveBeenCalled()
})

test('the local catalog record is read too — a command without the flag cannot slip past', async () => {
  await bootApp()
  // An engine older than the `restricted` field on this message, or any future shape
  // that drops it: the record this device holds for that id still says restricted.
  await remotePlay({ streamId: 'late', title: 'Late Night' })
  expect(mockNavigate).not.toHaveBeenCalled()
})

test('PIN configured: the channel routes, and Live raises the challenge', async () => {
  await bootApp()
  await ReactTestRenderer.act(async () => {
    workletSays({ type: 'prefs', creds: null, favorites: [], parental: { hide: false } })
  })
  await remotePlay({ streamId: 'late', restricted: true, title: 'Late Night' })
  // Routing through Live's own param path is what keeps the PIN modal in front of it —
  // the gate this device CAN offer, because a PIN exists to compare against.
  expect(mockNavigate).toHaveBeenCalledWith('Live', expect.objectContaining({ streamId: 'late' }))
})

test('PIN configured and "hide" on: still routed — hidden is not the same as unreachable', async () => {
  await bootApp()
  await ReactTestRenderer.act(async () => {
    workletSays({ type: 'prefs', creds: null, favorites: [], parental: { hide: true } })
  })
  await remotePlay({ streamId: 'late', restricted: true, title: 'Late Night' })
  expect(mockNavigate).toHaveBeenCalledWith('Live', expect.objectContaining({ streamId: 'late' }))
})
