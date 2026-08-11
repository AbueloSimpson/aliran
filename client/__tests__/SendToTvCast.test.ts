// "Play on a TV" — the decisions that are not visible on screen.
//
// THE ONE THAT MATTERS MOST IS PINNING. A cast session can be told to serve one address
// and refuse every other peer; unpinned, the stream is reachable by anything that can
// read the media URL off the television, which a receiver hands to any peer that joins
// its session (measured on a real TCL Google TV — a process that never saw the URL
// recovered it in full). None of that can be checked on hardware from here, but the
// DECISION can: which facts make the app pin, which make it refuse to, and whether a
// refusal to pin is silent. Every case below is a case that was wrong at some point in
// some app that shipped this feature.
//
// The second half is teardown. Every failure after a Cast session connects leaves two
// things running — a session on the television and an origin server on this phone — and
// a half-torn-down cast is this phone awake, decrypting and serving for nobody.

import { Platform } from 'react-native'

// The Cast library, with a receiver on the end of it. jest.config.js already maps the
// package to __mocks__/react-native-google-cast.js — a device with no Play Services —
// and this factory takes precedence over that file for this suite.
//
// NOT `{ virtual: true }`, which is what it used to say. The package IS installed, and a
// virtual mock is keyed on the file that called jest.mock, so it lost to jest's
// per-worker resolver cache whenever another suite had already required the package from
// src/cast.ts first: every test below then ran against the real library and failed
// 'cast-connect' as a block. The mechanism is written up in the mock file.
//
// AND THE SESSION IS TWO STEPS, because on a real device it is. startSession() reaches
// RNGCSessionManager.java, which looks the device up in the MediaRouter's route list,
// calls `router.selectRoute()` and resolves TRUE — and selectRoute is fire-and-forget.
// Whether a Cast session then exists is reported afterwards, through onSessionStarted /
// onSessionStartFailed. A stub that answered `true` and had a session ready in the same
// breath is what let "the promise means a session exists" ship: it made a race that
// failed on every channel and every television look like a passing suite.
const mockCast: any = {
  devices: [] as any[],
  deviceListeners: [] as any[],
  sessionEndedListeners: [] as any[],
  sessionStartedListeners: [] as any[],
  sessionStartFailedListeners: [] as any[],
  playServices: 'success',
  deviceName: 'Kitchen display',
  // Which device the framework currently holds a session with, or null. Set by a session
  // that starts, cleared by one that ends — the same thing getCurrentCastSession() reads.
  session: null as string | null,
  // What happens AFTER the route is selected: 'started' / 'failed' report themselves,
  // 'silent' reports nothing (a set that never answers — and also a route that was
  // already selected, which has no state change to report), 'manual' waits for the test.
  outcome: 'started' as 'started' | 'failed' | 'silent' | 'manual',
  startDiscovery: jest.fn(),
  stopDiscovery: jest.fn(),
  endCurrentSession: jest.fn(async () => { mockCast.session = null }),
  loadMedia: jest.fn(async () => {}),
  sessionStarted: (deviceId: string) => {
    mockCast.session = deviceId
    for (const fn of [...mockCast.sessionStartedListeners]) fn({})
  },
  sessionStartFailed: () => {
    for (const fn of [...mockCast.sessionStartFailedListeners]) fn({}, 'connection failed')
  }
}
function selectRoute () {
  return jest.fn(async (deviceId: string) => {
    // Reported on a later turn, never in the same one: this IS the gap the fix waits out.
    const outcome = mockCast.outcome
    if (outcome === 'started' || outcome === 'failed') {
      Promise.resolve().then(() => {
        if (outcome === 'started') mockCast.sessionStarted(deviceId)
        else mockCast.sessionStartFailed()
      })
    }
    return true
  })
}
mockCast.startSession = selectRoute()
jest.mock('react-native-google-cast', () => ({
  CastContext: {
    getPlayServicesState: async () => mockCast.playServices,
    getDiscoveryManager: () => ({
      startDiscovery: mockCast.startDiscovery,
      stopDiscovery: mockCast.stopDiscovery,
      getDevices: async () => mockCast.devices,
      onDevicesUpdated: (fn: unknown) => { mockCast.deviceListeners.push(fn); return { remove: () => {} } }
    }),
    getSessionManager: () => ({
      startSession: (id: string) => mockCast.startSession(id),
      endCurrentSession: mockCast.endCurrentSession,
      getCurrentCastSession: async () => (mockCast.session
        ? {
            client: { loadMedia: mockCast.loadMedia },
            // deviceId, not just the friendly name: a session is only an answer for the
            // device that was asked for, and another room's set is a live session too.
            getCastDevice: async () => ({ deviceId: mockCast.session, friendlyName: mockCast.deviceName })
          }
        : null),
      onSessionStarted: (fn: unknown) => { mockCast.sessionStartedListeners.push(fn); return { remove: () => {} } },
      onSessionStartFailed: (fn: unknown) => { mockCast.sessionStartFailedListeners.push(fn); return { remove: () => {} } },
      onSessionEnded: (fn: unknown) => { mockCast.sessionEndedListeners.push(fn); return { remove: () => {} } }
    })
  }
}))

