// Movies & Series — the external VOD provider's browse surface (S53; rebuilt in S54d
// to the reference mockups, design D4/D5/D8). The desktop twin of
// client/src/screens/VodScreen.tsx: same states, same wording, same decisions;
// different platform.
//
// LAYOUT. A narrow LEFT pane that is a MENU and nothing else — Movies / Series /
// Search — and a wide content pane carrying a tab bar (Recommended · My List · Genres ·
// All) over the poster grid.
//
//   Search is a MENU ITEM, not an always-visible box: it opens its own view with an
//   input and a result grid over the active kind. (The S53 inline search box is gone.)
//
//   All     the whole list, ordered by the sort chip (SortMenu, D4) with the A–Z rail
//           on the right edge whenever the alphabetical sort is in force (D5).
//   Genres  the provider's own genre names as cards (poster of that genre's first
//           title) -> the same grid, filtered, with a chip back to the cards.
//   My List the device-local watchlist (backend.vodMyList, S54a) joined against the
//           cached list; an empty list says so. RIGHT-CLICK any tile — or press the ＋
//           button that appears on hover — to add or remove it (mouse-first: on desktop
//           a long press is not a gesture anyone reaches for).
//   Recommended two one-row rails — Recently added and Newest releases — each with a
//           "SEE N MORE…" that jumps to All with that ordering.
//
// Everything here comes from the PROVIDER, not the catalog: the panel delivers the
// coordinates on the login payload (backend.vod) and the MAIN process fetches them
// (main/vod-provider.js — the renderer is file://, so CORS forbids it here, and the
// credential is the viewer's own password, which never crosses the bridge). Live TV is
// untouched: a provider title never enters the channel list, the zap ring, or the
// numbering. My List and the watch history are DEVICE-LOCAL (D9) — nothing about them
// ever reaches the panel or the provider.
//
// KEYBOARD (LiveScreen conventions — one window keydown listener, INPUT owns its own
// keys): arrows move the tile focus inside the GRID (left/right by one, up/down by a
// row), Enter opens the focused title (or the focused genre card), Esc unwinds one
// step — search view -> its tab, an open genre -> the genre cards, otherwise back to
// the menu. The left menu, the tabs, the chips and the rail are mouse- and
// Tab-reachable rather than part of the arrow path, so no keystroke can strand a
// viewer outside the grid. The sort menu and the track menu capture their own keys.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { backend } from '../bridge'
import type { VodConfig, VodErrorCode, VodHistoryEntry, VodItem, VodListEntry } from '../types'
import {
  DEFAULT_SORT, fold, letterBuckets, letterOf, sortItems, sortLabel, titleWithYear, type VodSortKey
} from '../vod-sort'
import { SortMenu } from '../components/SortMenu'
import type { VodSeriesPick } from './VodSeriesScreen'

type Kind = 'movies' | 'series'
type Tab = 'recommended' | 'mylist' | 'genres' | 'all'

const TABS: { key: Tab; label: string }[] = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'mylist', label: 'My List' },
  { key: 'genres', label: 'Genres' },
  { key: 'all', label: 'All' }
]

// The DOM is not virtualized (a provider catalog runs to tens of thousands of
// titles), so the grid renders a bounded page and grows as the viewer scrolls or
// walks the focus down. One page comfortably fills any window.
const PAGE = 120

// A Recommended shelf carries at most this many titles — it scrolls horizontally and
// "SEE N MORE…" is the path to the rest (user decision, S54 polish). Mirrors the RN
// screen's RAIL_MAX.
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

/** Honest, named failure states — the viewer is told which of the two things broke,
 *  and never shown a provider message or an HTTP code. */
export function errorText (error: VodErrorCode): { title: string; hint: string } {
  if (error === 'auth') return { title: "Couldn't sign in to the movie catalog", hint: 'Your account was not accepted by the provider. Contact your service.' }
  if (error === 'network') return { title: "Couldn't reach the movie catalog", hint: 'Check your connection and try again in a moment.' }
  return { title: 'The movie catalog answered unexpectedly', hint: 'Nothing to show right now — try again later.' }
}

/** What the grid hands the player screen. `id`/`kind` let the player remember where
 *  the viewer got to (D9); `resumeSec` brings them back there. */
