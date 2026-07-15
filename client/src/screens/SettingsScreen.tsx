// Settings — account, service info, live diagnostics (P2P source + peers + entitled
// channel count), and sign out. Sign out clears the saved "remember me" credentials
// (D1) so the next boot lands on Login instead of auto-authorizing.
import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { backend } from '../worklet'
import { loadServiceDescriptor } from '../config'
import { theme } from '../theme'

const service = loadServiceDescriptor()

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>

export function SettingsScreen ({ navigation }: Props) {
  const [username, setUsername] = useState<string | null>(backend.creds?.username ?? null)
  const [channels, setChannels] = useState(backend.streams.length)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [signOutFocused, setSignOutFocused] = useState(false)

  useEffect(() => {
    backend.requestPrefs()
    return backend.onMessage((m) => {
      if (m.type === 'prefs') setUsername(m.creds?.username ?? null)
      if (m.type === 'streams') setChannels(m.streams.length)
      if (m.type === 'status' && typeof m.peers === 'number') setPeers(m.peers)
      if (m.type === 'port' && m.source) setSource(m.source)
      if (m.type === 'source-changed') setSource(m.source)
    })
  }, [])

  function signOut () {
    backend.clearCredentials()
    backend.streams = [] // drop the session's display list; a fresh login rebuilds it
    navigation.reset({ index: 0, routes: [{ name: 'Login' }] })
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.header}>SETTINGS</Text>

      <Text style={styles.groupTitle}>ACCOUNT</Text>
      <View style={styles.group}>
        <Row label="Signed in as" value={username ?? '—'} />
        <Row label="Entitled channels" value={String(channels)} />
      </View>

      <Text style={styles.groupTitle}>SERVICE</Text>
      <View style={styles.group}>
        <Row label="Service" value={service.name} />
        <Row label="Panel key" value={service.panelPubKey.slice(0, 16) + '…'} />
        <Row label="Playback" value={service.hybrid?.mode ?? 'p2p-only'} />
      </View>

      <Text style={styles.groupTitle}>DIAGNOSTICS</Text>
      <View style={styles.group}>
        <Row label="Active source" value={source ? source.toUpperCase() : '—'} />
        <Row label="Peers" value={peers != null ? String(peers) : '—'} />
      </View>

      <Pressable
        style={[styles.signOut, signOutFocused && styles.signOutFocused]}
        onFocus={() => setSignOutFocused(true)}
        onBlur={() => setSignOutFocused(false)}
        onPress={signOut}
      >
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
      <Text style={styles.signOutHint}>Sign out forgets the saved sign-in on this device.</Text>
    </ScrollView>
  )
}

function Row ({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: theme.safeX, paddingVertical: theme.safeY, maxWidth: 720, alignSelf: 'stretch' },
  header: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1.5) },
  groupTitle: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2, marginTop: theme.spacing(1.5), marginBottom: 6 },
  group: { backgroundColor: theme.colors.surface, borderRadius: 10, paddingHorizontal: theme.spacing(1.5), paddingVertical: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: theme.isTV ? 12 : 10, gap: 16 },
  rowLabel: { color: theme.colors.textDim, fontSize: theme.type.body },
  rowValue: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '600', flexShrink: 1 },
  signOut: {
    marginTop: theme.spacing(2.5), backgroundColor: theme.colors.surface, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center', borderWidth: Math.max(theme.focusRing, 1), borderColor: theme.colors.live
  },
  signOutFocused: { backgroundColor: theme.colors.live, borderColor: theme.colors.focus },
  signOutText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' },
  signOutHint: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 8 }
})
