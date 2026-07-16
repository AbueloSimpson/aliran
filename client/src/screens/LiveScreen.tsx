// Live TV — ONE fullscreen video surface with overlay panels (the reorganization at
// the heart of the redesign; replaces the old Home→Player navigation for live).
//
//   base   : fullscreen <AliranVideo> — playback NEVER stops while browsing. Fullscreen
//            is CLEAN: no status chrome, no LIVE/peer/source diagnostics (those live in
//            Settings). A tap/OK surfaces the bottom OSD (channel identity) which fades.
//   overlay1: CategoryRail + ChannelListPanel — the "left menu" browse & zap surface;
//            selecting a row switches the stream AND collapses to fullscreen (the zap
//            OSD confirms the channel for a moment). It has no manual close control —
//            it auto-hides after inactivity (any touch/focus inside bumps the timer).
//   overlay2: ChannelInfoPanel — channel detail (long-press a row); honest
//            "No program information" placeholder where an EPG lands later (D2)
//
// Navigation: from fullscreen BACK opens the left menu; tap/OK peeks the bottom OSD.
// From the left menu BACK exits to Menu; from channel detail BACK returns to the list.
// TV: D-pad up/down while fullscreen zaps prev/next across the whole curated channel
// order (the numbers' order). Zap rides the FOCUS ENGINE (invisible focus strips
// above/below the select-catcher band) — react-native-tvos on Android does not dispatch
// HWEvents to useTVEventHandler while a view holds focus, so key handling must be
// focus-based (the S7 lesson).
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet, Platform, BackHandler, TVFocusGuideView } from 'react-native'
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
// The left menu (browse overlay) has no manual close control — it auto-hides this long
// after the last interaction, fading back to clean fullscreen video.
const MENU_IDLE_MS = 6000

// 24h HH:MM wall clock for the OSD (manual format — no Intl dependency under Hermes).
function clockText (d: Date) {
  const h = d.getHours(); const m = d.getMinutes()
  return `${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}`
}

