// "Play on a TV" — the sheet a viewer actually sees.
//
// THE THING THIS SUITE EXISTS TO DEFEND is that the two ways to put a channel on a
// television never blur into one list. They are not interchangeable: a handoff leaves
// this phone free, a cast turns it into an origin server that must stay awake and whose
// stream is reachable by anything on the network that can read the URL off the
// television. A viewer who has never heard of either has one source of truth about which
// one they picked — this sheet — so the sections, their order, and the sentence under
// each of them are behavior, not decoration.
//
// The second thing is the unpinned state. A session runs unpinned whenever the platform
// gave no usable address for the receiver, and always for a speaker group — so unpinned
// is a normal outcome, not an edge case, and an unpinned session that says nothing is
// exactly the silent default the security review objected to.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Platform, Text } from 'react-native'

// The Cast library, with receivers on the end of it. jest.config.js already maps the
// package to __mocks__/react-native-google-cast.js — a device with no Play Services — and
// this factory takes precedence over that file for this suite. NOT `{ virtual: true }`:
// see the mock file for the resolver-cache race that spelling lost, which took the eight
// cast cases below down as a block on about one run in three.
//
// AND THE SESSION IS TWO STEPS HERE TOO. startSession() only means the MediaRouter
// selected a matching route; whether a Cast session exists is reported afterwards through
// onSessionStarted / onSessionStartFailed, and cast.connect() waits for it. The gap is
// modelled rather than skipped — see SendToTvCast.test.ts, where it is what is on trial.
const mockCast: any = {
  devices: [] as any[],
  playServices: 'success',
  deviceName: 'Kitchen display',
  sessionStartedListeners: [] as any[],
  sessionStartFailedListeners: [] as any[],
  session: null as string | null,
  mediaStatusListeners: [] as any[],
  endCurrentSession: jest.fn(async () => { mockCast.session = null }),
  loadMedia: jest.fn(async () => {})
}
function selectRoute () {
  return jest.fn(async (deviceId: string) => {
    // Reported on a LATER turn, never in the same one — selectRoute is fire-and-forget.
    Promise.resolve().then(() => {
      mockCast.session = deviceId
      for (const fn of [...mockCast.sessionStartedListeners]) fn({})
    })
    return true
  })
}
mockCast.startSession = selectRoute()
jest.mock('react-native-google-cast', () => ({
  CastContext: {
    getPlayServicesState: async () => mockCast.playServices,
    getDiscoveryManager: () => ({
      getDevices: async () => mockCast.devices,
      onDevicesUpdated: () => ({ remove: () => {} })
    }),
    getSessionManager: () => ({
      startSession: (id: string) => mockCast.startSession(id),
      endCurrentSession: mockCast.endCurrentSession,
      getCurrentCastSession: async () => (mockCast.session
        ? {
            client: {
              // A receiver that plays what it is given: the load is accepted, and the
              // status that proves it played follows on a later turn (see cast.ts).
              loadMedia: async (req: unknown) => {
                await mockCast.loadMedia(req)
                Promise.resolve().then(() => {
                  for (const fn of [...mockCast.mediaStatusListeners]) fn({ playerState: 'playing' })
                })
              },
              onMediaStatusUpdated: (fn: unknown) => { mockCast.mediaStatusListeners.push(fn); return { remove: () => {} } }
            },
            getCastDevice: async () => ({ deviceId: mockCast.session, friendlyName: mockCast.deviceName })
          }
        : null),
      onSessionStarted: (fn: unknown) => { mockCast.sessionStartedListeners.push(fn); return { remove: () => {} } },
      onSessionStartFailed: (fn: unknown) => { mockCast.sessionStartFailedListeners.push(fn); return { remove: () => {} } },
      onSessionEnded: () => ({ remove: () => {} })
    })
  }
}))

// What the ANDROID bridge really sends for a device: ipAddress is a stringified
// java.net.InetAddress ('hostname/1.2.3.4'), and a group is marked in `capabilities`.
const CHROMECAST = { deviceId: 'cc-1', friendlyName: 'Kitchen display', modelName: 'Chromecast', ipAddress: '/192.168.1.77', capabilities: ['VideoOut'] }
const SPEAKER_GROUP = { deviceId: 'cc-1', friendlyName: 'Whole house', ipAddress: '/192.168.1.77', capabilities: ['AudioOut', 'MultizoneGroup'] }

