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
// VOD (S8a): library titles play on this same surface — the bottom bar grows a
// seek/pause transport (phone), the SDK's live self-heal disarms itself (port
// recordType), and CH+/CH- stays a live-only ring: zapping from a title lands on
// channel 001 and re-arms every live behavior.
// Guide overlay (WS7, phone only): the full time-grid guide is a MODE of this screen
// rather than a separate screen, so the single video surface keeps playing while the
// viewer browses the schedule. Portrait renders the video as a 16:9 strip on top
// with the grid below (the YouTube-TV/Pluto phone pattern — the AliranVideo element
// only changes STYLE, never tree position, so it never remounts); landscape lays the
// grid over the fullscreen video like the channel list panel. Entered via the Menu
// tile (route param `guide`) or OK/tap on the already-playing row of the channel
// list. TV keeps the dedicated Guide route.
// Orientation defaults (S22 round 3, phone): PORTRAIT's default browse surface is
// the guide — rotating to portrait raises it (collapsing list/info into it), tapping
// portrait fullscreen opens it, and portrait BACK order is fullscreen → guide →
// Menu (the guide strip's tap expands to fullscreen). LANDSCAPE's default stays
// clean fullscreen — tap opens the left menu, BACK collapses guide/list to
// fullscreen then pops, and rotating to landscape collapses the guide. A playback
// error suppresses every auto-guide rule so the error + retry flow stays visible.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, Platform, BackHandler, TVFocusGuideView, Animated, useWindowDimensions } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { AliranVideo, SelectedTrackType, type AliranVideoHandle, type TuneEvent, type SelectedTrack, type AudioTrack, type TextTrack } from '@aliran/react-native'
import type { RootStackParamList } from '../App'
import { getLocale, useI18n } from '@aliran/i18n'
import { backend, type Stream } from '../worklet'
import { markUnlocked, needsPin, visibleStreams } from '../parental'
import { PinEntryModal } from '../components/PinModal'
import { channelNumbers, categoryModel, splitCategory, subLabel, pickHero, zapOrder, isVod } from '../catalog'
import { CategoryRail } from '../components/CategoryRail'
import { ChannelListPanel } from '../components/ChannelListPanel'
import { ChannelInfoPanel } from '../components/ChannelInfoPanel'
import { GuidePanel } from '../components/GuidePanel'
import { ChannelChangeIndicator, type ChannelChangePhase } from '../components/ChannelChangeIndicator'
import { NowPlayingBar } from '../components/NowPlayingBar'
import { TrackMenu } from '../components/TrackMenu'
import { ReportSheet } from '../components/ReportSheet'
import { SectionLoading } from '../components/SectionLoading'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Live'>
type Overlay = 'none' | 'list' | 'info' | 'guide'

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

