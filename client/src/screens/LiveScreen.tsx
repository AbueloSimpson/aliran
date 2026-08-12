// Live TV — ONE fullscreen video surface with overlay panels (the reorganization at
// the heart of the redesign; replaces the old Home→Player navigation for live).
//
//   base   : fullscreen <AliranVideo> — playback NEVER stops while browsing. Over it a
//            persistent bottom menu (NowPlayingBar) carries the channel identity + touch
//            controls (Search / Info / Favorite) whenever a channel is open and the
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
// TV: the whole D-pad answers while fullscreen, and every direction rides the FOCUS
// ENGINE — invisible focus strips around a central select-catcher band, because
// react-native-tvos on Android does not dispatch HWEvents to useTVEventHandler while a
// view holds focus, so key handling must be focus-based (the S7 lesson). The bottom
// menu's touch buttons are phone-only so they stay out of that focus path.
//
//   UP / DOWN   zap prev/next across the whole curated channel order (the numbers'
//               order), like a set-top box's CH+/CH-.
//   OK / LEFT   open the channel list. Left is where every set-top box in the world
//               puts its channel menu.
//   RIGHT       channel detail for what is playing — the mirror of LEFT: left browses
//               everything else, right describes this. BACK from detail entered THIS
//               way returns to the picture, not to a channel list nobody opened.
//   BACK        leave for the menu.
//
// AND THE BAR NAMES ALL OF IT. None of the above is discoverable on its own — a focus
// strip is invisible by construction — so the NowPlayingBar carries a legend of key
// caps on TV. That is not decoration: a viewer on a TCL set pressed left and right,
// got silence, and reported channel changing as broken when it had worked all along.
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
// Fullscreen is ALWAYS landscape (S22 round 4, phone): the portrait guide's strip
// tap locks the Activity to landscape via a tiny native module (src/orientation.ts →
// android OrientationModule) and drops to fullscreen; BACK from that fullscreen
// releases the lock, the phone falls back to its physical orientation, and the
// rotation rule above raises the guide if that's portrait. Portrait mounts with a
// channel therefore start in 'guide' (portrait + overlay 'none' exists only
// transiently); errors still show fullscreen-with-error in any orientation.
// Locked-fullscreen tap zones (S22 round 5, phone): while the landscape lock is
// ours, a tap on the LEFT THIRD of the fullscreen catcher returns to the guide
// (release the lock + raise the guide overlay) and a tap anywhere else toggles the
// NowPlayingBar — it never opens the channel list, which stays the tap target of
// the UNLOCKED flow (entered from the LIVE TV tile / zap). A mid-left "‹ Guide"
// pill, visible while the bar is, advertises the zone. BACK stays the round-4
// unlock → guide path.
// Search overlay (WS15, phone only): the NowPlayingBar's Search button raises the
// in-player channel search as another mode of this screen — portrait uses the
// guide's strip layout (video strip on top, SearchPanel below), landscape lays the
// panel over the fullscreen video on the translucent bed. It SURVIVES rotation in
// both directions (the query must not be lost; only the strip appears/disappears),
// the idle timers never touch it, and BACK (or a result tune — search has a
// destination, so tune CLOSES it, unlike the guide) returns to the orientation
// default: portrait 'guide', landscape 'none'. A playback error collapses it like
// the guide (the error text must stay visible). Result tunes go through play() —
// the same PIN-gated path as the channel list.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, Platform, BackHandler, TVFocusGuideView, Animated, useWindowDimensions } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { AliranVideo, SelectedTrackType, type AliranVideoHandle, type TuneEvent, type SelectedTrack, type AudioTrack, type TextTrack } from '@aliran/react-native'
import type { RootStackParamList } from '../App'
import { getLocale, useI18n } from '@aliran/i18n'
import { backend, type Stream } from '../worklet'
import { setOrientation } from '../orientation'
import { onChannelKey } from '../channelKeys'
import { useMountDeferred } from '../defer'
import { autoTunable, blockedWithoutPin, markUnlocked, needsPin, visibleStreams } from '../parental'
import { PinEntryModal } from '../components/PinModal'
import { channelNumbers, categoryModel, splitCategory, subLabel, pickHero, zapOrder, isVod } from '../catalog'
import { CategoryRail } from '../components/CategoryRail'
import { ChannelListPanel } from '../components/ChannelListPanel'
import { ChannelInfoPanel } from '../components/ChannelInfoPanel'
import { GuidePanel } from '../components/GuidePanel'
import { GuideSkeleton } from '../components/GuideSkeleton'
import { SearchPanel } from '../components/SearchPanel'
import { ChannelChangeIndicator, type ChannelChangePhase } from '../components/ChannelChangeIndicator'
import { NowPlayingBar } from '../components/NowPlayingBar'
import { TrackMenu } from '../components/TrackMenu'
import { ReportSheet } from '../components/ReportSheet'
import { SendToTvSheet, useSendToTv } from '../components/SendToTvSheet'
import { SectionLoading } from '../components/SectionLoading'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Live'>
type Overlay = 'none' | 'list' | 'info' | 'guide' | 'search'

// On phone TVFocusGuideView is just a View; on TV autoFocus restores focus memory (S7).
const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

