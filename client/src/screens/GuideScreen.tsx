// Guide — the full EPG surface (WS3): every channel's schedule from the same data
// layer the Info panel reads (useEpgPrograms — P2P guide drive first, https provider
// feed fallback). ONE screen, two presentations (the VodScreen TV/phone split), both
// the SAME zoomed-out time-grid method over src/guide.ts's math:
//
//   GuideGrid (TV)   a classic timeline grid — channel column (number + station
//                    logo; channel identity, per the WS11 thumbnail policy)
//                    beside a 2 h window of absolutely-positioned program cells,
//                    paged in 30-min slots between now − 6 h and now + 48 h (the SDK's
//                    data window). The header's upper right carries the PREVIEW
//                    CARD (GuidePreviewCard — the live thumbnail's one surface):
//                    the channel the virtual focus is placed on but has not tuned,
//                    as a rolling live frame + the focused program's title/time;
//                    the playing channel (or a thumb 404) shows the logo version.
//                    Display-only — it owns no focusables, and it sits INSIDE the
//                    header row's layout, so it can never overlap the time bar or
//                    the grid. Focus is VIRTUAL: react-native-tvos on Android
//                    does not dispatch HW key events while a view holds native focus
//                    (the S7 lesson), so native focus stays parked on an invisible
//                    catcher and four edge strips bounce D-pad presses into the pure
//                    moveFocus reducer (src/guide.ts) — the generalization of
//                    LiveScreen's zap-strip rig. Walking UP off the grid releases
//                    native focus to the header (category chips + the NOW pill);
//                    DOWN from the header lands back on the catcher. OK tunes the
//                    focused row's channel; BACK leaves the header for the grid,
//                    else pops back to where the viewer came from.
//   GuidePanel (phone) the same timeline as a touch grid (WS7 — the now/next-only
//                    list "looked bad" on device): dense ~52px rows, horizontal
//                    fling pages the window one slot, tap tunes. Lives in
//                    components/GuidePanel.tsx because LiveScreen also mounts it as
//                    its 'guide' overlay — portrait shows the playing stream as a
//                    16:9 strip ABOVE the grid there, video never stopping. This
//                    screen remains the standalone (no-video) entry.
//
// Entry points: the Menu tile (TV; on phone the tile opens Live with the guide
// overlay up — see LiveScreen), and OK on the ALREADY-PLAYING row of Live TV's
// channel list (previously a no-op re-tune — see ChannelListPanel.onGuide). Tuning
// navigates back to Live with the picked channel; Live honors the fresh param.
// Guide-less channels show one honest full-width "No program information" cell
// (D2 — no fake data), and vod titles have no schedule, so they stay out entirely.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Image, Pressable, FlatList, StyleSheet, Platform, BackHandler, TVFocusGuideView, useWindowDimensions } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { useI18n } from '@aliran/i18n'
import { backend, type Stream } from '../worklet'
import { visibleStreams } from '../parental'
import { channelNumbers, categoryModel, splitCategory, formatChannelNumber, isVod, SUBCAT_SEP, type CategoryModel } from '../catalog'
import { useEpgPrograms, type EpgProgram } from '@aliran/react-native'
import { ProgressHairline } from '../components/ProgressHairline'
import { SectionLoading } from '../components/SectionLoading'
import { GuidePanel, GuidePreviewCard, CategoryChips, TimeBar, CELL_GAP, hhmm } from '../components/GuidePanel'
import {
  GUIDE_ROW_H, GUIDE_ROW_INNER_H, GUIDE_ROW_MB, GUIDE_WINDOW_MS, GUIDE_WINDOW_MIN, GUIDE_SLOTS,
  MIN_CELL_W, cellRect, visiblePrograms, moveFocus, snapToNow,
  type GuideFocus, type GuideDir
} from '../guide'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Guide'>

// On phone TVFocusGuideView is just a View; on TV autoFocus restores focus memory (S7).
const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

// TV channel column: number (52, the ChannelRow width) + 96×54 logo box + padding
// (the box kept the thumb era's size, so the grid geometry never moved — WS11).
const CH_COL_W = 176
const LOGO_W = 96
const LOGO_H = 54

// The focus-engine rig (TV): invisible edge strips around a central catcher, laid
// out INSIDE the grid body so the header chips stay out of the strip geometry.
const STRIP = 64