import { isLanAddress, parseAddress } from '../src/cast'
import {
  activeSend, armRendezvous, joinRendezvous, leaveRendezvous, sendCast, stopSending,
  __resetForTests, type CastTarget
} from '../src/sendToTv'
import { backend } from '../src/worklet'
import type { Stream } from '../src/worklet'

// The pin is decided from the TARGET, before anything connects — see sendCast.
const TARGET: CastTarget = { kind: 'cast', deviceId: 'cc:1', name: 'Kitchen display', address: '192.168.1.77', isGroup: false }
const GROUP: CastTarget = { ...TARGET, name: 'Whole house', isGroup: true }
const NO_ADDRESS: CastTarget = { ...TARGET, address: null }
const CHANNEL: Stream = { id: 'news', title: 'News 24', isLive: true }
// A real session reply: the url is the thing that must never be logged (it carries the
// per-session token) and the thing the receiver is handed.
const SESSION = {
  url: 'http://192.168.1.44:51234/cast/deadbeefdeadbeefdeadbeefdeadbeef/index.m3u8',
  streamId: 'news',
  source: 'p2p',
  host: '192.168.1.44',
  port: 51234,
  candidates: ['192.168.1.44', '172.17.0.1']
}

function sent (): any[] { return (backend as any).pending }
function lastOf (type: string): any {
  const all = sent().filter((m) => m?.type === type)
  return all[all.length - 1]
}
function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }
// Drain the microtask queue between steps. Generous on purpose: sendCast() awaits several
// things before it sends anything (the notification-permission check, the Cast session),
// and a count tuned to today's exact number of awaits breaks on the next one added.
async function flush () { for (let i = 0; i < 12; i++) await Promise.resolve() }

/** Kick off a send, answer the worklet messages it produces, and return the outcome.
 *
 *  The reply ECHOES `receiverHost` the way the engine does — it answers with its own
 *  normalised list, which is what the sheet's exposure sentence is now computed from
 *  rather than from what was asked for. `pinnedTo` overrides it, for the case where the
 *  engine did not apply the pin the phone requested. */
