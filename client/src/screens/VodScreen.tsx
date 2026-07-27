// Movies & Series — the external VOD provider's browse surface (S53; rebuilt in S54b
// to the reference mockups, design D4/D5/D8).
//
// LAYOUT. A narrow LEFT pane that is a MENU and nothing else — Movies / Series /
// Search — and a wide content pane carrying a tab bar (Recommended · My List · Genres ·
// All) over the poster grid. Both panes are focus zones (FocusPane = TVFocusGuideView
// on TV) so a D-pad crosses between them and remembers where it was.
//
//   Search is a MENU ITEM, not an always-visible box: it opens its own view with an
//   input and a result grid over the active kind. The input is reachable but NEVER
//   autofocused — on TV an autofocused TextInput opens the IME and swallows the remote
//   (the S50c report-modal lesson: nothing in this app may become a focus trap).
//
//   All    the whole list, ordered by the sort chip (SortMenu, D4) with the A–Z rail
//          on the right edge whenever the alphabetical sort is in force (D5).
//   Genres the provider's own genre names as cards (poster of that genre's first title)
//          -> the same grid, filtered, with a chip back to the cards.
//   My List the device-local watchlist (backend.vodList, S54a) joined against the
//          cached list. S54c adds the add/remove affordances; an empty list says so.
//   Recommended two one-row rails — Recently added and Newest releases — each with a
//          "SEE N MORE…" that jumps to All with that ordering.
//
// Everything here comes from the PROVIDER, not the catalog: the panel delivers the
// coordinates on the login payload (backend.vod) and src/vod/zencontent.ts fetches
// directly. Live TV is untouched — a provider title never enters the channel list, the
// zap ring, or the numbering. My List and the watch history are DEVICE-LOCAL (D9):
// this screen only READS them; the worklet owns the disk.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Image, Pressable, TextInput, FlatList, ActivityIndicator, StyleSheet, Platform, TVFocusGuideView, useWindowDimensions } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import type { VodConfig, VodHistoryEntry, VodListEntry } from '@aliran/react-native'
import { backend } from '../worklet'
import { listMovies, listSeries, listCategories, getMovieInfo, type VodItem, type VodErrorCode } from '../vod/zencontent'
import { DEFAULT_SORT, fold, letterBuckets, letterOf, sortItems, sortLabel, titleWithYear, type VodSortKey } from '../vod/sort'
import { SortMenu } from '../components/SortMenu'
import { AlphaRail, ALPHA_RAIL_W } from '../components/AlphaRail'
import { theme } from '../theme'

// On phone TVFocusGuideView is just a View; on TV autoFocus restores focus memory (S7).
const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

type Props = NativeStackScreenProps<RootStackParamList, 'Vod'>
type Kind = 'movies' | 'series'
type Tab = 'recommended' | 'mylist' | 'genres' | 'all'

const TABS: { key: Tab; label: string }[] = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'mylist', label: 'My List' },
  { key: 'genres', label: 'Genres' },
  { key: 'all', label: 'All' }
]

// Poster tile geometry (2:3 art). Every one of these is load-bearing for the A–Z rail:
// the row height has to be EXACT or scrollToIndex lands on the wrong row, so the tile
// gets a fixed height rather than one that follows its text (D5).
const TILE_W = theme.isTV ? 190 : 110
const TILE_GAP = theme.spacing(1.5)
const TILE_MB = theme.spacing(2)
const GRID_PAD = theme.spacing(0.5)
const POSTER_H = Math.round(TILE_W * 3 / 2)
// Two lines of caption text, always — a one-line title still occupies the full box so
// every row in the grid is the same height.
const LABEL_LINE = theme.type.caption + 4
const LABEL_PAD = 6
const LABEL_H = LABEL_LINE * 2 + LABEL_PAD * 2
export const VOD_TILE_H = POSTER_H + LABEL_H
/** Exact height of one grid ROW (tile + the gap under it) — the getItemLayout unit. */
export const VOD_ROW_H = VOD_TILE_H + TILE_MB

