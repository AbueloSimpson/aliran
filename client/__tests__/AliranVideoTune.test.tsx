// <AliranVideo> tune lifecycle — the state machine behind the tuning pill (see the
// header of sdk/react-native/src/AliranVideo.tsx). ONE localhost URL serves every P2P
// channel, so raw player events also fire for the PREVIOUS channel until the engine
// flips the served feed — the S22 2026-07-16 regressions were a pill stuck at 90% over
// playing video and the next zap's pill dismissed instantly by stale events. These
// tests drive a fake backend + a mock react-native-video and pin the guarantees:
// only the CURRENT tune's mount can fire 'playing', a zap replaces the tune, engine
// self-heal states relabel + re-arm it, and the friendly error ends it.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { AliranVideo, type AliranBackend, type TuneEvent } from '@aliran/react-native'

// These tests never boot a worklet (the backend below is a fake) — stub the native
// binding so importing the SDK doesn't drag in TurboModule spec files.
jest.mock('react-native-bare-kit', () => ({ Worklet: class {} }))

// Mock the player: records every render's props (so tests can fire the callbacks a
// given mount holds) and counts MOUNTS — a remount is how <AliranVideo> flushes the
// previous channel's playlist/buffer when the served feed changes under the shared URL.
let mockVideoRenders: any[] = []
let mockVideoMounts = 0
jest.mock('react-native-video', () => {
  const ReactActual = require('react')
  return function MockVideo (props: any) {
    ReactActual.useEffect(() => { mockVideoMounts++ }, [])
    mockVideoRenders.push(props)
    return null
  }
})

const URL = 'http://127.0.0.1:7357/index.m3u8'

function makeBackend () {
  const listeners = new Set<(m: any) => void>()
  return {
    url: URL,
    source: 'p2p',
    headers: null as Record<string, string> | null, // provider playback headers; see the headers test
    activeStreamId: null as string | null,
    play: jest.fn(),
    reconnect: jest.fn(),
    onMessage (fn: (m: any) => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    emit (m: any) { listeners.forEach(fn => fn(m)) }
  }
}

function lastVideo () { return mockVideoRenders[mockVideoRenders.length - 1] }
function playingEvents (events: TuneEvent[]) { return events.filter(e => e.phase === 'playing') }

// Track every rendered tree and unmount it after the test — the stall watchdog runs a
// real 1 s interval that otherwise outlives the test and blocks jest worker teardown.
const mounted: RendererInstance[] = []
async function createTree (el: React.ReactElement) {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  mounted.push(tree)
  return tree
}

beforeEach(() => {
  mockVideoRenders = []
  mockVideoMounts = 0
})

afterEach(async () => {
  while (mounted.length) {
    const tree = mounted.pop()!
    await ReactTestRenderer.act(async () => { tree.unmount() })
  }
})

test('zap: stale player events cannot complete the new tune; the port reply remounts and the fresh mount does', async () => {
  const backend = makeBackend()
  const events: TuneEvent[] = []
  const el = (streamId: string) => (
    <AliranVideo backend={backend as unknown as AliranBackend} streamId={streamId} controls={false} onTune={(e) => events.push(e)} />
  )
  const tree = await createTree(el('a'))

  // Mount = tune 1 for 'a'; play() sent; the engine has not confirmed a serve yet.
  expect(events).toEqual([{ id: 1, streamId: 'a', phase: 'start' }])
  expect(backend.play).toHaveBeenCalledWith('a')

  // Playback events BEFORE the engine confirms the URL serves 'a' are the previous
  // session's feed still playing — they must not complete the tune.
  await ReactTestRenderer.act(async () => {
    lastVideo().onProgress({ currentTime: 1 })
    lastVideo().onBuffer({ isBuffering: false })
    lastVideo().onReadyForDisplay()
  })
  expect(playingEvents(events)).toHaveLength(0)

  // Engine confirms 'a' → first real playback completes tune 1.
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
  await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 2 }) })
  expect(playingEvents(events)).toEqual([{ id: 1, streamId: 'a', phase: 'playing' }])

  // ZAP to 'b': a new tune replaces the old one; the old channel keeps playing under
  // the same URL — none of its events may complete tune 2 (the "pill dismissed
  // instantly / stuck forever" class).
  await ReactTestRenderer.act(async () => { tree.update(el('b')) })
  expect(events).toContainEqual({ id: 2, streamId: 'b', phase: 'start' })
  const staleMount = lastVideo()
  await ReactTestRenderer.act(async () => {
    staleMount.onProgress({ currentTime: 3 })
    staleMount.onBuffer({ isBuffering: false })
    staleMount.onReadyForDisplay()
  })
  expect(playingEvents(events)).toHaveLength(1)

  // The 'b' port reply flips the served channel → remount (flush the old playlist).
  const mountsBefore = mockVideoMounts
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'b' }) })
  expect(mockVideoMounts).toBe(mountsBefore + 1)

  // Callbacks still held by the OUTGOING mount are epoch-stale — inert.
  await ReactTestRenderer.act(async () => {
    staleMount.onReadyForDisplay()
    staleMount.onProgress({ currentTime: 4 })
  })
  expect(playingEvents(events)).toHaveLength(1)

  // The fresh mount's first playback completes tune 2 — exactly once.
  await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 0.5 }) })
  await ReactTestRenderer.act(async () => { lastVideo().onReadyForDisplay() })
  expect(playingEvents(events)).toEqual([
    { id: 1, streamId: 'a', phase: 'playing' },
    { id: 2, streamId: 'b', phase: 'playing' }
  ])
})

