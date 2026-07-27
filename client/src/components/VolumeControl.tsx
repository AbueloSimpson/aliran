// In-app volume for the players (QA round 3): a speaker mute toggle + a small
// horizontal level slider, the SeekBar's pure-JS PanResponder pattern (no native
// slider dep). PHONE-ONLY by the hosts' gating — on TV the remote's own volume keys
// drive the system volume, and a focusable here would sit in the D-pad path (S7).
//
// Session-local by design: the OS remembers hardware volume; this is the in-app
// trim on top (rn-video's `volume`/`muted` props). Muting keeps the level, so
// unmuting restores it; dragging the slider while muted unmutes.
import React, { useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, PanResponder } from 'react-native'
import { theme } from '../theme'

export interface VolumeControlProps {
  /** 0..1 level (kept while muted). */
  volume: number
  muted: boolean
  onChange: (volume: number, muted: boolean) => void
}

export function VolumeControl ({ volume, muted, onChange }: VolumeControlProps) {
  const width = useRef(0)
  const [drag, setDrag] = useState<number | null>(null)
  const latest = useRef({ volume, muted, onChange }); latest.current = { volume, muted, onChange }
  const frac = (x: number) => (width.current > 0 ? Math.max(0, Math.min(1, x / width.current)) : 0)
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => setDrag(frac(e.nativeEvent.locationX)),
    onPanResponderMove: (e) => setDrag(frac(e.nativeEvent.locationX)),
    onPanResponderRelease: (e) => {
      const f = frac(e.nativeEvent.locationX)
      setDrag(null)
      latest.current.onChange(f, false) // dragging unmutes
    },
    onPanResponderTerminate: () => setDrag(null)
  })).current
  const shown = drag ?? (muted ? 0 : volume)
  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={muted ? 'Unmute' : 'Mute'}
        style={({ pressed }) => [styles.btn, pressed && styles.btnActive]}
        onPress={() => latest.current.onChange(latest.current.volume, !latest.current.muted)}
      >
        <Text style={styles.glyph}>{muted || volume === 0 ? '🔇' : '🔊'}</Text>
      </Pressable>
      <View style={styles.touch} {...pan.panHandlers} onLayout={(e) => { width.current = e.nativeEvent.layout.width }}>
        <View style={styles.line}>
          <View style={[styles.fill, { width: `${shown * 100}%` }]} />
        </View>
        <View style={[styles.thumb, { left: `${shown * 100}%` }]} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(0.75) },
  btn: { paddingHorizontal: theme.spacing(1), paddingVertical: 6, borderRadius: 10, backgroundColor: theme.colors.overlay },
  btnActive: { backgroundColor: theme.colors.surface },
  glyph: { fontSize: theme.type.body },
  touch: { width: 110, height: 28, justifyContent: 'center' },
  line: { height: 4, borderRadius: 2, backgroundColor: theme.colors.surface, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.accent },
  thumb: { position: 'absolute', top: 8, width: 12, height: 12, borderRadius: 6, marginLeft: -6, backgroundColor: theme.colors.accent }
})
