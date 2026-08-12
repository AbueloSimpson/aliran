// HOME, AND BACK AGAIN — the app booting a second time over an engine that never stopped.
//
// Android recreates the ACTIVITY while the process survives: leaving a television app for
// the launcher and coming back to it does exactly this, and so do a locale change and a
// display change. The React root re-runs, the module singletons do NOT — the Bare worklet
// is still running, still connected, still holding the session — and the host calls its
// boot path again. On a TCL Android TV set-top box that produced:
//
//   I ReactNativeJS: Running "AliranClient"
//   E ReactNativeJS: 'worklet boot failed', [Error: Worklet has already been started]
//   I ReactNativeJS: '[backend]', 'prefs'
//
// The third line is the important one: the IPC channel is FINE. Messages still flow. What
// was lost is the one-shot {type:'ready'}, which fired minutes earlier for a listener that
// no longer exists — so the fresh root's `backendReady` stayed false for ever, the sign-in
// button read "Connecting…" and stayed disabled, and only a force-stop cleared it. Every
// television viewer met this, whether or not they ever cast anything.
//
// So the two halves below are one bug, and a fix that only does the first half is the same
// bug wearing a quieter face:
//
//   1  a second boot must not throw
//   2  …and the fresh root must still be TOLD, because nothing will tell it again.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'

// The navigator is stubbed to mount no screen: what is under test is the state the root
// reaches, not what it draws. (@react-navigation ships ESM this jest config does not
// transform, so requireActual() on it does not parse either.)
jest.mock('@react-navigation/native', () => ({
  NavigationContainer: ({ children }: { children?: unknown }) => children ?? null,
  createNavigationContainerRef: () => ({ current: null, isReady: () => true, navigate: jest.fn() })
}))
jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({ Navigator: () => null, Screen: () => null })
}))
jest.mock('../src/sendToTv', () => ({
  joinRendezvous: jest.fn(async () => true),
  watchPeers: jest.fn(() => () => {})
}))
// checkForUpdate() is THE SEAM. App runs it on {type:'ready'} and nowhere else, so it is
// the one place outside a rendered screen where "this root reached ready" is observable
// without a navigator — and it is what the disabled "Connecting…" button was waiting on.
const mockCheckForUpdate = jest.fn(async () => {})
jest.mock('../src/update', () => ({
  checkForUpdate: mockCheckForUpdate,
  onUpdateAvailable: jest.fn(() => () => {})
}))

import b4a from 'b4a'
import { backend, type Stream } from '../src/worklet'

const App = require('../src/App').default as React.ComponentType

const CATALOG: Stream[] = [{ id: 'news', title: 'News 24' } as Stream]
const PANEL_KEY = 'a'.repeat(64)

function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }
async function flush () { for (let i = 0; i < 12; i++) await Promise.resolve() }

/** Put a recorder where the worklet's IPC stream is, and return what the host writes
 *  from now on. The stub IPC swallows writes, so this is the only way to see them. */
function recordSends (): Record<string, any>[] {
  const out: Record<string, any>[] = []
  ;(backend as any).ipc = {
    on () {},
    write (bytes: Uint8Array) {
      // b4a, not String(): the binding writes BYTES, and String() on a Uint8Array
      // renders the byte values with commas between them and parses as nothing.
      for (const line of b4a.toString(bytes).split('\n')) {
        if (line.trim()) { try { out.push(JSON.parse(line)) } catch { /* not ours */ } }
      }
    }
  }
  return out
}

const trees: ReactTestRenderer.ReactTestRenderer[] = []
/** One React root, booted for REAL — no boot() spy, because start() is the thing on
 *  trial. Returns once the app-version probe and the boot it gates have settled. */
async function mountRoot () {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<App />) })
  // boot()/bootIdle() await the native app-version probe before start(); let it land,
  // and let the re-attach's own microtask land with it.
  await ReactTestRenderer.act(async () => { await flush() })
  // The app ships debug:true (worklet.ts), and start() has just turned it back on — every
  // message below would print. Nothing here is asserted off the log.
  ;(backend as unknown as { debug: boolean }).debug = false
  trees.push(tree)
  return tree
}

beforeEach(() => {
  // A VIRGIN BINDING per case. The backend is a module singleton and every test here
  // boots it, so without this the second test in the file would open on an engine the
  // first one left running — and every case after the first would silently be testing
  // the re-attach path instead of choosing to.
  const b = backend as any
  b.started = false
  b.worklet = null
  b.ipc = null
  b.pending = []
  b.engineReady = false
  backend.streams = []
  backend.vod = null
  // The app ships debug:true, and every message below would print. Nothing is asserted
  // off the log here.
  b.debug = false
  mockCheckForUpdate.mockClear()
})
afterEach(async () => {
  while (trees.length) {
    const t = trees.pop()!
    await ReactTestRenderer.act(async () => t.unmount())
  }
  jest.clearAllMocks()
})

