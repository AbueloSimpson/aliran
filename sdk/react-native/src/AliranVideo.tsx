// <AliranVideo> — drop-in P2P (and hybrid CDN<->P2P) live video on react-native-video.
//
// Plays whatever the engine says is the ACTIVE source: the localhost P2P server, or
// the CDN after a 'fallback', switching back on 'source-changed'. Right after play()
// the P2P playlist can 404 for a few seconds while the live edge replicates from
// peers, so source errors retry with a remount instead of failing (the proven
// behavior from the app's player screen). The component is chrome-free: overlays
// (badges, peer counts, spinners) belong to the host app via the state callbacks.

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
   *  the engine's wedged peer connection via backend.reconnect()). Hosts typically
   *  re-show their tuning indicator until onBuffering(false)/onReadyForDisplay. */
  onStall?: () => void
  /** How long the playhead may sit still (while playing) before a resync; 0 disables.
   *  Default 12000 — under the smallest deployed live window (8×2 s). */
  stallTimeoutMs?: number
  /** Extra props spread onto the underlying <Video>. */
  videoProps?: Record<string, unknown>
}

export function AliranVideo ({
  backend, streamId, autoPlay = true, style, controls = true, paused,
  resizeMode = 'contain', onSource, onFallback, onSourceChanged, onFeedChanged, onPeers,
  onBuffering, onError, onStall, stallTimeoutMs = STALL_MS, videoProps
}: AliranVideoProps) {
  const [url, setUrl] = useState<string | null>(backend.url)
  const [attempt, setAttempt] = useState(0) // bump to remount <Video> after an error
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cb = useRef({ onSource, onFallback, onSourceChanged, onFeedChanged, onPeers, onBuffering, onError, onStall })
  cb.current = { onSource, onFallback, onSourceChanged, onFeedChanged, onPeers, onBuffering, onError, onStall }
  // Live-edge stall detection: last playhead position + when it advanced. `played`
  // arms the watchdog only after THIS mount has produced motion — the tune phase owns
  // its own recovery (error-retry remounts + the engine's tune watchdog), and a dead
  // feed must not hot-loop remounts.
  const progress = useRef({ time: -1, at: Date.now(), played: false })
  // Consecutive stall resyncs with no playback in between: 1 = plain remount, ≥2 =
  // the remount didn't restore playback, escalate to a transport teardown.
  const resyncs = useRef(0)

  useEffect(() => {
    const off = backend.onMessage((m: BackendMessage) => {
      if (m.type === 'port' && backend.url) {
        setUrl(backend.url)
        if (backend.source) cb.current.onSource?.(backend.url, backend.source)
      }
      if (m.type === 'fallback' && m.streamId === streamId) {
        setUrl(m.url); setAttempt(a => a + 1)
        cb.current.onFallback?.({ url: m.url, reason: m.reason })
      }
      if (m.type === 'source-changed' && m.streamId === streamId) {
        setUrl(m.url); setAttempt(a => a + 1)
        cb.current.onSourceChanged?.({ url: m.url, source: m.source })
      }
      if (m.type === 'feed-changed' && m.streamId === streamId) {
        // Same localhost URL, new feed behind it — bump attempt to remount and flush the
        // old playlist/segments the player has already buffered.
        setUrl(m.url); setAttempt(a => a + 1)
        cb.current.onFeedChanged?.({ feedKey: m.feedKey, url: m.url })
      }
      if (m.type === 'status' && typeof m.peers === 'number') cb.current.onPeers?.(m.peers)
      if (m.type === 'error') cb.current.onError?.(m.message) // e.g. corrupt store, not entitled
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
      cb.current.onStall?.()
      if (resyncs.current >= 2) backend.reconnect()
      setAttempt((a) => a + 1) // remount = fresh playlist load at the live edge
    }, 1000)
    return () => clearInterval(timer)
  }, [backend, paused, stallTimeoutMs])

  if (!url) return null

  const { onProgress: hostOnProgress, ...restVideoProps } = videoProps ?? {}

  return (
    <Video
      key={url + ':' + attempt}
      source={{ uri: url }}
      style={style ?? StyleSheet.absoluteFill}
      controls={controls}
      paused={paused}
      resizeMode={resizeMode}
      onBuffer={({ isBuffering }: { isBuffering: boolean }) => cb.current.onBuffering?.(isBuffering)}
      onReadyForDisplay={() => cb.current.onBuffering?.(false)}
      onProgress={(e: { currentTime: number }) => {
        const p = progress.current
        if (e.currentTime !== p.time) progress.current = { time: e.currentTime, at: Date.now(), played: true }
        ;(hostOnProgress as ((e: { currentTime: number }) => void) | undefined)?.(e)
      }}
      onError={() => {
        // Playlist/segments not replicated yet (or a live-edge hiccup) — retry.
        cb.current.onBuffering?.(true)
        if (retry.current) clearTimeout(retry.current)
        retry.current = setTimeout(() => setAttempt((a) => a + 1), RETRY_MS)
      }}
      {...restVideoProps}
    />
  )
}
