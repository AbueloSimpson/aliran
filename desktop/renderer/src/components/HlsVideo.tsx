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
// SELF-HEAL LADDER: a live HLS window can be tiny (16-24 s on the reference deploy;
// 24 s recommended), so
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
import { t } from '@aliran/i18n'
import type { DesktopBackend } from '../bridge'
import type { BackendMessage } from '../types'
import { trackDisplayLabels } from '../lang'

const RETRY_MS = 2500
// The BOUND on those retries — the RN component's ERROR_GIVE_UP, ported. Unbounded,
// a dead redirect url (404 that never heals, host refusing connections) remounted
// hls.js every 2.5 s forever with no report: the eternal spinner. Each consecutive
// failure doubles the next wait (2.5/5/10 s, give-up ≈ 25-30 s after the first
// error); only real playback — never a mere remount — re-arms a spent ladder, and
// the retry the offline text offers is a host-side re-select that mounts a fresh
// component. See sdk/react-native/src/AliranVideo.tsx for the full rationale.
const ERROR_GIVE_UP = 4
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
  /** In-app volume (QA round 3): 0..1 level + mute, applied to the element on every
   *  mount (the self-heal ladder remounts <video> — the setting must survive that). */
  volume?: number
  muted?: boolean
  stallTimeoutMs?: number
}

