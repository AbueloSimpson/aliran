// In-app volume for the players (QA round 3): a speaker mute toggle + a level
// slider. Applied by the host screen to its <video> element; persisted in
// localStorage — a presentation preference, renderer-owned, device-local.
// Muting keeps the level so unmuting restores it; dragging while muted unmutes.
import React from 'react'
import { useI18n } from '@aliran/i18n'

const KEY = 'aliran.volume'

/** The persisted volume state (defaults: full volume, unmuted). */
export function loadVolume (): { volume: number; muted: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '')
    const volume = Number(raw?.volume)
    return {
      volume: isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1,
      muted: !!raw?.muted
    }
  } catch { return { volume: 1, muted: false } }
}

export function saveVolume (volume: number, muted: boolean) {
  try { localStorage.setItem(KEY, JSON.stringify({ volume, muted })) } catch { /* full/blocked storage is not an error */ }
}

export function VolumeControl ({ volume, muted, onChange }: {
  volume: number
  muted: boolean
  onChange: (volume: number, muted: boolean) => void
}) {
  const { t } = useI18n()
  return (
    <div className="np-volume">
      <button
        className="np-btn"
        // The key token is a variable, not part of the sentence: 'm' is the same
        // keyboard key in every language.
        title={muted ? t('hints.unmuteKey', { key: 'm' }) : t('hints.muteKey', { key: 'm' })}
        onClick={() => onChange(volume, !muted)}
      >
        <span className="np-btn-glyph">{muted || volume === 0 ? '🔇' : '🔊'}</span>
      </button>
      <input
        className="np-volume-slider"
        type="range"
        min={0}
        max={100}
        value={Math.round((muted ? 0 : volume) * 100)}
        aria-label={t('common.volume')}
        onChange={(e) => onChange(Number(e.target.value) / 100, false)}
      />
    </div>
  )
}
