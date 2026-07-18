// Live TV — ONE fullscreen video surface with overlay panels (the reorganization at
// the heart of the redesign; replaces the old Home→Player navigation for live).
//
//   base   : fullscreen <AliranVideo> — playback NEVER stops while browsing. Over it a
//            persistent bottom menu (NowPlayingBar) carries the channel identity + touch
//            controls (Channels / Info / Favorite) whenever a channel is open and the
//            left menu is gone. A top-right ChannelChangeIndicator shows tuning progress
//            (spinner + 0→100%) while a zap/select replicates the new feed.
//   overlay1: CategoryRail + ChannelListPanel — the "left menu" browse & zap surface;
//            selecting a row switches the stream AND collapses to fullscreen. It has no
//            manual close control — it auto-hides after inactivity (any touch/focus
//            inside bumps the timer), and BACK collapses it to fullscreen.
//   overlay2: ChannelInfoPanel — channel detail (Info button / long-press a row); honest
//            "No program information" placeholder where an EPG lands later (D2)
//
// Navigation: fullscreen TAP/OK opens the left menu; BACK from the left menu collapses
// back to fullscreen; BACK from fullscreen exits to Menu; BACK from channel detail
// returns to the list. Re-entering Live RESUMES the last channel watched this session
// (lastStreamId) instead of snapping back to the hero.
// TV: D-pad up/down while fullscreen zaps prev/next across the whole curated channel
// order (the numbers' order). Zap rides the FOCUS ENGINE (invisible focus strips
// above/below the select-catcher band) — react-native-tvos on Android does not dispatch
// HWEvents to useTVEventHandler while a view holds focus, so key handling must be
// focus-based (the S7 lesson). The bottom menu's touch buttons are phone-only so they
// stay out of that focus path.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, Platform, BackHandler, TVFocusGuideView, Animated } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { AliranVideo, type TuneEvent } from '@aliran/react-native'
import type { RootStackParamList } from '../App'
import { backend, type Stream } from '../worklet'
import { channelNumbers, groupByCategory, pickHero, sortByCuration } from '../catalog'
import { CategoryRail } from '../components/CategoryRail'
import { ChannelListPanel } from '../components/ChannelListPanel'
import { ChannelInfoPanel } from '../components/ChannelInfoPanel'
import { ChannelChangeIndicator, type ChannelChangePhase } from '../components/ChannelChangeIndicator'
import { NowPlayingBar } from '../components/NowPlayingBar'
import { SectionLoading } from '../components/SectionLoading'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Live'>
type Overlay = 'none' | 'list' | 'info'

// On phone TVFocusGuideView is just a View; on TV autoFocus restores focus memory (S7).
const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

// The left menu (browse overlay) has no manual close control — it auto-hides this long
// after the last interaction, fading back to clean fullscreen video.
const MENU_IDLE_MS = 6000

// The bottom now-playing bar (phone) fades away this long after it appears / the last
// interaction, for an unobstructed picture; a touch in the bottom reveal zone brings it
// back. TV keeps the bar always-on (it lives in the D-pad path, not a touch surface).
const BAR_IDLE_MS = 5000

// Last channel watched THIS session. Module-level so it survives leaving Live for the
// Menu and coming back (the native stack unmounts the screen in between): re-entering
// Live resumes it instead of the hero pick — "the channel control returns to where you
// left it". In-memory only (per the request: on the trip out to the menu, not restart).
let lastStreamId: string | null = null

// 24h HH:MM wall clock for the bottom menu (manual format — no Intl under Hermes).
function clockText (d: Date) {
  const h = d.getHours(); const m = d.getMinutes()
  return `${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}`
}

