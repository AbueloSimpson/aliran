// Provider VOD playback (S53, design D3) — a fullscreen video surface over a URL
// the provider handed us. Desktop twin of client/src/screens/VodPlayerScreen.tsx.
//
// This screen deliberately does NOT go through <HlsVideo> or the engine: there is no
// feed, no peers, no localhost server and no tune lifecycle here. HlsVideo is built
// around the engine contract — it calls backend.play(streamId) and completes its
// tunes on 'port' replies — none of which exists for a provider URL. What it DOES do
// for m3u8 (attach hls.js to a <video>, retry a fatal network error with a remount)
// is small enough to restate here honestly: an .m3u8 URL gets hls.js, anything else
// (mp4/mkv) goes straight to Chromium's own decoder. Live TV keeps HlsVideo, and its
// self-heal ladder, entirely to itself.
//
// The transport mirrors the NowPlayingBar vod row — play/pause, elapsed / runtime and
// a scrubbable seek bar, reusing its classes — but is fed by this <video>'s own
// events instead of the engine's port reply. Esc goes back to the grid; Space
// toggles play; `c` opens the track menu (the LiveScreen key).
//
// A playback failure shows a plain sentence. The viewer never sees a media code.
//
// S54d adds two things that are NOT about the picture:
//   - DEVICE-LOCAL watch history (D9). When the caller names the title (id + kind, plus
//     seriesId for an episode) this screen remembers where the viewer got to — throttled
//     to one prefs message per HISTORY_STEP_SEC of progress, flushed when the screen goes
//     away, and NEVER on the playback path: a failed prefs write must not stop a film.
//     A title watched past WATCHED_FRACTION stores position 0 — "seen it, start again".
//   - Subtitle + audio track selection (D7), the same machinery the live player uses:
//     hls.js reports the tracks it found in the master playlist, the app renders its own
//     TrackMenu, and selection is by flat index (reliable in hls.js). A progressive file
//     played by Chromium directly has no such tracks — the CC button is gated on the
//     counts, so that branch simply never shows one.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Hls from 'hls.js'
import { backend } from '../bridge'
import { formatDuration } from '../catalog'
import { TrackMenu } from '../components/TrackMenu'
import { trackList, type MediaTrack } from '../components/HlsVideo'
import { VolumeControl, loadVolume, saveVolume } from '../components/VolumeControl'
import type { VodHistoryEntry } from '../types'

/** Seconds of playback between two history writes. Main rewrites the whole prefs file
 *  per message, so a per-second write would hammer the disk for a two-hour film. */
export const HISTORY_STEP_SEC = 10
/** Past this much of the runtime a title counts as watched — its stored position becomes
 *  0 so the next "Start" plays it from the top instead of the closing credits. */
export const WATCHED_FRACTION = 0.95
/** The transport fades away this long after it appears / the last activity, for an
 *  unobstructed picture — the live bar's timing (QA round 2). Paused keeps it up. */
export const BAR_IDLE_MS = 5000
/** The mouse cursor hides over clean video after this idle (the live rule). */
export const CURSOR_IDLE_MS = 3000
/** The two skip sizes, mirrored around play/pause: ⟲30 ⟲10 ▶ ⟳10 ⟳30. */
export const SKIP_STEPS = [10, 30] as const

