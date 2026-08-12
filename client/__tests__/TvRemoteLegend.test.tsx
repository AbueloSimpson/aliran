// The TV remote legend on the NowPlayingBar — the discoverability half of the D-pad
// work. Everything the pad does on Live is answered by an INVISIBLE focus strip (the S7
// focus engine), so before this line nothing on screen ever named a key: a viewer on a
// TCL set pressed left and right, got silence, and reported channel changing as broken
// when it had worked the whole time.
//
// What this suite pins:
//   * the legend names every direction the screen answers to — including the two that
//     used to do nothing — so a key can never be wired up without being advertised;
//   * it is TELEVISION ONLY (a phone teaches itself: the same bar carries labelled
//     buttons, and a legend there would be noise);
//   * the caps carry NO focusables, which is the rule the whole screen is built on —
//     one Pressable over the video hijacks the up/down zap engine;
//   * the words come from the catalog, not from English literals baked into the view.
//
// Platform.isTV is faked with ordered require()s rather than jest.isolateModules: an
// isolated registry hands screen tests a SECOND React, and hooks then throw
// (AcceptRemoteToggle's lesson).
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text, Pressable } from 'react-native'
import type { Stream } from '../src/worklet'

// theme.ts reads Platform.isTV ONCE, at module load, so the fake has to be in place
// before anything that reaches it is required. ES imports are hoisted; these are not.
const { Platform } = require('react-native')
const realIsTV = Object.getOwnPropertyDescriptor(Platform, 'isTV')!
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
const { NowPlayingBar } = require('../src/components/NowPlayingBar')
const { t } = require('@aliran/i18n')

afterAll(() => { Object.defineProperty(Platform, 'isTV', realIsTV) })

const stream: Stream = { id: 'news', title: 'News 24', isLive: true, description: 'via demotv' }
const props = {
  stream,
  number: 1,
  clock: '18:36',
  favorite: false,
  onSearch: () => {},
  onInfo: () => {},
  onToggleFavorite: () => {},
  onReport: () => {}
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
})

function texts (tree: RendererInstance): string {
  return tree.root.findAllByType(Text).map((n: any) => [n.props.children].flat(9).map(String).join('')).join(' | ')
}

test('names every direction the D-pad answers to, including the two that used to be silent', async () => {
  const shown = texts(await createTree(<NowPlayingBar {...props} hint />))

  // Up/down — the zap that was working all along and looked broken.
  expect(shown).toContain('▲ ▼')
  expect(shown).toContain(t('live.hint.channel'))
  // LEFT and OK, one action with two markings. Left is the press that started this.
  expect(shown).toContain('◀ OK')
  expect(shown).toContain(t('live.bar.channels'))
  // RIGHT — the last direction on the pad that answered to nothing.
  expect(shown).toContain('▶')
  expect(shown).toContain(t('live.bar.info'))
  // BACK, the only cap that is translated (remotes print the arrows and OK the same
  // everywhere; the back key is a word, in the language the viewer chose).
  expect(shown).toContain(t('common.back'))
  expect(shown).toContain(t('live.hint.menu'))
})

test('the legend is display-only — it adds no focusable to the D-pad path', async () => {
  const without = await createTree(<NowPlayingBar {...props} />)
  const withLegend = await createTree(<NowPlayingBar {...props} hint />)
  // The S7 rule: a Pressable over the video captures focus and the up/down zap strips
  // never see the press. The legend must cost exactly zero of them.
  expect(withLegend.root.findAllByType(Pressable).length).toBe(without.root.findAllByType(Pressable).length)
})

test('the host can withhold it — the legend fades out rather than standing over the picture', async () => {
  // The TV bar itself never auto-hides, so the legend carries its own timer; `hint`
  // false is what that timer lands on.
  const shown = texts(await createTree(<NowPlayingBar {...props} hint={false} />))
  expect(shown).not.toContain(t('live.hint.channel'))
  expect(shown).not.toContain('◀ OK')
  // …and the bar itself is untouched underneath it.
  expect(shown).toContain('News 24')
})