test('re-entry on the resumed channel completes without a remount', async () => {
  const backend = makeBackend()
  backend.activeStreamId = 'a' // the engine already serves 'a' (screen re-entry)
  const events: TuneEvent[] = []
  await createTree(
    <AliranVideo backend={backend as unknown as AliranBackend} streamId="a" controls={false} onTune={(e) => events.push(e)} />
  )
  // Live from the start: the already-playing mount completes the tune on first progress,
  // no waiting for the play() reply.
  await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 }) })
  expect(playingEvents(events)).toEqual([{ id: 1, streamId: 'a', phase: 'playing' }])
  // The confirming port reply for the SAME channel must not remount (no re-buffer blip).
  const mountsBefore = mockVideoMounts
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
  expect(mockVideoMounts).toBe(mountsBefore)
})

test('engine self-heal relabels the tune and re-arms completion; the friendly error ends it', async () => {
  const backend = makeBackend()
  const events: TuneEvent[] = []
  const errors: string[] = []
  await createTree(
    <AliranVideo
      backend={backend as unknown as AliranBackend}
      streamId="a" controls={false}
      onTune={(e) => events.push(e)} onError={(m) => errors.push(m)}
    />
  )
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
  await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 }) })
  expect(playingEvents(events)).toHaveLength(1)

  // Tune watchdog cycles (feed:retune → feed:reconnect): the host is told, and the
  // tune re-arms so the recovery's fresh playback completes it AGAIN instead of the
  // pill freezing at 90% forever.
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'status', state: 'feed:retune' }) })
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'status', state: 'feed:reconnect' }) })
  expect(events).toContainEqual({ id: 1, streamId: 'a', phase: 'retune' })
  expect(events).toContainEqual({ id: 1, streamId: 'a', phase: 'reconnect' })
  await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 2 }) })
  expect(playingEvents(events)).toHaveLength(2)

  // The friendly tune-timeout error ENDS the tune — playback events after it must not
  // resurrect 'playing'; the host's error UI owns the screen now.
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'status', state: 'feed:retune' }) })
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'error', message: 'tune timeout: no video' }) })
  expect(errors).toEqual(['tune timeout: no video'])
  await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 3 }) })
  expect(playingEvents(events)).toHaveLength(2)
})

