// Favorites — the ★ channels (device-local, D4: stored by the worklet beside its
// store; no panel roundtrip, no sync). Rows reuse ChannelRow; selecting one jumps
// into Live TV playing that channel.
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, StyleSheet } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { backend, type Stream } from '../worklet'
import { channelNumbers, sortByCuration } from '../catalog'
import { ChannelRow } from '../components/ChannelRow'
import { SectionLoading } from '../components/SectionLoading'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Favorites'>

export function FavoritesScreen ({ navigation }: Props) {
  const [streams, setStreams] = useState<Stream[]>(backend.streams)
  const [favorites, setFavorites] = useState<string[]>(backend.favorites)
  const [loaded, setLoaded] = useState(backend.prefsLoaded)

  useEffect(() => {
    backend.requestPrefs()
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(m.streams)
      if (m.type === 'prefs') { setFavorites(m.favorites); setLoaded(true) }
    })
  }, [])

  const numbers = useMemo(() => channelNumbers(streams), [streams])
  const list = useMemo(() => sortByCuration(streams.filter(s => favorites.includes(s.id))), [streams, favorites])

  if (!loaded) return <SectionLoading section="Favorites" />

  return (
    <View style={styles.container}>
      <Text style={styles.header}>FAVORITES</Text>
      {list.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyStar}>☆</Text>
          <Text style={styles.emptyText}>No favorites yet</Text>
          <Text style={styles.emptyHint}>In Live TV, hold a channel and choose "Add favorite".</Text>
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(s) => s.id}
          renderItem={({ item, index }) => (
            <ChannelRow
              stream={item}
              number={numbers.get(item.id)}
              favorite
              hasTVPreferredFocus={index === 0}
              onPress={() => navigation.navigate('Live', { streamId: item.id })}
              onLongPress={() => backend.toggleFavorite(item.id)}
            />
          )}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingHorizontal: theme.safeX, paddingVertical: theme.safeY },
  header: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1.5) },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyStar: { color: theme.colors.textDim, fontSize: theme.type.display + 12 },
  emptyText: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700', marginTop: theme.spacing(1) },
  emptyHint: { color: theme.colors.textDim, fontSize: theme.type.body, marginTop: 6, textAlign: 'center', maxWidth: 420 }
})
