// Movies & Series — the external VOD provider's landing screen (S53, design D3).
//
// Layout mirrors the Live browse surface: a narrow LEFT pane (search box + the
// Movies/Series switch) and a wide poster GRID on the right. Both panes are focus
// zones (FocusPane = TVFocusGuideView on TV) so a D-pad crosses between them and
// remembers where it was. The search field is reachable but never autofocused — on TV
// an autofocused TextInput opens the IME and swallows the remote (the S50c
// report-modal lesson: nothing in this app may become a focus trap).
//
// Everything here comes from the PROVIDER, not the catalog: the panel delivers the
// coordinates on the login payload (backend.vod) and src/vod/zencontent.ts fetches
// directly. Live TV is untouched — a provider title never enters the channel list,
// the zap ring, or the numbering.
//
// Series has no source value yet (the panel only accepts `sources.movies` today), so
// the switch is honest rather than hidden: picking Series says "No series yet".
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Image, Pressable, TextInput, FlatList, ActivityIndicator, StyleSheet, Platform, TVFocusGuideView, useWindowDimensions } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import type { VodConfig } from '@aliran/react-native'
import { backend } from '../worklet'
import { listMovies, getMovieInfo, type VodItem, type VodErrorCode } from '../vod/zencontent'
import { theme } from '../theme'

// On phone TVFocusGuideView is just a View; on TV autoFocus restores focus memory (S7).
const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

type Props = NativeStackScreenProps<RootStackParamList, 'Vod'>
type Mode = 'movies' | 'series'

// Poster tile geometry (2:3 art). The grid picks its column count from the pane width
// so the same screen fills a 10-foot TV and a phone in portrait.
const TILE_W = theme.isTV ? 190 : 110
const TILE_GAP = theme.spacing(1)

/** Case- and diacritic-insensitive fold for search ("Sick Girl" ≡ "sick girl",
 *  "Amélie" ≡ "amelie"). Hermes ships String.normalize; the try/catch keeps a stale
 *  runtime without it working (it just stops folding accents). */
// Combining diacritical marks (U+0300–U+036F), assembled with fromCharCode so the
// source file carries no bare combining characters — written literally they attach
// themselves to the preceding bracket in most editors and diff viewers.
const COMBINING_MARKS = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036F) + ']', 'g')

export function fold (s: string): string {
  const lower = (s || '').toLowerCase()
  try { return lower.normalize('NFD').replace(COMBINING_MARKS, '') } catch { return lower }
}

// Folding both titles of every item on every keystroke is real work on a 50k-title
// catalog, and the items are stable objects — fold each one once.
const folded = new WeakMap<VodItem, string>()
function haystack (it: VodItem): string {
  let v = folded.get(it)
  if (v === undefined) { v = fold(it.name) + '\n' + fold(it.nameOriginal); folded.set(it, v) }
  return v
}

/** Client-side filter over BOTH titles the provider gives us. */
export function filterItems (items: VodItem[], query: string): VodItem[] {
  const q = fold(query.trim())
  if (!q) return items
  return items.filter((it) => haystack(it).includes(q))
}