export function GuideScreen (props: Props) {
  // theme.isTV is fixed for the app's lifetime, so the branch never flips mid-mount.
  return theme.isTV ? <GuideScreenTV {...props} /> : <GuideScreenPhone {...props} />
}

// ---------------------------------------------------------------------------
// Phone: the standalone screen is a thin shell over the shared GuidePanel (the
// grid itself also mounts inside LiveScreen's 'guide' overlay, where the playing
// stream renders above it — this route stays for direct navigation).
// ---------------------------------------------------------------------------

function GuideScreenPhone ({ route, navigation }: Props) {
  const { t } = useI18n()
  const tune = useCallback((s: Stream) => {
    // The same jump Favorites/Search make; Live honors the param when already
    // mounted. tuneKey makes even a VALUE-EQUAL streamId (re-tuning the channel
    // Live is already on) register as a fresh param there.
    navigation.navigate('Live', { streamId: s.id, tuneKey: Date.now() })
  }, [navigation])
  return (
    <View style={styles.container}>
      <Text style={styles.header}>{t('guide.header')}</Text>
      <GuidePanel playingId={route.params?.streamId ?? null} onTune={tune} />
    </View>
  )
}

// ---------------------------------------------------------------------------
// TV: the timeline grid + virtual-focus rig.
// ---------------------------------------------------------------------------

function GuideScreenTV ({ route, navigation }: Props) {
  const { t } = useI18n()
  const [streams, setStreams] = useState<Stream[]>(() => visibleStreams(backend.streams))
  // Category scope — the CategoryRail's two-level model rendered as chips (a rail
  // would eat width this timeline needs; chips are the VOD tab-bar grammar). The
  // drill state is DERIVED from the selection: picking a parent with subs shows its
  // sub-chips row; re-tapping the selected sub returns to the parent.
  const [selected, setSelected] = useState('All')
  // Slow clock: past-dimming, the airing cell and every hairline ride this tick.
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'streams') setStreams(visibleStreams(m.streams))
    })
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  const model = useMemo(() => categoryModel(streams), [streams])
  const numbers = useMemo(() => channelNumbers(streams), [streams])
  const activeKey = model.groups[selected] ? selected : 'All'
  // The guide is a CHANNEL surface: vod titles have no schedule (ChannelInfoPanel
  // omits their guide slot for the same reason) and stay out of the rows.
  const list = useMemo(() => (model.groups[activeKey] ?? []).filter((s) => !isVod(s)), [model, activeKey])
  // The channel Live was on when it opened us — the NOW pill target and the row the
  // list mounts at.
  const playingId = route.params?.streamId ?? null

  const pickCategory = useCallback((key: string) => {
    // Re-tapping the selected sub-category deselects it (back to the whole parent).
    setSelected((prev) => (prev === key && key.includes(SUBCAT_SEP) ? splitCategory(key)[0] : key))
  }, [])

  const tune = useCallback((s: Stream) => {
    // The same jump Favorites/Search make; Live honors the param when already
    // mounted. tuneKey makes even a VALUE-EQUAL streamId (re-tuning the channel
    // Live is already on) register as a fresh param there.
    navigation.navigate('Live', { streamId: s.id, tuneKey: Date.now() })
  }, [navigation])

  if (!streams.length) return <SectionLoading section={t('menu.guide')} hint={t('live.waitingForChannels')} />

  return <GuideGrid model={model} activeKey={activeKey} onSelectCategory={pickCategory} list={list} numbers={numbers} playingId={playingId} nowMs={nowMs} onTune={tune} />
}

interface GuideBodyProps {
  model: CategoryModel
  activeKey: string
  onSelectCategory: (key: string) => void
  list: Stream[]
  numbers: Map<string, number>
  playingId: string | null
  nowMs: number
  onTune: (s: Stream) => void
}

