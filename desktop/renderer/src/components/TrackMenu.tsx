// Subtitle/CC + audio track selector — an overlay over the live video (the CC bar
// button / the 'c' key). hls.js reports the tracks it found in the current stream;
// selection is by flat index (reliable in hls.js — unlike ExoPlayer's group-relative
// text indexes that bit the RN app, S27k). Subtitles always shows Off + one row per
// track; Audio appears only when the stream has more than one. Picking a row applies
// it AND dismisses (a track choice is a one-shot action). Esc / backdrop click close.

import React, { useEffect, useState } from 'react'
import type { MediaTrack } from './HlsVideo'

export interface TrackMenuProps {
  textTracks: MediaTrack[]
  audioTracks: MediaTrack[]
  /** Selected subtitle index (-1 = off). */
  selectedText: number
  /** Selected audio index (undefined = player default). */
  selectedAudio?: number
  onSelectText: (index: number) => void
  onSelectAudio: (index: number) => void
  onClose: () => void
}

interface Row { kind: 'text' | 'audio'; index: number; label: string; active: boolean }

export function TrackMenu ({ textTracks, audioTracks, selectedText, selectedAudio, onSelectText, onSelectAudio, onClose }: TrackMenuProps) {
  const rows: Array<Row | { heading: string }> = [{ heading: 'Subtitles' }]
  rows.push({ kind: 'text', index: -1, label: 'Off', active: selectedText === -1 })
  textTracks.forEach((t, i) => rows.push({ kind: 'text', index: i, label: t.label, active: selectedText === i }))
  if (audioTracks.length > 1) {
    rows.push({ heading: 'Audio' })
    audioTracks.forEach((t, i) => rows.push({ kind: 'audio', index: i, label: t.label, active: selectedAudio != null ? selectedAudio === i : i === 0 }))
  }
  const selectable = rows.map((r, i) => ('kind' in r ? i : -1)).filter((i) => i >= 0)
  const [focus, setFocus] = useState(selectable[0] ?? 0)

  const choose = (r: Row) => {
    if (r.kind === 'text') onSelectText(r.index)
    else onSelectAudio(r.index)
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      const pos = selectable.indexOf(focus)
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(selectable[Math.min(selectable.length - 1, pos + 1)]) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(selectable[Math.max(0, pos - 1)]) }
      else if (e.key === 'Enter') { e.preventDefault(); const r = rows[focus]; if (r && 'kind' in r) choose(r) }
      else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    // Capture phase so the Live surface beneath never sees these keys.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, textTracks, audioTracks, selectedText, selectedAudio])

  return (
    <div className="track-overlay" onClick={onClose}>
      <div className="track-panel" onClick={(e) => e.stopPropagation()}>
        {rows.map((r, i) =>
          'heading' in r
            ? <div key={'h' + i} className="track-heading">{r.heading}</div>
            : (
              <div
                key={r.kind + r.index}
                className={'track-row' + (r.active ? ' active' : '') + (i === focus ? ' focused' : '')}
                onMouseMove={() => setFocus(i)}
                onClick={() => choose(r)}
              >
                <span className="track-dot">{r.active ? '●' : '○'}</span>
                <span className="track-label">{r.label}</span>
              </div>
              )
        )}
      </div>
    </div>
  )
}
