// VodPlayerScreen plumbing (S53 / D3, extended in S54c / D7·D9). The provider's title
// plays on plain react-native-video — NOT through <AliranVideo> and not through the
// engine (there is no feed, no peer, no localhost server here). What this pins:
//   - the resolved URL reaches <Video source={{uri}}> unchanged;
//   - the transport is fed by the PLAYER's own onLoad/onProgress;
//   - a playback failure is a sentence, never an ExoPlayer code;
//   - the DEVICE-LOCAL watch history is written on a throttle, flushed on the way out,
//     de-duped newest-first, and stores 0 for a title watched to the end;
//   - a caller that names no title is never remembered;
//   - resumeSec seeks once on load;
//   - subtitle/audio tracks flow player -> TrackMenu -> the <Video> selection props.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'

let mockVideoProps: any[] = []
jest.mock('react-native-video', () => {
  const ReactActual = require('react')
  return {
    __esModule: true,
    // The SDK re-exports SelectedTrackType FROM react-native-video, so a mock that drops
    // it takes the whole track model down with it (@aliran/react-native would hand the
    // screen an undefined enum).
    SelectedTrackType: { SYSTEM: 'system', DISABLED: 'disabled', TITLE: 'title', LANGUAGE: 'language', INDEX: 'index' },
    default: function MockVideo (props: any) {
      ReactActual.useImperativeHandle(props.ref, () => ({ seek: (s: number) => mockSeeks.push(s) }))
      mockVideoProps.push(props)
      return null
    }
  }
})
const mockSeeks: number[] = []

import { VodPlayerScreen, HISTORY_STEP_SEC } from '../src/screens/VodPlayerScreen'
import { TrackMenu } from '../src/components/TrackMenu'
import { backend } from '../src/worklet'

const URL = 'https://cdn.example/heat.mp4'
const nav = { goBack: jest.fn(), navigate: jest.fn() }
function propsFor (params: Record<string, unknown>) {
  return { navigation: nav, route: { params, key: 'k', name: 'VodPlayer' } } as any
}
/** A named movie — the shape the grid hands over so the title can be remembered (D9). */
const MOVIE = { url: URL, title: 'Heat', id: '3', kind: 'movie' as const }

const setHistory = jest.spyOn(backend, 'setVodHistory').mockImplementation(() => {})
/** The entries handed to the worklet on the nth write. */
function written (nth = 0) { return setHistory.mock.calls[nth][0] }

const mounted: RendererInstance[] = []
async function createTree (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}
async function unmountAll () {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
}
afterEach(async () => {
  await unmountAll()
  mockVideoProps = []; mockSeeks.length = 0; nav.goBack.mockClear()
  setHistory.mockClear()
  ;(backend as any).vodHistory = []
})

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).join(' | ')
}
function last () { return mockVideoProps[mockVideoProps.length - 1] }
// The Pressable COMPOSITE carries onPress; its host layers only carry the role.
function pressable (tree: RendererInstance) {
  return tree.root.findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')[0]
}

test('plays the resolved URL directly, with no engine in the path', async () => {
  await createTree(<VodPlayerScreen {...propsFor({ url: URL, title: 'Heat' })} />)
  expect(last().source).toEqual({ uri: URL })
  expect(last().controls).toBe(false)
  expect(last().paused).toBe(false)
  // The engine's props have no business here — this is a plain provider URL.
  expect(last().backend).toBeUndefined()
  expect(last().streamId).toBeUndefined()
})

test('the transport follows the player: onLoad sets the runtime, onProgress the elapsed', async () => {
  const tree = await createTree(<VodPlayerScreen {...propsFor({ url: URL, title: 'Heat' })} />)
  expect(texts(tree)).toContain('Starting Heat…') // loading state until the player reports
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 5525 }) })
  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: 754.4 }) })
  const t = texts(tree)
  expect(t).toContain('12:34') // elapsed
  expect(t).toContain('1:32:05') // runtime
  expect(t).not.toContain('Starting Heat…')
})

test('the provider-stated runtime shows before the player reports one', async () => {
  const tree = await createTree(<VodPlayerScreen {...propsFor({ url: URL, title: 'Heat', durationSec: 5525 })} />)
  expect(texts(tree)).toContain('1:32:05')
})

