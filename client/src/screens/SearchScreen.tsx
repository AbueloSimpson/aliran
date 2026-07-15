// Search — client-side filter over the entitled catalog (title / description /
// category). No server roundtrip: the whole display list is already replicated.
// Results reuse ChannelRow; selecting one jumps into Live TV.
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, TextInput, FlatList, StyleSheet } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { backend, type Stream } from '../worklet'
import { channelNumbers, sortByCuration } from '../catalog'
import { ChannelRow } from '../components/ChannelRow'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Search'>

export function SearchScreen ({ navigation }: Props) {
  const [streams, setStreams] = useState<Stream[]>(backend.streams)
  const [favorites, setFavorites] = useState<string[]>(backend.favorites)
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(m.streams)
      if (m.type === 'prefs') setFavorites(m.favorites)
    })
  }, [])

  const numbers = useMemo(() => channelNumbers(streams), [streams])
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sortByCuration(streams)
    return sortByCuration(streams.filter(s =>
      s.title?.toLowerCase().includes(q) ||
      s.description?.toLowerCase().includes(q) ||
      s.category?.some(c => c.toLowerCase().includes(q))
    ))
  }, [streams, query])

  return (
    <View style={styles.container}>
      <Text style={styles.header}>SEARCH</Text>
      <TextInput
        style={[styles.input, focused && styles.inputFocused]}
        placeholder="Channel, program or category…"
        placeholderTextColor={theme.colors.textDim}
        autoCapitalize="none"
        autoFocus
        value={query}
        onChangeText={setQuery}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {results.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No channels match "{query.trim()}"</Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(s) => s.id}
          renderItem={({ item }) => (
            <ChannelRow
              stream={item}
              number={numbers.get(item.id)}
              favorite={favorites.includes(item.id)}
              onPress={() => navigation.navigate('Live', { streamId: item.id })}
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
  input: {
    backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 12, fontSize: theme.type.body,
    marginBottom: theme.spacing(1.5), borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  inputFocused: { borderColor: theme.colors.focus },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: theme.colors.textDim, fontSize: theme.type.body }
})
