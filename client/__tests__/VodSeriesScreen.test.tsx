// The series detail screen (S54c / D3·D8·D9, mockup screen 5). Pins the product
// decisions rather than the pixels:
//   - the header renders from what the GRID already knew, before the provider answers;
//   - the provider's 0-10 rating becomes five stars (rating/2) plus the number;
//   - season tiles carry the episode-count badge and SWITCH the episode list;
//   - an episode hands the player everything the watch history needs (id/kind/seriesId)
//     and resumes where THIS DEVICE left off;
//   - "Start" is a resume: the newest history entry for this series wins, otherwise the
//     first episode of the first season;
//   - an episode the provider gave no playable (https) url for shows a notice and is
//     NEVER handed to the player;
//   - My List is a whole-array replace through the worklet, newest first.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'

jest.mock('../src/vod/zencontent', () => ({ getSeriesInfo: jest.fn() }))

import { VodSeriesScreen, episodeTitle, ratingStars } from '../src/screens/VodSeriesScreen'
import { getSeriesInfo } from '../src/vod/zencontent'
import { backend } from '../src/worklet'

const mockInfo = getSeriesInfo as unknown as jest.Mock

const VOD = {
  enabled: true as const,
  apiBase: 'https://provider.example/api',
  service: 'svc',
  sources: { movies: 'movies-src', series: 'series-src' },
  params: {}
}

const DETAIL = {
  plot: 'Two scientists and a lot of portals.',
  genre: 'Animation, Comedy',
  director: 'A Director',
  cast: 'A Cast',
  rating: '8.0',
  releasedate: '2019-10-05 - 2026-07-18',
  icon: 'https://art.example/s1.jpg',
  seasons: [
    { id: 'se1', number: 1, title: 'Season 1', icon: '', airDate: '2019-10-05', episodeCount: 2 },
    { id: 'se2', number: 2, title: 'Season 2', icon: '', airDate: '2020-10-05', episodeCount: 1 }
  ],
  episodes: [
    { id: 'e1', seasonId: 'se1', number: 1, title: 'Pilot', plot: 'The first one.', icon: '', url: 'https://cdn.example/s1e1.m3u8', durationSec: 3060 },
    { id: 'e2', seasonId: 'se1', number: 2, title: 'Lawnmower Dog', plot: 'The second one.', icon: '', url: 'https://cdn.example/s1e2.m3u8', durationSec: 3000 },
    { id: 'e3', seasonId: 'se2', number: 1, title: 'A Rickle in Time', plot: 'No path from the provider.', icon: '', url: '', durationSec: 2900 }
  ]
}

const PARAMS = { id: 's1', name: 'Rick and Morty', icon: 'https://art.example/s1.jpg', anio: '2013' }

const nav = { navigate: jest.fn(), goBack: jest.fn() }
const props = { navigation: nav, route: { params: PARAMS, key: 'k', name: 'VodSeries' } } as any

const mounted: RendererInstance[] = []
async function createTree (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}
beforeEach(() => {
  mockInfo.mockResolvedValue({ ok: true, detail: DETAIL })
  ;(backend as any).vod = VOD
  ;(backend as any).vodList = []
  ;(backend as any).vodHistory = []
})
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  nav.navigate.mockClear(); nav.goBack.mockClear(); mockInfo.mockReset()
  ;(backend as any).vod = null
  ;(backend as any).vodList = []
  ;(backend as any).vodHistory = []
})

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
}
// The Pressable COMPOSITE carries onPress; its host layers only carry the role.
function pressableLabelled (tree: RendererInstance, label: string) {
  return tree.root.findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .filter(n => n.findAllByType(Text).some(t => String(t.props.children) === label))[0]
}
async function press (tree: RendererInstance, label: string) {
  const p = pressableLabelled(tree, label)
  expect(p).toBeTruthy()
  await ReactTestRenderer.act(async () => { await p!.props.onPress() })
}
async function mount () { return createTree(<VodSeriesScreen {...props} />) }