async function castRun (opts: { started?: any; loads?: boolean; target?: CastTarget; pinnedTo?: string[] | undefined } = {}) {
  mockCast.loadMedia = jest.fn(async () => { if (opts.loads === false) throw new Error('receiver refused') })
  const p = sendCast(opts.target ?? TARGET, CHANNEL)
  await flush()
  const start = lastOf('cast-start')
  const echoed = 'pinnedTo' in opts ? opts.pinnedTo : (start?.receiverHost ? [start.receiverHost] : undefined)
  const reply = opts.started ?? { type: 'cast-started', ok: true, session: { ...SESSION, ...(echoed ? { receiverHost: echoed } : {}) } }
  // The tag is always the REQUEST's: the binding matches replies by it, and an answer
  // without one is an answer nobody is listening for.
  workletSays({ ...reply, tag: start?.tag })
  await flush()
  // The two-step teardown paths send a second message and wait for its reply.
  const stop = lastOf('cast-stop')
  if (stop) { workletSays({ type: 'cast-stopped', ok: true, tag: stop.tag }); await flush() }
  return { failure: await p, start }
}

const realOS = Platform.OS
beforeEach(() => {
  ;(Platform as { OS: string }).OS = 'android'
  __resetForTests()
  ;(backend as any).pending = []
  mockCast.deviceListeners = []
  mockCast.sessionEndedListeners = []
  mockCast.sessionStartedListeners = []
  mockCast.sessionStartFailedListeners = []
  mockCast.playServices = 'success'
  mockCast.deviceName = 'Kitchen display'
  mockCast.session = null
  mockCast.outcome = 'started'
  mockCast.startSession = selectRoute()
  mockCast.endCurrentSession = jest.fn(async () => { mockCast.session = null })
  // castRun() replaces this per case; the cases that never reach it still have to open
  // on a clean one, or "the URL was never handed over" reads the LAST test's hand-over.
  mockCast.loadMedia = jest.fn(async () => {})
})
afterEach(() => {
  ;(Platform as { OS: string }).OS = realOS
  jest.useRealTimers()
  jest.restoreAllMocks()
})

// --- which addresses are worth pinning to -----------------------------------------
//
// The cast server binds a PRIVATE address, so a receiver that reaches it has one too.
// Anything else is the platform reporting a connection that is not the one fetching the
// media, and pinning to it would 404 the device that actually is.

test('isLanAddress: private, link-local and CGNAT yes; public and nonsense no', () => {
  for (const a of ['10.0.0.5', '192.168.1.44', '172.16.9.9', '172.31.0.1', '169.254.4.4', '100.100.1.1', 'fe80::1', 'fd12:3456::1']) {
    expect([a, isLanAddress(a)]).toEqual([a, true])
  }
  for (const a of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '2001:4860::1', '', 'chromecast.local', 'not an address']) {
    expect([a, isLanAddress(a)]).toEqual([a, false])
  }
})

test('isLanAddress ignores an IPv6 zone suffix — the zone is this device\'s interface', () => {
  expect(isLanAddress('fe80::a1b2:c3d4%wlan0')).toBe(true)
})

// THE SPELLING IS PART OF THE PIN. The engine compares the value it was given against a
// socket's remote address, through a normaliser that lowercases, drops the zone and folds
// the v4-mapped forms — and which says in its own comment that it is not a general IPv6
// canonicaliser. Java's getHostAddress(), which is what the Android bridge stringifies,
// renders IPv6 UNCOMPRESSED. The socket reports it compressed. Two spellings of one host
// never match, so the television 404s while the card says only it can get the channel:
// fail-closed for exposure and fail-OPEN for honesty, which is the one outcome parseAddress
// exists to prevent. The old guard asserted 'fe80::1%wlan0' — a spelling the bridge cannot
// produce — so it never saw this.
test('an IPv6 address is pinned in the spelling a socket peer will be reported as', () => {
  // What the bridge really sends for a link-local receiver.
  expect(parseAddress('/fe80:0:0:0:0:0:0:1%wlan0')).toBe('fe80::1')
  expect(parseAddress('chromecast.lan/fe80:0:0:0:0:0:0:1%wlan0')).toBe('fe80::1')
  // Already-compressed, mixed case, and a zone: same answer, and the zone never rides
  // along — it names an interface on THIS device.
  expect(parseAddress('/FE80::1%wlan0')).toBe('fe80::1')
  // Leading zeros go; a single zero group is NOT compressed (inet_ntop compresses runs of
  // two or more, longest first) — this is the run-picking that has to agree exactly.
  expect(parseAddress('/fd00:0abc:0:0:1:0:0:9')).toBe('fd00:abc::1:0:0:9')
  expect(parseAddress('/fd00:0:1:0:0:0:0:2')).toBe('fd00:0:1::2')
})

