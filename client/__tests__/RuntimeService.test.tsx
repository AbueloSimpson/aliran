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

async function fillAndSubmit (tree: RendererInstance, key: string, user = 'viewer', pass = 'pw') {
  await ReactTestRenderer.act(() => { input(tree, 'Panel public key (64 characters)').props.onChangeText(key) })
  await ReactTestRenderer.act(() => { input(tree, 'Username').props.onChangeText(user) })
  await ReactTestRenderer.act(() => { input(tree, 'Password').props.onChangeText(pass) })
  await ReactTestRenderer.act(() => { pressable(tree, 'Connect').props.onPress() })
}

test('Connect rejects a malformed panel key without touching the worklet', async () => {
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<ConnectScreen navigation={navigation} route={{} as any} />)

  await fillAndSubmit(tree, 'not-a-key')
  expect(texts(tree).some(t => t.includes('64 characters'))).toBe(true)
  expect(sentMessages()).toEqual([]) // nothing sent — the key never left the screen
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
  const navigation = { replace: jest.fn() } as any
  await mount(<SplashScreen navigation={navigation} route={{} as any} backendReady={false} />)
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [], service: null }) })
  expect(navigation.replace).toHaveBeenCalledWith('Connect')

  // Saved service + saved creds: dial that panel and authorize, no screen change yet.
  const nav2 = { replace: jest.fn() } as any
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
  const nav3 = { replace: jest.fn() } as any
  await mount(<SplashScreen navigation={nav3} route={{} as any} backendReady={false} />)
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [], service: { panelPubKey: KEY } }) })
  expect(nav3.replace).toHaveBeenCalledWith('Login')
})

test('Splash (baked key) ignores any persisted runtime service', async () => {
  mockFlavor.baked = true
  const navigation = { replace: jest.fn() } as any
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
