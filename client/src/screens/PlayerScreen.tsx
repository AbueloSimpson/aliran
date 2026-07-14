// Player — full-screen live HLS via the @aliran/react-native <AliranVideo> binding
// (this app dogfoods the public SDK surface). The binding handles source selection
// (P2P localhost server, or CDN under a hybrid policy with auto-return), the
// port/url caching, and error-retry remounts; this screen just adds the chrome:
// LIVE badge, source badge, peer count, buffering spinner, error state.
import React, { useState } from 'react'
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { AliranVideo } from '@aliran/react-native'
import type { RootStackParamList } from '../App'
import { backend } from '../worklet'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>

export function PlayerScreen ({ route }: Props) {
  const { streamId, title } = route.params
  const [peers, setPeers] = useState<number | null>(null)
  const [buffering, setBuffering] = useState(true)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [error, setError] = useState<string | null>(null)

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Playback failed</Text>
        <Text style={styles.dim}>{error}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <AliranVideo
        backend={backend}
        streamId={streamId}
        onSource={(_url, s) => setSource(s)}
        onFallback={() => setSource('cdn')}
        onSourceChanged={({ source: s }) => setSource(s)}
        onPeers={setPeers}
        onBuffering={setBuffering}
        onError={setError} // e.g. corrupt local store, not entitled
      />
      {!backend.url && (
        <View style={[styles.center, StyleSheet.absoluteFill] as any}>
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={styles.dim}>Connecting to peers…</Text>
        </View>
      )}
      <View style={styles.overlay} pointerEvents="none">
        <Text style={styles.live}>● LIVE</Text>
        <Text style={styles.title}>{title}</Text>
        {source && <Text style={source === 'p2p' ? styles.srcP2P : styles.srcCDN}>{source.toUpperCase()}</Text>}
        {source !== 'cdn' && peers != null && <Text style={styles.peers}>{peers} peer{peers === 1 ? '' : 's'}</Text>}
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
  srcP2P: { color: theme.colors.accent, fontWeight: '800', fontSize: 12 },
  srcCDN: { color: '#F59E0B', fontWeight: '800', fontSize: 12 },
  peers: { color: theme.colors.textDim },
  dim: { color: theme.colors.textDim, marginTop: 8 },
  errorTitle: { color: theme.colors.text, fontSize: 18, fontWeight: '700' }
})
