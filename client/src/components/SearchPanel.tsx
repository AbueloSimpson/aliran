// In-player channel search (WS15, phone) — the content of LiveScreen's 'search'
// overlay, opened from the NowPlayingBar's Search button so the viewer never has to
// leave playback to find a channel. Playback NEVER stops: this panel is pure overlay
// content; the host owns the video surface and the overlay geometry (portrait =
// video strip on top + this panel below; landscape = this panel over the fullscreen
// video on a translucent bed).
//
// LAYOUT (S22 round 5, WS16). A LEFT alphabet BOX — a multi-column letter GRID like
// a TV search keyboard (quick input: tapping a key APPENDS it to the query; the
// ABC/local-script toggle chip and ⌫ backspace fixed on top, then the letters and
// the 0-9 digits for channel numbers scrolling in rows) — and a RIGHT pane with the
// search field on top (soft-keyboard capable, with a clear ×) and the results below
// as a GRID of SMALL channel cards: station LOGO (contain; initial-box fallback —
// logos only, never live thumbs, the WS11 policy), channel number + name under it.
// The box's column count follows the SCRIPT (boxColumns — kana keeps gojūon's
// 5-per-row, Latin 5, the bigger alphabets 6; portrait compresses every script to 4
// so the results pane stays readable at ~360dp) and the results grid's column count
// DERIVES from the right pane's measured width (searchGridGeometry — as many
// ~96dp-target columns as fit), not the window. The left box and right pane split
// the panel horizontally in BOTH orientations.
// TV-READY: the box's keys are plain Pressables with ≥40dp metrics and
// accessibilityRole="button", so this same component is D-pad navigable when TV
// adopts it — but this round TV keeps its own SearchScreen (the panel stays
// phone-gated in LiveScreen).
//
// The box renders the GUI locale's SCRIPT by default (src/alphabets.ts — Cyrillic
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
import { channelNumbers, sortByCuration, displayTitle, formatChannelNumber } from '../catalog'
import { DIGITS, railLetters, scriptForLocale, normalizeSearch, type RailScript } from '../alphabets'
import { theme } from '../theme'

// Alphabet-box key metrics: ≥40dp touch targets (finger-sized now, and the Android
// TV minimum focusable size later — the D-pad readiness in the header).
const KEY = 40
const KEY_GAP = 4
const BOX_PAD = 6
const GRID_GAP = theme.spacing(1)
// Results-card width the column derivation aims for (cards come out between this
// and a bit above it, whatever divides the pane evenly) — ~35% under the old
// fixed-4-column landscape cards.
const CARD_TARGET_W = 96

/** Letter-grid columns per script. Kana keeps gojūon's natural 5-per-row; Latin's
 *  26 sit in 5; the bigger alphabets (Cyrillic 33, Devanagari 44, Thai 42) take 6.
 *  Portrait compresses every script to 4 so the results pane keeps readable card
 *  widths at ~360dp — the left/right structure itself never changes. */
export function boxColumns (script: RailScript, portrait: boolean): number {
  const base = script === 'latin' || script === 'kana' || script === 'hangul' ? 5 : 6
  return portrait ? Math.min(base, 4) : base
}

/** The alphabet box's outer width for a column count (keys + gaps + padding). */
export function boxWidth (columns: number): number {
  return columns * KEY + (columns - 1) * KEY_GAP + BOX_PAD * 2
}

/** Results-grid geometry: the column COUNT derives from the measured RIGHT-PANE
 *  width — as many ~CARD_TARGET_W columns as fit (floor 2) — and the card width
 *  follows (the VodScreen gridGeometry discipline, kept local). */
