// Live TV — ONE fullscreen video surface with overlay panels (the S18
// reorganization, ported from the phone app): playback never stops while browsing;
// selecting a row switches the stream in place. Overlays:
//   overlay 'list': CategoryRail + ChannelList — the browse & zap surface. No manual
//                   close control: it auto-hides after idle; Esc collapses it.
//   overlay 'info': ChannelInfoPanel — channel detail with the EPG now/next guide.
// Over fullscreen video a NowPlayingBar (number/logo/EPG-now/clock + mouse buttons)
// fades in on activity and out after idle; the top-right TunePill shows switch
// progress driven SOLELY by <HlsVideo>'s onTune lifecycle (raw player events also
// fire for the PREVIOUS channel under the shared localhost URL — the S22 lesson).
//
// Keyboard model (the D-pad patterns on desktop keys):
//   fullscreen : ↑/↓ zap over the whole curated order · Enter/click channel list
//                · i info · f favorite · c subtitles/audio · Esc → Menu
//   list open  : ↑/↓ rows · ←/→ rail↔list · Enter watch · i info · Esc unwinds
//                (sub-category → parent → top rail → close), mirroring BACK on TV
//   info open  : Enter watch · f favorite · Esc back to the list
//
// VOD (S8a): library titles play on this same surface — the bar grows a seek/pause
// transport, the stall ladder disarms engine-side (recordType), and CH+/CH- stays a
// live-only ring: zapping from a title lands on channel 001.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { backend } from '../bridge'
import type { Stream } from '../types'
import { channelNumbers, categoryModel, isVod, pickHero, splitCategory, subLabel, zapOrder } from '../catalog'
import { HlsVideo, type HlsVideoHandle, type MediaTrack, type TuneEvent } from '../components/HlsVideo'
import { TunePill, type TunePillPhase } from '../components/TunePill'
import { ChannelList } from '../components/ChannelList'
import { CategoryRail } from '../components/CategoryRail'
import { ChannelInfoPanel } from '../components/ChannelInfoPanel'
import { NowPlayingBar } from '../components/NowPlayingBar'
import { TrackMenu } from '../components/TrackMenu'

type Overlay = 'none' | 'list' | 'info'

// The browse overlay auto-hides this long after the last interaction.
const MENU_IDLE_MS = 6000
// The bottom bar fades this long after it appears / the last activity.
const BAR_IDLE_MS = 5000
// The mouse cursor hides over clean fullscreen video after this idle.
const CURSOR_IDLE_MS = 3000

// Last channel watched THIS session (module-level: survives leaving Live for the
// Menu and back — re-entering resumes it instead of the hero pick).
let lastStreamId: string | null = null

function clockText (d: Date) {
  const h = d.getHours(); const m = d.getMinutes()
  return `${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}`
}