export function LiveScreen ({ route }: Props) {
  const [streams, setStreams] = useState<Stream[]>(backend.streams)
  const [favorites, setFavorites] = useState<string[]>(backend.favorites)
  const [playingId, setPlayingId] = useState<string | null>(() => route.params?.streamId ?? lastStreamId ?? pickHero(backend.streams)?.id ?? null)
  const [overlay, setOverlay] = useState<Overlay>((route.params?.streamId || lastStreamId) ? 'none' : 'list')
  const [infoStream, setInfoStream] = useState<Stream | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The top-right tuning indicator, driven SOLELY by <AliranVideo>'s onTune lifecycle
  // (single source of truth — the SDK knows when a tune starts, self-heals, and truly
  // plays; raw player events also fire for the PREVIOUS channel, which stuck/killed the
  // pill on the S22). id keys the pill so every tune replaces it atomically at 0%;
  // active flips false on 'playing' (snap to 100% + hold); null = no pill (error UI).
  const [tuneUI, setTuneUI] = useState<{ id: number; phase: ChannelChangePhase; active: boolean } | null>(null)
  const [now, setNow] = useState(() => new Date())
  const menuIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bottom bar auto-hide (phone): `barShown` gates mounting; `barOpacity` fades it.
  // TV never auto-hides (theme.isTV branch in armBarHide).
  const [barShown, setBarShown] = useState(true)
  const barIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const barOpacity = useRef(new Animated.Value(1)).current

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

  useEffect(() => clearMenuIdle, [])

  // Remember the channel across a trip out to the Menu (see lastStreamId).
  useEffect(() => { if (playingId) lastStreamId = playingId }, [playingId])

  // Wall clock for the bottom menu — tick twice a minute so the minute never lags far behind.
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

  // Bottom bar: reveal + re-arm the fade whenever fullscreen (re)appears or the channel
  // changes (so a zap flashes the new now-playing), then it fades out on its own.
  useEffect(() => {
    if (overlay === 'none') showBar()
    else clearBarIdle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, playingId])
  useEffect(() => clearBarIdle, [])

  const numbers = useMemo(() => channelNumbers(streams), [streams])
  const groups = useMemo(() => groupByCategory(streams), [streams])
  const categories = useMemo(() => Object.keys(groups), [groups])
  const activeCategory = category && groups[category] ? category : categories[0] ?? null
  const list = activeCategory ? groups[activeCategory] : []
  const playing = streams.find(s => s.id === playingId) ?? null

  // First streams push after a cold navigation: start the hero channel (the tuning
  // indicator arms itself — mounting <AliranVideo> fires onTune 'start').
  useEffect(() => {
    if (!playingId && streams.length) setPlayingId(pickHero(streams)?.id ?? streams[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams])

  function play (s: Stream, { collapse = false }: { collapse?: boolean } = {}) {
    if (s.id !== playingId) {
      setPlayingId(s.id)
      setPeers(null)
      setError(null)
      // The tuning indicator follows via onTune 'start' (the streamId prop change).
    } else if (error) {
      // The friendly tune-timeout says "switch to it again to retry" — honor re-selecting
      // the SAME channel: clearing the error remounts <AliranVideo>, which starts a fresh
      // tune (mount → play() → onTune 'start'). Without this the retry was a no-op and
      // the only way out was a trip through the Menu (found live 2026-07-16, broadcaster
      // outage on the VPS).
      setError(null)
    }
    if (collapse) setOverlay('none')
  }

  // Tune lifecycle → tuning pill. 'start' shows a FRESH pill (the id keys the component,
  // so a tune that begins while the previous pill is still up replaces it atomically at
  // 0% — no inherited progress); 'retune'/'reconnect' relabel it while the SDK
  // self-heals; 'playing' — the first real playback of the CURRENT tune, edge-proof
  // against mid-tune remounts — completes it (snap to 100%, brief hold, hide).
  function onTune (e: TuneEvent) {
    if (e.phase === 'playing') setTuneUI(t => (t && t.id === e.id ? { ...t, active: false } : t))
    else setTuneUI({ id: e.id, phase: e.phase === 'start' ? 'tuning' : e.phase, active: true })
  }

  // Bottom bar: reveal (fade in) + arm the auto-hide; a bottom-zone touch calls this.
  function clearBarIdle () { if (barIdle.current) { clearTimeout(barIdle.current); barIdle.current = null } }
  function armBarHide () {
    clearBarIdle()
    if (theme.isTV) return // TV: the bar is always on (D-pad model, not touch)
    barIdle.current = setTimeout(() => {
      Animated.timing(barOpacity, { toValue: 0, duration: 350, useNativeDriver: true })
        .start(({ finished }) => { if (finished) setBarShown(false) })
    }, BAR_IDLE_MS)
  }
  function showBar () {
    clearBarIdle()
    barOpacity.stopAnimation()
    setBarShown(true)
    Animated.timing(barOpacity, { toValue: 1, duration: 160, useNativeDriver: true }).start()
    armBarHide()
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

  // BACK: channel detail → list; the left menu → fullscreen (collapse, hiding it);
  // fullscreen → default (pop to Menu). Fullscreen is OPENED via a tap/OK on the catcher.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (overlayRef.current === 'info') { setOverlay('list'); return true }
      if (overlayRef.current === 'list') { setOverlay('none'); return true } // hide the left menu
      return false // fullscreen: default back = exit to Menu
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
          onTune={onTune}
          // Live-edge freeze self-heal (log only — onTune 'start' re-arms the pill).
          onStall={() => console.log('[live] stall resync', playingIdRef.current)}
          onError={(msg) => { setError(msg); setTuneUI(null) }} // pill hands off to the error UI
        />
      )}

      {/* Fullscreen surface: TAP/OK opens the left menu (BACK exits to Menu). On TV the
          catcher is a middle band so the zap strips sit strictly above/below it in the
          focus engine's geometry. The bottom menu renders on top of the catcher so its
          buttons catch their own taps while the rest of the surface opens the left menu. */}
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
          {playing && barShown && (
            <Animated.View style={[styles.barFade, { opacity: barOpacity }]} pointerEvents="box-none">
              <NowPlayingBar
                stream={playing}
                number={numbers.get(playing.id)}
                clock={clockText(now)}
                favorite={favorites.includes(playing.id)}
                onChannels={() => setOverlay('list')}
                onInfo={() => { setInfoStream(playing); setOverlay('info') }}
                onToggleFavorite={() => { showBar(); backend.toggleFavorite(playing.id) }}
              />
            </Animated.View>
          )}
          {/* Bar hidden (phone): a touch in the bottom zone brings it back. A tap higher
              up still falls through to the catcher and opens the left menu. */}
          {playing && !barShown && !Platform.isTV && (
            <Pressable style={styles.barRevealZone} onPress={showBar} />
          )}
        </>
      )}

      {error && (
        <View style={styles.center} pointerEvents="none">
          <Text style={styles.errorTitle}>Playback failed</Text>
          <Text style={styles.dim}>{error}</Text>
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

      {/* Top-right tuning indicator — keyed by tune id so every tune starts a fresh pill;
          pointerEvents none so it never intercepts a tap meant for the video/bottom menu. */}
      {tuneUI && (
        <ChannelChangeIndicator
          key={tuneUI.id}
          active={tuneUI.active}
          phase={tuneUI.phase}
          number={playing ? numbers.get(playing.id) : undefined}
          title={playing?.title}
        />
      )}

    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.videoBackground },
  catcherTV: { position: 'absolute', top: 80, bottom: 80, left: 0, right: 0 },
  // Full-screen wrapper so the NowPlayingBar's own absolute positioning still anchors
  // to the bottom while we fade the whole thing; box-none lets non-button taps reach
  // the catcher beneath. The bottom reveal zone re-shows the faded bar on touch.
  barFade: { ...StyleSheet.absoluteFillObject },
  barRevealZone: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 150 },
  zapUp: { position: 'absolute', top: 0, left: 0, right: 0, height: 80 },
  zapDown: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 80 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  panels: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', paddingVertical: theme.safeY, paddingLeft: theme.safeX / 2 },
  railPane: { width: '20%', backgroundColor: theme.colors.overlayStrong, borderRadius: 12, paddingVertical: theme.spacing(1), marginRight: 2 },
  listPane: { width: theme.isTV ? '38%' : '52%' },
  infoPane: { flex: 1, backgroundColor: theme.colors.overlay, borderTopRightRadius: 12, borderBottomRightRadius: 12 },
  dim: { color: theme.colors.textDim, fontSize: theme.type.caption },
  errorTitle: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700' }
})
