// One channel row (the reference's LISTA DE CANALES row): derived channel number,
// title, now-playing line (the current EPG program when the channel has a guide — S27 —
// else the catalog description), LIVE badge, favorite star, and on the right edge the
// channel's LIVE thumbnail (the rolling frame off its own feed) falling back to the
// station logo. Focus grammar: focused row = light fill (focusFill tokens); the playing
// channel keeps an accent edge bar. Press = play/select; long-press = channel info.
// vod library titles (S8a) ride the same row: runtime badge instead of LIVE, no
// channel number ('—'), and status 'unavailable' grays them out.
import React, { useEffect, useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet } from 'react-native'
import type { Stream } from '../worklet'
import { useI18n } from '@aliran/i18n'
import { formatChannelNumber, formatDuration, isVod } from '../catalog'
import { useEpg } from '@aliran/react-native'
import { theme } from '../theme'

// Exact row geometry (QA round 2): the channel list jumps to the playing channel with
// FlatList getItemLayout, and that math is only exact when every row is EXACTLY this
// tall — so the row's height is pinned (a guide-less one-liner centers in the same box)
// instead of following its text. Same discipline as VOD_ROW_H (D5).
const ROW_INNER_H = theme.isTV ? 64 : 56
const ROW_MB = 2
/** One list row + the gap under it — the getItemLayout unit. */
export const CHANNEL_ROW_H = ROW_INNER_H + ROW_MB

// Live thumbnail refresh cadence — the broadcaster rolls /thumb.jpg at the same period,
// so a faster tick would re-fetch the frame the row is already showing.
const THUMB_REFRESH_MS = 30000

// Thumb-first channel art. The engine hands out thumbBase for EVERY channel, so a 404 is
// the normal "nothing to show" answer (thumbnails off, feed not warm, metered network)
// and the caller falls back to the logo — never a broken-image state. Two details carry
// the feature:
//   the ?t= stamp — the thumbnail rolls IN PLACE, so without a changing URL the Image
//     cache would pin the first frame forever;
//   the tick lives in the ROW — a FlatList unmounts rows that scroll away, so only the
//     visible channels ever fetch, and each re-probes after a miss (the SDK warms a cold
//     feed on that first miss, so the picture appears on the next tick instead of never).
function useChannelThumb (thumbBase?: string): [string | null, () => void] {
  const [stamp, setStamp] = useState(0)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    if (!thumbBase) return
    setBroken(false)
    const timer = setInterval(() => { setStamp(Date.now()); setBroken(false) }, THUMB_REFRESH_MS)
    return () => clearInterval(timer)
  }, [thumbBase])
  return [thumbBase && !broken ? `${thumbBase}?t=${stamp}` : null, () => setBroken(true)]
}

export interface ChannelRowProps {
  stream: Stream
  number?: number
  playing?: boolean
  favorite?: boolean
  hasTVPreferredFocus?: boolean
  onFocus?: () => void
  onPress: () => void
  onLongPress?: () => void
}

export function ChannelRow ({ stream, number, playing, favorite, hasTVPreferredFocus, onFocus, onPress, onLongPress }: ChannelRowProps) {
  const { t } = useI18n()
  const [focused, setFocused] = useState(false)
  // Off-air channel, or a vod title the library took down (S8a: vod records carry no
  // isLive — their availability signal is status 'available'/'unavailable').
  const vod = isVod(stream)
  const dimmed = vod ? stream.status === 'unavailable' : stream.isLive === false
  // vod rows swap the LIVE badge for the title's runtime.
  const duration = vod ? formatDuration(stream.durationSec) : ''
  // Now-playing line: the airing EPG program (S27) when the channel has a guide, else
  // the catalog synopsis. The feed is shared per category, so all its rows resolve from
  // one cached fetch (src/epg.ts); guide-less channels never fetch.
  const { data } = useEpg(stream.epgUrl, stream.epgId, stream.guideBase)
  const nowText = data?.now?.title || stream.description
  // Right-edge art: what is on screen RIGHT NOW when the channel has a live thumbnail,
  // the station logo otherwise (and the initial box when it has neither).
  const [thumbUri, onThumbError] = useChannelThumb(stream.thumbBase)
  const art = thumbUri || stream.logo
  return (
    <Pressable
      style={[styles.row, playing && styles.rowPlaying, focused && styles.rowFocused]}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={() => { setFocused(true); onFocus?.() }}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <Text style={[styles.number, focused && styles.textOnFill]}>{formatChannelNumber(number)}</Text>
      <View style={styles.main}>
        <View style={styles.titleLine}>
          <Text style={[styles.title, focused && styles.textOnFill, dimmed && styles.dimmed]} numberOfLines={1}>{stream.title}</Text>
          {stream.isLive && <Text style={styles.live}>{t('common.live')}</Text>}
          {!!duration && <Text style={[styles.duration, dimmed && styles.dimmed]}>{duration}</Text>}
          {favorite && <Text style={[styles.star, focused && styles.textOnFill]}>★</Text>}
        </View>
        {!!nowText && (
          <Text style={[styles.nowPlaying, focused && styles.textDimOnFill]} numberOfLines={1}>{nowText}</Text>
        )}
      </View>
      {art
        ? <Image source={{ uri: art }} style={styles.logo} resizeMode={thumbUri ? 'cover' : 'contain'} onError={thumbUri ? onThumbError : undefined} />
        : <View style={[styles.logo, styles.logoFallback]}><Text style={[styles.logoInitial, focused && styles.textOnFill]}>{(stream.title || '?').slice(0, 1).toUpperCase()}</Text></View>}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    height: ROW_INNER_H, paddingHorizontal: theme.spacing(1),
    borderRadius: 8, marginBottom: ROW_MB,
    borderLeftWidth: 3, borderLeftColor: 'transparent'
  },
  rowPlaying: { borderLeftColor: theme.colors.accent },
  rowFocused: { backgroundColor: theme.colors.focusFill },
  number: { color: theme.colors.textDim, fontSize: theme.type.label, fontVariant: ['tabular-nums'], width: theme.isTV ? 52 : 40 },
  main: { flex: 1, marginRight: theme.spacing(1) },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700', flexShrink: 1 },
  dimmed: { opacity: 0.5 },
  live: { color: theme.colors.onPrimary, backgroundColor: theme.colors.live, fontSize: theme.type.caption - 2, fontWeight: '800', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' },
  duration: { color: theme.colors.textDim, borderColor: theme.colors.textDim, borderWidth: 1, fontSize: theme.type.caption - 2, fontWeight: '700', fontVariant: ['tabular-nums'], paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' },
  star: { color: theme.colors.accent, fontSize: theme.type.label },
  nowPlaying: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 2 },
  textOnFill: { color: theme.colors.focusFillText },
  textDimOnFill: { color: theme.colors.focusFillText, opacity: 0.7 },
  logo: { width: theme.isTV ? 56 : 42, height: theme.isTV ? 32 : 24, borderRadius: 4 },
  logoFallback: { backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' },
  logoInitial: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800' }
})