export function LiveScreen ({ onExit, initialStreamId }: { onExit: () => void; initialStreamId?: string }) {
  const [streams, setStreams] = useState<Stream[]>(backend.streams)
  const [favorites, setFavorites] = useState<string[]>(backend.favorites)
  const [playingId, setPlayingId] = useState<string | null>(() => initialStreamId ?? lastStreamId ?? pickHero(backend.streams)?.id ?? null)
  const [overlay, setOverlay] = useState<Overlay>(() => ((initialStreamId ?? lastStreamId) ? 'none' : 'list'))
  const [infoStream, setInfoStream] = useState<Stream | null>(null)
  // Two-level category browse: `selected` is the group key whose channels show;
  // `drillParent` is the parent whose sub-categories the rail currently shows.
  const [selected, setSelected] = useState('All')
  const [drillParent, setDrillParent] = useState<string | null>(null)
  // Which pane owns ↑/↓ while the browse overlay is open.
  const [pane, setPane] = useState<'rail' | 'list'>('list')
  const [railFocus, setRailFocus] = useState(0)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tuneUI, setTuneUI] = useState<{ id: number; phase: TunePillPhase; active: boolean } | null>(null)
  const [now, setNow] = useState(() => new Date())
  // In-stream tracks of the CURRENT channel + the picks (subtitles default Off,
  // audio = player default). Reset on channel change — a new stream's tracks differ.
  const [audioTracks, setAudioTracks] = useState<MediaTrack[]>([])
  const [textTracks, setTextTracks] = useState<MediaTrack[]>([])
  const [selectedText, setSelectedText] = useState(-1)
  const [selectedAudio, setSelectedAudio] = useState<number | undefined>(undefined)
  const [showTracks, setShowTracks] = useState(false)
  // Bottom bar + cursor idle.
  const [barShown, setBarShown] = useState(true)
  const [cursorHidden, setCursorHidden] = useState(false)
  // vod transport (S8a): playhead (whole seconds), runtime (player-reported on load,
  // catalog durationSec until then), app-owned pause.
  const [vodPos, setVodPos] = useState(0)
  const [vodDur, setVodDur] = useState(0)
  const [vodPaused, setVodPausedState] = useState(false)
  const vodPausedRef = useRef(false)
  function setVodPaused (v: boolean) { vodPausedRef.current = v; setVodPausedState(v) }

  const videoHandle = useRef<HlsVideoHandle | null>(null)
  const menuIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const barIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overlayRef = useRef(overlay); overlayRef.current = overlay
  const playingIdRef = useRef(playingId); playingIdRef.current = playingId
  const paneRef = useRef(pane); paneRef.current = pane
  const drillRef = useRef(drillParent); drillRef.current = drillParent
  const selectedRef = useRef(selected); selectedRef.current = selected

  useEffect(() => {
    backend.requestPrefs()
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(m.streams)
      if (m.type === 'prefs') setFavorites(m.favorites)
      // Broadcaster rotated the channel we're watching: the SDK re-resolved behind
      // the same URL and HlsVideo remounts. Clear any prior playback error (that had
      // unmounted the video) so it re-mounts onto the fresh feed.
      if (m.type === 'feed-changed' && m.streamId === playingIdRef.current) setError(null)
    })
  }, [])

  useEffect(() => { if (playingId) lastStreamId = playingId }, [playingId])

  // A new channel has different tracks — clear the picker state; the vod transport
  // resets with them (re-enter cleanly: unpaused, playhead 0, runtime from the
  // record's catalog durationSec until the player reports the real one).
  useEffect(() => {
    setAudioTracks([]); setTextTracks([])
    setSelectedText(-1); setSelectedAudio(undefined)
    setShowTracks(false)
    setVodPaused(false); setVodPos(0)
    const s = backend.streams.find((x) => x.id === playingId)
    setVodDur(s && isVod(s) ? s.durationSec ?? 0 : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingId])

  // Wall clock for the bottom bar.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(t)
  }, [])

  // --- idle timers (browse overlay, bottom bar, cursor) ---

  function clearMenuIdle () { if (menuIdle.current) { clearTimeout(menuIdle.current); menuIdle.current = null } }
  function bumpMenuIdle () {
    if (overlayRef.current !== 'list') return
    clearMenuIdle()
    menuIdle.current = setTimeout(() => setOverlay('none'), MENU_IDLE_MS)
  }
  useEffect(() => {
    if (overlay === 'list') bumpMenuIdle()
    else clearMenuIdle()
    return clearMenuIdle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay])

  function clearBarIdle () { if (barIdle.current) { clearTimeout(barIdle.current); barIdle.current = null } }
  function showBar () {
    clearBarIdle()
    setBarShown(true)
    if (vodPausedRef.current) return // paused vod: the bar (and its play control) stays up
    barIdle.current = setTimeout(() => setBarShown(false), BAR_IDLE_MS)
  }
  useEffect(() => {
    if (overlay === 'none') showBar()
    else clearBarIdle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, playingId, vodPaused])
  useEffect(() => clearBarIdle, [])

  // Cursor hide over clean fullscreen video; any mouse move reveals bar + cursor.
  function pokeCursor () {
    setCursorHidden(false)
    if (cursorIdle.current) clearTimeout(cursorIdle.current)
    cursorIdle.current = setTimeout(() => { if (overlayRef.current === 'none') setCursorHidden(true) }, CURSOR_IDLE_MS)
  }
  useEffect(() => () => { if (cursorIdle.current) clearTimeout(cursorIdle.current) }, [])

  // --- catalog shaping ---

  const numbers = useMemo(() => channelNumbers(streams), [streams])
  const model = useMemo(() => categoryModel(streams), [streams])
  const activeKey = model.groups[selected] ? selected : 'All'
  const list = model.groups[activeKey] ?? []
  const inDrill = drillParent != null && (model.subs[drillParent]?.length ?? 0) > 0
  const railItems = inDrill
    ? model.subs[drillParent!].map((key) => ({ key, label: subLabel(key) }))
    : model.top.map((key) => ({ key, label: key, hasChildren: (model.subs[key]?.length ?? 0) > 0 }))
  const railSelected = inDrill ? activeKey : splitCategory(activeKey)[0]
  const listHeading = activeKey === 'All' ? 'CHANNELS' : splitCategory(activeKey).filter((x): x is string => !!x).map((x) => x.toUpperCase()).join('  ›  ')
  const playing = streams.find((s) => s.id === playingId) ?? null
  const playingVod = !!playing && isVod(playing)

  // First streams push after a cold navigation: start the hero channel.
  useEffect(() => {
    if (!playingId && streams.length) setPlayingId(pickHero(streams)?.id ?? streams[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams])

  function play (s: Stream, { collapse = false }: { collapse?: boolean } = {}) {
    if (s.id !== playingId) {
      setPlayingId(s.id)
      setPeers(null)
      setError(null)
    } else if (error) {
      // The friendly tune-timeout says "switch to it again to retry" — honor
      // re-selecting the SAME channel: clearing the error remounts the video.
      setError(null)
    }
    if (collapse) setOverlay('none')
  }

  // Rail pick. Top-level: a parent WITH subs drills in; a leaf just scopes the list.
  // Drilled: a sub scopes; re-picking the selected sub deselects (back to the whole
  // parent). Any pick shows the channel LIST.
  function selectRail (key: string) {
    if (drillParent == null) {
      if ((model.subs[key]?.length ?? 0) > 0) { setDrillParent(key); setSelected(key) }
      else setSelected(key)
    } else {
      setSelected(key === selected ? drillParent : key)
    }
    setOverlay('list')
  }

  function exitDrill () {
    if (drillParent != null) setSelected(drillParent)
    setDrillParent(null)
    setOverlay('list')
  }

  // Fullscreen zap over the LIVE catalog in curated order (the numbers' order).
  function zap (dir: 1 | -1) {
    const all = zapOrder(streams)
    if (!all.length) return
    const i = all.findIndex((s) => s.id === playingId)
    const next = all[(i < 0 ? 0 : i + dir + all.length) % all.length]
    if (next) play(next)
  }

  function onTune (e: TuneEvent) {
    if (e.phase === 'playing') setTuneUI((t) => (t && t.id === e.id ? { ...t, active: false } : t))
    else setTuneUI({ id: e.id, phase: e.phase === 'start' ? 'tuning' : e.phase, active: true })
  }

  function openInfo (s: Stream) { setInfoStream(s); setOverlay('info') }

  // BACK semantics (Esc), mirroring the TV app: info → list; list unwinds the
  // category drill before closing; fullscreen exits to Menu.
  function overlayBack () {
    if (overlayRef.current === 'info') { setOverlay('list'); return }
    if (drillRef.current != null && selectedRef.current !== drillRef.current) { setSelected(drillRef.current); return }
    if (drillRef.current != null) { setDrillParent(null); return }
    setOverlay('none')
  }

  // --- keyboard: fullscreen + rail + info (ChannelList owns its rows itself) ---

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showTracks) return // TrackMenu captures its own keys
      const ov = overlayRef.current
      if (ov === 'none') {
        if (e.key === 'ArrowUp') { e.preventDefault(); zap(1); showBar() }
        else if (e.key === 'ArrowDown') { e.preventDefault(); zap(-1); showBar() }
        else if (e.key === 'Enter') { e.preventDefault(); setPane('list'); setOverlay('list') }
        else if (e.key === 'Escape') { e.preventDefault(); onExit() }
        else if ((e.key === 'i' || e.key === 'I') && playing) { e.preventDefault(); openInfo(playing) }
        else if ((e.key === 'f' || e.key === 'F') && playing) { e.preventDefault(); backend.toggleFavorite(playing.id); showBar() }
        else if ((e.key === 'c' || e.key === 'C') && (textTracks.length > 0 || audioTracks.length > 1)) { e.preventDefault(); setShowTracks(true) }
        else if (e.key === ' ' && playingVod) { e.preventDefault(); toggleVodPause() }
      } else if (ov === 'list' && paneRef.current === 'rail') {
        if (e.key === 'ArrowDown') { e.preventDefault(); bumpMenuIdle(); setRailFocus((i) => Math.min(railItems.length - 1, i + 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); bumpMenuIdle(); setRailFocus((i) => Math.max(0, i - 1)) }
        else if (e.key === 'Enter') { e.preventDefault(); bumpMenuIdle(); const it = railItems[railFocus]; if (it) selectRail(it.key) }
        else if (e.key === 'ArrowRight') { e.preventDefault(); bumpMenuIdle(); setPane('list') }
        else if (e.key === 'Escape') { e.preventDefault(); overlayBack() }
      } else if (ov === 'info') {
        if (e.key === 'Escape') { e.preventDefault(); overlayBack() }
        else if (e.key === 'Enter' && infoStream) { e.preventDefault(); play(streams.find((s) => s.id === infoStream.id) ?? infoStream, { collapse: true }) }
        else if ((e.key === 'f' || e.key === 'F') && infoStream) { e.preventDefault(); backend.toggleFavorite(infoStream.id) }
      }
      // ov === 'list' && pane 'list': ChannelList's own listener handles it, except ←:
      if (ov === 'list' && paneRef.current === 'list' && e.key === 'ArrowLeft') { e.preventDefault(); bumpMenuIdle(); setPane('rail') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams, playingId, error, railItems, railFocus, infoStream, showTracks, textTracks, audioTracks, playingVod, playing])

  function toggleVodPause () {
    // ▶ on a finished title replays from the top (unpausing at the end is a no-op —
    // the player is already "ended").
    if (vodPausedRef.current && vodDur > 0 && vodPos >= Math.floor(vodDur) - 1) { videoHandle.current?.seek(0); setVodPos(0) }
    setVodPaused(!vodPausedRef.current)
    showBar()
  }

  if (!streams.length) {
    return <div className="section-loading"><span className="spinner" /><div>Waiting for the channel list…</div></div>
  }

  return (
    <div className={'live' + (cursorHidden && overlay === 'none' ? ' cursor-hidden' : '')} onMouseMove={() => { pokeCursor(); if (overlayRef.current === 'none') showBar() }}>
      {playingId && !error && (
        <HlsVideo
          ref={videoHandle}
          backend={backend}
          streamId={playingId}
          paused={playingVod && vodPaused}
          onSource={(_url, s) => setSource(s)}
          onPeers={setPeers}
          onTune={onTune}
          onStall={() => console.log('[live] stall resync', playingIdRef.current)}
          onError={(msg) => { setError(msg); setTuneUI(null) }}
          onAudioTracks={setAudioTracks}
          onTextTracks={setTextTracks}
          selectedAudio={selectedAudio}
          selectedText={selectedText}
          // vod transport feed: playhead (one update/second via Math.floor), the
          // player-reported runtime, end-of-title parking the transport on ▶.
          onProgress={playingVod ? setVodPos : undefined}
          onDuration={playingVod ? ((d) => { if (d > 0) setVodDur(d) }) : undefined}
          onEnded={playingVod ? (() => { setVodPaused(true); showBar() }) : undefined}
        />
      )}

      {/* Fullscreen surface: a click opens the channel list. */}
      {overlay === 'none' && <div className="live-catcher" onClick={() => { setPane('list'); setOverlay('list') }} />}

      {error && (
        <div className="live-error">
          <div className="live-error-title">Playback failed</div>
          <div className="live-error-msg">{error}</div>
          <div className="live-error-hint">Pick the channel again to retry (Enter opens the list).</div>
        </div>
      )}

      {overlay !== 'none' && (
        <div className="live-panels" onMouseMove={bumpMenuIdle}>
          <CategoryRail
            items={railItems}
            selected={railSelected}
            focusIndex={pane === 'rail' && overlay === 'list' ? railFocus : -1}
            parentHeader={inDrill ? { label: drillParent!, onBack: exitDrill } : undefined}
            onSelect={selectRail}
            onActivity={bumpMenuIdle}
          />
          {overlay === 'list' ? (
            <ChannelList
              streams={list}
              heading={listHeading}
              numbers={numbers}
              playingId={playingId}
              favorites={favorites}
              active={pane === 'list'}
              onSelect={(s) => play(s, { collapse: true })}
              onInfo={openInfo}
              onClose={overlayBack}
              onActivity={bumpMenuIdle}
            />
          ) : (
            infoStream && (
              <ChannelInfoPanel
                stream={streams.find((s) => s.id === infoStream.id) ?? infoStream}
                number={numbers.get(infoStream.id)}
                favorite={favorites.includes(infoStream.id)}
                playing={infoStream.id === playingId}
                source={source}
                peers={peers}
                onWatch={() => play(streams.find((s) => s.id === infoStream.id) ?? infoStream, { collapse: true })}
                onToggleFavorite={() => backend.toggleFavorite(infoStream.id)}
              />
            )
          )}
        </div>
      )}

      {/* Bottom bar + status badge — fullscreen chrome, fades after idle. */}
      {overlay === 'none' && playing && (
        <div className={'live-chrome' + (barShown ? '' : ' hidden')}>
          <NowPlayingBar
            stream={playing}
            number={numbers.get(playing.id)}
            clock={clockText(now)}
            favorite={favorites.includes(playing.id)}
            onChannels={() => { setPane('list'); setOverlay('list') }}
            onInfo={() => openInfo(playing)}
            onToggleFavorite={() => { showBar(); backend.toggleFavorite(playing.id) }}
            hasTracks={textTracks.length > 0 || audioTracks.length > 1}
            onTracks={() => { showBar(); setShowTracks(true) }}
            vod={playingVod ? { position: vodPos, duration: vodDur, paused: vodPaused } : null}
            onTogglePause={toggleVodPause}
            onSeek={(sec) => {
              videoHandle.current?.seek(sec)
              // Optimistic playhead: while paused no progress event will confirm the
              // jump, and the bar must not snap back under the pointer.
              setVodPos(Math.floor(sec))
              showBar()
            }}
          />
          {source && (
            <div className="status-badge">
              <span className={source === 'p2p' ? 'src-p2p' : 'src-cdn'}>{source.toUpperCase()}</span>
              {source === 'p2p' && peers != null && <span className="badge-peers">{peers} peer{peers === 1 ? '' : 's'}</span>}
            </div>
          )}
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

      {showTracks && (
        <TrackMenu
          textTracks={textTracks}
          audioTracks={audioTracks}
          selectedText={selectedText}
          selectedAudio={selectedAudio}
          onSelectText={setSelectedText}
          onSelectAudio={setSelectedAudio}
          onClose={() => setShowTracks(false)}
        />
      )}
    </div>
  )
}
