// <AliranVideo> vod behavior (S8a): the engine's 'port' reply carries recordType —
// 'vod' means the URL serves a FINISHED library title, where a still playhead
// (paused, seeking, end of title) is by design. The live-edge stall ladder (resync
// remount → transport teardown) must disarm for vod — a resync would yank playback
// back to 0:00 — and re-arm the moment a zap lands on a live channel again. The
// imperative handle seeks the CURRENT mount (the localhost server does full Range).

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { AliranVideo, type AliranBackend, type AliranVideoHandle } from '@aliran/react-native'

jest.mock('react-native-bare-kit', () => ({ Worklet: class {} }))

// Mock player: records renders/mounts like the tune test, and exposes seek() through
// the ref so the AliranVideoHandle path is testable (React 19 ref-as-prop).
let mockVideoRenders: any[] = []
let mockVideoMounts = 0
let mockSeeks: number[] = []
jest.mock('react-native-video', () => {
  const ReactActual = require('react')
  return function MockVideo (props: any) {
    ReactActual.useImperativeHandle(props.ref, () => ({ seek: (s: number) => mockSeeks.push(s) }))
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
    recordType: null as 'live' | 'vod' | null,
    durationSec: null as number | null,
    play: jest.fn(),
    reconnect: jest.fn(),
    onMessage (fn: (m: any) => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    emit (m: any) { listeners.forEach(fn => fn(m)) }
  }
}

function lastVideo () { return mockVideoRenders[mockVideoRenders.length - 1] }

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
  mockSeeks = []
})

afterEach(async () => {
  while (mounted.length) {
    const tree = mounted.pop()!
    await ReactTestRenderer.act(async () => { tree.unmount() })
  }
})

test('vod disarms the stall ladder; a zap to a live channel re-arms it', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    const stalls = jest.fn()
    const el = (streamId: string) => (
      <AliranVideo
        backend={backend as unknown as AliranBackend}
        streamId={streamId} controls={false} stallTimeoutMs={12000}
        onStall={stalls}
      />
    )
    const tree = await createTree(el('movie'))

    // Engine confirms the serve is a vod title, playback starts, then the playhead
    // sits still (paused/seeking/finished — all look identical from here) far past
    // the stall window: NO resync (the remount would restart the title at 0:00).
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'movie', recordType: 'vod', durationSec: 5525 }) })
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 1 }) })
    const mountsBefore = mockVideoMounts
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(60000) })
    expect(stalls).not.toHaveBeenCalled()
    expect(mockVideoMounts).toBe(mountsBefore)
    expect(backend.reconnect).not.toHaveBeenCalled()

    // Zap back to live TV: the live port reply re-arms the ladder — a frozen live
    // edge must resync exactly as before the vod detour.
    await ReactTestRenderer.act(async () => { tree.update(el('ch1')) })
    await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'ch1', recordType: 'live' }) })
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 2 }) })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(13000) })
    expect(stalls).toHaveBeenCalledTimes(1)
  } finally {
    jest.useRealTimers()
  }
})

test('re-entry on a title the engine already serves starts disarmed (backend seed)', async () => {
  jest.useFakeTimers()
  try {
    const backend = makeBackend()
    backend.activeStreamId = 'movie'
    backend.recordType = 'vod' // the singleton backend remembers across screen unmounts
    const stalls = jest.fn()
    await createTree(
      <AliranVideo backend={backend as unknown as AliranBackend} streamId="movie" controls={false} stallTimeoutMs={12000} onStall={stalls} />
    )
    // Plays immediately (already-served re-entry), then sits still — the seed alone
    // must keep the ladder off before any fresh port reply arrives.
    await ReactTestRenderer.act(async () => { lastVideo().onProgress({ currentTime: 42 }) })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(60000) })
    expect(stalls).not.toHaveBeenCalled()
  } finally {
    jest.useRealTimers()
  }
})

test('the handle seeks the current mount', async () => {
  const backend = makeBackend()
  const handle = React.createRef<AliranVideoHandle>()
  await createTree(
    <AliranVideo ref={handle} backend={backend as unknown as AliranBackend} streamId="movie" controls={false} />
  )
  await ReactTestRenderer.act(async () => { backend.emit({ type: 'port', port: 7357, url: URL, source: 'p2p', streamId: 'movie', recordType: 'vod', durationSec: 5525 }) })
  await ReactTestRenderer.act(async () => { handle.current!.seek(754) })
  expect(mockSeeks).toEqual([754])
})
