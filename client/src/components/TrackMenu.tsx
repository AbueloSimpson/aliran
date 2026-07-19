// Subtitle/CC + audio track selector — an overlay over the live video (opened from the
// NowPlayingBar "CC" button). react-native-video exposes the tracks the player found in
// the current stream; the app renders its own picker (native controls are off) and drives
// selection through <AliranVideo>'s selectedTextTrack / selectedAudioTrack props.
//
// The redirect/CDN movie & anime channels are single-audio but several carry subtitle
// (WebVTT) and/or closed-caption (CEA-608 CC1) text tracks — so Subtitles is always shown
// (Off + one row per track) and Audio only appears when the stream actually has more than
// one audio track. Tap the dim backdrop to dismiss.
import React from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { SelectedTrackType, type SelectedTrack, type AudioTrack, type TextTrack } from '@aliran/react-native'
import { theme } from '../theme'

// react-native-video's Android <Video> selects a TEXT track by matching the WITHIN-GROUP
// track index, but onTextTracks reports a FLAT index across track groups — so selecting an
// embedded HLS subtitle by index only works for the first group. An "English" track at
// index 1 (its own group) silently no-ops and subtitles stay off (found on-device 2026-07-19).
// So map a track to a SelectedTrack preferring LANGUAGE, then a real TITLE, and only fall
// back to INDEX for tracks rn-video couldn't label — its synthetic "Track N"/"External N"
// titles aren't matchable by title either (the underlying format has no label), so those go
// by index (which does work for the first group). LANGUAGE/TITLE both iterate every group
// correctly. The same mapping is valid for audio (its index path is per-group anyway).
const SYNTHETIC_TITLE = /^(Track|External)\s+\d+$/
export function trackChoice (t: { index: number; title?: string; language?: string }): SelectedTrack {
  if (t.language) return { type: SelectedTrackType.LANGUAGE, value: t.language }
  if (t.title && !SYNTHETIC_TITLE.test(t.title)) return { type: SelectedTrackType.TITLE, value: t.title }
  return { type: SelectedTrackType.INDEX, value: t.index }
}

export interface TrackMenuProps {
  textTracks: TextTrack[]
  audioTracks: AudioTrack[]
  /** Current subtitle selection ({ type: DISABLED } = Off). */
  selectedText: SelectedTrack
  /** Current audio selection (undefined = the player's default track). */
  selectedAudio?: SelectedTrack
  onSelectText: (t: SelectedTrack) => void
  onSelectAudio: (t: SelectedTrack) => void
  onClose: () => void
}

export function TrackMenu ({ textTracks, audioTracks, selectedText, selectedAudio, onSelectText, onSelectAudio, onClose }: TrackMenuProps) {
  // A row is active when the current selection equals what this track maps to (trackChoice).
  // "Off" is active when nothing is selected (DISABLED); for audio with no explicit pick,
  // reflect the player's currently-selected track (`selected`).
  const eqSel = (a: SelectedTrack | undefined, b: SelectedTrack) => !!a && a.type === b.type && a.value === b.value
  const textActive = (t?: TextTrack) =>
    t == null ? selectedText.type === SelectedTrackType.DISABLED : eqSel(selectedText, trackChoice(t))
  const audioActive = (t: AudioTrack) =>
    selectedAudio ? eqSel(selectedAudio, trackChoice(t)) : !!t.selected

  // Picking a track applies it AND dismisses the menu — a subtitle/audio choice is a
  // one-shot action, and leaving the panel over the video was the annoyance.
  const chooseText = (sel: SelectedTrack) => { onSelectText(sel); onClose() }
  const chooseAudio = (sel: SelectedTrack) => { onSelectAudio(sel); onClose() }

  return (
    <View style={styles.overlay}>
      {/* Dim backdrop — a tap anywhere outside the panel dismisses. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.panel} pointerEvents="box-none">
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Text style={styles.heading}>Subtitles</Text>
          <Row label="Off" active={textActive()} onPress={() => chooseText({ type: SelectedTrackType.DISABLED })} />
          {textTracks.map((t, i) => (
            <Row
              key={t.index}
              label={t.title || t.language || `Subtitle ${i + 1}`}
              active={textActive(t)}
              onPress={() => chooseText(trackChoice(t))}
            />
          ))}

          {audioTracks.length > 1 && (
            <>
              <Text style={[styles.heading, styles.headingGap]}>Audio</Text>
              {audioTracks.map((t, i) => (
                <Row
                  key={t.index}
                  label={t.title || t.language || `Audio ${i + 1}`}
                  active={audioActive(t)}
                  onPress={() => chooseAudio(trackChoice(t))}
                />
              ))}
            </>
          )}
        </ScrollView>
      </View>
    </View>
  )
}

function Row ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.row, (active || pressed) && styles.rowActive]} onPress={onPress}>
      <Text style={[styles.dot, active && styles.dotActive]}>{active ? '●' : '○'}</Text>
      <Text style={[styles.rowLabel, active && styles.rowLabelActive]} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  // Fill the screen, centre the panel; the backdrop sibling behind it catches outside taps.
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  panel: {
    width: '64%', maxWidth: 460, maxHeight: '82%',
    backgroundColor: theme.colors.overlayStrong, borderRadius: 14,
    paddingVertical: theme.spacing(1.5), paddingHorizontal: theme.spacing(1.5)
  },
  content: { paddingBottom: theme.spacing(1) },
  heading: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2 },
  headingGap: { marginTop: theme.spacing(2) },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1),
    paddingVertical: theme.spacing(1), paddingHorizontal: theme.spacing(1),
    borderRadius: 10, marginTop: theme.spacing(0.5)
  },
  rowActive: { backgroundColor: theme.colors.surface },
  dot: { color: theme.colors.textDim, fontSize: theme.type.label },
  dotActive: { color: theme.colors.accent },
  rowLabel: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '600', flexShrink: 1 },
  rowLabelActive: { color: theme.colors.accent }
})
