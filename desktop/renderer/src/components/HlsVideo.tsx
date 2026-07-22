// <HlsVideo> — the desktop port of @aliran/react-native's <AliranVideo>: P2P
// localhost HLS and redirect-channel URLs on hls.js/MSE over one <video>. Chrome-free;
// overlays belong to the host via callbacks. The playback contracts are the RN
// component's, reimplemented for hls.js (see sdk/react-native/src/AliranVideo.tsx —
// the S22-proven behaviors):
//
// TUNE LIFECYCLE (onTune): ONE localhost URL serves every P2P channel, so raw player
// events are useless as a "channel switch finished" signal — after a zap the OLD
// channel keeps playing (and firing timeupdate) under the same URL until the engine
// flips the served feed. Each switch is a TUNE with a monotonic id:
//   'start'      new channel (streamId change / mount) or a stall resync began;
//   'retune'/'reconnect'  the engine's self-heal cycle (show "reconnecting");
//   'playing'    first real playback of THIS tune — the engine confirmed the URL
//                serves this stream (the 'port' reply, remounting if the channel
//                changed) AND the current mount produced advancing playback.
// Completion is mount-scoped (epoch guard): events still held by an outgoing hls
// instance can neither finish a tune nor feed the stall watchdog.
//
// SELF-HEAL LADDER: a live HLS window can be tiny (16 s on the reference deploy), so
// a network blip longer than the window slides it past the playhead — no error fires,
// the picture just freezes. Once a mount has played, a playhead still for
// stallTimeoutMs (while not paused) forces a remount at the live edge; if the resync
// mount itself doesn't play within another window the engine's peer connection is
// likely wedged (transport-alive, replication-dead) — escalate to backend.reconnect()
// before each further remount. VOD (S8a): the whole ladder disarms when the engine
// reports the served record is a vod title — a paused/seeking/finished playhead sits
// still by design.
//
// hls.js specifics: fatal network errors retry with a full remount (the SDK holds
// playlist requests while the live edge replicates, so brief startup gaps mostly
// never surface); fatal media errors get one recoverMediaError() then a remount;
// incompatible-codec errors (an HEVC lineup on a device without HEVC decode) surface
// as a clean per-channel error instead of a retry loop — retrying can't grow a codec.

import React, { useEffect, useImperativeHandle, useRef, useState } from 'react'
import Hls from 'hls.js'
import type { DesktopBackend } from '../bridge'
import type { BackendMessage } from '../types'

const RETRY_MS = 2500
const STALL_MS = 12000

export type TunePhase = 'start' | 'retune' | 'reconnect' | 'playing'

export interface TuneEvent {
  /** Monotonic per-component tune counter — hosts key their indicator on it. */
  id: number
  streamId: string
  phase: TunePhase
}

/** One selectable in-stream track (audio or subtitle), by hls.js flat index. */
export interface MediaTrack {
  index: number
  label: string
  lang?: string
}

/** Imperative surface: absolute seek, for the vod transport (S8a). */
export interface HlsVideoHandle {
  seek: (seconds: number) => void
}

export interface HlsVideoProps {
  backend: DesktopBackend
  streamId: string
  paused?: boolean
  onTune?: (e: TuneEvent) => void
  onPeers?: (peers: number) => void
  onBuffering?: (buffering: boolean) => void
  onSource?: (url: string, source: 'p2p' | 'cdn') => void
  onError?: (message: string) => void
  /** The frozen-live-edge self-heal kicked in (logging hook; onTune 'start' re-arms the UI). */
  onStall?: () => void
  /** Available audio tracks (fires after manifest parse; [] when none/single implied). */
  onAudioTracks?: (tracks: MediaTrack[]) => void
  /** Available subtitle/CC tracks. */
  onTextTracks?: (tracks: MediaTrack[]) => void
  /** Selected audio track index (undefined = player default). */
  selectedAudio?: number
  /** Selected subtitle track index (-1 = off, the default). */
  selectedText?: number
  /** vod transport feed: playhead seconds / player-reported duration / natural end. */
  onProgress?: (seconds: number) => void
  onDuration?: (seconds: number) => void
  onEnded?: () => void
  stallTimeoutMs?: number
}

// The localhost server always serves index.m3u8; redirect channels are operator URLs
// that may (rarely) be direct files — those go to native <video> playback.
function isHlsUrl (url: string) {
  return /\.m3u8(\?|$)/i.test(url)
}

function trackList (tracks: Array<{ name?: string; lang?: string }>): MediaTrack[] {
  return tracks.map((t, i) => ({ index: i, label: t.name || t.lang || `Track ${i + 1}`, lang: t.lang || undefined }))
}

