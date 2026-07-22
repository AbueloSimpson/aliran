// Top-right "tuning" indicator — the desktop port of the app's
// ChannelChangeIndicator: spinner + an OPTIMISTIC percentage ramp (quick attack to
// ~45%, slow crawl toward ~85%) that SNAPS to 100% the instant the new feed actually
// plays (active -> false, driven by <HlsVideo>'s onTune 'playing'). Live HLS exposes
// no honest mid-switch buffer %, so the only hard-truthful point is the end:
// 100% == first real playback of THIS tune. While the SDK self-heals the label
// switches to Retuning/Reconnecting and the percentage hides (a frozen "90%" over a
// reconnect cycle reads as a hang). The host resets the pill per tune by keying it
// on the tune id. Purely presentational — pointer-events none.

import React, { useEffect, useRef, useState } from 'react'
import { formatChannelNumber } from '../catalog'

const TICK_MS = 140
const HOLD_MS = 450 // keep the completed bar up briefly so 100% is actually seen

export type TunePillPhase = 'tuning' | 'retune' | 'reconnect'

const LABELS: Record<TunePillPhase, string> = {
  tuning: 'Tuning',
  retune: 'Retuning',
  reconnect: 'Reconnecting'
}

export function TunePill ({ active, phase = 'tuning', number, title }: {
  active: boolean
  phase?: TunePillPhase
  number?: number
  title?: string
}) {
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
      ramp.current = setInterval(() => setProgress((p) => p + (85 - p) * (p < 45 ? 0.09 : 0.012)), TICK_MS)
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
  const showPct = phase === 'tuning' || !active
  return (
    <div className="tune-pill">
      <div className="tune-pill-row">
        <span className="spinner" />
        <span className="tune-pill-label">{LABELS[phase]} {formatChannelNumber(number)}</span>
        {showPct && <span className="tune-pill-pct">{pct}%</span>}
      </div>
      {title && <div className="tune-pill-title">{title}</div>}
      <div className="tune-pill-track"><div className="tune-pill-fill" style={{ width: `${pct}%` }} /></div>
    </div>
  )
}