test('a stall resync starts a fresh tune (new id) and completes on the resync mount', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const events: TuneEvent[] = []
    const stalls = jest.fn()
    await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="a" controls={false} stallTimeoutMs={12000}
        onTune={(e) => events.push(e)} onStall={stalls}
      />
    )
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 }) })
    expect(playingEvents(events)).toEqual([{ id: 1, streamId: 'a', phase: 'playing' }])

    // Playhead sits still past the stall window → resync: onStall + a NEW tune id
    // (the pill restarts from scratch) + a remount.
    const mountsBefore = mockVideoMounts
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(13000) })
    expect(stalls).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({ id: 2, streamId: 'a', phase: 'start' })
    expect(mockVideoMounts).toBe(mountsBefore + 1)

    // The resync mount's fresh playback completes the NEW tune.
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 5 }) })
    expect(playingEvents(events)).toEqual([
      { id: 1, streamId: 'a', phase: 'playing' },
      { id: 2, streamId: 'a', phase: 'playing' }
    ])
  } finally {
    jest.useRealTimers()
  }
})

// THE GIVE-UP LANE. The stall ladder used to remount forever at a flat 12 s: on a TCL
// Android 14 box (2026-08-14) a wedged player rebuilt ~150 ExoPlayer/MediaCodec pairs and
// ART aborted the process, while the FEED was healthy throughout — which is also why no
// engine-side error ever arrived to stop it (player.js's watchdog kept standing down on the
// healthy feed and restarting its own countdown). So the bound has to live HERE, and this
// test pins all four of its properties: the windows double, the attempts are capped, a spent
// ladder goes quiet, and only real playback — never a remount — buys attempts back.
test('the stall ladder backs off, gives up with a friendly error, and stays spent until playback', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const stalls = jest.fn()
    const errors = jest.fn()
    await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="a" controls={false} stallTimeoutMs={12000}
        onStall={stalls} onError={errors}
      />
    )
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 }) })
    const mountsBefore = mockVideoMounts

    // Each failed resync doubles the window: 12 s, then 24 s, then 48 s. A flat ladder would
    // have fired 3 times by 36 s and 7 times by 84 s.
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(12000) })
    expect(stalls).toHaveBeenCalledTimes(1)
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(23000) }) // t=35 s: still inside the 24 s window
    expect(stalls).toHaveBeenCalledTimes(1)
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(1000) }) // t=36 s
    expect(stalls).toHaveBeenCalledTimes(2)
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(48000) }) // t=84 s
    expect(stalls).toHaveBeenCalledTimes(3)

    // Three resyncs, three remounts, and the transport teardown on every rung from the 2nd.
    expect(mockVideoMounts).toBe(mountsBefore + 3)
    expect(backend.reconnect).toHaveBeenCalledTimes(2)
    expect(errors).not.toHaveBeenCalled()

    // The 4th rung GIVES UP: a friendly error instead of a remount, and no 4th onStall.
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(96000) }) // t=180 s
    expect(stalls).toHaveBeenCalledTimes(3)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][0]).toMatch(/switch to it again to retry/)
    expect(mockVideoMounts).toBe(mountsBefore + 3) // the give-up did NOT remount

    // SPENT MEANS SPENT. Ten minutes with the playhead still buys nothing — no second error,
    // no remount. A ladder that re-armed on its own would loop here forever, which is the
    // failure this bound exists to prevent.
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(600000) })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(stalls).toHaveBeenCalledTimes(3)
    expect(mockVideoMounts).toBe(mountsBefore + 3)

    // …and REAL PLAYBACK is what re-arms it: the playhead moves, the ladder resets, and a
    // fresh freeze earns a fresh first rung at the full 12 s.
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 9 }) })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(12000) })
    expect(stalls).toHaveBeenCalledTimes(4)
  } finally {
    jest.useRealTimers()
  }
})