export interface VodPick {
  url: string
  title: string
  durationSec: number | null
  id?: string
  kind?: 'movie' | 'episode'
  /** The parent series, for an episode — the player credits its history to it. */
  seriesId?: string
  resumeSec?: number
}

export function VodScreen ({ onPlay, onOpenSeries, onBack }: {
  onPlay: (pick: VodPick) => void
  onOpenSeries: (pick: VodSeriesPick) => void
  onBack: () => void
}) {
  // Login-scoped: the config rides the 'streams' message and never changes
  // mid-session (an operator's change lands at the viewer's next login).
  const config: VodConfig | null = backend.vod ?? null
  const [kind, setKind] = useState<Kind>('movies')
  const [tab, setTab] = useState<Tab>('all')
  const [search, setSearch] = useState(false)
  const [query, setQuery] = useState('')
  // One sort per screen, kept across kind and tab switches (D4).
  const [sort, setSort] = useState<VodSortKey>(DEFAULT_SORT)
  const [sortOpen, setSortOpen] = useState(false)
  const [genre, setGenre] = useState<number | null>(null)
  const [items, setItems] = useState<VodItem[] | null>(null)
  const [categories, setCategories] = useState<string[]>([])
  const [error, setError] = useState<VodErrorCode | null>(null)
  // Device-local (S54a/D9), seeded from the bridge's cached prefs and kept current
  // from the 'prefs' reply — which is the TRUTH: main gates and caps what it stored.
  const [myList, setMyList] = useState<VodListEntry[]>(backend.vodMyList || [])
  const [history, setHistory] = useState<VodHistoryEntry[]>(backend.vodHistory || [])
  // The tile whose stream URL is being resolved (vodInfo) — a spinner covers its
  // poster until main answers, so a slow detail call is visible on the thing the
  // viewer clicked rather than as a frozen screen.
  const [resolving, setResolving] = useState<string | null>(null)
  // A title that would not resolve is a banner over the grid, not a screen-wide
  // error: the rest of the catalog is still perfectly usable.
  const [notice, setNotice] = useState<string | null>(null)
  const [focus, setFocus] = useState(0)
  const [shown, setShown] = useState(PAGE)
  const [columns, setColumns] = useState(1)
  // Index of the first tile the grid is showing — the A–Z rail's highlight follows it.
  const [firstVisible, setFirstVisible] = useState(0)
  // A letter jump whose target is not rendered yet: the page grows first, then the
  // effect below scrolls to it (D5 desktop risk — a jump past the 120-tile page
  // otherwise scrolls nowhere).
  const [pendingJump, setPendingJump] = useState<number | null>(null)

  const gridRef = useRef<HTMLDivElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const tileRefs = useRef<(HTMLDivElement | null)[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)

  // A My-List confirmation is a FLASH, not a state: it says what just happened and
  // then gets out of the way. (A provider failure uses setNotice directly and stays.)
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
  // the first load is a cache hit in the main process, so both calls stay
  // unconditional and simple.
  useEffect(() => {
    if (!config) return
    let live = true
    setItems(null); setError(null)
    backend.vodList(kind).then((res) => {
      if (!live) return
      if (res.ok) setItems(res.items)
      else { setItems([]); setError(res.error) }
    })
    return () => { live = false }
  }, [config, kind])

  useEffect(() => {
    if (!config) return
    let live = true
    backend.vodCategories().then((res) => { if (live && res.ok) setCategories(res.categories) })
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
  // provider no longer carries simply drop out.
  const saved = useMemo(() => {
    const want = kind === 'movies' ? 'movie' : 'series'
    const ids = (myList || []).filter((e) => e && e.kind === want).map((e) => e.id)
    const byId = new Map(all.map((it) => [it.id, it]))
    return ids.map((id) => byId.get(id)).filter((it): it is VodItem => !!it)
  }, [myList, kind, all])

  const savedIds = useMemo(() => {
    const want = kind === 'movies' ? 'movie' : 'series'
    return new Set((myList || []).filter((e) => e && e.kind === want).map((e) => e.id))
  }, [myList, kind])

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

  // Which surface is on screen. The genre CARDS are their own thing (they are not
  // titles), so they get their own flag rather than a fake item list.
  const onGrid = !search && (tab === 'all' || (tab === 'genres' && genre !== null))
  const cardsMode = !search && tab === 'genres' && genre === null
  const railsMode = !search && tab === 'recommended'

  // The list the arrows walk and the page counter applies to.
  const gridItems = useMemo(() => {
    if (search) return results
    if (tab === 'mylist') return saved
    if (railsMode || cardsMode) return []
    return grid
  }, [search, results, tab, saved, railsMode, cardsMode, grid])

  // The rail belongs to whichever grid is showing the SORTED list — "All", and a genre
  // opened from the cards. It is never drawn in any other sort (D5).
  const railShown = onGrid && sort === 'az' && gridItems.length > 0
  const buckets = useMemo(() => (railShown ? letterBuckets(gridItems) : []), [railShown, gridItems])
  const activeLetter = railShown
    ? letterOf(gridItems[Math.min(firstVisible, gridItems.length - 1)]?.name || '')
    : ''

  const page = useMemo(() => gridItems.slice(0, shown), [gridItems, shown])
  const focusCount = cardsMode ? genreCards.length : gridItems.length

  // A new list is a new list: back to the top, back to one page. The tile refs belong
  // to the OLD surface and are dropped with it — a stale one would otherwise feed the
  // row math a detached node.
  useEffect(() => {
    tileRefs.current = []
    setFocus(0); setShown(PAGE); setFirstVisible(0); setPendingJump(null)
    gridRef.current?.scrollTo({ top: 0 })
  }, [query, kind, tab, genre, sort, search])

  // The column count comes from the CSS grid itself (auto-fill), so arrow-key row
  // movement always matches what the viewer sees at this window width.
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const measure = () => {
      const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length
      setColumns(Math.max(1, cols))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [page.length, cardsMode, railsMode])

  useEffect(() => { tileRefs.current[focus]?.scrollIntoView({ block: 'nearest' }) }, [focus, page.length])

  // The letter jump, part two: the page has grown, the tile now exists, scroll to it
  // and put the focus there. If it is STILL not rendered the effect leaves the
  // pending jump alone and runs again on the next page growth.
  useEffect(() => {
    if (pendingJump === null) return
    const el = tileRefs.current[pendingJump]
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    setFocus(pendingJump)
    setFirstVisible(pendingJump)
    setPendingJump(null)
  }, [pendingJump, shown, page.length])

  const jumpToLetter = useCallback((letter: string) => {
    const bucket = buckets.find((b) => b.letter === letter)
    if (!bucket) return
    // EXPAND FIRST: a letter beyond the rendered page has no element to scroll to, so
    // the page is grown to cover it and the effect above finishes the jump.
    setShown((s) => (bucket.index < s ? s : Math.min(gridItems.length, bucket.index + PAGE)))
    setPendingJump(bucket.index)
  }, [buckets, gridItems.length])

  const open = useCallback(async (item: VodItem) => {
    if (!config || resolving) return
    // A series never plays directly (D3) — it opens its own detail screen.
    if (kind === 'series') {
      onOpenSeries({ id: item.id, name: item.name, icon: item.icon || undefined, anio: item.anio || undefined })
      return
    }
    setResolving(item.id); setNotice(null)
    const res = await backend.vodInfo(item.id)
    setResolving(null)
    if (res.ok) {
      // id/kind travel with the url so the player can remember where the viewer got to
      // (D9) — and resumeSec brings them back there next time.
      const seen = (history || []).find((h) => h && h.kind === 'movie' && h.id === item.id)
      onPlay({
        url: res.url,
        title: item.name,
        durationSec: res.durationSec,
        id: item.id,
        kind: 'movie',
        ...(seen && seen.positionSec > 0 ? { resumeSec: seen.positionSec } : {})
      })
    } else setNotice(errorText(res.error).title)
  }, [config, resolving, onPlay, onOpenSeries, kind, history])

  // My List (D9). Whole-array replace, newest first; the optimistic local state keeps
  // the grid honest for the frame or two before main answers with a 'prefs', which is
  // the truth about what was actually stored.
  const toggleSaved = useCallback((item: VodItem) => {
    const entryKind: VodListEntry['kind'] = kind === 'movies' ? 'movie' : 'series'
    const current = myList || []
    const has = current.some((e) => e && e.kind === entryKind && e.id === item.id)
    const rest = current.filter((e) => !(e && e.kind === entryKind && e.id === item.id))
    const next: VodListEntry[] = has ? rest : [{ kind: entryKind, id: item.id }, ...rest]
    setMyList(next)
    flashNotice(has ? `Removed from My List: ${item.name}` : `Added to My List: ${item.name}`)
    try { backend.setVodPrefs({ list: next }) } catch { /* device-local convenience, never fatal */ }
  }, [kind, myList, flashNotice])

  const chooseKind = useCallback((k: Kind) => {
    setKind(k); setSearch(false); setGenre(null); setQuery(''); setNotice(null)
  }, [])
  const chooseTab = useCallback((t: Tab) => {
    setTab(t); setSearch(false); setGenre(null)
  }, [])
  const seeMore = useCallback((key: VodSortKey) => {
    setSort(key); setTab('all'); setSearch(false); setGenre(null)
  }, [])

  // Walking the focus past the rendered page pulls the next one in (the same
  // boundary the scroll handler watches).
  const move = useCallback((delta: number) => {
    setFocus((i) => {
      const next = Math.max(0, Math.min(focusCount - 1, i + delta))
      if (next >= shown - columns) setShown((s) => Math.min(focusCount, s + PAGE))
      return next
    })
  }, [focusCount, shown, columns])

  const openFocused = useCallback(() => {
    if (cardsMode) { const g = genreCards[focus]; if (g) setGenre(g.index); return }
    const it = gridItems[focus]
    if (it) void open(it)
  }, [cardsMode, genreCards, focus, gridItems, open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sortOpen) return // the sort menu captures its own keys
      // The search field owns the keyboard while it has focus (ChannelList's rule),
      // and a real <button> that has been Tab-focused owns its own activation — Enter
      // on the Genres tab must switch tabs, not open whatever tile the arrows last sat
      // on.
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT') return
      if (tag === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        // One step at a time: the search view, then an open genre, then the screen.
        if (search) { setSearch(false); return }
        if (genre !== null) { setGenre(null); return }
        onBack()
        return
      }
      if (!focusCount) return
      if (e.key === 'ArrowRight') { e.preventDefault(); move(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(columns) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-columns) }
      else if (e.key === 'PageDown') { e.preventDefault(); move(columns * 3) }
      else if (e.key === 'PageUp') { e.preventDefault(); move(-columns * 3) }
      else if (e.key === 'Home') { e.preventDefault(); setFocus(0) }
      else if (e.key === 'Enter') { e.preventDefault(); openFocused() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusCount, columns, move, openFocused, onBack, search, genre, sortOpen])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) {
      setShown((s) => (s < gridItems.length ? Math.min(gridItems.length, s + PAGE) : s))
    }
    // Which row is at the top — that tile's letter is the one the rail highlights.
    const first = tileRefs.current[0]
    if (!first || gridItems.length === 0) return
    const nextRow = tileRefs.current[columns]
    const rowH = nextRow ? Math.max(1, nextRow.offsetTop - first.offsetTop) : Math.max(1, first.offsetHeight)
    const row = Math.max(0, Math.floor(el.scrollTop / rowH))
    setFirstVisible(Math.min(gridItems.length - 1, row * columns))
  }

  const noSource = kind === 'movies' ? !config?.sources?.movies : !config?.sources?.series
  const genreName = genre === null ? '' : (categories[genre] || '')

  function renderGrid (empty: { title: string; hint: string }) {
    if (gridItems.length === 0) return <Centered {...empty} />
    return (
      <div className="vod-gridrow">
        <div className="vod-grid" ref={gridRef} onScroll={onScroll}>
          {page.map((item, i) => (
            <PosterTile
              key={item.id}
              ref={(el) => { tileRefs.current[i] = el }}
              label={titleWithYear(item)}
              art={item.icon}
              initial={item.name}
              title={item.name}
              focused={i === focus}
              busy={resolving === item.id}
              saved={savedIds.has(item.id)}
              onHover={() => setFocus(i)}
              onClick={() => { void open(item) }}
              onToggleSave={() => toggleSaved(item)}
            />
          ))}
        </div>
        {railShown && (
          <div className="vod-rail">
            {buckets.map((b) => (
              <button
                key={b.letter}
                className={'vod-rail-letter' + (b.letter === activeLetter ? ' active' : '')}
                onClick={() => jumpToLetter(b.letter)}
              >{b.letter}</button>
            ))}
          </div>
        )}
      </div>
    )
  }

  function renderBody () {
    if (!config) return <Centered title="Not available" hint="This service has no movie provider configured." />
    if (noSource) {
      return kind === 'movies'
        ? <Centered title="No movies yet" hint="Movies are not part of this catalog yet." />
        : <Centered title="No series yet" hint="Series are not part of this catalog yet." />
    }
    if (items === null) return <div className="section-loading"><span className="spinner" />Loading titles…</div>
    if (error) return <Centered {...errorText(error)} />

    if (search) {
      return (
        <>
          <input
            ref={inputRef}
            className="search-input vod-search"
            placeholder="Search titles…"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Esc leaves the search view; Down/Right/Enter hands the keyboard back to
              // the grid by blurring — the window listener takes over.
              if (e.key === 'Escape') { e.preventDefault(); setSearch(false) }
              if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur() }
            }}
          />
          {renderGrid(query.trim()
            ? { title: 'No matches', hint: `No title matches "${query.trim()}".` }
            : { title: 'Nothing here yet', hint: 'The provider returned no titles.' })}
        </>
      )
    }

    if (railsMode) {
      if (all.length === 0) return <Centered title="Nothing here yet" hint="The provider returned no titles." />
      return (
        <div className="vod-rails">
          {rails.map((r) => (
            <Shelf
              key={r.key}
              title={r.title}
              items={r.items.slice(0, RAIL_MAX)}
              more={Math.max(0, r.items.length - RAIL_MAX)}
              busyId={resolving}
              savedIds={savedIds}
              onPressItem={(it) => { void open(it) }}
              onToggleSave={toggleSaved}
              onSeeMore={() => seeMore(r.key)}
            />
          ))}
        </div>
      )
    }

    if (tab === 'mylist') {
      return renderGrid({ title: 'Your list is empty', hint: 'Titles you add to My List appear here.' })
    }

    if (cardsMode) {
      if (genreCards.length === 0) return <Centered title="No genres" hint="The provider named no genres for these titles." />
      return (
        <div className="vod-grid vod-genres" ref={gridRef}>
          {genreCards.map((g, i) => (
            <PosterTile
              key={g.index}
              ref={(el) => { tileRefs.current[i] = el }}
              label={g.name}
              art={g.item.icon}
              initial={g.name}
              title={g.name}
              focused={i === focus}
              busy={false}
              saved={false}
              onHover={() => setFocus(i)}
              onClick={() => setGenre(g.index)}
            />
          ))}
        </div>
      )
    }

    // 'all', and a genre that has been opened from the cards.
    return renderGrid({
      title: genre === null ? 'Nothing here yet' : 'Nothing in this genre',
      hint: genre === null ? 'The provider returned no titles.' : 'No title here carries that genre.'
    })
  }

  return (
    <>
      <div className="vod">
        <div className="vod-left">
          <div className="section-header">MOVIES &amp; SERIES</div>
          <div className="vod-modes">
            <button className={'vod-mode' + (!search && kind === 'movies' ? ' active' : '')} onClick={() => chooseKind('movies')}>MOVIES</button>
            <button className={'vod-mode' + (!search && kind === 'series' ? ' active' : '')} onClick={() => chooseKind('series')}>SERIES</button>
            <button className={'vod-mode' + (search ? ' active' : '')} onClick={() => { setSearch(true); setGenre(null) }}>SEARCH</button>
          </div>
          {items !== null && !error && !noSource && (
            <div className="vod-count">
              {search
                ? `${results.length} of ${all.length}`
                : `${all.length} title${all.length === 1 ? '' : 's'}`}
            </div>
          )}
        </div>

        <div className="vod-right" ref={paneRef}>
          <div className="vod-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={'vod-tab' + (!search && tab === t.key ? ' active' : '')}
                onClick={() => chooseTab(t.key)}
              >{t.label.toUpperCase()}</button>
            ))}
          </div>

          {onGrid && (
            <div className="vod-chips">
              {genre !== null && (
                <button className="vod-chip" onClick={() => setGenre(null)}>{`Genre: ${genreName || 'Unnamed'}`}</button>
              )}
              <span className="vod-chip-spacer" />
              <button className="vod-chip vod-sort" onClick={() => setSortOpen(true)}>{`Sort by: ${sortLabel(sort)}`}</button>
            </div>
          )}

          {!!notice && <div className="vod-notice">{notice}</div>}
          {renderBody()}
        </div>
      </div>

      {sortOpen && (
        <SortMenu
          value={sort}
          onSelect={(k) => { setSort(k); setFirstVisible(0) }}
          onClose={() => setSortOpen(false)}
        />
      )}
    </>
  )
}

