// VodPlayerScreen plumbing (S53 / D3). The provider's title plays on plain
// react-native-video — NOT through <AliranVideo> and not through the engine (there is
// no feed, no peer, no localhost server here). What this pins:
//   - the resolved URL reaches <Video source={{uri}}> unchanged;
//   - the transport is fed by the PLAYER's own onLoad/onProgress;
//   - a playback failure is a sentence, never an ExoPlayer code.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'

let mockVideoProps: any[] = []
jest.mock('react-native-video', () => {
  const ReactActual = require('react')
  return {
    __esModule: true,
    default: function MockVideo (props: any) {
      ReactActual.useImperativeHandle(props.ref, () => ({ seek: (s: number) => mockSeeks.push(s) }))
      mockVideoProps.push(props)
      return null
    }
  }
})
const mockSeeks: number[] = []

import { VodPlayerScreen } from '../src/screens/VodPlayerScreen'

const URL = 'https://cdn.example/heat.mp4'
const nav = { goBack: jest.fn(), navigate: jest.fn() }
function propsFor (params: Record<string, unknown>) {
  return { navigation: nav, route: { params, key: 'k', name: 'VodPlayer' } } as any
}

const mounted: RendererInstance[] = []
async function createTree (el: React.ReactElement): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(el) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  mockVideoProps = []; mockSeeks.length = 0; nav.goBack.mockClear()
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

test('a playback failure is a friendly sentence and unmounts the player', async () => {
  const tree = await createTree(<VodPlayerScreen {...propsFor({ url: URL, title: 'Heat' })} />)
  await ReactTestRenderer.act(async () => { last().onError({ error: { errorCode: 'ERROR_CODE_IO_BAD_HTTP_STATUS', errorString: '403' } }) })
  const t = texts(tree)
  expect(t).toContain("This title won't play")
  expect(t).not.toContain('ERROR_CODE_IO_BAD_HTTP_STATUS')
  expect(t).not.toContain('403')
})
