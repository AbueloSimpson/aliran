// Guide — the full EPG surface (WS4), the desktop twin of the client's TV grid
// (client/src/screens/GuideScreen.tsx — desktop follows the TV presentation, not
// the phone list): a classic timeline grid — channel column (number + live thumb)
// beside a 2 h window of absolutely-positioned program cells, paged in 30-min slots
// between now − 6 h and now + 48 h (the SDK's data window). Same data layer as the
// Info panel (useEpgPrograms — P2P guide drive first, https provider feed fallback).
//
// Input, adapted to pointer + keyboard (no TV focus rig here — the pure moveFocus
// reducer in ../guide.ts drives the Arrow keys directly):
//   Arrows     moveFocus — left/right walk program starts and page the window in
//              slot steps at the edges; up/down keep the time position; row 0 + up
//              releases the keyboard into the header zone (chips + NOW pill), where
//              ←/→ walk chips, Enter picks, ↓/Esc drop back onto the grid.
//   Enter      tune the focused row's channel (the same jump Favorites/Search make).
//   Esc        back to where the viewer came from (Menu tile or Live's list).
//   Mouse      hover focuses a cell, click tunes; the wheel over the program strips
//              pages the window sideways (deltaY → left/right slots), over the
//              channel column it scrolls the list vertically as usual.
//
// Rows are windowed (a scroll-driven slice over the fixed GUIDE_ROW_H — the plain-DOM
// stand-in for the client's FlatList windowSize): only mounted rows run useEpgPrograms
// and useChannelThumb, so a 300-channel lineup costs only the visible window (the
// thumbs.ts contract). The reducer reads whatever the mounted rows reported; an
// unmounted/unloaded row reads as guide-less, which is exactly its on-screen state.
// Guide-less channels show one honest full-width "No program information" cell (D2 —
// no fake data), and vod titles have no schedule, so they stay out entirely.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { backend } from '../bridge'
import type { Stream } from '../types'
import { visibleStreams } from '../parental'
import { channelNumbers, categoryModel, splitCategory, subLabel, formatChannelNumber, isVod, SUBCAT_SEP, type CategoryModel } from '../catalog'
import { useEpgPrograms } from '../../../../sdk/react-native/src/useEpg'
import { useChannelThumb } from '../../../../sdk/react-native/src/thumbs'
import type { EpgProgram } from '../../../../sdk/react-native/src/epg'
import { ProgressHairline } from '../components/ProgressHairline'
import {
  GUIDE_ROW_H, GUIDE_WINDOW_MS, GUIDE_WINDOW_MIN, GUIDE_SLOTS,
  SLOT_MIN, SLOT_MS, MIN_CELL_W, cellRect, visiblePrograms, moveFocus, snapToNow, windowFloor, windowCeil,
  type GuideFocus, type GuideDir
} from '../guide'

// Channel column: number (52, the client's ChannelRow width) + 96×54 live thumb +
// padding — the client's TV numbers verbatim (the guide keeps its own thumb size;
// the 112×63 .row-logo is the channel LIST's).
const CH_COL_W = 176
// Adjacent program cells keep a hairline gap so the timeline reads as cells, not a bar.
const CELL_GAP = 2
// Rows rendered beyond the visible slice on each side (scroll headroom).
const OVERSCAN = 4
// The .guide-screen horizontal padding (styles.css) — the strip width derives from it.
const SCREEN_PAD_X = 32