function Centered ({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="empty-center">
      <div className="empty-title">{title}</div>
      <div className="empty-hint">{hint}</div>
    </div>
  )
}

/** One horizontal "shelf" on Recommended: a heading, a single row of tiles, and the
 *  "SEE N MORE…" that opens the full grid in that same ordering. */
function Shelf ({ title, items, more, busyId, savedIds, onPressItem, onToggleSave, onSeeMore }: {
  title: string
  items: VodItem[]
  more: number
  busyId: string | null
  savedIds: Set<string>
  onPressItem: (it: VodItem) => void
  onToggleSave: (it: VodItem) => void
  onSeeMore: () => void
}) {
  if (items.length === 0) return null
  return (
    <div className="vod-rails-item">
      <div className="vod-rails-head">
        <span className="vod-rails-title">{title}</span>
        {more > 0 && <button className="vod-chip" onClick={onSeeMore}>{`SEE ${more} MORE…`}</button>}
      </div>
      <div className="vod-rails-row">
        {items.map((it) => (
          <PosterTile
            key={it.id}
            label={titleWithYear(it)}
            art={it.icon}
            initial={it.name}
            title={it.name}
            focused={false}
            busy={busyId === it.id}
            saved={savedIds.has(it.id)}
            onClick={() => onPressItem(it)}
            onToggleSave={() => onToggleSave(it)}
          />
        ))}
      </div>
    </div>
  )
}

