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
// toggles play.
//
// A playback failure shows a plain sentence. The viewer never sees a media code.

import React, { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { formatDuration } from '../catalog'

export function VodPlayerScreen ({ url, title, durationSec, onBack }: {
  url: string
  title: string
  durationSec: number | null
  onBack: () => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [paused, setPaused] = useState(false)
  const [position, setPosition] = useState(0)
  // Runtime: whatever the provider stated until the player reports the real one.
  const [duration, setDuration] = useState(durationSec ?? 0)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onBack() }
      else if (e.key === ' ') { e.preventDefault(); togglePause() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(30) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-10) }
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

    const onTime = () => setPosition(Math.floor(video.currentTime))
    const onMeta = () => { if (isFinite(video.duration) && video.duration > 0) setDuration(video.duration) }
    const onPlaying = () => setLoading(false)
    const onEnded = () => setPaused(true)
    const onNativeError = () => { setLoading(false); setFailed(true) }
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('ended', onEnded)

    let hls: Hls | null = null
    if (/\.m3u8(\?|$)/i.test(url) && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30 })
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}) })
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
      if (hls) hls.destroy()
      else { video.removeAttribute('src'); video.load() }
    }
  }, [url])

  function seek (seconds: number) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = seconds
    // Optimistic playhead: while paused no timeupdate confirms the jump, and the bar
    // must not snap back under the pointer.
    setPosition(Math.floor(seconds))
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

  return (
    <div className="vod-player">
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

      {!failed && (
        <div className="nowplaying">
          <div className="np-info">
            <span className="np-main">
              <span className="np-title-line"><span className="np-title">{title}</span></span>
            </span>
            <button className="np-btn" onClick={onBack}><span className="np-btn-glyph">↩</span><span className="np-btn-label">Back</span></button>
          </div>
          <div className="np-transport">
            <button className="np-play" onClick={togglePause}>{paused ? '▶' : '❚❚'}</button>
            <SeekBar position={position} duration={duration} onSeek={seek} />
          </div>
        </div>
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
