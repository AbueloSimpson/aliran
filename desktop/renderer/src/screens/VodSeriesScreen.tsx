// Series detail — the provider's seasons and episodes (S54d, design D3/D6/D8/D9,
// mockup screen 5). The desktop twin of client/src/screens/VodSeriesScreen.tsx.
//
// A series NEVER plays directly: its tile on the Movies & Series grid opens this screen,
// which asks the MAIN process for the whole detail in ONE call (vod-series-info) and then
// plays an individual EPISODE. The episode url comes back already playable — the
// provider's token is substituted in main — and an episode the provider gave no usable
// (https) path for arrives as `url: ''` and shows a notice instead of playing. Nothing on
// this screen ever dials the provider a second time.
//
// LAYOUT (mockup screen 5). Left column: the poster, a ★ rating row (the provider rates
// out of TEN — five stars is rating/2, and the number is shown beside them so nobody has
// to count), the run-date range verbatim, the genre line. Right column: the title and the
// plot (expandable — provider plots run long and must not push the seasons off-screen).
// Under both: season TILES with an episode-count badge, then the selected season's
// episode list, then Start / Add to My List / Back.
//
// Start is a RESUME: the most recent watch-history entry belonging to this series wins,
// and playback picks up at its stored position; with no history it plays the first
// episode of the first season. My List and the history are DEVICE-LOCAL (D9) — main owns
// the disk, this screen only hands it whole arrays.
//
// KEYBOARD: Esc goes back to the grid. Everything else is mouse- and Tab-reachable (the
// episode list is a long column of buttons — an arrow model over it would fight the
// browser's own Tab order for no gain).

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { backend } from '../bridge'
import { formatDuration } from '../catalog'
import type {
  VodConfig, VodEpisode, VodErrorCode, VodHistoryEntry, VodListEntry, VodSeason, VodSeriesDetail
} from '../types'
import { errorText, type VodPick } from './VodScreen'

/** What the grid hands this screen: everything it already knew about the series, so the
 *  header can be drawn before the provider answers. */
export interface VodSeriesPick {
  id: string
  name: string
  icon?: string
  anio?: string
}

const STAR_FULL = '★'
const STAR_EMPTY = '☆'

/** The mockup's "★★★★☆ 8.0" row. The provider states a rating out of ten as a string;
 *  five stars is therefore rating/2, rounded to the nearest whole star. An absent,
 *  unparseable or zero rating has no row at all — inventing "0.0 ★☆☆☆☆" would libel
 *  every title the provider simply never rated. */
export function ratingStars (rating: string): { stars: string; value: string } | null {
  const n = Number(rating)
  if (!Number.isFinite(n) || n <= 0) return null
  const clamped = Math.min(10, n)
  const full = Math.round(clamped / 2)
  return { stars: STAR_FULL.repeat(full) + STAR_EMPTY.repeat(5 - full), value: clamped.toFixed(1) }
}

/** The title the player screen shows for an episode: "<series> S1E1 — <episode>".
 *  Numbers are the provider's own; an untitled episode keeps just the code. */
export function episodeTitle (seriesName: string, seasonNumber: number, ep: Pick<VodEpisode, 'number' | 'title'>): string {
  const code = `S${seasonNumber || 1}E${ep.number || 1}`
  const head = seriesName ? `${seriesName} ${code}` : code
  return ep.title ? `${head} — ${ep.title}` : head
}