// The menu pane is a menu now, not a menu plus a search box, so it can be much
// narrower than the S53 layout was (mockup proportions).
const LEFT_PCT = theme.isTV ? 0.18 : 0.22

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
  const [kind, setKind] = useState<Kind>('movies')
  const [tab, setTab] = useState<Tab>('all')
  const [search, setSearch] = useState(false)
  const [query, setQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  // One sort per screen, kept across kind and tab switches (D4).
  const [sort, setSort] = useState<VodSortKey>(DEFAULT_SORT)
  const [sortOpen, setSortOpen] = useState(false)
  const [genre, setGenre] = useState<number | null>(null)
  const [items, setItems] = useState<VodItem[] | null>(null)
  const [categories, setCategories] = useState<string[]>([])
  const [error, setError] = useState<VodErrorCode | null>(null)
  // Device-local (S54a/D9). Read-only here: the worklet is the only writer.
  const [myList, setMyList] = useState<VodListEntry[]>(backend.vodList || [])
  const [history, setHistory] = useState<VodHistoryEntry[]>(backend.vodHistory || [])
  // The tile whose stream URL is being resolved (getMovieInfo) — a spinner replaces
  // its poster until the provider answers, so a slow detail call is visible on the
  // thing the viewer pressed rather than as a frozen screen.
  const [resolving, setResolving] = useState<string | null>(null)
  // A title that would not resolve is a banner over the grid, not a screen-wide error:
  // the rest of the catalog is still perfectly usable.
  const [notice, setNotice] = useState<string | null>(null)
  // Index of the first tile the grid is showing — the rail's highlight follows it.
  const [firstVisible, setFirstVisible] = useState(0)

  const { width } = useWindowDimensions()
  const listRef = useRef<FlatList<VodItem> | null>(null)

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'prefs') { setMyList(m.vodList || []); setHistory(m.vodHistory || []) }
    })
  }, [])

  // ONE download feeds movies, series and the genre names (D1) — switching kinds after
  // the first load is a cache hit, so both calls stay unconditional and simple.
  useEffect(() => {
    if (!config) return
    let live = true
    setItems(null); setError(null); setFirstVisible(0)
    const p = kind === 'movies' ? listMovies(config) : listSeries(config)
    p.then((res) => {
      if (!live) return
      if (res.ok) setItems(res.items)
      else { setItems([]); setError(res.error) }
    })
    return () => { live = false }
  }, [config, kind])

  useEffect(() => {
    if (!config) return
    let live = true
    listCategories(config).then((res) => { if (live && res.ok) setCategories(res.categories) })
    return () => { live = false }
  }, [config])

  // A stable empty list while the first download is in flight — every memo below keys
  // off this, and a fresh `[]` per render would re-sort the whole catalog each time.
  const all = useMemo(() => items ?? [], [items])
  const sorted = useMemo(() => sortItems(all, sort, history), [all, sort, history])

  // The grid the "All" tab actually shows: sorted, then narrowed to a genre when one
  // is open. Filtering AFTER sorting keeps the rail buckets consistent with the rows.
  const grid = useMemo(
    () => (genre === null ? sorted : sorted.filter((it) => it.categories.includes(genre))),
    [sorted, genre]
  )

  const results = useMemo(() => filterItems(all, query), [all, query])

  // My List, newest-saved first, joined against the cached list for THIS kind. Ids the
  // provider no longer carries simply drop out (S54c renders those from history).
  const savedIds = useMemo(() => {
    const want = kind === 'movies' ? 'movie' : 'series'
    return (myList || []).filter((e) => e && e.kind === want).map((e) => e.id)
  }, [myList, kind])
  const saved = useMemo(() => {
    const byId = new Map(all.map((it) => [it.id, it]))
    return savedIds.map((id) => byId.get(id)).filter((it): it is VodItem => !!it)
  }, [savedIds, all])

  // Genre cards: every provider genre that this kind actually has a title in, labelled
  // with the provider's own name and fronted by that genre's first title in ADDED order
  // (the provider's list order, not the current sort — the card must not move about).
  const genreCards = useMemo(() => {
    const first = new Map<number, VodItem>()
    for (const it of all) for (const c of it.categories) if (!first.has(c)) first.set(c, it)
    return categories
      .map((name, index) => ({ index, name, item: first.get(index) }))
      .filter((g): g is { index: number; name: string; item: VodItem } => !!g.item)
  }, [all, categories])

  const rails = useMemo(() => ([
    { key: 'added' as VodSortKey, title: 'RECENTLY ADDED', items: sortItems(all, 'added') },
    { key: 'yearDesc' as VodSortKey, title: 'NEWEST RELEASES', items: sortItems(all, 'yearDesc') }
  ]), [all])

  // The rail belongs to whichever grid is showing the SORTED list — "All", and a genre
  // opened from the cards. It is never drawn in any other sort (D5).
  const onGrid = tab === 'all' || (tab === 'genres' && genre !== null)
  const railShown = !search && onGrid && sort === 'az' && grid.length > 0
  const buckets = useMemo(() => (railShown ? letterBuckets(grid) : []), [railShown, grid])

  // Grid width = the content pane minus its padding and (when shown) the A–Z rail.
  // n tiles carry n-1 gaps between them, hence the +TILE_GAP in the division.
  const inner = Math.max(TILE_W, width - theme.safeX * 2)
  const gridWidth = Math.max(
    TILE_W,
    inner * (1 - LEFT_PCT) - theme.spacing(1.5) - GRID_PAD * 2 - (railShown ? ALPHA_RAIL_W : 0)
  )
  const columns = Math.max(2, Math.floor((gridWidth + TILE_GAP) / (TILE_W + TILE_GAP)))

  // FlatList with numColumns feeds getItemLayout and scrollToIndex ROW indexes (it
  // packs `columns` items into one virtualized cell) — every jump therefore has to be
  // divided down, and the layout describes a ROW, not a tile.
  const getItemLayout = useCallback(
    (_: unknown, rowIndex: number) => ({ length: VOD_ROW_H, offset: VOD_ROW_H * rowIndex, index: rowIndex }),
    []
  )

  // onViewableItemsChanged pairs MUST keep their identity for the life of the list or
  // RN throws mid-scroll ("Changing viewabilityConfigCallbackPairs on the fly is not
  // supported") — hence the ref. 5% is deliberately low: a row that has barely entered
  // the viewport is the one whose letter the rail should be showing.
  const viewabilityPairs = useRef([{
    viewabilityConfig: { itemVisiblePercentThreshold: 5 },
    onViewableItemsChanged: ({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
      const first = viewableItems && viewableItems[0]
      if (first && typeof first.index === 'number') setFirstVisible(first.index)
    }
  }]).current

  const jumpToLetter = useCallback((letter: string) => {
    const bucket = buckets.find((b) => b.letter === letter)
    if (!bucket || !listRef.current) return
    setFirstVisible(bucket.index)
    listRef.current.scrollToIndex({ index: Math.floor(bucket.index / columns), animated: true })
  }, [buckets, columns])

  const onScrollToIndexFailed = useCallback((info: { index: number }) => {
    // Outside the render window: fall back to the offset the exact row math gives us.
    listRef.current?.scrollToOffset({ offset: info.index * VOD_ROW_H, animated: true })
  }, [])

  const open = useCallback(async (item: VodItem) => {
    if (!config || resolving) return
    // A series never plays directly (D3) — it opens its own detail screen.
    if (kind === 'series') {
      navigation.navigate('VodSeries', { id: item.id, name: item.name, icon: item.icon || undefined, anio: item.anio || undefined })
      return
    }
    setResolving(item.id); setNotice(null)
    const res = await getMovieInfo(config, item.id)
    setResolving(null)
    if (res.ok) navigation.navigate('VodPlayer', { url: res.url, title: item.name, durationSec: res.durationSec ?? undefined })
    else setNotice(errorText(res.error).title)
  }, [config, resolving, navigation, kind])

  const chooseKind = useCallback((k: Kind) => {
    setKind(k); setSearch(false); setGenre(null); setQuery(''); setNotice(null); setFirstVisible(0)
  }, [])
  const chooseTab = useCallback((t: Tab) => {
    setTab(t); setSearch(false); setGenre(null); setFirstVisible(0)
  }, [])
  const seeMore = useCallback((key: VodSortKey) => {
    setSort(key); setTab('all'); setGenre(null); setFirstVisible(0)
  }, [])

  const noSource = kind === 'movies' ? !config?.sources?.movies : !config?.sources?.series
  const genreName = genre === null ? '' : (categories[genre] || '')

  function renderGrid (data: VodItem[], empty: { title: string; hint: string }, withRail: boolean) {
    if (data.length === 0) return <Centered {...empty} />
    return (
      <View style={styles.gridRow}>
        <FlatList
          ref={withRail ? listRef : undefined}
          key={`cols-${columns}`} // numColumns cannot change on a live list
          style={styles.gridFlex}
          data={data}
          numColumns={columns}
          keyExtractor={(it) => it.id}
          columnWrapperStyle={columns > 1 ? styles.row : undefined}
          contentContainerStyle={styles.grid}
          initialNumToRender={columns * 4}
          windowSize={5}
          removeClippedSubviews
          getItemLayout={getItemLayout}
          onScrollToIndexFailed={onScrollToIndexFailed}
          viewabilityConfigCallbackPairs={viewabilityPairs}
          renderItem={({ item, index }) => (
            <PosterTile
              item={item}
              first={index === 0}
              busy={resolving === item.id}
              onPress={() => { void open(item) }}
            />
          )}
        />
        {withRail && (
          <AlphaRail
            letters={buckets.map((b) => b.letter)}
            active={letterOf(data[Math.min(firstVisible, data.length - 1)]?.name || '')}
            onSelect={jumpToLetter}
          />
        )}
      </View>
    )
  }

  function renderBody () {
    if (!config) return <Centered title="Not available" hint="This service has no movie provider configured." />
    if (noSource) {
      return kind === 'movies'
        ? <Centered title="No movies yet" hint="Movies are not part of this catalog yet." />
        : <Centered title="No series yet" hint="Series are not part of this catalog yet." />
    }
    if (items === null) return <View style={styles.center}><ActivityIndicator color={theme.colors.accent} /><Text style={styles.hint}>Loading titles…</Text></View>
    if (error) return <Centered {...errorText(error)} />

    if (search) {
      return (
        <>
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
          {renderGrid(results, query.trim()
            ? { title: 'No matches', hint: `No title matches "${query.trim()}".` }
            : { title: 'Nothing here yet', hint: 'The provider returned no titles.' }, false)}
        </>
      )
    }

    if (tab === 'recommended') {
      if (all.length === 0) return <Centered title="Nothing here yet" hint="The provider returned no titles." />
      return (
        <View style={styles.rails}>
          {rails.map((r) => (
            <Rail
              key={r.key}
              title={r.title}
              items={r.items.slice(0, columns)}
              more={Math.max(0, r.items.length - columns)}
              busyId={resolving}
              onPressItem={(it) => { void open(it) }}
              onSeeMore={() => seeMore(r.key)}
            />
          ))}
        </View>
      )
    }

    if (tab === 'mylist') {
      return renderGrid(saved, {
        title: 'Your list is empty',
        hint: 'Titles you add to My List appear here.'
      }, false)
    }

    if (tab === 'genres' && genre === null) {
      if (genreCards.length === 0) return <Centered title="No genres" hint="The provider named no genres for these titles." />
      return (
        <FlatList
          key={`genres-${columns}`}
          data={genreCards}
          numColumns={columns}
          keyExtractor={(g) => String(g.index)}
          columnWrapperStyle={columns > 1 ? styles.row : undefined}
          contentContainerStyle={styles.grid}
          renderItem={({ item, index }) => (
            <GenreCard genre={item} first={index === 0} onPress={() => setGenre(item.index)} />
          )}
        />
      )
    }

    // 'all', and a genre that has been opened from the cards.
    return renderGrid(grid, {
      title: genre === null ? 'Nothing here yet' : 'Nothing in this genre',
      hint: genre === null ? 'The provider returned no titles.' : 'No title here carries that genre.'
    }, railShown)
  }

  const showChips = !search && onGrid

  return (
    <View style={styles.container}>
      <FocusPane autoFocus style={styles.leftPane}>
        <Text style={styles.header}>MOVIES &amp; SERIES</Text>
        <MenuButton label="Movies" active={!search && kind === 'movies'} onPress={() => chooseKind('movies')} />
        <MenuButton label="Series" active={!search && kind === 'series'} onPress={() => chooseKind('series')} />
        <MenuButton label="Search" active={search} onPress={() => { setSearch(true); setGenre(null) }} />
      </FocusPane>

      <FocusPane autoFocus style={styles.contentPane}>
        <View style={styles.tabs}>
          {TABS.map((t) => (
            <TabButton key={t.key} label={t.label} active={!search && tab === t.key} onPress={() => chooseTab(t.key)} />
          ))}
        </View>

        {showChips && (
          <View style={styles.chips}>
            {genre !== null && (
              <Chip label={`Genre: ${genreName || 'Unnamed'}`} onPress={() => setGenre(null)} />
            )}
            <View style={styles.chipSpacer} />
            <Chip label={`Sort by: ${sortLabel(sort)}`} onPress={() => setSortOpen(true)} />
          </View>
        )}

        {!!notice && <Text style={styles.notice}>{notice}</Text>}
        {renderBody()}
      </FocusPane>

      {sortOpen && (
        <SortMenu
          value={sort}
          onSelect={(k) => { setSort(k); setFirstVisible(0) }}
          onClose={() => setSortOpen(false)}
        />
      )}
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

function MenuButton ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.menu, active && styles.menuActive, focused && styles.menuFocused]}
      accessibilityRole="button"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={[styles.menuText, active && styles.menuTextActive]}>{label.toUpperCase()}</Text>
    </Pressable>
  )
}