// CASTING IS PARKED IN THIS BUILD (src/cast.ts CAST_ENABLED), so castAvailable() answers no
// and the sheet draws no cast section at all. This suite is about what the sheet DOES with
// receivers, and that behaviour is the thing worth keeping under test while the feature
// waits — so it opts back in here, with the same probe the real one uses minus the flag.
// The parked decision itself is pinned in SendToTvCast.test.ts, against the real module.
jest.mock('../src/cast', () => ({
  ...jest.requireActual('../src/cast'),
  CAST_ENABLED: true,
  castAvailable: async () => mockCast.playServices === 'success'
}))

import { SendToTvSheet } from '../src/components/SendToTvSheet'
import { NowPlayingBar } from '../src/components/NowPlayingBar'
import { backend, type Stream } from '../src/worklet'
import { __resetForTests, watchPeers } from '../src/sendToTv'

const CHANNEL: Stream = { id: 'news', title: 'News 24', isLive: true }
const SESSION = {
  url: 'http://192.168.1.44:51234/cast/deadbeef/index.m3u8',
  streamId: 'news', source: 'p2p', host: '192.168.1.44', port: 51234
}

const TV = { deviceId: 'tv-1', label: 'Living room TV', role: 'tv', platform: 'android', appVersion: '0.5.0' }
const PHONE = { deviceId: 'ph-2', label: 'Kitchen phone', role: 'controller', platform: 'android', appVersion: '0.5.0' }

function sent (): any[] { return (backend as any).pending }
function lastOf (type: string): any {
  const all = sent().filter((m) => m?.type === type)
  return all[all.length - 1]
}
function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }

function texts (tree: RendererInstance): string[] {
  return tree.root.findAllByType(Text).map((t) => [t.props.children].flat(9).map(String).join(''))
}
function joined (tree: RendererInstance): string { return texts(tree).join(' | ') }
function rowFor (tree: RendererInstance, label: string) {
  const found = tree.root.findAll((n) => n.props?.accessibilityRole === 'button' && n.props?.accessibilityLabel === label)
  if (!found.length) throw new Error(`no device row for "${label}" in: ${joined(tree)}`)
  return found[0]
}
/** A button found by the words ON it — the Stop control carries its label as a child. */
function buttonSaying (tree: RendererInstance, text: string) {
  const found = tree.root.findAll((n) => n.props?.accessibilityRole === 'button' &&
    n.findAllByType(Text).some((t) => [t.props.children].flat(9).map(String).join('').includes(text)))
  if (!found.length) throw new Error(`no button saying "${text}" in: ${joined(tree)}`)
  // Pressable renders host views that inherit the role, so take the one that owns the press.
  return found.find((n) => typeof n.props.onPress === 'function') ?? found[0]
}

const mounted: RendererInstance[] = []
async function createTree (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}

const realOS = Platform.OS
let offPeers: (() => void) | null = null
beforeEach(() => {
  ;(Platform as { OS: string }).OS = 'android'
  __resetForTests()
  ;(backend as any).pending = []
  mockCast.devices = []
  mockCast.playServices = 'success'
  mockCast.deviceName = 'Kitchen display'
  mockCast.startSession = selectRoute()
  mockCast.endCurrentSession = jest.fn(async () => { mockCast.session = null })
  mockCast.loadMedia = jest.fn(async () => {})
  mockCast.session = null
  mockCast.sessionStartedListeners = []
  mockCast.sessionStartFailedListeners = []
  mockCast.mediaStatusListeners = []
  offPeers = watchPeers()
})
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  offPeers?.(); offPeers = null
  ;(Platform as { OS: string }).OS = realOS
  jest.restoreAllMocks()
})

// --- the two sections ---------------------------------------------------------------

test('handoff targets come FIRST, and casting is described as this phone doing the work', async () => {
  mockCast.devices = [CHROMECAST]
  workletSays({ type: 'remote-peers', peers: [TV] })
  const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)
  const all = texts(tree)
  const yours = all.findIndex((s) => s === 'YOUR DEVICES')
  const casts = all.findIndex((s) => s === 'CAST DEVICES')
  expect(yours).toBeGreaterThanOrEqual(0)
  expect(casts).toBeGreaterThan(yours) // the better mechanism is the one read first

  const body = all.join(' | ')
  // Each section says what happens to THIS PHONE, in the viewer's terms.
  expect(body).toContain('The TV gets the channel and plays it. You can then use this phone for other things.')
  expect(body).toContain('This phone sends the channel to the TV.')
  // …and the cast section carries the exposure warning where it is read, not in a footer
  // — including the fact that the app narrows it when it can, so the sentence does not
  // overstate a risk the active card may then say is closed. LIMITS, not PREVENTS: an
  // address check against a socket peer does not stop an attacker who can hold that
  // address, and the security model says exactly that.
  expect(body).toContain('Other devices on this network can also get the channel.')
  expect(body).toContain('The app limits this to the address of the TV when it knows the address.')
  expect(body).not.toContain('prevents')
  // Both targets are pickable.
  expect(() => rowFor(tree, 'Living room TV')).not.toThrow()
  expect(() => rowFor(tree, 'Kitchen display')).not.toThrow()
})

