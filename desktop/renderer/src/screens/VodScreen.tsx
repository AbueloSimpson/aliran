// Movies & Series — the external VOD provider's landing screen (S53, design D3).
// The desktop twin of client/src/screens/VodScreen.tsx: same states, same wording,
// same decisions; different platform.
//
// Layout mirrors the phone/TV screen: a narrow LEFT pane (search box + the
// Movies/Series switch) and a wide poster GRID on the right.
//
// Everything here comes from the PROVIDER, not the catalog: the panel delivers the
// coordinates on the login payload (backend.vod) and the MAIN process fetches them
// (main/vod-provider.js — the renderer is file://, so CORS forbids it here, and the
// credential is the viewer's own password, which never crosses the bridge). Live TV
// is untouched: a provider title never enters the channel list, the zap ring, or the
// numbering.
//
// KEYBOARD (LiveScreen conventions — one window keydown listener, INPUT owns its own
// keys): arrows move the tile focus (left/right by one, up/down by a row), Enter
// opens the focused title, Esc goes back to the menu. The search field is not
// autofocused — the grid is the thing you arrive for — and while it IS focused it
// owns typing, with ArrowDown/ArrowRight handing focus back to the grid and Esc
// leaving the screen (the SearchScreen contract). The mode buttons are mouse- and
// Tab-reachable rather than part of the arrow path, so no keystroke can strand a
// viewer in the left pane.
//
// Series has no source value yet (the panel only accepts `sources.movies` today), so
// the switch is honest rather than hidden: picking Series says "No series yet".

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { backend } from '../bridge'
import type { VodConfig, VodErrorCode, VodItem } from '../types'

type Mode = 'movies' | 'series'

// The DOM is not virtualized (a provider catalog runs to tens of thousands of
// titles), so the grid renders a bounded page and grows as the viewer scrolls or
// walks the focus down. One page comfortably fills any window.
const PAGE = 120

/** Case- and diacritic-insensitive fold for search ("Sick Girl" ≡ "sick girl",
 *  "Amélie" ≡ "amelie"). */
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

/** Honest, named failure states — the viewer is told which of the two things broke,
 *  and never shown a provider message or an HTTP code. */
export function errorText (error: VodErrorCode): { title: string; hint: string } {
  if (error === 'auth') return { title: "Couldn't sign in to the movie catalog", hint: 'Your account was not accepted by the provider. Contact your service.' }
  if (error === 'network') return { title: "Couldn't reach the movie catalog", hint: 'Check your connection and try again in a moment.' }
  return { title: 'The movie catalog answered unexpectedly', hint: 'Nothing to show right now — try again later.' }
}

export interface VodPick { url: string; title: string; durationSec: number | null }

