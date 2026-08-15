// Runtime service descriptor (S36) — the public keyless flavor's RN plumbing:
// Connect-screen validation + connect→ready→login→persist-on-success sequencing,
// Splash routing (saved service vs first run), and the Settings "Change service…"
// row (runtime flavor only; a baked key never shows it). The worklet side (prefs
// `service` field, engine swap on a different panel key) is worklet/backend code
// covered by its own paths — these tests drive the backend singleton's IPC queue
// exactly like SmoothZappingToggle.test.tsx.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, TextInput } from 'react-native'

// Flavor switch under test control. Everything else in config.ts stays real (the
// local gitignored service.json backs loadServiceDescriptor in jest).
const mockFlavor = { baked: false }
jest.mock('../src/config', () => {
  const actual = jest.requireActual('../src/config')
  return { ...actual, hasBakedKey: () => mockFlavor.baked }
})

// RN's own jest mock for Modal requireActual()s virtualized-lists ESM this preset
// cannot parse — replace it with a visibility-honoring passthrough (ReportSheet
// pattern; Settings mounts the parental PIN modals).
jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: ({ visible, children }: { visible?: boolean; children?: unknown }) => (visible ? children : null)
}))

import { ConnectScreen } from '../src/screens/ConnectScreen'
import { SplashScreen } from '../src/screens/SplashScreen'
import { SettingsScreen } from '../src/screens/SettingsScreen'
import { backend } from '../src/worklet'
import { loadServiceDescriptor } from '../src/config'

const KEY = 'ab'.repeat(32) // 64 hex chars
const OTHER = 'cd'.repeat(32)

function sentMessages (): any[] { return (backend as any).pending }
function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }

function input (tree: RendererInstance, placeholder: string) {
  const found = tree.root.findAllByType(TextInput).find(i => i.props.placeholder === placeholder)
  if (!found) throw new Error(`no input with placeholder "${placeholder}"`)
  return found
}

function pressable (tree: RendererInstance, label: string) {
  const found = tree.root.findAll(n => typeof n.props?.onPress === 'function' &&
    n.findAllByType(Text).some(t => [t.props.children].flat(9).join('') === label))
  if (!found.length) throw new Error(`no pressable labeled "${label}"`)
  return found[0]
}

function texts (tree: RendererInstance): string[] {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join(''))
}

// The backend is a module singleton: a mounted screen keeps its message listener
// until unmounted, so every mount is tracked and torn down between tests (a stale
// ConnectScreen would otherwise answer later tests' login-errors with retries).
const mounted: RendererInstance[] = []
async function mount (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(el) })
  mounted.push(tree)
  return tree
}

beforeEach(() => {
  mockFlavor.baked = false
  sentMessages().length = 0
  backend.creds = null
  backend.service = null
  backend.smoothZapping = null
  backend.prefsLoaded = false
  backend.streams = []
  jest.useRealTimers()
})

afterEach(async () => {
  for (const t of mounted.splice(0)) await ReactTestRenderer.act(() => { t.unmount() })
})

// Connect opens on the PAIRING CODE (12 characters, three groups) — one press
// switches to the 64-hex panel key.
async function useKeyField (tree: RendererInstance) {
  await ReactTestRenderer.act(() => { pressable(tree, 'Enter the 64-character panel key instead').props.onPress() })
}

async function fillAndSubmit (tree: RendererInstance, key: string, user = 'viewer', pass = 'pw') {
  if (!tree.root.findAllByType(TextInput).some(i => i.props.placeholder === 'Panel public key (64 characters)')) await useKeyField(tree)
  await ReactTestRenderer.act(() => { input(tree, 'Panel public key (64 characters)').props.onChangeText(key) })
  await ReactTestRenderer.act(() => { input(tree, 'Username').props.onChangeText(user) })
  await ReactTestRenderer.act(() => { input(tree, 'Password').props.onChangeText(pass) })
  await ReactTestRenderer.act(() => { pressable(tree, 'Connect').props.onPress() })
}

// The three code groups, in order.
function codeGroups (tree: RendererInstance) {
  return tree.root.findAllByType(TextInput).filter(i => i.props.placeholder === '––––')
}

async function typeCode (tree: RendererInstance, code: string, user = 'viewer', pass = 'pw') {
  const groups = codeGroups(tree)
  for (let i = 0; i < groups.length; i++) {
    await ReactTestRenderer.act(() => { groups[i].props.onChangeText(code.slice(i * 4, i * 4 + 4)) })
  }
  await ReactTestRenderer.act(() => { input(tree, 'Username').props.onChangeText(user) })
  await ReactTestRenderer.act(() => { input(tree, 'Password').props.onChangeText(pass) })
  await ReactTestRenderer.act(() => { pressable(tree, 'Connect').props.onPress() })
}

// Answer the pair-resolve the screen just sent (tagged, as resolvePairing() expects).
// Async act: resolvePairing() settles a promise, so the screen's state lands a
// microtask later — a sync act would leave it outside React's batch.
async function pairAnswer (answer: Record<string, unknown>) {
  const req = sentMessages().filter(x => x.type === 'pair-resolve').pop()
  if (!req) throw new Error('no pair-resolve was sent')
  await ReactTestRenderer.act(async () => { workletSays({ type: 'pair-result', ...answer, tag: req.tag }) })
}

