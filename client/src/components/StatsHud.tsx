// The "Debug overlay" (upper-right stats HUD): live playback + device + swarm
// diagnostics an END USER can read to an operator over the phone — the answer to
// "it says CDN, 0 peers, buffer zero" being worth more than "it's stuck".
//
// Data comes from two places, deliberately split:
//   - the WORKLET, polled: this component owns a 1 s backend.getStats() loop, so a
//     hidden HUD costs the worklet exactly nothing (the pull pattern — see sendStats
//     in client/backend/backend.mjs). A null reply (worklet busy, engine-less build)
//     renders dashes and simply asks again next tick; requests never stack.
//   - the PLAYER, pushed: buffer level / bitrate / codec / resolution arrive as
//     <Video> events LiveScreen captures into a plain mutable ref (no state — a
//     re-render per onProgress would be a re-render per second of video). This
//     component's own tick re-renders, which reads the ref's current values: at
//     worst one second stale, which is exactly the HUD's resolution anyway.
//
// Styling follows ChannelChangeIndicator (the tune pill): same overlay chrome, same
// corner, pointerEvents="none" — permanently BELOW the pill's slot so a zap never
// makes the two fight for the corner (S7 note: NEVER a focusable over the video).
// Labels are terse English on purpose: diagnostics prose stays unlocalized (i18n
// README), only the Settings toggle that opens this is translated.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import type { StatsMessage } from '@aliran/react-native'
import { backend } from '../worklet'
import { PILL_TOP, PILL_SLOT_HEIGHT } from './ChannelChangeIndicator'
import { theme } from '../theme'

/** Player-side numbers LiveScreen captures from <Video> events into a ref. */
export interface HudVideoStats {
  bufferSec: number | null // onProgress: playableDuration - currentTime
  bitrateBps: number | null // onBandwidthUpdate (bits/s; Android needs reportBandwidth)
  codec: string | null // onLoad/onVideoTracks videoTracks[].codecs
  width: number | null
  height: number | null
}

export const emptyHudVideoStats = (): HudVideoStats => ({ bufferSec: null, bitrateBps: null, codec: null, width: null, height: null })

const DASH = '—'

function fmtBytes (n: number | null | undefined) {
  if (n == null) return DASH
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB'
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}

function fmtBitrate (bps: number | null | undefined) {
  if (bps == null) return DASH
  if (bps >= 1000000) return (bps / 1000000).toFixed(1) + ' Mbps'
  return Math.round(bps / 1000) + ' kbps'
}

/** Swarm health, derived cheap and honest: cdn has no swarm to grade; p2p grades on
 *  feed peers, demoted only when a measured download rate can't cover the measured
 *  bitrate (unknown rates never demote — a dash must not read as "bad"). */
export function healthLabel (s: StatsMessage | null, bitrateBps: number | null): string {
  if (!s || !s.engine.source) return DASH
  if (s.engine.source === 'cdn') return 'CDN'
  const { feedPeers } = s.engine
  if (feedPeers <= 0) return 'POOR'
  const rx = s.net.rxBps
  const starving = rx != null && bitrateBps != null && rx * 8 < bitrateBps // rx is bytes/s, bitrate bits/s
  if (feedPeers >= 3 && !starving) return 'GOOD'
  return starving ? 'POOR' : 'FAIR'
}

export function StatsHud ({ videoStats }: { videoStats: React.MutableRefObject<HudVideoStats> }) {
  const [stats, setStats] = useState<StatsMessage | null>(null)
  const [, setTick] = useState(0) // re-render even on a null reply — the ref's player numbers still moved

  useEffect(() => {
    let gone = false
    let inflight = false
    const pull = async () => {
      if (inflight) return // a slow worklet answer must not stack requests behind itself
      inflight = true
      const s = await backend.getStats() // resolves null on timeout, never throws
      inflight = false
      if (gone) return
      setStats(s)
      setTick((n) => n + 1)
    }
    pull()
    const timer = setInterval(pull, 1000)
    return () => { gone = true; clearInterval(timer) }
  }, [])

  const v = videoStats.current
  const src = stats?.engine.source
  const rows: Array<[string, string]> = [
    ['SRC', src === 'p2p' ? `P2P · ${stats!.engine.feedPeers} peer${stats!.engine.feedPeers === 1 ? '' : 's'}` : src === 'cdn' ? 'CDN' : DASH],
    ['HEALTH', healthLabel(stats, v.bitrateBps)],
    ['BUF', v.bufferSec == null ? DASH : v.bufferSec.toFixed(1) + ' s'],
    ['BITRATE', fmtBitrate(v.bitrateBps)],
    ['RES', v.width && v.height ? `${v.width}×${v.height}${v.codec ? ' · ' + v.codec : ''}` : v.codec ?? DASH],
    ['NET', stats && (stats.net.rxBps != null || stats.net.txBps != null)
      ? `↓ ${fmtBytes(stats.net.rxBps)}/s  ↑ ${fmtBytes(stats.net.txBps)}/s`
      : DASH],
    ['SWARM', stats ? String(stats.engine.swarmPeers) + ' conn' : DASH],
    ['STORE', fmtBytes(stats?.store.driveBytes)],
    ['CPU', stats?.os.cpuPercent == null ? DASH : stats.os.cpuPercent + ' %'],
    ['MEM', stats?.os.rssBytes == null ? DASH : `${fmtBytes(stats.os.rssBytes)} / free ${fmtBytes(stats.os.freeMem)}`]
  ]

  return (
    <View style={styles.wrap} pointerEvents="none">
      {rows.map(([label, value]) => (
        <View key={label} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.value} numberOfLines={1}>{value}</Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    // The tune pill owns the corner; the HUD sits permanently below its slot so
    // nothing jumps during a zap. Derived from the pill's own exported geometry —
    // never hand-measured here.
    position: 'absolute', top: PILL_TOP + PILL_SLOT_HEIGHT, right: theme.safeX,
    backgroundColor: theme.colors.overlayStrong, borderRadius: 10,
    paddingHorizontal: theme.spacing(1.25), paddingVertical: theme.spacing(0.75),
    minWidth: theme.isTV ? 240 : 190, maxWidth: 300
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1) },
  label: { color: theme.colors.textDim, fontSize: theme.type.caption - 1, fontWeight: '800', letterSpacing: 1, width: 62 },
  value: { color: theme.colors.text, fontSize: theme.type.caption - 1, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1, marginLeft: 'auto' }
})
