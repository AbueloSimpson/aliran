// 2px program-progress hairline: how far into the airing program the clock is,
// under a now-playing line (ChannelList rows, NowPlayingBar). The math is the SDK's
// programProgress (clamped 0..1); the REFRESH rides the consumer's existing useEpg
// 30 s tick — every consumer already re-renders on that cadence with a fresh
// now-program, so the hairline just computes on render and starts no timer of its
// own (a list row already carries two intervals; a third per row would buy nothing).
// No program (guide-less channel, gap in the schedule): the track renders fully
// TRANSPARENT, never collapsed — rows are height-pinned (.channel-row in styles.css),
// so the hairline must hold its 2px whether or not there is a guide.
// Desktop twin of client/src/components/ProgressHairline.tsx — styling lives in
// styles.css (.hairline-track/.hairline-fill), the way every component here shares it.
import React from 'react'
import { programProgress, type EpgProgram } from '../../../../sdk/react-native/src/epg'

export interface ProgressHairlineProps {
  program?: EpgProgram | null
  /** Fill color (default var(--c-live)). */
  color?: string
  /** Extra class — the consumer decides how the track sits in its line. */
  className?: string
}

export function ProgressHairline ({ program, color, className }: ProgressHairlineProps) {
  const pct = program ? programProgress(program, Date.now()) : 0
  return (
    <span className={'hairline-track' + (program ? '' : ' hidden') + (className ? ' ' + className : '')}>
      {/* background: undefined lets the .hairline-fill default (var(--c-live)) stand. */}
      {!!program && <span className="hairline-fill" style={{ width: `${pct * 100}%`, background: color }} />}
    </span>
  )
}