test('an IPv6 address this cannot canonicalise is NOT pinned — unpinned and honest beats pinned and dead', () => {
  expect(parseAddress('/fe80::1::2')).toBeNull()     // two runs of `::` is not an address
  expect(parseAddress('/fe80:0:0:0:0:0:1')).toBeNull() // seven groups, uncompressed
  expect(parseAddress('/fe80::wxyz')).toBeNull()     // not hex
  expect(parseAddress('/fe80::1:2:3:4:5:6:7:8')).toBeNull() // more than eight
})

// The Android bridge stringifies a java.net.InetAddress, and InetAddress.toString()
// renders as `hostname/1.2.3.4` — NOT a bare address. Passing that through as a host
// produces a pin that matches nothing, and a session that believes it is pinned while it
// serves every peer is the worst outcome this feature has.
test('parseAddress strips what InetAddress.toString() actually sends', () => {
  expect(parseAddress('/192.168.1.77')).toBe('192.168.1.77')
  expect(parseAddress('chromecast.lan/192.168.1.77')).toBe('192.168.1.77')
  expect(parseAddress('192.168.1.77')).toBe('192.168.1.77')
  // …and the LAN test still has the last word on whatever came out.
  expect(parseAddress('gw/8.8.8.8')).toBeNull()
  expect(parseAddress('')).toBeNull()
  expect(parseAddress(undefined)).toBeNull()
  expect(parseAddress(null)).toBeNull()
})

// --- the pinning decision ----------------------------------------------------------

test('a single receiver with a LAN address is PINNED: startCast carries receiverHost', async () => {
  const { failure, start } = await castRun()
  expect(failure).toBeNull()
  expect(start.receiverHost).toBe('192.168.1.77')
  expect(activeSend()).toMatchObject({ kind: 'cast', pinned: true, group: false, deviceName: 'Kitchen display' })
})

test('a multi-room GROUP is NOT pinned — every member fetches, so one address is wrong', async () => {
  mockCast.deviceName = 'Whole house'
  const { failure, start } = await castRun({ target: GROUP })
  expect(failure).toBeNull()
  expect(start).not.toHaveProperty('receiverHost')
  expect(activeSend()).toMatchObject({ pinned: false, group: true, deviceName: 'Whole house' })
})

test('a device with no usable address casts UNPINNED rather than not at all', async () => {
  const { failure, start } = await castRun({ target: NO_ADDRESS })
  expect(failure).toBeNull()
  expect(start).not.toHaveProperty('receiverHost')
  expect(activeSend()).toMatchObject({ pinned: false, group: false })
})

// `pinned` is what the viewer's exposure sentence is chosen from, so it is read off the
// ENGINE'S ANSWER — session.receiverHost, its own normalised list — and not asserted from
// what the request carried. Everything between the two can drop the pin: an address the
// engine will not take, an option a worklet does not know. Asserting it from intent is how
// a session that serves every peer gets to say only one television can reach it.
test('a pin the engine did not apply reads UNPINNED, whatever was asked for', async () => {
  const { failure, start } = await castRun({ pinnedTo: undefined })
  expect(failure).toBeNull()
  expect(start.receiverHost).toBe('192.168.1.77') // asked for…
  expect(activeSend()).toMatchObject({ pinned: false }) // …and not granted
})

test('an EMPTY receiverHost from the engine is unpinned too — it names nothing', async () => {
  await castRun({ pinnedTo: [] })
  expect(activeSend()).toMatchObject({ pinned: false })
})

