// Live TV — ONE fullscreen video surface with overlay panels (the S18
// reorganization, ported from the phone app): playback never stops while browsing;
// selecting a row switches the stream in place. Overlays:
//   overlay 'list': CategoryRail + ChannelList — the browse & zap surface. No manual
//                   close control: it auto-hides after idle; Esc collapses it.
//   overlay 'info': ChannelInfoPanel — channel detail with the EPG now/next guide.
// Over fullscreen video a NowPlayingBar (number/logo/EPG-now/clock + mouse buttons)
// fades in on activity and out after idle; the top-right TunePill shows switch
// progress driven SOLELY by <HlsVideo>'s onTune lifecycle (raw player events also
// fire for the PREVIOUS channel under the shared localhost URL — the S22 lesson).
//
// Keyboard model (the D-pad patterns on desktop keys):
//   fullscreen : ↑/↓ zap within the category the channel was tuned FROM (Phase 4 —
//                'All' tunes keep the global curated order) · Enter/click channel
//                list, reopened scoped to that same category
//                · i info · f favorite · c subtitles/audio · Esc → Menu
//   list open  : ↑/↓ rows · ←/→ rail↔list · Enter watch · i info · Esc unwinds
//                (sub-category → parent → top rail → close), mirroring BACK on TV
//   info open  : Enter watch · f favorite · Esc back to the list
//
// VOD (S8a): library titles play on this same surface — the bar grows a seek/pause
// transport, the stall ladder disarms engine-side (recordType), and CH+/CH- stays a
// live-only ring: zapping from a title lands on channel 001.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getLocale, useI18n } from '@aliran/i18n'
import { backend } from '../bridge'
import type { Stream } from '../types'
import { channelNumbers, categoryModel, displayTitle, isVod, pickHero, splitCategory, subLabel, zapOrder, zapRing, type CategoryModel } from '../catalog'
import { HlsVideo, type HlsVideoHandle, type MediaTrack, type TuneEvent } from '../components/HlsVideo'
import { autoTunable, markUnlocked, needsPin, visibleStreams } from '../parental'
import { PinEntryModal } from '../components/PinModal'
import { TunePill, type TunePillPhase } from '../components/TunePill'
import { ChannelList } from '../components/ChannelList'
import { CategoryRail } from '../components/CategoryRail'
import { ChannelInfoPanel } from '../components/ChannelInfoPanel'
import { NowPlayingBar } from '../components/NowPlayingBar'
import { TrackMenu } from '../components/TrackMenu'
import { ReportModal } from '../components/ReportModal'
import { loadVolume, saveVolume } from '../components/VolumeControl'

type Overlay = 'none' | 'list' | 'info'

// The browse overlay auto-hides this long after the last interaction.
const MENU_IDLE_MS = 6000
// The bottom bar fades this long after it appears / the last activity.
const BAR_IDLE_MS = 5000
// The mouse cursor hides over clean fullscreen video after this idle.
const CURSOR_IDLE_MS = 3000

// Last channel watched THIS session (module-level: survives leaving Live for the
// Menu and back — re-entering resumes it instead of the hero pick).
let lastStreamId: string | null = null

// …and the CATEGORY that channel was tuned FROM (Phase 4, operator feedback): the
// scope zap() rings over, and the scope Enter/click-from-fullscreen reopens the
// left panel to. 'All' = the global channel-number ring (the old feel).
// Module-level for the same reason as lastStreamId: a trip out to the Menu must
// not forget which rail the viewer lives on. (The App remounts this screen per
// jump — LiveScreen is keyed — so per-mount state would forget even sooner.)
let lastTuneScope: string = 'All'

// A tune with NO browsing context — a Favorites/Search jump, the hero autoplay, a
// category the catalog no longer has — takes its scope from the channel's own
// filing (design rule, shared with the RN twin: the viewer will be STANDING on
// that channel, so the rail it lives on is the honest context). Prefer the
// channel's first full 'Parent/Sub' entry that the model actually has a group for
// (the drilled rail a viewer would find it on), fall back to a bare parent that
// does, else 'All'.
function deriveTuneScope (s: Stream | null | undefined, model: CategoryModel): string {
  if (!s) return 'All'
  const cats = s.category ?? []
  for (const c of cats) { if (c && c !== 'All' && model.groups[c]) return c }
  for (const c of cats) {
    if (!c || c === 'All') continue
    const [parent] = splitCategory(c)
    if (parent && model.groups[parent]) return parent
  }
  return 'All'
}