test('play/pause toggles the player, and ▶ at the end replays from the top', async () => {
  const tree = await createTree(<VodPlayerScreen {...propsFor({ url: URL, title: 'Heat' })} />)
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 100 }) })
  const play = pressable(tree)
  await ReactTestRenderer.act(async () => { play.props.onPress() })
  expect(last().paused).toBe(true)
  expect(texts(tree)).toContain('▶')

  // End of title parks on ▶; pressing it seeks back to 0 rather than no-opping.
  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: 100 }) })
  await ReactTestRenderer.act(async () => { last().onEnd() })
  await ReactTestRenderer.act(async () => { pressable(tree).props.onPress() })
  expect(mockSeeks).toContain(0)
})

// --- device-local watch history (D9) -----------------------------------------------

test('history is written on a throttle, not on every progress tick', async () => {
  await createTree(<VodPlayerScreen {...propsFor(MOVIE)} />)
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 1000 }) })

  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: 3 }) })
  expect(setHistory).not.toHaveBeenCalled() // inside the first step

  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: HISTORY_STEP_SEC + 2 }) })
  expect(setHistory).toHaveBeenCalledTimes(1)
  expect(written()[0]).toMatchObject({ kind: 'movie', id: '3', title: 'Heat', positionSec: 12, durationSec: 1000 })
  expect(written()[0].at).toBeGreaterThan(0)

  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: 15 }) })
  expect(setHistory).toHaveBeenCalledTimes(1) // still inside the step
  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: 25 }) })
  expect(setHistory).toHaveBeenCalledTimes(2)
})

test('leaving the screen flushes the position the throttle had not stored yet', async () => {
  await createTree(<VodPlayerScreen {...propsFor(MOVIE)} />)
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 1000 }) })
  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: 4 }) })
  expect(setHistory).not.toHaveBeenCalled()

  await unmountAll()
  expect(setHistory).toHaveBeenCalledTimes(1)
  expect(written()[0].positionSec).toBe(4)
})

test('a title watched to the end is stored as position 0 — seen it, start again', async () => {
  await createTree(<VodPlayerScreen {...propsFor(MOVIE)} />)
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 1000 }) })
  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: 960 }) }) // 96%
  expect(written()[0]).toMatchObject({ positionSec: 0, durationSec: 1000 })

  await ReactTestRenderer.act(async () => { last().onEnd() })
  expect(written(1)[0].positionSec).toBe(0)
  // and the flush on the way out must not undo it
  await unmountAll()
  for (const call of setHistory.mock.calls) expect(call[0][0].positionSec).toBe(0)
})

test('a write replaces this title in place and moves it to the front', async () => {
  ;(backend as any).vodHistory = [
    { kind: 'movie', id: 'other', title: 'Zulu', positionSec: 5, durationSec: 100, at: 1 },
    { kind: 'movie', id: '3', title: 'Heat', positionSec: 5, durationSec: 1000, at: 2 }
  ]
  await createTree(<VodPlayerScreen {...propsFor(MOVIE)} />)
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 1000 }) })
  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: 30 }) })
  const entries = written()
  expect(entries).toHaveLength(2)
  expect(entries[0]).toMatchObject({ id: '3', positionSec: 30 })
  expect(entries[1]).toMatchObject({ id: 'other' })
})

test('an episode carries its parent series into the history', async () => {
  await createTree(<VodPlayerScreen {...propsFor({
    url: URL, title: 'Rick and Morty S1E2', id: 'e2', kind: 'episode', seriesId: 's1'
  })} />)
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 3000 }) })
  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: 40 }) })
  expect(written()[0]).toMatchObject({ kind: 'episode', id: 'e2', seriesId: 's1' })
})

test('a title the caller did not name is never remembered', async () => {
  await createTree(<VodPlayerScreen {...propsFor({ url: URL, title: 'Heat' })} />)
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 1000 }) })
  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: 400 }) })
  await ReactTestRenderer.act(async () => { last().onEnd() })
  await unmountAll()
  expect(setHistory).not.toHaveBeenCalled()
})