// --- the session has to EXIST before anything is served ------------------------------
//
// This is the one that reached hardware: pick any channel, tap "Play on TV", pick either
// television, and it failed with "The TV did not start the channel. Try again." — on two
// different sets and several channels. A castv2 probe polling both televisions through
// repeated attempts saw NO Default Media Receiver session at all, while the same probe
// caught a control cast fine. There was nothing wrong with the URL, the server or the
// channel: the session was never there to load anything into.
//
// The cause is one word — `startSession()` resolves on the ROUTE being selected — and the
// cost of believing it was three things done to a television that had not answered yet: a
// LAN origin server stood up on the phone, a live session token put on the network, and
// the wrong half of the flow blamed on the sheet.

test('nothing is served until the session really starts', async () => {
  mockCast.outcome = 'manual'
  const p = sendCast(TARGET, CHANNEL)
  await flush()
  // The bridge answered "route selected", which is all it has ever meant…
  expect(mockCast.startSession).toHaveBeenCalledWith('cc:1')
  // …and on the strength of that, this phone has done NOTHING.
  expect(lastOf('cast-start')).toBeUndefined()
  expect(mockCast.loadMedia).not.toHaveBeenCalled()

  // The framework establishes the session and says so.
  mockCast.sessionStarted('cc:1')
  await flush()
  const start = lastOf('cast-start')
  expect(start).toBeTruthy()
  workletSays({ type: 'cast-started', ok: true, session: { ...SESSION, receiverHost: ['192.168.1.77'] }, tag: start.tag })
  await flush()
  expect(await p).toBeNull()
  expect(mockCast.loadMedia).toHaveBeenCalled()
  expect(activeSend()).toMatchObject({ kind: 'cast', pinned: true })
})

// THE MISLABELLING, and it is the half that costs somebody a day. With connect() unable
// to answer no, a session that never started fell through to loadMedia() and reported
// 'cast-load' — "The TV did not start the channel" — which points the next person at the
// origin server this phone stands up, and the origin server was fine every time.
test('a session that FAILS to start is a connect failure, not a load failure', async () => {
  mockCast.outcome = 'failed'
  const failure = await sendCast(TARGET, CHANNEL)
  expect(failure).toBe('cast-connect')
  expect(lastOf('cast-start')).toBeUndefined() // no server was stood up…
  expect(mockCast.loadMedia).not.toHaveBeenCalled() // …and nothing was handed to nobody
  expect(activeSend()).toBeNull()
})

test('a television that never answers gives the sheet back rather than holding it', async () => {
  jest.useFakeTimers()
  mockCast.outcome = 'silent'
  const p = sendCast(TARGET, CHANNEL)
  await flush()
  expect(lastOf('cast-start')).toBeUndefined()
  jest.advanceTimersByTime(30000)
  await flush()
  expect(await p).toBe('cast-connect')
  expect(lastOf('cast-start')).toBeUndefined()
})

// A ROUTE THAT IS ALREADY SELECTED REPORTS NOTHING, because nothing changed — and the
// viewer sending a second channel to the set they are already casting to is the ordinary
// way to reach that. Waiting on an event that will never come would turn a working
// session into a 30-second wait and then a lie, so the current session is read as well.
test('the set this phone is already casting to needs no new session', async () => {
  jest.useFakeTimers()
  mockCast.outcome = 'silent'
  mockCast.session = 'cc:1' // still connected from the last channel
  const p = sendCast(TARGET, CHANNEL)
  await flush()
  jest.advanceTimersByTime(500)
  await flush()
  const start = lastOf('cast-start')
  expect(start).toBeTruthy()
  workletSays({ type: 'cast-started', ok: true, session: { ...SESSION, receiverHost: ['192.168.1.77'] }, tag: start.tag })
  await flush()
  expect(await p).toBeNull()
})

