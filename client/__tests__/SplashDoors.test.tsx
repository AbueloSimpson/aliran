// The two doors of SplashScreen — the kept phone -> TV sign-in ("restore") and the saved
// password ("saved") — and the thing that decides how long a viewer stares at a spinner:
// their RETRY BUDGETS.
//
// This is the layer WP2c shipped with no tests at all, and it is where all three of its
// defects lived. None of them is visible from the worklet lane or from test:signin-resume,
// which starts at signInWithKeys() and never enters the app:
//
//   B1  one budget of 24 tries × 2.5 s was written for the PASSWORD door, where a failure
//       comes back in milliseconds. The restore door's failure comes back after the
//       worklet has dialled for 25 s, so the same 24 tries were ELEVEN MINUTES of
//       "Authorizing device" on an offline television with nothing on screen to press.
//   B2  both doors incremented the SAME counter. A set holding a kept sign-in AND a saved
//       password, booting offline, spent the whole budget on the restore door, fell
//       through to the password door with nothing left, and dropped to the sign-in screen
//       on its first transient — having never once tried the password it had.
//   B3  the fix for B1 made the restore door's budget a DEADLINE, and a deadline counts
//       seconds while the panel counts logins. 45 s buys two attempts when each one dials
//       for 25 s — and nineteen when each one comes back fast. A television whose account
//       record has not replicated spent 3 logins per attempt, 18 in a boot, and locked
//       ITSELF out of a panel that tolerates 10 — after which 'login failed: locked' came
//       back in 20 ms, so the loop ACCELERATED. The set then showed a login screen a
//       viewer with the right password could not get through for fifteen minutes.
//
// All three are timing properties, so the clock is faked and every wait is spent
// explicitly. The worklet is not mocked: the real backend singleton is driven through its
// IPC queue, as in RuntimeService.test.tsx.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'

// A baked-key build, so Splash never takes the Connect branch and the prefs reply decides
// the door on its own.
jest.mock('../src/config', () => {
  const actual = jest.requireActual('../src/config')
  return { ...actual, hasBakedKey: () => true }
})

import { SplashScreen } from '../src/screens/SplashScreen'
import { backend } from '../src/worklet'

// The screen's own constants, restated here so a change to either has to be a deliberate
// edit in two places rather than a silent re-tuning of the budget.
const RETRY_MS = 2500
const RESTORE_BUDGET_MS = 45000
const LOGIN_MAX_RETRIES = 24
// What one restore attempt COSTS IN TIME. resumeSignIn() loops inside the worklet on 'not
// connected to panel' for RESUME_CONNECT_MS before it answers retry:true, so an offline
// device pays this every single time (client/backend/backend.mjs).
const WORKLET_DIAL_MS = 25000

// …and what an attempt costs THE PANEL, which is the other currency entirely and the one
// B3 was denominated in wrongly. panel/src/rpc.js counts every `login` against
// (username|peer) — the ones that succeed too — and refuses past LOCKOUT_THRESHOLD
// (panel/src/config.js: 10) for LOCKOUT_SECONDS (900). The peer half is the engine's
// Hyperswarm key, random per instance, so a set locks out only itself and only for this app
// process — and what it locks out is its own password fall-through, seconds later, in front
// of a viewer holding the right password.
const PANEL_LOCKOUT_THRESHOLD = 10
// The most logins ONE resume can spend: client/backend/backend.mjs RESUME_RECORD_TRIES,
// the bounded retry for an account record that has not replicated yet. The screen does not
// know this number and must not need to — see the door rule asserted below.
const RESUME_RECORD_TRIES = 3
// The two shapes of a PAYING resume, measured against a real panel at production
// proof-of-work difficulty:
//   the record has not replicated  3 logins, 3 s apart, ~6.2 s per resume
//   the account is already locked  1 login, back in ~20 ms — which is what made the
//                                  broken loop accelerate rather than slow down
const UNREPLICATED_MS = 6200
const LOCKED_MS = 20

type Sent = Record<string, unknown>
const sent = (): Sent[] => (backend as unknown as { pending: Sent[] }).pending
const workletSays = (msg: unknown) => (backend as unknown as { onData (s: string): void }).onData(JSON.stringify(msg) + '\n')
const resumes = (): Sent[] => sent().filter(m => m.type === 'signin-resume')
const logins = (): Sent[] => sent().filter(m => typeof m.username === 'string' && typeof m.password === 'string')

const mounted: RendererInstance[] = []
async function mount (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(el) })
  mounted.push(tree)
  return tree
}
// Advance the clock and let every promise the screen is holding settle.
async function tick (ms: number) {
  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(ms) })
}
async function flush () { await ReactTestRenderer.act(async () => {}) }

