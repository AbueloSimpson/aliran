// Live TV — ONE fullscreen video surface with overlay panels (the S18
// reorganization, ported): playback never stops while browsing; selecting a row
// switches the stream in place; a top-right TunePill shows switch progress driven
// SOLELY by <HlsVideo>'s onTune lifecycle (raw player events also fire for the
// PREVIOUS channel under the shared localhost URL — the S22 lesson).
//
// Keyboard model (the D-pad patterns on desktop keys):
//   fullscreen : ↑/↓ zap prev/next over the whole curated order (the channel
//                numbers' order), Enter/click opens the channel list, Esc → Menu
//   list open  : ↑/↓ browse, Enter watch, Esc close (auto-hides after idle too)

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { backend } from '../bridge'
import type { Stream } from '../types'
import { channelNumbers, pickHero, sortByCuration, zapOrder } from '../catalog'
import { HlsVideo, type HlsVideoHandle, type TuneEvent } from '../components/HlsVideo'
import { TunePill, type TunePillPhase } from '../components/TunePill'
import { ChannelList } from '../components/ChannelList'

// The browse overlay has no manual close control — it auto-hides this long after the
// last interaction, back to clean fullscreen video.
const MENU_IDLE_MS = 6000

// Last channel watched THIS session (module-level: survives leaving Live for the
// Menu and back — re-entering resumes it instead of the hero pick).
let lastStreamId: string | null = null

export function LiveScreen ({ onExit, initialStreamId }: { onExit: () => void; initialStreamId?: string }) {
  const [streams, setStreams] = useState<Stream[]>(backend.streams)
  const [playingId, setPlayingId] = useState<string | null>(() => initialStreamId ?? lastStreamId ?? pickHero(backend.streams)?.id ?? null)
  const [listOpen, setListOpen] = useState(() => !(initialStreamId ?? lastStreamId))
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The tuning pill, keyed by tune id so every tune replaces it atomically at 0%;
  // active flips false on 'playing' (snap to 100% + hold); null = no pill (error UI).
  const [tuneUI, setTuneUI] = useState<{ id: number; phase: TunePillPhase; active: boolean } | null>(null)
  const videoHandle = useRef<HlsVideoHandle | null>(null)
  const menuIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playingIdRef = useRef(playingId); playingIdRef.current = playingId
  const listOpenRef = useRef(listOpen); listOpenRef.current = listOpen

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(m.streams)
      // Broadcaster rotated the channel we're watching: the SDK re-resolved behind the
      // same URL and HlsVideo remounts. Clear any prior playback error (that had
      // unmounted the video) so it re-mounts onto the fresh feed.
      if (m.type === 'feed-changed' && m.streamId === playingIdRef.current) setError(null)
    })
  }, [])

  useEffect(() => { if (playingId) lastStreamId = playingId }, [playingId])

  // First streams push after a cold navigation: start the hero channel.
  useEffect(() => {
    if (!playingId && streams.length) setPlayingId(pickHero(streams)?.id ?? streams[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams])

  // Browse overlay auto-hide.
  function clearMenuIdle () { if (menuIdle.current) { clearTimeout(menuIdle.current); menuIdle.current = null } }
  function bumpMenuIdle () {
    if (!listOpenRef.current) return
    clearMenuIdle()
    menuIdle.current = setTimeout(() => setListOpen(false), MENU_IDLE_MS)
  }
  useEffect(() => {
    if (listOpen) bumpMenuIdle()
    else clearMenuIdle()
    return clearMenuIdle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listOpen])

  const numbers = useMemo(() => channelNumbers(streams), [streams])
  // Browse list in curated order (the numbers' order) — Stage B scopes it by category.
  const list = useMemo(() => sortByCuration(streams), [streams])
  const playing = streams.find((s) => s.id === playingId) ?? null

  function play (s: Stream, { collapse = false }: { collapse?: boolean } = {}) {
    if (s.id !== playingId) {
      setPlayingId(s.id)
      setPeers(null)
      setError(null)
    } else if (error) {
      // The friendly tune-timeout says "switch to it again to retry" — honor
      // re-selecting the SAME channel: clearing the error remounts the video, which
      // starts a fresh tune.
      setError(null)
    }
    if (collapse) setListOpen(false)
  }

  // Fullscreen zap: prev/next over the LIVE catalog in curated order — the same
  // order the derived channel numbers follow, like a TV's CH+/CH-.
  function zap (dir: 1 | -1) {
    const all = zapOrder(streams)
    if (!all.length) return
    const i = all.findIndex((s) => s.id === playingId)
    const next = all[(i < 0 ? 0 : i + dir + all.length) % all.length]
    if (next) play(next)
  }

  // Tune lifecycle → tuning pill ('start' shows a FRESH pill; 'retune'/'reconnect'
  // relabel it while the SDK self-heals; 'playing' completes it).
  function onTune (e: TuneEvent) {
    if (e.phase === 'playing') setTuneUI((t) => (t && t.id === e.id ? { ...t, active: false } : t))
    else setTuneUI({ id: e.id, phase: e.phase === 'start' ? 'tuning' : e.phase, active: true })
  }

  // Fullscreen keys (the list owns the keyboard while open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (listOpenRef.current) return
      if (e.key === 'ArrowUp') { e.preventDefault(); zap(1) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); zap(-1) }
      else if (e.key === 'Enter') { e.preventDefault(); setListOpen(true) }
      else if (e.key === 'Escape') { e.preventDefault(); onExit() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams, playingId, error])

  if (!streams.length) {
    return <div className="section-loading"><span className="spinner" /><div>Waiting for the channel list…</div></div>
  }

  return (
    <div className="live">
      {playingId && !error && (
        <HlsVideo
          ref={videoHandle}
          backend={backend}
          streamId={playingId}
          onSource={(_url, s) => setSource(s)}
          onPeers={setPeers}
          onTune={onTune}
          onStall={() => console.log('[live] stall resync', playingIdRef.current)}
          onError={(msg) => { setError(msg); setTuneUI(null) }}
        />
      )}

      {/* Fullscreen surface: a click opens the channel list. */}
      {!listOpen && <div className="live-catcher" onClick={() => setListOpen(true)} />}

      {error && (
        <div className="live-error">
          <div className="live-error-title">Playback failed</div>
          <div className="live-error-msg">{error}</div>
          <div className="live-error-hint">Pick the channel again to retry (Enter opens the list).</div>
        </div>
      )}

      {listOpen && (
        <div className="live-panels" onMouseMove={bumpMenuIdle}>
          <ChannelList
            streams={list}
            numbers={numbers}
            playingId={playingId}
            favorites={backend.favorites}
            onSelect={(s) => play(s, { collapse: true })}
            onClose={() => setListOpen(false)}
            onActivity={bumpMenuIdle}
          />
        </div>
      )}

      {/* Peer/source badge — the P2P health line (verification surface for S35). */}
      {playing && source && (
        <div className="status-badge">
          <span className={source === 'p2p' ? 'src-p2p' : 'src-cdn'}>{source.toUpperCase()}</span>
          {source === 'p2p' && peers != null && <span className="badge-peers">{peers} peer{peers === 1 ? '' : 's'}</span>}
        </div>
      )}

      {tuneUI && (
        <TunePill
          key={tuneUI.id}
          active={tuneUI.active}
          phase={tuneUI.phase}
          number={playing ? numbers.get(playing.id) : undefined}
          title={playing?.title}
        />
      )}
    </div>
  )
}
