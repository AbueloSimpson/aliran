// Phone -> TV sign-in, the app half (WP2b) — and above all WHO OWNS THE OUTCOME.
//
// Both screens a device with no session can land on host two doors into the same
// session, and both doors finish on the same worklet message ({type:'streams'}). The
// first two tests here are the two ways that went wrong, and they are the shape of bug
// a mounted-component test catches and nothing else does: each one is an ORDINARY
// sequence (a wrong password, then a phone handover) whose parts are individually
// correct. See client/src/signinPath.ts.
//
// The worklet side (the engine, the rendezvous, the two proofs) is covered by
// test:signin-pair; this suite is the RN plumbing only, driving the backend singleton's
// IPC queue exactly like RuntimeService.test.tsx.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, TextInput, StyleSheet, BackHandler } from 'react-native'

import { ConnectScreen } from '../src/screens/ConnectScreen'
import { LoginScreen } from '../src/screens/LoginScreen'
import { SendSignInToTv } from '../src/components/SendSignInToTv'
import { backend } from '../src/worklet'

// The service the viewer typed and got refused, and the one the phone handed over. They
// differ on purpose: that difference is the whole bug.
const TYPED = 'ab'.repeat(32)
const ADOPTED = 'cd'.repeat(32)

function sentMessages (): any[] { return (backend as any).pending }
function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }

function input (tree: RendererInstance, placeholder: string) {
  const found = tree.root.findAllByType(TextInput).find(i => i.props.placeholder === placeholder)
  if (!found) throw new Error(`no input with placeholder "${placeholder}"`)
  return found
}

function pressables (tree: RendererInstance, label: string) {
  return tree.root.findAll(n => typeof n.props?.onPress === 'function' &&
    n.findAllByType(Text).some(t => [t.props.children].flat(9).join('') === label))
}

function pressable (tree: RendererInstance, label: string) {
  const found = pressables(tree, label)
  if (!found.length) throw new Error(`no pressable labeled "${label}"`)
  return found[0]
}

// The innermost match — the <Pressable> itself rather than the Button wrapper around it,
// which is the node that carries the styling.
function styleOf (tree: RendererInstance, label: string) {
  const found = pressables(tree, label).filter(n => n.props.style !== undefined)
  if (!found.length) throw new Error(`no styled pressable labeled "${label}"`)
  return StyleSheet.flatten(found[found.length - 1].props.style)
}

function texts (tree: RendererInstance): string[] {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join(''))
}

async function press (tree: RendererInstance, label: string) {
  await ReactTestRenderer.act(async () => { pressable(tree, label).props.onPress() })
}

// Answer the newest tagged request of `requestType` with `{type: replyType, ...body}`.
// Async act: the binding resolves a promise, so the screen's state lands a microtask
// later — a sync act would leave it outside React's batch.
async function answer (requestType: string, replyType: string, body: Record<string, unknown> = {}) {
  const req = sentMessages().filter(x => x.type === requestType).pop()
  if (!req) throw new Error(`no ${requestType} was sent`)
  await ReactTestRenderer.act(async () => { workletSays({ type: replyType, ...body, tag: req.tag }) })
}

async function pairEvent (info: Record<string, unknown>) {
  await ReactTestRenderer.act(async () => { workletSays({ type: 'signin-pair', ...info }) })
}

const mounted: RendererInstance[] = []
async function mount (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(el) })
  mounted.push(tree)
  return tree
}

beforeEach(() => {
  sentMessages().length = 0
  backend.creds = null
  backend.service = null
  backend.streams = []
  backend.signinTv = null
  backend.signinPhone = null
  jest.useRealTimers()
})

afterEach(async () => {
  for (const t of mounted.splice(0)) await ReactTestRenderer.act(() => { t.unmount() })
})

// Walk the TV half from a fresh code to "this device is signed in", adopting ADOPTED.
// Stops just before the viewer presses OK, because everything interesting happens
// between 'streams' and that press.
async function handoverToSignedIn (tree: RendererInstance) {
  await press(tree, 'Sign in with your phone')
  await answer('signin-start', 'signin-started', { ok: true, code: 'A3K79QF2M4XR', expiresAt: Date.now() + 60000 })
  await pairEvent({ role: 'tv', state: 'code', code: 'A3K79QF2M4XR', expiresAt: Date.now() + 60000 })
  await pairEvent({ role: 'tv', state: 'match', sas: '4821' })
  await pairEvent({ role: 'tv', state: 'pin-entry', sas: '4821' })
  // The viewer keys the phone's digits in and the engine accepts them.
  for (const d of ['7', '3', '9', '1']) await press(tree, d)
  await press(tree, 'OK')
  await answer('signin-submit-pin', 'signin-ack', { ok: true })
  // The operator-key question — the key the PHONE brought, not the one typed above.
  await pairEvent({ role: 'tv', state: 'confirm-service', adopting: true, panelPubKey: ADOPTED, pairingCode: 'A3K7-9QF2-M4XR', username: 'viewer' })
  await press(tree, 'Yes, sign in')
  await answer('signin-confirm-service', 'signin-ack', { ok: true })
}