function GuideGrid ({ model, activeKey, onSelectCategory, list, numbers, playingId, nowMs, onTune }: GuideBodyProps) {
  const { t } = useI18n()
  const { width } = useWindowDimensions()
  const stripW = Math.max(GUIDE_SLOTS * MIN_CELL_W, width - theme.safeX * 2 - CH_COL_W)
  const pxPerMin = stripW / GUIDE_WINDOW_MIN

  // Virtual grid focus (styled from state — cells are never native-focusable) and
  // the header zone flag: true = native focus is up among the chips/NOW pill.
  const [focus, setFocus] = useState<GuideFocus>(() => {
    const ws = snapToNow(Date.now())
    return { focusRow: Math.max(0, list.findIndex((s) => s.id === playingId)), focusCellStart: ws, windowStart: ws }
  })
  const [headerFocus, setHeaderFocus] = useState(false)
  const focusRef = useRef(focus); focusRef.current = focus
  const headerFocusRef = useRef(headerFocus); headerFocusRef.current = headerFocus

  // Programs per stream id, reported up by the MOUNTED rows (each row owns its
  // useEpgPrograms hook) — the reducer reads whatever is known; a row not yet
  // loaded/mounted reads as guide-less, which is exactly its on-screen state.
  // The version bump re-renders the header's preview card when the focused row's
  // programs arrive (the ref alone would leave its caption blank until the next
  // focus move or clock tick).
  const programsRef = useRef(new Map<string, EpgProgram[]>())
  const [, setProgramsVersion] = useState(0)
  const reportPrograms = useCallback((id: string, programs: EpgProgram[]) => {
    programsRef.current.set(id, programs)
    setProgramsVersion((v) => v + 1)
  }, [])

  const listRef = useRef<FlatList<Stream>>(null)
  const catcherRef = useRef<React.ComponentRef<typeof Pressable> | null>(null)
  const nowPillRef = useRef<any>(null)

  function bounceToGrid () {
    requestAnimationFrame(() => (catcherRef.current as any)?.requestTVFocus?.())
  }

  // The rig: a strip focus is a D-pad press — run the reducer, bounce native focus
  // straight back to the catcher (LiveScreen's bounceZap, generalized to 4 ways).
  function dispatchMove (dir: GuideDir) {
    const rows = list.map((s) => programsRef.current.get(s.id) ?? [])
    const r = moveFocus(focusRef.current, dir, { rows, now: Date.now() })
    if ('exit' in r) {
      // Row 0 + up: release native focus to the header zone (chips + NOW pill).
      // Move focus off the strip SYNCHRONOUSLY, before setHeaderFocus unmounts the
      // strips — otherwise the unmount can dump native focus onto the catcher,
      // whose onFocus would instantly undo the exit.
      nowPillRef.current?.requestTVFocus?.()
      setHeaderFocus(true)
      return
    }
    setFocus(r)
    bounceToGrid()
  }

  // BACK from the header returns to the grid; from the grid, default (pop away).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (headerFocusRef.current) { setHeaderFocus(false); bounceToGrid(); return true }
      return false
    })
    return () => sub.remove()
  }, [])

  // Follow the virtual focus: keep the focused row around the middle third (the
  // ChannelListPanel scroll discipline — exact rows, so the jump is one frame).
  useEffect(() => {
    try { listRef.current?.scrollToIndex({ index: focus.focusRow, animated: false, viewPosition: 0.35 }) } catch {}
  }, [focus.focusRow])

  // Category switch: re-anchor the focus on the playing channel (or the top).
  const firstScope = useRef(true)
  useEffect(() => {
    if (firstScope.current) { firstScope.current = false; return }
    setFocus((f) => ({ ...f, focusRow: Math.max(0, list.findIndex((s) => s.id === playingId)) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey])

  // The NOW pill: window back to the current half-hour, focus back on the playing
  // channel, native focus back down on the grid.
  function jumpToNow () {
    const ws = snapToNow(Date.now())
    setFocus({ focusRow: Math.max(0, list.findIndex((s) => s.id === playingId)), focusCellStart: ws, windowStart: ws })
    setHeaderFocus(false)
    bounceToGrid()
  }

  const initialIndex = Math.max(0, list.findIndex((s) => s.id === playingId))

  // The preview card's subject: the channel the virtual focus is placed on, and the
  // exact program cell the reducer named (nothing when the focus position fell in a
  // schedule gap or the row's programs have not arrived — the card shows identity
  // only, constant footprint either way).
  const previewStream = list[focus.focusRow] ?? null
  const previewProgram = previewStream
    ? (programsRef.current.get(previewStream.id) ?? []).find((p) => p.start === focus.focusCellStart) ?? null
    : null

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>{t('guide.header')}</Text>
        <FocusPane autoFocus style={styles.chipsPane}>
          <CategoryChips model={model} activeKey={activeKey} onSelect={onSelectCategory} onNow={jumpToNow} nowPillRef={nowPillRef} />
        </FocusPane>
        {/* Upper-right preview pane — display-only (no focusables, so the focus rig
            never sees it) and INSIDE the header row, so the reserved width/height
            keep it clear of the time bar and the grid below. */}
        {previewStream && (
          <GuidePreviewCard
            stream={previewStream}
            number={numbers.get(previewStream.id)}
            playing={previewStream.id === playingId}
            program={previewProgram}
          />
        )}
      </View>

      <TimeBar windowStart={focus.windowStart} nowMs={nowMs} pxPerMin={pxPerMin} leadW={CH_COL_W} />

      <View style={styles.body}>
        <FlatList
          ref={listRef}
          data={list}
          keyExtractor={(s) => s.id}
          getItemLayout={(_, index) => ({ length: GUIDE_ROW_H, offset: GUIDE_ROW_H * index, index })}
          initialScrollIndex={initialIndex > 0 ? initialIndex : undefined}
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({ offset: GUIDE_ROW_H * info.index, animated: false })
            setTimeout(() => { try { listRef.current?.scrollToIndex({ index: info.index, animated: false, viewPosition: 0.35 }) } catch {} }, 60)
          }}
          extraData={[focus, nowMs, stripW]}
          // Keep the mounted window tight: every mounted row runs an EPG tick and a
          // thumb timer, so a 150-channel category must not keep 150 of each alive.
          windowSize={5}
          initialNumToRender={12}
          removeClippedSubviews
          renderItem={({ item, index }) => (
            <GuideRowTV
              stream={item}
              number={numbers.get(item.id)}
              playing={item.id === playingId}
              windowStart={focus.windowStart}
              stripW={stripW}
              pxPerMin={pxPerMin}
              nowMs={nowMs}
              focusedCellStart={index === focus.focusRow ? focus.focusCellStart : null}
              onPrograms={reportPrograms}
            />
          )}
        />

        {/* The focus engine's puppet theater: native focus lives on the catcher; the
            four strips exist only to turn a D-pad press into a moveFocus dispatch.
            While the header holds focus the strips unmount (chips navigate natively)
            and the catcher doubles as the way back down (focus lands on it). */}
        <Pressable
          ref={catcherRef}
          style={styles.catcher}
          hasTVPreferredFocus
          onFocus={() => { if (headerFocusRef.current) setHeaderFocus(false) }}
          onPress={() => { const s = list[focusRef.current.focusRow]; if (s) onTune(s) }}
        />
        {!headerFocus && (
          <>
            <Pressable style={styles.stripUp} onFocus={() => dispatchMove('up')} />
            <Pressable style={styles.stripDown} onFocus={() => dispatchMove('down')} />
            <Pressable style={styles.stripLeft} onFocus={() => dispatchMove('left')} />
            <Pressable style={styles.stripRight} onFocus={() => dispatchMove('right')} />
          </>
        )}
      </View>
    </View>
  )
}

