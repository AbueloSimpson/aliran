// Channel-list overlay panel (the reference's LISTA DE CANALES): dark translucent
// panel of channel rows over the playing video. Selecting a row switches the stream
// IN PLACE — playback never stops while browsing. Keyboard-first (the D-pad model):
// the list owns Arrow/Enter/Escape while mounted; the mouse gets the same rows plus
// right-click for channel detail. Rows show the airing EPG program as their
// now-playing line when the channel carries a guide (one cached fetch covers every
// row sharing the feed URL), else the catalog synopsis; vod titles (S8a) swap the
// LIVE badge for their runtime and never take a channel number. The right-edge picture
// is the channel's LIVE thumbnail (the rolling frame off its own feed) when there is
// one, the station logo otherwise.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '@aliran/i18n'
import type { Stream } from '../types'
import { formatChannelNumber, formatDuration, isVod } from '../catalog'
import { useEpg } from '../../../../sdk/react-native/src/useEpg'
import { useChannelThumb } from '../../../../sdk/react-native/src/thumbs'
import { ProgressHairline } from './ProgressHairline'

// Fixed row geometry — the desktop mirror of the client's getItemLayout
// (ChannelListPanel.tsx). Every row occupies ROW_H px, so the visible window is
// pure index arithmetic and only rows in view (plus a small overscan) mount.
// This is what keeps a 90-channel list honest: an unmounted row runs no
// 30 s thumbnail interval and never cold-opens its feed, so off-screen rows
// cannot churn the SDK's 12-slot feed LRU.
const ROW_INNER_H = 54
const ROW_GAP = 2
const ROW_H = ROW_INNER_H + ROW_GAP
const OVERSCAN = 4

export interface ChannelListProps {
  streams: Stream[]
  /** Panel heading. Absent = the generic "CHANNELS" from the catalog. */
  heading?: string
  numbers: Map<string, number>
  playingId: string | null
  favorites: string[]
  onSelect: (s: Stream) => void
  /** Open channel detail (the 'i' key / right-click). */
  onInfo?: (s: Stream) => void
  /** Two-tier select (WS4): Enter/click on the row of the channel ALREADY PLAYING —
   *  previously a no-op re-tune — opens the full program guide instead. Every other
   *  row keeps tuning via onSelect. Absent = the old single-tier behavior. */
  onGuide?: (s: Stream) => void
  onClose: () => void
  /** Any interaction (defers the auto-hide timer). */
  onActivity?: () => void
  /** Keyboard ownership: false while a sibling pane (the category rail) has it —
   *  the mouse keeps working either way. Default true. */
  active?: boolean
}

export function ChannelList ({ streams, heading, numbers, playingId, favorites, onSelect, onInfo, onGuide, onClose, onActivity, active = true }: ChannelListProps) {
  const { t } = useI18n()
  const [focus, setFocus] = useState(() => {
    const i = streams.findIndex((s) => s.id === playingId)
    return i >= 0 ? i : 0
  })
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(0)

  // Measure the scroll viewport (and follow window resizes) — the window math
  // needs its height. useLayoutEffect so the first paint already shows a full
  // viewport of rows, not just the overscan.
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    setViewH(el.clientHeight)
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The two-tier pick (Enter and click share it): the already-playing row opens the
  // guide when the caller wired one, every other row tunes.
  const pick = (s: Stream) => (s.id === playingId && onGuide ? onGuide(s) : onSelect(s))

  // Keep the focused index valid when the category scopes the list down.
  useEffect(() => {
    if (focus >= streams.length) setFocus(Math.max(0, streams.length - 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams])

  // scrollIntoView('nearest') by hand — the focused row may not be mounted, so
  // scroll the viewport to its computed slot instead of asking a DOM node.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const top = focus * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
  }, [focus])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      // A text input above the list (Search) owns the keyboard while focused.
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'ArrowDown') { e.preventDefault(); onActivity?.(); setFocus((i) => Math.min(streams.length - 1, i + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); onActivity?.(); setFocus((i) => Math.max(0, i - 1)) }
      else if (e.key === 'PageDown') { e.preventDefault(); onActivity?.(); setFocus((i) => Math.min(streams.length - 1, i + 10)) }
      else if (e.key === 'PageUp') { e.preventDefault(); onActivity?.(); setFocus((i) => Math.max(0, i - 10)) }
      else if (e.key === 'Enter') { e.preventDefault(); const s = streams[focus]; if (s) pick(s) }
      else if (e.key === 'i' || e.key === 'I') { const s = streams[focus]; if (s && onInfo) { e.preventDefault(); onInfo(s) } }
      else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [streams, focus, onSelect, onInfo, onGuide, playingId, onClose, onActivity, active])

  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const lastRow = Math.min(streams.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)

  return (
    <div className="channel-list">
      <div className="panel-heading">{heading ?? t('live.channels')}</div>
      <div
        className="channel-rows"
        ref={viewportRef}
        onScroll={(e) => { setScrollTop(e.currentTarget.scrollTop); onActivity?.() }}
      >
        <div style={{ position: 'relative', height: streams.length * ROW_H }}>
          {streams.slice(firstRow, lastRow).map((s, off) => {
            const i = firstRow + off
            return (
              <ChannelRow
                key={s.id}
                top={i * ROW_H}
                stream={s}
                number={numbers.get(s.id)}
                playing={s.id === playingId}
                focused={i === focus}
                favorite={favorites.includes(s.id)}
                onHover={() => { setFocus(i); onActivity?.() }}
                onClick={() => pick(s)}
                onContextMenu={onInfo ? () => onInfo(s) : undefined}
              />
            )
          })}
        </div>
      </div>
      {/* Key hints: each one is its own template with the key token supplied here, and
          the " · " joins are punctuation the composing code owns — never copy. */}
      <div className="panel-hint">
        {t('hints.arrowsBrowse', { arrows: '↑↓' })} · {t('hints.enterWatch', { enter: 'Enter' })}
        {onInfo ? ' · ' + t('hints.infoKeyClick', { key: 'i' }) : ''} · {t('hints.escClose', { esc: 'Esc' })}
      </div>
    </div>
  )
}