test('a controller is not a handoff target — a play sent to one is refused "unknown"', async () => {
  workletSays({ type: 'remote-peers', peers: [TV, PHONE] })
  const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)
  expect(joined(tree)).toContain('Living room TV')
  expect(joined(tree)).not.toContain('Kitchen phone')
})

test('no Cast framework on this device: the whole cast section is absent', async () => {
  mockCast.playServices = 'missing' // no Play Services — a Fire OS stick, an AOSP box
  workletSays({ type: 'remote-peers', peers: [TV] })
  const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)
  expect(joined(tree)).toContain('YOUR DEVICES')
  expect(joined(tree)).not.toContain('CAST DEVICES')
})

// --- the entry point ----------------------------------------------------------------

test('NowPlayingBar grows the TV button only when a handler is given', async () => {
  const props = { number: 1, clock: '17:45', favorite: false, onSearch: () => {}, onInfo: () => {}, onToggleFavorite: () => {}, onReport: () => {} }
  const without = await createTree(<NowPlayingBar stream={CHANNEL} {...props} />)
  expect(joined(without)).not.toContain('Play on TV')
  const withIt = await createTree(<NowPlayingBar stream={CHANNEL} {...props} onSendToTv={() => {}} />)
  expect(joined(withIt)).toContain('Play on TV')
})

// --- sending ------------------------------------------------------------------------

test('tapping a television asks IT to play — nothing is served from this phone', async () => {
  workletSays({ type: 'remote-peers', peers: [TV] })
  const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)
  await ReactTestRenderer.act(async () => { rowFor(tree, 'Living room TV').props.onPress() })
  const cmd = lastOf('remote-cmd')
  expect(cmd).toMatchObject({ cmd: 'play', deviceId: 'tv-1', streamId: 'news' })
  expect(lastOf('cast-start')).toBeUndefined()

  await ReactTestRenderer.act(async () => { workletSays({ type: 'remote-ack', ok: true, tag: cmd.tag }) })
  expect(joined(tree)).toContain('Living room TV plays the channel.')
  expect(joined(tree)).toContain('The TV plays the channel. You can use this phone for other things.')
})

test('a refusal is named, and "did not answer" is never dressed up as "said no"', async () => {
  workletSays({ type: 'remote-peers', peers: [TV] })
  const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)

  await ReactTestRenderer.act(async () => { rowFor(tree, 'Living room TV').props.onPress() })
  await ReactTestRenderer.act(async () => { workletSays({ type: 'remote-ack', ok: false, error: 'refused', tag: lastOf('remote-cmd').tag }) })
  expect(joined(tree)).toContain('That device does not accept commands.')

  await ReactTestRenderer.act(async () => { rowFor(tree, 'Living room TV').props.onPress() })
  await ReactTestRenderer.act(async () => { workletSays({ type: 'remote-ack', ok: false, error: 'timeout', tag: lastOf('remote-cmd').tag }) })
  const body = joined(tree)
  expect(body).toContain('That device did not answer. It can still start the channel.')
  expect(body).not.toContain('does not accept commands')
})

// --- what the active card says about exposure ---------------------------------------

/** The engine echoes its own normalised `receiverHost`, and the card is computed from
 *  THAT rather than from what the phone asked for — so the reply mirrors the request. */
async function castAndSettle (tree: RendererInstance, row = 'Kitchen display') {
  await ReactTestRenderer.act(async () => { rowFor(tree, row).props.onPress() })
  await ReactTestRenderer.act(async () => {
    const start = lastOf('cast-start')
    const session = { ...SESSION, ...(start.receiverHost ? { receiverHost: [start.receiverHost] } : {}) }
    workletSays({ type: 'cast-started', ok: true, session, tag: start.tag })
  })
}

test('a PINNED cast says what pinning actually delivers, and no more', async () => {
  mockCast.devices = [CHROMECAST]
  const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)
  await castAndSettle(tree)
  const body = joined(tree)
  expect(body).toContain('This phone sends to Kitchen display.')
  // NOT "only that TV can get the channel": the pin is an address check against a socket
  // peer, so it raises the bar to holding a position on the network that answers as the
  // television — it does not stop somebody who can. Both the security model and the SDK
  // say so, and the card is the one place a viewer reads it.
  expect(body).toContain('The app limits the channel to the address of the TV.')
  expect(body).not.toContain('Only that TV')
  expect(body).toContain('Keep the phone on. If you stop the phone, the TV stops.')
})