// The other half of that contract, and the reason onError's text says "switch to it again":
// the ladder's spent state lives in a ref, so the host's retry has to UNMOUNT this component
// (LiveScreen renders the error instead of <AliranVideo>, then re-selecting the channel
// clears it). A host that left the player mounted would hand the viewer a retry button that
// silently does nothing.
test('a re-select after the give-up error mounts a fresh component with a clean ladder', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const stalls = jest.fn()
    const tree = await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="a" controls={false} stallTimeoutMs={12000}
        onStall={stalls} onError={jest.fn()}
      />
    )
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 }) })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(180000) }) // run the ladder out
    expect(stalls).toHaveBeenCalledTimes(3)

    // The host's error UI takes the screen: <AliranVideo> unmounts.
    await ReactTestRenderer.act(async () => { tree.unmount() })
    mounted.splice(mounted.indexOf(tree), 1)

    // Re-selecting the SAME channel clears the error and mounts a fresh one — whose ladder
    // starts at rung 1 again, not spent.
    const restalls = jest.fn()
    await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="a" controls={false} stallTimeoutMs={12000}
        onStall={restalls} onError={jest.fn()}
      />
    )
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 }) })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(12000) })
    expect(restalls).toHaveBeenCalledTimes(1)
  } finally {
    jest.useRealTimers()
  }
})

// THE ERROR GIVE-UP LANE — the stall give-up's sibling, on a faster clock. The <Video>
// onError retry used to remount every 2.5 s forever: against a persistent failure
// (loopback server dead, feed gone, a 404 that never heals) that is ExoPlayer's ~3 s of
// load retries → onError → 2.5 s → a full ExoPlayer/MediaCodec rebuild, every ~5.5 s with
// no report and no give-up — the codec-churn class that SIGABRTed the TCL box on the stall
// path (2026-08-14), ~2x faster, and with no engine error coming (a redirect channel has no
// feed to watch; a dead loopback server reports nothing). This test pins the bound's four
// properties: the waits double, the attempts are capped with a friendly error, a spent
// ladder goes quiet, and only real playback — never a remount — buys attempts back.
test('the error retry ladder backs off, gives up with a friendly error, and stays spent until playback', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const stalls = jest.fn()
    const errors = jest.fn()
    const buffering = jest.fn()
    await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="a" controls={false} stallTimeoutMs={12000}
        onStall={stalls} onError={errors} onBuffering={buffering}
      />
    )
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
    const mountsBefore = mockVideoMounts

    // Error 1 → the FAST first retry at 2.5 s: the transient contract (a segment lost to
    // a replica rotation edge) must not get slower because persistent failures exist.
    await ReactTestRenderer.act(async () => { lastVideo().onError() })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(2500) })
    expect(mockVideoMounts).toBe(mountsBefore + 1)

    // Error 2 → 5 s. Negative assertion inside the window: a flat 2.5 s ladder would
    // have remounted again by 4.9 s.
    await ReactTestRenderer.act(async () => { lastVideo().onError() })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(4900) })
    expect(mockVideoMounts).toBe(mountsBefore + 1)
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(100) })
    expect(mockVideoMounts).toBe(mountsBefore + 2)

    // A mount that LOOKS up but never progresses is not recovery: first-frame and
    // buffer-idle signals must not reset the ladder — only onProgress motion may.
    await ReactTestRenderer.act(async () => {
      lastVideo().onBuffer({ isBuffering: false })
      lastVideo().onReadyForDisplay()
    })

    // Error 3 → 10 s (the reset-less schedule continued: ReadyForDisplay bought nothing).
    await ReactTestRenderer.act(async () => { lastVideo().onError() })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(9900) })
    expect(mockVideoMounts).toBe(mountsBefore + 2)
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(100) })
    expect(mockVideoMounts).toBe(mountsBefore + 3)
    expect(errors).not.toHaveBeenCalled()

    // Error 4 → GIVE UP: a friendly error, no fourth remount, and no spinner re-arm
    // (the error UI owns the screen — onBuffering(true) belongs to retries only).
    const bufferingTrues = buffering.mock.calls.filter(([b]) => b === true).length
    await ReactTestRenderer.act(async () => { lastVideo().onError() })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][0]).toMatch(/switch to it again to retry/)
    expect(buffering.mock.calls.filter(([b]) => b === true).length).toBe(bufferingTrues)
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(600000) })
    expect(mockVideoMounts).toBe(mountsBefore + 3)

    // SPENT MEANS SPENT. Further errors over ten simulated minutes buy nothing — no
    // second friendly error, no remount. A ladder that re-armed on its own would loop
    // at the give-up boundary, which is the failure this bound exists to prevent.
    await ReactTestRenderer.act(async () => { lastVideo().onError() })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(600000) })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(mockVideoMounts).toBe(mountsBefore + 3)

    // The stall ladder never joined in: error churn without playback is tune-phase
    // recovery, and a never-played mount must not trip stall resyncs on top.
    expect(stalls).not.toHaveBeenCalled()

    // …and REAL PLAYBACK is what re-arms it: the playhead moves, the ladder resets, and
    // the next error earns a fresh first rung at the fast 2.5 s.
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 9 }) })
    await ReactTestRenderer.act(async () => { lastVideo().onError() })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(2500) })
    expect(mockVideoMounts).toBe(mountsBefore + 4)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(stalls).not.toHaveBeenCalled()
  } finally {
    jest.useRealTimers()
  }
})