// Stub for SplashScreen mounts: replace() is the exit the assertions watch; the rest
// exist because the screen registers a focus listener on mount and provisional
// routing navigates/resets. (ConnectScreen stubs stay bare — it only replaces.)
function splashNav () {
  return {
    replace: jest.fn(),
    navigate: jest.fn(),
    dispatch: jest.fn(),
    addListener: jest.fn(() => () => {})
  } as any
}

test('Connect rejects a malformed panel key without touching the worklet', async () => {
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<ConnectScreen navigation={navigation} route={{} as any} />)

  await fillAndSubmit(tree, 'not-a-key')
  expect(texts(tree).some(t => t.includes('64 characters'))).toBe(true)
  expect(sentMessages()).toEqual([]) // nothing sent — the key never left the screen
})

test('Connect opens on the pairing code: three groups, filtered and self-advancing', async () => {
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<ConnectScreen navigation={navigation} route={{} as any} />)

  const groups = codeGroups(tree)
  expect(groups).toHaveLength(3)
  expect(groups.every(g => g.props.maxLength === 4)).toBe(true)
  expect(groups[0].props.hasTVPreferredFocus).toBe(true) // the remote lands here

  // Typing is folded to the alphabet: lowercase up, O -> 0, I/L -> 1, separators
  // dropped — a viewer reading a printed card gets the character they expect.
  await ReactTestRenderer.act(() => { groups[0].props.onChangeText('a-o il') })
  expect(codeGroups(tree)[0].props.value).toBe('A011')
  // U is not in Crockford base32, so the field never accepts it.
  await ReactTestRenderer.act(() => { groups[1].props.onChangeText('9uqf') })
  expect(codeGroups(tree)[1].props.value).toBe('9QF')
})

test('Connect resolves a pairing code, then runs the ordinary connect -> login flow', async () => {
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<ConnectScreen navigation={navigation} route={{} as any} />)

  await typeCode(tree, 'A3K79QF2M4XR')
  // The code goes to the engine; the panel key is not known to the screen yet.
  expect(sentMessages()).toEqual([expect.objectContaining({ type: 'pair-resolve', code: 'A3K79QF2M4XR' })])
  expect(sentMessages().some(m => m.panelPubKey)).toBe(false)

  // The engine answers with the VERIFIED key + the operator's own service name.
  await pairAnswer({ ok: true, panelPubKey: KEY, name: 'Nice Operator TV' })
  expect(sentMessages().filter(m => m.panelPubKey).pop()).toEqual(expect.objectContaining({ panelPubKey: KEY }))

  // From here it is the same sequence a typed key takes — and the persisted service
  // carries the name the operator's panel gave, not the build's.
  await ReactTestRenderer.act(() => { workletSays({ type: 'ready' }) })
  await ReactTestRenderer.act(() => { workletSays({ type: 'streams', streams: [] }) })
  expect(sentMessages()).toEqual(expect.arrayContaining([
    { type: 'service-save', service: { panelPubKey: KEY, name: 'Nice Operator TV' } },
    { type: 'creds-save', username: 'viewer', password: 'pw' }
  ]))
  expect(navigation.replace).toHaveBeenCalledWith('Menu')
})

test('Connect never connects on a pairing code the engine could not verify', async () => {
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<ConnectScreen navigation={navigation} route={{} as any} />)

  // An incomplete code fails on the screen — nothing is sent anywhere.
  await typeCode(tree, 'A3K79QF2')
  expect(texts(tree).some(t => t.includes('12 characters'))).toBe(true)
  expect(sentMessages()).toEqual([])

  // A peer answered but could not prove it owns the code: say so, and do NOT dial it.
  await typeCode(tree, 'A3K79QF2M4XR')
  await pairAnswer({ ok: false, error: 'unverified' })
  expect(texts(tree).some(t => t.includes('could not prove it owns it'))).toBe(true)
  expect(sentMessages().some(m => m.panelPubKey)).toBe(false)

  // Nobody answered at all: a different message, still no connect.
  await typeCode(tree, 'A3K79QF2M4XR')
  await pairAnswer({ ok: false, error: 'timeout' })
  expect(texts(tree).some(t => t.includes('No service answered'))).toBe(true)
  expect(sentMessages().some(m => m.panelPubKey)).toBe(false)
  expect(navigation.replace).not.toHaveBeenCalled()
})

