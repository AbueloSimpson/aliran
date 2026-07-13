// Player — full-screen live HLS from the Bare localhost server. The media server is
// persistent (port cached on the worklet wrapper); right after play() the playlist may
// 404 for a few seconds while the feed replicates from peers, so source errors retry
// with a remount instead of failing. For DRM streams, also set the `drm` prop with a
// panel-issued entitlement token (see docs/content-management.md).
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native'
import Video from 'react-native-video'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { backend } from '../worklet'
import { theme } from '../theme'

const RETRY_MS = 2500

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>

export function PlayerScreen ({ route }: Props) {
  const { title } = route.params
  const [port, setPort] = useState<number | null>(backend.port)
  const [peers, setPeers] = useState<number | null>(null)
  const [buffering, setBuffering] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0) // bump to remount <Video> after an error
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const off = backend.onMessage((m) => {
      if (m.type === 'port') setPort(m.port)
      if (m.type === 'status' && typeof m.peers === 'number') setPeers(m.peers)
      if (m.type === 'error') setError(m.message) // e.g. corrupt local store, not entitled
    })
    return () => {
      off()
      if (retry.current) clearTimeout(retry.current)
    }
  }, [])

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Playback failed</Text>
        <Text style={styles.dim}>{error}</Text>
      </View>
    )
  }

  if (!port) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
        <Text style={styles.dim}>Connecting to peers…</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <Video
        key={attempt}
        source={{ uri: `http://127.0.0.1:${port}/index.m3u8` }}
        style={StyleSheet.absoluteFill}
        controls
        resizeMode="contain"
        onBuffer={({ isBuffering }) => setBuffering(isBuffering)}
        onReadyForDisplay={() => setBuffering(false)}
        onError={() => {
          // Playlist/segments not replicated yet (or a live-edge hiccup) — retry.
          setBuffering(true)
          if (retry.current) clearTimeout(retry.current)
          retry.current = setTimeout(() => setAttempt((a) => a + 1), RETRY_MS)
        }}
        // For protection === 'drm':
        // drm={{ type: 'widevine', licenseServer: LICENSE_URL, headers: { Authorization: entitlementJwt } }}
      />
      <View style={styles.overlay} pointerEvents="none">
        <Text style={styles.live}>● LIVE</Text>
        <Text style={styles.title}>{title}</Text>
        {peers != null && <Text style={styles.peers}>{peers} peer{peers === 1 ? '' : 's'}</Text>}
        {buffering && <ActivityIndicator size="small" color={theme.colors.primary} />}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  overlay: { position: 'absolute', top: 16, left: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  live: { color: theme.colors.live, fontWeight: '800' },
  title: { color: '#fff', fontSize: 16, fontWeight: '700' },
  peers: { color: theme.colors.textDim },
  dim: { color: theme.colors.textDim, marginTop: 8 },
  errorTitle: { color: theme.colors.text, fontSize: 18, fontWeight: '700' }
})