// The transient contract the 2.5 s retry exists for, unchanged by the bound: only
// CONSECUTIVE failures back off, because real playback between errors resets the ladder.
// Without the reset, every channel would creep toward the give-up over a long session.
test('real playback between errors keeps the retry at the fast first rung', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const errors = jest.fn()
    await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="a" controls={false} stallTimeoutMs={12000} onError={errors}
      />
    )
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 }) })
    const mountsBefore = mockVideoMounts

    // A transient: one error, one fast retry…
    await ReactTestRenderer.act(async () => { lastVideo().onError() })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(2500) })
    expect(mockVideoMounts).toBe(mountsBefore + 1)

    // …and the retry mount PLAYS, which resets the ladder: the next error is a fresh
    // transient, not consecutive failure #2 — an unreset ladder would wait 5 s here.
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 2 }) })
    await ReactTestRenderer.act(async () => { lastVideo().onError() })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(2400) })
    expect(mockVideoMounts).toBe(mountsBefore + 1)
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(100) })
    expect(mockVideoMounts).toBe(mountsBefore + 2)
    expect(errors).not.toHaveBeenCalled()
  } finally {
    jest.useRealTimers()
  }
})

// The other half of the give-up contract — same reason as the stall re-select lane: the
// spent state lives in a ref, so the retry the error text offers has to be a host-side
// RE-SELECT that unmounts this component. This lane also pins that the error-UI path
// genuinely re-arms: the fresh mount completes its tune on real playback, and its ladder
// starts at the fast first rung — not spent, not backed off.
test('a re-select after the error give-up mounts a fresh component with a clean retry ladder', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const errors = jest.fn()
    const tree = await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="a" controls={false} stallTimeoutMs={12000} onError={errors}
      />
    )
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
    // Run the ladder out: three backed-off retries (2.5 s, 5 s, 10 s), then the 4th
    // consecutive error is the give-up.
    for (const wait of [2500, 5000, 10000]) {
      await ReactTestRenderer.act(async () => { lastVideo().onError() })
      await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(wait) })
    }
    await ReactTestRenderer.act(async () => { lastVideo().onError() })
    expect(errors).toHaveBeenCalledTimes(1)

    // The host's error UI takes the screen: <AliranVideo> unmounts.
    await ReactTestRenderer.act(async () => { tree.unmount() })
    mounted.splice(mounted.indexOf(tree), 1)

    // Re-selecting the channel mounts a fresh component. Its tune completes on real
    // playback — the retry the error UI offered genuinely works…
    const events: TuneEvent[] = []
    const rerrors = jest.fn()
    await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="a" controls={false} stallTimeoutMs={12000}
        onTune={(e) => events.push(e)} onError={rerrors}
      />
    )
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 }) })
    expect(playingEvents(events)).toHaveLength(1)

    // …and its ladder is CLEAN: a fresh error retries at the fast 2.5 s first rung. A
    // spent ladder would never remount; an inherited one would give up on the spot.
    const mountsBefore = mockVideoMounts
    await ReactTestRenderer.act(async () => { lastVideo().onError() })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(2500) })
    expect(mockVideoMounts).toBe(mountsBefore + 1)
    expect(rerrors).not.toHaveBeenCalled()
  } finally {
    jest.useRealTimers()
  }
})

