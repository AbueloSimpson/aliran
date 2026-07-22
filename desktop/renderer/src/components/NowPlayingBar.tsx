// Persistent bottom bar shown while a channel is open and the browse overlay is
// gone: derived number + logo + title / what's-on-now (EPG when the channel has a
// guide, else the catalog synopsis) + wall clock, and a row of mouse controls
// (Channels / Info / Favorite / CC). Auto-hidden by LiveScreen after idle; any
// mouse move or key brings it back.
//
// vod transport (S8a): when the playing record is a library title the bar grows a
// transport row — play/pause, elapsed / runtime, and a scrubbable seek bar.

import React, { useRef, useState } from 'react'
import type { Stream } from '../types'
import { formatChannelNumber, formatDuration } from '../catalog'
import { useEpg } from '../../../../sdk/react-native/src/useEpg'

export interface VodTransport {
  position: number
  duration: number
  paused: boolean
}

export interface NowPlayingBarProps {
  stream: Stream
  number?: number
  clock: string
  favorite: boolean
  onChannels: () => void
  onInfo: () => void
  onToggleFavorite: () => void
  hasTracks?: boolean
  onTracks?: () => void
  vod?: VodTransport | null
  onTogglePause?: () => void
  onSeek?: (seconds: number) => void
}

export function NowPlayingBar ({ stream, number, clock, favorite, onChannels, onInfo, onToggleFavorite, hasTracks, onTracks, vod, onTogglePause, onSeek }: NowPlayingBarProps) {
  // What's on NOW from the program guide — more useful on the bar than the channel
  // synopsis; the synopsis still lives in the Info panel.
  const { data } = useEpg(stream.epgUrl, stream.epgId)
  const subtitle = data?.now?.title || stream.description
  return (
    <div className="nowplaying">
      <div className="np-info">
        {stream.logo && <img className="np-logo" src={stream.logo} alt="" />}
        <span className="np-number">{formatChannelNumber(number)}</span>
        <span className="np-main">
          <span className="np-title-line">
            <span className="np-title">{stream.title}</span>
            {stream.isLive && <span className="np-live">● LIVE</span>}
          </span>
          {subtitle && <span className="np-desc">{subtitle}</span>}
        </span>
        <span className="np-divider" />
        <span className="np-clock">{clock}</span>
      </div>

      {vod && (
        <div className="np-transport">
          <button className="np-play" onClick={onTogglePause}>{vod.paused ? '▶' : '❚❚'}</button>
          <SeekBar position={vod.position} duration={vod.duration} onSeek={onSeek} />
        </div>
      )}

      <div className="np-buttons">
        <BarButton glyph="☰" label="Channels" onClick={onChannels} />
        <BarButton glyph="ⓘ" label="Info" onClick={onInfo} />
        <BarButton glyph={favorite ? '★' : '☆'} label="Favorite" active={favorite} onClick={onToggleFavorite} />
        {hasTracks && <BarButton glyph="CC" label="Subtitles" onClick={() => onTracks?.()} />}
      </div>
    </div>
  )
}

// Scrubbable progress bar: elapsed | track | runtime. Press/drag previews the target
// position, release seeks; while not scrubbing it renders the live playhead.
function SeekBar ({ position, duration, onSeek }: { position: number; duration: number; onSeek?: (seconds: number) => void }) {
  const [scrub, setScrub] = useState<number | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)

  const frac = (clientX: number) => {
    const el = trackRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }
  const onDown = (e: React.PointerEvent) => {
    dragging.current = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setScrub(frac(e.clientX))
  }
  const onMove = (e: React.PointerEvent) => { if (dragging.current) setScrub(frac(e.clientX)) }
  const onUp = (e: React.PointerEvent) => {
    if (!dragging.current) return
    dragging.current = false
    const f = frac(e.clientX)
    setScrub(null)
    if (duration > 0) onSeek?.(f * duration)
  }

  const shownFrac = scrub ?? (duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0)
  const shownPos = scrub != null && duration > 0 ? scrub * duration : position
  return (
    <>
      <span className="np-time">{formatDuration(shownPos) || '0:00'}</span>
      <div ref={trackRef} className="np-track-touch" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <div className="np-track-line"><div className="np-track-fill" style={{ width: `${shownFrac * 100}%` }} /></div>
        <div className="np-thumb" style={{ left: `${shownFrac * 100}%` }} />
      </div>
      <span className="np-time">{formatDuration(duration) || '--:--'}</span>
    </>
  )
}

function BarButton ({ glyph, label, active, onClick }: { glyph: string; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button className={'np-btn' + (active ? ' active' : '')} onClick={onClick}>
      <span className="np-btn-glyph">{glyph}</span>
      <span className="np-btn-label">{label}</span>
    </button>
  )
}