// …but the current session is only an answer for the device it belongs to. A viewer
// moving a channel from the bedroom set to the kitchen one has a live session the whole
// time, and reading "connected" off it would hand this channel's URL to the wrong room.
test('a live session with ANOTHER television does not answer for this one', async () => {
  jest.useFakeTimers()
  mockCast.outcome = 'silent'
  mockCast.session = 'cc:2' // the bedroom, still playing
  const p = sendCast(TARGET, CHANNEL)
  await flush()
  jest.advanceTimersByTime(30000)
  await flush()
  expect(await p).toBe('cast-connect')
  expect(lastOf('cast-start')).toBeUndefined()
})

// --- teardown ----------------------------------------------------------------------

test('a receiver that will not load the URL tears BOTH halves down', async () => {
  const { failure } = await castRun({ loads: false })
  expect(failure).toBe('cast-load')
  expect(lastOf('cast-stop')).toBeTruthy()          // the origin server is closed
  expect(mockCast.endCurrentSession).toHaveBeenCalled() // and so is the session on the TV
  expect(activeSend()).toBeNull()
})

test('an engine that will not serve ends the session it already opened on the TV', async () => {
  const { failure } = await castRun({ started: { type: 'cast-started', ok: false, message: 'no private address' } })
  expect(failure).toBe('cast-serve')
  expect(mockCast.endCurrentSession).toHaveBeenCalled()
  expect(mockCast.loadMedia).not.toHaveBeenCalled()
  expect(activeSend()).toBeNull()
})

test('a receiver that refuses the session never starts a server', async () => {
  mockCast.startSession = jest.fn(async () => { throw new Error('nope') })
  const failure = await sendCast(TARGET, CHANNEL)
  expect(failure).toBe('cast-connect')
  expect(lastOf('cast-start')).toBeUndefined()
  expect(activeSend()).toBeNull()
})

test('the television dropping the session stops the server here', async () => {
  await castRun()
  expect(activeSend()).not.toBeNull()
  expect(mockCast.sessionEndedListeners).toHaveLength(1)
  mockCast.sessionEndedListeners[0]()
  await flush()
  const stop = lastOf('cast-stop')
  expect(stop).toBeTruthy()
  expect(activeSend()).toBeNull()
  workletSays({ type: 'cast-stopped', ok: true, tag: stop.tag }) // settle the request's timer
  await flush()
})

test('the engine ending the session ends it on the television too', async () => {
  await castRun()
  workletSays({ type: 'cast-ended', state: 'ended', streamId: 'news', reason: 'feed-evicted' })
  await flush()
  expect(mockCast.endCurrentSession).toHaveBeenCalled()
  expect(activeSend()).toBeNull()
  // …and the binding's own cached session is cleared, so a sheet that re-opens does not
  // paint "Casting" over a server that is already closed.
  expect(backend.castSession).toBeNull()
})

test('Stop stops both halves', async () => {
  await castRun()
  const before = sent().filter((m) => m?.type === 'cast-stop').length
  const p = stopSending()
  await flush()
  const stop = lastOf('cast-stop')
  workletSays({ type: 'cast-stopped', ok: true, tag: stop.tag })
  await p
  expect(sent().filter((m) => m?.type === 'cast-stop').length).toBe(before + 1)
  expect(mockCast.endCurrentSession).toHaveBeenCalled()
  expect(activeSend()).toBeNull()
})

// --- the rendezvous, and what a sign-out has to undo --------------------------------
//
// The join rides the catalog push, which is ALSO re-sent on every panel edit and again
// after a sign-out/sign-in. So the latch has to be exactly right in both directions: no
// re-join per edit, and a guaranteed re-join per session.

async function joinRun (ok = true, error?: string) {
  const p = joinRendezvous()
  await flush()
  const req = lastOf('remote-start')
  if (req) {
    workletSays({ type: 'remote-started', ok, role: req.role, ...(error ? { error } : {}), tag: req.tag })
    await flush()
  }
  return { joined: await p, req }
}
function starts (): number { return sent().filter((m) => m?.type === 'remote-start').length }

