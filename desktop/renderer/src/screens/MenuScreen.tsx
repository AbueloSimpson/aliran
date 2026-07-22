// Main menu hub (the reference's icon-bar-over-wallpaper screen): a single
// horizontal icon menu across the top — glyphs + ALL-CAPS labels, focused item
// wrapped in an accent rounded border — over a full-screen wallpaper. Wallpaper =
// the featured stream's backdrop (panel curation) under a dark scrim, falling back
// to the operator's branding.wallpaper, then a plain brand surface. The section
// list is DATA-DRIVEN from the service descriptor (white-label §8).

import React, { useEffect, useMemo, useState } from 'react'
import { backend } from '../bridge'
import type { Stream } from '../types'
import { pickHero } from '../catalog'

export type MenuTarget = 'live' | 'favorites' | 'search' | 'settings' | 'exit'

interface MenuItem { key: MenuTarget; label: string; glyph: string }

export function MenuScreen ({ onGo }: { onGo: (target: MenuTarget) => void }) {
  const [streams, setStreams] = useState<Stream[]>(backend.streams)
  const [focus, setFocus] = useState(0)

  useEffect(() => {
    return backend.onMessage((m) => { if (m.type === 'streams') setStreams(m.streams) })
  }, [])

  const hero = useMemo(() => pickHero(streams), [streams])
  const wallpaper = hero?.backdrop || hero?.poster || backend.descriptor?.branding?.wallpaper

  const items = useMemo<MenuItem[]>(() => {
    const s = backend.descriptor?.sections ?? {}
    const list: MenuItem[] = [{ key: 'live', label: 'Live TV', glyph: '📺' }]
    if (s.favorites !== false) list.push({ key: 'favorites', label: 'Favorites', glyph: '⭐' })
    if (s.search !== false) list.push({ key: 'search', label: 'Search', glyph: '🔍' })
    if (s.settings !== false) list.push({ key: 'settings', label: 'Settings', glyph: '⚙️' })
    if (s.exit !== false) list.push({ key: 'exit', label: 'Exit', glyph: '🚪' })
    return list
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); setFocus((i) => Math.min(items.length - 1, i + 1)) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setFocus((i) => Math.max(0, i - 1)) }
      else if (e.key === 'Enter') { e.preventDefault(); onGo(items[focus].key) }
      else if (e.key === 'Escape') { e.preventDefault(); onGo('live') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, focus, onGo])

  return (
    <div className="menu">
      {wallpaper && <img className="menu-wallpaper" src={wallpaper} alt="" />}
      <div className="menu-scrim" />

      <div className="menu-bar">
        {items.map((item, i) => (
          <div
            key={item.key}
            className={'menu-entry' + (i === focus ? ' focused' : '')}
            onMouseMove={() => setFocus(i)}
            onClick={() => onGo(item.key)}
          >
            <span className="menu-glyph">{item.glyph}</span>
            <span className="menu-label">{item.label.toUpperCase()}</span>
          </div>
        ))}
      </div>

      <div className="menu-footer">
        <div className="menu-wordmark">{backend.descriptor?.name ?? 'Aliran'}</div>
        {hero && (
          <div className="menu-hero-line">
            {hero.isLive && <span className="np-live">● LIVE</span>}
            <span className="menu-hero-title">{hero.title}</span>
          </div>
        )}
      </div>
    </div>
  )
}
