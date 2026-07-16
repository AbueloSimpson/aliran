// Top-right "tuning" indicator shown while a channel switch is in flight (a zap or a
// list select). It answers the S18-demo gap: switching a channel used to be silent, so
// the P2P join / live-edge replicate looked like a freeze. Now the corner shows a
// spinner + a percentage that climbs 0->100%.
//
// The percentage is an OPTIMISTIC ramp (eases toward ~90% over a couple of seconds) that
// SNAPS to 100% the instant the new feed is actually ready (active -> false, driven by
// AliranVideo's onBuffering/onReadyForDisplay). Live HLS exposes no honest mid-switch
// buffer percentage, so the number is a progress affordance whose ONLY hard-truthful
// point is the end: 100% == first frame ready. Purely presentational — pointerEvents
// none, so it never intercepts a tap meant for the video.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native'
import { formatChannelNumber } from '../catalog'
import { theme } from '../theme'

const TICK_MS = 140
const HOLD_MS = 450 // keep the completed bar up briefly so 100% is actually seen

export interface ChannelChangeIndicatorProps {
  /** True from the moment a switch starts until the new feed's first frame is ready. */
  active: boolean
  number?: number
  title?: string
}

export function ChannelChangeIndicator ({ active, number, title }: ChannelChangeIndicatorProps) {
  const [progress, setProgress] = useState(0)
  const [visible, setVisible] = useState(false)
  const shown = useRef(false)
  const ramp = useRef<ReturnType<typeof setInterval> | null>(null)
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const stopRamp = () => { if (ramp.current) { clearInterval(ramp.current); ramp.current = null } }
    if (active) {
      shown.current = true
      if (hide.current) { clearTimeout(hide.current); hide.current = null }
      setVisible(true)
      setProgress(8)
      stopRamp()
      // Ease toward 90% and never quite reach it — the real "done" comes from active->false.
      ramp.current = setInterval(() => setProgress(p => p + (90 - p) * 0.18), TICK_MS)
    } else if (shown.current) {
      stopRamp()
      setProgress(100)
      hide.current = setTimeout(() => { setVisible(false); shown.current = false }, HOLD_MS)
    }
    return stopRamp
  }, [active])

  useEffect(() => () => {
    if (ramp.current) clearInterval(ramp.current)
    if (hide.current) clearTimeout(hide.current)
  }, [])

  if (!visible) return null
  const pct = Math.min(100, Math.round(progress))
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={styles.row}>
        <ActivityIndicator size="small" color={theme.colors.accent} />
        <Text style={styles.label}>Tuning {formatChannelNumber(number)}</Text>
        <Text style={styles.pct}>{pct}%</Text>
      </View>
      {!!title && <Text style={styles.title} numberOfLines={1}>{title}</Text>}
      <View style={styles.track}><View style={[styles.fill, { width: `${pct}%` }]} /></View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute', top: theme.safeY + theme.spacing(1), right: theme.safeX,
    backgroundColor: theme.colors.overlayStrong, borderRadius: 10,
    paddingHorizontal: theme.spacing(1.25), paddingVertical: theme.spacing(0.75),
    minWidth: theme.isTV ? 200 : 150, maxWidth: 280
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(0.75) },
  label: { color: theme.colors.text, fontSize: theme.type.caption, fontWeight: '700' },
  pct: { color: theme.colors.accent, fontSize: theme.type.caption, fontWeight: '800', marginLeft: 'auto', fontVariant: ['tabular-nums'] },
  title: { color: theme.colors.textDim, fontSize: theme.type.caption - 1, marginTop: 2 },
  track: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.15)', marginTop: 6, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 2, backgroundColor: theme.colors.accent }
})
