// Home / Browse — OTT rails. A featured hero + horizontal rails of live channels,
// grouped by category, with LIVE badges. Focusable cards for D-pad (TV) and tap (phone).
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, Pressable, Image, StyleSheet } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { backend, type Stream } from '../worklet'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>

export function HomeScreen ({ navigation }: Props) {
  const [streams, setStreams] = useState<Stream[]>(backend.streams)

  useEffect(() => {
    // Live catalog: the backend pushes updated stream lists as the panel catalog changes.
    return backend.onMessage((m) => { if (m.type === 'streams') setStreams(m.streams) })
  }, [])

  const byCategory = useMemo(() => groupByCategory(streams), [streams])
  const hero = streams.find(s => s.isLive) ?? streams[0]

  return (
    <View style={styles.container}>
      {hero && (
        <Pressable style={styles.hero} onPress={() => open(hero)}>
          {hero.backdrop && <Image source={{ uri: hero.backdrop }} style={StyleSheet.absoluteFill} />}
          <View style={styles.heroOverlay}>
            {hero.isLive && <Text style={styles.liveBadge}>● LIVE</Text>}
            <Text style={styles.heroTitle}>{hero.title}</Text>
            {hero.description && <Text style={styles.heroDesc} numberOfLines={2}>{hero.description}</Text>}
          </View>
        </Pressable>
      )}

      <FlatList
        data={Object.entries(byCategory)}
        keyExtractor={([cat]) => cat}
        renderItem={({ item: [cat, list] }) => (
          <View style={styles.rail}>
            <Text style={styles.railTitle}>{cat}</Text>
            <FlatList
              horizontal
              data={list}
              keyExtractor={(s) => s.id}
              showsHorizontalScrollIndicator={false}
              renderItem={({ item }) => <Card stream={item} onPress={() => open(item)} />}
            />
          </View>
        )}
      />
    </View>
  )

  function open (s: Stream) {
    backend.play(s.id)
    navigation.navigate('Player', { streamId: s.id, title: s.title })
  }
}

function Card ({ stream, onPress }: { stream: Stream; onPress: () => void }) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      {stream.poster
        ? <Image source={{ uri: stream.poster }} style={styles.poster} />
        : <View style={[styles.poster, styles.posterFallback]}><Text style={styles.posterText}>{stream.title}</Text></View>}
      {stream.isLive && <Text style={styles.cardLive}>LIVE</Text>}
      <Text style={styles.cardTitle} numberOfLines={1}>{stream.title}</Text>
    </Pressable>
  )
}

function groupByCategory (streams: Stream[]): Record<string, Stream[]> {
  const out: Record<string, Stream[]> = {}
  for (const s of streams) {
    const cats = s.category?.length ? s.category : ['All']
    for (const c of cats) (out[c] ??= []).push(s)
  }
  return out
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  hero: { height: theme.isTV ? 360 : 200, justifyContent: 'flex-end', backgroundColor: theme.colors.surface },
  heroOverlay: { padding: 24 },
  heroTitle: { color: theme.colors.text, fontSize: theme.isTV ? 40 : 26, fontWeight: '800' },
  heroDesc: { color: theme.colors.textDim, fontSize: 16, marginTop: 6, maxWidth: 600 },
  liveBadge: { color: theme.colors.live, fontWeight: '800', marginBottom: 6 },
  rail: { marginTop: theme.spacing(2), paddingLeft: 16 },
  railTitle: { color: theme.colors.text, fontSize: theme.isTV ? 24 : 18, fontWeight: '700', marginBottom: 8 },
  card: { width: theme.cardWidth, marginRight: 12 },
  poster: { width: theme.cardWidth, height: theme.cardHeight, borderRadius: 8, backgroundColor: theme.colors.surface },
  posterFallback: { alignItems: 'center', justifyContent: 'center', padding: 8 },
  posterText: { color: theme.colors.textDim, textAlign: 'center' },
  cardLive: { position: 'absolute', top: 6, left: 6, color: '#fff', backgroundColor: theme.colors.live, fontSize: 11, fontWeight: '800', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  cardTitle: { color: theme.colors.text, marginTop: 6, fontSize: 14 }
})