// BACK from the left menu falls through to the navigator's default (pop → Menu), so this
// screen never needs the navigation prop directly.
export function LiveScreen ({ route }: Props) {
  const [streams, setStreams] = useState<Stream[]>(backend.streams)
  const [favorites, setFavorites] = useState<string[]>(backend.favorites)
  const [playingId, setPlayingId] = useState<string | null>(() => route.params?.streamId ?? pickHero(backend.streams)?.id ?? null)
  const [overlay, setOverlay] = useState<Overlay>(route.params?.streamId ? 'none' : 'list')
  const [infoStream, setInfoStream] = useState<Stream | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [osd, setOsd] = useState<Stream | null>(null)
  const [now, setNow] = useState(() => new Date())
  const osdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuIdle = useRef<ReturnType<typeof setTimeout> | null>(null)

  const overlayRef = useRef(overlay); overlayRef.current = overlay
  const playingIdRef = useRef(playingId); playingIdRef.current = playingId

  useEffect(() => {
    backend.requestPrefs() // favorites may not be loaded yet
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(m.streams)
      if (m.type === 'prefs') setFavorites(m.favorites)
      // Broadcaster rotated the channel we're watching (source change / restart): the SDK
      // re-resolved the feed behind the same URL and AliranVideo remounts. Clear any prior
      // playback error (that had unmounted the video) so it re-mounts onto the fresh feed.
      if (m.type === 'feed-changed' && m.streamId === playingIdRef.current) {
        setError(null)
      }
    })
  }, [])

  useEffect(() => () => { if (osdTimer.current) clearTimeout(osdTimer.current); clearMenuIdle() }, [])

  // Wall clock for the OSD — tick twice a minute so the minute never lags far behind.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(t)
  }, [])

  // Left menu auto-hide: refresh the idle timer while the browse overlay is up; clear it
  // in fullscreen (no timer there) and on channel detail (stays until you leave it).
  useEffect(() => {
    if (overlay === 'list') bumpMenuIdle()
    else clearMenuIdle()
    return clearMenuIdle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay])

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

  function clearMenuIdle () { if (menuIdle.current) { clearTimeout(menuIdle.current); menuIdle.current = null } }
  // Called on any touch/focus inside the panels; only the left menu auto-hides, so this
  // is a no-op on channel detail (which stays until you leave it) and in fullscreen.
  function bumpMenuIdle () {
    if (overlayRef.current !== 'list') return
    clearMenuIdle()
    menuIdle.current = setTimeout(() => setOverlay('none'), MENU_IDLE_MS)
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

  // BACK: channel detail → list; the left menu exits to Menu; fullscreen opens the
  // left menu (tap/OK peeks the bottom OSD instead — see the catcher below).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (overlayRef.current === 'info') { setOverlay('list'); return true }
      if (overlayRef.current === 'list') return false // left menu: default = back to Menu
      setOverlay('list'); return true // fullscreen: open the left menu
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
          resizeMode="contain"
          onSource={(_url, s) => setSource(s)}
          onFallback={() => setSource('cdn')}
          onSourceChanged={({ source: s }) => setSource(s)}
          onPeers={setPeers}
          onError={setError}
        />
      )}

      {/* Tap/select catcher: fullscreen -> peek the bottom OSD (channel identity), which
          fades on its own. BACK opens the left menu. On TV it is a middle band so the zap
          strips sit strictly above/below it in the focus engine's geometry. */}
      {overlay === 'none' && (
        <>
          <Pressable
            ref={catcherRef}
            style={Platform.isTV ? styles.catcherTV : StyleSheet.absoluteFill}
            hasTVPreferredFocus
            onPress={() => { if (playing) showOsd(playing) }}
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

      {/* Bottom OSD: derived number + name, auto-hides. Shown on zap and on a
          fullscreen tap/OK — no LIVE/peer/source chrome (kept in Settings). */}
      {osd && overlay === 'none' && (
        <View style={styles.osd} pointerEvents="none">
          {!!osd.logo && <Image source={{ uri: osd.logo }} style={styles.osdLogo} resizeMode="contain" />}
          <Text style={styles.osdNumber}>{formatChannelNumber(numbers.get(osd.id))}</Text>
          <View style={styles.osdMain}>
            <Text style={styles.osdTitle} numberOfLines={1}>{osd.title}</Text>
            {!!osd.description && <Text style={styles.osdDesc} numberOfLines={1}>{osd.description}</Text>}
          </View>
          <View style={styles.osdDivider} />
          <Text style={styles.osdClock}>{clockText(now)}</Text>
        </View>
      )}

      {overlay !== 'none' && activeCategory && (
        <View style={styles.panels} onTouchStart={bumpMenuIdle}>
          <FocusPane autoFocus style={styles.railPane}>
            <CategoryRail categories={categories} selected={activeCategory} onSelect={setCategory} onActivity={bumpMenuIdle} />
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
                onActivity={bumpMenuIdle}
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

    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.videoBackground },
  catcherTV: { position: 'absolute', top: 80, bottom: 80, left: 0, right: 0 },
  zapUp: { position: 'absolute', top: 0, left: 0, right: 0, height: 80 },
  zapDown: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 80 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  panels: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', paddingVertical: theme.safeY, paddingLeft: theme.safeX / 2 },
  railPane: { width: '20%', backgroundColor: theme.colors.overlayStrong, borderRadius: 12, paddingVertical: theme.spacing(1), marginRight: 2 },
  listPane: { width: theme.isTV ? '38%' : '52%' },
  infoPane: { flex: 1, backgroundColor: theme.colors.overlay, borderTopRightRadius: 12, borderBottomRightRadius: 12 },
  dim: { color: theme.colors.textDim, fontSize: theme.type.caption },
  errorTitle: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700' },
  osd: {
    position: 'absolute', left: theme.safeX, bottom: theme.safeY + theme.spacing(1.5),
    flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.25),
    backgroundColor: theme.colors.overlayStrong, borderRadius: 12,
    paddingHorizontal: theme.spacing(1.5), paddingVertical: theme.spacing(0.75), maxWidth: '80%'
  },
  osdLogo: { width: theme.isTV ? 60 : 44, height: theme.isTV ? 34 : 24, borderRadius: 4 },
  osdNumber: { color: theme.colors.accent, fontSize: theme.type.title, fontWeight: '800', fontVariant: ['tabular-nums'] },
  osdMain: { flexShrink: 1 },
  osdTitle: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' },
  osdDesc: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 2 },
  osdDivider: { width: 1, height: 24, backgroundColor: theme.colors.textDim, opacity: 0.3 },
  osdClock: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700', fontVariant: ['tabular-nums'] }
})