test('a phone joins as a CONTROLLER — it never announces itself, so it is never a target', async () => {
  const { joined, req } = await joinRun()
  expect(joined).toBe(true)
  expect(req).toMatchObject({ type: 'remote-start', role: 'controller' })
  expect(typeof req.label).toBe('string')
  expect(req.label.length).toBeGreaterThan(0)
})

// THE JOIN CARRIES NO acceptPlay, AND THAT IS THE PER-SET SWITCH WORKING. The take-over
// preference is persisted, and the WORKLET resolves it into its own startRemote() call —
// it owns the prefs file, while this layer only mirrors it in a message that may not have
// arrived yet. Sending `acceptPlay: true` from here, which is what this used to do, would
// overrule a television whose viewer had switched it off, on every boot, for the window
// between the join landing and anything noticing.
test('the join does not overrule the persisted take-over switch', async () => {
  const { req } = await joinRun()
  expect(req).not.toHaveProperty('acceptPlay')
})

test('joined once per session: a later catalog push does not re-join', async () => {
  await joinRun()
  const before = starts()
  await joinRendezvous()
  await flush()
  expect(starts()).toBe(before)
})

// THE LATCH HAS TO SURVIVE ITS OWN AWAIT. The old one was read before startRemote() and
// written after it, so two catalog pushes inside one in-flight start sent two requests —
// and the engine's throw on the second ("a remote session is already running on this
// device") then cleared the latch the first had just set, leaving every later push to fire
// another doomed start for the life of the run.
test('two catalog pushes inside one in-flight start send ONE request', async () => {
  const first = joinRendezvous()
  await flush()
  const second = joinRendezvous() // the panel edited the catalog while the start was out
  await flush()
  expect(starts()).toBe(1)
  const req = lastOf('remote-start')
  workletSays({ type: 'remote-started', ok: true, role: req.role, tag: req.tag })
  await flush()
  expect(await first).toBe(true)
  expect(await second).toBe(false) // it did not join; it also did not start anything
  // …and the latch the answer set is still set.
  await joinRendezvous()
  await flush()
  expect(starts()).toBe(1)
})

// A no that cannot change is latched. A build without `remote: { control: true }`, or an
// account whose panel record predates tokenVersion, answers no however long anyone waits —
// the binding's own docstring says so — and retrying it once per panel edit is pure noise.
test('a PERMANENT refusal is latched: no retry on the next catalog push', async () => {
  const { joined } = await joinRun(false) // an engine throw: ok:false with no code
  expect(joined).toBe(false)
  const before = starts()
  await joinRendezvous()
  await flush()
  expect(starts()).toBe(before)
})

// …and the two answers that decided NOTHING are retried, or a television that was still
// signing in when the first catalog arrived would never join.
test('"no answer" and "not signed in yet" are not refusals — the next push tries again', async () => {
  for (const code of ['timeout', 'offline']) {
    __resetForTests()
    ;(backend as any).pending = []
    await joinRun(false, code)
    const before = starts()
    const { joined } = await joinRun()
    expect([code, joined]).toEqual([code, true])
    expect(starts()).toBe(before + 1)
  }
})

test('sign-out leaves the rendezvous and stops the send', async () => {
  await joinRun()
  await castRun()
  expect(activeSend()).not.toBeNull()

  leaveRendezvous()
  await flush()
  const stop = lastOf('cast-stop')
  if (stop) { workletSays({ type: 'cast-stopped', ok: true, tag: stop.tag }); await flush() }

  // The rendezvous key is derived from the ACCOUNT: staying on it after a sign-out keeps
  // announcing a device of that account.
  expect(lastOf('remote-leave')).toBeTruthy()
  expect(activeSend()).toBeNull()
  expect(mockCast.endCurrentSession).toHaveBeenCalled()
})