// Local wall-clock HH:MM (the ChannelInfoPanel helper).
function hhmm (ms: number): string {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// Time-bar date hint once paging crosses local midnight: nothing while the window
// starts today; TOMORROW / YESTERDAY on the neighbor days, a short date past those.
function dayHint (windowStart: number, now: number): string | null {
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const w = new Date(windowStart)
  if (same(w, new Date(now))) return null
  if (same(w, new Date(now + 86400000))) return 'TOMORROW'
  if (same(w, new Date(now - 86400000))) return 'YESTERDAY'
  return `${w.getDate()}/${w.getMonth() + 1}`
}

export interface GuideScreenProps {
  /** The channel Live was playing when it opened the guide — the row the grid mounts
   *  at and the NOW pill's jump target. Absent when entered from the Menu tile. */
  playingId?: string | null
  /** Tune a channel: App routes this to Live the same way MenuScreen's onGo('live')
   *  flow lands there, carrying the streamId. */
  onTune: (streamId: string) => void
  /** Esc — back to where the viewer came from (App decides: Menu or Live). */
  onBack: () => void
}

export function GuideScreen ({ playingId = null, onTune, onBack }: GuideScreenProps) {
  const [streams, setStreams] = useState<Stream[]>(() => visibleStreams(backend.streams))
  // Category scope — the CategoryModel rendered as chips (the client's grammar; a
  // rail would eat width this timeline needs). The drill state is DERIVED from the
  // selection: picking a parent with subs shows its sub-chips row; re-picking the
  // selected sub returns to the parent.
  const [selected, setSelected] = useState('All')
  // Slow clock: past-dimming, the airing cell and every hairline ride this tick.
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(visibleStreams(m.streams))
    })
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  const model = useMemo(() => categoryModel(streams), [streams])
  const numbers = useMemo(() => channelNumbers(streams), [streams])
  const activeKey = model.groups[selected] ? selected : 'All'
  // The guide is a CHANNEL surface: vod titles have no schedule (ChannelInfoPanel
  // omits their guide slot for the same reason) and stay out of the rows.
  const list = useMemo(() => (model.groups[activeKey] ?? []).filter((s) => !isVod(s)), [model, activeKey])

  const pickCategory = useCallback((key: string) => {
    // Re-picking the selected sub-category deselects it (back to the whole parent).
    setSelected((prev) => (prev === key && key.includes(SUBCAT_SEP) ? splitCategory(key)[0] : key))
  }, [])

  const tune = useCallback((s: Stream) => onTune(s.id), [onTune])

  if (!streams.length) {
    return <div className="section-loading"><span className="spinner" /><div>Waiting for the channel list…</div></div>
  }

  return (
    <GuideGrid
      model={model}
      activeKey={activeKey}
      onSelectCategory={pickCategory}
      list={list}
      numbers={numbers}
      playingId={playingId}
      nowMs={nowMs}
      onTune={tune}
      onBack={onBack}
    />
  )
}

export interface GuideGridProps {
  model: CategoryModel
  activeKey: string
  onSelectCategory: (key: string) => void
  list: Stream[]
  numbers: Map<string, number>
  playingId: string | null
  nowMs: number
  onTune: (s: Stream) => void
  onBack: () => void
}

// Keyboard focus in the header zone: which chips row (0 = NOW pill + top chips,
// 1 = the sub-chips row) and the index within it. null = the grid has the keys.
interface HeaderFocus { row: 0 | 1; index: number }

