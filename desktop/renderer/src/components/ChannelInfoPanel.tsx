// Channel-detail overlay (the reference's program-info panel): art, number + title,
// category chips, LIVE state, synopsis, live source stats (P2P/CDN + peers — data
// the reference app doesn't even have), favorite toggle, Watch button. The
// program-guide slot shows a live now/next guide for source-imported channels
// (fetched on demand from the provider's epgUrl — the shared EPG data layer from
// @aliran/react-native, which is plain TS and runs verbatim here), and falls back
// to an honest "No program information" placeholder (D2 — no fake data). vod
// library titles (S8a) show their runtime and availability instead of LIVE state
// and omit the guide slot — titles have no schedule.

import React from 'react'
import type { Stream } from '../types'
import { formatChannelNumber, formatDuration, isVod } from '../catalog'
import { useEpg } from '../../../../sdk/react-native/src/useEpg'
import type { EpgProgram } from '../../../../sdk/react-native/src/epg'

function hhmm (ms: number): string {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

export interface ChannelInfoPanelProps {
  stream: Stream
  number?: number
  favorite: boolean
  playing: boolean
  source?: 'p2p' | 'cdn' | null
  peers?: number | null
  onWatch: () => void
  onToggleFavorite: () => void
}

export function ChannelInfoPanel ({ stream, number, favorite, playing, source, peers, onWatch, onToggleFavorite }: ChannelInfoPanelProps) {
  const art = stream.poster || stream.backdrop || stream.logo
  const vod = isVod(stream)
  const duration = vod ? formatDuration(stream.durationSec) : ''
  return (
    <div className="info-panel">
      <div className="info-header">
        <span className="info-number">{formatChannelNumber(number)}</span>
        <span className="info-title">{stream.title}</span>
      </div>

      <div className="info-art-box">
        {art
          ? <img className="info-art" src={art} alt="" />
          : <div className="info-art info-art-fallback">{(stream.title || '?').slice(0, 1).toUpperCase()}</div>}
        {stream.isLive && <span className="info-live badge-live">● LIVE</span>}
        {duration && <span className="info-duration">{duration}</span>}
      </div>

      {!!stream.category?.length && (
        <div className="info-chips">
          {stream.category.map((c) => <span key={c} className="info-chip">{c.toUpperCase()}</span>)}
        </div>
      )}

      {vod && stream.status === 'unavailable' && <div className="info-unavailable">CURRENTLY UNAVAILABLE</div>}

      {stream.description && <div className="info-desc">{stream.description}</div>}

      {playing && (
        <div className="info-stats">
          {source && <span className={source === 'p2p' ? 'src-p2p' : 'src-cdn'}>{source.toUpperCase()}</span>}
          {source !== 'cdn' && peers != null && <span className="badge-peers">{peers} peer{peers === 1 ? '' : 's'}</span>}
        </div>
      )}

      {/* EPG slot: live now/next when the channel carries a guide, else the honest
          placeholder. A vod title has no schedule — the slot is omitted entirely. */}
      {!vod && <EpgGuide stream={stream} />}

      <div className="info-actions">
        <button className="info-button primary" onClick={onWatch}>{playing ? 'Watching' : 'Watch'}</button>
        <button className="info-button" onClick={onToggleFavorite}>{favorite ? '★ Remove favorite' : '☆ Add favorite'}</button>
      </div>
      <div className="panel-hint">Esc back · f favorite</div>
    </div>
  )
}

// Renders "Now" (with an elapsed bar) + a short "Up next" list when the channel has
// a guide that resolved; otherwise the placeholder. Never blocks on the fetch.
function EpgGuide ({ stream }: { stream: Stream }) {
  const { data, loaded } = useEpg(stream.epgUrl, stream.epgId)
  const has = !!(data && (data.now || data.next.length))
  return (
    <div className="epg-slot">
      <div className="epg-heading">PROGRAM GUIDE</div>
      {!has
        ? <div className="epg-empty">{stream.epgUrl && !loaded ? 'Loading guide…' : 'No program information'}</div>
        : (
          <>
            {data!.now && <NowRow program={data!.now} />}
            {data!.next.length > 0 && (
              <div className="epg-next">
                <div className="epg-next-label">UP NEXT</div>
                {data!.next.map((p) => (
                  <div key={p.start} className="epg-next-row">
                    <span className="epg-next-time">{hhmm(p.start)}</span>
                    <span className="epg-next-title">{p.title}</span>
                  </div>
                ))}
              </div>
            )}
          </>
          )}
    </div>
  )
}

function NowRow ({ program }: { program: EpgProgram }) {
  const pct = Math.max(0, Math.min(1, (Date.now() - program.start) / (program.stop - program.start)))
  return (
    <div className="epg-now">
      <div className="epg-now-head">
        <span className="epg-now-title">{program.title}</span>
        <span className="epg-now-time">{hhmm(program.start)}–{hhmm(program.stop)}</span>
      </div>
      <div className="epg-bar-track"><div className="epg-bar-fill" style={{ width: `${Math.round(pct * 100)}%` }} /></div>
    </div>
  )
}