// --- B1: Connect ---------------------------------------------------------------------

test('Connect: a refused manual attempt does not persist itself when a handover succeeds', async () => {
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<ConnectScreen navigation={navigation} route={{} as any} />)

  // An ordinary bad first try: the right shape of key, the wrong password.
  await press(tree, 'Enter the 64-character panel key instead')
  await ReactTestRenderer.act(() => { input(tree, 'Panel public key (64 characters)').props.onChangeText(TYPED) })
  await ReactTestRenderer.act(() => { input(tree, 'Username').props.onChangeText('viewer') })
  await ReactTestRenderer.act(() => { input(tree, 'Password').props.onChangeText('wrong-password') })
  await press(tree, 'Connect')
  await ReactTestRenderer.act(() => { workletSays({ type: 'ready' }) })
  await ReactTestRenderer.act(() => { workletSays({ type: 'login-error', message: 'invalid credentials' }) })
  expect(texts(tree).some(t => t.includes('invalid credentials'))).toBe(true)
  expect(sentMessages().some(m => m.type === 'service-save' || m.type === 'creds-save')).toBe(false)

  // The viewer gives up on typing and uses a phone instead.
  await handoverToSignedIn(tree)

  // THE MOMENT. _applySignIn fires 'streams' BEFORE the 'signed-in' state, and the
  // refused attempt's key and password are still sitting in the form. Neither may move.
  await ReactTestRenderer.act(() => { workletSays({ type: 'streams', streams: [] }) })
  expect(sentMessages().some(m => m.type === 'service-save')).toBe(false)
  expect(sentMessages().some(m => m.type === 'creds-save')).toBe(false)
  // And the panel is still up to say so — navigating here is what used to stop the
  // adopted key from ever being saved.
  expect(navigation.replace).not.toHaveBeenCalled()

  await pairEvent({ role: 'tv', state: 'signed-in', username: 'viewer' })
  expect(texts(tree).some(t => t === 'This device is signed in.')).toBe(true)
  await press(tree, 'OK')

  // The service that gets persisted is the one the phone ADOPTED, and a handover leaves
  // no credentials behind at all.
  expect(sentMessages().filter(m => m.type === 'service-save')).toEqual([
    { type: 'service-save', service: { panelPubKey: ADOPTED, name: expect.any(String) } }
  ])
  expect(sentMessages().some(m => m.type === 'service-save' && m.service.panelPubKey === TYPED)).toBe(false)
  expect(sentMessages().some(m => m.type === 'creds-save')).toBe(false)
  expect(navigation.replace).toHaveBeenCalledWith('Menu')
})

test('Connect: the manual door still persists both values on its own success', async () => {
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<ConnectScreen navigation={navigation} route={{} as any} />)

  await press(tree, 'Enter the 64-character panel key instead')
  await ReactTestRenderer.act(() => { input(tree, 'Panel public key (64 characters)').props.onChangeText(TYPED) })
  await ReactTestRenderer.act(() => { input(tree, 'Username').props.onChangeText('viewer') })
  await ReactTestRenderer.act(() => { input(tree, 'Password').props.onChangeText('pw') })
  await press(tree, 'Connect')
  await ReactTestRenderer.act(() => { workletSays({ type: 'ready' }) })
  await ReactTestRenderer.act(() => { workletSays({ type: 'streams', streams: [] }) })

  expect(sentMessages()).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'service-save', service: expect.objectContaining({ panelPubKey: TYPED }) }),
    { type: 'creds-save', username: 'viewer', password: 'pw' }
  ]))
  expect(navigation.replace).toHaveBeenCalledWith('Menu')
})

// --- B2: Login -----------------------------------------------------------------------