export function VodPlayerScreen ({ url, title, durationSec, id, kind, seriesId, resumeSec, onBack }: {
  url: string
  title: string
  durationSec: number | null
  /** Provider id of the movie or episode — absent = play it, remember nothing (D9). */
  id?: string
  kind?: 'movie' | 'episode'
  /** The parent series, for an episode: its history entry is credited to the series. */
  seriesId?: string
  /** Where this device left off, in seconds — seeked to once, on load. */
  resumeSec?: number
  onBack: () => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [paused, setPaused] = useState(false)
  const [position, setPosition] = useState(0)
  // Runtime: whatever the provider stated until the player reports the real one.
  const [duration, setDuration] = useState(durationSec ?? 0)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  // Subtitle/CC + audio tracks hls.js found in THIS title, plus the current picks
  // (subtitles off, audio = the stream's default). Session-local: a track choice is not
  // a preference, it belongs to the title being watched (D7).
  const [audioTracks, setAudioTracks] = useState<MediaTrack[]>([])
  const [textTracks, setTextTracks] = useState<MediaTrack[]>([])
  const [selectedText, setSelectedText] = useState(-1)
  const [selectedAudio, setSelectedAudio] = useState<number | undefined>(undefined)
  const [showTracks, setShowTracks] = useState(false)

  // In-app volume (QA round 3): applied straight to the <video>, persisted in
  // localStorage (shared with the live player).
  const [{ volume, muted }, setVol] = useState(loadVolume)
  const volRef = useRef({ volume, muted }); volRef.current = { volume, muted }
  function setVolume (v: number, m: boolean) { setVol({ volume: v, muted: m }); saveVolume(v, m); showBar() }
  useEffect(() => {
    const v = videoRef.current
    if (v) { v.volume = Math.max(0, Math.min(1, volume)); v.muted = muted }
  }, [volume, muted, url, loading])

  // --- transport auto-hide (QA round 2) — the live screen's fade + cursor hide -----
  const [barShown, setBarShown] = useState(true)
  const [cursorHidden, setCursorHidden] = useState(false)
  const barIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pausedRef = useRef(false); pausedRef.current = paused
  const tracksOpenRef = useRef(false); tracksOpenRef.current = showTracks

  function clearBarIdle () { if (barIdle.current) { clearTimeout(barIdle.current); barIdle.current = null } }
  function showBar () {
    clearBarIdle()
    setBarShown(true)
    // A paused title (or an open track menu) keeps the bar — and its play control — up.
    if (pausedRef.current || tracksOpenRef.current) return
    barIdle.current = setTimeout(() => setBarShown(false), BAR_IDLE_MS)
  }
  // Cursor hide over clean video; any mouse move reveals bar + cursor.
  function pokeCursor () {
    setCursorHidden(false)
    if (cursorIdle.current) clearTimeout(cursorIdle.current)
    cursorIdle.current = setTimeout(() => { if (!tracksOpenRef.current) setCursorHidden(true) }, CURSOR_IDLE_MS)
  }
  useEffect(() => {
    if (paused || showTracks) { clearBarIdle(); setBarShown(true) } else showBar()
  }, [paused, showTracks])
  useEffect(() => () => { clearBarIdle(); if (cursorIdle.current) clearTimeout(cursorIdle.current) }, [])

  // --- device-local watch history (D9) ---------------------------------------------
  // Only a NAMED title is remembered; a caller that hands over just a url plays without
  // leaving a trace (which is also the escape hatch for anything that must not be).
  const tracked = useMemo(
    () => (id && (kind === 'movie' || kind === 'episode') ? { id, kind } : null),
    [id, kind]
  )
  // Playback state the throttle and the flush read WITHOUT re-rendering. `written` is the
  // playhead at the last write and starts at 0 — the top of the title — so a fresh start
  // costs no write for its first step, while a RESUMED one (which lands far from 0) is
  // recorded straight away.
  const progress = useRef({ position: 0, duration: durationSec ?? 0, written: 0 })

  const writeHistory = useCallback((atSec: number, runtime: number) => {
    if (!tracked) return
    progress.current.written = atSec
    const done = runtime > 0 && atSec >= runtime * WATCHED_FRACTION
    const entry: VodHistoryEntry = {
      kind: tracked.kind,
      id: tracked.id,
      ...(seriesId ? { seriesId } : {}),
      title,
      positionSec: done ? 0 : Math.max(0, Math.floor(atSec)),
      durationSec: Math.max(0, Math.floor(runtime)),
      at: Date.now()
    }
    // Whole-array replace, newest first, one entry per title (main gates and caps what it
    // stores — the 'prefs' reply is the truth, and nothing here waits for it).
    const rest = (backend.vodHistory || []).filter((e) => !(e && e.kind === entry.kind && e.id === entry.id))
    try { backend.setVodPrefs({ history: [entry, ...rest] }) } catch { /* prefs must never break playback */ }
  }, [tracked, seriesId, title])

  // The player effect below is keyed on [url] and must not be re-armed every time a
  // callback identity changes — so its handlers reach the LATEST writer through a ref.
  const write = useRef(writeHistory); write.current = writeHistory

  // Flushing happens from an unmount cleanup, which must not re-run either.
  const flush = useRef<() => void>(() => {})
  flush.current = () => {
    const p = progress.current
    if (!tracked || p.position <= 0) return
    if (Math.floor(p.position) === Math.floor(p.written)) return // already stored
    writeHistory(p.position, p.duration)
  }
  useEffect(() => () => { flush.current() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showTracks) return // TrackMenu captures its own keys
      if (e.key === 'Escape') { e.preventDefault(); onBack() }
      else if (e.key === ' ') { e.preventDefault(); togglePause(); showBar() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(30); showBar() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-10); showBar() }
      else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); setVolume(volRef.current.volume, !volRef.current.muted) }
      else if ((e.key === 'c' || e.key === 'C') && (textTracks.length > 0 || audioTracks.length > 1)) { e.preventDefault(); setShowTracks(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // No dep array on purpose: the handler reads the current playhead and runtime,
    // and re-arming one listener per render is cheaper than threading refs through.
  })

  // One player per URL. An .m3u8 goes through hls.js (Chromium has no native HLS);
  // a progressive file plays natively.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !url) return
    setLoading(true); setFailed(false); setPosition(0)
    setAudioTracks([]); setTextTracks([]); setSelectedText(-1); setSelectedAudio(undefined); setShowTracks(false)
    progress.current = { position: 0, duration: durationSec ?? 0, written: 0 }

    const onTime = () => {
      const t = video.currentTime
      setPosition(Math.floor(t))
      progress.current.position = t
      if (Math.abs(t - progress.current.written) >= HISTORY_STEP_SEC) {
        write.current(t, progress.current.duration)
      }
    }
    const onMeta = () => {
      if (isFinite(video.duration) && video.duration > 0) { setDuration(video.duration); progress.current.duration = video.duration }
      // Resume, once: the caller said where this device left off (D9). A stored position
      // is always mid-title (a finished one is stored as 0), so there is nothing to guard
      // against here beyond seeking twice.
      if (resumeSec && resumeSec > 0 && progress.current.position <= 0) {
        video.currentTime = resumeSec
        setPosition(Math.floor(resumeSec))
        progress.current.position = resumeSec
      }
    }
    const onPlaying = () => setLoading(false)
    const onEnded = () => {
      setPaused(true)
      // Ran to the end: stored as watched (position 0), not as "1 second left".
      write.current(progress.current.duration, progress.current.duration)
    }
    const onNativeError = () => { setLoading(false); setFailed(true) }
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('ended', onEnded)

    let hls: Hls | null = null
    if (/\.m3u8(\?|$)/i.test(url) && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30 })
      hlsRef.current = hls
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}) })
      // The master playlist's EXT-X-MEDIA groups — what track selection exposes (D7).
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => setAudioTracks(trackList(hls!.audioTracks)))
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => setTextTracks(trackList(hls!.subtitleTracks)))
      hls.on(Hls.Events.ERROR, (_ev, data) => {
        // A provider title is a fixed asset: there is no live edge to catch up with,
        // so a fatal error is a dead end rather than something to retry into.
        if (data.fatal) { setLoading(false); setFailed(true) }
      })
      hls.loadSource(url)
      hls.attachMedia(video)
    } else {
      video.addEventListener('error', onNativeError)
      video.src = url
      video.play().catch(() => {})
    }
    return () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('error', onNativeError)
      if (hls) { hls.destroy(); if (hlsRef.current === hls) hlsRef.current = null }
      else { video.removeAttribute('src'); video.load() }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // In-stream track selection (the HlsVideo pattern). hls.js uses flat indexes
  // consistently, so index selection is reliable.
  useEffect(() => {
    const hls = hlsRef.current
    if (!hls) return
    if (typeof selectedAudio === 'number' && selectedAudio >= 0 && selectedAudio < hls.audioTracks.length) hls.audioTrack = selectedAudio
  }, [selectedAudio, url])
  useEffect(() => {
    const hls = hlsRef.current
    if (!hls) return
    hls.subtitleDisplay = selectedText >= 0
    hls.subtitleTrack = selectedText >= 0 && selectedText < hls.subtitleTracks.length ? selectedText : -1
  }, [selectedText, url])

  function seek (seconds: number) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = seconds
    // Optimistic playhead: while paused no timeupdate confirms the jump, and the bar
    // must not snap back under the pointer.
    setPosition(Math.floor(seconds))
    progress.current.position = seconds
  }

  function nudge (delta: number) {
    const v = videoRef.current
    if (!v || !isFinite(v.currentTime)) return
    seek(Math.max(0, duration > 0 ? Math.min(duration, v.currentTime + delta) : v.currentTime + delta))
  }

  function togglePause () {
    const v = videoRef.current
    if (!v || failed) return
    if (v.paused) {
      // Play on a finished title replays from the top.
      if (duration > 0 && position >= Math.floor(duration) - 1) seek(0)
      v.play().catch(() => {})
      setPaused(false)
    } else {
      v.pause()
      setPaused(true)
    }
  }

  // The tracks (⋮) button follows the live bar's rule: subtitles OR a real audio choice.
  const hasTracks = textTracks.length > 0 || audioTracks.length > 1

  return (
    <div
      className={'vod-player' + (cursorHidden && !showTracks ? ' cursor-hidden' : '')}
      onMouseMove={() => { pokeCursor(); showBar() }}
      onClick={(e) => {
        // A click on clean video (not on a control) toggles the transport.
        if (e.target === videoRef.current) { if (barShown) { clearBarIdle(); setBarShown(false) } else showBar() }
      }}
    >
      <video ref={videoRef} className="video-surface" autoPlay />

      {loading && !failed && (
        <div className="empty-center vod-player-center">
          <span className="spinner" />
          <div className="empty-hint">Starting {title}…</div>
        </div>
      )}

      {failed && (
        <div className="empty-center vod-player-center">
          <div className="empty-title">This title won't play</div>
          <div className="empty-hint">The movie catalog couldn't deliver it right now. Try another title, or come back later.</div>
        </div>
      )}

      {/* The live screen's chrome fade wraps the bar — same class, same 0.3s ease. */}
      {!failed && (
        <div className={'live-chrome' + (barShown ? '' : ' hidden')}>
          <div className="nowplaying">
            <div className="np-info">
              <span className="np-main">
                <span className="np-title-line"><span className="np-title">{title}</span></span>
              </span>
              <VolumeControl volume={volume} muted={muted} onChange={setVolume} />
              {hasTracks && (
                <button className="np-btn" onClick={() => { setShowTracks(true); showBar() }}><span className="np-btn-glyph">⋮</span><span className="np-btn-label">Audio & subtitles</span></button>
              )}
              <button className="np-btn" onClick={onBack}><span className="np-btn-glyph">↩</span><span className="np-btn-label">Back</span></button>
            </div>
            <div className="np-transport">
              <SeekBar position={position} duration={duration} onSeek={(s) => { seek(s); showBar() }} />
            </div>
            {/* The skip cluster, centered under the progress bar (QA round 2):
                ⟲30 ⟲10 ▶ ⟳10 ⟳30. Arrow keys keep their ±30/−10 behavior. */}
            <div className="np-skip-row">
              <button className="np-play np-skip" title={`Back ${SKIP_STEPS[1]} seconds`} onClick={() => { nudge(-SKIP_STEPS[1]); showBar() }}>{`↺${SKIP_STEPS[1]}`}</button>
              <button className="np-play np-skip" title={`Back ${SKIP_STEPS[0]} seconds`} onClick={() => { nudge(-SKIP_STEPS[0]); showBar() }}>{`↺${SKIP_STEPS[0]}`}</button>
              <button className="np-play" onClick={() => { togglePause(); showBar() }}>{paused ? '▶' : '❚❚'}</button>
              <button className="np-play np-skip" title={`Forward ${SKIP_STEPS[0]} seconds`} onClick={() => { nudge(SKIP_STEPS[0]); showBar() }}>{`↻${SKIP_STEPS[0]}`}</button>
              <button className="np-play np-skip" title={`Forward ${SKIP_STEPS[1]} seconds`} onClick={() => { nudge(SKIP_STEPS[1]); showBar() }}>{`↻${SKIP_STEPS[1]}`}</button>
            </div>
          </div>
        </div>
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

// The NowPlayingBar seek bar, fed by this screen's <video>: press/drag previews the
// target on the fill and the elapsed label, release seeks. (NowPlayingBar's copy is
// private to that component and wired to the engine's transport props.)
function SeekBar ({ position, duration, onSeek }: { position: number; duration: number; onSeek: (seconds: number) => void }) {
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
    if (duration > 0) onSeek(f * duration)
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
