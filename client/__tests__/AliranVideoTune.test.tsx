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