export function VodScreen ({ navigation }: Props) {
  // Login-scoped: the config rides the 'streams' message and never changes mid-session
  // (an operator's change lands at the viewer's next login).
  const config: VodConfig | null = backend.vod ?? null
  const [mode, setMode] = useState<Mode>('movies')
  const [query, setQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [items, setItems] = useState<VodItem[] | null>(null)
  const [error, setError] = useState<VodErrorCode | null>(null)
  // The tile whose stream URL is being resolved (getMovieInfo) — a spinner replaces
  // its poster until the provider answers, so a slow detail call is visible on the
  // thing the viewer pressed rather than as a frozen screen.
  const [resolving, setResolving] = useState<string | null>(null)
  // A title that would not resolve is a banner over the grid, not a screen-wide error:
  // the rest of the catalog is still perfectly usable.
  const [notice, setNotice] = useState<string | null>(null)

  const { width } = useWindowDimensions()

  useEffect(() => {
    if (!config || mode !== 'movies') return
    let live = true
    setItems(null); setError(null)
    listMovies(config).then((res) => {
      if (!live) return
      if (res.ok) setItems(res.items)
      else { setItems([]); setError(res.error) }
    })
    return () => { live = false }
  }, [config, mode])

  const results = useMemo(() => filterItems(items ?? [], query), [items, query])

  const open = useCallback(async (item: VodItem) => {
    if (!config || resolving) return
    setResolving(item.id); setNotice(null)
    const res = await getMovieInfo(config, item.id)
    setResolving(null)
    if (res.ok) navigation.navigate('VodPlayer', { url: res.url, title: item.name, durationSec: res.durationSec ?? undefined })
    else setNotice(errorText(res.error).title)
  }, [config, resolving, navigation])

  // Grid width = the screen minus the left pane and the page margins.
  const gridWidth = Math.max(TILE_W, width * (theme.isTV ? 0.74 : 0.66) - theme.safeX)
  const columns = Math.max(2, Math.floor(gridWidth / (TILE_W + TILE_GAP)))

  return (
    <View style={styles.container}>
      <FocusPane autoFocus style={styles.leftPane}>
        <Text style={styles.header}>MOVIES &amp; SERIES</Text>
        <TextInput
          style={[styles.input, searchFocused && styles.inputFocused]}
          placeholder="Search titles…"
          placeholderTextColor={theme.colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          // Never autoFocus: on TV that traps the remote inside the IME (S50c).
          autoFocus={false}
          value={query}
          onChangeText={setQuery}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
        />
        <ModeButton label="Movies" active={mode === 'movies'} onPress={() => setMode('movies')} />
        <ModeButton label="Series" active={mode === 'series'} onPress={() => setMode('series')} />
      </FocusPane>

      <FocusPane autoFocus style={styles.gridPane}>
        {!!notice && <Text style={styles.notice}>{notice}</Text>}
        {!config
          ? <Centered title="Not available" hint="This service has no movie provider configured." />
          : mode === 'series'
            ? <Centered title="No series yet" hint="Series are not part of this catalog yet." />
            : !config.sources?.movies
              ? <Centered title="No movies yet" hint="Movies are not part of this catalog yet." />
              : items === null
                ? <View style={styles.center}><ActivityIndicator color={theme.colors.accent} /><Text style={styles.hint}>Loading titles…</Text></View>
                : error
                  ? <Centered {...errorText(error)} />
                  : results.length === 0
                    ? <Centered title={query.trim() ? 'No matches' : 'Nothing here yet'} hint={query.trim() ? `No title matches "${query.trim()}".` : 'The provider returned no titles.'} />
                    : (
                      <FlatList
                        key={`cols-${columns}`} // numColumns cannot change on a live list
                        data={results}
                        numColumns={columns}
                        keyExtractor={(it) => it.id}
                        columnWrapperStyle={columns > 1 ? styles.row : undefined}
                        contentContainerStyle={styles.grid}
                        initialNumToRender={columns * 4}
                        windowSize={5}
                        removeClippedSubviews
                        renderItem={({ item, index }) => (
                          <PosterTile
                            item={item}
                            first={index === 0}
                            busy={resolving === item.id}
                            onPress={() => { void open(item) }}
                          />
                        )}
                      />
                      )}
      </FocusPane>
    </View>
  )
}

/** Honest, named failure states — the viewer is told which of the two things broke,
 *  and never shown a provider message or an HTTP code. */
function errorText (error: VodErrorCode): { title: string; hint: string } {
  if (error === 'auth') return { title: "Couldn't sign in to the movie catalog", hint: 'Your account was not accepted by the provider. Contact your service.' }
  if (error === 'network') return { title: "Couldn't reach the movie catalog", hint: 'Check your connection and try again in a moment.' }
  return { title: 'The movie catalog answered unexpectedly', hint: 'Nothing to show right now — try again later.' }
}

function Centered ({ title, hint }: { title: string; hint: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.hint}>{hint}</Text>
    </View>
  )
}

function ModeButton ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.mode, active && styles.modeActive, focused && styles.modeFocused]}
      accessibilityRole="button"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={[styles.modeText, active && styles.modeTextActive]}>{label.toUpperCase()}</Text>
    </Pressable>
  )
}