// The left menu (browse overlay) has no manual close control — it auto-hides this long
// after the last interaction, fading back to clean fullscreen video.
//
// FAR LONGER ON A TELEVISION, because 6 s is measurably wrong there. A phone viewer
// interacts continuously — a scroll bumps the timer every few hundred ms — but a remote
// viewer READS the list and then presses a key, and 6 s of reading is ordinary. The
// overlay going away mid-read does not read as "back to the picture"; it reads as "it
// lost my place". Every D-pad move inside the list already bumps this (ChannelRow's
// onFocus → onActivity), so what is really being timed is a viewer who has stopped
// pressing keys entirely — and BACK is still the instant way out.
const MENU_IDLE_MS = theme.isTV ? 20000 : 6000

// The bottom now-playing bar fades away this long after it appears / the last
// interaction, for an unobstructed picture; on phone a touch in the bottom reveal zone
// brings it back. IT NOW FADES ON TELEVISION TOO — it used to stand there for the whole
// session, which is what a viewer means by "the rest of the bottom menu never goes
// away". A set-top box shows its banner on a channel change and then clears the picture,
// and that is exactly what the zap already does here: every zap changes playingId, and
// the effect below re-reveals the bar. Longer than the phone's, and deliberately longer
// than HINT_IDLE_MS, so the legend fades first and the bar it sits on outlives it.
const BAR_IDLE_MS = theme.isTV ? 12000 : 5000

