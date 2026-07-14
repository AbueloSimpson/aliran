// Home / Browse — OTT rails. A featured hero + horizontal rails of live channels,
// grouped by category, with LIVE badges. Focusable cards for D-pad (TV) and tap (phone).
// TV: every focusable shows a focus ring; TVFocusGuideView gives each rail focus memory
// so D-pad up/down returns to the card you left, not the rail's first card.
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, Pressable, Image, StyleSheet, Platform, TVFocusGuideView } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { backend, type Stream } from '../worklet'
import { groupByCategory, pickHero } from '../catalog'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>

// On phone TVFocusGuideView is just a View; on TV autoFocus restores the last-focused child.
const Rail = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

export function HomeScreen ({ navigation }: Props) {
  const [streams, setStreams] = useState<Stream[]>(backend.streams)
  const [heroFocused, setHeroFocused] = useState(false)

  useEffect(() => {
    // Live catalog: the backend pushes updated stream lists as the panel catalog changes.
    return backend.onMessage((m) => { if (m.type === 'streams') setStreams(m.streams) })
  }, [])

  // Panel curation (S16c): rails sort by (order ?? Infinity, title); hero prefers featured.
  const byCategory = useMemo(() => groupByCategory(streams), [streams])
  const hero = useMemo(() => pickHero(streams), [streams])

  return (
    <View style={styles.container}>
      {hero && (
        <Pressable
          style={[styles.hero, heroFocused && styles.heroFocused]}
          hasTVPreferredFocus
          onFocus={() => setHeroFocused(true)}
          onBlur={() => setHeroFocused(false)}
          onPress={() => open(hero)}
        >
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
          <Rail autoFocus style={styles.rail}>
            <Text style={styles.railTitle}>{cat}</Text>
            <FlatList
              horizontal
              data={list}
              keyExtractor={(s) => s.id}
              showsHorizontalScrollIndicator={false}
              renderItem={({ item }) => <Card stream={item} onPress={() => open(item)} />}
            />
          </Rail>
        )}
      />
    </View>
  )

  function open (s: Stream) {
    // <AliranVideo> sends play() itself on mount — no pre-play needed here.
    navigation.navigate('Player', { streamId: s.id, title: s.title })
  }
}

function Card ({ stream, onPress }: { stream: Stream; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={styles.card}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      {stream.poster
        ? <Image source={{ uri: stream.poster }} style={[styles.poster, focused && styles.posterFocused]} />
        : <View style={[styles.poster, styles.posterFallback, focused && styles.posterFocused]}><Text style={styles.posterText}>{stream.title}</Text></View>}
      {stream.isLive && <Text style={styles.cardLive}>LIVE</Text>}
      <Text style={[styles.cardTitle, focused && styles.cardTitleFocused]} numberOfLines={1}>{stream.title}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  hero: { height: theme.isTV ? 360 : 200, justifyContent: 'flex-end', backgroundColor: theme.colors.surface, borderWidth: theme.focusRing, borderColor: 'transparent' },
  heroFocused: { borderColor: theme.colors.focus },
  heroOverlay: { padding: 24 },
  heroTitle: { color: theme.colors.text, fontSize: theme.isTV ? 40 : 26, fontWeight: '800' },
  heroDesc: { color: theme.colors.textDim, fontSize: 16, marginTop: 6, maxWidth: 600 },
  liveBadge: { color: theme.colors.live, fontWeight: '800', marginBottom: 6 },
  rail: { marginTop: theme.spacing(2), paddingLeft: 16 },
  railTitle: { color: theme.colors.text, fontSize: theme.isTV ? 24 : 18, fontWeight: '700', marginBottom: 8 },
  card: { width: theme.cardWidth, marginRight: 12 },
  poster: { width: theme.cardWidth, height: theme.cardHeight, borderRadius: 8, backgroundColor: theme.colors.surface, borderWidth: theme.focusRing, borderColor: 'transparent' },
  posterFocused: { borderColor: theme.colors.focus },
  posterFallback: { alignItems: 'center', justifyContent: 'center', padding: 8 },
  posterText: { color: theme.colors.textDim, textAlign: 'center' },
  cardLive: { position: 'absolute', top: 6, left: 6, color: '#fff', backgroundColor: theme.colors.live, fontSize: 11, fontWeight: '800', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  cardTitle: { color: theme.colors.text, marginTop: 6, fontSize: 14 },
  cardTitleFocused: { color: theme.colors.focus }
})
