// 2px program-progress hairline: how far into the airing program the clock is,
// under a now-playing line (ChannelRow, NowPlayingBar). The math is the SDK's
// programProgress (clamped 0..1); the REFRESH rides the consumer's existing useEpg
// 30 s tick — every consumer already re-renders on that cadence with a fresh
// now-program, so the hairline just computes on render and starts no timer of its
// own (a list row already carries two intervals; a third per row would buy nothing).
// No program (guide-less channel, gap in the schedule): the track renders fully
// TRANSPARENT, never collapsed — rows are height-pinned for getItemLayout, so the
// hairline must hold its 2px whether or not there is a guide.
import React from 'react'
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import { programProgress, type EpgProgram } from '@aliran/react-native'
import { theme } from '../theme'

export interface ProgressHairlineProps {
  program?: EpgProgram | null
  /** Fill color (default theme.colors.live). */
  color?: string
  /** Width/margin pass-through — the consumer decides how the track sits in its line. */
  style?: StyleProp<ViewStyle>
}

export function ProgressHairline ({ program, color, style }: ProgressHairlineProps) {
  const pct = program ? programProgress(program, Date.now()) : 0
  return (
    <View style={[styles.track, !program && styles.trackHidden, style]}>
      {!!program && <View style={[styles.fill, { width: `${pct * 100}%` }, !!color && { backgroundColor: color }]} />}
    </View>
  )
}

const styles = StyleSheet.create({
  track: { height: 2, borderRadius: 1, backgroundColor: theme.colors.overlay, overflow: 'hidden' },
  trackHidden: { backgroundColor: 'transparent' },
  fill: { height: 2, borderRadius: 1, backgroundColor: theme.colors.live }
})