beforeEach(() => {
  jest.useFakeTimers()
  sent().length = 0
  backend.creds = null
  backend.signinSaved = false
  backend.prefsLoaded = false
  backend.streams = []
})

afterEach(async () => {
  for (const t of mounted.splice(0)) await ReactTestRenderer.act(() => { t.unmount() })
  jest.useRealTimers()
})

/** Answer the resume the screen is waiting on, as the worklet would (tagged). */
async function answerResume (answer: Record<string, unknown>) {
  const req = resumes().pop()
  if (!req) throw new Error('the screen is not waiting on a resume')
  await ReactTestRenderer.act(async () => { workletSays({ type: 'signin-resumed', ...answer, tag: req.tag }) })
}

/** Boot the screen with the prefs a television that a phone signed in would have. */
async function boot (prefs: { signinSaved?: boolean; creds?: { username: string; password: string } | null }) {
  const navigation = { replace: jest.fn() } as unknown as React.ComponentProps<typeof SplashScreen>['navigation']
  await mount(<SplashScreen navigation={navigation} route={{} as never} backendReady={false} />)
  await ReactTestRenderer.act(async () => {
    workletSays({ type: 'prefs', creds: prefs.creds ?? null, favorites: [], service: null, signinSaved: prefs.signinSaved === true })
  })
  return navigation as unknown as { replace: jest.Mock }
}

/**
 * Run the restore door to its end against ONE failure mode, and add up what that boot
 * cost the panel.
 *
 * @param answer  the 'signin-resumed' the worklet would send. `logins` is the field that
 *                carries the cost across the IPC boundary; omit it to play an answer the
 *                worklet never sent — the RN-side timeout, whose cost is unknowable.
 * @param costMs  how long the worklet takes to produce it.
 * @returns how many resumes were attempted, how many PANEL LOGINS they spent between
 *          them, and how long the door took.
 */
async function runRestore (
  nav: { replace: jest.Mock },
  answer: Record<string, unknown>,
  costMs: number,
  cap = 60
) {
  const started = Date.now()
  let attempts = 0
  let spent = 0
  for (let i = 0; i < cap; i++) {
    // Nothing is ever removed from the queue, so a new attempt is a LONGER queue.
    if (resumes().length <= attempts) break
    attempts++
    if (costMs) await tick(costMs)
    spent += typeof answer.logins === 'number' ? answer.logins : 0
    await answerResume(answer)
    // The door is finished when it routes, or when it hands over to the password door.
    if (nav.replace.mock.calls.length || logins().length) break
    await tick(RETRY_MS)
    await flush()
  }
  return { attempts, spent, elapsed: Date.now() - started }
}

/**
 * Play the offline television: every resume is answered retry:true, but only after the
 * worklet has spent WORKLET_DIAL_MS dialling — which is the cost in TIME the budget has
 * to be written against. It costs the panel nothing: 'not connected to panel' is thrown
 * before any RPC leaves the device, which is exactly why `logins` is 0 here.
 */
const runRestoreOffline = (nav: { replace: jest.Mock }) =>
  runRestore(nav, { ok: false, error: 'offline', retry: true, logins: 0, message: 'not connected to panel' }, WORKLET_DIAL_MS, 40)

test('B1: an offline restore gives up in about a minute, not eleven', async () => {
  const nav = await boot({ signinSaved: true, creds: null })
  expect(resumes()).toHaveLength(1) // the kept sign-in goes first

  const { attempts, elapsed } = await runRestoreOffline(nav)

  // The shipped bug: 24 attempts × (25 s of dialling + 2.5 s of waiting) ≈ 11 minutes.
  // The budget is a DEADLINE now, so what is asserted is the wall clock, not a count.
  expect(elapsed).toBeLessThanOrEqual(RESTORE_BUDGET_MS + WORKLET_DIAL_MS + RETRY_MS)
  expect(elapsed).toBeLessThan(120000)
  // …and, as a consequence rather than as the rule, only a couple of attempts.
  expect(attempts).toBeLessThanOrEqual(3)
  expect(attempts).toBeGreaterThanOrEqual(2) // one attempt would be too eager on a cold DHT

  // Nothing left to try: no saved password, so the sign-in screen — but reached in under a
  // minute, which is the whole point.
  expect(nav.replace).toHaveBeenCalledWith('Login')
})

