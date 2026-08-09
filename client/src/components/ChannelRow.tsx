// One channel row (the reference's LISTA DE CANALES row): derived channel number,
// title, now-playing line (the current EPG program when the channel has a guide — S27 —
// else the catalog description), LIVE badge, favorite star, and on the right edge the
// channel's LIVE thumbnail (the rolling frame off its own feed) falling back to the
// station logo. Focus grammar: focused row = light fill (focusFill tokens); the playing
// channel keeps an accent edge bar. Press = play/select; long-press = channel info.
// vod library titles (S8a) ride the same row: runtime badge instead of LIVE, no
// channel number ('—'), and status 'unavailable' grays them out.
import React, { useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet } from 'react-native'
import type { Stream } from '../worklet'
import { formatChannelNumber, formatDuration, isVod } from '../catalog'
import { useEpg, useChannelThumb } from '@aliran/react-native'
import { prefersReducedMotion } from '../motion'
import { ProgressHairline } from './ProgressHairline'
import { theme } from '../theme'

// Exact row geometry (QA round 2): the channel list jumps to the playing channel with
// FlatList getItemLayout, and that math is only exact when every row is EXACTLY this
// tall — so the row's height is pinned (a guide-less one-liner centers in the same box)
// instead of following its text. Same discipline as VOD_ROW_H (D5). Grown for the
// guide UI (WS1): the live thumb doubled, so the row makes room for it.
const ROW_INNER_H = theme.isTV ? 80 : 64
const ROW_MB = 2
/** One list row + the gap under it — the getItemLayout unit. */
export const CHANNEL_ROW_H = ROW_INNER_H + ROW_MB

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
      style={[
        styles.row, playing && styles.rowPlaying, focused && styles.rowFocused,
        // Focus scale lift (TV grammar, theme.focusScale) — a transform, so it is
        // skipped under the OS reduced-motion setting; the fill/border grammar above
        // always applies. zIndex only reorders within this row's own list cell —
        // cross-row stacking is decided between cell wrappers, so the ~1px overhang
        // may underdraw the next row; at 1.025 that is imperceptible.
        focused && !prefersReducedMotion() && styles.rowScaled
      ]}
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
          {stream.isLive && <Text style={styles.live}>LIVE</Text>}
          {!!duration && <Text style={[styles.duration, dimmed && styles.dimmed]}>{duration}</Text>}
          {favorite && <Text style={[styles.star, focused && styles.textOnFill]}>★</Text>}
        </View>
        {!!nowText && (
          <Text style={[styles.nowPlaying, focused && styles.textDimOnFill]} numberOfLines={1}>{nowText}</Text>
        )}
        {/* Program progress under the subline (full text width). No guide/program:
            the hairline renders transparent, never collapses — the row height is
            pinned (getItemLayout above), so every row must lay out identically. */}
        {!vod && <ProgressHairline program={data?.now} style={styles.hairline} />}
      </View>
      {art
        ? <Image source={{ uri: art }} style={styles.logo} resizeMode={thumbUri ? 'cover' : 'contain'} onError={thumbUri ? onThumbError : undefined} accessibilityLabel={thumbUri ? `${stream.title} — live preview` : undefined} />
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
  rowScaled: { transform: [{ scale: theme.focusScale }], zIndex: 1 },
  number: { color: theme.colors.textDim, fontSize: theme.type.label, fontVariant: ['tabular-nums'], width: theme.isTV ? 52 : 40 },
  main: { flex: 1, marginRight: theme.spacing(1) },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700', flexShrink: 1 },
  dimmed: { opacity: 0.5 },
  live: { color: theme.colors.onPrimary, backgroundColor: theme.colors.live, fontSize: theme.type.caption - 2, fontWeight: '800', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' },
  duration: { color: theme.colors.textDim, borderColor: theme.colors.textDim, borderWidth: 1, fontSize: theme.type.caption - 2, fontWeight: '700', fontVariant: ['tabular-nums'], paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' },
  star: { color: theme.colors.accent, fontSize: theme.type.label },
  nowPlaying: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 2 },
  hairline: { marginTop: 4 },
  textOnFill: { color: theme.colors.focusFillText },
  textDimOnFill: { color: theme.colors.focusFillText, opacity: 0.7 },
  logo: { width: theme.isTV ? 112 : 84, height: theme.isTV ? 63 : 48, borderRadius: 4 },
  logoFallback: { backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' },
  logoInitial: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800' }
})