test('an UNPINNED cast says so on the card — it is never a silent default', async () => {
  // A device the platform gave no usable address for: the commonest real case.
  mockCast.devices = [{ ...CHROMECAST, ipAddress: undefined }]
  const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)
  await castAndSettle(tree)
  const body = joined(tree)
  expect(body).toContain('The app does not know the address of the TV. Other devices on this network can also get the channel.')
  expect(body).not.toContain('The app limits the channel to the address of the TV.')
})

test('a speaker GROUP gets its own sentence — one address would break the other members', async () => {
  mockCast.devices = [SPEAKER_GROUP]
  mockCast.deviceName = 'Whole house'
  const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)
  await castAndSettle(tree, 'Whole house')
  const body = joined(tree)
  expect(body).toContain('Each device in the group gets the channel.')
  expect(body).not.toContain('The app limits the channel to the address of the TV.')
  expect(lastOf('cast-start')).not.toHaveProperty('receiverHost')
})

// --- the controls that must not disappear -------------------------------------------

// STOP IS THE ONLY WAY TO SHUT DOWN A LAN ORIGIN SERVER, and it used to be mounted behind
// `playing` — a channel resolved out of the phone's own parental-filtered catalog. A cast
// depends on none of that: the operator removing the playing channel, a parental change
// over a restricted one, or any window with an empty catalog took the button away and left
// force-quit as the recovery, with the phone still decrypting and serving.
test('Stop is reachable with no channel playing — a cast outlives this phone\'s catalog', async () => {
  mockCast.devices = [CHROMECAST]
  const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)
  await castAndSettle(tree)

  // The catalog goes out from under it; the sheet re-mounts with nothing to send.
  await ReactTestRenderer.act(async () => { tree.update(<SendToTvSheet stream={null} onClose={() => {}} />) })
  const body = joined(tree)
  expect(body).toContain('This phone sends to Kitchen display.') // the session is still up
  expect(body).toContain('Stop')
  expect(body).toContain('No channel to send now.')

  await ReactTestRenderer.act(async () => { buttonSaying(tree, 'Stop').props.onPress() })
  const stop = lastOf('cast-stop')
  expect(stop).toBeTruthy()
  // Settle the request so stopSending() finishes inside the test rather than after it.
  await ReactTestRenderer.act(async () => { workletSays({ type: 'cast-stopped', ok: true, tag: stop.tag }) })
})

// "Looking for devices…" HAS A TERMINAL STATE. Discovery pushes an empty list for a network
// with no receivers — the ordinary case indoors — so without a deadline the phone spins for
// as long as the sheet is open and never says the plain thing.
test('discovery that finds nothing says so instead of spinning forever', async () => {
  jest.useFakeTimers()
  try {
    mockCast.devices = []
    const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)
    expect(joined(tree)).toContain('Looking for devices…')
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(9000) })
    const body = joined(tree)
    expect(body).not.toContain('Looking for devices…')
    expect(body).toContain('No cast devices. Make sure that the TV is on and on this Wi-Fi network.')
  } finally {
    jest.useRealTimers()
  }
})

test('the session URL is never rendered — the card shows names, not the token', async () => {
  mockCast.devices = [CHROMECAST]
  const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)
  await castAndSettle(tree)
  const body = joined(tree)
  expect(body).not.toContain('deadbeef')
  expect(body).not.toContain('/cast/')
})

test('a second tap cannot race the first: every other row goes inert while one runs', async () => {
  mockCast.devices = [CHROMECAST]
  workletSays({ type: 'remote-peers', peers: [TV] })
  const tree = await createTree(<SendToTvSheet stream={CHANNEL} onClose={() => {}} />)
  // Leave the cast start unanswered so the sheet stays busy on that row.
  await ReactTestRenderer.act(async () => { rowFor(tree, 'Kitchen display').props.onPress() })
  expect(lastOf('cast-start')).toBeTruthy()
  expect(rowFor(tree, 'Living room TV').props.onPress).toBeUndefined()
  await ReactTestRenderer.act(async () => {
    workletSays({ type: 'cast-started', ok: true, session: SESSION, tag: lastOf('cast-start').tag })
  })
  expect(rowFor(tree, 'Living room TV').props.onPress).toBeInstanceOf(Function)
})