function TabButton ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.tab, active && styles.tabActive, focused && styles.tabFocused]}
      accessibilityRole="button"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label.toUpperCase()}</Text>
    </Pressable>
  )
}

function Chip ({ label, onPress }: { label: string; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.chip, focused && styles.chipFocused]}
      accessibilityRole="button"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  )
}

/** One horizontal "rail" on Recommended: a heading, a single row of tiles, and the
 *  "SEE N MORE…" that opens the full grid in that same ordering. */
function Rail ({ title, items, more, busyId, onPressItem, onSeeMore }: {
  title: string
  items: VodItem[]
  more: number
  busyId: string | null
  onPressItem: (it: VodItem) => void
  onSeeMore: () => void
}) {
  if (items.length === 0) return null
  return (
    <View style={styles.rail}>
      <View style={styles.railHead}>
        <Text style={styles.railTitle}>{title}</Text>
        {more > 0 && <Chip label={`SEE ${more} MORE…`} onPress={onSeeMore} />}
      </View>
      <View style={styles.railRow}>
        {items.map((it) => (
          <PosterTile key={it.id} item={it} first={false} busy={busyId === it.id} onPress={() => onPressItem(it)} />
        ))}
      </View>
    </View>
  )
}

// A genre card wears the tile's clothes: the genre's first title as the art, the
// provider's genre NAME in the label box.
function GenreCard ({ genre, first, onPress }: { genre: { index: number; name: string; item: VodItem }; first: boolean; onPress: () => void }) {
  return <Tile art={genre.item.icon} label={genre.name} initial={genre.name} first={first} busy={false} onPress={onPress} />
}

