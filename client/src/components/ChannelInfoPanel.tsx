// Channel-detail overlay (the reference's program-info panel, and the ROADMAP's
// missing channel-detail screen): art, number + title, category chips, LIVE state,
// synopsis (catalog description), live source stats (P2P/CDN + peers — data the
// reference app doesn't even have), favorite toggle, Watch button. Where a program
// guide would sit, an honest "No program information" placeholder (D2 — no fake EPG);
// the layout slot is where an EPG lands later.
import React, { useState } from 'react'
import { View, Text, Image, Pressable, ScrollView, StyleSheet } from 'react-native'
import type { Stream } from '../worklet'
import { formatChannelNumber } from '../catalog'
import { theme } from '../theme'

export interface ChannelInfoPanelProps {
  stream: Stream
  number?: number
  favorite: boolean
  playing: boolean
  source?: 'p2p' | 'cdn' | null
  peers?: number | null
  onWatch: () => void
  onToggleFavorite: () => void
}

export function ChannelInfoPanel ({ stream, number, favorite, playing, source, peers, onWatch, onToggleFavorite }: ChannelInfoPanelProps) {
  const art = stream.poster || stream.backdrop || stream.logo
  return (
    <ScrollView style={styles.panel} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <Text style={styles.number}>{formatChannelNumber(number)}</Text>
        <Text style={styles.title} numberOfLines={2}>{stream.title}</Text>
      </View>

      <View style={styles.artBox}>
        {art
          ? <Image source={{ uri: art }} style={styles.art} resizeMode="cover" />
          : <View style={[styles.art, styles.artFallback]}><Text style={styles.artInitial}>{(stream.title || '?').slice(0, 1).toUpperCase()}</Text></View>}
        {stream.isLive && <Text style={styles.live}>● LIVE</Text>}
      </View>

      {!!stream.category?.length && (
        <View style={styles.chips}>
          {stream.category.map((c) => <Text key={c} style={styles.chip}>{c.toUpperCase()}</Text>)}
        </View>
      )}

      {!!stream.description && <Text style={styles.desc}>{stream.description}</Text>}

      {playing && (
        <View style={styles.stats}>
          {source && <Text style={source === 'p2p' ? styles.srcP2P : styles.srcCDN}>{source.toUpperCase()}</Text>}
          {source !== 'cdn' && peers != null && <Text style={styles.peers}>{peers} peer{peers === 1 ? '' : 's'}</Text>}
        </View>
      )}

      {/* EPG slot: honest placeholder until program data exists (D2). */}
      <View style={styles.epgSlot}>
        <Text style={styles.epgTitle}>PROGRAM GUIDE</Text>
        <Text style={styles.epgEmpty}>No program information</Text>
      </View>

      <View style={styles.actions}>
        <ActionButton label={playing ? 'Watching' : 'Watch'} primary onPress={onWatch} hasTVPreferredFocus />
        <ActionButton label={favorite ? '★ Remove favorite' : '☆ Add favorite'} onPress={onToggleFavorite} />
      </View>
    </ScrollView>
  )
}

function ActionButton ({ label, primary, hasTVPreferredFocus, onPress }: { label: string; primary?: boolean; hasTVPreferredFocus?: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.button, primary && styles.buttonPrimary, focused && styles.buttonFocused]}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  panel: { flex: 1 },
  content: { padding: theme.spacing(2) },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  number: { color: theme.colors.textDim, fontSize: theme.type.label, fontVariant: ['tabular-nums'] },
  title: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '800', flexShrink: 1 },
  artBox: { marginTop: theme.spacing(1) },
  art: { width: '100%', aspectRatio: 16 / 9, borderRadius: 8, backgroundColor: theme.colors.surface },
  artFallback: { alignItems: 'center', justifyContent: 'center' },
  artInitial: { color: theme.colors.textDim, fontSize: theme.type.display, fontWeight: '800' },
  live: { position: 'absolute', top: 8, left: 8, color: theme.colors.onPrimary, backgroundColor: theme.colors.live, fontSize: theme.type.caption - 2, fontWeight: '800', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: theme.spacing(1) },
  chip: { color: theme.colors.textDim, borderColor: theme.colors.textDim, borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, fontSize: theme.type.caption - 1, letterSpacing: 1 },
  desc: { color: theme.colors.text, fontSize: theme.type.body, marginTop: theme.spacing(1), lineHeight: theme.type.body * 1.4 },
  stats: { flexDirection: 'row', gap: 12, marginTop: theme.spacing(1), alignItems: 'center' },
  srcP2P: { color: theme.colors.accent, fontWeight: '800', fontSize: theme.type.caption },
  srcCDN: { color: theme.colors.live, fontWeight: '800', fontSize: theme.type.caption },
  peers: { color: theme.colors.textDim, fontSize: theme.type.caption },
  epgSlot: { marginTop: theme.spacing(2), padding: theme.spacing(1.5), borderRadius: 8, backgroundColor: theme.colors.overlayStrong },
  epgTitle: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2 },
  epgEmpty: { color: theme.colors.textDim, fontSize: theme.type.body, marginTop: 6, fontStyle: 'italic' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: theme.spacing(2) },
  button: { backgroundColor: theme.colors.surface, borderRadius: 8, paddingHorizontal: 18, paddingVertical: 10, borderWidth: theme.focusRing, borderColor: 'transparent' },
  buttonPrimary: { backgroundColor: theme.colors.primary },
  buttonFocused: { borderColor: theme.colors.focus },
  buttonText: { color: theme.colors.onPrimary, fontSize: theme.type.label, fontWeight: '700' }
})
