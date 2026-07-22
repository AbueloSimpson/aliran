// Channel-detail overlay (the reference's program-info panel, and the ROADMAP's
// missing channel-detail screen): art, number + title, category chips, LIVE state,
// synopsis (catalog description), live source stats (P2P/CDN + peers — data the
// reference app doesn't even have), favorite toggle, Watch button. The program-guide
// slot shows a live now/next guide for source-imported channels (S27: fetched on
// demand from the provider's epgUrl over https — see src/epg.ts), and falls back to
// an honest "No program information" placeholder for channels without an EPG (D2 — no
// fake data). vod library titles (S8a) show their runtime (badge on the art) and an
// availability note instead of LIVE state, and omit the guide slot — titles have no
// schedule.
import React, { useState } from 'react'
import { View, Text, Image, Pressable, ScrollView, StyleSheet } from 'react-native'
import type { Stream } from '../worklet'
import { formatChannelNumber, formatDuration, isVod } from '../catalog'
import { useEpg, type EpgProgram } from '@aliran/react-native'
import { theme } from '../theme'

// Local wall-clock HH:MM (no Intl dependency — Hermes' Intl is uneven on Android).
function hhmm (ms: number): string {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

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
  // vod library title (S8a): runtime + availability instead of LIVE state, and the
  // program-guide slot does not apply (a title has no schedule).
  const vod = isVod(stream)
  const duration = vod ? formatDuration(stream.durationSec) : ''
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
        {!!duration && <Text style={styles.durationBadge}>{duration}</Text>}
      </View>

      {!!stream.category?.length && (
        <View style={styles.chips}>
          {stream.category.map((c) => <Text key={c} style={styles.chip}>{c.toUpperCase()}</Text>)}
        </View>
      )}

      {vod && stream.status === 'unavailable' && (
        <Text style={styles.unavailable}>Currently unavailable</Text>
      )}

      {!!stream.description && <Text style={styles.desc}>{stream.description}</Text>}

      {playing && (
        <View style={styles.stats}>
          {source && <Text style={source === 'p2p' ? styles.srcP2P : styles.srcCDN}>{source.toUpperCase()}</Text>}
          {source !== 'cdn' && peers != null && <Text style={styles.peers}>{peers} peer{peers === 1 ? '' : 's'}</Text>}
        </View>
      )}

      {/* EPG slot: live now/next for channels that carry a guide (S27), else an
          honest placeholder (D2 — no fake data). A vod title has no schedule — the
          slot is omitted entirely rather than showing "No program information". */}
      {!vod && <EpgGuide stream={stream} />}

      <View style={styles.actions}>
        <ActionButton label={playing ? 'Watching' : 'Watch'} primary onPress={onWatch} hasTVPreferredFocus />
        <ActionButton label={favorite ? '★ Remove favorite' : '☆ Add favorite'} onPress={onToggleFavorite} />
      </View>
    </ScrollView>
  )
}

// The program-guide slot. Renders "Now" (with an elapsed bar) + a short "Up next"
// list when the channel has a guide and it resolved to a current/upcoming program;
// otherwise the honest placeholder. Never blocks on the fetch — it shows the
// placeholder until data arrives, and keeps it if the feed is empty/unreachable.
function EpgGuide ({ stream }: { stream: Stream }) {
  const { data, loaded } = useEpg(stream.epgUrl, stream.epgId)
  const has = !!(data && (data.now || data.next.length))
  return (
    <View style={styles.epgSlot}>
      <Text style={styles.epgTitle}>PROGRAM GUIDE</Text>
      {!has
        ? <Text style={styles.epgEmpty}>{stream.epgUrl && !loaded ? 'Loading guide…' : 'No program information'}</Text>
        : (
          <>
            {data!.now && <NowRow program={data!.now} />}
            {data!.next.length > 0 && (
              <View style={styles.epgNext}>
                <Text style={styles.epgNextLabel}>UP NEXT</Text>
                {data!.next.map((p) => (
                  <View key={p.start} style={styles.epgNextRow}>
                    <Text style={styles.epgNextTime}>{hhmm(p.start)}</Text>
                    <Text style={styles.epgNextTitle} numberOfLines={1}>{p.title}</Text>
                  </View>
                ))}
              </View>
            )}
          </>
          )}
    </View>
  )
}

function NowRow ({ program }: { program: EpgProgram }) {
  const pct = Math.max(0, Math.min(1, (Date.now() - program.start) / (program.stop - program.start)))
  return (
    <View style={styles.epgNow}>
      <View style={styles.epgNowHead}>
        <Text style={styles.epgNowTitle} numberOfLines={2}>{program.title}</Text>
        <Text style={styles.epgNowTime}>{hhmm(program.start)}–{hhmm(program.stop)}</Text>
      </View>
      <View style={styles.epgBarTrack}><View style={[styles.epgBarFill, { width: `${Math.round(pct * 100)}%` }]} /></View>
    </View>
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
  durationBadge: { position: 'absolute', bottom: 8, right: 8, color: theme.colors.text, backgroundColor: theme.colors.overlayStrong, fontSize: theme.type.caption - 1, fontWeight: '700', fontVariant: ['tabular-nums'], paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  unavailable: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1, marginTop: theme.spacing(1), textTransform: 'uppercase' },
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
  epgNow: { marginTop: 8 },
  epgNowHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  epgNowTitle: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700', flexShrink: 1 },
  epgNowTime: { color: theme.colors.textDim, fontSize: theme.type.caption, fontVariant: ['tabular-nums'] },
  epgBarTrack: { height: 4, borderRadius: 2, backgroundColor: theme.colors.surface, marginTop: 6, overflow: 'hidden' },
  epgBarFill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.accent },
  epgNext: { marginTop: 10, gap: 4 },
  epgNextLabel: { color: theme.colors.textDim, fontSize: theme.type.caption - 1, fontWeight: '800', letterSpacing: 1 },
  epgNextRow: { flexDirection: 'row', gap: 10 },
  epgNextTime: { color: theme.colors.textDim, fontSize: theme.type.caption, fontVariant: ['tabular-nums'], minWidth: 42 },
  epgNextTitle: { color: theme.colors.text, fontSize: theme.type.caption, flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: theme.spacing(2) },
  button: { backgroundColor: theme.colors.surface, borderRadius: 8, paddingHorizontal: 18, paddingVertical: 10, borderWidth: theme.focusRing, borderColor: 'transparent' },
  buttonPrimary: { backgroundColor: theme.colors.primary },
  buttonFocused: { borderColor: theme.colors.focus },
  buttonText: { color: theme.colors.onPrimary, fontSize: theme.type.label, fontWeight: '700' }
})
