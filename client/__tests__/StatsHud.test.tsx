// The Debug overlay (StatsHud) — rendering contract: worklet stats + player-side ref
// values paint as rows, the health label derives honestly (GOOD/FAIR/POOR/CDN, and a
// dash — never a grade — when nothing is known), and a null getStats() reply (worklet
// busy / engine-less build) renders dashes instead of crashing or going stale-bold.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import type { StatsMessage } from '@aliran/react-native'
import { StatsHud, healthLabel, emptyHudVideoStats, type HudVideoStats } from '../src/components/StatsHud'
import { backend } from '../src/worklet'

const MB = 1048576

function sample (over: Partial<StatsMessage['engine']> = {}, net: Partial<StatsMessage['net']> = {}): StatsMessage {
  return {
    type: 'stats',
    at: 1000,
    os: { cpuPercent: 42, rssBytes: 200 * MB, freeMem: 500 * MB, totalMem: 2048 * MB, loadAvg1: 1.5 },
    engine: { source: 'p2p', streamId: 'news', feedPeers: 3, swarmPeers: 7, ...over },
    net: { rxBps: 512 * 1024, txBps: 20 * 1024, ...net },
    store: { driveBytes: 88 * MB }
  }
}

function texts (tree: RendererInstance): string[] {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join(''))
}

const mounted: RendererInstance[] = []
async function mount (videoStats: React.MutableRefObject<HudVideoStats>) {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<StatsHud videoStats={videoStats} />) })
  await ReactTestRenderer.act(async () => {}) // flush the initial pull's promise
  mounted.push(tree)
  return tree
}

afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  jest.restoreAllMocks()
})

// --- healthLabel: the derivation is a pure function, pin it directly ---

test('healthLabel grades honestly', () => {
  expect(healthLabel(null, null)).toBe('—')
  expect(healthLabel(sample({ source: null }), null)).toBe('—')
  expect(healthLabel(sample({ source: 'cdn' }), 2_000_000)).toBe('CDN')
  // 3+ peers, download rate covers the bitrate (512 KiB/s * 8 > 2 Mbps) -> GOOD
  expect(healthLabel(sample(), 2_000_000)).toBe('GOOD')
  // unknown bitrate/rate must never demote — a dash is not evidence of trouble
  expect(healthLabel(sample(), null)).toBe('GOOD')
  expect(healthLabel(sample({}, { rxBps: null }), 2_000_000)).toBe('GOOD')
  // 1-2 peers -> FAIR
  expect(healthLabel(sample({ feedPeers: 1 }), null)).toBe('FAIR')
  // measured starvation demotes even with peers: 10 KB/s against 8 Mbps
  expect(healthLabel(sample({}, { rxBps: 10 * 1024 }), 8_000_000)).toBe('POOR')
  // no peers on p2p -> POOR, whatever else says
  expect(healthLabel(sample({ feedPeers: 0 }), null)).toBe('POOR')
})

// --- rendering ---

test('renders worklet stats and player-side values as rows', async () => {
  jest.spyOn(backend, 'getStats').mockResolvedValue(sample())
  const videoStats = { current: { bufferSec: 4.2, bitrateBps: 2_000_000, codec: 'avc1.64001f', width: 1920, height: 1080 } }
  const tree = await mount(videoStats)
  const all = texts(tree)
  expect(all).toContain('P2P · 3 peers')
  expect(all).toContain('GOOD')
  expect(all).toContain('4.2 s')
  expect(all).toContain('2.0 Mbps')
  expect(all).toContain('1920×1080 · avc1.64001f')
  expect(all).toContain('7 conn')
  expect(all).toContain('88.0 MB')
  expect(all).toContain('42 %')
})

test('a cdn source says CDN and never grades a swarm', async () => {
  jest.spyOn(backend, 'getStats').mockResolvedValue(sample({ source: 'cdn', feedPeers: 0 }, { rxBps: null, txBps: null }))
  const tree = await mount({ current: emptyHudVideoStats() })
  const all = texts(tree)
  expect(all).toContain('CDN') // both the SRC row and HEALTH
  expect(all.filter(s => s === 'CDN').length).toBe(2)
  expect(all).not.toContain('POOR')
})

test('a null reply renders dashes, not a crash and not stale numbers', async () => {
  jest.spyOn(backend, 'getStats').mockResolvedValue(null)
  const tree = await mount({ current: emptyHudVideoStats() })
  const all = texts(tree)
  expect(all.filter(s => s === '—').length).toBeGreaterThanOrEqual(5)
  expect(all).not.toContain('GOOD')
})