export function VodSeriesScreen ({ pick, onPlay, onBack }: {
  pick: VodSeriesPick
  onPlay: (p: VodPick) => void
  onBack: () => void
}) {
  const { id, name, icon, anio } = pick
  // Login-scoped, exactly as on the grid: the coordinates ride the 'streams' message.
  const config: VodConfig | null = backend.vod ?? null

  const [detail, setDetail] = useState<VodSeriesDetail | null>(null)
  const [error, setError] = useState<VodErrorCode | null>(null)
  const [seasonId, setSeasonId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Device-local (D9). Seeded from the bridge's cached prefs and kept current from the
  // 'prefs' reply — which is the TRUTH: main gates and caps what it stored.
  const [myList, setMyList] = useState<VodListEntry[]>(backend.vodMyList || [])
  const [history, setHistory] = useState<VodHistoryEntry[]>(backend.vodHistory || [])

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'prefs') { setMyList(m.vodList || []); setHistory(m.vodHistory || []) }
    })
  }, [])

  useEffect(() => {
    if (!config) return
    let live = true
    setDetail(null); setError(null); setSeasonId(null)
    backend.vodSeriesInfo(id).then((res) => {
      if (!live) return
      if (res.ok) {
        setDetail(res.detail)
        // Land on the first season the provider named, so the episode list is never
        // empty on arrival (a series with no seasons falls back to every episode).
        setSeasonId(res.detail.seasons[0]?.id ?? null)
      } else setError(res.error)
    })
    return () => { live = false }
  }, [config, id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'Escape') { e.preventDefault(); onBack() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const seasons: VodSeason[] = detail?.seasons ?? []
  const episodes = useMemo(() => {
    const all = detail?.episodes ?? []
    if (!seasonId) return seasons.length > 0 ? [] : all
    return all.filter((e) => e.seasonId === seasonId)
  }, [detail, seasonId, seasons.length])

  const seasonOf = useCallback(
    (episode: VodEpisode) => seasons.find((s) => s.id === episode.seasonId) ?? null,
    [seasons]
  )

  // id -> this device's history entry for that EPISODE (the resume hint under each row).
  const watched = useMemo(() => {
    const out = new Map<string, VodHistoryEntry>()
    for (const h of history || []) if (h && h.kind === 'episode' && h.id) out.set(h.id, h)
    return out
  }, [history])

  // The newest history entry belonging to THIS series — what Start resumes.
  const lastWatched = useMemo(() => {
    let best: VodHistoryEntry | null = null
    for (const h of history || []) {
      if (!h || h.kind !== 'episode' || h.seriesId !== id) continue
      if (!best || (Number(h.at) || 0) > (Number(best.at) || 0)) best = h
    }
    return best
  }, [history, id])

  const saved = useMemo(
    () => (myList || []).some((e) => e && e.kind === 'series' && e.id === id),
    [myList, id]
  )

  const play = useCallback((episode: VodEpisode, resumeSec?: number) => {
    if (!episode.url) {
      // D3: a non-https (or absent) provider path never becomes a playback attempt —
      // this app will not put a viewer's password on a cleartext URL.
      setNotice('This episode has no playable video yet. Try another one.')
      return
    }
    setNotice(null)
    const season = seasonOf(episode)
    onPlay({
      url: episode.url,
      title: episodeTitle(name, season?.number ?? 0, episode),
      durationSec: episode.durationSec ?? null,
      id: episode.id,
      kind: 'episode',
      seriesId: id,
      ...(resumeSec && resumeSec > 0 ? { resumeSec } : {})
    })
  }, [onPlay, name, id, seasonOf])

  // Start = resume where this device left off, else the very first episode.
  const start = useCallback(() => {
    if (!detail) return
    if (lastWatched) {
      const episode = detail.episodes.find((e) => e.id === lastWatched.id)
      if (episode) { play(episode, lastWatched.positionSec); return }
    }
    const firstSeason = detail.seasons[0]
    const first = firstSeason
      ? detail.episodes.find((e) => e.seasonId === firstSeason.id) ?? detail.episodes[0]
      : detail.episodes[0]
    if (first) play(first)
    else setNotice('This series has no episodes yet.')
  }, [detail, lastWatched, play])

  // My List: whole-array replace, newest first (D9). The optimistic local state keeps the
  // button honest for the frame or two before main answers with a 'prefs'.
  const toggleSaved = useCallback(() => {
    const rest = (myList || []).filter((e) => !(e && e.kind === 'series' && e.id === id))
    const next: VodListEntry[] = saved ? rest : [{ kind: 'series', id }, ...rest]
    setMyList(next)
    setNotice(saved ? 'Removed from My List.' : 'Added to My List.')
    try { backend.setVodPrefs({ list: next }) } catch { /* device-local convenience, never fatal */ }
  }, [myList, saved, id])

  const rating = detail ? ratingStars(detail.rating) : null

  function renderDetail () {
    if (!config) return <Centered title="Not available" hint="This service has no movie provider configured." />
    if (error) return <Centered {...errorText(error)} />
    if (!detail) return <div className="section-loading"><span className="spinner" />Loading episodes…</div>
    return (
      <>
        <div className="vod-series-actions">
          <button className="vod-series-btn primary" onClick={start}>Start</button>
          <button className="vod-series-btn" onClick={toggleSaved}>{saved ? 'Remove from My List' : 'Add to My List'}</button>
          <button className="vod-series-btn" onClick={onBack}>Back</button>
        </div>

        {seasons.length > 0 && (
          <>
            <div className="section-header vod-series-section">SEASONS</div>
            <div className="vod-series-seasons">
              {seasons.map((s) => (
                <SeasonTile key={s.id} season={s} active={s.id === seasonId} onClick={() => setSeasonId(s.id)} />
              ))}
            </div>
          </>
        )}

        <div className="section-header vod-series-section">EPISODES</div>
        {episodes.length === 0
          ? <div className="empty-hint">This season has no episodes yet.</div>
          : (
            <div className="vod-episodes">
              {episodes.map((e) => (
                <EpisodeRow key={e.id} episode={e} seen={watched.get(e.id) ?? null} onClick={() => play(e, watched.get(e.id)?.positionSec)} />
              ))}
            </div>
            )}
      </>
    )
  }

  // The header is drawn from what the GRID already knew (poster, name, year) the instant
  // this screen mounts — the provider call only ever ADDS to it. A detail screen that
  // shows a spinner where the poster the viewer just clicked should be reads as a stall.
  return (
    <div className="vod-series">
      <div className="vod-series-scroll">
        {!!notice && <div className="vod-notice">{notice}</div>}

        <div className="vod-series-top">
          <div className="vod-series-left">
            <Poster art={detail?.icon || icon || ''} initial={name} />
            {!!rating && (
              <div className="vod-series-rating">
                <span className="vod-series-stars">{rating.stars}</span>
                <span className="vod-series-rating-value">{rating.value}</span>
              </div>
            )}
            {!!detail?.releasedate && <div className="vod-series-meta">{detail.releasedate}</div>}
            {!!detail?.genre && <div className="vod-series-meta">{detail.genre}</div>}
          </div>

          <div className="vod-series-right">
            <div className="vod-series-title">{name}{anio ? ` (${anio})` : ''}</div>
            {!!detail?.plot && (
              <>
                <div className={'vod-series-plot' + (expanded ? ' expanded' : '')}>{detail.plot}</div>
                <button className="vod-chip" onClick={() => setExpanded((v) => !v)}>{expanded ? 'LESS' : 'MORE'}</button>
              </>
            )}
          </div>
        </div>

        {renderDetail()}
      </div>
    </div>
  )
}

function Centered ({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="empty-center">
      <div className="empty-title">{title}</div>
      <div className="empty-hint">{hint}</div>
    </div>
  )
}

// Poster art with the grid's fallback: the title's initial on a plain surface rather
// than a grey hole (a hole reads as breakage, an initial reads as "no art").
function Poster ({ art, initial }: { art: string; initial: string }) {
  const [broken, setBroken] = useState(false)
  const showArt = !!art && !broken
  return (
    <span className="vod-poster vod-series-poster">
      {showArt
        ? <img src={art} alt="" onError={() => setBroken(true)} />
        : <span className="vod-poster-initial">{(initial || '?').slice(0, 1).toUpperCase()}</span>}
    </span>
  )
}

// A season tile wears the poster tile's clothes plus the mockup's episode-count badge in
// the top-right corner of the art.
function SeasonTile ({ season, active, onClick }: { season: VodSeason; active: boolean; onClick: () => void }) {
  const [broken, setBroken] = useState(false)
  const showArt = !!season.icon && !broken
  const label = season.title || `Season ${season.number || 1}`
  return (
    <button className={'vod-season' + (active ? ' active' : '')} onClick={onClick} title={label}>
      <span className="vod-poster">
        {showArt
          ? <img src={season.icon} alt="" onError={() => setBroken(true)} />
          : <span className="vod-poster-initial">{season.number || 1}</span>}
        {season.episodeCount > 0 && <span className="vod-season-badge">{season.episodeCount}</span>}
      </span>
      <span className="vod-season-label">{label}</span>
    </button>
  )
}

// One episode: number + title, the runtime as a chip, one line of plot, and this
// DEVICE's own progress ("Resume at 12:34" / "Watched").
function EpisodeRow ({ episode, seen, onClick }: { episode: VodEpisode; seen: VodHistoryEntry | null; onClick: () => void }) {
  const duration = episode.durationSec && episode.durationSec > 0 ? formatDuration(episode.durationSec) : ''
  const progress = seen
    ? (seen.positionSec > 0 ? `Resume at ${formatDuration(seen.positionSec)}` : 'Watched')
    : ''
  return (
    <button className="vod-episode" onClick={onClick}>
      <span className="vod-episode-num">{episode.number || '-'}</span>
      <span className="vod-episode-body">
        <span className="vod-episode-title">{episode.title || `Episode ${episode.number || ''}`.trim()}</span>
        {!!episode.plot && <span className="vod-episode-plot">{episode.plot}</span>}
      </span>
      <span className="vod-episode-side">
        {!!duration && <span className="vod-episode-duration">{duration}</span>}
        {!!progress && <span className="vod-episode-progress">{progress}</span>}
      </span>
    </button>
  )
}