// Poster + title + year. A missing or broken `icon` falls back to the title's initial
// on a plain surface (the ChannelInfoPanel art pattern) — a grid of grey holes reads
// as breakage, an initial reads as "no art".
function PosterTile ({ item, first, busy, onPress }: { item: VodItem; first: boolean; busy: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  const [broken, setBroken] = useState(false)
  const showArt = !!item.icon && !broken
  return (
    <Pressable
      style={[styles.tile, focused && styles.tileFocused]}
      accessibilityRole="button"
      hasTVPreferredFocus={first}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <View style={styles.posterBox}>
        {showArt
          ? <Image source={{ uri: item.icon }} style={styles.poster} resizeMode="cover" onError={() => setBroken(true)} />
          : <View style={[styles.poster, styles.posterFallback]}><Text style={styles.posterInitial}>{(item.name || '?').slice(0, 1).toUpperCase()}</Text></View>}
        {busy && <View style={styles.busy}><ActivityIndicator color={theme.colors.accent} /></View>}
        {!!item.anio && <Text style={styles.year}>{item.anio}</Text>}
      </View>
      <Text style={styles.tileTitle} numberOfLines={2}>{item.name}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row', backgroundColor: theme.colors.background, paddingVertical: theme.safeY, paddingHorizontal: theme.safeX },
  leftPane: { width: theme.isTV ? '24%' : '32%', paddingRight: theme.spacing(1.5) },
  gridPane: { flex: 1 },
  header: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1.5) },
  input: {
    backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10, fontSize: theme.type.body,
    marginBottom: theme.spacing(1.5), borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  inputFocused: { borderColor: theme.colors.focus },
  mode: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, marginBottom: 8,
    borderWidth: theme.focusRing, borderColor: 'transparent', backgroundColor: theme.colors.surface
  },
  modeActive: { backgroundColor: theme.colors.primary },
  modeFocused: { borderColor: theme.colors.focus },
  modeText: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 1 },
  modeTextActive: { color: theme.colors.onPrimary },
  grid: { paddingBottom: theme.spacing(2) },
  row: { gap: TILE_GAP },
  tile: { width: TILE_W, marginBottom: theme.spacing(1.5), borderRadius: 10, borderWidth: theme.focusRing, borderColor: 'transparent' },
  tileFocused: { borderColor: theme.colors.focus },
  posterBox: { width: '100%', aspectRatio: 2 / 3 },
  poster: { width: '100%', height: '100%', borderRadius: 8, backgroundColor: theme.colors.surface },
  posterFallback: { alignItems: 'center', justifyContent: 'center' },
  posterInitial: { color: theme.colors.textDim, fontSize: theme.type.display, fontWeight: '800' },
  busy: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.overlayStrong, borderRadius: 8 },
  year: {
    position: 'absolute', bottom: 6, right: 6, color: theme.colors.text, backgroundColor: theme.colors.overlayStrong,
    fontSize: theme.type.caption - 1, fontWeight: '700', fontVariant: ['tabular-nums'],
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, overflow: 'hidden'
  },
  tileTitle: { color: theme.colors.text, fontSize: theme.type.caption, marginTop: 6 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: theme.spacing(2) },
  notice: {
    color: theme.colors.text, backgroundColor: theme.colors.overlayStrong, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8, marginBottom: theme.spacing(1), fontSize: theme.type.caption
  },
  emptyTitle: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700', textAlign: 'center' },
  hint: { color: theme.colors.textDim, fontSize: theme.type.body, textAlign: 'center' }
})
