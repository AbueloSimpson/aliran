// Persistent bottom menu shown while a channel is open and the left menu is gone
// (overlay 'none'). Replaces the old transient bottom OSD: instead of a channel-identity
// chip that peeked on a tap and faded, the bottom of fullscreen now carries a standing
// bar — derived number + logo + title/synopsis + wall clock on top, a row of touch
// controls (Channels / Info / Favorite) beneath.
//
// Touch model: the container is pointerEvents "box-none" and the identity row is "none",
// so only the three buttons capture touches — a tap anywhere else on the bar (or the
// video) falls through to the fullscreen catcher, which opens the left menu. The button
// row is PHONE-ONLY: on TV it would sit in the D-pad path and hijack the up/down zap
// focus engine (the S7 lesson), so TV keeps the identity-only bar and zaps as before.
import React from 'react'
import { View, Text, Image, Pressable, StyleSheet } from 'react-native'
import type { Stream } from '../worklet'
import { formatChannelNumber } from '../catalog'
import { useEpg } from '@aliran/react-native'
import { theme } from '../theme'

export interface NowPlayingBarProps {
  stream: Stream
  number?: number
  clock: string
  favorite: boolean
  onChannels: () => void
  onInfo: () => void
  onToggleFavorite: () => void
  /** The current stream carries subtitle/CC or multiple audio tracks — show the CC button. */
  hasTracks?: boolean
  /** Open the subtitle/audio track selector. */
  onTracks?: () => void
}

export function NowPlayingBar ({ stream, number, clock, favorite, onChannels, onInfo, onToggleFavorite, hasTracks, onTracks }: NowPlayingBarProps) {
  // What's on NOW from the program guide (S27) — the airing program is more useful on
  // the bar than the channel synopsis. Falls back to the description ("via plutotv")
  // for channels without an EPG. The channel synopsis still lives in the Info panel.
  const { data } = useEpg(stream.epgUrl, stream.epgId)
  const subtitle = data?.now?.title || stream.description
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.bar} pointerEvents="box-none">
        <View style={styles.info} pointerEvents="none">
          {!!stream.logo && <Image source={{ uri: stream.logo }} style={styles.logo} resizeMode="contain" />}
          <Text style={styles.number}>{formatChannelNumber(number)}</Text>
          <View style={styles.main}>
            <View style={styles.titleLine}>
              <Text style={styles.title} numberOfLines={1}>{stream.title}</Text>
              {stream.isLive && <Text style={styles.live}>● LIVE</Text>}
            </View>
            {!!subtitle && <Text style={styles.desc} numberOfLines={1}>{subtitle}</Text>}
          </View>
          <View style={styles.divider} />
          <Text style={styles.clock}>{clock}</Text>
        </View>

        {/* Touch controls — phone only (see file header). */}
        {!theme.isTV && (
          <View style={styles.buttons}>
            <BarButton glyph="☰" label="Channels" onPress={onChannels} />
            <BarButton glyph="ⓘ" label="Info" onPress={onInfo} />
            <BarButton glyph={favorite ? '★' : '☆'} label="Favorite" active={favorite} onPress={onToggleFavorite} />
            {hasTracks && <BarButton glyph="CC" label="Subtitles" onPress={() => onTracks?.()} />}
          </View>
        )}
      </View>
    </View>
  )
}

function BarButton ({ glyph, label, active, onPress }: { glyph: string; label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.btn, (pressed || active) && styles.btnActive]} onPress={onPress}>
      <Text style={[styles.btnGlyph, active && styles.btnTextActive]}>{glyph}</Text>
      <Text style={[styles.btnLabel, active && styles.btnTextActive]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: theme.safeX, right: theme.safeX, bottom: theme.safeY + theme.spacing(1) },
  bar: {
    backgroundColor: theme.colors.overlayStrong, borderRadius: 14,
    paddingHorizontal: theme.spacing(1.5), paddingVertical: theme.spacing(1)
  },
  info: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.25) },
  logo: { width: theme.isTV ? 60 : 44, height: theme.isTV ? 34 : 24, borderRadius: 4 },
  number: { color: theme.colors.accent, fontSize: theme.type.title, fontWeight: '800', fontVariant: ['tabular-nums'] },
  main: { flexShrink: 1, flexGrow: 1 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800', flexShrink: 1 },
  live: { color: theme.colors.live, fontSize: theme.type.caption - 2, fontWeight: '800' },
  desc: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 2 },
  divider: { width: 1, height: 24, backgroundColor: theme.colors.textDim, opacity: 0.3 },
  clock: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700', fontVariant: ['tabular-nums'] },
  buttons: { flexDirection: 'row', gap: theme.spacing(1), marginTop: theme.spacing(1) },
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: theme.spacing(1.5), paddingVertical: theme.spacing(1),
    borderRadius: 10, backgroundColor: theme.colors.overlay
  },
  btnActive: { backgroundColor: theme.colors.surface },
  btnGlyph: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700' },
  btnLabel: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '700' },
  btnTextActive: { color: theme.colors.accent }
})