test('B1: the deadline is measured over the door, not reset by each attempt', async () => {
  const nav = await boot({ signinSaved: true, creds: null })
  // An attempt that answers INSTANTLY and costs the panel NOTHING (no engine yet, or a key
  // store that did not answer) must not be able to run for ever just because each try is
  // cheap — but the deadline is the right bound for it, because nothing but the viewer's
  // patience is being spent.
  const { attempts, spent, elapsed } = await runRestore(
    nav, { ok: false, error: 'offline', retry: true, logins: 0 }, 0, 200
  )
  expect(elapsed).toBeLessThanOrEqual(RESTORE_BUDGET_MS + RETRY_MS)
  expect(attempts).toBeLessThanOrEqual(Math.ceil(RESTORE_BUDGET_MS / RETRY_MS) + 1)
  // THE ASSERTION THAT WAS MISSING, and its absence is what let B3 through: the bound above
  // is nineteen attempts, and nineteen attempts is fine ONLY because these ones are free.
  expect(spent).toBe(0)
  expect(nav.replace).toHaveBeenCalledWith('Login')
})

// --- B3: the budget the panel is actually keeping ---------------------------------------
//
// The rule these three assert is one line and does not name a number: AN ATTEMPT THAT
// REACHED THE PANEL ENDS THIS DOOR. Free attempts keep the deadline they always had.
// The screen therefore never has to know how many logins a resume can spend — only whether
// this one spent any — and the boot ceiling is whatever the worklet's own per-resume cap
// is, which is where that number belongs.

test('B3: the record has not replicated — one boot, one paying resume, never a lockout', async () => {
  const nav = await boot({ signinSaved: true, creds: null })
  // Exactly the case the bounded retry was ADDED for, and the case that reproduced the
  // lockout against a real panel: the bee replicates but has no `user/alice` yet, so every
  // resume burns its whole RESUME_RECORD_TRIES and answers retry:true.
  const { attempts, spent } = await runRestore(
    nav, { ok: false, error: 'offline', retry: true, logins: RESUME_RECORD_TRIES, message: 'unknown user' }, UNREPLICATED_MS
  )
  // Before the fix: 45000 / (6200 + 2500) admits six resumes, 18 logins, and the panel
  // stops answering at the eleventh.
  expect(spent).toBeLessThan(PANEL_LOCKOUT_THRESHOLD)
  expect(spent).toBe(RESUME_RECORD_TRIES) // one resume's worth, and one resume
  expect(attempts).toBe(1)
  // A third of the panel's tolerance, which leaves the password door's own fall-through
  // and a viewer typing at the sign-in screen room in the same window.
  expect(spent * 3).toBeLessThanOrEqual(PANEL_LOCKOUT_THRESHOLD)
  expect(nav.replace).toHaveBeenCalledWith('Login')
})

test('B3: an account already locked out cannot make the door spin faster', async () => {
  const nav = await boot({ signinSaved: true, creds: null })
  // The positive feedback loop. Once the throttle has fired, the panel refuses in ~20 ms
  // — so under a wall-clock budget each refusal bought another attempt sooner than the
  // last, and the door accelerated into the wall it had just hit.
  const { attempts, spent } = await runRestore(
    nav, { ok: false, error: 'offline', retry: true, logins: 1, message: 'login failed: locked (retry 871s)' }, LOCKED_MS
  )
  expect(spent).toBeLessThan(PANEL_LOCKOUT_THRESHOLD)
  expect(attempts).toBe(1)
  expect(spent).toBe(1)
  expect(nav.replace).toHaveBeenCalledWith('Login')
})

test('B3: a resume whose cost never came back is charged as if it had paid', async () => {
  const nav = await boot({ signinSaved: true, creds: { username: 'viewer', password: 'pw' } })
  // The one answer the WORKLET never composed, so the one answer with no cost on it: the
  // RN binding builds this itself when nothing came back inside SIGNIN_RESUME_MS, and it
  // is the case where the worklet may still be inside signInWithKeys() — which has no
  // timeout of its own — with a login already in flight. The clock is not what is under
  // test here (a real timeout arrives at 45 s, where the deadline would have stopped the
  // door anyway); the CHARGE is, because it is what keeps the door bounded if that
  // constant ever shortens.
  const { attempts } = await runRestore(nav, { ok: false, error: 'timeout', retry: true }, 0)
  expect(attempts).toBe(1)
  expect(resumes()).toHaveLength(1) // no second resume was ever started
  // …and the password door — which is about to run a login on that same socket — takes the
  // rest of the boot with its own budget intact.
  expect(logins()).toEqual([{ username: 'viewer', password: 'pw' }])
})