test('Login: a refused password is not written to prefs when a handover succeeds', async () => {
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<LoginScreen navigation={navigation} route={{} as any} backendReady />)

  await ReactTestRenderer.act(() => { input(tree, 'Username').props.onChangeText('viewer') })
  await ReactTestRenderer.act(() => { input(tree, 'Password').props.onChangeText('typo') })
  await press(tree, 'Sign in')
  await ReactTestRenderer.act(() => { workletSays({ type: 'login-error', message: 'invalid credentials' }) })
  expect(texts(tree).some(t => t.includes('invalid credentials'))).toBe(true)

  await handoverToSignedIn(tree)
  await ReactTestRenderer.act(() => { workletSays({ type: 'streams', streams: [] }) })

  // The dead password stays dead. Writing it here left it in the prefs file in plain
  // text and failed every auto-login from the next boot on.
  expect(sentMessages().some(m => m.type === 'creds-save')).toBe(false)
  expect(navigation.replace).not.toHaveBeenCalled()

  await pairEvent({ role: 'tv', state: 'signed-in', username: 'viewer' })
  await press(tree, 'OK')
  expect(sentMessages().some(m => m.type === 'creds-save')).toBe(false)
  expect(navigation.replace).toHaveBeenCalledWith('Menu')
})

test('Login: the password door still saves the credentials that worked', async () => {
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<LoginScreen navigation={navigation} route={{} as any} backendReady />)

  await ReactTestRenderer.act(() => { input(tree, 'Username').props.onChangeText('viewer') })
  await ReactTestRenderer.act(() => { input(tree, 'Password').props.onChangeText('pw') })
  await press(tree, 'Sign in')
  await ReactTestRenderer.act(() => { workletSays({ type: 'streams', streams: [] }) })

  expect(sentMessages()).toEqual(expect.arrayContaining([
    { type: 'creds-save', username: 'viewer', password: 'pw' }
  ]))
  expect(navigation.replace).toHaveBeenCalledWith('Menu')
})

// The other half of the ownership rule: a door that is still in flight keeps it.
test('Login: a transient error retries with the door that owns the outcome', async () => {
  jest.useFakeTimers()
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<LoginScreen navigation={navigation} route={{} as any} backendReady />)

  await ReactTestRenderer.act(() => { input(tree, 'Username').props.onChangeText('viewer') })
  await ReactTestRenderer.act(() => { input(tree, 'Password').props.onChangeText('pw') })
  await press(tree, 'Sign in')
  const before = sentMessages().filter(m => m.username).length

  await ReactTestRenderer.act(() => { workletSays({ type: 'login-error', message: 'not connected to panel' }) })
  await ReactTestRenderer.act(() => { jest.advanceTimersByTime(3000) })
  expect(sentMessages().filter(m => m.username).length).toBe(before + 1)
  expect(sentMessages().filter(m => m.username).pop()).toEqual({ username: 'viewer', password: 'pw' })
})

// --- the phone half ------------------------------------------------------------------

test('the phone confirm step aborts on "no", and neither answer is weighted', async () => {
  const onClose = jest.fn()
  const tree = await mount(<SendSignInToTv onClose={onClose} />)

  const groups = tree.root.findAllByType(TextInput).filter(i => i.props.placeholder === '––––')
  expect(groups).toHaveLength(3)
  for (let i = 0; i < groups.length; i++) {
    await ReactTestRenderer.act(() => { groups[i].props.onChangeText('A3K79QF2M4XR'.slice(i * 4, i * 4 + 4)) })
  }
  await press(tree, 'OK')
  await answer('signin-send', 'signin-sending', { ok: true })
  await pairEvent({ role: 'phone', state: 'match', sas: '4821' })
  expect(texts(tree).some(t => t === '4821')).toBe(true)

  // NEITHER button carries the accent border. This is the one step whose purpose is
  // making "no" easy to give, so nothing may point at "yes".
  expect(styleOf(tree, 'Yes, they agree').borderColor)
    .toBe(styleOf(tree, 'No, they are different').borderColor)

  await press(tree, 'No, they are different')
  expect(sentMessages().filter(m => m.type === 'signin-confirm-match')).toEqual([
    expect.objectContaining({ type: 'signin-confirm-match', ok: false })
  ])
  await answer('signin-confirm-match', 'signin-ack', { ok: true })
  // A second press at this step must not be able to mean anything.
  expect(pressables(tree, 'Yes, they agree')).toHaveLength(0)
})

