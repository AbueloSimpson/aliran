// useEpgProgramsState (WS17): the loading-truth variant of useEpgPrograms — same
// fetch/caching path (both wrap one core), plus a `ready` flag that stays false
// until the FIRST resolution for the current inputs lands. The phone guide rows
// use it to show skeleton cells instead of the honest "No program information"
// answer while the answer isn't known yet. Guide-less inputs (no guideBase and no
// epgUrl/epgId pair) resolve ready:true immediately with [] — nothing will ever
// be fetched, so the honest placeholder may show at once.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import { epg, useEpgProgramsState, useEpgPrograms, type EpgProgram } from '@aliran/react-native'

// Probe components — render the hook result as inspectable text.
function StateProbe ({ epgUrl, epgId, guideBase }: { epgUrl?: string; epgId?: string; guideBase?: string }) {
  const { programs, ready } = useEpgProgramsState(epgUrl, epgId, guideBase)
  return <Text>{`ready:${ready} titles:${programs.map(p => p.title).join(',')}`}</Text>
}
function PlainProbe ({ epgUrl, epgId }: { epgUrl?: string; epgId?: string }) {
  const programs = useEpgPrograms(epgUrl, epgId)
  return <Text>{`titles:${programs.map(p => p.title).join(',')}`}</Text>
}

function probeText (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
}

const mounted: RendererInstance[] = []
async function createTree (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  jest.restoreAllMocks()
})

const PROGRAM: EpgProgram = { title: 'Moon Cat A', start: Date.now() - 6e5, stop: Date.now() + 6e5 }

test('ready flips false → true when the first fetch resolves', async () => {
  // A deferred promise: the fetch stays in flight until WE resolve it, so the
  // pre-resolution render is observable.
  let resolve!: (p: EpgProgram[]) => void
  jest.spyOn(epg, 'getPrograms').mockReturnValue(new Promise<EpgProgram[]>((r) => { resolve = r }))
  const tree = await createTree(<StateProbe epgUrl="https://epg.example/a.json" epgId="moon-cat" />)
  expect(probeText(tree)).toBe('ready:false titles:') // in flight — NOT the no-guide answer
  await ReactTestRenderer.act(async () => { resolve([PROGRAM]) })
  expect(probeText(tree)).toBe('ready:true titles:Moon Cat A')
})

test('a channel with a guide pointer but an empty schedule is ready with [] — the honest answer', async () => {
  jest.spyOn(epg, 'getPrograms').mockResolvedValue([])
  const tree = await createTree(<StateProbe epgUrl="https://epg.example/a.json" epgId="moon-cat" />)
  expect(probeText(tree)).toBe('ready:true titles:')
})

test('guide-less inputs are ready immediately with [] and never fetch', async () => {
  const spy = jest.spyOn(epg, 'getPrograms')
  // No pointers at all, and the epgUrl-without-epgId half-pointer (both unfetchable).
  const none = await createTree(<StateProbe />)
  expect(probeText(none)).toBe('ready:true titles:')
  const half = await createTree(<StateProbe epgUrl="https://epg.example/a.json" />)
  expect(probeText(half)).toBe('ready:true titles:')
  expect(spy).not.toHaveBeenCalled()
})

test('an input change resets ready until the new channel resolves', async () => {
  let resolveSecond!: (p: EpgProgram[]) => void
  const spy = jest.spyOn(epg, 'getPrograms').mockResolvedValue([PROGRAM])
  const tree = await createTree(<StateProbe epgUrl="https://epg.example/a.json" epgId="moon-cat" />)
  expect(probeText(tree)).toBe('ready:true titles:Moon Cat A')
  spy.mockReturnValue(new Promise<EpgProgram[]>((r) => { resolveSecond = r }))
  await ReactTestRenderer.act(async () => { tree.update(<StateProbe epgUrl="https://epg.example/a.json" epgId="ninja-run" />) })
  expect(probeText(tree)).toBe('ready:false titles:') // the old channel's guide must not linger
  await ReactTestRenderer.act(async () => { resolveSecond([{ ...PROGRAM, title: 'Ninja Run' }]) })
  expect(probeText(tree)).toBe('ready:true titles:Ninja Run')
})

test('useEpgPrograms keeps its original contract — programs only, [] while loading', async () => {
  let resolve!: (p: EpgProgram[]) => void
  jest.spyOn(epg, 'getPrograms').mockReturnValue(new Promise<EpgProgram[]>((r) => { resolve = r }))
  const tree = await createTree(<PlainProbe epgUrl="https://epg.example/a.json" epgId="moon-cat" />)
  expect(probeText(tree)).toBe('titles:')
  await ReactTestRenderer.act(async () => { resolve([PROGRAM]) })
  expect(probeText(tree)).toBe('titles:Moon Cat A')
})
