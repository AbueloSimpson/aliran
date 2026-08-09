// In-player channel search (WS15, phone) — the content of LiveScreen's 'search'
// overlay, opened from the NowPlayingBar's Search button so the viewer never has to
// leave playback to find a channel. Playback NEVER stops: this panel is pure overlay
// content; the host owns the video surface and the overlay geometry (portrait =
// video strip on top + this panel below; landscape = this panel over the fullscreen
// video on a translucent bed).
//
// LAYOUT. A LEFT vertical letter rail (quick input — tapping a key APPENDS it to the
// query; digits 0–9 for channel numbers; ⌫ backspace), the search field top-right
// (soft-keyboard capable, with a clear ×), and the results below as a GRID of channel
// cards: station LOGO (contain; initial-box fallback — logos only, never live thumbs,
// the WS11 policy), channel number + name under it. ~4 columns landscape, 3 portrait
// (searchGridGeometry below — the VodScreen gridGeometry discipline, kept local).
//
// The rail renders the GUI locale's SCRIPT by default (src/alphabets.ts — Cyrillic
// for ru, Devanagari for hi, kana for ja, jamo for ko, Thai for th, Latin elsewhere)
// with a toggle chip back to the plain English A–Z: channel names can be English
// while the GUI is not.
//
// TUNE CONTRACT: tapping a result calls onTune(stream) and the HOST is expected to
// tune AND CLOSE the overlay — unlike the guide (which tunes in place so the viewer
// keeps browsing), a search has a destination: once found, the viewer is done here.
// PIN gating stays the host's job (LiveScreen play()), same as the channel list.
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, Image, Pressable, TextInput, FlatList, ScrollView, StyleSheet, useWindowDimensions } from 'react-native'
import { useI18n } from '@aliran/i18n'
import { backend, type Stream } from '../worklet'
import { visibleStreams } from '../parental'
import { channelNumbers, sortByCuration, formatChannelNumber } from '../catalog'
import { DIGITS, railLetters, scriptForLocale, normalizeSearch } from '../alphabets'
import { theme } from '../theme'

// Letter-rail column width (finger-sized keys at phone scale).
const RAIL_W = 44
const GRID_GAP = theme.spacing(1)

/** Grid geometry — the VodScreen gridGeometry pattern, local to this panel: the
 *  column COUNT is fixed per orientation (3 portrait / 4 landscape) and the card
 *  width follows from the measured grid width. */
export function searchGridGeometry (gridW: number, portrait: boolean) {
  const columns = portrait ? 3 : 4
  const cardW = Math.max(64, Math.floor((gridW - (columns - 1) * GRID_GAP) / columns))
  return { columns, cardW }
}

/** Case/diacritic-insensitive substring on the title, OR a channel-number prefix
 *  match when the query is all digits ("00" and "1" both find channel 001). Results
 *  keep the curated channel order. Exported for the jest suite. */
export function searchChannels (streams: Stream[], numbers: Map<string, number>, query: string): Stream[] {
  const q = normalizeSearch(query.trim())
  if (!q) return sortByCuration(streams)
  const digits = /^\d+$/.test(q)
  return sortByCuration(streams.filter((s) => {
    if (normalizeSearch(s.title || '').includes(q)) return true
    if (!digits) return false
    const n = numbers.get(s.id)
    if (n === undefined) return false
    return String(n).startsWith(q) || String(n).padStart(3, '0').startsWith(q)
  }))
}

export interface SearchPanelProps {
  /** The channel currently playing (its card gets the accent border). */
  playingId?: string | null
  /** Tap on a result. The host tunes AND closes the overlay (see header). */
  onTune: (s: Stream) => void
}

