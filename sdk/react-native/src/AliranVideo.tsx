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
  onPeers?: (peers: number) => void
  onBuffering?: (buffering: boolean) => void
  onError?: (message: string) => void
  /** Extra props spread onto the underlying <Video>. */
  videoProps?: Record<string, unknown>
}

export function AliranVideo ({
  backend, streamId, autoPlay = true, style, controls = true, paused,
  resizeMode = 'contain', onSource, onFallback, onSourceChanged, onPeers,
  onBuffering, onError, videoProps
}: AliranVideoProps) {
  const [url, setUrl] = useState<string | null>(backend.url)
  const [attempt, setAttempt] = useState(0) // bump to remount <Video> after an error
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cb = useRef({ onSource, onFallback, onSourceChanged, onPeers, onBuffering, onError })
  cb.current = { onSource, onFallback, onSourceChanged, onPeers, onBuffering, onError }

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

  if (!url) return null

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
      onError={() => {
        // Playlist/segments not replicated yet (or a live-edge hiccup) — retry.
        cb.current.onBuffering?.(true)
        if (retry.current) clearTimeout(retry.current)
        retry.current = setTimeout(() => setAttempt((a) => a + 1), RETRY_MS)
      }}
      {...videoProps}
    />
  )
}
