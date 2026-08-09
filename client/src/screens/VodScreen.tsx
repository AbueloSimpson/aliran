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
//          cached list; an empty list says so. LONG-PRESS any tile (movie or series,
//          any tab) to add or remove it — a long press is the one gesture that costs
//          the grid no extra focusable, so the D-pad path on TV is unchanged (S7) and
//          the remote's own long-select works there (S54c).
//   Recommended two one-row rails — Recently added and Newest releases — each with a
//          "SEE N MORE…" that jumps to All with that ordering.
//
// Everything here comes from the PROVIDER, not the catalog: the panel delivers the
// coordinates on the login payload (backend.vod) and src/vod/zencontent.ts fetches
// directly. Live TV is untouched — a provider title never enters the channel list, the
// zap ring, or the numbering. My List and the watch history are DEVICE-LOCAL (D9):
// this screen only READS them; the worklet owns the disk.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Image, Pressable, TextInput, FlatList, ScrollView, ActivityIndicator, StyleSheet, Platform, TVFocusGuideView, useWindowDimensions } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import type { VodConfig, VodHistoryEntry, VodListEntry } from '@aliran/react-native'
import { getLocale, useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { listMovies, listSeries, listCategories, getMovieInfo, type VodItem, type VodErrorCode } from '../vod/zencontent'
import { DEFAULT_SORT, fold, letterBuckets, letterOf, sortItems, titleWithYear, type VodSortKey } from '../vod/sort'
import { SortMenu } from '../components/SortMenu'
import { AlphaRail, ALPHA_RAIL_W } from '../components/AlphaRail'
import { theme } from '../theme'

// On phone TVFocusGuideView is just a View; on TV autoFocus restores focus memory (S7).
const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

type Props = NativeStackScreenProps<RootStackParamList, 'Vod'>
type Kind = 'movies' | 'series'
type Tab = 'recommended' | 'mylist' | 'genres' | 'all'

// Tab ORDER, not tab copy — the label is looked up per render from vod.tab.<key>,
// so a language change repaints the bar (a module-level label table could not).
const TABS: Tab[] = ['recommended', 'mylist', 'genres', 'all']

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

/** Grid geometry per orientation (WS13, S22 feedback). Landscape and TV keep the fixed
 *  mockup tile (TILE_W) and the left menu pane's width math. Phone PORTRAIT drops the
 *  left pane (it becomes a chip row above the grid), so the grid owns the full width —
 *  and sizes exactly THREE columns out of it, which means the tile (and therefore the
 *  row height) becomes a function of the width. getItemLayout, the A–Z jump math and
 *  the test suite all read the same numbers from here so they cannot drift. */
export function gridGeometry (width: number, height: number, railShown: boolean) {
  const portrait = !theme.isTV && height >= width
  const inner = Math.max(TILE_W, width - theme.safeX * 2)
  if (!portrait) {
    const gridWidth = Math.max(
      TILE_W,
      inner * (1 - LEFT_PCT) - theme.spacing(1.5) - GRID_PAD * 2 - (railShown ? ALPHA_RAIL_W : 0)
    )
    const columns = Math.max(2, Math.floor((gridWidth + TILE_GAP) / (TILE_W + TILE_GAP)))
    return { portrait, columns, tileW: TILE_W, rowH: VOD_ROW_H }
  }
  const gridWidth = Math.max(TILE_W, inner - GRID_PAD * 2 - (railShown ? ALPHA_RAIL_W : 0))
  const columns = 3
  const tileW = Math.max(72, Math.floor((gridWidth - (columns - 1) * TILE_GAP) / columns))
  return { portrait, columns, tileW, rowH: Math.round(tileW * 3 / 2) + LABEL_H + TILE_MB }
}

// A Recommended carousel carries at most this many titles — "SEE N MORE…" is the
// path to the rest (user decision, S54 polish).
const RAIL_MAX = 50

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
  const { t } = useI18n()
  // Login-scoped: the config rides the 'streams' message and never changes mid-session
  // (an operator's change lands at the viewer's next login).
  const config: VodConfig | null = backend.vod ?? null
  const [kind, setKind] = useState<Kind>('movies')
  // Recommended is the landing tab (QA round 2): a viewer who backed out of a title
  // finds it right there under CONTINUE WATCHING instead of searching again.
  const [tab, setTab] = useState<Tab>('recommended')
  const [search, setSearch] = useState(false)
  // What the search field holds while typing. The COMMITTED `query` only updates on
  // the keyboard's search/Done action — filtering per keystroke re-rendered the grid
  // under the field on every letter, and the fresh first tile's TV preferred-focus
  // yanked Android focus off the input (keyboard closed after each character).
  const [draft, setDraft] = useState('')
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

  const { width, height } = useWindowDimensions()
  const listRef = useRef<FlatList<VodItem> | null>(null)

  // A My-List confirmation is a FLASH, not a state: it says what just happened and then
  // gets out of the way. (A provider failure uses setNotice directly and stays put.)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => { noticeTimer.current = null; setNotice(null) }, 2500)
  }, [])
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current) }, [])

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

  // CONTINUE WATCHING (QA round 2): the unfinished titles of the ACTIVE kind, newest
  // watch first. History is newest-first already; the first entry per credited id is
  // the one that counts, an episode credits its parent series (the watchedAt rule),
  // and positionSec 0 means finished (WATCHED_FRACTION) — nothing to continue.
  const continueWatching = useMemo(() => {
    const byId = new Map(all.map((it) => [it.id, it]))
    const seen = new Set<string>()
    const out: VodItem[] = []
    for (const h of history) {
      if (!h || !(h.positionSec > 0)) continue
      if ((kind === 'movies') !== (h.kind === 'movie')) continue
      const creditId = h.kind === 'episode' ? (h.seriesId || '') : h.id
      if (!creditId || seen.has(creditId)) continue
      seen.add(creditId)
      const it = byId.get(creditId)
      if (it) out.push(it)
    }
    return out
  }, [history, all, kind])

  // The orderings stay memoized (sorting a 50k-title catalog is real work); the shelf
  // HEADINGS are resolved outside the memo, which a language change can reach.
  const railItems = useMemo(() => ({
    watched: continueWatching,
    added: sortItems(all, 'added'),
    yearDesc: sortItems(all, 'yearDesc')
  }), [all, continueWatching])
  const rails = [
    { key: 'watched' as VodSortKey, title: t('vod.rail.continueWatching'), items: railItems.watched },
    { key: 'added' as VodSortKey, title: t('vod.rail.recentlyAdded'), items: railItems.added },
    { key: 'yearDesc' as VodSortKey, title: t('vod.rail.newestReleases'), items: railItems.yearDesc }
  ]

  // The rail belongs to whichever grid is showing the SORTED list — "All", and a genre
  // opened from the cards. It is never drawn in any other sort (D5).
  const onGrid = tab === 'all' || (tab === 'genres' && genre !== null)
  const railShown = !search && onGrid && sort === 'az' && grid.length > 0
  const buckets = useMemo(() => (railShown ? letterBuckets(grid) : []), [railShown, grid])

  // Orientation-aware grid geometry (WS13): landscape/TV = fixed tile + left-pane
  // math; phone portrait = the full width divided into exactly three columns.
  const { portrait, columns, tileW, rowH } = gridGeometry(width, height, railShown)

  // FlatList with numColumns feeds getItemLayout and scrollToIndex ROW indexes (it
  // packs `columns` items into one virtualized cell) — every jump therefore has to be
  // divided down, and the layout describes a ROW, not a tile.
  const getItemLayout = useCallback(
    (_: unknown, rowIndex: number) => ({ length: rowH, offset: rowH * rowIndex, index: rowIndex }),
    [rowH]
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
    listRef.current?.scrollToOffset({ offset: info.index * rowH, animated: true })
  }, [rowH])

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
    if (res.ok) {
      // id/kind travel with the url so the player can remember where the viewer got to
      // (D9) — and resumeSec brings them back there next time.
      const seen = (history || []).find((h) => h && h.kind === 'movie' && h.id === item.id)
      navigation.navigate('VodPlayer', {
        url: res.url,
        title: item.name,
        durationSec: res.durationSec ?? undefined,
        id: item.id,
        kind: 'movie',
        ...(seen && seen.positionSec > 0 ? { resumeSec: seen.positionSec } : {})
      })
    } else setNotice(errorText(t, res.error).title)
  }, [config, resolving, navigation, kind, history, t])

  // My List, from a LONG PRESS on the tile (D9). Whole-array replace, newest first; the
  // optimistic local state keeps the grid honest for the frame or two before the worklet
  // answers with a 'prefs', which is the truth about what was actually stored.
  const toggleSaved = useCallback((item: VodItem) => {
    const entryKind: VodListEntry['kind'] = kind === 'movies' ? 'movie' : 'series'
    const current = myList || []
    const has = current.some((e) => e && e.kind === entryKind && e.id === item.id)
    const rest = current.filter((e) => !(e && e.kind === entryKind && e.id === item.id))
    const next: VodListEntry[] = has ? rest : [{ kind: entryKind, id: item.id }, ...rest]
    setMyList(next)
    flashNotice(has ? t('vod.myList.removed', { name: item.name }) : t('vod.myList.added', { name: item.name }))
    try { backend.setVodList(next) } catch { /* device-local convenience, never fatal */ }
  }, [kind, myList, flashNotice, t])

  const chooseKind = useCallback((k: Kind) => {
    setKind(k); setSearch(false); setGenre(null); setQuery(''); setDraft(''); setNotice(null); setFirstVisible(0)
  }, [])
  const chooseTab = useCallback((next: Tab) => {
    setTab(next); setSearch(false); setGenre(null); setFirstVisible(0)
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
              w={portrait ? tileW : undefined}
              onPress={() => { void open(item) }}
              onLongPress={() => toggleSaved(item)}
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
    if (!config) return <Centered title={t('vod.empty.noProviderTitle')} hint={t('vod.empty.noProviderHint')} />
    if (noSource) {
      return kind === 'movies'
        ? <Centered title={t('vod.empty.noMoviesTitle')} hint={t('vod.empty.noMoviesHint')} />
        : <Centered title={t('vod.empty.noSeriesTitle')} hint={t('vod.empty.noSeriesHint')} />
    }
    if (items === null) return <View style={styles.center}><ActivityIndicator color={theme.colors.accent} /><Text style={styles.hint}>{t('vod.loading')}</Text></View>
    if (error) return <Centered {...errorText(t, error)} />

    if (search) {
      return (
        <>
          <TextInput
            style={[styles.input, searchFocused && styles.inputFocused]}
            placeholder={t('vod.searchPlaceholder')}
            placeholderTextColor={theme.colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            // Never autoFocus: on TV that traps the remote inside the IME (S50c).
            autoFocus={false}
            value={draft}
            onChangeText={setDraft}
            // Type the whole query, then the keyboard's search action runs it.
            returnKeyType="search"
            onSubmitEditing={() => { setQuery(draft); setFirstVisible(0) }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
          />
          {renderGrid(results, query.trim()
            ? { title: t('vod.empty.noMatchesTitle'), hint: t('vod.empty.noMatchesHint', { query: query.trim() }) }
            : { title: t('vod.empty.nothingTitle'), hint: t('vod.empty.nothingHint') }, false)}
        </>
      )
    }

    if (tab === 'recommended') {
      if (all.length === 0) return <Centered title={t('vod.empty.nothingTitle')} hint={t('vod.empty.nothingHint')} />
      // The stack of shelves scrolls VERTICALLY (a second shelf must never clip dead),
      // and each shelf is a horizontal carousel capped at RAIL_MAX titles — "SEE N
      // MORE…" (right-aligned in the shelf head) covers the rest.
      return (
        <ScrollView style={styles.rails} showsVerticalScrollIndicator={false}>
          {rails.map((r) => (
            <Rail
              key={r.key}
              title={r.title}
              items={r.items.slice(0, RAIL_MAX)}
              more={Math.max(0, r.items.length - RAIL_MAX)}
              busyId={resolving}
              onPressItem={(it) => { void open(it) }}
              onLongPressItem={toggleSaved}
              onSeeMore={() => seeMore(r.key)}
            />
          ))}
        </ScrollView>
      )
    }

    if (tab === 'mylist') {
      return renderGrid(saved, {
        title: t('vod.empty.myListTitle'),
        hint: t('vod.empty.myListHint')
      }, false)
    }

    if (tab === 'genres' && genre === null) {
      if (genreCards.length === 0) return <Centered title={t('vod.empty.noGenresTitle')} hint={t('vod.empty.noGenresHint')} />
      return (
        <FlatList
          key={`genres-${columns}`}
          data={genreCards}
          numColumns={columns}
          keyExtractor={(g) => String(g.index)}
          columnWrapperStyle={columns > 1 ? styles.row : undefined}
          contentContainerStyle={styles.grid}
          renderItem={({ item, index }) => (
            <GenreCard genre={item} first={index === 0} w={portrait ? tileW : undefined} onPress={() => setGenre(item.index)} />
          )}
        />
      )
    }

    // 'all', and a genre that has been opened from the cards.
    return renderGrid(grid, {
      title: genre === null ? t('vod.empty.nothingTitle') : t('vod.empty.genreTitle'),
      hint: genre === null ? t('vod.empty.nothingHint') : t('vod.empty.genreHint')
    }, railShown)
  }

  const showChips = !search && onGrid

  // The section menu, one source of truth for both orientations: the landscape LEFT
  // PANE renders it as MenuButtons, phone portrait as a horizontal chip row (WS13).
  const menu = [
    { key: 'movies', label: t('vod.menu.movies'), active: !search && kind === 'movies', go: () => chooseKind('movies') },
    { key: 'series', label: t('vod.menu.series'), active: !search && kind === 'series', go: () => chooseKind('series') },
    { key: 'search', label: t('vod.menu.search'), active: search, go: () => { setSearch(true); setGenre(null) } }
  ]

  return (
    <View style={[styles.container, portrait && styles.containerPortrait]}>
      {portrait
        ? (
          // PHONE PORTRAIT (WS13, S22 feedback): the left pane collapses into a
          // horizontal chip row above the grid (the guide's chip grammar), so the
          // poster grid gets the full width underneath.
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.menuRow} contentContainerStyle={styles.menuRowContent} testID="vod-menu-row">
            {menu.map((m) => <MenuChip key={m.key} label={m.label} active={m.active} onPress={m.go} />)}
          </ScrollView>
          )
        : (
          <FocusPane autoFocus style={styles.leftPane}>
            <Text style={styles.header}>{t('vod.header')}</Text>
            {menu.map((m) => <MenuButton key={m.key} label={m.label} active={m.active} onPress={m.go} />)}
          </FocusPane>
          )}

      <FocusPane autoFocus style={styles.contentPane}>
        {portrait
          ? (
            // Full-width tab bar that SCROLLS instead of wrapping/clipping (the S22
            // complaint) — same TabButtons, laid in one horizontal row.
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabsRowPortrait}>
              {TABS.map((key) => (
                <TabButton key={key} label={t('vod.tab.' + key)} active={!search && tab === key} onPress={() => chooseTab(key)} />
              ))}
            </ScrollView>
            )
          : (
            <View style={styles.tabs}>
              {TABS.map((key) => (
                <TabButton key={key} label={t('vod.tab.' + key)} active={!search && tab === key} onPress={() => chooseTab(key)} />
              ))}
            </View>
            )}

        {showChips && (
          <View style={styles.chips}>
            {genre !== null && (
              <Chip label={t('vod.chip.genre', { name: genreName || t('vod.chip.genreUnnamed') })} onPress={() => setGenre(null)} />
            )}
            <View style={styles.chipSpacer} />
            <Chip label={t('vod.chip.sortBy', { label: t('vod.sort.' + sort) })} onPress={() => setSortOpen(true)} />
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
function errorText (t: ReturnType<typeof useI18n>['t'], error: VodErrorCode): { title: string; hint: string } {
  if (error === 'auth') return { title: t('vod.error.authTitle'), hint: t('vod.error.authHint') }
  if (error === 'network') return { title: t('vod.error.networkTitle'), hint: t('vod.error.networkHint') }
  return { title: t('vod.error.otherTitle'), hint: t('vod.error.otherHint') }
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
      <Text style={[styles.menuText, active && styles.menuTextActive]}>{label.toLocaleUpperCase(getLocale())}</Text>
    </Pressable>
  )
}

// Portrait section chip (WS13): the guide's chip grammar (rounded pill, uppercase
// caption), with the vod menu's active color (primary fill) so the active KIND reads
// differently from the active TAB underneath it.
function MenuChip ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.menuChip, active && styles.menuChipActive, focused && styles.menuChipFocused]}
      accessibilityRole="button"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={[styles.menuChipText, active && styles.menuChipTextActive]}>{label.toLocaleUpperCase(getLocale())}</Text>
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
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label.toLocaleUpperCase(getLocale())}</Text>
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