// THE RE-ARM IS THE HOLE, not the leave. Sign-out rewrites the prefs file and nothing
// else: the engine keeps its session and keeps publishing the catalog, and the join rides
// that push. A latch that merely RESET put the device back on the signed-out account's
// rendezvous — announcing itself, acceptPlay: true, taking that account's commands — at
// the operator's very next catalog edit, while the screen showed Login.
test('after a sign-out a catalog edit does NOT rejoin the signed-out account', async () => {
  await joinRun()
  leaveRendezvous()
  await flush()
  const before = starts()
  await joinRendezvous() // the operator edits the catalog; the engine re-pushes it
  await flush()
  expect(starts()).toBe(before)
})

test('…and a sign-in door opening arms it again, so the feature is not gone for the run', async () => {
  await joinRun()
  leaveRendezvous()
  await flush()
  const before = starts()
  armRendezvous() // signinPath.claim(): a viewer is signing in
  const { joined } = await joinRun()
  expect(joined).toBe(true)
  expect(starts()).toBe(before + 1)
})

test('a start that lands after a sign-out leaves again rather than staying on', async () => {
  const p = joinRendezvous()
  await flush()
  const req = lastOf('remote-start')
  leaveRendezvous() // the viewer signed out while the start was in flight
  await flush()
  const leavesBefore = sent().filter((m) => m?.type === 'remote-leave').length
  workletSays({ type: 'remote-started', ok: true, role: req.role, tag: req.tag })
  await flush()
  expect(await p).toBe(false)
  // The engine may have joined AFTER the leave reached it, so it is told again.
  expect(sent().filter((m) => m?.type === 'remote-leave').length).toBe(leavesBefore + 1)
})

// --- the debug logger --------------------------------------------------------------
//
// This app ships debug:true in RELEASE builds, so anything the binding prints goes into
// `adb logcat` on a viewer's phone. The cast session URL carries the session token. The
// exclusion is on the `cast-` PREFIX, so a message added to the family later is excluded
// by default rather than by somebody remembering — which is what these two tests pin.

test('the cast family never reaches the log, whatever it carries', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {})
  ;(backend as any).debug = true
  try {
    workletSays({ type: 'cast-started', ok: true, session: SESSION })
    workletSays({ type: 'cast-ended', state: 'ended', streamId: 'news', reason: 'feed-evicted' })
    const printed = log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(printed).not.toContain('deadbeef')      // the token
    expect(printed).not.toContain('/cast/')        // nor the path that carries it
    expect(printed).toContain('cast-started')      // the TYPE still shows: it is a breadcrumb
    expect(printed).toContain('cast-ended')
  } finally {
    ;(backend as any).debug = false
    log.mockRestore()
  }
})

test('the peer list IS logged — a deviceId is a picker handle, and it is the first thing to look at', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {})
  ;(backend as any).debug = true
  try {
    workletSays({ type: 'remote-peers', peers: [{ deviceId: 'abc123', label: 'Living room', role: 'tv', platform: 'android', appVersion: '0.5.0' }] })
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('Living room')
  } finally {
    ;(backend as any).debug = false
    log.mockRestore()
  }
})

// …but the COMMAND is not a peer list. It carries the title of the channel a television
// was told to play and whether that channel is parental-restricted — a viewing record of
// somebody else's household set — and it is far shorter than the raw-line cut-off, so
// without an explicit exclusion it printed in full into `adb logcat` on a release build.
test('a remote command never reaches the log — the title and the parental flag are a viewing record', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {})
  ;(backend as any).debug = true
  try {
    workletSays({ type: 'remote-info', role: 'tv', state: 'play', streamId: 'late', restricted: true, title: 'Late Night Adult Channel' })
    const printed = log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(printed).not.toContain('Late Night Adult Channel')
    expect(printed).not.toContain('restricted')
    expect(printed).toContain('remote-info') // the type still shows: it is a breadcrumb
  } finally {
    ;(backend as any).debug = false
    log.mockRestore()
  }
})