// One grid row: channel cell (number + station logo — identity, never the live
// thumb; that belongs to the header's preview card, WS11) + the window's program
// cells, absolutely positioned from cellRect. Only MOUNTED rows fetch
// (useEpgPrograms lives here, so a 300-row lineup costs only the visible window).
function GuideRowTV ({ stream, number, playing, windowStart, stripW, pxPerMin, nowMs, focusedCellStart, onPrograms }: {
  stream: Stream
  number?: number
  playing: boolean
  windowStart: number
  stripW: number
  pxPerMin: number
  nowMs: number
  /** The virtual focus when THIS row holds it (the focused program's start), else null. */
  focusedCellStart: number | null
  onPrograms: (id: string, programs: EpgProgram[]) => void
}) {
  const { t } = useI18n()
  const programs = useEpgPrograms(stream.epgUrl, stream.epgId, stream.guideBase)
  useEffect(() => { onPrograms(stream.id, programs) }, [stream.id, programs, onPrograms])

  const visible = visiblePrograms(programs, windowStart, windowStart + GUIDE_WINDOW_MS)
  // The focus highlight: the exact cell the reducer named; if the focus position
  // fell in a schedule gap, light the first visible cell so the row's focus is
  // never invisible.
  const focusStart = focusedCellStart == null
    ? null
    : visible.some((p) => p.start === focusedCellStart) ? focusedCellStart : visible[0]?.start ?? null

  return (
    <View style={[styles.gridRow, playing && styles.rowPlaying]}>
      <View style={styles.chCell}>
        <Text style={styles.chNumber}>{formatChannelNumber(number)}</Text>
        {stream.logo
          ? <Image source={{ uri: stream.logo }} style={styles.chLogo} resizeMode="contain" accessibilityLabel={stream.title} />
          : <View style={[styles.chLogo, styles.chLogoFallback]}><Text style={styles.chInitial}>{(stream.title || '?').slice(0, 1).toUpperCase()}</Text></View>}
      </View>
      <View style={[styles.strip, { width: stripW }]}>
        {visible.length === 0
          ? (
            <View style={[styles.cell, styles.cellAtStart, { width: stripW }, focusedCellStart != null && styles.cellFocused]}>
              <Text style={[styles.cellTitle, styles.cellEmpty, focusedCellStart != null && styles.cellTitleFocused]} numberOfLines={1}>{t('live.noProgramInfo')}</Text>
            </View>
            )
          : visible.map((p) => {
            const r = cellRect(p, windowStart, pxPerMin, stripW)
            if (r.w <= 0) return null // fully squeezed out at the row edge — nothing to draw
            const airing = p.start <= nowMs && nowMs < p.stop
            const past = p.stop <= nowMs
            const focused = focusStart === p.start
            return (
              <View key={`${p.start}-${p.stop}`} style={[styles.cell, { left: r.x, width: Math.max(0, r.w - CELL_GAP) }, airing && styles.cellNow, focused && styles.cellFocused]}>
                <Text style={[styles.cellTitle, past && styles.cellPast, focused && styles.cellTitleFocused]} numberOfLines={1}>{p.title}</Text>
                <Text style={[styles.cellTime, past && styles.cellPast, focused && styles.cellTimeFocused]} numberOfLines={1}>{hhmm(p.start)}–{hhmm(p.stop)}</Text>
                {/* Program progress on the airing cell only; the transparent track
                    keeps the cell's inner layout identical either way. */}
                <ProgressHairline program={airing ? p : null} style={styles.cellHairline} />
              </View>
            )
          })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingHorizontal: theme.safeX, paddingVertical: theme.safeY },
  header: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1) },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing(1.5) },
  chipsPane: { flex: 1 },

  // Grid body + the focus rig (TV).
  body: { flex: 1 },
  catcher: { position: 'absolute', top: STRIP, bottom: STRIP, left: STRIP, right: STRIP },
  stripUp: { position: 'absolute', top: 0, left: STRIP, right: STRIP, height: STRIP },
  stripDown: { position: 'absolute', bottom: 0, left: STRIP, right: STRIP, height: STRIP },
  stripLeft: { position: 'absolute', left: 0, top: 0, bottom: 0, width: STRIP },
  stripRight: { position: 'absolute', right: 0, top: 0, bottom: 0, width: STRIP },

  gridRow: {
    flexDirection: 'row', alignItems: 'center', height: GUIDE_ROW_INNER_H, marginBottom: GUIDE_ROW_MB,
    borderLeftWidth: 3, borderLeftColor: 'transparent'
  },
  rowPlaying: { borderLeftColor: theme.colors.accent },
  chCell: { width: CH_COL_W, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: theme.spacing(1) },
  chNumber: { color: theme.colors.textDim, fontSize: theme.type.label, fontVariant: ['tabular-nums'], width: 52 },
  chLogo: { width: LOGO_W, height: LOGO_H, borderRadius: 4, backgroundColor: theme.colors.surface },
  chLogoFallback: { alignItems: 'center', justifyContent: 'center' },
  chInitial: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800' },
  strip: { height: GUIDE_ROW_INNER_H, overflow: 'hidden' },
  cell: {
    position: 'absolute', top: 0, height: GUIDE_ROW_INNER_H, borderRadius: 6,
    backgroundColor: theme.colors.surface, paddingHorizontal: 10, paddingVertical: 6,
    borderWidth: 2, borderColor: 'transparent', overflow: 'hidden', justifyContent: 'center'
  },
  cellAtStart: { left: 0 },
  cellNow: { borderColor: theme.colors.accent },
  cellFocused: { backgroundColor: theme.colors.focusFill },
  cellTitle: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '700' },
  cellTime: { color: theme.colors.textDim, fontSize: theme.type.caption - 1, fontVariant: ['tabular-nums'], marginTop: 1 },
  cellTitleFocused: { color: theme.colors.focusFillText },
  cellTimeFocused: { color: theme.colors.focusFillText, opacity: 0.7 },
  cellPast: { opacity: 0.5 },
  cellEmpty: { color: theme.colors.textDim, fontStyle: 'italic', fontWeight: '400' },
  cellHairline: { position: 'absolute', left: 8, right: 8, bottom: 4 }
})