// THE OFFLINE WATCHDOG LANES (NO_ANSWER / CDN_TUNE). A dead REDIRECT channel is the class
// neither ladder above can see: the engine never arms its tune watchdog for a redirect
// ("the host player owns its own errors"), and a host that hangs the TCP connect — or
// answers 200 with something the loader chews on forever — never surfaces a player error
// either. Before the bound, that was the ~80% pill forever (2026-08-15). These lanes pin
// the wall-clock termination: a confirmed cdn source with no first frame ends at 30 s, a
// play() the engine never answers ends at 15 s, a second consecutive permanent HTTP
// refusal ends immediately, and p2p tunes NEVER trip it (the engine owns that class).

test('offline watchdog: a confirmed cdn source with no playback ends the tune at 30 s', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const REMOTE = 'https://provider.example/dead/e1.m3u8'
    const errors = jest.fn()
    await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="dead" controls={false} stallTimeoutMs={12000} onError={errors}
      />
    )
    backend.url = REMOTE; backend.source = 'cdn'
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', url: REMOTE, source: 'cdn', streamId: 'dead' }) })

    // The player mounted, produces neither a frame nor an error (the hanging-host
    // shape). 29 s in: still inside the window — a slow link must not false-trip.
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(29000) })
    expect(errors).not.toHaveBeenCalled()

    // 30 s: the watchdog ends the tune with the offline marker.
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(2000) })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][0]).toMatch(/switch to it again to retry/)
    expect(errors.mock.calls[0][1]).toEqual({ code: 'offline' })

    // Spent means spent — same contract as the ladders: no second error, and a late
    // player error cannot restart the retry loop behind the error UI.
    const mountsBefore = mockVideoMounts
    await ReactTestRenderer.act(async () => { lastVideo().onError() })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(600000) })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(mockVideoMounts).toBe(mountsBefore)
  } finally {
    jest.useRealTimers()
  }
})

test('offline watchdog: a play() the engine never answers ends the tune at 15 s', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    ;(backend as any).url = null // nothing resolved yet: no <Video> ever mounts
    const errors = jest.fn()
    await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="a" controls={false} stallTimeoutMs={12000} onError={errors}
      />
    )
    expect(backend.play).toHaveBeenCalledWith('a')
    expect(mockVideoRenders).toHaveLength(0) // url null → no player, no player events, ever

    // 14 s: a slow resolve is still allowed to land.
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(14000) })
    expect(errors).not.toHaveBeenCalled()

    // 15 s with no 'port' (and no 'error') for this stream: the worklet is gone, not
    // slow — the watchdog is the only thing that can ever end this tune.
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(2000) })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][1]).toEqual({ code: 'offline' })
  } finally {
    jest.useRealTimers()
  }
})

test('offline watchdog: a zap from a playing channel is still bounded when the worklet goes silent', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const errors = jest.fn()
    const el = (streamId: string) => (
      <AliranVideo backend={backend as unknown as AliranBackend} streamId={streamId} controls={false} stallTimeoutMs={12000} onError={errors} />
    )
    const tree = await createTree(el('a'))
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 }) })

    // Zap to 'b'; the worklet never answers. The OLD channel keeps playing under the
    // same URL — a CONTINUOUSLY advancing playhead, which keeps the stall lane quiet
    // (no freeze to resync) and used to shield the new tune via the played latch:
    // the eternal-pill-over-playing-video shape. NO_ANSWER must fire through it.
    await ReactTestRenderer.act(async () => { tree.update(el('b')) })
    for (let s = 1; s <= 4; s++) {
      await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(4000) })
      await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 + s * 4 }) }) // the old channel, still rolling
    }
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][1]).toEqual({ code: 'offline' })
  } finally {
    jest.useRealTimers()
  }
})

test('offline watchdog: autoPlay={false} sends no play() and earns no NO_ANSWER verdict', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    ;(backend as any).url = null
    const errors = jest.fn()
    await createTree(
      <AliranVideo backend={backend as unknown as AliranBackend} streamId="a" controls={false} autoPlay={false} stallTimeoutMs={12000} onError={errors} />
    )
    expect(backend.play).not.toHaveBeenCalled()
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(60000) })
    expect(errors).not.toHaveBeenCalled() // nothing was asked, so nothing failed to answer
  } finally {
    jest.useRealTimers()
  }
})

