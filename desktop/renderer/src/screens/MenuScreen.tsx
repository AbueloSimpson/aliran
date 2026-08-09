// Main menu hub (the reference's icon-bar-over-wallpaper screen): a single
// horizontal icon menu across the top — glyphs + ALL-CAPS labels, focused item
// wrapped in an accent rounded border — over a full-screen wallpaper. Wallpaper =
// the featured stream's LIVE feed thumb when one is rolling (WS5), over its backdrop
// (panel curation) under a dark scrim, falling back to the operator's
// branding.wallpaper, then a plain brand surface. The section
// list is DATA-DRIVEN from the service descriptor (white-label §8) AND, for Movies
// & Series, from the PANEL: that tile exists only while the operator has an external
// VOD provider enabled (S53 — backend.vod arrives on the login/'streams' payload and
// is null otherwise), and a brand can still switch it off with sections.vod:false.

import React, { useEffect, useMemo, useState } from 'react'
import { getLocale, useI18n } from '@aliran/i18n'
import { backend } from '../bridge'
import type { Stream, SectionToggles } from '../types'
import { pickHero } from '../catalog'
import { visibleStreams } from '../parental'
import { useEpg } from '../../../../sdk/react-native/src/useEpg'
import { useChannelThumb } from '../../../../sdk/react-native/src/thumbs'

export type MenuTarget = 'live' | 'guide' | 'vod' | 'favorites' | 'search' | 'settings' | 'exit'

// The tile carries its TARGET and its glyph, never its label: the label is looked up
// at render (t('menu.' + key)), so a language change repaints a menu this memo would
// otherwise hold frozen in the language it was first built in.
interface MenuItem { key: MenuTarget; glyph: string }

export function MenuScreen ({ onGo }: { onGo: (target: MenuTarget) => void }) {
  const { t } = useI18n()
  const [streams, setStreams] = useState<Stream[]>(() => visibleStreams(backend.streams))
  const [focus, setFocus] = useState(0)
  // The panel's VOD provider switch. It rides the same 'streams' message, so a menu
  // mounted before login grows the tile the moment the catalog lands.
  const [vodEnabled, setVodEnabled] = useState<boolean>(!!backend.vod?.enabled)

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'streams') { setStreams(visibleStreams(m.streams)); setVodEnabled(!!m.vod?.enabled) }
    })
  }, [])

  const hero = useMemo(() => pickHero(streams), [streams])
  const wallpaper = hero?.backdrop || hero?.poster || backend.descriptor?.branding?.wallpaper
  // Live hero: the featured channel's rolling feed thumb (the SDK's 30 s poll — the
  // same hook the channel rows use) layered over its backdrop. The backdrop stays
  // mounted underneath, so nothing changes while the thumb loads — and a 404
  // (thumbnails off, feed cold) IS today's backdrop-only wallpaper. The existing
  // scrim above does all the blending; no new overlays.
  const [heroThumb, onHeroThumbError] = useChannelThumb(hero?.thumbBase)
  // The chip latches on a real decoded frame, not URL truthiness: the hook re-probes
  // 404ing feeds every 30 s (url flips truthy before the error lands), which would
  // flash the chip on thumb-less channels without this latch.
  const [thumbShown, setThumbShown] = useState(false)
  useEffect(() => { setThumbShown(false) }, [hero?.thumbBase])
  // Now-playing line for the featured stream — omitted entirely when it has no guide.
  const { data: heroEpg } = useEpg(hero?.epgUrl, hero?.epgId, hero?.guideBase)
  const nowTitle = heroEpg?.now?.title

  const items = useMemo<MenuItem[]>(() => {
    // sections.guide is new with the guide hub (WS5) — typed locally until the
    // descriptor's SectionToggles grows the field.
    const s: SectionToggles & { guide?: boolean } = backend.descriptor?.sections ?? {}
    const list: MenuItem[] = [{ key: 'live', glyph: '📺' }]
    if (s.guide !== false) list.push({ key: 'guide', glyph: '🗓️' })
    if (vodEnabled && s.vod !== false) list.push({ key: 'vod', glyph: '🎬' })
    if (s.favorites !== false) list.push({ key: 'favorites', glyph: '⭐' })
    if (s.search !== false) list.push({ key: 'search', glyph: '🔍' })
    if (s.settings !== false) list.push({ key: 'settings', glyph: '⚙️' })
    if (s.exit !== false) list.push({ key: 'exit', glyph: '🚪' })
    return list
  }, [vodEnabled])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); setFocus((i) => Math.min(items.length - 1, i + 1)) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setFocus((i) => Math.max(0, i - 1)) }
      // items[] can grow at runtime (the VOD tile appears with the login payload) —
      // a focus index left over from the shorter list must not crash the menu.
      else if (e.key === 'Enter') { e.preventDefault(); const it = items[focus]; if (it) onGo(it.key) }
      else if (e.key === 'Escape') { e.preventDefault(); onGo('live') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, focus, onGo])

  return (
    <div className="menu">
      {wallpaper && <img className="menu-wallpaper" src={wallpaper} alt="" />}
      {hero && heroThumb && (
        // The src carries a rolling ?t= stamp; the img element itself stays mounted
        // across polls (same slot in the tree) — only the source updates.
        <img
          className="menu-wallpaper"
          src={heroThumb}
          alt={t('menu.heroLiveNow', { title: hero.title ?? '' })}
          onError={() => { setThumbShown(false); onHeroThumbError() }}
          onLoad={() => setThumbShown(true)}
        />
      )}
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
            <span className="menu-label">{t('menu.' + item.key).toLocaleUpperCase(getLocale())}</span>
          </div>
        ))}
      </div>

      <div className="menu-footer">
        <div className="menu-wordmark">{backend.descriptor?.name ?? 'Aliran'}</div>
        {hero && (
          <div className="menu-hero-line">
            {hero.isLive && <span className="np-live">{t('common.liveBadge')}</span>}
            <span className="menu-hero-title">{hero.title}</span>
          </div>
        )}
        {!!nowTitle && (
          <div className="menu-hero-line">
            {/* The chip needs live evidence: only after a feed frame actually loaded. */}
            {thumbShown && <span className="badge-live">{t('common.live')}</span>}
            <span className="menu-hero-title">{nowTitle}</span>
          </div>
        )}
      </div>
    </div>
  )
}