function clockText (d: Date) {
  const h = d.getHours(); const m = d.getMinutes()
  return `${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}`
}

export function LiveScreen ({ onExit, initialStreamId, initialCategory, onGuide }: {
  onExit: () => void
  initialStreamId?: string
  /** The browsing context initialStreamId was picked FROM (the Guide's active
   *  category chip — Phase 4). Absent (Favorites/Search jumps), the channel's own
   *  filing stands in via deriveTuneScope. Meaningless without initialStreamId. */
  initialCategory?: string
  /** Two-tier OK (WS4): the channel list's already-playing row opens the full EPG
   *  guide anchored on that channel. Absent = the old single-tier behavior. */
  onGuide?: (streamId: string) => void
}) {
  const { t, tn } = useI18n()
  const [streams, setStreams] = useState<Stream[]>(() => visibleStreams(backend.streams))
  const [favorites, setFavorites] = useState<string[]>(backend.favorites)
  // Parental gate (device-local): a restricted channel about to play while the PIN
  // is set but this session hasn't unlocked yet — the PIN modal resolves it.
  const [pinTarget, setPinTarget] = useState<Stream | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(() => {
    const candidate = initialStreamId ?? lastStreamId ?? pickHero(visibleStreams(backend.streams))?.id ?? null
    const s = backend.streams.find((x) => x.id === candidate)
    return s && needsPin(s) ? null : candidate // the mount effect below raises the PIN modal
  })
  const [overlay, setOverlay] = useState<Overlay>(() => ((initialStreamId ?? lastStreamId) ? 'none' : 'list'))
  const [infoStream, setInfoStream] = useState<Stream | null>(null)
  // Two-level category browse: `selected` is the group key whose channels show;
  // `drillParent` is the parent whose sub-categories the rail currently shows.
  const [selected, setSelected] = useState('All')
  const [drillParent, setDrillParent] = useState<string | null>(null)
  // Which pane owns ↑/↓ while the browse overlay is open.
  const [pane, setPane] = useState<'rail' | 'list'>('list')
  const [railFocus, setRailFocus] = useState(0)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tuneUI, setTuneUI] = useState<{ id: number; phase: TunePillPhase; active: boolean } | null>(null)
  const [now, setNow] = useState(() => new Date())
  // In-stream tracks of the CURRENT channel + the picks (subtitles default Off,
  // audio = player default). Reset on channel change — a new stream's tracks differ.
  const [audioTracks, setAudioTracks] = useState<MediaTrack[]>([])
  const [textTracks, setTextTracks] = useState<MediaTrack[]>([])
  const [selectedText, setSelectedText] = useState(-1)
  const [selectedAudio, setSelectedAudio] = useState<number | undefined>(undefined)
  const [showTracks, setShowTracks] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  // Bottom bar + cursor idle.
  const [barShown, setBarShown] = useState(true)
  const [cursorHidden, setCursorHidden] = useState(false)
  // vod transport (S8a): playhead (whole seconds), runtime (player-reported on load,
  // catalog durationSec until then), app-owned pause.
  const [vodPos, setVodPos] = useState(0)
  const [vodDur, setVodDur] = useState(0)
  const [vodPaused, setVodPausedState] = useState(false)
  const vodPausedRef = useRef(false)
  function setVodPaused (v: boolean) { vodPausedRef.current = v; setVodPausedState(v) }

  const videoHandle = useRef<HlsVideoHandle | null>(null)
  // In-app volume (QA round 3): applied to the <video> by HlsVideo, persisted in
  // localStorage (shared with the VOD player).
  const [{ volume, muted }, setVol] = useState(loadVolume)
  function setVolume (v: number, m: boolean) { setVol({ volume: v, muted: m }); saveVolume(v, m); showBar() }
  const volRef = useRef({ volume, muted }); volRef.current = { volume, muted }
  const menuIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const barIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overlayRef = useRef(overlay); overlayRef.current = overlay
  const playingIdRef = useRef(playingId); playingIdRef.current = playingId
  const paneRef = useRef(pane); paneRef.current = pane
  const drillRef = useRef(drillParent); drillRef.current = drillParent
  const selectedRef = useRef(selected); selectedRef.current = selected

  // Tune scope (Phase 4): the category the playing channel was tuned FROM — the
  // ring zap() walks, and the scope openListInContext() reopens the panel to.
  // Restored from the module-level lastTuneScope (the Menu-trip persistence, like
  // lastStreamId). A ref, not state, on purpose: nothing renders from it — the
  // rail/list render from selected/drillParent, and the displayed channel numbers
  // stay global — while zap() needs the value synchronously in the same
  // interaction that set it (select a row, then ↑ before the next render commit).
  const tuneScopeRef = useRef(lastTuneScope)
  function setTuneScope (key: string) {
    tuneScopeRef.current = key
    lastTuneScope = key
  }
  // The scope validated at USE time (zap / openListInContext) — a catalog push can
  // remove the group the viewer tuned from, or RE-FILE the playing channel out of
  // a group that still exists under the same name — so the check is MEMBERSHIP,
  // not existence: the scope only stands while the playing channel is actually in
  // it. When it fails, the playing channel's own filing stands in
  // (deriveTuneScope), remembered so the next use agrees. EXCEPT when the playing
  // record itself cannot be resolved — a transient empty/provisional streams push
  // mid-reload: degrade this one call to 'All' WITHOUT writing it, or a single
  // zap during a catalog reload would permanently destroy the scope.
  function resolveTuneScope (m: CategoryModel): string {
    const scope = tuneScopeRef.current
    if (scope === 'All') return scope
    const id = playingIdRef.current
    if (m.groups[scope]?.some((x) => x.id === id)) return scope
    const playing = streams.find((x) => x.id === id)
    if (!playing) return 'All' // transient — never persisted
    const derived = deriveTuneScope(playing, m)
    setTuneScope(derived)
    return derived
  }

  // The scope a PIN-deferred tune carries (Phase 4): play() parks it here when it
  // hands the tune to the modal, and the modal's onOk re-enters play() with it —
  // so the scope records only when the tune actually happens. Cleared on decline.
  const pinScope = useRef<string | undefined>(undefined)

  // Did the mount pick the HERO itself? Evaluated during the FIRST render —
  // BEFORE any effect runs, so the pre-mount emptiness of both the jump prop and
  // the remembered channel is still observable here (the lastStreamId-writer
  // effect below overwrites the module var as soon as effects flush; the RN
  // twin's mountedOnHero, for the same reason).
  const mountedOnHero = useRef(playingId != null && !(initialStreamId ?? lastStreamId))

  // Record the mount's own tune context ONCE. Three mount shapes:
  //   - initialStreamId (a Guide/Favorites/Search jump): the caller's category
  //     when it sent one, else the channel's own filing. A PIN-gated candidate
  //     parks the scope for the modal instead — a refused tune moves nothing,
  //     and a candidate the catalog cannot resolve at all records NOTHING (a
  //     fact about this moment, not the viewer's context — the RN twin's rule).
  //   - resumed lastStreamId: lastTuneScope already holds the right scope.
  //   - hero pick (no candidate at all): the hero's own filing (the same rule the
  //     late-hero streams effect below applies when the catalog wasn't in yet).
  useEffect(() => {
    const all = visibleStreams(backend.streams)
    if (initialStreamId) {
      const s = backend.streams.find((x) => x.id === initialStreamId)
      if (s) {
        const scope = initialCategory ?? deriveTuneScope(s, categoryModel(all))
        if (needsPin(s)) pinScope.current = scope
        else setTuneScope(scope)
      }
    } else if (mountedOnHero.current) {
      // Mounted straight onto the hero (catalog already present, nothing to resume).
      setTuneScope(deriveTuneScope(all.find((x) => x.id === playingIdRef.current), categoryModel(all)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    backend.requestPrefs()
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(visibleStreams(m.streams))
      if (m.type === 'prefs') setFavorites(m.favorites)
      // Broadcaster rotated the channel we're watching: the SDK re-resolved behind
      // the same URL and HlsVideo remounts. Clear any prior playback error (that had
      // unmounted the video) so it re-mounts onto the fresh feed.
      if (m.type === 'feed-changed' && m.streamId === playingIdRef.current) setError(null)
    })
  }, [])

  useEffect(() => { if (playingId) lastStreamId = playingId }, [playingId])

  // A new channel has different tracks — clear the picker state; the vod transport
  // resets with them (re-enter cleanly: unpaused, playhead 0, runtime from the
  // record's catalog durationSec until the player reports the real one).
  useEffect(() => {
    setAudioTracks([]); setTextTracks([])
    setSelectedText(-1); setSelectedAudio(undefined)
    setShowTracks(false)
    setVodPaused(false); setVodPos(0)
    const s = backend.streams.find((x) => x.id === playingId)
    setVodDur(s && isVod(s) ? s.durationSec ?? 0 : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingId])

  // Wall clock for the bottom bar.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(timer)
  }, [])

  // --- idle timers (browse overlay, bottom bar, cursor) ---

  function clearMenuIdle () { if (menuIdle.current) { clearTimeout(menuIdle.current); menuIdle.current = null } }
  function bumpMenuIdle () {
    if (overlayRef.current !== 'list') return
    clearMenuIdle()
    menuIdle.current = setTimeout(() => setOverlay('none'), MENU_IDLE_MS)
  }
  useEffect(() => {
    if (overlay === 'list') bumpMenuIdle()
    else clearMenuIdle()
    return clearMenuIdle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay])

  function clearBarIdle () { if (barIdle.current) { clearTimeout(barIdle.current); barIdle.current = null } }
  function showBar () {
    clearBarIdle()
    setBarShown(true)
    if (vodPausedRef.current) return // paused vod: the bar (and its play control) stays up
    barIdle.current = setTimeout(() => setBarShown(false), BAR_IDLE_MS)
  }
  useEffect(() => {
    if (overlay === 'none') showBar()
    else clearBarIdle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, playingId, vodPaused])
  useEffect(() => clearBarIdle, [])

  // Cursor hide over clean fullscreen video; any mouse move reveals bar + cursor.
  function pokeCursor () {
    setCursorHidden(false)
    if (cursorIdle.current) clearTimeout(cursorIdle.current)
    cursorIdle.current = setTimeout(() => { if (overlayRef.current === 'none') setCursorHidden(true) }, CURSOR_IDLE_MS)
  }
  useEffect(() => () => { if (cursorIdle.current) clearTimeout(cursorIdle.current) }, [])

  // --- catalog shaping ---

  const numbers = useMemo(() => channelNumbers(streams), [streams])
  const model = useMemo(() => categoryModel(streams), [streams])
  const activeKey = model.groups[selected] ? selected : 'All'
  const list = model.groups[activeKey] ?? []
  const inDrill = drillParent != null && (model.subs[drillParent]?.length ?? 0) > 0
  const railItems = inDrill
    ? model.subs[drillParent!].map((key) => ({ key, label: subLabel(key) }))
    // 'All' is the everything-group this app adds itself, so it is the only label here
    // that comes out of the catalog. Every other key is an operator category name.
    : model.top.map((key) => ({ key, label: key === 'All' ? t('live.all') : key, hasChildren: (model.subs[key]?.length ?? 0) > 0 }))
  const railSelected = inDrill ? activeKey : splitCategory(activeKey)[0]
  const listHeading = activeKey === 'All' ? t('live.channels') : splitCategory(activeKey).filter((x): x is string => !!x).map((x) => x.toLocaleUpperCase(getLocale())).join('  ›  ')
  const playing = streams.find((s) => s.id === playingId) ?? null
  const playingVod = !!playing && isVod(playing)

  // A restricted entry channel (jumped in from Favorites/Search, or resumed):
  // raise the PIN modal once on mount instead of autoplaying it.
  useEffect(() => {
    const candidate = initialStreamId ?? lastStreamId
    if (playingId || !candidate) return
    const s = backend.streams.find((x) => x.id === candidate)
    if (s && needsPin(s)) setPinTarget(s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // First streams push after a cold navigation: start the hero channel. The hero is
  // picked over autoTunable() alone: the app must never tune a PIN-gated channel on
  // its own initiative, and nothing tunable means nothing plays.
  useEffect(() => {
    if (!playingId && !pinTarget && streams.length) {
      const hero = pickHero(autoTunable(streams))
      // An autoplay is a tune with no browsing context: the hero's own filing is
      // the scope (deriveTuneScope) — Enter-from-fullscreen then opens the panel
      // on the rail the playing channel actually lives on, and the zap ring
      // matches it.
      setTuneScope(deriveTuneScope(hero, categoryModel(streams)))
      setPlayingId(hero?.id ?? null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams])

  function play (s: Stream, { collapse = false, scope }: { collapse?: boolean; scope?: string } = {}) {
    if (needsPin(s)) { pinScope.current = scope; setPinTarget(s); return } // resolved by the PIN modal
    // The tune's browsing context (Phase 4), recorded HERE — past the PIN gate —
    // never at the call sites: a refused tune (the viewer declining the modal)
    // must not move the viewer's scope. `scope` undefined = nothing to record;
    // the current scope stands (a scoped zap keeps its ring).
    if (scope !== undefined) setTuneScope(scope)
    if (s.id !== playingId) {
      setPlayingId(s.id)
      setPeers(null)
      setError(null)
    } else if (error) {
      // The friendly tune-timeout says "switch to it again to retry" — honor
      // re-selecting the SAME channel: clearing the error remounts the video.
      setError(null)
    }
    if (collapse) setOverlay('none')
  }

  // Rail pick. Top-level: a parent WITH subs drills in; a leaf just scopes the list.
  // Drilled: a sub scopes; re-picking the selected sub deselects (back to the whole
  // parent). Any pick shows the channel LIST.
  function selectRail (key: string) {
    if (drillParent == null) {
      if ((model.subs[key]?.length ?? 0) > 0) { setDrillParent(key); setSelected(key) }
      else setSelected(key)
    } else {
      setSelected(key === selected ? drillParent : key)
    }
    setOverlay('list')
  }

  function exitDrill () {
    if (drillParent != null) setSelected(drillParent)
    setDrillParent(null)
    setOverlay('list')
  }

  // Fullscreen zap: prev/next WITHIN the category the viewer tuned from, in that
  // category's own curated order, wrapping (zapRing) — an 'All' tune keeps the old
  // global channel-number ring. Phase 4 (operator feedback), the same reversal the
  // RN twin documents at length: the DISPLAYED channel numbers stay global — only
  // the order the keys walk is scoped.
  //
  // The playing channel not being IN the scoped ring — zapping FROM a vod title,
  // or the scope emptied under a catalog push — falls back to the global ring with
  // the old land-on-001 behavior, and the scope resets to 'All' with it (the
  // viewer is surfing everything now). A ring whose ONLY member is the playing
  // channel widens outward instead of going silent — sub → parent → global.
  function zap (dir: 1 | -1) {
    const m = categoryModel(streams)
    const scope = resolveTuneScope(m)
    let ring = zapRing(streams, m, scope)
    // What the scope should BECOME if this press tunes. undefined = unchanged (a
    // scoped zap keeps its ring); it rides play()'s scope option, so a refused
    // tune (PIN) moves nothing.
    let nextScope: string | undefined
    // THE LADDER for a ring with no other channel to give: the key means "next
    // channel", and a one-game category must not make ↑/↓ dead keys — widen to
    // the NEAREST larger circle first: the sub's parent (still the viewer's
    // neighborhood), then the global ring. The scope follows the ring that
    // actually answered, so the next press keeps walking it.
    const onlyPlaying = (r: Stream[]) => r.length === 1 && r[0].id === playingId
    if (onlyPlaying(ring)) {
      const [parent, sub] = splitCategory(scope)
      if (sub !== undefined) { ring = zapRing(streams, m, parent); nextScope = parent }
      if (onlyPlaying(ring)) { ring = zapOrder(streams); nextScope = 'All' }
    }
    let i = ring.findIndex((s) => s.id === playingId)
    if (i < 0) {
      // Not in the ring the scope named (a vod title plays, or the group changed
      // under us — zapRing may itself have degraded to global already): this
      // press is a GLOBAL zap, and the scope follows it to 'All' — deliberately
      // NOT re-derived from the landed channel: the viewer is surfing everything.
      ring = zapOrder(streams)
      i = ring.findIndex((s) => s.id === playingId)
      nextScope = 'All'
    }
    if (!ring.length) return
    const next = ring[(i < 0 ? 0 : i + dir + ring.length) % ring.length]
    if (next) play(next, { scope: nextScope })
  }

  // Enter/click from fullscreen: reopen the left panel IN CONTEXT (Phase 4) —
  // scoped to the category the playing channel was tuned from, DRILLED into it
  // when that is a 'Parent/Sub' (the "‹ Parent" back header up, the sub pill
  // active), instead of the bare setOverlay('list') that landed the viewer back
  // on whatever stale scope remained ('All' after a mount — the operator-reported
  // bug). ChannelList already mounts focused on the playing row — it just never
  // could while the panel opened on a scope that didn't contain the channel.
  // For a BARE PARENT scope this deliberately does NOT drill even when the
  // parent has subs — the viewer tuned from the whole parent, and the top rail
  // with the parent pill selected IS that state (one Esc closes instead of two).
  // The Esc-unwind ladder (overlayBack) walks the restored state unchanged.
  function openListInContext () {
    const m = categoryModel(streams)
    const scope = resolveTuneScope(m)
    const [parent, sub] = splitCategory(scope)
    const drilled = sub !== undefined && (m.subs[parent]?.length ?? 0) > 0
    setDrillParent(drilled ? parent : null)
    setSelected(scope)
    // Land the rail's keyboard focus on the restored pill, so stepping into the
    // rail starts from the viewer's context (the state writes batch — compute the
    // fresh rail contents here rather than reading stale railItems).
    const keys = drilled ? m.subs[parent] : m.top
    setRailFocus(Math.max(0, keys.indexOf(drilled ? scope : parent)))
    setPane('list')
    setOverlay('list')
  }

  function onTune (e: TuneEvent) {
    if (e.phase === 'playing') setTuneUI((ui) => (ui && ui.id === e.id ? { ...ui, active: false } : ui))
    else setTuneUI({ id: e.id, phase: e.phase === 'start' ? 'tuning' : e.phase, active: true })
  }

  // Channel detail. `fromFullscreen` marks the entries that never passed through
  // the list (the `i` key / the bar's Info button over clean fullscreen): watching
  // from THERE records no scope — activeKey is whatever stale browse scope
  // remained, not the viewer's context (the RN twin's infoFromFullscreen rule).
  const infoFromFullscreen = useRef(false)
  function openInfo (s: Stream, { fromFullscreen = false }: { fromFullscreen?: boolean } = {}) {
    infoFromFullscreen.current = fromFullscreen
    setInfoStream(s)
    setOverlay('info')
  }

  // BACK semantics (Esc), mirroring the TV app: info → the list it came from — or
  // straight back to fullscreen when it was opened THERE (the `i` key / the bar's
  // Info button): dropping the viewer into a list they never opened takes them
  // further FROM the picture, not back to it (the RN twin's rule). The list
  // unwinds the category drill before closing; fullscreen exits to Menu.
  function overlayBack () {
    if (overlayRef.current === 'info') {
      const toFullscreen = infoFromFullscreen.current
      infoFromFullscreen.current = false
      setOverlay(toFullscreen ? 'none' : 'list')
      return
    }
    if (drillRef.current != null && selectedRef.current !== drillRef.current) { setSelected(drillRef.current); return }
    if (drillRef.current != null) { setDrillParent(null); return }
    setOverlay('none')
  }

  // --- keyboard: fullscreen + rail + info (ChannelList owns its rows itself) ---

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showTracks) return // TrackMenu captures its own keys
      if (pinTarget) return // PIN modal owns its keys (Esc via its capture listener)
      if (reportOpen) { if (e.key === 'Escape') { e.preventDefault(); setReportOpen(false) } return } // modal owns its keys
      const ov = overlayRef.current
      if (ov === 'none') {
        if (e.key === 'ArrowUp') { e.preventDefault(); zap(1); showBar() }
        else if (e.key === 'ArrowDown') { e.preventDefault(); zap(-1); showBar() }
        else if (e.key === 'Enter') { e.preventDefault(); openListInContext() }
        else if (e.key === 'Escape') { e.preventDefault(); onExit() }
        else if ((e.key === 'i' || e.key === 'I') && playing) { e.preventDefault(); openInfo(playing, { fromFullscreen: true }) }
        else if ((e.key === 'f' || e.key === 'F') && playing) { e.preventDefault(); backend.toggleFavorite(playing.id); showBar() }
        else if ((e.key === 'r' || e.key === 'R') && playing) { e.preventDefault(); setReportOpen(true) }
        else if ((e.key === 'c' || e.key === 'C') && (textTracks.length > 0 || audioTracks.length > 1)) { e.preventDefault(); setShowTracks(true) }
        else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); setVolume(volRef.current.volume, !volRef.current.muted) }
        else if (e.key === ' ' && playingVod) { e.preventDefault(); toggleVodPause() }
      } else if (ov === 'list' && paneRef.current === 'rail') {
        if (e.key === 'ArrowDown') { e.preventDefault(); bumpMenuIdle(); setRailFocus((i) => Math.min(railItems.length - 1, i + 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); bumpMenuIdle(); setRailFocus((i) => Math.max(0, i - 1)) }
        else if (e.key === 'Enter') { e.preventDefault(); bumpMenuIdle(); const it = railItems[railFocus]; if (it) selectRail(it.key) }
        else if (e.key === 'ArrowRight') { e.preventDefault(); bumpMenuIdle(); setPane('list') }
        else if (e.key === 'Escape') { e.preventDefault(); overlayBack() }
      } else if (ov === 'info') {
        if (e.key === 'Escape') { e.preventDefault(); overlayBack() }
        else if (e.key === 'Enter' && infoStream) {
          e.preventDefault()
          // The browse scope at PRESS time, via selectedRef (`selected` can move
          // without re-registering this listener) — but detail reached from
          // fullscreen records nothing: the stale browse scope is not the
          // viewer's context.
          const sel = selectedRef.current
          const scope = infoFromFullscreen.current ? undefined : (categoryModel(streams).groups[sel] ? sel : 'All')
          play(streams.find((s) => s.id === infoStream.id) ?? infoStream, { collapse: true, scope })
        }
        else if ((e.key === 'f' || e.key === 'F') && infoStream) { e.preventDefault(); backend.toggleFavorite(infoStream.id) }
      }
      // ov === 'list' && pane 'list': ChannelList's own listener handles it, except ←:
      if (ov === 'list' && paneRef.current === 'list' && e.key === 'ArrowLeft') { e.preventDefault(); bumpMenuIdle(); setPane('rail') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams, playingId, error, railItems, railFocus, infoStream, showTracks, reportOpen, pinTarget, textTracks, audioTracks, playingVod, playing])

  function toggleVodPause () {
    // ▶ on a finished title replays from the top (unpausing at the end is a no-op —
    // the player is already "ended").
    if (vodPausedRef.current && vodDur > 0 && vodPos >= Math.floor(vodDur) - 1) { videoHandle.current?.seek(0); setVodPos(0) }
    setVodPaused(!vodPausedRef.current)
    showBar()
  }

  if (!streams.length) {
    return <div className="section-loading"><span className="spinner" /><div>{t('live.waitingForChannels')}</div></div>
  }

  return (
    <div className={'live' + (cursorHidden && overlay === 'none' ? ' cursor-hidden' : '')} onMouseMove={() => { pokeCursor(); if (overlayRef.current === 'none') showBar() }}>
      {playingId && !error && (
        <HlsVideo
          ref={videoHandle}
          backend={backend}
          streamId={playingId}
          paused={playingVod && vodPaused}
          onSource={(_url, s) => setSource(s)}
          onPeers={setPeers}
          onTune={onTune}
          onStall={() => console.log('[live] stall resync', playingIdRef.current)}
          onError={(msg) => { setError(msg); setTuneUI(null) }}
          onAudioTracks={setAudioTracks}
          onTextTracks={setTextTracks}
          selectedAudio={selectedAudio}
          selectedText={selectedText}
          // vod transport feed: playhead (one update/second via Math.floor), the
          // player-reported runtime, end-of-title parking the transport on ▶.
          onProgress={playingVod ? setVodPos : undefined}
          onDuration={playingVod ? ((d) => { if (d > 0) setVodDur(d) }) : undefined}
          onEnded={playingVod ? (() => { setVodPaused(true); showBar() }) : undefined}
          volume={volume}
          muted={muted}
        />
      )}

      {/* Fullscreen surface: a click opens the channel list — scoped to the
          tuned-from category (Phase 4). */}
      {overlay === 'none' && <div className="live-catcher" onClick={openListInContext} />}

      {error && (
        <div className="live-error">
          <div className="live-error-title">{t('live.playbackFailed')}</div>
          {/* The engine's own message, English by design (S56) — never translated. */}
          <div className="live-error-msg">{error}</div>
          <div className="live-error-hint">{t('hints.retryEnter', { enter: 'Enter' })}</div>
        </div>
      )}

      {overlay !== 'none' && (
        <div className="live-panels" onMouseMove={bumpMenuIdle}>
          <CategoryRail
            items={railItems}
            selected={railSelected}
            focusIndex={pane === 'rail' && overlay === 'list' ? railFocus : -1}
            parentHeader={inDrill ? { label: drillParent!, onBack: exitDrill } : undefined}
            onSelect={selectRail}
            onActivity={bumpMenuIdle}
          />
          {overlay === 'list' ? (
            <ChannelList
              streams={list}
              heading={listHeading}
              numbers={numbers}
              playingId={playingId}
              favorites={favorites}
              active={pane === 'list'}
              // The tune's browsing context (Phase 4): the scope the LIST is
              // showing at press time. Recorded by play() itself, past its gate.
              onSelect={(s) => play(s, { collapse: true, scope: activeKey })}
              onInfo={openInfo}
              // Two-tier OK — but NOT while a playback error is up: play() honors
              // re-selecting the SAME channel as the retry the error message
              // promises, and routing that press to the Guide would shadow it.
              // Absent onGuide = the old path (the client's exact rule).
              onGuide={error || !onGuide ? undefined : (s) => onGuide(s.id)}
              onClose={overlayBack}
              onActivity={bumpMenuIdle}
            />
          ) : (
            infoStream && (
              <ChannelInfoPanel
                stream={streams.find((s) => s.id === infoStream.id) ?? infoStream}
                number={numbers.get(infoStream.id)}
                favorite={favorites.includes(infoStream.id)}
                playing={infoStream.id === playingId}
                source={source}
                peers={peers}
                onWatch={() => play(streams.find((s) => s.id === infoStream.id) ?? infoStream, { collapse: true, scope: infoFromFullscreen.current ? undefined : activeKey })}
                onToggleFavorite={() => backend.toggleFavorite(infoStream.id)}
              />
            )
          )}
        </div>
      )}

      {/* Bottom bar + status badge — fullscreen chrome, fades after idle. */}
      {overlay === 'none' && playing && (
        <div className={'live-chrome' + (barShown ? '' : ' hidden')}>
          <NowPlayingBar
            stream={playing}
            number={numbers.get(playing.id)}
            clock={clockText(now)}
            favorite={favorites.includes(playing.id)}
            onChannels={openListInContext}
            onInfo={() => openInfo(playing, { fromFullscreen: true })}
            onToggleFavorite={() => { showBar(); backend.toggleFavorite(playing.id) }}
            onReport={() => { showBar(); setReportOpen(true) }}
            hasTracks={textTracks.length > 0 || audioTracks.length > 1}
            onTracks={() => { showBar(); setShowTracks(true) }}
            vod={playingVod ? { position: vodPos, duration: vodDur, paused: vodPaused } : null}
            onTogglePause={toggleVodPause}
            onSeek={(sec) => {
              videoHandle.current?.seek(sec)
              // Optimistic playhead: while paused no progress event will confirm the
              // jump, and the bar must not snap back under the pointer.
              setVodPos(Math.floor(sec))
              showBar()
            }}
            volume={volume}
            muted={muted}
            onVolume={setVolume}
          />
          {source && (
            <div className="status-badge">
              <span className={source === 'p2p' ? 'src-p2p' : 'src-cdn'}>{source.toUpperCase()}</span>
              {source === 'p2p' && peers != null && <span className="badge-peers">{tn('live.peers', peers)}</span>}
            </div>
          )}
        </div>
      )}

      {tuneUI && (
        <TunePill
          key={tuneUI.id}
          active={tuneUI.active}
          phase={tuneUI.phase}
          number={playing ? numbers.get(playing.id) : undefined}
          title={playing ? displayTitle(playing) : undefined}
        />
      )}

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

      {/* "Report a problem" (S51) — from the bar's Report button or the `r` key. The
          engine attaches the ACTIVE stream, so it is only reachable during playback.
          RAW title, not displayTitle: a viewer problem report must name the channel
          exactly as the panel stores it — the operator reading it greps the lineup. */}
      {reportOpen && <ReportModal channelTitle={playing?.title} onClose={() => setReportOpen(false)} />}

      {/* Parental gate: a restricted channel was picked while locked. One correct
          PIN unlocks the rest of the app session. */}
      {pinTarget && (
        <PinEntryModal
          title={t('live.enterPin')}
          hint={t('live.restricted', { title: (pinTarget.title && displayTitle(pinTarget)) || pinTarget.id })}
          onOk={() => {
            markUnlocked()
            const s = pinTarget
            setPinTarget(null)
            // The scope the deferred tune carried (parked by play() when it raised
            // this modal) rides back in — recorded only now that the tune happens.
            play(s, { collapse: true, scope: pinScope.current })
            pinScope.current = undefined
          }}
          onClose={() => {
            setPinTarget(null)
            pinScope.current = undefined // declined: the deferred scope dies with the tune
            // The mount-time case: nothing playing yet — fall back to the hero. The
            // fallback is PIN-free by construction (autoTunable): declining the
            // challenge must not hand over some OTHER restricted channel instead, and
            // when they are all locked it leaves nothing playing rather than re-asking.
            if (!playingIdRef.current && streams.length) {
              const hero = pickHero(autoTunable(streams))
              // The same no-context autoplay as the streams effect: the hero's own
              // filing is the tune scope.
              setTuneScope(deriveTuneScope(hero, categoryModel(streams)))
              setPlayingId(hero?.id ?? null)
            }
          }}
        />
      )}
    </div>
  )
}
