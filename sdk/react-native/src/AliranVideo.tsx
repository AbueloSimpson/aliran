// <AliranVideo> — drop-in P2P (and hybrid CDN<->P2P) live video on react-native-video.
//
// Plays whatever the engine says is the ACTIVE source: the localhost P2P server, or
// the CDN after a 'fallback', switching back on 'source-changed'. Right after play()
// the P2P playlist can 404 for a few seconds while the live edge replicates from
// peers, so source errors retry with a remount instead of failing (the proven
// behavior from the app's player screen). The component is chrome-free: overlays
// (badges, peer counts, spinners) belong to the host app via the state callbacks.
//
// TUNE LIFECYCLE (onTune): ONE localhost URL serves every P2P channel, so raw player
// events are useless as a "channel switch finished" signal — after a zap the OLD
// channel keeps playing (and emitting onProgress/onBuffer) under the same URL until
// the engine flips the served feed, and self-heal remounts re-create the <Video>
// mid-switch (S22 2026-07-16: a pill stuck at "Tuning 90%" over visibly playing
// video, and the opposite — the next zap's pill dismissed instantly by the previous
// channel's events). The component therefore tracks each switch as a TUNE:
//   'start'      a new channel (streamId change / mount) or a stall resync began;
//   'retune'/'reconnect'  the engine's self-heal cycle is running (fresh feed open /
//                wedged-transport teardown) — show "reconnecting", not a frozen bar;
//   'playing'    FIRST real playback of THIS tune: the engine confirmed the URL
//                serves this stream (the 'port' reply, remounting if the channel
//                changed) AND the current mount produced a frame or progress.
// Completion is mount-scoped (see remount()/mountEpoch): events still held by an
// outgoing mount can neither finish a tune nor feed the stall watchdog, and a
// remount mid-tune simply re-arms the same tune on the fresh mount.

import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import Video from 'react-native-video'
import { AliranBackend, type BackendMessage } from './backend'

const RETRY_MS = 2500
// Live-edge freeze self-heal: a live HLS window can be tiny (16 s on the reference
// deploy), so a network blip longer than the window slides it past the playhead —
// react-native-video fires NO error, the picture just freezes while everything else
// stays healthy (S22 2026-07-16). Once a mount has actually played, a playhead that
// stops advancing for this long (while not paused) forces a remount: a fresh playlist
// load rejoins at the live edge — exactly what a manual zap-away/zap-back did.
// ESCALATION: if the remount itself brings no playback within another window, the
// engine's swarm connection is likely wedged — transport-alive but replication-dead
// (a network flap can leave it that way; the same S22 day, 15+ min stuck with
// "1 peer" showing) — so the ladder calls backend.reconnect() to tear it down and
// dial fresh before each further remount.
const STALL_MS = 12000

export type TunePhase = 'start' | 'retune' | 'reconnect' | 'playing'

export interface TuneEvent {
  /** Monotonic per-component tune counter — a new id on every 'start' (channel change,
   *  mount, stall resync), so hosts can key their indicator and drop stale events. */
  id: number
  streamId: string
  phase: TunePhase
}

export interface AliranVideoProps {
  backend: AliranBackend
  streamId: string
  /** Send play() on mount (default true). Disable if the host already called it. */
  autoPlay?: boolean
  style?: StyleProp<ViewStyle>
  controls?: boolean
  paused?: boolean
  resizeMode?: 'contain' | 'cover' | 'stretch' | 'none'
  onSource?: (url: string, source: 'p2p' | 'cdn') => void
  onFallback?: (e: { url: string; reason: string }) => void
  onSourceChanged?: (e: { url: string; source: 'p2p' | 'cdn' }) => void
  /** The active stream's feed rotated (broadcaster source change / restart); the player
   *  was remounted onto the same URL to flush the stale playlist. */
  onFeedChanged?: (e: { feedKey: string; url: string }) => void
  onPeers?: (peers: number) => void
  onBuffering?: (buffering: boolean) => void
  onError?: (message: string) => void
  /** A frozen live edge was detected and the player is resyncing (remount onto a fresh
   *  playlist load at the live edge; consecutive failed resyncs additionally tear down
   *  the engine's wedged peer connection via backend.reconnect()). The same moment also
   *  fires onTune {phase:'start'} — drive tuning UI off onTune, use this for logging. */
  onStall?: () => void
  /** Tune lifecycle for the host's tuning indicator: 'start' arms it (reset — never
   *  inherit the previous tune's progress), 'retune'/'reconnect' are the engine's
   *  self-heal cycle (say "reconnecting", don't freeze), 'playing' dismisses it — the
   *  first REAL playback of this tune, raw player events can't be trusted for that
   *  (see the tune-lifecycle note above). */
  onTune?: (e: TuneEvent) => void
  /** How long the playhead may sit still (while playing) before a resync; 0 disables.
   *  Default 12000 — under the smallest deployed live window (8×2 s). */
  stallTimeoutMs?: number
  /** Extra props spread onto the underlying <Video>. */
  videoProps?: Record<string, unknown>
}

