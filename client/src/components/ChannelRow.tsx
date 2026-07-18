// One channel row (the reference's LISTA DE CANALES row): derived channel number,
// title, now-playing line (the current EPG program when the channel has a guide — S27 —
// else the catalog description), LIVE badge, favorite star, channel logo thumb on the
// right edge. Focus grammar: focused row = light fill (focusFill tokens); the playing
// channel keeps an accent edge bar. Press = play/select; long-press = channel info.
import React, { useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet } from 'react-native'
import type { Stream } from '../worklet'
import { formatChannelNumber } from '../catalog'
import { useEpg } from '../useEpg'
import { theme } from '../theme'

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
  const dimmed = stream.isLive === false
  // Now-playing line: the airing EPG program (S27) when the channel has a guide, else
  // the catalog synopsis. The feed is shared per category, so all its rows resolve from
  // one cached fetch (src/epg.ts); guide-less channels never fetch.
  const { data } = useEpg(stream.epgUrl, stream.epgId)
  const nowText = data?.now?.title || stream.description
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
          {stream.isLive && <Text style={styles.live}>LIVE</Text>}
          {favorite && <Text style={[styles.star, focused && styles.textOnFill]}>★</Text>}
        </View>
        {!!nowText && (
          <Text style={[styles.nowPlaying, focused && styles.textDimOnFill]} numberOfLines={1}>{nowText}</Text>
        )}
      </View>
      {stream.logo
        ? <Image source={{ uri: stream.logo }} style={styles.logo} resizeMode="contain" />
        : <View style={[styles.logo, styles.logoFallback]}><Text style={[styles.logoInitial, focused && styles.textOnFill]}>{(stream.title || '?').slice(0, 1).toUpperCase()}</Text></View>}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: theme.isTV ? 10 : 8, paddingHorizontal: theme.spacing(1),
    borderRadius: 8, marginBottom: 2,
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
  star: { color: theme.colors.accent, fontSize: theme.type.label },
  nowPlaying: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 2 },
  textOnFill: { color: theme.colors.focusFillText },
  textDimOnFill: { color: theme.colors.focusFillText, opacity: 0.7 },
  logo: { width: theme.isTV ? 56 : 42, height: theme.isTV ? 32 : 24, borderRadius: 4 },
  logoFallback: { backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' },
  logoInitial: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800' }
})