/** One horizontal "rail" on Recommended: a heading with a right-aligned "SEE N MORE…",
 *  and a horizontally scrolling carousel of up to RAIL_MAX tiles. */
function Rail ({ title, items, more, busyId, onPressItem, onLongPressItem, onSeeMore }: {
  title: string
  items: VodItem[]
  more: number
  busyId: string | null
  onPressItem: (it: VodItem) => void
  onLongPressItem: (it: VodItem) => void
  onSeeMore: () => void
}) {
  const { t } = useI18n()
  if (items.length === 0) return null
  return (
    <View style={styles.rail}>
      <View style={styles.railHead}>
        <Text style={styles.railTitle}>{title}</Text>
        {more > 0 && <Chip label={t('vod.chip.seeMore', { count: more })} onPress={onSeeMore} />}
      </View>
      <FlatList
        horizontal
        data={items}
        keyExtractor={(it) => it.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.railRow}
        renderItem={({ item }) => (
          <PosterTile
            item={item}
            first={false}
            busy={busyId === item.id}
            onPress={() => onPressItem(item)}
            onLongPress={() => onLongPressItem(item)}
          />
        )}
      />
    </View>
  )
}

// A genre card wears the tile's clothes: the genre's first title as the art, the
// provider's genre NAME in the label box.
function GenreCard ({ genre, first, w, onPress }: { genre: { index: number; name: string; item: VodItem }; first: boolean; w?: number; onPress: () => void }) {
  return <Tile art={genre.item.icon} label={genre.name} initial={genre.name} first={first} busy={false} w={w} onPress={onPress} />
}