export function searchGridGeometry (gridW: number) {
  const columns = Math.max(2, Math.floor((gridW + GRID_GAP) / (CARD_TARGET_W + GRID_GAP)))
  const cardW = Math.max(56, Math.floor((gridW - (columns - 1) * GRID_GAP) / columns))
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

// Rows of n for the letter/digit grids (code-point arrays in, so multi-byte
// letters chunk correctly).
function chunk<T> (arr: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push([...arr.slice(i, i + n)])
  return out
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
  const latin = latinRail || !hasLocalScript
  const letters = railLetters(locale, latin)
  const script: RailScript = latin ? 'latin' : scriptForLocale(locale)
  const cols = boxColumns(script, portrait)
  const boxW = boxWidth(cols)

  const append = (ch: string) => setQuery((q) => q + ch)
  // Code-point-aware backspace (kana/jamo/etc. must delete whole characters).
  const backspace = () => setQuery((q) => [...q].slice(0, -1).join(''))

  // Until the first onLayout the grid falls back to the window minus the box, so
  // the very first frame already lays out with sane card widths.
  const gw = gridW || Math.max(1, winW - boxW - GRID_GAP)
  const { columns, cardW } = searchGridGeometry(gw)

  const key = (ch: string) => (
    <Pressable key={ch} style={styles.key} accessibilityRole="button" onPress={() => append(ch)}>
      <Text style={styles.keyText}>{ch}</Text>
    </Pressable>
  )

  return (
    <View style={styles.panel}>
      {/* LEFT: the alphabet box. Toggle + backspace stay fixed on top; the letter
          grid (locale script, then the 0-9 digits for channel numbers) scrolls in
          rows below them. keyboardShouldPersistTaps: the box must keep working with
          the soft keyboard up — a key tap types, it must not just dismiss the IME. */}
      <View style={[styles.box, { width: boxW }]} testID="search-alpha-box">
        <View style={styles.boxHeader}>
          {hasLocalScript && (
            <Pressable
              style={styles.boxToggle}
              accessibilityRole="button"
              onPress={() => setLatinRail((v) => !v)}
            >
              <Text style={styles.boxToggleText}>
                {latinRail ? t('live.search.localRail') : t('live.search.latinRail')}
              </Text>
            </Pressable>
          )}
          <Pressable
            style={[styles.key, !hasLocalScript && styles.keyGrow]}
            accessibilityRole="button"
            accessibilityLabel={t('live.search.backspace')}
            onPress={backspace}
          >
            <Text style={styles.keyText}>⌫</Text>
          </Pressable>
        </View>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always">
          {chunk(letters, cols).map((row, i) => (
            <View key={`r${i}`} style={styles.keyRow}>{row.map(key)}</View>
          ))}
          <View style={styles.boxDivider} />
          {chunk(DIGITS, cols).map((row, i) => (
            <View key={`d${i}`} style={styles.keyRow}>{row.map(key)}</View>
          ))}
        </ScrollView>
      </View>

      {/* RIGHT: the search field on top, the result grid below. */}
      <View style={styles.main} testID="search-results-pane" onLayout={(e) => setGridW(e.nativeEvent.layout.width)}>
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
              // …BUT NOT CLIPPING, ON A TELEVISION. removeClippedSubviews does not
              // change what is MOUNTED (windowSize decides that) — it DETACHES the
              // mounted cards that are off-screen from the native view tree, and on
              // Android a detached view is also out of FOCUS SEARCH. These cards are
              // focusables, so a DOWN press on the last visible row finds nothing
              // below it and focus wraps back to the top of the results, taking the
              // scroll with it — the channel list's "it goes down four or five
              // channels and jumps back up". The panel is still phone-gated in
              // LiveScreen (TV keeps its own SearchScreen), so the flag costs nothing
              // either way today; it is here so the D-pad readiness this file's header
              // promises is real on the day TV adopts the panel. Phone keeps the flag:
              // touch has no focus to lose.
              removeClippedSubviews={!theme.isTV}
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
  // DISPLAY only: the result card shows the clean name (catalog.displayTitle), but
  // searchChannels above keeps MATCHING on the raw title — typing "MLB" must still
  // find every game whose stored title leads with the tag. Any future highlight/
  // snippet logic must compute its indices against displayTitle, NOT the raw title:
  // the two disagree by exactly the stripped prefix.
  const title = displayTitle(stream)
  return (
    <Pressable
      style={[styles.card, { width: w }]}
      accessibilityRole="button"
      accessibilityLabel={`${formatChannelNumber(number)} ${title}`}
      onPress={onPress}
    >
      <View style={[styles.logoBox, { height: logoH }, playing && styles.logoBoxPlaying]}>
        {stream.logo
          ? <Image source={{ uri: stream.logo }} style={styles.logo} resizeMode="contain" accessibilityLabel={title} />
          : <View style={[styles.logo, styles.logoFallback]}><Text style={styles.logoInitial}>{(title || '?').slice(0, 1).toUpperCase()}</Text></View>}
      </View>
      <Text style={styles.cardLine} numberOfLines={1}>
        <Text style={styles.cardNumber}>{formatChannelNumber(number)}</Text>
        <Text style={styles.cardTitle}>  {title}</Text>
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  panel: { flex: 1, flexDirection: 'row' },

  box: {
    marginRight: GRID_GAP, padding: BOX_PAD, borderRadius: 10,
    backgroundColor: theme.colors.overlay, alignItems: 'stretch'
  },
  boxHeader: { flexDirection: 'row', gap: KEY_GAP, marginBottom: KEY_GAP },
  boxToggle: {
    flex: 1, height: KEY, borderRadius: 8, backgroundColor: theme.colors.surface,
    alignItems: 'center', justifyContent: 'center'
  },
  boxToggleText: { color: theme.colors.accent, fontSize: theme.type.caption, fontWeight: '800' },
  keyRow: { flexDirection: 'row', gap: KEY_GAP, marginBottom: KEY_GAP },
  key: {
    width: KEY, height: KEY, borderRadius: 8, backgroundColor: theme.colors.surface,
    alignItems: 'center', justifyContent: 'center'
  },
  keyGrow: { flex: 1, width: 'auto' },
  keyText: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '700' },
  boxDivider: { height: 1, backgroundColor: theme.colors.textDim, opacity: 0.3, marginBottom: KEY_GAP, marginHorizontal: 8 },

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
