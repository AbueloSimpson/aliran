// Main menu hub (the reference's icon-bar-over-wallpaper screen): a single horizontal
// icon menu across the top — white glyphs + ALL-CAPS labels, focused item wrapped in
// an accent rounded border — over a full-screen wallpaper. Wallpaper = the featured
// stream's LIVE feed thumb when one is rolling (WS5), over its backdrop (panel
// curation, S16c) under a dark scrim, falling back to the operator's
// branding.wallpaper, then a plain brand surface (D6: no baked-in art).
// The section list is DATA-DRIVEN from the service descriptor (white-label §8) AND,
// for Movies & Series, from the PANEL: that tile exists only while the operator has an
// external VOD provider enabled (S53 — backend.vod is delivered on the login/'streams'
// payload and is null otherwise), and a brand can still switch it off with
// sections.vod:false. Exit is TV-only by default (D7).
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet, Platform, BackHandler, ScrollView } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { backend, type Stream } from '../worklet'
import { visibleStreams } from '../parental'
import { loadServiceDescriptor, type SectionToggles } from '../config'
import { pickHero } from '../catalog'
import { useEpg, useChannelThumb } from '@aliran/react-native'
import { theme } from '../theme'

const service = loadServiceDescriptor()

type Props = NativeStackScreenProps<RootStackParamList, 'Menu'>

interface MenuItem {
  key: string
  label: string
  glyph: string
  go: () => void
}

export function MenuScreen ({ navigation }: Props) {
  const [streams, setStreams] = useState<Stream[]>(() => visibleStreams(backend.streams))
  // The panel's VOD provider switch. It rides the same 'streams' message, so a menu
  // mounted before login sees it the moment the catalog lands.
  const [vodEnabled, setVodEnabled] = useState<boolean>(!!backend.vod?.enabled)

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'streams') { setStreams(visibleStreams(m.streams)); setVodEnabled(!!m.vod?.enabled) }
      // A parental change in Settings (this screen stays mounted under the stack)
      // can re-hide/reveal restricted channels — recompute the wallpaper pick.
      if (m.type === 'prefs') setStreams(visibleStreams(backend.streams))
    })
  }, [])

  const hero = useMemo(() => pickHero(streams), [streams])
  const wallpaper = hero?.backdrop || hero?.poster || service.branding?.wallpaper
  // Live hero: the featured channel's rolling feed thumb (the SDK's 30 s poll — the
  // same hook the channel rows use) layered over its backdrop. The backdrop stays
  // mounted underneath, so nothing changes while the thumb loads — and a 404
  // (thumbnails off, feed cold) IS today's backdrop-only wallpaper. The existing
  // scrim above does all the blending; no new overlays.
  const [heroThumb, onHeroThumbError] = useChannelThumb(hero?.thumbBase)
  // The chip latches on a real decoded frame, not URL truthiness: the hook re-probes
  // 404ing feeds every 30 s (url flips truthy before the error lands), which would
  // flash the chip on thumb-less channels without this latch.
  const [thumbShown, setThumbShown] = useState(false)
  useEffect(() => { setThumbShown(false) }, [hero?.thumbBase])
  // Now-playing line for the featured stream — omitted entirely when it has no guide.
  const { data: heroEpg } = useEpg(hero?.epgUrl, hero?.epgId, hero?.guideBase)
  const nowTitle = heroEpg?.now?.title

  const items = useMemo<MenuItem[]>(() => {
    // sections.guide is new with the guide hub (WS5) — typed locally until the
    // descriptor's SectionToggles grows the field.
    const s: SectionToggles & { guide?: boolean } = service.sections ?? {}
    const list: MenuItem[] = [
      { key: 'live', label: 'Live TV', glyph: '📺', go: () => navigation.navigate('Live', {}) }
    ]
    if (s.guide !== false) list.push({ key: 'guide', label: 'Guide', glyph: '🗓️', go: () => navigation.navigate('Guide') })
    if (vodEnabled && s.vod !== false) list.push({ key: 'vod', label: 'Movies & Series', glyph: '🎬', go: () => navigation.navigate('Vod') })
    if (s.favorites !== false) list.push({ key: 'favorites', label: 'Favorites', glyph: '⭐', go: () => navigation.navigate('Favorites') })
    if (s.search !== false) list.push({ key: 'search', label: 'Search', glyph: '🔍', go: () => navigation.navigate('Search') })
    if (s.settings !== false) list.push({ key: 'settings', label: 'Settings', glyph: '⚙️', go: () => navigation.navigate('Settings') })
    if (s.exit ?? Platform.isTV) list.push({ key: 'exit', label: 'Exit', glyph: '🚪', go: () => BackHandler.exitApp() })
    return list
  }, [navigation, vodEnabled])

  return (
    <View style={styles.container}>
      {wallpaper && <Image source={{ uri: wallpaper }} style={StyleSheet.absoluteFill} resizeMode="cover" />}
      {hero && heroThumb && (
        // The uri carries a rolling ?t= stamp; the Image element itself stays mounted
        // across polls (same slot in the tree) — only the source updates.
        <Image
          source={{ uri: heroThumb }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => { setThumbShown(false); onHeroThumbError() }}
          onLoad={() => setThumbShown(true)}
          accessibilityLabel={`${hero.title} — live now`}
        />
      )}
      <View style={[StyleSheet.absoluteFill, styles.scrim]} />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bar} contentContainerStyle={styles.barContent}>
        {items.map((item, i) => <MenuEntry key={item.key} item={item} first={i === 0} />)}
      </ScrollView>

      <View style={styles.footer}>
        <Text style={styles.wordmark}>{service.name}</Text>
        {hero && (
          <View style={styles.heroLine}>
            {hero.isLive && <Text style={styles.live}>● LIVE</Text>}
            <Text style={styles.heroTitle} numberOfLines={1}>{hero.title}</Text>
          </View>
        )}
        {!!nowTitle && (
          <View style={styles.heroLine}>
            {/* The chip needs live evidence: only after a feed frame actually loaded. */}
            {thumbShown && <Text style={styles.liveChip}>LIVE</Text>}
            <Text style={styles.heroTitle} numberOfLines={1}>{nowTitle}</Text>
          </View>
        )}
      </View>
    </View>
  )
}