// Poster + title. A missing or broken `icon` falls back to the title's initial on a
// plain surface (the ChannelInfoPanel art pattern) — a grid of grey holes reads as
// breakage, an initial reads as "no art".
function PosterTile ({ item, first, busy, w, onPress, onLongPress }: { item: VodItem; first: boolean; busy: boolean; w?: number; onPress: () => void; onLongPress: () => void }) {
  return <Tile art={item.icon} label={titleWithYear(item)} initial={item.name} first={first} busy={busy} w={w} onPress={onPress} onLongPress={onLongPress} />
}

// The shared tile: a framed poster with a fixed-height LABEL BOX underneath (D8). The
// height is fixed on purpose — the A–Z rail's scrollToIndex math depends on every row
// being exactly VOD_ROW_H tall (or, in the portrait grid, exactly the gridGeometry
// row: `w` overrides the tile/poster width so three columns fill the freed width, and
// the height stays a pure function of that width — same discipline, computed once).
function Tile ({ art, label, initial, first, busy, w, onPress, onLongPress }: {
  art: string
  label: string
  initial: string
  first: boolean
  busy: boolean
  /** Portrait grid tile width (gridGeometry). Absent = the fixed TILE_W layout. */
  w?: number
  onPress: () => void
  /** Long press = the My List toggle (D9). Absent on the genre cards, which are not
   *  titles and have nothing to save. */
  onLongPress?: () => void
}) {
  const [focused, setFocused] = useState(false)
  const [broken, setBroken] = useState(false)
  const showArt = !!art && !broken
  const posterH = w === undefined ? undefined : Math.round(w * 3 / 2)
  return (
    <Pressable
      style={[styles.tile, w !== undefined && { width: w, height: posterH! + LABEL_H }]}
      accessibilityRole="button"
      // TV-only: D-pad entry into the grid should land on the first tile. On the
      // PHONE this same flag stole focus from the search field on every results
      // re-render (a new first tile mounts preferred → input blurs, keyboard closes).
      hasTVPreferredFocus={first && Platform.isTV}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <View style={[styles.posterBox, posterH !== undefined && { height: posterH }, focused && styles.posterBoxFocused]}>
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
  // Portrait stacks: menu chip row, then the (full-width) content pane under it.
  containerPortrait: { flexDirection: 'column' },
  leftPane: { width: theme.isTV ? '18%' : '22%', paddingRight: theme.spacing(1.5) },
  contentPane: { flex: 1 },
  // --- phone portrait (WS13): the left pane as a horizontal chip row ---
  menuRow: { flexGrow: 0, marginBottom: theme.spacing(1.25) },
  menuRowContent: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(0.75), paddingRight: theme.spacing(1) },
  menuChip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: theme.colors.surface,
    borderWidth: theme.focusRing, borderColor: 'transparent'
  },
  menuChipActive: { backgroundColor: theme.colors.primary },
  menuChipFocused: { borderColor: theme.colors.focus },
  menuChipText: { color: theme.colors.text, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1 },
  menuChipTextActive: { color: theme.colors.onPrimary },
  // Portrait tab bar: one non-wrapping row with room to breathe (the landscape
  // flexWrap row clipped and wrapped labels in portrait — the S22 complaint).
  tabsScroll: { flexGrow: 0, marginBottom: theme.spacing(1) },
  tabsRowPortrait: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(0.75), paddingRight: theme.spacing(1) },
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
  railHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing(1), marginBottom: theme.spacing(0.5), paddingHorizontal: GRID_PAD },
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
