// Player — full-screen live HLS from the Bare localhost server. Waits for the backend
// to report the local port, then plays. For DRM streams, also set the `drm` prop with a
// panel-issued entitlement token (see docs/content-management.md).
import React, { useEffect, useState } from 'react'
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native'
// @ts-expect-error — react-native-video is installed in S6c (this screen isn't wired until then)
import Video from 'react-native-video'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { backend } from '../worklet'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>

export function PlayerScreen ({ route }: Props) {
  const { title } = route.params
  const [port, setPort] = useState<number | null>(null)
  const [peers, setPeers] = useState<number | null>(null)

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'port') setPort(m.port)
      if (m.type === 'status' && typeof m.peers === 'number') setPeers(m.peers)
    })
  }, [])

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
        source={{ uri: `http://127.0.0.1:${port}/index.m3u8` }}
        style={StyleSheet.absoluteFill}
        controls
        resizeMode="contain"
        // For protection === 'drm':
        // drm={{ type: 'widevine', licenseServer: LICENSE_URL, headers: { Authorization: entitlementJwt } }}
      />
      <View style={styles.overlay} pointerEvents="none">
        <Text style={styles.live}>● LIVE</Text>
        <Text style={styles.title}>{title}</Text>
        {peers != null && <Text style={styles.dim}>{peers} peers</Text>}
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
  dim: { color: theme.colors.textDim, marginTop: 8 }
})