// Poster + title. A missing or broken `icon` falls back to the title's initial on a
// plain surface (the ChannelInfoPanel art pattern) — a grid of grey holes reads as
// breakage, an initial reads as "no art".
function PosterTile ({ item, first, busy, onPress }: { item: VodItem; first: boolean; busy: boolean; onPress: () => void }) {
  return <Tile art={item.icon} label={titleWithYear(item)} initial={item.name} first={first} busy={busy} onPress={onPress} />
}

// The shared tile: a framed poster with a fixed-height LABEL BOX underneath (D8). The
// height is fixed on purpose — the A–Z rail's scrollToIndex math depends on every row
// being exactly VOD_ROW_H tall.
function Tile ({ art, label, initial, first, busy, onPress }: {
  art: string
  label: string
  initial: string
  first: boolean
  busy: boolean
  onPress: () => void
}) {
  const [focused, setFocused] = useState(false)
  const [broken, setBroken] = useState(false)
  const showArt = !!art && !broken
  return (
    <Pressable
      style={styles.tile}
      accessibilityRole="button"
      hasTVPreferredFocus={first}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <View style={[styles.posterBox, focused && styles.posterBoxFocused]}>
        {showArt
          ? <Image source={{ uri: art }} style={styles.poster} resizeMode="cover" onError={() => setBroken(true)} />
          : <View style={[styles.poster, styles.posterFallback]}><Text style={styles.posterInitial}>{(initial || '?').slice(0, 1).toUpperCase()}</Text></View>}
        {busy && <View style={styles.busy}><ActivityIndicator color={theme.colors.accent} /></View>}
      </View>
      <View style={[styles.labelBox, focused && styles.labelBoxFocused]}>
        <Text style={styles.tileTitle} numberOfLines={2}>{label}</Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row', backgroundColor: theme.colors.background, paddingVertical: theme.safeY, paddingHorizontal: theme.safeX },
  leftPane: { width: theme.isTV ? '18%' : '22%', paddingRight: theme.spacing(1.5) },
  contentPane: { flex: 1 },
  header: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1.5) },
  input: {
    backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10, fontSize: theme.type.body,
    marginBottom: theme.spacing(1), borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  inputFocused: { borderColor: theme.colors.focus },
  menu: {
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, marginBottom: 8,
    borderWidth: theme.focusRing, borderColor: 'transparent', backgroundColor: theme.colors.surface
  },
  menuActive: { backgroundColor: theme.colors.primary },
  menuFocused: { borderColor: theme.colors.focus },
  menuText: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 1 },
  menuTextActive: { color: theme.colors.onPrimary },

  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing(0.75), marginBottom: theme.spacing(0.75) },
  tab: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: theme.focusRing, borderColor: 'transparent'
  },
  tabActive: { backgroundColor: theme.colors.surface },
  tabFocused: { borderColor: theme.colors.focus },
  tabText: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1 },
  tabTextActive: { color: theme.colors.text },

  chips: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(0.75), marginBottom: theme.spacing(0.75) },
  chipSpacer: { flex: 1 },
  chip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: theme.colors.surface,
    borderWidth: theme.focusRing, borderColor: 'transparent'
  },
  chipFocused: { borderColor: theme.colors.focus },
  chipText: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '700', letterSpacing: 1 },

  gridRow: { flex: 1, flexDirection: 'row' },
  gridFlex: { flex: 1 },
  grid: { paddingBottom: theme.spacing(2), paddingHorizontal: GRID_PAD },
  row: { gap: TILE_GAP },

  rails: { flex: 1 },
  rail: { marginBottom: theme.spacing(1.5) },
  railHead: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1), marginBottom: theme.spacing(0.5) },
  railTitle: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2, flexShrink: 1 },
  railRow: { flexDirection: 'row', gap: TILE_GAP, paddingHorizontal: GRID_PAD },

  tile: { width: TILE_W, height: VOD_TILE_H, marginBottom: TILE_MB },
  posterBox: {
    width: '100%', height: POSTER_H, borderRadius: 8, borderWidth: 1,
    borderColor: theme.colors.textDim, overflow: 'hidden', backgroundColor: theme.colors.surface
  },
  posterBoxFocused: { borderColor: theme.colors.focus },
  poster: { width: '100%', height: '100%', backgroundColor: theme.colors.surface },
  posterFallback: { alignItems: 'center', justifyContent: 'center' },
  posterInitial: { color: theme.colors.textDim, fontSize: theme.type.display, fontWeight: '800' },
  busy: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.overlayStrong },
  labelBox: { width: '100%', height: LABEL_H, paddingVertical: LABEL_PAD, paddingHorizontal: 4, justifyContent: 'flex-start' },
  labelBoxFocused: { backgroundColor: theme.colors.surface, borderRadius: 6 },
  tileTitle: { color: theme.colors.text, fontSize: theme.type.caption, lineHeight: LABEL_LINE, height: LABEL_LINE * 2, textAlign: 'center' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: theme.spacing(2) },
  notice: {
    color: theme.colors.text, backgroundColor: theme.colors.overlayStrong, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8, marginBottom: theme.spacing(1), fontSize: theme.type.caption
  },
  emptyTitle: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700', textAlign: 'center' },
  hint: { color: theme.colors.textDim, fontSize: theme.type.body, textAlign: 'center' }
})