test('a refused start offers a new code, not only a way out', async () => {
  const tree = await mount(<LoginScreen navigation={{ replace: jest.fn() } as any} route={{} as any} backendReady />)
  await press(tree, 'Sign in with your phone')
  // The likeliest refusal: cancel, then re-open before the engine let go of the handle.
  await answer('signin-start', 'signin-started', { ok: false, message: 'a sign-in code is already showing on this device' })

  // Catalog copy, never the engine's sentence — see signinFailure.ts.
  expect(texts(tree).some(t => t === 'The sign-in did not finish. Start again with a new code.')).toBe(true)
  expect(texts(tree).some(t => t.includes('already showing on this device'))).toBe(false)

  const starts = sentMessages().filter(m => m.type === 'signin-start').length
  await press(tree, 'Show a new code')
  // The stale code is cancelled first (the effect's cleanup), then a fresh one is asked
  // for — which is the recovery the viewer was previously left to guess.
  expect(sentMessages().some(m => m.type === 'signin-cancel')).toBe(true)
  expect(sentMessages().filter(m => m.type === 'signin-start').length).toBe(starts + 1)

  // …and the fresh code paints, so this is a way ON, not a second dead end.
  await answer('signin-start', 'signin-started', { ok: true, code: 'M4XRA3K79QF2', expiresAt: Date.now() + 60000 })
  await pairEvent({ role: 'tv', state: 'code', code: 'M4XRA3K79QF2', expiresAt: Date.now() + 60000 })
  expect(texts(tree).some(t => t === 'M4XRA3K79QF2')).toBe(true)
})

// --- B6: what a REMOTE can reach, measured on a TCL set-top box -----------------------
//
// Both of these were found by a viewer, not by a reviewer, and they compound: the first
// leaves you needing a way out of the PIN screen, and the second makes the only way out
// throw you clean out of the app with the code already spent.

test('the OK button is out of the D-pad path until the PIN is complete', async () => {
  const navigation = { replace: jest.fn() } as any
  const tree = await mount(<LoginScreen navigation={navigation} route={{} as any} backendReady />)

  await press(tree, 'Sign in with your phone')
  await answer('signin-start', 'signin-started', { ok: true, code: 'A3K79QF2M4XR', expiresAt: Date.now() + 60000 })
  await pairEvent({ role: 'tv', state: 'code', code: 'A3K79QF2M4XR', expiresAt: Date.now() + 60000 })
  await pairEvent({ role: 'tv', state: 'pin-entry', sas: '4821' })

  // Part-way through: `disabled` used to reach the style and the handler but never the
  // Pressable, so the D-pad landed on a lit-up OK that did nothing and the viewer was
  // stuck. Focusability is the property that matters here — a dead control the remote
  // cannot reach is fine; one it CAN reach is the bug.
  // Found by accessibilityLabel, NOT by the suite's pressables(): that helper keys on
  // onPress being a function, and a properly disabled button no longer has one — so it
  // cannot see the very state under test. (It failing to find the button IS the fix
  // working, which is a confusing way to read a test.)
  const ok = () => tree.root.findAll(n => n.props?.accessibilityLabel === 'OK' && n.props?.focusable !== undefined).pop()!

  // Asserted on `focusable` and accessibilityState, NOT on a `disabled` prop: Pressable
  // consumes `disabled` and forwards its EFFECT, so the host node never carries the name.
  // focusable:false is the thing a remote obeys, which makes it the thing worth pinning.
  for (const d of ['7', '3']) await press(tree, d)
  expect(ok().props.focusable).toBe(false)
  expect(ok().props.accessibilityState).toMatchObject({ disabled: true })

  // Completed, it is a real control again.
  for (const d of ['9', '1']) await press(tree, d)
  expect(ok().props.focusable).toBe(true)
  expect(ok().props.accessibilityState).toMatchObject({ disabled: false })
})

test('BACK closes the sign-in overlay instead of closing the app', async () => {
  const handlers: Array<() => boolean> = []
  const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_e: string, h: () => boolean) => {
    handlers.push(h)
    return { remove () {} }
  }) as any)
  try {
    const navigation = { replace: jest.fn() } as any
    const tree = await mount(<LoginScreen navigation={navigation} route={{} as any} backendReady />)

    await press(tree, 'Sign in with your phone')
    await answer('signin-start', 'signin-started', { ok: true, code: 'A3K79QF2M4XR', expiresAt: Date.now() + 60000 })
    await pairEvent({ role: 'tv', state: 'code', code: 'A3K79QF2M4XR', expiresAt: Date.now() + 60000 })
    expect(texts(tree).some(t => t === 'A3K79QF2M4XR')).toBe(true)
    expect(handlers).toHaveLength(1)

    // Returning true is the whole point: unhandled, the key reaches the activity and the
    // television drops the viewer at its launcher, mid-exchange.
    let handled: boolean | undefined
    await ReactTestRenderer.act(async () => { handled = handlers[0]() })
    expect(handled).toBe(true)

    // Same outcome as Cancel: the overlay is gone and the spent code went with it.
    expect(texts(tree).some(t => t === 'A3K79QF2M4XR')).toBe(false)
    expect(sentMessages().some(m => m.type === 'signin-cancel')).toBe(true)
  } finally {
    spy.mockRestore()
  }
})