test('resumeSec seeks once, on load', async () => {
  const tree = await createTree(<VodPlayerScreen {...propsFor({ ...MOVIE, resumeSec: 754 })} />)
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 5525 }) })
  expect(mockSeeks).toEqual([754])
  expect(texts(tree)).toContain('12:34') // the bar shows the resumed playhead at once

  // a re-fired onLoad (rn-video does that on a source refresh) must not yank it back
  await ReactTestRenderer.act(async () => { last().onProgress({ currentTime: 800 }) })
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 5525 }) })
  expect(mockSeeks).toEqual([754])
})

// --- subtitle / audio tracks (D7) ---------------------------------------------------

const TEXT_TRACKS = [{ index: 0, title: 'English', language: 'en', type: 'text/vtt', selected: false }]
const AUDIO_TRACKS = [
  { index: 0, title: 'Original', language: 'ja', selected: true },
  { index: 1, title: 'Dubbed', language: 'es', selected: false }
]
function ccButton (tree: RendererInstance) {
  return tree.root.findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .filter(n => n.findAllByType(Text).some(t => String(t.props.children) === 'CC'))[0]
}

test('the CC button appears only once the player reports something to choose', async () => {
  const tree = await createTree(<VodPlayerScreen {...propsFor(MOVIE)} />)
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 1000 }) })
  expect(ccButton(tree)).toBeUndefined()

  // a single audio track is not a choice; a subtitle track is
  await ReactTestRenderer.act(async () => { last().onAudioTracks({ audioTracks: [AUDIO_TRACKS[0]] }) })
  expect(ccButton(tree)).toBeUndefined()
  await ReactTestRenderer.act(async () => { last().onTextTracks({ textTracks: TEXT_TRACKS }) })
  expect(ccButton(tree)).toBeTruthy()
})

test('the menu opens with the player-reported tracks and its choice reaches <Video>', async () => {
  const tree = await createTree(<VodPlayerScreen {...propsFor(MOVIE)} />)
  await ReactTestRenderer.act(async () => { last().onLoad({ duration: 1000 }) })
  await ReactTestRenderer.act(async () => {
    last().onTextTracks({ textTracks: TEXT_TRACKS })
    last().onAudioTracks({ audioTracks: AUDIO_TRACKS })
  })
  // subtitles start off, audio on the stream's own default
  expect(last().selectedTextTrack).toEqual({ type: 'disabled' })
  expect(last().selectedAudioTrack).toBeUndefined()

  await ReactTestRenderer.act(async () => { ccButton(tree).props.onPress() })
  const menu = tree.root.findByType(TrackMenu)
  expect(menu.props.textTracks).toEqual(TEXT_TRACKS)
  expect(menu.props.audioTracks).toEqual(AUDIO_TRACKS)

  // trackChoice prefers LANGUAGE (the ExoPlayer flat-vs-group index trap, S7 lore)
  const row = (label: string) => menu.findAll(n => typeof n.props.onPress === 'function' && n.findAllByType(Text).some(t => String(t.props.children) === label))[0]
  await ReactTestRenderer.act(async () => { row('English').props.onPress() })
  expect(last().selectedTextTrack).toEqual({ type: 'language', value: 'en' })
  expect(tree.root.findAllByType(TrackMenu)).toHaveLength(0) // choosing dismisses

  await ReactTestRenderer.act(async () => { ccButton(tree).props.onPress() })
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TrackMenu)
      .findAll(n => typeof n.props.onPress === 'function' && n.findAllByType(Text).some(t => String(t.props.children) === 'Dubbed'))[0]
      .props.onPress()
  })
  expect(last().selectedAudioTrack).toEqual({ type: 'language', value: 'es' })
})

test('a playback failure is a friendly sentence and unmounts the player', async () => {
  const tree = await createTree(<VodPlayerScreen {...propsFor({ url: URL, title: 'Heat' })} />)
  await ReactTestRenderer.act(async () => { last().onError({ error: { errorCode: 'ERROR_CODE_IO_BAD_HTTP_STATUS', errorString: '403' } }) })
  const t = texts(tree)
  expect(t).toContain("This title won't play")
  expect(t).not.toContain('ERROR_CODE_IO_BAD_HTTP_STATUS')
  expect(t).not.toContain('403')
})