// A framed poster with a fixed-height LABEL BOX underneath (D8) — the S53 year badge
// over the art is gone; the year now rides the label, inline after the name. A missing
// or broken `art` falls back to the label's initial on a plain surface (the
// ChannelInfoPanel pattern) — a grid of grey holes reads as breakage, an initial reads
// as "no art".
//
// It is a role="button" DIV rather than a <button>: the My-List control lives INSIDE
// the tile, and a button inside a button is not valid HTML. tabIndex keeps it in the
// Tab order exactly as the old <button> was.
const PosterTile = React.forwardRef<HTMLDivElement, {
  label: string
  art: string
  initial: string
  title: string
  focused: boolean
  busy: boolean
  saved: boolean
  onHover?: () => void
  onClick: () => void
  /** Absent on the genre cards, which are not titles and have nothing to save. */
  onToggleSave?: () => void
}>(function PosterTile ({ label, art, initial, title, focused, busy, saved, onHover, onClick, onToggleSave }, ref) {
  const [broken, setBroken] = useState(false)
  const showArt = !!art && !broken
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      className={'vod-tile' + (focused ? ' focused' : '')}
      onMouseMove={onHover}
      // Tab-focusing a tile MOVES the arrow cursor onto it, so the two navigation
      // models can never disagree about which title Enter would open. (Enter itself is
      // the screen's one window listener — the tile does not handle keys.)
      onFocus={onHover}
      onClick={onClick}
      onContextMenu={onToggleSave ? (e) => { e.preventDefault(); onToggleSave() } : undefined}
      title={title}
    >
      <span className="vod-poster">
        {showArt
          ? <img src={art} alt="" onError={() => setBroken(true)} />
          : <span className="vod-poster-initial">{(initial || '?').slice(0, 1).toUpperCase()}</span>}
        {busy && <span className="vod-busy"><span className="spinner" /></span>}
        {!!onToggleSave && (
          <button
            className={'vod-save' + (saved ? ' active' : '')}
            title={saved ? 'Remove from My List' : 'Add to My List'}
            aria-label={saved ? 'Remove from My List' : 'Add to My List'}
            onClick={(e) => { e.stopPropagation(); onToggleSave() }}
          >{saved ? '✓' : '＋'}</button>
        )}
      </span>
      {/* Two class names on purpose: `.vod-tile-title` is what the label has always
          been, `.vod-tile-year` is what it became in S54d — the year rides the label
          inline now that the poster badge is gone. */}
      <span className="vod-tile-title vod-tile-year">{label}</span>
    </div>
  )
})
