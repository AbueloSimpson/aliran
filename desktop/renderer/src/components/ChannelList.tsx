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

import React, { useEffect, useRef, useState } from 'react'
import type { Stream } from '../types'
import { formatChannelNumber, formatDuration, isVod } from '../catalog'
import { useEpg } from '../../../../sdk/react-native/src/useEpg'

// Live thumbnail refresh cadence — the broadcaster rolls /thumb.jpg at the same period,
// so a faster tick would re-fetch the frame the row already shows.
const THUMB_REFRESH_MS = 30000

// Thumb-first channel art (the desktop half of the client's useChannelThumb). The engine
// hands out thumbBase for EVERY channel, so a 404 is the normal "nothing to show" answer
// (thumbnails off, feed not warm, metered network) and the row falls back to the logo —
// never a broken-image state. The ?t= stamp is load-bearing: the thumbnail rolls IN
// PLACE, so an unchanged URL would leave the browser cache pinned to the first frame.
// Each tick also re-probes a missing thumb — the SDK warms a cold feed on that first
// miss, so the picture appears one tick later instead of never.
function useChannelThumb (thumbBase?: string): [string | null, () => void] {
  const [stamp, setStamp] = useState(0)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    if (!thumbBase) return
    setBroken(false)
    const timer = setInterval(() => { setStamp(Date.now()); setBroken(false) }, THUMB_REFRESH_MS)
    return () => clearInterval(timer)
  }, [thumbBase])
  return [thumbBase && !broken ? `${thumbBase}?t=${stamp}` : null, () => setBroken(true)]
}

export interface ChannelListProps {
  streams: Stream[]
  heading?: string
  numbers: Map<string, number>
  playingId: string | null
  favorites: string[]
  onSelect: (s: Stream) => void
  /** Open channel detail (the 'i' key / right-click). */
  onInfo?: (s: Stream) => void
  onClose: () => void
  /** Any interaction (defers the auto-hide timer). */
  onActivity?: () => void
  /** Keyboard ownership: false while a sibling pane (the category rail) has it —
   *  the mouse keeps working either way. Default true. */
  active?: boolean
}

export function ChannelList ({ streams, heading = 'CHANNELS', numbers, playingId, favorites, onSelect, onInfo, onClose, onActivity, active = true }: ChannelListProps) {
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
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      // A text input above the list (Search) owns the keyboard while focused.
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
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
  }, [streams, focus, onSelect, onInfo, onClose, onActivity, active])

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
      <div className="panel-hint">↑↓ browse · Enter watch{onInfo ? ' · i / right-click info' : ''} · Esc close</div>
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
          {duration && <span className="row-duration">{duration}</span>}
          {favorite && <span className="row-star">★</span>}
        </span>
        {nowText && <span className="row-now">{nowText}</span>}
      </span>
      {art
        ? <img className={'row-logo' + (thumbUri ? ' row-thumb' : '')} src={art} alt="" loading="lazy" onError={thumbUri ? onThumbError : undefined} />
        : <span className="row-logo row-logo-fallback">{(stream.title || '?').slice(0, 1).toUpperCase()}</span>}
    </div>
  )
})
