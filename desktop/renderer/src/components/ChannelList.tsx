// Channel-list overlay panel (the reference's LISTA DE CANALES): dark translucent
// panel of channel rows over the playing video. Selecting a row switches the stream
// IN PLACE — playback never stops while browsing. Keyboard-first (the D-pad model):
// the list owns Arrow/Enter/Escape while mounted; the mouse gets the same rows.

import React, { useEffect, useRef, useState } from 'react'
import type { Stream } from '../types'
import { formatChannelNumber } from '../catalog'

export interface ChannelListProps {
  streams: Stream[]
  heading?: string
  numbers: Map<string, number>
  playingId: string | null
  favorites: string[]
  onSelect: (s: Stream) => void
  /** Open channel detail (the 'i' key / right-click; Stage B surface). */
  onInfo?: (s: Stream) => void
  onClose: () => void
  /** Any interaction (defers the auto-hide timer). */
  onActivity?: () => void
}

export function ChannelList ({ streams, heading = 'CHANNELS', numbers, playingId, favorites, onSelect, onInfo, onClose, onActivity }: ChannelListProps) {
  const [focus, setFocus] = useState(() => {
    const i = streams.findIndex((s) => s.id === playingId)
    return i >= 0 ? i : 0
  })
  const rowRefs = useRef<Array<HTMLDivElement | null>>([])

  // Keep the focused index valid when the category scopes the list down.
  useEffect(() => {
    if (focus >= streams.length) setFocus(Math.max(0, streams.length - 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams])

  useEffect(() => {
    rowRefs.current[focus]?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); onActivity?.(); setFocus((i) => Math.min(streams.length - 1, i + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); onActivity?.(); setFocus((i) => Math.max(0, i - 1)) }
      else if (e.key === 'PageDown') { e.preventDefault(); onActivity?.(); setFocus((i) => Math.min(streams.length - 1, i + 10)) }
      else if (e.key === 'PageUp') { e.preventDefault(); onActivity?.(); setFocus((i) => Math.max(0, i - 10)) }
      else if (e.key === 'Enter') { e.preventDefault(); const s = streams[focus]; if (s) onSelect(s) }
      else if (e.key === 'i' || e.key === 'I') { const s = streams[focus]; if (s && onInfo) { e.preventDefault(); onInfo(s) } }
      else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [streams, focus, onSelect, onInfo, onClose, onActivity])

  return (
    <div className="channel-list" onScroll={onActivity}>
      <div className="panel-heading">{heading}</div>
      <div className="channel-rows">
        {streams.map((s, i) => (
          <ChannelRow
            key={s.id}
            ref={(el) => { rowRefs.current[i] = el }}
            stream={s}
            number={numbers.get(s.id)}
            playing={s.id === playingId}
            focused={i === focus}
            favorite={favorites.includes(s.id)}
            onHover={() => { setFocus(i); onActivity?.() }}
            onClick={() => onSelect(s)}
            onContextMenu={onInfo ? () => onInfo(s) : undefined}
          />
        ))}
      </div>
      <div className="panel-hint">↑↓ browse · Enter watch{onInfo ? ' · i info' : ''} · Esc close</div>
    </div>
  )
}

interface RowProps {
  stream: Stream
  number?: number
  playing: boolean
  focused: boolean
  favorite: boolean
  onHover: () => void
  onClick: () => void
  onContextMenu?: () => void
}

const ChannelRow = React.forwardRef<HTMLDivElement, RowProps>(function ChannelRow (
  { stream, number, playing, focused, favorite, onHover, onClick, onContextMenu }, ref
) {
  const dimmed = stream.isLive === false
  return (
    <div
      ref={ref}
      className={'channel-row' + (focused ? ' focused' : '') + (playing ? ' playing' : '')}
      onMouseMove={onHover}
      onClick={onClick}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu() } : undefined}
    >
      <span className="row-number">{formatChannelNumber(number)}</span>
      <span className="row-main">
        <span className="row-title-line">
          <span className={'row-title' + (dimmed ? ' dimmed' : '')}>{stream.title || stream.id}</span>
          {stream.isLive && <span className="badge-live">LIVE</span>}
          {favorite && <span className="row-star">★</span>}
        </span>
        {stream.description && <span className="row-now">{stream.description}</span>}
      </span>
      {stream.logo
        ? <img className="row-logo" src={stream.logo} alt="" />
        : <span className="row-logo row-logo-fallback">{(stream.title || '?').slice(0, 1).toUpperCase()}</span>}
    </div>
  )
})