export function AliranVideo ({
  backend, streamId, autoPlay = true, style, controls = true, paused,
  resizeMode = 'contain', onSource, onFallback, onSourceChanged, onFeedChanged, onPeers,
  onBuffering, onError, onStall, onTune, stallTimeoutMs = STALL_MS, videoProps
}: AliranVideoProps) {
  const [url, setUrl] = useState<string | null>(backend.url)
  const [attempt, setAttempt] = useState(0) // remounts <Video>; trails epoch (see remount)
  // Synchronous shadow of `attempt`: bumped BEFORE the remounting setState, so event
  // callbacks still held by the outgoing mount (they captured `attempt` at its render)
  // identify themselves as stale in the gap before React commits the new mount.
  const epoch = useRef(0)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cb = useRef({ onSource, onFallback, onSourceChanged, onFeedChanged, onPeers, onBuffering, onError, onStall, onTune })
  cb.current = { onSource, onFallback, onSourceChanged, onFeedChanged, onPeers, onBuffering, onError, onStall, onTune }
  // The in-flight tune (see the tune-lifecycle note in the header). `live` = the engine
  // confirmed the shared localhost URL serves THIS tune's stream; only then can the
  // current mount's playback complete the tune.
  const tune = useRef({ id: 0, streamId, tuning: false, live: false })
  // Which channel the engine last confirmed serving — the backend remembers it across
  // screen unmounts, so re-entering on the resumed channel doesn't force a remount.
  const served = useRef<string | null>(backend.activeStreamId)
  // Live-edge stall detection: last playhead position + when it advanced. `played`
  // arms the watchdog only after THIS mount has produced motion — the tune phase owns
  // its own recovery (error-retry remounts + the engine's tune watchdog), and a dead
  // feed must not hot-loop remounts.
  const progress = useRef({ time: -1, at: Date.now(), played: false })
  // Consecutive stall resyncs with no playback in between: 1 = plain remount, ≥2 =
  // the remount didn't restore playback, escalate to a transport teardown.
  const resyncs = useRef(0)

  function remount () {
    epoch.current++
    setAttempt(epoch.current)
  }

  // First real playback of the CURRENT tune → 'playing'. Callers are mount-scoped
  // (epoch-checked), so only the live mount can get here.
  function completeTune () {
    const t = tune.current
    if (!t.tuning || !t.live) return
    t.tuning = false
    cb.current.onTune?.({ id: t.id, streamId: t.streamId, phase: 'playing' })
  }

  useEffect(() => {
    // A new channel (or the first mount) starts a new TUNE. If the engine's last
    // confirmed serve already IS this stream (re-entering the screen on the resumed
    // channel), the mount is live from the start — first playback completes the tune
    // without waiting for the play() reply.
    tune.current = { id: tune.current.id + 1, streamId, tuning: true, live: served.current === streamId }
    cb.current.onTune?.({ id: tune.current.id, streamId, phase: 'start' })
    const off = backend.onMessage((m: BackendMessage) => {
      if (m.type === 'port' && backend.url) {
        setUrl(backend.url)
        if (backend.source) cb.current.onSource?.(backend.url, backend.source)
        const sid = m.streamId ?? streamId // pre-streamId worklet bundles: assume ours
        const changed = sid !== served.current
        served.current = sid
        if (sid === streamId) {
          // The engine confirmed OUR stream is what the shared URL serves now. If that
          // is a switch, remount to flush the previous channel's playlist/buffer —
          // otherwise the old channel plays on until ExoPlayer stumbles into the swap.
          if (changed) remount()
          tune.current.live = true
        }
        // else: a stale reply from an outrun zap — recorded; ours is still on the way.
      }
      if (m.type === 'fallback' && m.streamId === streamId) {
        setUrl(m.url); remount()
        served.current = streamId
        tune.current.live = true
        cb.current.onFallback?.({ url: m.url, reason: m.reason })
      }
      if (m.type === 'source-changed' && m.streamId === streamId) {
        setUrl(m.url); remount()
        served.current = streamId
        tune.current.live = true
        cb.current.onSourceChanged?.({ url: m.url, source: m.source })
      }
      if (m.type === 'feed-changed' && m.streamId === streamId) {
        // Same localhost URL, new feed behind it — remount to flush the old playlist/
        // segments the player has already buffered.
        setUrl(m.url); remount()
        tune.current.live = true
        cb.current.onFeedChanged?.({ feedKey: m.feedKey, url: m.url })
      }
      if (m.type === 'status' && typeof m.peers === 'number') cb.current.onPeers?.(m.peers)
      if (m.type === 'status' && (m.state === 'feed:retune' || m.state === 'feed:reconnect')) {
        // The engine's self-heal cycle on the active feed (tune watchdog / wedged-
        // transport teardown). Re-arm completion — the cycle ends in fresh playback or
        // a friendly error — and surface the phase so the host can say "reconnecting"
        // instead of freezing its indicator.
        tune.current.tuning = true
        cb.current.onTune?.({ id: tune.current.id, streamId: tune.current.streamId, phase: m.state === 'feed:retune' ? 'retune' : 'reconnect' })
      }
      if (m.type === 'error') {
        tune.current.tuning = false // the friendly error ENDS the tune — the host's error UI takes over
        cb.current.onError?.(m.message) // e.g. tune timeout, corrupt store, not entitled
      }
    })
    if (autoPlay) backend.play(streamId)
    return () => {
      off()
      if (retry.current) clearTimeout(retry.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, streamId])

  // Every remount (source switch, error retry, feed rotation, stall resync) disarms the
  // stall watchdog until the fresh mount plays again.
  useEffect(() => {
    progress.current = { time: -1, at: Date.now(), played: false }
  }, [url, attempt])

  // A zap or source switch starts a fresh tune — the escalation ladder resets with it.
  useEffect(() => { resyncs.current = 0 }, [streamId, url])

  // Stall watchdog: playing but the playhead has not moved for stallTimeoutMs → the
  // live window slid past the playhead (no error event exists for this) → remount.
  // If a resync mount then FAILS to play within another window, a remount alone can't
  // help — the engine's peer connection is wedged (transport-alive, replication-dead):
  // tear it down via backend.reconnect() so the swarm dials fresh, and let the engine's
  // re-armed tune watchdog drive the outcome (playback resumes, or a friendly error).
  useEffect(() => {
    if (!stallTimeoutMs) return
    const timer = setInterval(() => {
      const p = progress.current
      if (paused) { p.at = Date.now(); return } // a paused playhead is not a stall
      if (p.played) resyncs.current = 0 // motion since the last resync — the ladder resets
      else if (resyncs.current === 0) return // never played: the tune phase owns recovery
      if (Date.now() - p.at < stallTimeoutMs) return
      progress.current = { time: -1, at: Date.now(), played: false }
      resyncs.current++
      // A resync re-arms the tune under a NEW id — the host's indicator restarts from
      // scratch, and the remount below must produce fresh playback before 'playing'.
      const t = tune.current
      tune.current = { id: t.id + 1, streamId: t.streamId, tuning: true, live: t.live }
      cb.current.onStall?.()
      cb.current.onTune?.({ id: tune.current.id, streamId: t.streamId, phase: 'start' })
      if (resyncs.current >= 2) backend.reconnect()
      remount() // fresh playlist load at the live edge
    }, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, paused, stallTimeoutMs])

  if (!url) return null

  const { onProgress: hostOnProgress, ...restVideoProps } = videoProps ?? {}
  const mountEpoch = attempt // the epoch this render's callbacks belong to (see remount)

  return (
    <Video
      key={url + ':' + attempt}
      source={{ uri: url }}
      style={style ?? StyleSheet.absoluteFill}
      controls={controls}
      paused={paused}
      resizeMode={resizeMode}
      onBuffer={({ isBuffering }: { isBuffering: boolean }) => {
        cb.current.onBuffering?.(isBuffering)
        if (!isBuffering && mountEpoch === epoch.current) completeTune()
      }}
      onReadyForDisplay={() => {
        cb.current.onBuffering?.(false)
        if (mountEpoch === epoch.current) completeTune()
      }}
      onProgress={(e: { currentTime: number }) => {
        if (mountEpoch === epoch.current) {
          const p = progress.current
          if (e.currentTime !== p.time) {
            progress.current = { time: e.currentTime, at: Date.now(), played: true }
            completeTune() // an advancing playhead is playback, whatever else fired
          }
        }
        ;(hostOnProgress as ((e: { currentTime: number }) => void) | undefined)?.(e)
      }}
      onError={() => {
        // Playlist/segments not replicated yet (or a live-edge hiccup) — retry.
        cb.current.onBuffering?.(true)
        if (retry.current) clearTimeout(retry.current)
        retry.current = setTimeout(() => remount(), RETRY_MS)
      }}
      {...restVideoProps}
    />
  )
}