export function VodScreen ({ onPlay, onBack }: { onPlay: (pick: VodPick) => void; onBack: () => void }) {
  // Login-scoped: the config rides the 'streams' message and never changes
  // mid-session (an operator's change lands at the viewer's next login).
  const config: VodConfig | null = backend.vod ?? null
  const [mode, setMode] = useState<Mode>('movies')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<VodItem[] | null>(null)
  const [error, setError] = useState<VodErrorCode | null>(null)
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

  const gridRef = useRef<HTMLDivElement | null>(null)
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!config || mode !== 'movies') return
    let live = true
    setItems(null); setError(null)
    backend.vodList().then((res) => {
      if (!live) return
      if (res.ok) setItems(res.items)
      else { setItems([]); setError(res.error) }
    })
    return () => { live = false }
  }, [config, mode])

  const results = useMemo(() => filterItems(items ?? [], query), [items, query])
  const page = useMemo(() => results.slice(0, shown), [results, shown])

  // A new filter is a new list: back to the top, back to one page.
  useEffect(() => { setFocus(0); setShown(PAGE) }, [query, mode])

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
  }, [page.length])

  useEffect(() => { tileRefs.current[focus]?.scrollIntoView({ block: 'nearest' }) }, [focus, page.length])

  const open = useCallback(async (item: VodItem) => {
    if (!config || resolving) return
    setResolving(item.id); setNotice(null)
    const res = await backend.vodInfo(item.id)
    setResolving(null)
    if (res.ok) onPlay({ url: res.url, title: item.name, durationSec: res.durationSec })
    else setNotice(errorText(res.error).title)
  }, [config, resolving, onPlay])

  // Walking the focus past the rendered page pulls the next one in (the same
  // boundary the scroll handler watches).
  const move = useCallback((delta: number) => {
    setFocus((i) => {
      const next = Math.max(0, Math.min(results.length - 1, i + delta))
      if (next >= shown - columns) setShown((s) => Math.min(results.length, s + PAGE))
      return next
    })
  }, [results.length, shown, columns])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The search field owns the keyboard while it has focus (ChannelList's rule).
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'Escape') { e.preventDefault(); onBack(); return }
      if (!results.length) return
      if (e.key === 'ArrowRight') { e.preventDefault(); move(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(columns) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-columns) }
      else if (e.key === 'PageDown') { e.preventDefault(); move(columns * 3) }
      else if (e.key === 'PageUp') { e.preventDefault(); move(-columns * 3) }
      else if (e.key === 'Home') { e.preventDefault(); setFocus(0) }
      else if (e.key === 'Enter') { e.preventDefault(); const it = results[focus]; if (it) void open(it) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [results, focus, columns, move, open, onBack])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) {
      setShown((s) => (s < results.length ? Math.min(results.length, s + PAGE) : s))
    }
  }

  return (
    <div className="vod">
      <div className="vod-left">
        <div className="section-header">MOVIES &amp; SERIES</div>
        <input
          ref={inputRef}
          className="search-input vod-search"
          placeholder="Search titles…"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Esc leaves the screen (SearchScreen's contract); Down/Right hands the
            // keyboard back to the grid by blurring — the window listener takes over.
            if (e.key === 'Escape') { e.preventDefault(); onBack() }
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur() }
          }}
        />
        <div className="vod-modes">
          <button className={'vod-mode' + (mode === 'movies' ? ' active' : '')} onClick={() => setMode('movies')}>MOVIES</button>
          <button className={'vod-mode' + (mode === 'series' ? ' active' : '')} onClick={() => setMode('series')}>SERIES</button>
        </div>
        {mode === 'movies' && items !== null && !error && (
          <div className="vod-count">{results.length === (items?.length ?? 0) ? `${results.length} titles` : `${results.length} of ${items?.length ?? 0}`}</div>
        )}
      </div>

      <div className="vod-right">
        {!!notice && <div className="vod-notice">{notice}</div>}
        {!config
          ? <Centered title="Not available" hint="This service has no movie provider configured." />
          : mode === 'series'
            ? <Centered title="No series yet" hint="Series are not part of this catalog yet." />
            : !config.sources?.movies
              ? <Centered title="No movies yet" hint="Movies are not part of this catalog yet." />
              : items === null
                ? <div className="section-loading"><span className="spinner" />Loading titles…</div>
                : error
                  ? <Centered {...errorText(error)} />
                  : results.length === 0
                    ? <Centered
                        title={query.trim() ? 'No matches' : 'Nothing here yet'}
                        hint={query.trim() ? `No title matches "${query.trim()}".` : 'The provider returned no titles.'}
                      />
                    : (
                      <div className="vod-grid" ref={gridRef} onScroll={onScroll}>
                        {page.map((item, i) => (
                          <PosterTile
                            key={item.id}
                            ref={(el) => { tileRefs.current[i] = el }}
                            item={item}
                            focused={i === focus}
                            busy={resolving === item.id}
                            onHover={() => setFocus(i)}
                            onClick={() => { void open(item) }}
                          />
                        ))}
                      </div>
                      )}
      </div>
    </div>
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

// Poster + title + year. A missing or broken `icon` falls back to the title's
// initial on a plain surface (the ChannelInfoPanel art pattern) — a grid of grey
// holes reads as breakage, an initial reads as "no art".
const PosterTile = React.forwardRef<HTMLButtonElement, {
  item: VodItem
  focused: boolean
  busy: boolean
  onHover: () => void
  onClick: () => void
}>(function PosterTile ({ item, focused, busy, onHover, onClick }, ref) {
  const [broken, setBroken] = useState(false)
  const showArt = !!item.icon && !broken
  return (
    <button
      ref={ref}
      className={'vod-tile' + (focused ? ' focused' : '')}
      onMouseMove={onHover}
      onClick={onClick}
      title={item.name}
    >
      <span className="vod-poster">
        {showArt
          ? <img src={item.icon} alt="" onError={() => setBroken(true)} />
          : <span className="vod-poster-initial">{(item.name || '?').slice(0, 1).toUpperCase()}</span>}
        {busy && <span className="vod-busy"><span className="spinner" /></span>}
        {!!item.anio && <span className="vod-year">{item.anio}</span>}
      </span>
      <span className="vod-tile-title">{item.name}</span>
    </button>
  )
})