// Exported for the twin lane (tools/desktop-guide-test.mjs) — a static render with
// injected props, the client's GuideScreen.test.tsx counterpart.
export function GuideGrid ({ model, activeKey, onSelectCategory, list, numbers, playingId, nowMs, onTune, onBack }: GuideGridProps) {
  // Strip geometry from the measured body width (ResizeObserver — desktop windows
  // resize; the pre-measure fallback only covers the very first frame).
  const [bodyW, setBodyW] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth) - SCREEN_PAD_X * 2)
  const stripW = Math.max(GUIDE_SLOTS * MIN_CELL_W, bodyW - CH_COL_W)
  const pxPerMin = stripW / GUIDE_WINDOW_MIN

  // Virtual grid focus (styled from state — the same reducer state the client's TV
  // rig drives) and the header zone (chips + NOW pill) keyboard focus.
  const [focus, setFocus] = useState<GuideFocus>(() => {
    const ws = snapToNow(Date.now())
    return { focusRow: Math.max(0, list.findIndex((s) => s.id === playingId)), focusCellStart: ws, windowStart: ws }
  })
  const [headerFocus, setHeaderFocus] = useState<HeaderFocus | null>(null)
  const focusRef = useRef(focus); focusRef.current = focus
  const headerFocusRef = useRef(headerFocus); headerFocusRef.current = headerFocus
  const listRef = useRef(list); listRef.current = list

  // Programs per stream id, reported up by the MOUNTED rows (each row owns its
  // useEpgPrograms hook) — the reducer reads whatever is known; a row not yet
  // loaded/mounted reads as guide-less, which is exactly its on-screen state.
  const programsRef = useRef(new Map<string, EpgProgram[]>())
  const reportPrograms = useCallback((id: string, programs: EpgProgram[]) => {
    programsRef.current.set(id, programs)
  }, [])

  // Scroll-driven row window (the FlatList stand-in): fixed GUIDE_ROW_H rows, so the
  // visible slice is arithmetic over scrollTop.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(() => (typeof window === 'undefined' ? 720 : window.innerHeight))

  useEffect(() => {
    const el = bodyRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setBodyW(el.clientWidth)
      setViewH(el.clientHeight)
    })
    ro.observe(el)
    setBodyW(el.clientWidth)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const firstRow = Math.max(0, Math.floor(scrollTop / GUIDE_ROW_H) - OVERSCAN)
  const lastRow = Math.min(list.length, Math.ceil((scrollTop + viewH) / GUIDE_ROW_H) + OVERSCAN)

  // The reducer over whatever the mounted rows know.
  const rowsNow = useCallback(() => listRef.current.map((s) => programsRef.current.get(s.id) ?? []), [])

  // Focus-follow scrolling is for KEYBOARD moves only — hover also sets focusRow on
  // desktop, and auto-scrolling under the pointer would yank the list around.
  const followFocus = useRef(false)

  function dispatchMove (dir: GuideDir) {
    const r = moveFocus(focusRef.current, dir, { rows: rowsNow(), now: Date.now() })
    if ('exit' in r) { setHeaderFocus({ row: 0, index: 0 }); return }
    followFocus.current = true
    setFocus(r)
  }

  // Wheel over the program strips: deltaY pages the window sideways in slot steps
  // (there is no horizontal scrolling — the client contract); over the channel
  // column the native vertical scroll stands. Non-passive: paging must preventDefault
  // the vertical scroll it replaces.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const left = el.getBoundingClientRect().left
      if (e.clientX - left < CH_COL_W) return // channel column: scroll the list
      if (!e.deltaY) return
      e.preventDefault()
      const step = e.deltaY > 0 ? SLOT_MS : -SLOT_MS
      const now = Date.now()
      setFocus((f) => {
        const ws = Math.min(Math.max(f.windowStart + step, windowFloor(now)), windowCeil(now))
        return ws === f.windowStart ? f : { ...f, windowStart: ws }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Follow the keyboard focus: keep the focused row around the middle third (the
  // client's viewPosition 0.35 — exact rows, so the jump is one frame). Hover moves
  // focus too, but never scrolls (followFocus stays false).
  useEffect(() => {
    if (!followFocus.current) return
    followFocus.current = false
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = Math.max(0, focus.focusRow * GUIDE_ROW_H - el.clientHeight * 0.35)
  }, [focus.focusRow])

  // Category switch: re-anchor the focus on the playing channel (or the top).
  const firstScope = useRef(true)
  useEffect(() => {
    if (firstScope.current) { firstScope.current = false; return }
    followFocus.current = true // a deliberate re-anchor, not a hover
    setFocus((f) => ({ ...f, focusRow: Math.max(0, list.findIndex((s) => s.id === playingId)) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey])

  // The NOW pill: window back to the current half-hour, focus back on the playing
  // channel, keys back down on the grid.
  const jumpToNow = useCallback(() => {
    const ws = snapToNow(Date.now())
    followFocus.current = true // the jump SHOULD bring its row into view
    setFocus({ focusRow: Math.max(0, listRef.current.findIndex((s) => s.id === playingId)), focusCellStart: ws, windowStart: ws })
    setHeaderFocus(null)
  }, [playingId])

  // Header chip rows for the keyboard walk: row 0 = NOW pill + top-level chips,
  // row 1 = the active parent's sub-chips (present only while it has any).
  const parent = splitCategory(activeKey)[0]
  const subs = model.subs[parent] ?? []
  const headerRow0 = useMemo(() => ['now', ...model.top], [model])
  const headerRow0Ref = useRef(headerRow0); headerRow0Ref.current = headerRow0
  const subsRef = useRef(subs); subsRef.current = subs
  // A mouse click on a different parent can empty the sub-chips row while the
  // keyboard sits on it — reset to the top row rather than point at nothing.
  useEffect(() => {
    if (subs.length === 0) setHeaderFocus((hf) => (hf?.row === 1 ? { row: 0, index: 0 } : hf))
  }, [subs.length])

  // The keyboard — the client's D-pad model on desktop keys. Refs keep the handler
  // registered once (the LiveScreen discipline).
  const onSelectCategoryRef = useRef(onSelectCategory); onSelectCategoryRef.current = onSelectCategory
  const onTuneRef = useRef(onTune); onTuneRef.current = onTune
  const onBackRef = useRef(onBack); onBackRef.current = onBack
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hf = headerFocusRef.current
      if (hf) {
        const row = hf.row === 0 ? headerRow0Ref.current : subsRef.current
        if (e.key === 'ArrowRight') { e.preventDefault(); setHeaderFocus({ ...hf, index: Math.min(row.length - 1, hf.index + 1) }) }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); setHeaderFocus({ ...hf, index: Math.max(0, hf.index - 1) }) }
        else if (e.key === 'ArrowDown') {
          e.preventDefault()
          // Top row drops onto the sub-chips row while one shows, else onto the grid.
          if (hf.row === 0 && subsRef.current.length > 0) setHeaderFocus({ row: 1, index: 0 })
          else setHeaderFocus(null)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (hf.row === 1) setHeaderFocus({ row: 0, index: 0 })
        } else if (e.key === 'Enter') {
          e.preventDefault()
          const key = row[hf.index]
          if (key === 'now') jumpToNow()
          else if (key) onSelectCategoryRef.current(key)
        } else if (e.key === 'Escape') {
          // BACK from the header returns to the grid (the client's rule).
          e.preventDefault()
          setHeaderFocus(null)
        }
        return
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); dispatchMove('up') }
      else if (e.key === 'ArrowDown') { e.preventDefault(); dispatchMove('down') }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); dispatchMove('left') }
      else if (e.key === 'ArrowRight') { e.preventDefault(); dispatchMove('right') }
      else if (e.key === 'Enter') { e.preventDefault(); const s = listRef.current[focusRef.current.focusRow]; if (s) onTuneRef.current(s) }
      else if (e.key === 'Escape') { e.preventDefault(); onBackRef.current() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mount the list around the playing channel (the client's initialScrollIndex).
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const i = listRef.current.findIndex((s) => s.id === playingId)
    if (i > 0) el.scrollTop = Math.max(0, i * GUIDE_ROW_H - el.clientHeight * 0.35)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hint = dayHint(focus.windowStart, nowMs)
  // The floating jump control (the client list's nowFloat grammar): shows once the
  // window paged away from the current half-hour; one click resets to NOW.
  const paged = focus.windowStart !== snapToNow(nowMs)

  const rows: React.ReactNode[] = []
  for (let i = firstRow; i < lastRow; i++) {
    const s = list[i]
    rows.push(
      <GuideRow
        key={s.id}
        stream={s}
        number={numbers.get(s.id)}
        playing={s.id === playingId}
        windowStart={focus.windowStart}
        stripW={stripW}
        pxPerMin={pxPerMin}
        nowMs={nowMs}
        focusedCellStart={i === focus.focusRow && !headerFocus ? focus.focusCellStart : null}
        onPrograms={reportPrograms}
        onHoverCell={(cellStart) => {
          // A hover must never scroll — and it must also DISARM a follow left over
          // from a key move that didn't change focusRow (left/right), or the next
          // hovered row change would yank the list under the pointer.
          followFocus.current = false
          setFocus((f) => {
            const cs = cellStart ?? f.windowStart
            return f.focusRow === i && f.focusCellStart === cs ? f : { ...f, focusRow: i, focusCellStart: cs }
          })
        }}
        onTune={() => onTune(s)}
      />
    )
  }

  return (
    <div className="guide-screen">
      <div className="guide-header-row">
        <div className="guide-heading">GUIDE</div>
        <div className="guide-chips-pane">
          <div className="guide-chips-row">
            <div
              className={'guide-chip guide-now-pill' + (headerFocus?.row === 0 && headerFocus.index === 0 ? ' focused' : '')}
              onClick={jumpToNow}
            >NOW</div>
            {model.top.map((key, i) => (
              <GuideChip
                key={key}
                label={key}
                active={key === parent}
                focused={headerFocus?.row === 0 && headerFocus.index === i + 1}
                onPick={() => onSelectCategory(key)}
              />
            ))}
          </div>
          {subs.length > 0 && (
            <div className="guide-chips-row">
              {subs.map((key, i) => (
                <GuideChip
                  key={key}
                  label={subLabel(key)}
                  active={key === activeKey}
                  focused={headerFocus?.row === 1 && headerFocus.index === i}
                  onPick={() => onSelectCategory(key)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="guide-timebar">
        <div className="guide-timebar-lead">{hint ? <span className="guide-day-hint">{hint}</span> : null}</div>
        {Array.from({ length: GUIDE_SLOTS }, (_, i) => focus.windowStart + i * SLOT_MS).map((t) => (
          <span key={t} className="guide-slot-label" style={{ width: pxPerMin * SLOT_MIN }}>{hhmm(t)}</span>
        ))}
      </div>

      <div className="guide-body" ref={bodyRef} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
        {/* Spacers stand in for the unmounted rows — total height stays exact, so the
            scrollbar and the slice arithmetic agree. */}
        <div style={{ height: firstRow * GUIDE_ROW_H }} />
        {rows}
        <div style={{ height: Math.max(0, (list.length - lastRow) * GUIDE_ROW_H) }} />
      </div>

      {paged && (
        <div className="guide-now-float" onClick={jumpToNow}>NOW</div>
      )}

      <div className="panel-hint">↑↓←→ browse · Enter watch · scroll wheel over the timeline pages · Esc back</div>
    </div>
  )
}

function GuideChip ({ label, active, focused, onPick }: { label: string; active: boolean; focused: boolean; onPick: () => void }) {
  return (
    <div className={'guide-chip' + (active ? ' active' : '') + (focused ? ' focused' : '')} onClick={onPick}>
      {label.toUpperCase()}
    </div>
  )
}

// One grid row: channel cell + the window's program cells, absolutely positioned
// from cellRect. Only MOUNTED rows fetch (useEpgPrograms/useChannelThumb live here —
// the row window above keeps the mounted set tight).
function GuideRow ({ stream, number, playing, windowStart, stripW, pxPerMin, nowMs, focusedCellStart, onPrograms, onHoverCell, onTune }: {
  stream: Stream
  number?: number
  playing: boolean
  windowStart: number
  stripW: number
  pxPerMin: number
  nowMs: number
  /** The virtual focus when THIS row holds it (the focused program's start), else null. */
  focusedCellStart: number | null
  onPrograms: (id: string, programs: EpgProgram[]) => void
  /** Hover moved the focus here (cellStart = the hovered program's start; null = the
   *  placeholder / channel cell). */
  onHoverCell: (cellStart: number | null) => void
  onTune: () => void
}) {
  const programs = useEpgPrograms(stream.epgUrl, stream.epgId, stream.guideBase)
  useEffect(() => { onPrograms(stream.id, programs) }, [stream.id, programs, onPrograms])
  const [thumbUri, onThumbError] = useChannelThumb(stream.thumbBase)
  const art = thumbUri || stream.logo

  const visible = visiblePrograms(programs, windowStart, windowStart + GUIDE_WINDOW_MS)
  // The focus highlight: the exact cell the reducer named; if the focus position
  // fell in a schedule gap, light the first visible cell so the row's focus is
  // never invisible.
  const focusStart = focusedCellStart == null
    ? null
    : visible.some((p) => p.start === focusedCellStart) ? focusedCellStart : visible[0]?.start ?? null

  return (
    <div className={'guide-row' + (playing ? ' playing' : '')}>
      <div className="guide-ch-cell" onMouseMove={() => onHoverCell(null)} onClick={onTune}>
        <span className="guide-ch-number">{formatChannelNumber(number)}</span>
        {art
          ? <img className={'guide-ch-thumb' + (thumbUri ? ' thumb' : '')} src={art} alt={thumbUri ? `${stream.title} — live preview` : ''} loading="lazy" onError={thumbUri ? onThumbError : undefined} />
          : <span className="guide-ch-thumb guide-ch-thumb-fallback">{(stream.title || '?').slice(0, 1).toUpperCase()}</span>}
      </div>
      <div className="guide-strip" style={{ width: stripW }}>
        {visible.length === 0
          ? (
            <div
              className={'guide-cell guide-cell-at-start' + (focusedCellStart != null ? ' focused' : '')}
              style={{ width: stripW }}
              onMouseMove={() => onHoverCell(null)}
              onClick={onTune}
            >
              <span className="guide-cell-title guide-cell-empty">No program information</span>
            </div>
            )
          : visible.map((p) => {
            const r = cellRect(p, windowStart, pxPerMin, stripW)
            if (r.w <= 0) return null // fully squeezed out at the row edge — nothing to draw
            const airing = p.start <= nowMs && nowMs < p.stop
            const past = p.stop <= nowMs
            const focused = focusStart === p.start
            return (
              <div
                key={`${p.start}-${p.stop}`}
                className={'guide-cell' + (airing ? ' now' : '') + (past ? ' past' : '') + (focused ? ' focused' : '')}
                style={{ left: r.x, width: Math.max(0, r.w - CELL_GAP) }}
                onMouseMove={() => onHoverCell(p.start)}
                onClick={onTune}
              >
                <span className="guide-cell-title">{p.title}</span>
                <span className="guide-cell-time">{hhmm(p.start)}–{hhmm(p.stop)}</span>
                {/* Program progress on the airing cell only; the transparent track
                    keeps the cell's inner layout identical either way. */}
                <ProgressHairline program={airing ? p : null} className="guide-cell-hairline" />
              </div>
            )
          })}
      </div>
    </div>
  )
}
