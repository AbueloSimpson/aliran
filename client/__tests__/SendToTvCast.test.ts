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

// The Cast library, virtually: it is a real dependency of the app and is not installed
// in this workspace, which is also the shape of every device that cannot cast.
const mockCast: any = {
  devices: [] as any[],
  deviceListeners: [] as any[],
  sessionEndedListeners: [] as any[],
  playServices: 'success',
  deviceName: 'Kitchen display',
  startDiscovery: jest.fn(),
  stopDiscovery: jest.fn(),
  startSession: jest.fn(async () => true),
  endCurrentSession: jest.fn(async () => {}),
  loadMedia: jest.fn(async () => {})
}
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
      startSession: mockCast.startSession,
      endCurrentSession: mockCast.endCurrentSession,
      getCurrentCastSession: async () => ({
        client: { loadMedia: mockCast.loadMedia },
        getCastDevice: async () => ({ friendlyName: mockCast.deviceName })
      }),
      onSessionEnded: (fn: unknown) => { mockCast.sessionEndedListeners.push(fn); return { remove: () => {} } }
    })
  }
}), { virtual: true })

import { isLanAddress, parseAddress } from '../src/cast'
import {
  activeSend, joinRendezvous, leaveRendezvous, sendCast, stopSending, __resetForTests,
  type CastTarget
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
async function flush () { for (let i = 0; i < 4; i++) await Promise.resolve() }

/** Kick off a send, answer the worklet messages it produces, and return the outcome. */
async function castRun (opts: { started?: any; loads?: boolean; target?: CastTarget } = {}) {
  mockCast.loadMedia = jest.fn(async () => { if (opts.loads === false) throw new Error('receiver refused') })
  const p = sendCast(opts.target ?? TARGET, CHANNEL)
  await flush()
  const start = lastOf('cast-start')
  // The tag is always the REQUEST's: the binding matches replies by it, and an answer
  // without one is an answer nobody is listening for.
  workletSays({ ...(opts.started ?? { type: 'cast-started', ok: true, session: SESSION }), tag: start?.tag })
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
  mockCast.playServices = 'success'
  mockCast.deviceName = 'Kitchen display'
  mockCast.startSession = jest.fn(async () => true)
  mockCast.endCurrentSession = jest.fn(async () => {})
})
afterEach(() => {
  ;(Platform as { OS: string }).OS = realOS
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

// The Android bridge stringifies a java.net.InetAddress, and InetAddress.toString()
// renders as `hostname/1.2.3.4` — NOT a bare address. Passing that through as a host
// produces a pin that matches nothing, and a session that believes it is pinned while it
// serves every peer is the worst outcome this feature has.
test('parseAddress strips what InetAddress.toString() actually sends', () => {
  expect(parseAddress('/192.168.1.77')).toBe('192.168.1.77')
  expect(parseAddress('chromecast.lan/192.168.1.77')).toBe('192.168.1.77')
  expect(parseAddress('192.168.1.77')).toBe('192.168.1.77')
  expect(parseAddress('/fe80::1%wlan0')).toBe('fe80::1%wlan0')
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

async function joinRun (ok = true) {
  const p = joinRendezvous()
  await flush()
  const req = lastOf('remote-start')
  if (req) { workletSays({ type: 'remote-started', ok, role: req.role, tag: req.tag }); await flush() }
  return { joined: await p, req }
}

test('a phone joins as a CONTROLLER — it never announces itself, so it is never a target', async () => {
  const { joined, req } = await joinRun()
  expect(joined).toBe(true)
  expect(req).toMatchObject({ type: 'remote-start', role: 'controller', acceptPlay: true })
  expect(typeof req.label).toBe('string')
  expect(req.label.length).toBeGreaterThan(0)
})

test('joined once per session: a later catalog push does not re-join', async () => {
  await joinRun()
  const before = sent().filter((m) => m?.type === 'remote-start').length
  await joinRendezvous()
  await flush()
  expect(sent().filter((m) => m?.type === 'remote-start').length).toBe(before)
})

test('a refused join is NOT latched — the next catalog push tries again', async () => {
  const { joined } = await joinRun(false)
  expect(joined).toBe(false)
  const before = sent().filter((m) => m?.type === 'remote-start').length
  await joinRun()
  expect(sent().filter((m) => m?.type === 'remote-start').length).toBe(before + 1)
})

test('sign-out leaves the rendezvous, stops the send, and re-arms the join', async () => {
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

  // …and the NEXT sign-in joins again, rather than the feature being silently absent for
  // the rest of the app run.
  const before = sent().filter((m) => m?.type === 'remote-start').length
  await joinRun()
  expect(sent().filter((m) => m?.type === 'remote-start').length).toBe(before + 1)
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

test('the handoff family is NOT excluded — a deviceId is a picker handle, not a secret', () => {
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