test('Connect sequences connect -> ready -> login and persists ONLY on success', async () => {
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<ConnectScreen navigation={navigation} route={{} as any} />)

  await fillAndSubmit(tree, ' ' + KEY.toUpperCase() + ' ') // normalized: trimmed + lowercased
  expect(sentMessages()).toEqual([expect.objectContaining({ panelPubKey: KEY })])

  // Login waits for the engine's (possibly re-built) 'ready' — not sent yet.
  expect(sentMessages().some(m => m.username)).toBe(false)
  await ReactTestRenderer.act(() => { workletSays({ type: 'ready' }) })
  expect(sentMessages()).toEqual(expect.arrayContaining([{ username: 'viewer', password: 'pw' }]))

  // Nothing persisted while the outcome is open…
  expect(sentMessages().some(m => m.type === 'service-save' || m.type === 'creds-save')).toBe(false)

  // …until the entitlement list proves key+credentials: both persist, then Menu.
  await ReactTestRenderer.act(() => { workletSays({ type: 'streams', streams: [] }) })
  expect(sentMessages()).toEqual(expect.arrayContaining([
    { type: 'service-save', service: { panelPubKey: KEY, name: loadServiceDescriptor().name } },
    { type: 'creds-save', username: 'viewer', password: 'pw' }
  ]))
  expect(navigation.replace).toHaveBeenCalledWith('Menu')
})

test('Connect retries transient errors, surfaces real ones, and can re-submit a new key', async () => {
  jest.useFakeTimers()
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<ConnectScreen navigation={navigation} route={{} as any} />)

  await fillAndSubmit(tree, KEY)
  await ReactTestRenderer.act(() => { workletSays({ type: 'ready' }) })
  const loginsBefore = sentMessages().filter(m => m.username).length

  // Swarm still dialing: quiet retry after the backoff.
  await ReactTestRenderer.act(() => { workletSays({ type: 'login-error', message: 'not connected to panel' }) })
  await ReactTestRenderer.act(() => { jest.advanceTimersByTime(3000) })
  expect(sentMessages().filter(m => m.username).length).toBe(loginsBefore + 1)

  // Real failure: shown, busy released.
  await ReactTestRenderer.act(() => { workletSays({ type: 'login-error', message: 'invalid credentials' }) })
  expect(texts(tree).some(t => t.includes('invalid credentials'))).toBe(true)

  // Corrected key on the same screen: a fresh connect goes out for the NEW panel.
  await fillAndSubmit(tree, OTHER)
  expect(sentMessages().filter(m => m.panelPubKey).pop()).toEqual(expect.objectContaining({ panelPubKey: OTHER }))
})

test('Splash (keyless): no saved service -> Connect; saved service -> connect + auto-login', async () => {
  const navigation = splashNav()
  await mount(<SplashScreen navigation={navigation} route={{} as any} backendReady={false} />)
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [], service: null }) })
  expect(navigation.replace).toHaveBeenCalledWith('Connect')

  // Saved service + saved creds: dial that panel and authorize, no screen change yet.
  const nav2 = splashNav()
  await mount(<SplashScreen navigation={nav2} route={{} as any} backendReady={false} />)
  sentMessages().length = 0
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: { username: 'u', password: 'p' }, favorites: [], service: { panelPubKey: KEY } }) })
  expect(sentMessages()).toEqual(expect.arrayContaining([
    expect.objectContaining({ panelPubKey: KEY }),
    { username: 'u', password: 'p' }
  ]))
  expect(nav2.replace).not.toHaveBeenCalled()
  expect(backend.service).toEqual({ panelPubKey: KEY }) // mirrored for Settings

  // Saved service but no creds: connect, then the normal Login exception path.
  const nav3 = splashNav()
  await mount(<SplashScreen navigation={nav3} route={{} as any} backendReady={false} />)
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [], service: { panelPubKey: KEY } }) })
  expect(nav3.replace).toHaveBeenCalledWith('Login')
})

test('Splash (baked key) ignores any persisted runtime service', async () => {
  mockFlavor.baked = true
  const navigation = splashNav()
  await mount(<SplashScreen navigation={navigation} route={{} as any} backendReady={false} />)
  sentMessages().length = 0
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [], service: { panelPubKey: OTHER } }) })
  expect(sentMessages().some(m => m.panelPubKey)).toBe(false) // no runtime connect — App booted the baked key
  expect(navigation.replace).toHaveBeenCalledWith('Login')
})

test('Settings offers "Change service…" only on the keyless flavor, and it clears both', async () => {
  mockFlavor.baked = true
  const navigation = { reset: jest.fn() } as any
  let tree = await mount(<SettingsScreen navigation={navigation} route={{} as any} />)
  expect(texts(tree).some(t => t === 'Change service…')).toBe(false)

  mockFlavor.baked = false
  backend.service = { panelPubKey: KEY, name: 'Demo' }
  tree = await mount(<SettingsScreen navigation={navigation} route={{} as any} />)
  expect(texts(tree).some(t => t === 'Change service…')).toBe(true)
  expect(texts(tree).some(t => t === KEY.slice(0, 16) + '…')).toBe(true) // runtime key shown

  sentMessages().length = 0
  await ReactTestRenderer.act(() => { pressable(tree, 'Change service…').props.onPress() })
  expect(sentMessages()).toEqual(expect.arrayContaining([{ type: 'service-clear' }, { type: 'creds-clear' }]))
  expect(backend.service).toBeNull()
  expect(navigation.reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Connect' }] })
})