export function SearchPanel ({ playingId, onTune }: SearchPanelProps) {
  const { t, locale } = useI18n()
  const [streams, setStreams] = useState<Stream[]>(() => visibleStreams(backend.streams))
  const [query, setQuery] = useState('')
  // false = the GUI locale's script (the default); true = the plain English A–Z.
  const [latinRail, setLatinRail] = useState(false)
  const [focused, setFocused] = useState(false)
  const [gridW, setGridW] = useState(0)

  const { width: winW, height: winH } = useWindowDimensions()
  const portrait = winH >= winW

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(visibleStreams(m.streams))
    })
  }, [])

  const numbers = useMemo(() => channelNumbers(streams), [streams])
  const results = useMemo(() => searchChannels(streams, numbers, query), [streams, numbers, query])

  // Only a locale whose script is not already Latin needs the toggle chip.
  const hasLocalScript = scriptForLocale(locale) !== 'latin'
  const letters = railLetters(locale, latinRail || !hasLocalScript)

  const append = (ch: string) => setQuery((q) => q + ch)
  // Code-point-aware backspace (kana/jamo/etc. must delete whole characters).
  const backspace = () => setQuery((q) => [...q].slice(0, -1).join(''))

  // Until the first onLayout the grid falls back to the window minus the rail, so
  // the very first frame already lays out with sane card widths.
  const gw = gridW || Math.max(1, winW - RAIL_W - GRID_GAP)
  const { columns, cardW } = searchGridGeometry(gw, portrait)

  return (
    <View style={styles.panel}>
      {/* LEFT: the letter rail. Toggle + backspace stay fixed on top; the letters
          (locale script, then the 0-9 digits row for channel numbers) scroll.
          keyboardShouldPersistTaps: the rail must keep working with the soft
          keyboard up — a rail tap types, it must not just dismiss the IME. */}
      <View style={styles.rail}>
        {hasLocalScript && (
          <Pressable
            style={styles.railToggle}
            accessibilityRole="button"
            onPress={() => setLatinRail((v) => !v)}
          >
            <Text style={styles.railToggleText}>
              {latinRail ? t('live.search.localRail') : t('live.search.latinRail')}
            </Text>
          </Pressable>
        )}
        <Pressable style={styles.railKey} accessibilityRole="button" accessibilityLabel={t('live.search.backspace')} onPress={backspace}>
          <Text style={styles.railKeyText}>⌫</Text>
        </Pressable>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always">
          {letters.map((ch) => (
            <Pressable key={ch} style={styles.railKey} accessibilityRole="button" onPress={() => append(ch)}>
              <Text style={styles.railKeyText}>{ch}</Text>
            </Pressable>
          ))}
          <View style={styles.railDivider} />
          {DIGITS.map((d) => (
            <Pressable key={d} style={styles.railKey} accessibilityRole="button" onPress={() => append(d)}>
              <Text style={styles.railKeyText}>{d}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* RIGHT: the search field on top, the result grid below. */}
      <View style={styles.main} onLayout={(e) => setGridW(e.nativeEvent.layout.width)}>
        <View style={styles.searchRow}>
          <TextInput
            style={[styles.input, focused && styles.inputFocused]}
            placeholder={t('live.search.placeholder')}
            placeholderTextColor={theme.colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
          {query.length > 0 && (
            <Pressable style={styles.clear} accessibilityRole="button" accessibilityLabel={t('live.search.clear')} onPress={() => setQuery('')}>
              <Text style={styles.clearText}>×</Text>
            </Pressable>
          )}
        </View>

        {results.length === 0
          ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>{t('search.noResults', { query: query.trim() })}</Text>
            </View>
            )
          : (
            <FlatList
              key={`cols-${columns}`} // numColumns cannot change on a live list
              data={results}
              numColumns={columns}
              keyExtractor={(s) => s.id}
              columnWrapperStyle={columns > 1 ? styles.gridRow : undefined}
              contentContainerStyle={styles.grid}
              // Result taps must land on the FIRST tap even while the keyboard is up.
              keyboardShouldPersistTaps="handled"
              initialNumToRender={columns * 4}
              windowSize={5}
              removeClippedSubviews
              renderItem={({ item }) => (
                <ChannelCard
                  stream={item}
                  number={numbers.get(item.id)}
                  w={cardW}
                  playing={item.id === playingId}
                  onPress={() => onTune(item)}
                />
              )}
            />
            )}
      </View>
    </View>
  )
}

// One result card: station logo in a 16:9 box (contain; the GuidePanel initial-box
// fallback when a channel has no art — LOGOS only, never the live thumb, WS11),
// number + name under it.
function ChannelCard ({ stream, number, w, playing, onPress }: {
  stream: Stream
  number?: number
  w: number
  playing: boolean
  onPress: () => void
}) {
  const logoH = Math.round(w * 9 / 16)
  return (
    <Pressable
      style={[styles.card, { width: w }]}
      accessibilityRole="button"
      accessibilityLabel={`${formatChannelNumber(number)} ${stream.title}`}
      onPress={onPress}
    >
      <View style={[styles.logoBox, { height: logoH }, playing && styles.logoBoxPlaying]}>
        {stream.logo
          ? <Image source={{ uri: stream.logo }} style={styles.logo} resizeMode="contain" accessibilityLabel={stream.title} />
          : <View style={[styles.logo, styles.logoFallback]}><Text style={styles.logoInitial}>{(stream.title || '?').slice(0, 1).toUpperCase()}</Text></View>}
      </View>
      <Text style={styles.cardLine} numberOfLines={1}>
        <Text style={styles.cardNumber}>{formatChannelNumber(number)}</Text>
        <Text style={styles.cardTitle}>  {stream.title}</Text>
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  panel: { flex: 1, flexDirection: 'row' },

  rail: { width: RAIL_W, marginRight: GRID_GAP, alignItems: 'stretch' },
  railToggle: {
    borderRadius: 8, backgroundColor: theme.colors.surface, paddingVertical: 6,
    alignItems: 'center', marginBottom: 4
  },
  railToggleText: { color: theme.colors.accent, fontSize: theme.type.caption, fontWeight: '800' },
  railKey: { paddingVertical: 5, alignItems: 'center', borderRadius: 6 },
  railKeyText: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '700' },
  railDivider: { height: 1, backgroundColor: theme.colors.textDim, opacity: 0.3, marginVertical: 4, marginHorizontal: 8 },

  main: { flex: 1 },
  searchRow: { flexDirection: 'row', alignItems: 'center', marginBottom: theme.spacing(1) },
  input: {
    flex: 1, backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 8, fontSize: theme.type.body,
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  inputFocused: { borderColor: theme.colors.focus },
  clear: { marginLeft: theme.spacing(0.75), paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: theme.colors.surface },
  clearText: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700' },

  grid: { paddingBottom: theme.spacing(2) },
  gridRow: { gap: GRID_GAP },

  card: { marginBottom: theme.spacing(1.25) },
  logoBox: {
    width: '100%', borderRadius: 8, borderWidth: 2, borderColor: 'transparent',
    backgroundColor: theme.colors.surface, overflow: 'hidden'
  },
  logoBoxPlaying: { borderColor: theme.colors.accent },
  logo: { width: '100%', height: '100%' },
  logoFallback: { alignItems: 'center', justifyContent: 'center' },
  logoInitial: { color: theme.colors.textDim, fontSize: theme.type.title, fontWeight: '800' },
  cardLine: { marginTop: 3, paddingHorizontal: 2 },
  cardNumber: { color: theme.colors.accent, fontSize: theme.type.caption, fontWeight: '800', fontVariant: ['tabular-nums'] },
  cardTitle: { color: theme.colors.text, fontSize: theme.type.caption, fontWeight: '700' },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: theme.colors.textDim, fontSize: theme.type.body }
})