function MenuEntry ({ item, first }: { item: MenuItem; first: boolean }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.entry, focused && styles.entryFocused]}
      hasTVPreferredFocus={first}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={item.go}
    >
      <Text style={styles.glyph}>{item.glyph}</Text>
      <Text style={[styles.label, focused && styles.labelFocused]}>{item.label.toUpperCase()}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  scrim: { backgroundColor: theme.colors.overlay, opacity: 0.55 },
  bar: { position: 'absolute', top: theme.safeY + theme.spacing(1), left: 0, right: 0, flexGrow: 0 },
  // flexGrow lets the row fill the viewport so justifyContent can center the items;
  // if the sections ever overflow the width it falls back to a normal scrollable row.
  barContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: theme.safeX, gap: theme.spacing(1.5) },
  entry: {
    alignItems: 'center', justifyContent: 'center',
    minWidth: theme.isTV ? 132 : 92,
    paddingVertical: theme.spacing(1.25), paddingHorizontal: theme.spacing(1),
    borderRadius: 12, borderWidth: 3, borderColor: 'transparent'
  },
  entryFocused: { borderColor: theme.colors.accent, backgroundColor: theme.colors.overlay },
  glyph: { fontSize: theme.isTV ? 34 : 26 },
  label: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2, marginTop: 8 },
  labelFocused: { color: theme.colors.accent },
  footer: { position: 'absolute', left: theme.safeX, bottom: theme.safeY + theme.spacing(1) },
  wordmark: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '800', opacity: 0.9 },
  heroLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, maxWidth: 480 },
  live: { color: theme.colors.live, fontWeight: '800', fontSize: theme.type.caption },
  heroTitle: { color: theme.colors.textDim, fontSize: theme.type.caption },
  // ChannelRow's LIVE badge vocabulary (filled pill), local to this screen.
  liveChip: { color: theme.colors.onPrimary, backgroundColor: theme.colors.live, fontSize: theme.type.caption - 2, fontWeight: '800', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' }
})