// --- 1: the throw ------------------------------------------------------------------

test('a second boot over a live worklet does not throw', async () => {
  await mountRoot()
  // The stub throws on a second worklet.start() the way the native module does — see
  // __mocks__/react-native-bare-kit.js. If the binding passed the call through, this
  // would reject and App's own .catch() would print 'worklet boot failed'.
  await expect(mountRoot()).resolves.toBeDefined()
})

test('the engine is started ONCE — a re-attach re-attaches, it does not re-boot', async () => {
  await mountRoot()
  const worklet = (backend as any).worklet
  expect(worklet.started).toBe(true)
  const start = jest.spyOn(worklet, 'start')
  await mountRoot()
  expect(start).not.toHaveBeenCalled()
})

// The engine is ALREADY on its panel. Re-sending {panelPubKey} re-runs the engine's
// _openPanel(): a second Hyperbee over the same core, a second swarm join, and fresh
// catalog/EPG/grant watchers that ORPHAN the live ones. A re-attach is not a reconnect.
//
// Driven through the binding rather than through App because this app's committed test
// descriptor is the KEYLESS one, so its boot path never passes a panel key at all — and
// the branded builds that do are the ones this would break.
test('a re-attach does not re-connect the engine to its panel', async () => {
  backend.start('', { panelPubKey: PANEL_KEY })
  const wrote = recordSends() // installed after the first start, so only the re-attach shows
  backend.start('', { panelPubKey: PANEL_KEY })
  await flush()
  expect(wrote.some((m) => m.panelPubKey)).toBe(false)
  // …and the one thing it DOES send is the local prefs read (below).
  expect(wrote.map((m) => m.type)).toEqual(['prefs-get'])
})

// --- 2: …and the fresh root is told ------------------------------------------------

test('the fresh root reaches READY, from an event that fired before it existed', async () => {
  await mountRoot()
  await ReactTestRenderer.act(async () => { workletSays({ type: 'ready' }) })
  expect(mockCheckForUpdate).toHaveBeenCalledTimes(1)
  mockCheckForUpdate.mockClear()

  // Android recreates the activity. The engine says nothing — it has nothing left to say.
  await mountRoot()
  // TWO, and the count is the assertion. The old root is deliberately NOT unmounted here
  // (Android destroys it; this test does not, so the harsher case is the one on trial),
  // and the replay reaches every listener there is — so one call would leave it open
  // which root heard it, and two says the FRESH one did.
  expect(mockCheckForUpdate).toHaveBeenCalledTimes(2)
})

test('…and the catalog this session already has comes with it', async () => {
  await mountRoot()
  await ReactTestRenderer.act(async () => {
    workletSays({ type: 'ready' })
    workletSays({ type: 'streams', streams: CATALOG })
  })

  // A listener that did not exist until after the second boot — which is every listener
  // the new root has.
  const seen: string[] = []
  let off = () => {}
  await ReactTestRenderer.act(async () => {
    const p = mountRoot()
    off = backend.onMessage((m) => seen.push(m.type))
    await p
  })
  off()
  expect(seen).toContain('ready')
  expect(seen).toContain('streams')
  expect(backend.streams).toEqual(CATALOG)
})

// Prefs are RE-READ rather than replayed: the worklet owns the file, the read is local
// and cheap, and a host routes its whole first screen off `creds`/`service`/`signinSaved`.
// A mirror of an older answer is the one thing not worth handing back.
test('a re-attach asks the worklet for prefs again', async () => {
  await mountRoot()
  const wrote = recordSends()
  await mountRoot()
  expect(wrote.map((m) => m.type)).toContain('prefs-get')
})

// The replay must not be a SECOND channel. The IPC 'data' handler wired by the first
// start() is still attached to the same stream; a second one would parse every line twice,
// so every reply would fire its listeners twice and every tagged request would race its own
// duplicate — a quieter bug than the one being fixed, and a much longer one to find.
test('the IPC is not wired twice — one engine message is delivered once', async () => {
  await mountRoot()
  await mountRoot()
  const seen: string[] = []
  const off = backend.onMessage((m) => seen.push(m.type))
  workletSays({ type: 'status', state: 'peers' })
  off()
  expect(seen.filter((t) => t === 'status')).toHaveLength(1)
})

// A restart BEFORE the engine ever connected has nothing to replay, and must not invent
// one: 'ready' means the engine is on its panel and will take a login, and a host that is
// told so early logs in against nothing.
test('nothing is replayed before the engine has ever been ready — and the real one still lands', async () => {
  await mountRoot()
  await mountRoot()
  expect(mockCheckForUpdate).not.toHaveBeenCalled()
  await ReactTestRenderer.act(async () => { workletSays({ type: 'ready' }) })
  // Both roots are still mounted, and both hear the genuine event.
  expect(mockCheckForUpdate).toHaveBeenCalledTimes(2)
})