test('offline watchdog: a paused tune is parked, not billed', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const REMOTE = 'https://provider.example/paused/e1.m3u8'
    const errors = jest.fn()
    await createTree(
      <AliranVideo backend={backend as unknown as AliranBackend} streamId="p" controls={false} paused stallTimeoutMs={12000} onError={errors} />
    )
    backend.url = REMOTE; backend.source = 'cdn'
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', url: REMOTE, source: 'cdn', streamId: 'p' }) })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(90000) })
    expect(errors).not.toHaveBeenCalled() // no frame was ever ASKED for
  } finally {
    jest.useRealTimers()
  }
})

test('offline watchdog: the give-up also spends the stall ladder — no resurrection over the error UI', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const REMOTE = 'https://provider.example/frozen/e1.m3u8'
    const errors = jest.fn()
    const stalls = jest.fn()
    const events: TuneEvent[] = []
    await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="fz" controls={false} stallTimeoutMs={12000}
        onError={errors} onStall={stalls} onTune={(e) => events.push(e)}
      />
    )
    backend.url = REMOTE; backend.source = 'cdn'
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', url: REMOTE, source: 'cdn', streamId: 'fz' }) })
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 }) })

    // The cdn stream plays, then freezes with no error event: the stall ladder runs
    // (resync 1 ~12 s, resync 2 ~+24 s), and the offline watchdog fires 30 s into a
    // resync's tune before the 48 s third window can.
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(70000) })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][1]).toEqual({ code: 'offline' })
    const stallsAtGiveUp = stalls.mock.calls.length
    const startsAtGiveUp = events.filter(e => e.phase === 'start').length

    // SPENT MEANS BOTH LADDERS. Ten more minutes must produce no further resync
    // (the tuning pill must not resurrect over the error UI), no second error.
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(600000) })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(stalls.mock.calls.length).toBe(stallsAtGiveUp)
    expect(events.filter(e => e.phase === 'start').length).toBe(startsAtGiveUp)
  } finally {
    jest.useRealTimers()
  }
})

test('offline watchdog: a 403 pair is a token-rotation suspect — the THIRD consecutive refusal gives up, not the second', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const REMOTE = 'https://provider.example/token/e1.m3u8'
    const errors = jest.fn()
    await createTree(
      <AliranVideo backend={backend as unknown as AliranBackend} streamId="tk" controls={false} stallTimeoutMs={12000} onError={errors} />
    )
    backend.url = REMOTE; backend.source = 'cdn'
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', url: REMOTE, source: 'cdn', streamId: 'tk' }) })
    const mountsBefore = mockVideoMounts

    // 403 #1 -> retry at 2.5 s; 403 #2 -> STILL retries (5 s — a rotation window can
    // straddle two attempts); 403 #3 -> the provider means it, give up now.
    await ReactTestRenderer.act(async () => { lastVideo().onError({ error: { errorString: 'Response code: 403' } }) })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(2500) })
    expect(mockVideoMounts).toBe(mountsBefore + 1)
    await ReactTestRenderer.act(async () => { lastVideo().onError({ error: { errorString: 'Response code: 403' } }) })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(5000) })
    expect(mockVideoMounts).toBe(mountsBefore + 2)
    expect(errors).not.toHaveBeenCalled()
    await ReactTestRenderer.act(async () => { lastVideo().onError({ error: { errorString: 'Response code: 403' } }) })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][1]).toEqual({ code: 'offline' })
  } finally {
    jest.useRealTimers()
  }
})

