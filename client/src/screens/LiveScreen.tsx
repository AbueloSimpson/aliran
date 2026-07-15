// Live TV — ONE fullscreen video surface with overlay panels (the reorganization at
// the heart of the redesign; replaces the old Home→Player navigation for live).
//
//   base   : fullscreen <AliranVideo> — playback NEVER stops while browsing
//   overlay1: CategoryRail + ChannelListPanel — browse & zap; selecting a row
//             switches the stream AND collapses to fullscreen (the zap OSD confirms the
//             channel for a moment); BACK/tap reopens the panels to keep browsing
//   overlay2: ChannelInfoPanel — channel detail (long-press a row); honest
//             "No program information" placeholder where an EPG lands later (D2)
//
// TV: D-pad up/down while fullscreen zaps prev/next across the whole curated channel
// order (the numbers' order); select opens the channel list; BACK walks info → list →
// fullscreen → Menu. Zap rides the FOCUS ENGINE (invisible focus strips above/below
// the select-catcher band) — react-native-tvos on Android does not dispatch HWEvents
// to useTVEventHandler while a view holds focus, so key handling must be focus-based
// (the S7 lesson). Phone (D7): tap the video to toggle the panels; same IA.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet, Platform, BackHandler, TVFocusGuideView } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { AliranVideo } from '@aliran/react-native'
import type { RootStackParamList } from '../App'
import { backend, type Stream } from '../worklet'
import { channelNumbers, groupByCategory, pickHero, formatChannelNumber, sortByCuration } from '../catalog'
import { CategoryRail } from '../components/CategoryRail'
import { ChannelListPanel } from '../components/ChannelListPanel'
import { ChannelInfoPanel } from '../components/ChannelInfoPanel'
import { SectionLoading } from '../components/SectionLoading'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Live'>
type Overlay = 'none' | 'list' | 'info'

// On phone TVFocusGuideView is just a View; on TV autoFocus restores focus memory (S7).
const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

const OSD_MS = 2500