// The localhost server always serves index.m3u8; redirect channels are operator URLs
// that may (rarely) be direct files — those go to native <video> playback.
//
// An EXTENSION-LESS url counts as HLS. Chromium plays no HLS of its own, so the native
// branch is only ever right for a direct media file, and a url that names no container
// is not one: in practice it is a streaming shortlink. Every Samsung TV Plus KR channel
// arrives as https://jmp2.uk/stvp-<id> — no extension — and all 177 fell to the native
// branch and span forever on the retry ladder (2026-08-13). The wire was fine
// throughout (Content-Type: application/x-mpegURL); the container was simply decided
// before the request. Pluto's shortlinks carry .m3u8, which is why only Korea broke.
//
// Left deliberately narrow: a url that DOES name a container keeps the old answer, so
// .mp4/.webm still go native. (.mpd is academic here — hls.js is HLS-only and Chromium
// has no native DASH either, so a DASH redirect has never played on desktop.)
export function isHlsUrl (url: string) {
  if (/\.m3u8(\?|$)/i.test(url)) return true
  const path = url.split(/[?#]/)[0]
  return !/\.[a-z0-9]{1,5}$/i.test(path.slice(path.lastIndexOf('/') + 1))
}

/** hls.js track descriptors -> the flat-index shape TrackMenu renders. Exported for
 *  the VOD player (S54d), which drives its own hls instance but wants the same labels
 *  and the same indexing as live. Labels prefer the FULL language name from the
 *  track's code ("Spanish", not "spa t2" — S54 polish, lang.ts); the manifest's own
 *  name only fills in when the code resolves to nothing. */
export function trackList (tracks: Array<{ name?: string; lang?: string }>): MediaTrack[] {
  const labels = trackDisplayLabels(tracks.map((track) => ({ language: track.lang, title: track.name })), t('tracks.trackFallback'))
  return tracks.map((track, i) => ({ index: i, label: labels[i], lang: track.lang || undefined }))
}

export const HlsVideo = React.forwardRef<HlsVideoHandle, HlsVideoProps>(function HlsVideo ({
  backend, streamId, paused, onTune, onPeers, onBuffering, onSource, onError, onStall,
  onAudioTracks, onTextTracks, selectedAudio, selectedText = -1,
  onProgress, onDuration, onEnded, volume, muted, stallTimeoutMs = STALL_MS
}: HlsVideoProps, ref) {
  const [url, setUrl] = useState<string | null>(backend.url)
  const [attempt, setAttempt] = useState(0)
  // Synchronous shadow of `attempt`: bumped BEFORE the remounting setState so event
  // handlers of the outgoing player instance identify themselves as stale.
  const epoch = useRef(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Consecutive error-retry remounts with no real playback in between (ERROR_GIVE_UP).
  const failures = useRef(0)
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

  // In-app volume: re-applied on every mount too (attempt) — the self-heal ladder
  // replaces the <video> element and a fresh element starts at full volume.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = typeof volume === 'number' ? Math.max(0, Math.min(1, volume)) : 1
    v.muted = !!muted
  }, [volume, muted, attempt, url])

  function remount () {
    // Any remount supersedes a pending error retry: that timer belongs to a mount
    // that is going away, and now that the timer bills the ladder (failures++), a
    // handoff remount (port switch, feed rotation, stall resync) letting it fire
    // would charge a phantom attempt no error of the fresh mount's own earned —
    // and remount the fresh player a second time. (RN parity: AliranVideo.remount.)
    if (retry.current) { clearTimeout(retry.current); retry.current = null }
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
        // The error ladder resets with it: the engine is actively recovering, so the
        // errors spent so far belong to the outage the recovery is about to end — a
        // long P2P transient must heal the way the old flat retry always let it,
        // instead of stranding the viewer on a give-up mid-recovery. (A dead
        // redirect never emits these — no feed — so its bound is untouched.)
        failures.current = 0
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
  //
  // No provider-header code lives here on purpose. A redirect channel whose upstream
  // hotlink-checks Referer/Origin/User-Agent needs those on the manifest+segment GETs,
  // but hls.js (and the native <video> path) CANNOT set them — they are forbidden
  // request headers the browser owns. The MAIN process injects them per-origin via
  // Electron webRequest, armed from the same 'port' reply that hands us `url` (see
  // desktop/main/redirect-headers.js and its wiring in desktop/main/index.js). So this
  // component just loads the url; the headers ride underneath, invisibly to the renderer.
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
        failures.current = 0 // real playback — the error retry ladder re-arms (a mount alone never does)
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
      if (failures.current >= ERROR_GIVE_UP) return // spent: the error is up — no spinner, no remount, only real playback re-arms
      if (failures.current === ERROR_GIVE_UP - 1) {
        // The last rung gives up: three consecutive retry mounts took the same error
        // and nothing else on this path will ever report it (a redirect channel has
        // no feed for the engine's watchdog to fail on). Our own translated sentence,
        // same pattern as the codec error below — and the copy follows the source:
        // a cdn/redirect url refusing to play is the CHANNEL offline; a p2p failure
        // this persistent (the engine's own self-heal resets this ladder, so it was
        // silent too) gets the neutral playback-failed line instead of blaming the
        // channel for what may be a local engine problem. Retry is a re-select.
        if (retry.current) { clearTimeout(retry.current); retry.current = null }
        failures.current = ERROR_GIVE_UP
        tune.current.tuning = false
        cb.current.onError?.(t(backend.source === 'cdn' ? 'live.offlineHint' : 'live.playbackFailed'))
        return
      }
      // The spinner belongs to a retry that is actually coming — after the early
      // returns above, so a spent ladder's further error events cannot re-raise
      // buffering chrome over the error UI (RN parity: the spent-check runs first).
      cb.current.onBuffering?.(true)
      if (retry.current) clearTimeout(retry.current)
      // The delay belongs to the attempt this error asks for: 2.5 s first (the
      // transient contract), doubled per consecutive failure. The attempt is counted
      // when the remount actually happens, so N errors collapsing into one scheduled
      // retry spend one attempt, not N.
      retry.current = setTimeout(() => { failures.current++; remount() }, RETRY_MS * 2 ** failures.current)
    }

    let hls: Hls | null = null
    if (isHlsUrl(url) && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        // Live tuning: 5 segments (~10 s) behind the edge = churn headroom. The SDK
        // replicates the whole live window on-device, so everything between the
        // playhead and the edge survives a P2P source dying; measured re-source is
        // seconds-scale, well inside this offset. Playback starts as soon as the
        // first segments land, so zaps stay fast — the offset costs live delay,
        // not zap time. liveMaxLatency stays unset: a fixed bound would force
        // seeks on deployments running a narrower playlist window.
        liveSyncDurationCount: 5,
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
          // Our own sentence, not the engine's — so it goes through the catalog. The
          // codec string is a MIME type: data, never translated.
          const codec = (data as { mimeType?: string }).mimeType
          cb.current.onError?.(codec ? t('live.error.codecDetail', { codec }) : t('live.error.codec'))
          return
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
          mediaRecovered = true
          try { hls!.recoverMediaError(); return } catch { /* fall through to remount */ }
        }
        // Playlist/segments not replicated yet, or a live-edge hiccup — remount+retry
        // (scheduleRetry owns the buffering chrome: a spent ladder shows no spinner).
        scheduleRetry()
      })
      hls.loadSource(url)
      hls.attachMedia(video)
    } else {
      // Non-HLS redirect URL (or MSE unavailable): let Chromium play it directly.
      const onNativeError = () => { if (!stale()) scheduleRetry() } // scheduleRetry owns the buffering chrome
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

  // A zap or source switch starts a fresh tune — both escalation ladders reset with it.
  // (Keyed on streamId/url, NEVER on attempt: a retry remount must not buy back the
  // attempt it just spent, or the ladder would never give up.)
  useEffect(() => { resyncs.current = 0; failures.current = 0 }, [streamId, url])

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
      // A spent error ladder means the error UI owns the screen — the stall lane must
      // not resurrect the tune over it (12 s remount loop + tuning chrome over the
      // offline text). Desktop has no STALL_GIVE_UP of its own yet, so this gate is
      // what keeps the give-up final; real playback resets `failures` and re-arms.
      if (failures.current >= ERROR_GIVE_UP) return
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