test('offline watchdog: the second consecutive permanent HTTP refusal on cdn ends the tune immediately', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const REMOTE = 'https://provider.example/gone/e1.m3u8'
    const errors = jest.fn()
    await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="gone" controls={false} stallTimeoutMs={12000} onError={errors}
      />
    )
    backend.url = REMOTE; backend.source = 'cdn'
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', url: REMOTE, source: 'cdn', streamId: 'gone' }) })
    const mountsBefore = mockVideoMounts

    // Refusal 1 gets the one retry the token-rotation race earns (event playlists
    // rotate tokens — a single 403 can be a stale-token edge, not a dead channel).
    await ReactTestRenderer.act(async () => { lastVideo().onError({ error: { errorString: 'Response code: 404' } }) })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(2500) })
    expect(mockVideoMounts).toBe(mountsBefore + 1)
    expect(errors).not.toHaveBeenCalled()

    // Refusal 2 is the provider saying no — give up NOW (~5 s in), not at ~27 s.
    await ReactTestRenderer.act(async () => { lastVideo().onError({ error: { errorString: 'Response code: 404' } }) })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][1]).toEqual({ code: 'offline' })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(600000) })
    expect(mockVideoMounts).toBe(mountsBefore + 1) // no further retry mounts behind the error UI
  } finally {
    jest.useRealTimers()
  }
})

test('offline watchdog: a p2p tune never trips it — the engine owns that class', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const errors = jest.fn()
    await createTree(
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId="a" controls={false} stallTimeoutMs={12000} onError={errors}
      />
    )
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'a' }) })

    // Two minutes of confirmed-p2p tuning with no playback: the engine's own tune
    // watchdog owns this (retune → reconnect → friendly 'error' message), and the
    // offline watchdog must not preempt it with a false 'channel offline'.
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(120000) })
    expect(errors).not.toHaveBeenCalled()
  } finally {
    jest.useRealTimers()
  }
})

// Playback headers (redirect channels behind a provider hotlink check): the engine hands
// them to the HOST with the url, and this component is what actually gets them onto the
// wire — ExoPlayer reads source.headers once, when it opens the media, so a headers
// change has to reach it as a REMOUNT, not a re-render. The fake backend mutates its
// fields before dispatching, exactly like the real one (see sdk/react-native/src/backend.ts).
test('a port reply with headers puts them on the player source, and a headers-only change remounts', async () => {
  const backend = makeBackend()
  const REMOTE = 'https://provider.example/live/e1.m3u8?token=aaa'
  const h1 = { referer: 'https://provider.example/', 'user-agent': 'AliranTest/1.0' }
  const h2 = { referer: 'https://provider.example/', 'user-agent': 'AliranTest/2.0' }
  const events: TuneEvent[] = []
  await createTree(
    <AliranVideo backend={backend as unknown as AliranBackend} streamId="promo" controls={false} onTune={(e) => events.push(e)} />
  )
  backend.url = REMOTE; backend.headers = h1
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', url: REMOTE, source: 'cdn', streamId: 'promo', headers: h1 }) })
  expect(lastVideo().source.uri).toBe(REMOTE)
  expect(lastVideo().source.headers).toEqual(h1)

  // Same url, different headers (a provider that rotates only its UA — our feed-owned
  // header writes make that a real shape). The player must be torn down and reopened
  // with the new set, and it must go through the REMOUNT path, not the mount key alone:
  // the key would swap the mount while the epoch stood still, and a trailing event from
  // the dead player would then complete the new tune (the S22 stale-event regression).
  const mountsBefore = mockVideoMounts
  const stalePlayer = lastVideo()
  backend.headers = h2
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', url: REMOTE, source: 'cdn', streamId: 'promo', headers: h2 }) })
  expect(mockVideoMounts).toBe(mountsBefore + 1)
  expect(lastVideo().source.headers).toEqual(h2)
  await ReactTestRenderer.act(async () => { stalePlayer.onBuffer({ isBuffering: false }) })
  expect(playingEvents(events)).toHaveLength(0) // epoch moved: the torn-down mount is stale
  await ReactTestRenderer.act(async () => { lastVideo().onBuffer({ isBuffering: false }) })
  expect(playingEvents(events)).toHaveLength(1) // the live mount still completes it

  // A hybrid fallback swaps in the operator's OWN url — the provider's headers must not
  // follow it there.
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'fallback', streamId: 'promo', url: URL, reason: 'stall' }) })
  expect(lastVideo().source.uri).toBe(URL)
  expect(lastVideo().source.headers).toBeUndefined()
})