// --- pure helpers -------------------------------------------------------------------

test('the provider rates out of ten; the row shows five stars and the number', () => {
  const full = String.fromCharCode(0x2605)
  const empty = String.fromCharCode(0x2606)
  expect(ratingStars('8.0')).toEqual({ stars: full.repeat(4) + empty, value: '8.0' })
  expect(ratingStars('10')).toEqual({ stars: full.repeat(5), value: '10.0' })
  expect(ratingStars('7')).toEqual({ stars: full.repeat(4) + empty, value: '7.0' }) // 3.5 -> 4
  expect(ratingStars('2.2')).toEqual({ stars: full + empty.repeat(4), value: '2.2' })
  // Unrated titles get no row at all — a 0.0 would libel every one of them.
  expect(ratingStars('0')).toBeNull()
  expect(ratingStars('')).toBeNull()
  expect(ratingStars('n/a')).toBeNull()
})

test('the player title names the series, the episode code and the episode', () => {
  expect(episodeTitle('Rick and Morty', 1, { number: 2, title: 'Lawnmower Dog' }))
    .toBe('Rick and Morty S1E2 ' + String.fromCharCode(0x2014) + ' Lawnmower Dog')
  // An untitled episode keeps just the code — no trailing dash into nothing.
  expect(episodeTitle('Rick and Morty', 2, { number: 3, title: '' })).toBe('Rick and Morty S2E3')
})

// --- the screen ---------------------------------------------------------------------

test('the header renders from the route before the provider answers, then fills in', async () => {
  let resolve!: (v: unknown) => void
  mockInfo.mockReturnValue(new Promise((r) => { resolve = r }))
  const tree = await createTree(<VodSeriesScreen {...props} />)
  let t = texts(tree)
  expect(t).toContain('Rick and Morty (2013)') // instant, from the grid's params
  expect(t).toContain('Loading episodes…')

  await ReactTestRenderer.act(async () => { resolve({ ok: true, detail: DETAIL }) })
  t = texts(tree)
  expect(mockInfo).toHaveBeenCalledWith(VOD, 's1')
  expect(t).toContain('2019-10-05 - 2026-07-18')
  expect(t).toContain('Animation, Comedy')
  expect(t).toContain('8.0')
  expect(t).toContain(String.fromCharCode(0x2605).repeat(4) + String.fromCharCode(0x2606))
  expect(t).toContain('Two scientists and a lot of portals.')
})

test('a failed detail call names sign-in vs connection, never a code', async () => {
  mockInfo.mockResolvedValue({ ok: false, error: 'network' })
  const t = texts(await mount())
  expect(t).toContain("Couldn't reach the movie catalog")
  expect(t).not.toContain('network')
})

test('season tiles carry the episode count and switch the episode list', async () => {
  const tree = await mount()
  let t = texts(tree)
  expect(t).toContain('Season 1')
  expect(t).toContain('Season 2')
  // the first season is selected on arrival, so its episodes are the ones listed
  expect(t).toContain('Pilot')
  expect(t).toContain('Lawnmower Dog')
  expect(t).not.toContain('A Rickle in Time')
  expect(t).toContain('51:00') // the duration chip, from durationSec 3060

  await press(tree, 'Season 2')
  t = texts(tree)
  expect(t).toContain('A Rickle in Time')
  expect(t).not.toContain('Lawnmower Dog')
})

test('an episode hands the player everything the watch history needs', async () => {
  const tree = await mount()
  await press(tree, 'Lawnmower Dog')
  expect(nav.navigate).toHaveBeenCalledWith('VodPlayer', {
    url: 'https://cdn.example/s1e2.m3u8',
    title: 'Rick and Morty S1E2 ' + String.fromCharCode(0x2014) + ' Lawnmower Dog',
    durationSec: 3000,
    id: 'e2',
    kind: 'episode',
    seriesId: 's1'
  })
})

