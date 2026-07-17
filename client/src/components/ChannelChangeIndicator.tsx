// Top-right "tuning" indicator shown while a channel switch is in flight (a zap or a
// list select). It answers the S18-demo gap: switching a channel used to be silent, so
// the P2P join / live-edge replicate looked like a freeze. Now the corner shows a
// spinner + a percentage that climbs 0->100%.
//
// The percentage is an OPTIMISTIC ramp (a quick attack to ~45%, then a slow crawl
// toward ~85% budgeted for slow-starting feeds) that SNAPS to 100% the instant the new
// feed is actually ready (active -> false, driven by <AliranVideo>'s onTune 'playing').
// Live HLS exposes no honest mid-switch buffer percentage, so the number is a progress
// affordance whose ONLY hard-truthful point is the end: 100% == first real playback of
// THIS tune. While the SDK self-heals (onTune 'retune'/'reconnect') the label switches
// to Retuning/Reconnecting and the percentage hides — a frozen "90%" over a reconnect
// cycle read as a hang (S22 2026-07-16). The host resets the whole pill per tune by
// keying it on the tune id. Purely presentational — pointerEvents none, so it never
// intercepts a tap meant for the video.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native'
import { formatChannelNumber } from '../catalog'
import { theme } from '../theme'

const TICK_MS = 140
const HOLD_MS = 450 // keep the completed bar up briefly so 100% is actually seen

/** Mirrors <AliranVideo>'s tune phases: a plain tune vs the engine's self-heal cycle. */
export type ChannelChangePhase = 'tuning' | 'retune' | 'reconnect'

const LABELS: Record<ChannelChangePhase, string> = {
  tuning: 'Tuning',
  retune: 'Retuning',
  reconnect: 'Reconnecting'
}

export interface ChannelChangeIndicatorProps {
  /** True from the moment a switch starts until the new feed's first real playback. */
  active: boolean
  /** What the switch is doing right now (default 'tuning'); does not reset progress. */
  phase?: ChannelChangePhase
  number?: number
  title?: string
}

export function ChannelChangeIndicator ({ active, phase = 'tuning', number, title }: ChannelChangeIndicatorProps) {
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
      // Two-regime ease and never quite done — the real "done" comes from active->false.
      // Quick attack so a normal zap visibly moves (~45% in about a second), then a slow
      // crawl budgeted for slow-starting feeds (~80% at 30 s, asymptote 85) instead of
      // parking at 90% within seconds and sitting there for a minute.
      ramp.current = setInterval(() => setProgress(p => p + (85 - p) * (p < 45 ? 0.09 : 0.012)), TICK_MS)
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
  // Mid self-heal the percentage is meaningless — the label carries the state instead.
  const showPct = phase === 'tuning' || !active
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={styles.row}>
        <ActivityIndicator size="small" color={theme.colors.accent} />
        <Text style={styles.label}>{LABELS[phase]} {formatChannelNumber(number)}</Text>
        {showPct && <Text style={styles.pct}>{pct}%</Text>}
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