interface RowProps {
  stream: Stream
  /** Absolute y-offset of this row's slot inside the windowed list. */
  top: number
  number?: number
  playing: boolean
  focused: boolean
  favorite: boolean
  onHover: () => void
  onClick: () => void
  onContextMenu?: () => void
}

function ChannelRow ({ stream, top, number, playing, focused, favorite, onHover, onClick, onContextMenu }: RowProps) {
  const { t } = useI18n()
  // Off-air channel, or a vod title the library took down (vod records carry no
  // isLive — their availability signal is status 'available'/'unavailable').
  const vod = isVod(stream)
  const dimmed = vod ? stream.status === 'unavailable' : stream.isLive === false
  const duration = vod ? formatDuration(stream.durationSec) : ''
  // Now-playing line: the airing EPG program when the channel has a guide, else the
  // catalog synopsis. Guide-less channels never fetch.
  const { data } = useEpg(stream.epgUrl, stream.epgId, stream.guideBase)
  const nowText = data?.now?.title || stream.description
  // Right-edge picture: what is on screen right now, else the station logo.
  const [thumbUri, onThumbError] = useChannelThumb(stream.thumbBase)
  const art = thumbUri || stream.logo
  return (
    <div
      className={'channel-row' + (focused ? ' focused' : '') + (playing ? ' playing' : '')}
      style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_INNER_H }}
      onMouseMove={onHover}
      onClick={onClick}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu() } : undefined}
    >
      <span className="row-number">{formatChannelNumber(number)}</span>
      <span className="row-main">
        <span className="row-title-line">
          <span className={'row-title' + (dimmed ? ' dimmed' : '')}>{stream.title || stream.id}</span>
          {stream.isLive && <span className="badge-live">{t('common.live')}</span>}
          {duration && <span className="row-duration">{duration}</span>}
          {favorite && <span className="row-star">★</span>}
        </span>
        {nowText && <span className="row-now">{nowText}</span>}
        {/* Program progress under the subline (full text width). No guide/program:
            the hairline renders transparent, never collapses — the row height is
            pinned (.channel-row), so every row must lay out identically. */}
        {!vod && <ProgressHairline program={data?.now} className="row-hairline" />}
      </span>
      {art
        ? <img className={'row-logo' + (thumbUri ? ' row-thumb' : '')} src={art} alt={thumbUri ? t('live.livePreview', { title: stream.title ?? '' }) : ''} loading="lazy" onError={thumbUri ? onThumbError : undefined} />
        : <span className="row-logo row-logo-fallback">{(stream.title || '?').slice(0, 1).toUpperCase()}</span>}
    </div>
  )
}