test('an episode this device already started carries its resume position', async () => {
  ;(backend as any).vodHistory = [
    { kind: 'episode', id: 'e2', seriesId: 's1', title: 'x', positionSec: 754, durationSec: 3000, at: 5 }
  ]
  const tree = await mount()
  expect(texts(tree)).toContain('Resume at 12:34')
  await press(tree, 'Lawnmower Dog')
  expect(nav.navigate.mock.calls[0][1].resumeSec).toBe(754)
})

test('an episode with no playable url shows a notice and is never played', async () => {
  const tree = await mount()
  await press(tree, 'Season 2')
  await press(tree, 'A Rickle in Time')
  expect(texts(tree)).toContain('This episode has no playable video yet. Try another one.')
  expect(nav.navigate).not.toHaveBeenCalled()
})

test('Start with no history plays the first episode of the first season', async () => {
  const tree = await mount()
  await press(tree, 'Start')
  const [, params] = nav.navigate.mock.calls[0]
  expect(params.id).toBe('e1')
  expect(params.resumeSec).toBeUndefined()
})

test('Start resumes the newest history entry for THIS series, at its position', async () => {
  ;(backend as any).vodHistory = [
    { kind: 'episode', id: 'e1', seriesId: 's1', title: 'x', positionSec: 30, durationSec: 3060, at: 100 },
    { kind: 'episode', id: 'e2', seriesId: 's1', title: 'x', positionSec: 600, durationSec: 3000, at: 900 },
    { kind: 'episode', id: 'zz', seriesId: 'other', title: 'x', positionSec: 10, durationSec: 3000, at: 9999 },
    { kind: 'movie', id: 'm1', title: 'x', positionSec: 10, durationSec: 3000, at: 99999 }
  ]
  const tree = await mount()
  await press(tree, 'Start')
  const [, params] = nav.navigate.mock.calls[0]
  expect(params.id).toBe('e2')
  expect(params.resumeSec).toBe(600)
  expect(params.seriesId).toBe('s1')
})

test('a finished episode (stored position 0) restarts from the top', async () => {
  ;(backend as any).vodHistory = [
    { kind: 'episode', id: 'e2', seriesId: 's1', title: 'x', positionSec: 0, durationSec: 3000, at: 900 }
  ]
  const tree = await mount()
  expect(texts(tree)).toContain('Watched')
  await press(tree, 'Start')
  const [, params] = nav.navigate.mock.calls[0]
  expect(params.id).toBe('e2')
  expect(params.resumeSec).toBeUndefined()
})

test('the My List button toggles a device-local series entry, newest first', async () => {
  const spy = jest.spyOn(backend, 'setVodList').mockImplementation(() => {})
  ;(backend as any).vodList = [{ kind: 'movie', id: 'm9' }]
  const tree = await mount()
  await press(tree, 'Add to My List')
  expect(spy).toHaveBeenCalledWith([{ kind: 'series', id: 's1' }, { kind: 'movie', id: 'm9' }])
  let t = texts(tree)
  expect(t).toContain('Remove from My List')
  expect(t).toContain('Added to My List.')

  await press(tree, 'Remove from My List')
  expect(spy).toHaveBeenLastCalledWith([{ kind: 'movie', id: 'm9' }])
  expect(texts(tree)).toContain('Add to My List')
  spy.mockRestore()
})

test('a prefs message is the truth about what was stored', async () => {
  const tree = await mount()
  expect(texts(tree)).toContain('Add to My List')
  await ReactTestRenderer.act(async () => {
    ;(backend as any).onData(JSON.stringify({
      type: 'prefs', creds: null, favorites: [], vodList: [{ kind: 'series', id: 's1' }], vodHistory: []
    }) + '\n')
  })
  expect(texts(tree)).toContain('Remove from My List')
})