export function LiveScreen ({ route, navigation }: Props) {
  const { t } = useI18n()
  const [streams, setStreams] = useState<Stream[]>(() => visibleStreams(backend.streams))
  const [favorites, setFavorites] = useState<string[]>(backend.favorites)
  // Parental gate (device policy): a restricted channel about to play while the PIN
  // is set but this session hasn't unlocked yet — the PIN modal resolves it.
  const [pinTarget, setPinTarget] = useState<Stream | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(() => {
    const candidate = route.params?.streamId ?? lastStreamId ?? pickHero(visibleStreams(backend.streams))?.id ?? null
    const s = backend.streams.find(x => x.id === candidate)
    return s && needsPin(s) ? null : candidate // the mount effect below raises the PIN modal
  })
  const [overlay, setOverlay] = useState<Overlay>(() => {
    // The Menu's GUIDE tile (phone): open straight into the guide mode around the
    // resumed/hero channel. TV never sets it — the Guide route stays its surface.
    if (route.params?.guide && !theme.isTV) return 'guide'
    return (route.params?.streamId || lastStreamId) ? 'none' : 'list'
  })
  const [infoStream, setInfoStream] = useState<Stream | null>(null)
  // Two-level category browse: `selected` is the group key whose channels show
  // ('All' | 'Anime' | 'Anime/Español'); `drillParent` is the parent whose sub-categories
  // the rail is currently showing (null = top-level rail). See CategoryRail.
  const [selected, setSelected] = useState<string>('All')
  const [drillParent, setDrillParent] = useState<string | null>(null)
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
  // Subtitle/CC + audio tracks the player found in the CURRENT stream, plus the current
  // picks (default subtitles Off, audio = the stream's default). The CC button + TrackMenu
  // are phone-only. These reset whenever the channel changes (a new stream's tracks differ).
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([])
  const [textTracks, setTextTracks] = useState<TextTrack[]>([])
  const [selectedText, setSelectedText] = useState<SelectedTrack>({ type: SelectedTrackType.DISABLED })
  const [selectedAudio, setSelectedAudio] = useState<SelectedTrack | undefined>(undefined)
  const [showTracks, setShowTracks] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const menuIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bottom bar auto-hide (phone): `barShown` gates mounting; `barOpacity` fades it.
  // TV never auto-hides (theme.isTV branch in armBarHide).
  const [barShown, setBarShown] = useState(true)
  const barIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const barOpacity = useRef(new Animated.Value(1)).current
  // vod transport (S8a): playhead position (whole seconds — one re-render per second,
  // not per progress tick), runtime (player-reported on load, catalog durationSec until
  // then), and the app-owned pause. Live channels ignore all three.
  const [vodPos, setVodPos] = useState(0)
  const [vodDur, setVodDur] = useState(0)
  const [vodPaused, setVodPausedState] = useState(false)
  const vodPausedRef = useRef(false)
  // Ref+state in one step: armBarHide reads the ref synchronously (the bar must never
  // fade away over a paused title — the play control would vanish with it).
  function setVodPaused (v: boolean) { vodPausedRef.current = v; setVodPausedState(v) }
  // Imperative seek into the SDK's player (vod transport; see AliranVideoHandle).
  const videoHandle = useRef<AliranVideoHandle | null>(null)
  // In-app volume (QA round 3): rn-video's volume/muted props, session-local — the
  // OS keeps hardware volume, this is the trim on top. Phone-only control (S7).
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)

  const overlayRef = useRef(overlay); overlayRef.current = overlay
  const playingIdRef = useRef(playingId); playingIdRef.current = playingId
  const drillRef = useRef(drillParent); drillRef.current = drillParent
  const selectedRef = useRef(selected); selectedRef.current = selected

  // Guide-mode geometry (phone): portrait puts the ONE video surface as a 16:9
  // strip on top of the grid; landscape overlays the grid on the fullscreen video.
  // Only the video's STYLE changes between these layouts (same element, same tree
  // position), so the player never remounts and playback never stops. Lives up here
  // (not by the render) because the orientation state machine below and the BACK
  // handler read `portrait` too.
  const { width: winW, height: winH } = useWindowDimensions()
  const portrait = winH >= winW
  const stripH = Math.round(winW * 9 / 16)
  const portraitRef = useRef(portrait); portraitRef.current = portrait
  const errorRef = useRef(error); errorRef.current = error

  useEffect(() => {
    backend.requestPrefs() // favorites may not be loaded yet
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(visibleStreams(m.streams))
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

  // The Guide tuned a channel while THIS screen stayed mounted (Guide sits above Live
  // in the stack, so navigate('Live') pops back with fresh params instead of
  // remounting): honor the param like a row select. tuneKey (a fresh stamp per Guide
  // tune) rides the deps because a value-equal streamId alone would never re-fire the
  // effect (re-tuning the channel the params already name). A param matching what
  // already plays is a no-op, so the mount-time path (initial state above, no
  // tuneKey) is undisturbed.
  useEffect(() => {
    const id = route.params?.streamId
    if (!id || id === playingIdRef.current) return
    const s = backend.streams.find(x => x.id === id)
    if (s) play(s, { collapse: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.streamId, route.params?.tuneKey])

  // navigate('Live', { guide: true }) against an ALREADY-MOUNTED Live (the stack
  // reuses it): raise the guide overlay like the mount-time path above did.
  useEffect(() => {
    // Error-gated like every other guide entry: the guide's opaque bed must never
    // cover the error text (the grid is a retry surface, but the message comes first).
    if (route.params?.guide && !theme.isTV && !errorRef.current) setOverlay('guide')
  }, [route.params?.guide])

  // Orientation state machine (phone, S22 round 3): each orientation has a DEFAULT
  // browse surface — portrait = the guide (video strip + grid), landscape = clean
  // fullscreen with the side panel one tap away. Rotating to portrait raises the
  // guide over fullscreen AND collapses the side panels into it (list/info are
  // landscape furniture; one browse surface per orientation); rotating to landscape
  // collapses the guide back to fullscreen. Fires only on an actual orientation
  // CHANGE (prevPortrait), so it never fights the mount-time overlay choice or the
  // route-param guide effect above. Suppressed while a playback error is up —
  // auto-raising the guide would bury the error text (and its retry instruction)
  // under the grid's opaque bed, exactly what onError's collapse prevents.
  const prevPortrait = useRef(portrait)
  useEffect(() => {
    const was = prevPortrait.current
    prevPortrait.current = portrait
    if (theme.isTV || was === portrait || errorRef.current) return
    if (portrait) setOverlay('guide')
    else setOverlay((o) => (o === 'guide' ? 'none' : o))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portrait])

  // A new channel has different tracks — clear the picker so the previous channel's
  // tracks/selection don't carry over, reset subtitles to Off, and close the menu.
  // The vod transport resets with them: leaving a title (for live OR another title)
  // must re-enter cleanly — unpaused, playhead at 0, runtime from the new record's
  // catalog durationSec until the player reports the real one (onLoad).
  useEffect(() => {
    setAudioTracks([]); setTextTracks([])
    setSelectedText({ type: SelectedTrackType.DISABLED }); setSelectedAudio(undefined)
    setShowTracks(false)
    setVodPaused(false); setVodPos(0)
    const s = backend.streams.find(x => x.id === playingId)
    setVodDur(s && isVod(s) ? s.durationSec ?? 0 : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingId])

  // Wall clock for the bottom menu — tick twice a minute so the minute never lags far behind.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(timer)
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
  const model = useMemo(() => categoryModel(streams), [streams])
  // `selected` may reference a group that vanished after a catalog change; fall back to All.
  const activeKey = model.groups[selected] ? selected : 'All'
  const list = model.groups[activeKey] ?? []
  // Rail contents: top-level categories, or (when drilled) the parent's sub-categories.
  const inDrill = drillParent != null && (model.subs[drillParent]?.length ?? 0) > 0
  // Every rail name but one is the OPERATOR's own category and is never translated;
  // 'All' is the everything-group this app adds itself, so it is the only label here
  // that comes out of the catalog.
  const railItems = inDrill
    ? model.subs[drillParent!].map((key) => ({ key, label: subLabel(key) }))
    : model.top.map((key) => ({ key, label: key === 'All' ? t('live.all') : key, hasChildren: (model.subs[key]?.length ?? 0) > 0 }))
  const railSelected = inDrill ? activeKey : splitCategory(activeKey)[0] // top view highlights the parent
  const listHeading = activeKey === 'All' ? t('live.channels') : splitCategory(activeKey).filter((x): x is string => !!x).map((x) => x.toLocaleUpperCase(getLocale())).join('  ›  ')
  const playing = streams.find(s => s.id === playingId) ?? null
  // The playing record is a vod library title (S8a): transport UI on the bar, pause is
  // app-owned, and the SDK's live self-heal is off (it keys on the port recordType).
  const playingVod = !!playing && isVod(playing)

  // A restricted entry channel (jumped in from Favorites/Search, or resumed):
  // raise the PIN modal once on mount instead of autoplaying it.
  useEffect(() => {
    const candidate = route.params?.streamId ?? lastStreamId
    if (playingId || !candidate) return
    const s = backend.streams.find(x => x.id === candidate)
    if (s && needsPin(s)) setPinTarget(s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // First streams push after a cold navigation: start the hero channel (the tuning
  // indicator arms itself — mounting <AliranVideo> fires onTune 'start').
  useEffect(() => {
    if (!playingId && !pinTarget && streams.length) setPlayingId(pickHero(streams)?.id ?? streams[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams])

  function play (s: Stream, { collapse = false }: { collapse?: boolean } = {}) {
    if (needsPin(s)) { setPinTarget(s); return } // resolved by the PIN modal
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

  // Rail tap. Top-level: a parent WITH sub-categories drills in (rail then shows its subs,
  // list shows all of that parent); a leaf category just scopes the list. Drilled: tapping
  // a sub scopes the list; tapping the already-selected sub deselects it (back to the
  // sub-select, showing all of the parent). Any pick shows the channel LIST — from the
  // channel-detail (info) overlay this leaves detail (else the tap looked like it did nothing).
  function selectRail (key: string) {
    if (drillParent == null) {
      if ((model.subs[key]?.length ?? 0) > 0) { setDrillParent(key); setSelected(key) } // drill into a parent
      else setSelected(key)
    } else {
      setSelected(key === selected ? drillParent : key) // re-tap selected sub -> back to sub-select
    }
    setOverlay('list')
  }

  // Leave the drilled sub-category view, back to the top-level rail (parent stays selected).
  function exitDrill () {
    if (drillParent != null) setSelected(drillParent)
    setDrillParent(null)
    setOverlay('list')
  }

  // Tune lifecycle → tuning pill. 'start' shows a FRESH pill (the id keys the component,
  // so a tune that begins while the previous pill is still up replaces it atomically at
  // 0% — no inherited progress); 'retune'/'reconnect' relabel it while the SDK
  // self-heals; 'playing' — the first real playback of the CURRENT tune, edge-proof
  // against mid-tune remounts — completes it (snap to 100%, brief hold, hide).
  function onTune (e: TuneEvent) {
    if (e.phase === 'playing') setTuneUI(p => (p && p.id === e.id ? { ...p, active: false } : p))
    else setTuneUI({ id: e.id, phase: e.phase === 'start' ? 'tuning' : e.phase, active: true })
  }

  // Bottom bar: reveal (fade in) + arm the auto-hide; a bottom-zone touch calls this.
  function clearBarIdle () { if (barIdle.current) { clearTimeout(barIdle.current); barIdle.current = null } }
  function armBarHide () {
    clearBarIdle()
    if (theme.isTV) return // TV: the bar is always on (D-pad model, not touch)
    if (vodPausedRef.current) return // paused vod: the bar (and its play control) stays up
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
    // Re-check at fire time: a rotation can swap 'list' for 'guide' in the sliver
    // before the overlay watcher clears this timer — never collapse the fresh guide.
    menuIdle.current = setTimeout(() => { if (overlayRef.current === 'list') setOverlay('none') }, MENU_IDLE_MS)
  }

  // Fullscreen zap: prev/next over the LIVE catalog in curated order — the same
  // order the derived channel numbers follow (001, 002, …), like a TV's CH+/CH-.
  // (The category rail scopes the browse list, not the zap.) vod titles are not in
  // the ring (zapOrder): zapping FROM one lands on channel 001 — CH+/CH- is how you
  // leave a title back into live TV, and live behavior re-arms on that play().
  function zap (dir: 1 | -1) {
    const all = zapOrder(streams)
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
  // then the ladder splits by orientation (phone, S22 round 3). LANDSCAPE keeps the
  // original order: guide → fullscreen, fullscreen → default (pop to Menu).
  // PORTRAIT inverts the last pair — the guide is portrait's default surface, so
  // fullscreen BACK RAISES the guide and guide BACK leaves to the Menu (without the
  // inversion the viewer could never pop: none→guide→none would loop). While a
  // playback error is up the portrait raise is suppressed (fullscreen BACK pops as
  // before) so the error + retry flow stays visible.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // A screen stacked ABOVE a still-mounted Live (the Guide) leaves this listener
      // alive; it must not swallow that screen's BACK against its own stale overlay
      // state. The navigation object is stable, so reading isFocused() here is live.
      if (!navigation.isFocused()) return false
      if (overlayRef.current === 'guide') {
        // Portrait (phone): the guide IS the default surface — BACK exits to Menu.
        if (!theme.isTV && portraitRef.current) return false
        setOverlay('none'); return true // landscape guide mode → fullscreen
      }
      if (overlayRef.current === 'info') { setOverlay('list'); return true }
      if (overlayRef.current === 'list') {
        // Unwind the category drill before the overlay: sub selected -> back to sub-select;
        // drilled (no sub) -> back to the top-level rail; else hide the left menu.
        if (drillRef.current != null && selectedRef.current !== drillRef.current) { setSelected(drillRef.current); return true }
        if (drillRef.current != null) { setDrillParent(null); return true }
        setOverlay('none'); return true // hide the left menu
      }
      // Fullscreen: portrait raises the guide (portrait's default surface, unless a
      // playback error is up); landscape default back = exit to Menu.
      if (!theme.isTV && portraitRef.current && !errorRef.current) { setOverlay('guide'); return true }
      return false
    })
    return () => sub.remove()
  }, [navigation]) // stable identity — the listener registers once in practice

  const guideStrip = overlay === 'guide' && portrait

  if (!streams.length) return <SectionLoading section={t('menu.live')} hint={t('live.waitingForChannels')} />

  return (
    <View style={styles.container}>
      {playingId && !error && (
        <AliranVideo
          ref={videoHandle}
          backend={backend}
          style={guideStrip ? [styles.videoStrip, { height: stripH }] : undefined}
          streamId={playingId}
          controls={false}
          resizeMode="contain"
          paused={playingVod && vodPaused}
          onSource={(_url, s) => setSource(s)}
          onFallback={() => setSource('cdn')}
          onSourceChanged={({ source: s }) => setSource(s)}
          onPeers={setPeers}
          selectedAudioTrack={selectedAudio}
          selectedTextTrack={selectedText}
          onAudioTracks={setAudioTracks}
          onTextTracks={setTextTracks}
          onTune={onTune}
          // Live-edge freeze self-heal (log only — onTune 'start' re-arms the pill;
          // the SDK disarms the whole ladder for vod).
          onStall={() => console.log('[live] stall resync', playingIdRef.current)}
          // Pill hands off to the error UI — and the guide overlay collapses so the
          // error text (with its retry instruction) is never hidden under the grid's
          // opaque bed.
          onError={(msg) => { setError(msg); setTuneUI(null); setOverlay((o) => (o === 'guide' ? 'none' : o)) }}
          // vod transport feed (chained by the SDK behind its own handlers): playhead
          // in whole seconds (one re-render/second), the player-reported runtime, and
          // end-of-title parking the transport on ▶ (no auto-anything — the viewer
          // seeks back, replays, or zaps out).
          videoProps={{
            // In-app volume rides every playback (QA round 3).
            volume: muted ? 0 : volume,
            muted,
            ...(playingVod ? {
              onProgress: (e: { currentTime: number }) => setVodPos(Math.floor(e.currentTime)),
              onLoad: (e: { duration?: number }) => { if (e.duration && e.duration > 0) setVodDur(e.duration) },
              onEnd: () => { setVodPaused(true); showBar() }
            } : {})
          }}
        />
      )}

      {/* Fullscreen surface: TAP/OK opens the browse surface for the orientation —
          landscape (and TV) the left menu, phone portrait the GUIDE (portrait's
          default browse surface, S22 round 3) unless a playback error is up (the
          list keeps the same-channel retry reachable and never covers the error
          text). On TV the catcher is a middle band so the zap strips sit strictly
          above/below it in the focus engine's geometry. The bottom menu renders on
          top of the catcher so its buttons catch their own taps while the rest of
          the surface opens the overlay. */}
      {overlay === 'none' && (
        <>
          <Pressable
            ref={catcherRef}
            style={Platform.isTV ? styles.catcherTV : StyleSheet.absoluteFill}
            hasTVPreferredFocus
            onPress={() => setOverlay(!theme.isTV && portrait && !error ? 'guide' : 'list')}
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
                onReport={() => { showBar(); setReportOpen(true) }}
                hasTracks={textTracks.length > 0 || audioTracks.length > 1}
                onTracks={() => { showBar(); setShowTracks(true) }}
                vod={playingVod ? { position: vodPos, duration: vodDur, paused: vodPaused } : null}
                onTogglePause={() => {
                  // ▶ on a finished title replays from the top (unpausing at the end
                  // is a no-op in the player — it is already "ended").
                  if (vodPausedRef.current && vodDur > 0 && vodPos >= Math.floor(vodDur) - 1) { videoHandle.current?.seek(0); setVodPos(0) }
                  setVodPaused(!vodPausedRef.current); showBar()
                }}
                onSeek={(sec) => {
                  videoHandle.current?.seek(sec)
                  // Optimistic playhead: while paused no progress event will confirm
                  // the jump, and the bar must not snap back under the finger.
                  setVodPos(Math.floor(sec))
                  showBar()
                }}
                volume={volume}
                muted={muted}
                onVolume={(v, m) => { setVolume(v); setMuted(m); showBar() }}
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
          <Text style={styles.errorTitle}>{t('live.playbackFailed')}</Text>
          {/* The engine's own words, verbatim: SDK error prose stays English (S56). */}
          <Text style={styles.dim}>{error}</Text>
        </View>
      )}

      {/* Guide mode (phone): the shared time-grid around the playing stream. Tuning
          from the grid switches the stream IN PLACE — portrait keeps the guide up
          (the strip above shows the pick, the YouTube-TV pattern); landscape
          collapses to fullscreen like a channel-list select. */}
      {overlay === 'guide' && (
        <View style={portrait ? [styles.guidePortrait, { top: stripH }] : styles.guideLandscape}>
          <GuidePanel playingId={playingId} onTune={(s) => play(s, { collapse: !portrait })} />
        </View>
      )}

      {/* Portrait guide: tapping the video STRIP expands to portrait fullscreen
          (overlay none) — "portrait fullscreen is an option"; BACK (or rotating)
          brings the guide right back. Covers the strip region only, so the grid
          below keeps its own touches. */}
      {guideStrip && (
        <Pressable
          style={[styles.stripTap, { height: stripH }]}
          accessibilityRole="button"
          accessibilityLabel={t('live.fullscreen')}
          onPress={() => setOverlay('none')}
        />
      )}

      {(overlay === 'list' || overlay === 'info') && (
        <View style={styles.panels} onTouchStart={bumpMenuIdle}>
          <FocusPane autoFocus style={[styles.railPane, portrait && styles.railPanePortrait]}>
            <CategoryRail
              items={railItems}
              selected={railSelected}
              parentHeader={inDrill ? { label: drillParent!, onBack: exitDrill } : undefined}
              onSelect={selectRail}
              onActivity={bumpMenuIdle}
            />
          </FocusPane>
          <FocusPane autoFocus style={[styles.listPane, portrait && styles.listPanePortrait]}>
            {overlay === 'list' ? (
              <ChannelListPanel
                streams={list}
                heading={listHeading}
                numbers={numbers}
                playingId={playingId}
                favorites={favorites}
                onSelect={(s) => play(s, { collapse: true })}
                onInfo={(s) => { setInfoStream(s); setOverlay('info') }}
                // Two-tier OK — but NOT while a playback error is up: play() honors
                // re-selecting the SAME channel as the retry the error message
                // promises (see play()'s 2026-07-16 outage note), and routing that
                // press to the Guide would shadow it. Absent onGuide = the old path.
                // TV opens the Guide screen; phone raises the guide MODE right here
                // so the video surface never leaves the tree.
                onGuide={error ? undefined : (s) => (theme.isTV ? navigation.navigate('Guide', { streamId: s.id }) : setOverlay('guide'))}
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
                    onReport={() => setReportOpen(true)}
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

      {/* Subtitle/CC + audio selector — floats over the video independent of the browse
          overlay state machine (opened from the phone NowPlayingBar CC button). */}
      {showTracks && (
        <TrackMenu
          textTracks={textTracks}
          audioTracks={audioTracks}
          selectedText={selectedText}
          selectedAudio={selectedAudio}
          onSelectText={setSelectedText}
          onSelectAudio={setSelectedAudio}
          onClose={() => setShowTracks(false)}
        />
      )}

      {/* "Report a problem" (S51) — opened from the NowPlayingBar (phone) or the info
          panel of the channel being watched (TV). The engine attaches the ACTIVE
          stream, so this sheet is only reachable while one is playing. */}
      <ReportSheet visible={reportOpen} channelTitle={playing?.title} onClose={() => setReportOpen(false)} />

      {/* Parental gate: a restricted channel was picked while locked. One correct
          PIN unlocks the rest of the app session. */}
      <PinEntryModal
        visible={!!pinTarget}
        title={t('live.enterPin')}
        hint={pinTarget ? t('live.restricted', { title: pinTarget.title ?? pinTarget.id }) : undefined}
        onOk={() => {
          markUnlocked()
          const s = pinTarget
          setPinTarget(null)
          if (s) play(s, { collapse: true })
        }}
        onClose={() => {
          setPinTarget(null)
          // The mount-time case: nothing playing yet — fall back to the hero.
          if (!playingIdRef.current && streams.length) setPlayingId(pickHero(streams)?.id ?? streams[0].id)
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.videoBackground },
  // Guide mode, portrait: the video pinned to the top as a strip (height — the
  // 16:9 of the window width — rides in from render).
  videoStrip: { position: 'absolute', top: 0, left: 0, right: 0 },
  // Portrait guide: the transparent tap target over the video strip (expand to
  // portrait fullscreen). Same inline height as the strip itself.
  stripTap: { position: 'absolute', top: 0, left: 0, right: 0 },
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
  // Portrait (phone): the landscape percentages leave the rail/list unreadably
  // narrow on a ~360dp-wide screen — spread the two panes across the full width.
  railPanePortrait: { width: '30%' },
  listPanePortrait: { width: '67%' }, // 30 + 67 leaves room for panels' padding — no right-edge clip
  // Guide mode: portrait fills everything under the 16:9 strip on an opaque bed
  // (`top` set inline from the measured strip); landscape overlays the fullscreen
  // video like the channel-list panel.
  guidePortrait: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: theme.colors.background,
    paddingHorizontal: theme.safeX, paddingTop: theme.spacing(1), paddingBottom: theme.safeY
  },
  guideLandscape: {
    ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.overlayStrong,
    paddingHorizontal: theme.safeX, paddingVertical: theme.safeY
  },
  infoPane: { flex: 1, backgroundColor: theme.colors.overlay, borderTopRightRadius: 12, borderBottomRightRadius: 12 },
  dim: { color: theme.colors.textDim, fontSize: theme.type.caption },
  errorTitle: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700' }
})