export const HlsVideo = React.forwardRef<HlsVideoHandle, HlsVideoProps>(function HlsVideo ({
  backend, streamId, paused, onTune, onPeers, onBuffering, onSource, onError, onStall,
  onAudioTracks, onTextTracks, selectedAudio, selectedText = -1,
  onProgress, onDuration, onEnded, stallTimeoutMs = STALL_MS
}: HlsVideoProps, ref) {
  const [url, setUrl] = useState<string | null>(backend.url)
  const [attempt, setAttempt] = useState(0)
  // Synchronous shadow of `attempt`: bumped BEFORE the remounting setState so event
  // handlers of the outgoing player instance identify themselves as stale.
  const epoch = useRef(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cb = useRef({ onTune, onPeers, onBuffering, onSource, onError, onStall, onAudioTracks, onTextTracks, onProgress, onDuration, onEnded })
  cb.current = { onTune, onPeers, onBuffering, onSource, onError, onStall, onAudioTracks, onTextTracks, onProgress, onDuration, onEnded }
  // The in-flight tune. `live` = the engine confirmed the shared localhost URL serves
  // THIS tune's stream; only then can the current mount's playback complete it.
  const tune = useRef({ id: 0, streamId, tuning: false, live: false })
  // Which channel the engine last confirmed serving — survives screen unmounts via
  // the backend cache, so re-entering on the resumed channel doesn't force a remount.
  const served = useRef<string | null>(backend.activeStreamId)
  const progress = useRef({ time: -1, at: Date.now(), played: false })
  const resyncs = useRef(0)
  const vod = useRef(backend.activeStreamId === streamId && backend.recordType === 'vod')
  const pausedRef = useRef(!!paused); pausedRef.current = !!paused

  useImperativeHandle(ref, () => ({
    seek: (seconds: number) => { const v = videoRef.current; if (v) v.currentTime = seconds }
  }), [])

  function remount () {
    epoch.current++
    setAttempt(epoch.current)
  }

  // First real playback of the CURRENT tune → 'playing'. Callers are epoch-checked,
  // so only the live mount can get here.
  function completeTune () {
    const t = tune.current
    if (!t.tuning || !t.live) return
    t.tuning = false
    cb.current.onTune?.({ id: t.id, streamId: t.streamId, phase: 'playing' })
  }

  useEffect(() => {
    // A new channel (or the first mount) starts a new TUNE. If the engine's last
    // confirmed serve already IS this stream (re-entering the screen on the resumed
    // channel), the mount is live from the start.
    tune.current = { id: tune.current.id + 1, streamId, tuning: true, live: served.current === streamId }
    vod.current = backend.activeStreamId === streamId && backend.recordType === 'vod'
    cb.current.onTune?.({ id: tune.current.id, streamId, phase: 'start' })
    const off = backend.onMessage((m: BackendMessage) => {
      if (m.type === 'port' && backend.url) {
        setUrl(backend.url)
        if (backend.source) cb.current.onSource?.(backend.url, backend.source)
        const sid = m.streamId ?? streamId
        const changed = sid !== served.current
        served.current = sid
        if (sid === streamId) {
          // The engine confirmed OUR stream is what the shared URL serves now. If that
          // is a switch, remount to flush the previous channel's playlist/buffer.
          if (changed) remount()
          tune.current.live = true
          if (m.recordType) vod.current = m.recordType === 'vod'
        }
        // else: a stale reply from an outrun zap — recorded; ours is still on the way.
      }
      if (m.type === 'feed-changed' && m.streamId === streamId) {
        // Same localhost URL, new feed behind it — remount to flush the stale playlist.
        setUrl(m.url); remount()
        tune.current.live = true
      }
      if (m.type === 'status' && typeof m.peers === 'number') cb.current.onPeers?.(m.peers)
      if (m.type === 'status' && (m.state === 'feed:retune' || m.state === 'feed:reconnect')) {
        // The engine's self-heal on the active feed — re-arm completion and surface
        // the phase so the host says "reconnecting" instead of freezing its indicator.
        tune.current.tuning = true
        cb.current.onTune?.({ id: tune.current.id, streamId: tune.current.streamId, phase: m.state === 'feed:retune' ? 'retune' : 'reconnect' })
      }
      if (m.type === 'error') {
        tune.current.tuning = false // the friendly error ENDS the tune — error UI takes over
        cb.current.onError?.(m.message)
      }
    })
    backend.play(streamId)
    return () => {
      off()
      if (retry.current) clearTimeout(retry.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, streamId])

  // The player mount: one hls.js instance (or a native src for non-HLS redirect URLs)
  // per [url, attempt]. Every remount disarms the stall watchdog until the fresh
  // mount plays again.
  useEffect(() => {
    progress.current = { time: -1, at: Date.now(), played: false }
    const video = videoRef.current
    if (!video || !url) return
    const myEpoch = epoch.current
    const stale = () => myEpoch !== epoch.current

    const onTimeUpdate = () => {
      if (stale()) return
      const t = video.currentTime
      const p = progress.current
      if (t !== p.time) {
        progress.current = { time: t, at: Date.now(), played: true }
        completeTune() // an advancing playhead is playback, whatever else fired
      }
      cb.current.onProgress?.(Math.floor(t))
    }
    const onPlaying = () => { if (!stale()) { cb.current.onBuffering?.(false); completeTune() } }
    const onWaiting = () => { if (!stale()) cb.current.onBuffering?.(true) }
    const onLoadedMeta = () => { if (!stale() && isFinite(video.duration) && video.duration > 0) cb.current.onDuration?.(video.duration) }
    const onVideoEnded = () => { if (!stale()) cb.current.onEnded?.() }
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('loadedmetadata', onLoadedMeta)
    video.addEventListener('ended', onVideoEnded)

    const scheduleRetry = () => {
      if (retry.current) clearTimeout(retry.current)
      retry.current = setTimeout(() => remount(), RETRY_MS)
    }

    let hls: Hls | null = null
    if (isHlsUrl(url) && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        // Live tuning: start near the edge, keep a bounded buffer. The SDK reads the
        // live edge ahead server-side, so a small client buffer keeps zaps fast.
        liveSyncDurationCount: 3,
        maxBufferLength: 30,
        backBufferLength: 30,
        fragLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 4
      })
      hlsRef.current = hls
      let mediaRecovered = false
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (stale()) return
        video.play().catch(() => {})
      })
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => { if (!stale()) cb.current.onAudioTracks?.(trackList(hls!.audioTracks)) })
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => { if (!stale()) cb.current.onTextTracks?.(trackList(hls!.subtitleTracks)) })
      hls.on(Hls.Events.ERROR, (_ev, data) => {
        if (stale() || !data.fatal) return
        // A codec the device can't decode: retrying can't help — surface it cleanly
        // (the S35 HEVC reality: several live channels are HEVC 1080p, and Chromium
        // HEVC playback depends on platform hardware decode).
        if (/incompatiblecodecs|bufferaddcodec/i.test(String(data.details))) {
          tune.current.tuning = false
          const codec = (data as { mimeType?: string }).mimeType
          cb.current.onError?.(`This device can't decode this channel's video format${codec ? ` (${codec})` : ''}.`)
          return
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
          mediaRecovered = true
          try { hls!.recoverMediaError(); return } catch { /* fall through to remount */ }
        }
        // Playlist/segments not replicated yet, or a live-edge hiccup — remount+retry.
        cb.current.onBuffering?.(true)
        scheduleRetry()
      })
      hls.loadSource(url)
      hls.attachMedia(video)
    } else {
      // Non-HLS redirect URL (or MSE unavailable): let Chromium play it directly.
      const onNativeError = () => { if (!stale()) { cb.current.onBuffering?.(true); scheduleRetry() } }
      video.addEventListener('error', onNativeError)
      video.src = url
      video.play().catch(() => {})
      return () => {
        video.removeEventListener('error', onNativeError)
        video.removeEventListener('timeupdate', onTimeUpdate)
        video.removeEventListener('playing', onPlaying)
        video.removeEventListener('waiting', onWaiting)
        video.removeEventListener('loadedmetadata', onLoadedMeta)
        video.removeEventListener('ended', onVideoEnded)
        video.removeAttribute('src')
        video.load()
      }
    }
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('loadedmetadata', onLoadedMeta)
      video.removeEventListener('ended', onVideoEnded)
      if (hls) { hls.destroy(); if (hlsRef.current === hls) hlsRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, attempt])

  // A zap or source switch starts a fresh tune — the escalation ladder resets with it.
  useEffect(() => { resyncs.current = 0 }, [streamId, url])

  // Host-owned pause (vod transport).
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (paused) v.pause()
    else v.play().catch(() => {})
  }, [paused, url, attempt])

  // In-stream track selection (S27k parity). hls.js uses flat indexes consistently
  // (unlike ExoPlayer's group-relative text indexes), so index selection is reliable.
  useEffect(() => {
    const hls = hlsRef.current
    if (!hls) return
    if (typeof selectedAudio === 'number' && selectedAudio >= 0 && selectedAudio < hls.audioTracks.length) hls.audioTrack = selectedAudio
  }, [selectedAudio, url, attempt])
  useEffect(() => {
    const hls = hlsRef.current
    if (!hls) return
    hls.subtitleDisplay = selectedText >= 0
    hls.subtitleTrack = selectedText >= 0 && selectedText < hls.subtitleTracks.length ? selectedText : -1
  }, [selectedText, url, attempt])

  // Stall watchdog: playing but the playhead has not moved for stallTimeoutMs → the
  // live window slid past the playhead → remount at the live edge; a second
  // consecutive failed resync tears the engine's wedged transport down first.
  useEffect(() => {
    if (!stallTimeoutMs) return
    const timer = setInterval(() => {
      const p = progress.current
      if (vod.current) { p.at = Date.now(); return } // vod: a still playhead is by design
      if (pausedRef.current) { p.at = Date.now(); return }
      if (p.played) resyncs.current = 0
      else if (resyncs.current === 0) return // never played: the tune phase owns recovery
      if (Date.now() - p.at < stallTimeoutMs) return
      progress.current = { time: -1, at: Date.now(), played: false }
      resyncs.current++
      const t = tune.current
      tune.current = { id: t.id + 1, streamId: t.streamId, tuning: true, live: t.live }
      cb.current.onStall?.()
      cb.current.onTune?.({ id: tune.current.id, streamId: t.streamId, phase: 'start' })
      if (resyncs.current >= 2) backend.reconnect()
      remount()
    }, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, stallTimeoutMs])

  if (!url) return null
  return <video ref={videoRef} className="video-surface" autoPlay />
})