test('B3: the binding reports no cost when the worklet did not answer', async () => {
  // The other half of the contract the screen relies on, asserted against the binding
  // rather than assumed: `logins` present = what this resume spent; ABSENT = unknowable.
  const pending = backend.resumeSignIn()
  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(45000) })
  const res = await pending
  expect(res).toMatchObject({ ok: false, error: 'timeout', retry: true })
  expect('logins' in res).toBe(false)
})

test('B2: the password door still has its full budget after the restore door spent its own', async () => {
  const creds = { username: 'viewer', password: 'pw' }
  const nav = await boot({ signinSaved: true, creds })

  await runRestoreOffline(nav)
  // The restore door gave up and handed over — it did NOT route to the sign-in screen,
  // because there is a password to try.
  expect(nav.replace).not.toHaveBeenCalled()
  expect(logins()).toEqual([creds])

  // The shipped bug is exactly here: with one shared counter the budget was already spent,
  // so the FIRST transient dropped the viewer to LoginScreen with the saved password never
  // having reached the panel. It must retry instead.
  await ReactTestRenderer.act(async () => { workletSays({ type: 'login-error', message: 'not connected to panel' }) })
  expect(nav.replace).not.toHaveBeenCalled()
  await tick(RETRY_MS)
  expect(logins()).toHaveLength(2) // tried again…
  expect(logins()[1]).toEqual(creds) // …with the same credentials

  // …and it keeps its whole minute: still retrying well past where the restore door stopped.
  for (let i = 1; i < LOGIN_MAX_RETRIES; i++) {
    await ReactTestRenderer.act(async () => { workletSays({ type: 'login-error', message: 'not connected to panel' }) })
    await tick(RETRY_MS)
  }
  expect(nav.replace).not.toHaveBeenCalled()
  expect(logins()).toHaveLength(LOGIN_MAX_RETRIES + 1)
  // One more spends the last of it, and only then is the sign-in screen right.
  await ReactTestRenderer.act(async () => { workletSays({ type: 'login-error', message: 'not connected to panel' }) })
  expect(nav.replace).toHaveBeenCalledWith('Login')
})

test('a real auth failure at the password door drops straight to Login, budget or no budget', async () => {
  const nav = await boot({ signinSaved: false, creds: { username: 'viewer', password: 'pw' } })
  expect(resumes()).toHaveLength(0) // no kept sign-in: the restore door never opens
  await ReactTestRenderer.act(async () => { workletSays({ type: 'login-error', message: 'invalid credentials' }) })
  expect(nav.replace).toHaveBeenCalledWith('Login')
})

test('a restore that succeeds goes to the menu and never opens the password door', async () => {
  const creds = { username: 'viewer', password: 'pw' }
  const nav = await boot({ signinSaved: true, creds })
  await tick(WORKLET_DIAL_MS)
  await answerResume({ ok: true })
  expect(nav.replace).toHaveBeenCalledWith('Menu')
  expect(logins()).toHaveLength(0)
})

test('a refused restore falls through to the password door at once, spending nothing', async () => {
  const creds = { username: 'viewer', password: 'pw' }
  const nav = await boot({ signinSaved: true, creds })
  // 'rejected' carries no retry flag: the worklet has already erased the record, so there
  // is nothing left to try and no reason to wait.
  await answerResume({ ok: false, error: 'rejected', message: 'session failed: account disabled' })
  expect(nav.replace).not.toHaveBeenCalled()
  expect(logins()).toEqual([creds])
  // And the password door's own budget is untouched by that fall-through.
  for (let i = 0; i < LOGIN_MAX_RETRIES; i++) {
    await ReactTestRenderer.act(async () => { workletSays({ type: 'login-error', message: 'not connected to panel' }) })
    await tick(RETRY_MS)
  }
  expect(nav.replace).not.toHaveBeenCalled()
})

test('sign-out and leaving the operator each erase BOTH ways back in', async () => {
  // The RN half of the two erases: the message the worklet acts on, and the mirrored flag
  // a screen reads. (The Keystore destroy beside them is a native call with nothing to
  // answer under jest — Platform.OS is not android here, so it degrades to a no-op.)
  backend.signinSaved = true
  backend.creds = { username: 'viewer', password: 'pw' }
  sent().length = 0
  backend.clearCredentials()
  expect(sent()).toContainEqual({ type: 'creds-clear' })
  expect(backend.signinSaved).toBe(false)
  expect(backend.creds).toBeNull()

  backend.signinSaved = true
  sent().length = 0
  backend.clearService()
  expect(sent()).toContainEqual({ type: 'service-clear' })
  expect(backend.signinSaved).toBe(false)
})