export function LiveScreen ({ navigation, route }: Props) {
  const [streams, setStreams] = useState<Stream[]>(backend.streams)
  const [favorites, setFavorites] = useState<string[]>(backend.favorites)
  const [playingId, setPlayingId] = useState<string | null>(() => route.params?.streamId ?? pickHero(backend.streams)?.id ?? null)
  const [overlay, setOverlay] = useState<Overlay>(route.params?.streamId ? 'none' : 'list')
  const [infoStream, setInfoStream] = useState<Stream | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [buffering, setBuffering] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [osd, setOsd] = useState<Stream | null>(null)
  const osdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const overlayRef = useRef(overlay); overlayRef.current = overlay
  const playingIdRef = useRef(playingId); playingIdRef.current = playingId

  useEffect(() => {
    backend.requestPrefs() // favorites may not be loaded yet
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(m.streams)
      if (m.type === 'prefs') setFavorites(m.favorites)
      // Broadcaster rotated the channel we're watching (source change / restart): the SDK
      // re-resolved the feed behind the same URL and AliranVideo remounts. Clear any prior
      // playback error (that had unmounted the video) so it re-mounts onto the fresh feed,
      // and show the spinner until it buffers.
      if (m.type === 'feed-changed' && m.streamId === playingIdRef.current) {
        setError(null)
        setBuffering(true)
      }
    })
  }, [])

  useEffect(() => () => { if (osdTimer.current) clearTimeout(osdTimer.current) }, [])

  const numbers = useMemo(() => channelNumbers(streams), [streams])
  const groups = useMemo(() => groupByCategory(streams), [streams])
  const categories = useMemo(() => Object.keys(groups), [groups])
  const activeCategory = category && groups[category] ? category : categories[0] ?? null
  const list = activeCategory ? groups[activeCategory] : []
  const playing = streams.find(s => s.id === playingId) ?? null

  // First streams push after a cold navigation: start the hero channel.
  useEffect(() => {
    if (!playingId && streams.length) setPlayingId(pickHero(streams)?.id ?? streams[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams])

  function play (s: Stream, { collapse = false }: { collapse?: boolean } = {}) {
    if (s.id !== playingId) {
      setPlayingId(s.id)
      setPeers(null)
      setBuffering(true)
      setError(null)
      showOsd(s)
    }
    if (collapse) setOverlay('none')
  }

  function showOsd (s: Stream) {
    setOsd(s)
    if (osdTimer.current) clearTimeout(osdTimer.current)
    osdTimer.current = setTimeout(() => setOsd(null), OSD_MS)
  }

  // Fullscreen zap: prev/next over the WHOLE catalog in curated order — the same
  // order the derived channel numbers follow (001, 002, …), like a TV's CH+/CH-.
  // (The category rail scopes the browse list, not the zap.)
  function zap (dir: 1 | -1) {
    const all = sortByCuration(streams)
    if (!all.length) return
    const i = all.findIndex(s => s.id === playingId)
    const next = all[(i < 0 ? 0 : i + dir + all.length) % all.length]
    if (next) play(next)
  }

  // Focus-engine zap: D-pad UP/DOWN from the fullscreen catcher lands on an invisible
  // strip whose onFocus zaps and bounces focus straight back to the catcher.
  const catcherRef = useRef<React.ComponentRef<typeof Pressable> | null>(null)
  function bounceZap (dir: 1 | -1) {
    zap(dir)
    requestAnimationFrame(() => (catcherRef.current as any)?.requestTVFocus?.())
  }

  // BACK walks the overlay stack before leaving the screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (overlayRef.current === 'info') { setOverlay('list'); return true }
      if (overlayRef.current === 'list') { setOverlay('none'); return true }
      return false // fullscreen: default = back to Menu
    })
    return () => sub.remove()
  }, [])

  if (!streams.length) return <SectionLoading section="Live TV" hint="Waiting for the channel list…" />

  return (
    <View style={styles.container}>
      {playingId && !error && (
        <AliranVideo
          backend={backend}
          streamId={playingId}
          controls={false}
          onSource={(_url, s) => setSource(s)}
          onFallback={() => setSource('cdn')}
          onSourceChanged={({ source: s }) => setSource(s)}
          onPeers={setPeers}
          onBuffering={setBuffering}
          onError={setError}
        />
      )}

      {/* Tap/select catcher: fullscreen -> open the panels (phone tap, TV select).
          On TV it is a middle band so the zap strips sit strictly above/below it
          in the focus engine's geometry. */}
      {overlay === 'none' && (
        <>
          <Pressable
            ref={catcherRef}
            style={Platform.isTV ? styles.catcherTV : StyleSheet.absoluteFill}
            hasTVPreferredFocus
            onPress={() => setOverlay('list')}
          />
          {Platform.isTV && (
            <>
              <Pressable style={styles.zapUp} onFocus={() => bounceZap(1)} />
              <Pressable style={styles.zapDown} onFocus={() => bounceZap(-1)} />
            </>
          )}
        </>
      )}

      {error && (
        <View style={styles.center} pointerEvents="none">
          <Text style={styles.errorTitle}>Playback failed</Text>
          <Text style={styles.dim}>{error}</Text>
        </View>
      )}
      {!error && buffering && overlay === 'none' && (
        <View style={styles.buffering} pointerEvents="none">
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      )}

      {/* Zap OSD: derived number + name, auto-hides. */}
      {osd && overlay === 'none' && (
        <View style={styles.osd} pointerEvents="none">
          <Text style={styles.osdNumber}>{formatChannelNumber(numbers.get(osd.id))}</Text>
          <View style={styles.osdMain}>
            <Text style={styles.osdTitle} numberOfLines={1}>{osd.title}</Text>
            {!!osd.description && <Text style={styles.osdDesc} numberOfLines={1}>{osd.description}</Text>}
          </View>
          {osd.isLive && <Text style={styles.osdLive}>LIVE</Text>}
        </View>
      )}

      {overlay !== 'none' && activeCategory && (
        <View style={styles.panels}>
          <FocusPane autoFocus style={styles.railPane}>
            <CategoryRail categories={categories} selected={activeCategory} onSelect={setCategory} />
          </FocusPane>
          <FocusPane autoFocus style={styles.listPane}>
            {overlay === 'list' ? (
              <ChannelListPanel
                streams={list}
                numbers={numbers}
                playingId={playingId}
                favorites={favorites}
                onSelect={(s) => play(s, { collapse: true })}
                onInfo={(s) => { setInfoStream(s); setOverlay('info') }}
                onCollapse={() => setOverlay('none')}
              />
            ) : (
              <View style={styles.infoPane}>
                {infoStream && (
                  <ChannelInfoPanel
                    stream={streams.find(s => s.id === infoStream.id) ?? infoStream}
                    number={numbers.get(infoStream.id)}
                    favorite={favorites.includes(infoStream.id)}
                    playing={infoStream.id === playingId}
                    source={source}
                    peers={peers}
                    onWatch={() => play(streams.find(s => s.id === infoStream.id) ?? infoStream, { collapse: true })}
                    onToggleFavorite={() => backend.toggleFavorite(infoStream.id)}
                  />
                )}
              </View>
            )}
          </FocusPane>
        </View>
      )}

      {/* Panel-mode status chrome (top-right, over the visible video edge). */}
      {overlay !== 'none' && playing && (
        <View style={styles.chrome} pointerEvents="none">
          {playing.isLive && <Text style={styles.chromeLive}>● LIVE</Text>}
          <Text style={styles.chromeTitle} numberOfLines={1}>{playing.title}</Text>
          {source && <Text style={source === 'p2p' ? styles.srcP2P : styles.srcCDN}>{source.toUpperCase()}</Text>}
          {source !== 'cdn' && peers != null && <Text style={styles.dim}>{peers} peer{peers === 1 ? '' : 's'}</Text>}
          {buffering && <ActivityIndicator size="small" color={theme.colors.primary} />}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.videoBackground },
  catcherTV: { position: 'absolute', top: 80, bottom: 80, left: 0, right: 0 },
  zapUp: { position: 'absolute', top: 0, left: 0, right: 0, height: 80 },
  zapDown: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 80 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  buffering: { position: 'absolute', top: theme.safeY, right: theme.safeX },
  panels: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', paddingVertical: theme.safeY, paddingLeft: theme.safeX / 2 },
  railPane: { width: '20%', backgroundColor: theme.colors.overlayStrong, borderRadius: 12, paddingVertical: theme.spacing(1), marginRight: 2 },
  listPane: { width: theme.isTV ? '38%' : '52%' },
  infoPane: { flex: 1, backgroundColor: theme.colors.overlay, borderTopRightRadius: 12, borderBottomRightRadius: 12 },
  chrome: { position: 'absolute', top: theme.safeY, right: theme.safeX, flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: '38%' },
  chromeLive: { color: theme.colors.live, fontWeight: '800', fontSize: theme.type.caption },
  chromeTitle: { color: theme.colors.text, fontSize: theme.type.caption, fontWeight: '700', flexShrink: 1 },
  srcP2P: { color: theme.colors.accent, fontWeight: '800', fontSize: theme.type.caption - 1 },
  srcCDN: { color: theme.colors.live, fontWeight: '800', fontSize: theme.type.caption - 1 },
  dim: { color: theme.colors.textDim, fontSize: theme.type.caption },
  errorTitle: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700' },
  osd: {
    position: 'absolute', left: theme.safeX, bottom: theme.safeY + theme.spacing(1),
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: theme.colors.overlayStrong, borderRadius: 10,
    paddingHorizontal: theme.spacing(1.5), paddingVertical: theme.spacing(1), maxWidth: '60%'
  },
  osdNumber: { color: theme.colors.accent, fontSize: theme.type.title, fontWeight: '800', fontVariant: ['tabular-nums'] },
  osdMain: { flexShrink: 1 },
  osdTitle: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' },
  osdDesc: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 2 },
  osdLive: { color: theme.colors.onPrimary, backgroundColor: theme.colors.live, fontSize: theme.type.caption - 2, fontWeight: '800', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' }
})
