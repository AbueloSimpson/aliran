// Favorites — the ★ channels (device-local, D4: stored beside the engine store; no
// panel roundtrip, no sync). Rows reuse the ChannelList component; selecting one
// jumps into Live TV playing that channel.

import React, { useEffect, useMemo, useState } from 'react'
import { backend } from '../bridge'
import type { Stream } from '../types'
import { channelNumbers, sortByCuration } from '../catalog'
import { ChannelList } from '../components/ChannelList'

export function FavoritesScreen ({ onWatch, onBack }: { onWatch: (streamId: string) => void; onBack: () => void }) {
  const [streams, setStreams] = useState<Stream[]>(backend.streams)
  const [favorites, setFavorites] = useState<string[]>(backend.favorites)

  useEffect(() => {
    backend.requestPrefs()
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(m.streams)
      if (m.type === 'prefs') setFavorites(m.favorites)
    })
  }, [])

  const numbers = useMemo(() => channelNumbers(streams), [streams])
  const list = useMemo(() => sortByCuration(streams.filter((s) => favorites.includes(s.id))), [streams, favorites])

  if (list.length === 0) {
    return (
      <div className="favorites-empty">
        <div className="section-header">FAVORITES</div>
        <div className="empty-center">
          <div className="empty-star">☆</div>
          <div className="empty-title">No favorites yet</div>
          <div className="empty-hint">In Live TV, press f (or the ★ button) on a channel. · Esc back</div>
        </div>
        <EscBack onBack={onBack} />
      </div>
    )
  }

  return (
    <div className="favorites">
      <ChannelList
        streams={list}
        heading="FAVORITES"
        numbers={numbers}
        playingId={null}
        favorites={favorites}
        onSelect={(s) => onWatch(s.id)}
        onClose={onBack}
      />
    </div>
  )
}

function EscBack ({ onBack }: { onBack: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onBack() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])
  return null
}
