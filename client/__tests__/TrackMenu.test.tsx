// TrackMenu — the subtitle/CC + audio track selector overlay. Pins the contract the
// LiveScreen relies on: Subtitles always lists "Off" plus one row per text track, and
// selecting a row fires onSelectText with the right SelectedTrack; the Audio section is
// hidden with a single audio track and shown when the stream has more than one.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import { TrackMenu } from '../src/components/TrackMenu'
import { SelectedTrackType, type AudioTrack, type TextTrack } from '@aliran/react-native'

// Each Text node's concatenated string children, as a flat exact-match-friendly list.
function textList (tree: RendererInstance): string[] {
  return tree.root.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join(''))
}

// Press the row whose label matches. Matching on the onPress prop (not the Pressable
// type) breaks through memo/forwardRef — the repo pattern (see SmoothZappingToggle.test).
// The backdrop Pressable also has onPress but no Text, so it never matches a label.
function pressRow (tree: RendererInstance, label: string) {
  const rows = tree.root.findAll(n => typeof n.props?.onPress === 'function' &&
    n.findAllByType(Text).map(t => [t.props.children].flat(9).map(String).join('')).includes(label))
  if (!rows.length) throw new Error('no row with label: ' + label)
  ReactTestRenderer.act(() => { rows[0].props.onPress() })
}

const base = {
  selectedText: { type: SelectedTrackType.DISABLED },
  selectedAudio: undefined,
  onSelectText: () => {},
  onSelectAudio: () => {},
  onClose: () => {}
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
})

test('subtitles: lists Off + one row per text track; selecting fires onSelectText by title/language (not the broken index)', async () => {
  const onSelectText = jest.fn()
  const textTracks: TextTrack[] = [
    { index: 0, title: 'English' },
    { index: 1, language: 'fr' } // no title → label falls back to the language
  ]
  const tree = await createTree(
    <TrackMenu {...base} textTracks={textTracks} audioTracks={[{ index: 0, title: 'Original' }]} onSelectText={onSelectText} />
  )
  const labels = textList(tree)
  expect(labels).toContain('Off')
  expect(labels).toContain('English')
  expect(labels).toContain('fr')

  // A titled track → TITLE selection. rn-video's Android <Video> can't select embedded HLS
  // subtitles by index past the first group (it matches the within-group index while
  // onTextTracks reports a flat one), so trackChoice prefers title/language which iterate
  // every group — this is the fix for "English subtitles never showed".
  pressRow(tree, 'English')
  expect(onSelectText).toHaveBeenCalledWith({ type: SelectedTrackType.TITLE, value: 'English' })

  // A track with only a language → LANGUAGE selection.
  pressRow(tree, 'fr')
  expect(onSelectText).toHaveBeenCalledWith({ type: SelectedTrackType.LANGUAGE, value: 'fr' })

  // Off → DISABLED.
  pressRow(tree, 'Off')
  expect(onSelectText).toHaveBeenCalledWith({ type: SelectedTrackType.DISABLED })
})

test('subtitles: an unlabeled ("Track N") track falls back to index, a labeled one uses title', async () => {
  const onSelectText = jest.fn()
  // rn-video Android synthesizes "Track N" for tracks with no label; those aren't matchable
  // by title (the format has no label) so they fall back to index (which works for the first
  // group — the only case an unlabeled track can be reached).
  const textTracks: TextTrack[] = [{ index: 0, title: 'Track 1' }, { index: 1, title: 'English' }]
  const tree = await createTree(
    <TrackMenu {...base} textTracks={textTracks} audioTracks={[]} onSelectText={onSelectText} />
  )
  pressRow(tree, 'Track 1')
  expect(onSelectText).toHaveBeenCalledWith({ type: SelectedTrackType.INDEX, value: 0 })
  pressRow(tree, 'English')
  expect(onSelectText).toHaveBeenCalledWith({ type: SelectedTrackType.TITLE, value: 'English' })
})

test('audio: section hidden with a single audio track', async () => {
  const tree = await createTree(
    <TrackMenu {...base} textTracks={[]} audioTracks={[{ index: 0, title: 'English' }]} />
  )
  expect(textList(tree)).not.toContain('Audio')
})

test('audio: section shown with more than one audio track; selecting fires onSelectAudio', async () => {
  const onSelectAudio = jest.fn()
  const audioTracks: AudioTrack[] = [
    { index: 0, title: 'English' },
    { index: 1, title: 'Español' }
  ]
  const tree = await createTree(
    <TrackMenu {...base} textTracks={[]} audioTracks={audioTracks} onSelectAudio={onSelectAudio} />
  )
  const labels = textList(tree)
  expect(labels).toContain('Audio')
  expect(labels).toContain('English')
  expect(labels).toContain('Español')

  pressRow(tree, 'Español')
  expect(onSelectAudio).toHaveBeenCalledWith({ type: SelectedTrackType.TITLE, value: 'Español' })
})