// The TV remote legend fades this long after it appears — a timer of its own, and
// SHORTER than the bar's above: the legend teaches the keys and stops earning its space
// well before the channel identity does. Long enough to read four short items unhurried.
const HINT_IDLE_MS = 9000

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
    // Two different refusals, and only one of them has a modal behind it. needsPin →
    // the mount effect below raises the PIN entry. blockedWithoutPin → nothing is
    // raised, because there is no PIN to enter: the streams effect falls back to the
    // hero. (A candidate resolved from `backend.streams` — the UNFILTERED list — is
    // what makes this reachable at all; see parental.blockedWithoutPin.)
    return s && (blockedWithoutPin(s.restricted) || needsPin(s)) ? null : candidate
  })
  // Guide-mode geometry (phone): portrait puts the ONE video surface as a 16:9
  // strip on top of the grid; landscape overlays the grid on the fullscreen video.
  // Only the video's STYLE changes between these layouts (same element, same tree
  // position), so the player never remounts and playback never stops. Lives up here
  // (above the overlay state) because the overlay INITIALIZER below reads `portrait`
  // too — as do the orientation state machine and the BACK handler further down.
  const { width: winW, height: winH } = useWindowDimensions()
  // Heavy overlay bodies (guide/search) wait for the nav/overlay transition to
  // finish before mounting — the tap responds instantly (S22 round 6). Phone-only
  // surfaces; TV never reaches those overlays.
  const mountReady = useMountDeferred()
  const portrait = winH >= winW
  const stripH = Math.round(winW * 9 / 16)
  const [overlay, setOverlay] = useState<Overlay>(() => {
    // The Menu's GUIDE tile (phone): open straight into the guide mode around the
    // resumed/hero channel. TV never sets it — the Guide route stays its surface.
    if (route.params?.guide && !theme.isTV) return 'guide'
    // The Menu's SEARCH tile (phone): open with the in-player search overlay up
    // (WS15). TV never sets it — the standalone Search screen stays its surface.
    if (route.params?.search && !theme.isTV) return 'search'
    if (!(route.params?.streamId || lastStreamId)) return 'list'
    // Phone PORTRAIT mounts with a resume/tuned channel start in the guide, not
    // fullscreen (S22 round 4: fullscreen is ALWAYS landscape, so portrait
    // fullscreen no longer exists as a resting state — only transiently, with the
    // round-3 catcher/BACK portrait→guide rules as the safety net). Landscape
    // mounts (and TV) keep clean fullscreen.
    return !theme.isTV && portrait ? 'guide' : 'none'
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
  // "Play on a TV" (phone). The hook answers whether the entry point should exist at
  // all — this device can reach the Cast framework, or the account already has a
  // television on the rendezvous. Neither = no button: a picker that can only ever be
  // empty is worse than no picker.
  const [sendTvOpen, setSendTvOpen] = useState(false)
  // WHICH channel the sheet is about. null = "whatever is playing", which is what the
  // NowPlayingBar's button means and is the only thing this used to support. The guide's
  // chip names a channel instead, so an id is held rather than the record: the sheet must
  // keep tracking the catalog (an operator removing the channel has to reach it), and a
  // captured Stream would freeze at the moment the sheet opened.
  const [sendTvId, setSendTvId] = useState<string | null>(null)
  const sendTv = useSendToTv()
  const menuIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bottom bar auto-hide (phone): `barShown` gates mounting; `barOpacity` fades it.
  // TV never auto-hides (theme.isTV branch in armBarHide).
  const [barShown, setBarShown] = useState(true)
  const barIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const barOpacity = useRef(new Animated.Value(1)).current
  // The TV remote legend (NowPlayingBar): raised on the same two triggers as the bar —
  // arriving at fullscreen, and every channel change — then fading on its own timer.
  const [hintShown, setHintShown] = useState(theme.isTV)
  const hintIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hintOpacity = useRef(new Animated.Value(1)).current
  // How channel detail was entered: RIGHT from fullscreen, or the channel list. Only
  // the BACK handler reads it — see openInfo().
  const infoFromFullscreen = useRef(false)
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
  //
  // AND IT STAYS PHONE-ONLY. Cable-box volume and mute were asked for on the television
  // build, then MEASURED on the operator's TCL set (Android 14, a real television —
  // ro.build.characteristics=tv, leanback_only) with this app in the foreground:
  // VOLUME_UP/DOWN moved the REAL system volume (6→7→8→7 of 0..100), VOLUME_MUTE set the
  // real mute, and the set drew its OWN volume scale over our picture. The box IS the
  // television, so those keys already reach the speakers the viewer wants louder.
  // Claiming them — an onKeyDown hook in MainActivity returning true for
  // KEYCODE_VOLUME_UP/DOWN/MUTE — stops the system ever seeing them again and leaves an
  // in-app attenuator that cannot get PAST whatever the set's own level happens to be.
  // That trades a working control for a worse one, so there is nothing to build here.
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)

  const overlayRef = useRef(overlay); overlayRef.current = overlay
  const playingIdRef = useRef(playingId); playingIdRef.current = playingId
  const drillRef = useRef(drillParent); drillRef.current = drillParent
  const selectedRef = useRef(selected); selectedRef.current = selected

  const portraitRef = useRef(portrait); portraitRef.current = portrait
  const errorRef = useRef(error); errorRef.current = error

  // S22 round 4 — fullscreen is ALWAYS landscape (phone). Tapping the portrait
  // guide's video strip LOCKS the Activity to landscape (native module) and drops
  // to fullscreen; `lockedByUs` remembers the lock is ours. BACK from that
  // fullscreen releases the lock — the phone returns to its physical orientation,
  // and if that is portrait the rotation effect below raises the guide again (the
  // release does not touch the effect, so the chain is: unlock → dimension change →
  // setOverlay('guide')). The lock survives panel browsing (list/info/guide opened
  // over locked landscape keep it — the viewer is browsing in landscape on
  // purpose); it releases only on the BACK-to-guide intent, the left-third tap
  // below, or unmount. TV never locks (the strip tap is phone-portrait-only UI).
  // S22 round 5 — while locked, the fullscreen catcher splits into TAP ZONES: the
  // LEFT THIRD returns to the guide (release the lock + setOverlay('guide') — if
  // the phone is physically landscape the landscape guide overlay shows; if it
  // falls back to portrait the rotation effect sets 'guide' again, a harmless
  // same-value set); the REST toggles the NowPlayingBar like a plain fullscreen
  // tap — it never opens the channel list (the list stays the LIVE TV flow's
  // surface). `lockedUI` mirrors the ref for rendering (the ref itself never
  // re-renders): it gates the zones and the left-edge "‹ Guide" hint chip.
  const lockedByUs = useRef(false)
  const [lockedUI, setLockedUI] = useState(false)
  function lockLandscape () {
    lockedByUs.current = true
    setLockedUI(true)
    setOrientation('landscape')
    setOverlay('none')
  }
  // Returns whether a lock was actually held, so the BACK handler can consume the
  // press that released it (and do nothing else with it).
  function releaseOrientationLock () {
    if (!lockedByUs.current) return false
    lockedByUs.current = false
    setLockedUI(false)
    setOrientation('unspecified')
    return true
  }
  // The left-third tap (and the hint chip): back to the guide the viewer came from.
  // Error-gated like every other guide entry — with an error up the release still
  // honors the leave-fullscreen intent, but fullscreen-with-error stays visible
  // (the message and its retry instruction come first; mirrors the BACK path).
  function returnToGuide () {
    releaseOrientationLock()
    if (!errorRef.current) setOverlay('guide')
  }
  // Unmount (leaving Live for the Menu, or any navigation away): never leave the
  // Activity pinned — other screens own their own orientation behavior.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { releaseOrientationLock() }, [])

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

  // TELEVISION SIDE of "play on my TV": tell the controllers this set stopped. The engine
  // publishes the channel and "playing" itself (it learns both from resolve()), but it
  // cannot see a viewer leaving playback — that is one of the two things only a host
  // knows, and it is what updateRemoteStatus() is for. Phones never announce themselves
  // on the rendezvous, so this is TV-only.
  useEffect(() => {
    if (!theme.isTV) return
    return () => { backend.updateRemoteStatus({ state: 'stopped' }) }
  }, [])

  // The Guide tuned a channel while THIS screen stayed mounted (Guide sits above Live
  // in the stack, so navigate('Live') pops back with fresh params instead of
  // remounting): honor the param like a row select. tuneKey (a fresh stamp per Guide
  // tune) rides the deps because a value-equal streamId alone would never re-fire the
  // effect (re-tuning the channel the params already name). A param matching what
  // already plays is a no-op, so the mount-time path (initial state above, no
  // tuneKey) is undisturbed.
  useEffect(() => {
    const id = route.params?.streamId
    if (!id) return
    // Picking the channel that is ALREADY playing is NOT a no-op here, and treating it as
    // one was a bug: the viewer chose that row in the Guide, and this screen answered by
    // showing them whatever overlay it had been left on — usually the channel list, which
    // they never opened. The tune has nothing to do, but the INTENT was "watch this", so
    // collapse to the picture either way.
    if (id === playingIdRef.current) { setOverlay('none'); return }
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

  // navigate('Live', { search: true }) against an ALREADY-MOUNTED Live: raise the
  // search overlay like the mount-time path above did. Error-gated like every
  // guide/search entry: the panel's bed must never cover the error text.
  useEffect(() => {
    if (route.params?.search && !theme.isTV && !errorRef.current) setOverlay('search')
  }, [route.params?.search])

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
    // The search overlay survives rotation in BOTH directions (WS15): the query
    // must not be lost mid-search — only the video strip appears/disappears with
    // the orientation (the render section swaps layouts around the same panel).
    if (portrait) setOverlay((o) => (o === 'search' ? o : 'guide'))
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
    if (overlay === 'none') { showBar(); showHint() }
    else { clearBarIdle(); clearHintIdle() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, playingId])
  useEffect(() => clearBarIdle, [])
  useEffect(() => clearHintIdle, [])

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

  // THE OTHER TWO THINGS ONLY A HOST KNOWS (the companion to the 'stopped' effect above):
  // a pause, and the playhead. Both are properties of a VOD TITLE — a live channel has no
  // pause here and no meaningful playhead — so titles report both and everything else
  // reports plain 'playing'.
  //
  // THAT SECOND HALF IS THE ONE THAT IS EASY TO MISS. Zapping away from a PAUSED title
  // leaves 'paused' as the last thing this set ever said about itself. A zap to another
  // channel is fine on its own — the engine pushes `playing` for the new one and drops the
  // playhead with the channel it belonged to — but the word has to be retracted for the
  // case where nothing else pushes, and saying it explicitly costs one message.
  //
  // A position on its own never sends anything: the engine stores it and lets it ride the
  // next push that a real change causes (sdk/player.js updateRemoteStatus). So the ticking
  // seconds cost one worklet message each and NOTHING on the rendezvous — only the pause
  // flips reach the other devices. That is why the playhead is split into its own effect
  // rather than riding this one's deps: a per-second re-run of this one would be a
  // per-second status push.
  //
  // `playing` gates it because "nothing is on" is the ENGINE's to say, not this screen's:
  // a mount with no channel yet, or the blink while a catalog reload re-finds the record,
  // must not be reported as a set that is playing something.
  useEffect(() => {
    if (!theme.isTV || !playing) return
    if (!playingVod) { backend.updateRemoteStatus({ state: 'playing' }); return }
    backend.updateRemoteStatus({ state: vodPaused ? 'paused' : 'playing', position: vodPos })
    // Keyed on the ID, not the record: a catalog push replaces the array and hands back a
    // fresh object for the SAME channel, and that is not a change worth a message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing?.id, playingVod, vodPaused])

  useEffect(() => {
    if (!theme.isTV || !playingVod) return
    backend.updateRemoteStatus({ position: vodPos }) // stored; it rides the next real change
  }, [playingVod, vodPos])

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
  // indicator arms itself — mounting <AliranVideo> fires onTune 'start'). The hero is
  // picked over autoTunable() alone: the app must never tune a PIN-gated channel on
  // its own initiative, and nothing tunable means nothing plays.
  useEffect(() => {
    if (!playingId && !pinTarget && streams.length) setPlayingId(pickHero(autoTunable(streams))?.id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams])

  function play (s: Stream, { collapse = false }: { collapse?: boolean } = {}) {
    // The last gate before a tune, and it stands here as well as at the routes that can
    // reach it: a restricted channel on a device with NO PIN is refused outright. Every
    // local caller passes a record out of `streams` (already parental-filtered), so this
    // only ever fires for something that arrived from outside those lists — a remote
    // play, or a `lastStreamId` left over from before the PIN was removed.
    if (blockedWithoutPin(s.restricted)) return
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

  // Rail FOCUS (TV) — scope the channel list to this category and nothing more. It must
  // NOT drill, and that is a fix rather than a preference: this used to be the same
  // function as the one below, so moving the D-pad focus down the rail entered the first
  // parent that had sub-categories. The viewer could not reach the categories past it,
  // and could not stay on the parent either. Any pick shows the channel LIST — from the
  // channel-detail overlay that leaves detail (else the press looked like it did nothing).
  function selectRail (key: string) {
    setSelected(key)
    setOverlay('list')
  }

  // Rail OK (and a phone tap, which has no focus step): ENTER the category. A top-level
  // parent with sub-categories drills in — the rail then shows its subs under a pinned
  // "‹ Parent" header. Re-picking the already-selected sub goes back to the whole parent.
  // A leaf is just the scope the focus already gave it.
  function activateRail (key: string) {
    if (drillParent == null && (model.subs[key]?.length ?? 0) > 0) {
      setDrillParent(key); setSelected(key)
    } else if (drillParent != null && key === selected) {
      setSelected(drillParent) // re-pick the selected sub -> all of the parent
    } else {
      setSelected(key)
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
  function clearHintIdle () { if (hintIdle.current) { clearTimeout(hintIdle.current); hintIdle.current = null } }
  // Reveal the TV remote legend and arm its fade. A no-op on phone, which teaches
  // itself: every action the legend names is a labelled button on this same bar.
  function showHint () {
    if (!theme.isTV) return
    clearHintIdle()
    hintOpacity.stopAnimation()
    setHintShown(true)
    Animated.timing(hintOpacity, { toValue: 1, duration: 160, useNativeDriver: true }).start()
    hintIdle.current = setTimeout(() => {
      Animated.timing(hintOpacity, { toValue: 0, duration: 350, useNativeDriver: true })
        .start(({ finished }) => { if (finished) setHintShown(false) })
    }, HINT_IDLE_MS)
  }

  // The ONE way into channel detail, so that every entry records where BACK should
  // return to. Detail is normally reached from the channel list and goes back to it;
  // RIGHT reaches it from fullscreen, which never passed through a list at all.
  function openInfo (s: Stream, { fromFullscreen = false }: { fromFullscreen?: boolean } = {}) {
    infoFromFullscreen.current = fromFullscreen
    setInfoStream(s)
    setOverlay('info')
  }

  // The manual half of the locked-fullscreen tap toggle (S22 round 5): fade the bar
  // out now instead of waiting for the idle timer.
  function hideBar () {
    clearBarIdle()
    barOpacity.stopAnimation()
    Animated.timing(barOpacity, { toValue: 0, duration: 160, useNativeDriver: true })
      .start(({ finished }) => { if (finished) setBarShown(false) })
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

  // …and the remote's own CHANNEL keys, which are what those buttons are FOR. They reach
  // no focus strip (a strip is only found by a key that moves focus), so they arrive from
  // the Activity instead — see channelKeys.ts. Only while fullscreen: with a panel up the
  // viewer is browsing, and zapping the picture out from under them is not what the key
  // means there.
  useEffect(() => onChannelKey((direction) => {
    if (overlayRef.current !== 'none') return
    zap(direction === 'up' ? 1 : -1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [streams, playingId])

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
      if (overlayRef.current === 'search') {
        // BACK from search (WS15): the orientation default browse surface —
        // portrait's is the guide, landscape's is clean fullscreen.
        setOverlay(!theme.isTV && portraitRef.current ? 'guide' : 'none')
        return true
      }
      if (overlayRef.current === 'guide') {
        // Portrait (phone): the guide IS the default surface — BACK exits to Menu.
        if (!theme.isTV && portraitRef.current) return false
        setOverlay('none'); return true // landscape guide mode → fullscreen
      }
      if (overlayRef.current === 'info') {
        // Detail reached from the channel list goes back to it. Reached by RIGHT on
        // fullscreen it never passed through a list, and dropping the viewer into one
        // they never opened takes them further FROM the picture, not back to it.
        const toFullscreen = infoFromFullscreen.current
        infoFromFullscreen.current = false
        setOverlay(toFullscreen ? 'none' : 'list')
        return true
      }
      if (overlayRef.current === 'list') {
        // Unwind the category drill before the overlay: sub selected -> back to sub-select;
        // drilled (no sub) -> back to the top-level rail; else hide the left menu.
        if (drillRef.current != null && selectedRef.current !== drillRef.current) { setSelected(drillRef.current); return true }
        if (drillRef.current != null) { setDrillParent(null); return true }
        setOverlay('none'); return true // hide the left menu
      }
      // Fullscreen: a strip-tap landscape lock releases FIRST (the BACK-to-guide
      // intent, S22 round 4) — consuming the press; the phone rotates back to its
      // physical orientation, and if that is portrait the rotation effect raises
      // the guide. Then: portrait raises the guide (portrait's default surface,
      // unless a playback error is up); landscape default back = exit to Menu.
      if (releaseOrientationLock()) return true
      if (!theme.isTV && portraitRef.current && !errorRef.current) { setOverlay('guide'); return true }
      return false
    })
    return () => sub.remove()
  }, [navigation]) // stable identity — the listener registers once in practice

  const guideStrip = overlay === 'guide' && portrait
  // Portrait search uses the SAME strip layout as the portrait guide (the one video
  // surface as a 16:9 strip on top); only the guide gets the strip's tap-to-
  // fullscreen (search keeps its overlay — BACK is its way out).
  const stripMode = guideStrip || (overlay === 'search' && portrait)

  if (!streams.length) return <SectionLoading section={t('menu.live')} hint={t('live.waitingForChannels')} />

  return (
    <View style={styles.container}>
      {playingId && !error && (
        <AliranVideo
          ref={videoHandle}
          backend={backend}
          style={stripMode ? [styles.videoStrip, { height: stripH }] : undefined}
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
          // Pill hands off to the error UI — and the guide/search overlays collapse
          // so the error text (with its retry instruction) is never hidden under
          // their opaque beds (the error-collapse pattern).
          onError={(msg) => { setError(msg); setTuneUI(null); setOverlay((o) => (o === 'guide' || o === 'search' ? 'none' : o)) }}
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
          the surface opens the overlay.
          LOCKED fullscreen (S22 round 5, phone — entered FROM the portrait guide's
          strip): the catcher splits by tap x (locationX — the catcher IS the full
          screen, so it equals the screen x; pageX as the fallback). LEFT THIRD =
          back to the guide; the rest toggles the NowPlayingBar and NEVER opens the
          channel list — the list belongs to the LIVE TV flow, not the guide's. */}
      {overlay === 'none' && (
        <>
          <Pressable
            ref={catcherRef}
            style={Platform.isTV ? styles.catcherTV : StyleSheet.absoluteFill}
            hasTVPreferredFocus
            onPress={(e) => {
              if (!theme.isTV && lockedByUs.current) {
                const x = e?.nativeEvent?.locationX ?? e?.nativeEvent?.pageX ?? 0
                if (x < winW / 3) returnToGuide()
                else if (barShown) hideBar()
                else showBar()
                return
              }
              setOverlay(!theme.isTV && portrait && !error ? 'guide' : 'list')
            }}
          />
          {Platform.isTV && (
            <>
              <Pressable style={styles.zapUp} onFocus={() => bounceZap(1)} />
              <Pressable style={styles.zapDown} onFocus={() => bounceZap(-1)} />
              {/* LEFT opens the channel list — the same surface OK opens, reached the way
                  a set-top box viewer expects. No bounce back to the catcher: opening the
                  overlay unmounts this whole block, and the overlay takes focus itself. */}
              <Pressable style={styles.menuLeft} onFocus={() => setOverlay('list')} />
              {/* RIGHT opens channel detail for what is playing: the mirror of LEFT —
                  left browses everything ELSE, right describes THIS — and the last
                  direction on the pad that answered to nothing at all. Guarded on
                  `playing` because with nothing tuned there is no channel to describe,
                  and the press should stay silent rather than raise an empty panel. */}
              {playing && (
                <Pressable
                  style={styles.menuRight}
                  onFocus={() => openInfo(playing, { fromFullscreen: true })}
                />
              )}
            </>
          )}
          {playing && barShown && (
            <Animated.View style={[styles.barFade, { opacity: barOpacity }]} pointerEvents="box-none">
              {/* Locked-fullscreen affordance (S22 round 5): a mid-left "‹ Guide"
                  pill makes the left-third zone discoverable. Shows only while the
                  bar is up (it rides the bar's fade) and taps straight back to the
                  guide; everywhere else the chip is absent so nothing blocks the
                  picture. */}
              {lockedUI && !theme.isTV && (
                <Pressable
                  style={styles.guideHint}
                  accessibilityRole="button"
                  accessibilityLabel={t('menu.guide')}
                  onPress={returnToGuide}
                >
                  <Text style={styles.guideHintText}>{'‹ ' + t('menu.guide')}</Text>
                </Pressable>
              )}
              <NowPlayingBar
                stream={playing}
                number={numbers.get(playing.id)}
                clock={clockText(now)}
                favorite={favorites.includes(playing.id)}
                onSearch={() => setOverlay('search')}
                onInfo={() => openInfo(playing)}
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
                // The !theme.isTV here is what actually holds this to a phone, and it is
                // NOT redundant with the hook: useSendToTv().can counts the OTHER
                // televisions on the account, so on a set belonging to an account with two
                // of them it answers true. NowPlayingBar's own !theme.isTV gate is the
                // second one. Removing either puts a focusable in the TV D-pad path.
                onSendToTv={sendTv.can && !theme.isTV ? () => { showBar(); setSendTvId(null); setSendTvOpen(true) } : undefined}
                // Lit while a session runs. Not the only sign — the bar lives inside the
                // fullscreen overlay and fades on a timer, so the standing chip below is
                // what a viewer in the guide (portrait's resting state) actually sees.
                sendingToTv={sendTv.sending}
                // The remote legend (TV only, the bar gates it on theme.isTV itself).
                hint={hintShown}
                hintOpacity={hintOpacity}
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
          collapses to fullscreen like a channel-list select. Landscape also runs
          the panel's 'overlay' preview mode (WS11): first tap selects a row and
          raises the upper-right live-thumb preview card, the second tap tunes.
          Portrait stays tap-to-tune — the strip above IS the picture there. */}
      {overlay === 'guide' && (
        <View style={portrait ? [styles.guidePortrait, { top: stripH }] : styles.guideLandscape}>
          {/* Deferred mount (S22 round 6): the grid's first commit is heavy — gating
              it lets the screen/overlay transition paint immediately; the grid pops
              in one interaction later. The bed + strip above show at once — and the
              gap holds the guide's SKELETON FRAME (WS17, S22 round 7): the same
              chrome geometry with real times, so the tap "opens the guide" at once
              and only the content pops in. */}
          {mountReady ? (
            <GuidePanel
              playingId={playingId}
              preview={portrait ? 'none' : 'overlay'}
              onTune={(s) => play(s, { collapse: !portrait })}
              // Portrait's resting state is the guide and the bar only shows in
              // fullscreen — this chip is the portrait route into the in-player search.
              onSearch={() => setOverlay('search')}
              // …and the same route to "Play on a TV", which additionally carries the row
              // the viewer has SELECTED. Sending from the bar means tuning the channel on
              // this phone first, which spends a stream it never wanted to watch. The
              // overlay stays open behind the sheet: the viewer is browsing a schedule,
              // and sending one channel to the set is not a reason to leave it.
              // Phone-only for the same two reasons as the bar button — see there.
              onSendToTv={sendTv.can && !theme.isTV ? (s) => { setSendTvId(s.id); setSendTvOpen(true) } : undefined}
            />
          ) : <GuideSkeleton />}
        </View>
      )}

      {/* Search mode (WS15, phone): the in-player channel search around the ONE
          playing video surface — portrait borrows the guide's strip layout (video
          strip on top, panel on the opaque bed below), landscape lays the panel
          over the fullscreen video on the translucent bed. A result tap tunes
          through play() (the channel list's PIN-gated path) and CLOSES the overlay
          to the orientation default — a search has a destination. The panel keeps
          its own query state, so the rotation-survival rule above never loses it. */}
      {overlay === 'search' && (
        <View style={portrait ? [styles.guidePortrait, { top: stripH }] : styles.guideLandscape}>
          {mountReady ? (
            <SearchPanel
              playingId={playingId}
              onTune={(s) => {
                setOverlay(!theme.isTV && portraitRef.current ? 'guide' : 'none')
                play(s)
              }}
            />
          ) : <SectionLoading section={t('menu.search')} />}
        </View>
      )}

      {/* Portrait guide: tapping the video STRIP goes fullscreen — and fullscreen
          is ALWAYS landscape (S22 round 4), so the tap locks the Activity to
          landscape (the device rotates) besides collapsing the guide. BACK from
          that fullscreen releases the lock and the guide comes right back in
          portrait. Covers the strip region only, so the grid below keeps its own
          touches. */}
      {guideStrip && (
        <Pressable
          style={[styles.stripTap, { height: stripH }]}
          accessibilityRole="button"
          accessibilityLabel={t('live.fullscreen')}
          onPress={lockLandscape}
        />
      )}

      {(overlay === 'list' || overlay === 'info') && (
        <View style={styles.panels} onTouchStart={bumpMenuIdle}>
          {/* LEFT OUT OF A DRILLED RAIL GOES BACK UP to the top-level categories. Without
              it the only way out was to walk the focus up to the "‹ Parent" header and
              press OK — a detour the viewer has to discover, for the one direction that
              already means "back" everywhere else in this app. Mounted only while
              drilled, so at the top level LEFT stays what it was: nothing to the left of
              the rail, and the press is simply ignored. */}
          {theme.isTV && inDrill && (
            <Pressable style={styles.railExit} onFocus={exitDrill} />
          )}
          <FocusPane style={[styles.railPane, portrait && styles.railPanePortrait]}>
            <CategoryRail
              items={railItems}
              selected={railSelected}
              parentHeader={inDrill ? { label: drillParent!, onBack: exitDrill } : undefined}
              onSelect={selectRail}
              onActivate={activateRail}
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
                onInfo={(s) => openInfo(s)}
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
                    // The controls the TELEVISION's bottom bar cannot carry, because a
                    // focusable over the video would swallow the D-pad zap (S7). This
                    // panel is already out of that path and one key away (RIGHT), so it
                    // is where they live. Tracks belong to the channel being WATCHED —
                    // they were read off the running player — so they are not offered on
                    // a merely-browsed row. Phone keeps them on the bar and passes none.
                    hasTracks={theme.isTV && infoStream.id === playingId && (textTracks.length > 0 || audioTracks.length > 1)}
                    onSubtitles={theme.isTV ? () => setShowTracks(true) : undefined}
                    onSearch={theme.isTV ? () => navigation.navigate('Search') : undefined}
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

      {/* WHILE A SESSION RUNS, SAY SO — IN EVERY OVERLAY AND EVERY ORIENTATION. A cast
          leaves the local picture playing and changes nothing a viewer can see, and the
          lit TV glyph that used to be the only sign lives on the NowPlayingBar: inside
          `overlay === 'none'`, behind an auto-hide timer, and unreachable in portrait,
          whose resting state is the guide. So a phone could be awake, decrypting and
          serving a television with nothing on screen saying it. This chip is outside all
          of that, and it is also the way back to Stop. */}
      {sendTv.sending && !theme.isTV && (
        <Pressable
          style={styles.castingChip}
          accessibilityRole="button"
          accessibilityLabel={t('tvplay.sending')}
          onPress={() => setSendTvOpen(true)}
        >
          <Text style={styles.castingChipText}>{t('tvplay.sending')}</Text>
        </Pressable>
      )}

      {/* "Play on a TV" (phone) — hand the channel to another Aliran device, or cast it
          to a Chromecast. Mounted only while open: the sheet runs Cast discovery, which
          is a standing multicast cost, and it stops when the sheet unmounts. A live
          session keeps running regardless — it lives in sendToTv.ts, not here.
          NOT gated on `playing`: a cast outlives this phone's own catalog, and gating the
          sheet on a channel being resolvable took the Stop button away with it — the one
          control that shuts down a LAN origin server. The sheet handles a null stream. */}
      {sendTvOpen && !theme.isTV && (
        <SendToTvSheet
          // Resolved at RENDER, so the sheet keeps tracking the catalog either way: the
          // guide's chip names a channel by id, and everything else means "what is
          // playing". A named channel that leaves the catalog resolves to null, which is
          // the state the sheet already handles.
          stream={sendTvId ? streams.find((s) => s.id === sendTvId) ?? null : playing}
          onClose={() => setSendTvOpen(false)}
        />
      )}

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
          // Collapse lands on the orientation default: landscape/TV = fullscreen,
          // portrait = the guide (matching the non-PIN tune paths — a PIN entry must
          // not strand the viewer on the portrait fullscreen that no longer exists).
          if (s) { play(s, { collapse: true }); if (!theme.isTV && portraitRef.current && !errorRef.current) setOverlay('guide') }
        }}
        onClose={() => {
          setPinTarget(null)
          // The mount-time case: nothing playing yet — fall back to the hero. The
          // fallback is PIN-free by construction (autoTunable): declining the
          // challenge must not hand over some OTHER restricted channel instead, and
          // when they are all locked it leaves nothing playing rather than re-asking.
          if (!playingIdRef.current && streams.length) setPlayingId(pickHero(autoTunable(streams))?.id ?? null)
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
  // Insets on BOTH sides make room for menuLeft/menuRight. The catcher must not span to
  // either edge or there is nothing for the focus engine to find on a sideways press.
  catcherTV: { position: 'absolute', top: 80, bottom: 80, left: 80, right: 80 },
  // The LEFT strip: same trick as the zap strips, for the surface a viewer reaches for
  // first. Measured on a TCL set — up/down zapped and OK opened the channel list, but
  // LEFT and RIGHT did nothing at all, and left is where every set-top box in the world
  // puts its channel menu. A viewer pressed left, got silence, and reported that channel
  // changing was broken when it had been working the whole time.
  menuLeft: { position: 'absolute', top: 80, bottom: 80, left: 0, width: 80 },
  // …and the RIGHT strip, which was the other half of that same silence: channel detail
  // for what is playing. With this the whole pad answers, and the legend on the bar
  // says so.
  menuRight: { position: 'absolute', top: 80, bottom: 80, right: 0, width: 80 },
  // Full-screen wrapper so the NowPlayingBar's own absolute positioning still anchors
  // to the bottom while we fade the whole thing; box-none lets non-button taps reach
  // the catcher beneath. The bottom reveal zone re-shows the faded bar on touch.
  barFade: { ...StyleSheet.absoluteFillObject },
  barRevealZone: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 150 },
  // Locked-fullscreen "‹ Guide" pill: pinned to the left edge at mid-height (it
  // lives inside barFade's absoluteFill, so '50%' is mid-screen), rounded on the
  // open side only — reads as a tab growing out of the edge.
  guideHint: {
    position: 'absolute', left: 0, top: '50%', marginTop: -16,
    paddingVertical: 8, paddingLeft: 10, paddingRight: 12,
    borderTopRightRadius: 16, borderBottomRightRadius: 16,
    backgroundColor: theme.colors.overlayStrong
  },
  guideHintText: { color: theme.colors.text, fontSize: theme.type.caption, fontWeight: '700' },
  // The standing "a TV is being fed from here" chip. Top-left, over whatever the screen
  // is showing — the accent bed is there to be noticed, because the thing it reports is
  // this phone serving decrypted video to the network.
  castingChip: {
    position: 'absolute', top: theme.safeY, left: theme.safeX,
    paddingHorizontal: theme.spacing(1), paddingVertical: 6, borderRadius: 14,
    backgroundColor: theme.colors.accent
  },
  castingChipText: { color: theme.colors.onPrimary, fontSize: theme.type.caption, fontWeight: '800' },
  zapUp: { position: 'absolute', top: 0, left: 0, right: 0, height: 80 },
  zapDown: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 80 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  // The left inset moved from this container's PADDING to the rail's margin, so that the
  // gutter it leaves is real screen space OUTSIDE the rail — an absolutely-positioned
  // child at left:0 then sits strictly to the LEFT of the rail, which is the whole
  // requirement for the focus engine to find it on a LEFT press (see railExit). Padding
  // could not do that: an absolute child positions against the padding edge, so `left: 0`
  // landed exactly on the rail rather than beside it.
  panels: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', paddingVertical: theme.safeY },
  railExit: { position: 'absolute', left: 0, top: 0, bottom: 0, width: theme.isTV ? theme.safeX : theme.safeX / 2 },
  // The RAIL is trimmed on TV (it read too large on a real set) — narrower furniture
  // leaves more of the picture playing behind it, which is the point of browsing over
  // live video rather than on a page of its own.
  railPane: { width: theme.isTV ? '17%' : '20%', backgroundColor: theme.colors.overlayStrong, borderRadius: 12, paddingVertical: theme.spacing(1), marginRight: 2, marginLeft: theme.isTV ? theme.safeX : theme.safeX / 2 },
  // The CHANNEL LIST is not trimmed with it, and that is a measured decision rather
  // than an oversight. Narrowing it to 33% was tried and reverted: a row is number +
  // name + LIVE badge + logo, so the name is the only elastic thing in it, and the five
  // points came almost entirely out of the name — "A&E TV" became "A…" on the set. A
  // channel list whose channels cannot be read is not smaller, it is broken. The size
  // win here comes from the row HEIGHT instead (ChannelRow.ROW_INNER_H).
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
