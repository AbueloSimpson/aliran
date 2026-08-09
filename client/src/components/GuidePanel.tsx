// Phone guide panel (WS7): the TV timeline grid rebuilt for touch — the SAME
// zoomed-out time-grid method (a 2 h window of absolutely-positioned program cells
// from src/guide.ts's cellRect/visiblePrograms, paged in discrete 30-min slots), at
// phone density: a compact 72px channel column (number + station logo) beside ~52px
// rows so 8-12 channels sit on screen at once. Self-contained (streams, category
// chips, the slow clock, the windowStart pager) so BOTH hosts stay thin:
//
//   GuideScreen (phone)   the standalone Guide screen — tuning navigates to Live.
//   LiveScreen 'guide'    overlay mode around the ONE playing video surface:
//                         portrait = a 16:9 strip of the playing stream on top with
//                         this grid below (the YouTube-TV/Pluto phone pattern);
//                         landscape = the grid over the fullscreen video like the
//                         channel-list panel. Playback never stops either way.
//
// Preview pane (WS11 — the live thumbnail's ONE surface, the TiviMate pattern): in
// landscape overlay mode (preview='overlay', LiveScreen passes it) the first tap on
// a row SELECTS it — highlight + a display-only preview card in the upper right
// (that channel's rolling live thumb, logo fallback, + its airing program) — and a
// second tap on the SAME row tunes. Tapping another row moves the selection; paging
// the window or switching category clears it. PORTRAIT (and the standalone screen)
// keeps tap = tune immediately and shows NO preview pane: the 16:9 strip above the
// grid already shows the playing channel, and a second picture would fight it.
//
// Paging is DISCRETE (the TV grid's windowStart model — never a free horizontal
// scroll): a clearly-sideways fling on the grid area moves the window one slot,
// clamped to the SDK's data horizons (windowFloor/windowCeil). Vertical scrolling is
// the channel FlatList, under the same mounted-window discipline as the TV grid —
// every mounted row runs an EPG fetch (the thumb probe left the rows with WS11 —
// only the single preview card probes). Tapping a row tunes its channel (or selects,
// see above); guide-less rows show the honest "No program information" cell (D2).
//
// This file also owns the guide chrome BOTH presentations share (the TV grid header
// imports it from here): category chips, the NOW pill, the time bar — and the
// GuidePreviewCard the TV grid mounts in its header.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Image, Pressable, FlatList, ScrollView, StyleSheet, PanResponder } from 'react-native'
import { getLocale, useI18n } from '@aliran/i18n'
import { backend, type Stream } from '../worklet'
import { visibleStreams } from '../parental'
import { channelNumbers, categoryModel, splitCategory, subLabel, formatChannelNumber, isVod, SUBCAT_SEP, type CategoryModel } from '../catalog'
import { useEpg, useEpgPrograms, useChannelThumb, type EpgProgram } from '@aliran/react-native'
import { ProgressHairline } from './ProgressHairline'
import { SectionLoading } from './SectionLoading'
import {
  GUIDE_WINDOW_MS, GUIDE_WINDOW_MIN, GUIDE_SLOTS, SLOT_MIN, SLOT_MS, MIN_CELL_W,
  cellRect, visiblePrograms, snapToNow, windowFloor, windowCeil
} from '../guide'
import { theme } from '../theme'

// Adjacent program cells keep a hairline gap so the timeline reads as cells, not a
// bar (the TV grid's value — GuideScreen imports it from here).
export const CELL_GAP = 2

// Compact phone channel column: number over a small 16:9 station-logo box.
const PH_COL_W = 72
const PH_LOGO_W = 56
const PH_LOGO_H = 32
// Dense "zoomed-out" rows (the getItemLayout exact-height discipline): ~52px puts
// 8-12 channels on a phone screen beside the 2 h window.
const PH_ROW_INNER_H = 50
const PH_ROW_MB = 2
export const PH_ROW_H = PH_ROW_INNER_H + PH_ROW_MB

// A sideways move must clearly dominate before the pager claims the touch — smaller
// and it would steal vertical FlatList scrolls and cell taps.
const SWIPE_CLAIM_PX = 24
const SWIPE_SLOPE = 1.6

// Local wall-clock HH:MM (no Intl under Hermes — the ChannelInfoPanel helper).
export function hhmm (ms: number): string {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// Time-bar date hint once paging crosses local midnight: nothing while the window
// starts today; TOMORROW / YESTERDAY on the neighbor days, a short date past those.
// The caller passes its useI18n t so the hint re-renders on a language switch.
function dayHint (windowStart: number, now: number, t: (key: string) => string): string | null {
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const w = new Date(windowStart)
  if (same(w, new Date(now))) return null
  if (same(w, new Date(now + 86400000))) return t('guide.tomorrow')
  if (same(w, new Date(now - 86400000))) return t('guide.yesterday')
  return `${w.getDate()}/${w.getMonth() + 1}`
}

export interface GuidePanelProps {
  /** The channel currently playing (row accent + the NOW pill's jump target). */
  playingId: string | null
  /** Tap-to-tune — the host decides how (navigate to Live, or switch in place). */
  onTune: (s: Stream) => void
  /** 'overlay' (LiveScreen landscape guide mode): tap selects + shows the preview
   *  card, a second tap on the same row tunes. Default 'none': tap tunes at once. */
  preview?: 'overlay' | 'none'
  /** Optional search affordance in the header (LiveScreen guide mode passes it):
   *  portrait's resting state is the guide, so without this chip a portrait viewer
   *  has no route to the in-player search (the bar only shows in fullscreen). */
  onSearch?: () => void
}

export function GuidePanel ({ playingId, onTune, preview = 'none', onSearch }: GuidePanelProps) {
  const { t } = useI18n()
  const [streams, setStreams] = useState<Stream[]>(() => visibleStreams(backend.streams))
  // Category scope — the same chips grammar as the TV grid header.
  const [selected, setSelected] = useState('All')
  // Slow clock: past-dimming, the airing accent and every hairline ride this tick.
  const [nowMs, setNowMs] = useState(() => Date.now())
  // The discrete paging window (the TV grid's windowStart model).
  const [windowStart, setWindowStart] = useState(() => snapToNow(Date.now()))
  // Overlay-preview selection (WS11): the row the first tap placed the viewer on —
  // its channel fills the preview card; a second tap on it tunes. null = nothing
  // selected (no card). Cleared on paging and category switches (the window the
  // selection was made in is gone).
  const [selectedId, setSelectedId] = useState<string | null>(null)

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
  // A CHANNEL surface: vod titles have no schedule and stay out of the rows.
  const list = useMemo(() => (model.groups[activeKey] ?? []).filter((s) => !isVod(s)), [model, activeKey])

  const pickCategory = useCallback((key: string) => {
    // Re-tapping the selected sub-category deselects it (back to the whole parent).
    setSelected((prev) => (prev === key && key.includes(SUBCAT_SEP) ? splitCategory(key)[0] : key))
    setSelectedId(null)
  }, [])

  const listRef = useRef<FlatList<Stream>>(null)
  const playingIndex = list.findIndex((s) => s.id === playingId)
  // The preview card's channel — only in overlay mode, and only while the selection
  // is still in the visible list (a category race drops it harmlessly).
  const selectedStream = preview === 'overlay' && selectedId ? list.find((s) => s.id === selectedId) ?? null : null

  // Two-tier tap (overlay mode): first tap places the selection, the second tap on
  // the SAME row commits the tune. Everywhere else a tap tunes immediately.
  const rowPress = useCallback((s: Stream) => {
    if (preview !== 'overlay') { onTune(s); return }
    // Tune OUTSIDE the state updater (an updater may run twice under StrictMode —
    // a double-tune would double-zap).
    if (selectedId === s.id) { setSelectedId(null); onTune(s) } else setSelectedId(s.id)
  }, [preview, onTune, selectedId])

  // Strip geometry from the MEASURED panel width (the host decides how wide this
  // panel is — full screen, or the Live overlay's pane), floored so a tiny first
  // layout still spreads the slots readably.
  const [panelW, setPanelW] = useState(0)
  const stripW = Math.max(GUIDE_SLOTS * MIN_CELL_W, panelW - PH_COL_W)
  const pxPerMin = stripW / GUIDE_WINDOW_MIN

  // One slot per fling — the discrete pager, clamped to the data horizons.
  const page = useCallback((dir: 1 | -1) => {
    const now = Date.now()
    setWindowStart((ws) => Math.min(Math.max(ws + dir * SLOT_MS, windowFloor(now)), windowCeil(now)))
    setSelectedId(null)
  }, [])
  const pan = useMemo(() => PanResponder.create({
    // Capture only a clearly-sideways drag; taps and vertical scrolls pass through.
    onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > SWIPE_CLAIM_PX && Math.abs(g.dx) > Math.abs(g.dy) * SWIPE_SLOPE,
    // Once claimed, keep the gesture — a competing native scroll stealing it
    // mid-fling would swallow the release and the page would never fire.
    onPanResponderTerminationRequest: () => false,
    // Swiping left pulls LATER programs into view (the carousel direction).
    onPanResponderRelease: (_e, g) => { if (g.dx < 0) page(1); else if (g.dx > 0) page(-1) }
  }), [page])

  // The NOW pill: window back to the current half-hour + jump to the playing row.
  function jumpToNow () {
    setWindowStart(snapToNow(Date.now()))
    if (playingIndex >= 0) {
      try { listRef.current?.scrollToIndex({ index: playingIndex, animated: true, viewPosition: 0.35 }) } catch {}
    }
  }

  if (!streams.length) return <SectionLoading section={t('menu.guide')} hint={t('live.waitingForChannels')} />

  return (
    <View style={styles.panel} onLayout={(e) => setPanelW(e.nativeEvent.layout.width)}>
      <View style={styles.headerRow}>
        <View style={styles.headerChips}>
          <CategoryChips model={model} activeKey={activeKey} onSelect={pickCategory} />
        </View>
        {onSearch && (
          <Pressable
            style={({ pressed }) => [styles.searchChip, pressed && styles.chipFocused]}
            onPress={onSearch}
            accessibilityRole="button"
            accessibilityLabel={t('menu.search')}
          >
            <Text style={styles.searchChipText}>⌕ {t('menu.search').toLocaleUpperCase(getLocale())}</Text>
          </Pressable>
        )}
      </View>
      <View style={styles.gridArea} {...pan.panHandlers}>
        <TimeBar windowStart={windowStart} nowMs={nowMs} pxPerMin={pxPerMin} leadW={PH_COL_W} />
        <View style={styles.listArea}>
          <FlatList
            ref={listRef}
            data={list}
            keyExtractor={(s) => s.id}
            getItemLayout={(_, index) => ({ length: PH_ROW_H, offset: PH_ROW_H * index, index })}
            initialScrollIndex={playingIndex > 0 ? playingIndex : undefined}
            onScrollToIndexFailed={(info) => {
              listRef.current?.scrollToOffset({ offset: PH_ROW_H * info.index, animated: false })
              setTimeout(() => { try { listRef.current?.scrollToIndex({ index: info.index, animated: false, viewPosition: 0.35 }) } catch {} }, 60)
            }}
            // The TV grid's mounted-window discipline: every mounted row runs an
            // EPG interval — a 150-channel category must not keep 150 alive.
            windowSize={5}
            initialNumToRender={12}
            removeClippedSubviews
            extraData={[nowMs, windowStart, stripW, selectedId]}
            renderItem={({ item }) => (
              <GuideRowPhone
                stream={item}
                number={numbers.get(item.id)}
                playing={item.id === playingId}
                selected={item.id === selectedStream?.id}
                windowStart={windowStart}
                stripW={stripW}
                pxPerMin={pxPerMin}
                nowMs={nowMs}
                onPress={() => rowPress(item)}
              />
            )}
          />
          {/* The preview pane (WS11) — the live thumbnail's one surface. Upper
              right, floating OVER the grid's corner (the TiviMate placement);
              display-only and pointer-transparent, so the rows beneath keep
              their taps. */}
          {selectedStream && (
            <View style={styles.previewOverlay} pointerEvents="none">
              <OverlayPreview
                stream={selectedStream}
                number={numbers.get(selectedStream.id)}
                playing={selectedStream.id === playingId}
              />
            </View>
          )}
        </View>
      </View>
      <Pressable style={styles.nowFloat} accessibilityRole="button" onPress={jumpToNow}>
        <Text style={styles.nowPillText}>{t('guide.now')}</Text>
      </Pressable>
    </View>
  )
}

// One phone grid row — the whole row is the tap surface (tune, or select in overlay
// mode; schedules are for reading, per the reference guides). Only MOUNTED rows
// fetch (useEpgPrograms lives here). The channel column is IDENTITY: number +
// station logo — the live thumb belongs to the preview card alone (WS11).
function GuideRowPhone ({ stream, number, playing, selected, windowStart, stripW, pxPerMin, nowMs, onPress }: {
  stream: Stream
  number?: number
  playing: boolean
  selected: boolean
  windowStart: number
  stripW: number
  pxPerMin: number
  nowMs: number
  onPress: () => void
}) {
  const { t } = useI18n()
  const programs = useEpgPrograms(stream.epgUrl, stream.epgId, stream.guideBase)
  const visible = visiblePrograms(programs, windowStart, windowStart + GUIDE_WINDOW_MS)

  return (
    <Pressable
      style={[styles.row, playing && styles.rowPlaying, selected && styles.rowSelected]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${formatChannelNumber(number)} ${stream.title}`}
      onPress={onPress}
    >
      <View style={styles.chCol}>
        <Text style={[styles.chNumber, selected && styles.chTextSelected]}>{formatChannelNumber(number)}</Text>
        {stream.logo
          ? <Image source={{ uri: stream.logo }} style={styles.chLogo} resizeMode="contain" accessibilityLabel={stream.title} />
          : <View style={[styles.chLogo, styles.chLogoFallback]}><Text style={[styles.chInitial, selected && styles.chTextSelected]}>{(stream.title || '?').slice(0, 1).toUpperCase()}</Text></View>}
      </View>
      <View style={[styles.strip, { width: stripW }]}>
        {visible.length === 0
          ? (
            <View style={[styles.cell, styles.cellAtStart, { width: stripW }]}>
              <Text style={[styles.cellTitle, styles.cellEmpty]} numberOfLines={1}>{t('live.noProgramInfo')}</Text>
            </View>
            )
          : visible.map((p) => {
            const r = cellRect(p, windowStart, pxPerMin, stripW)
            if (r.w <= 0) return null // fully squeezed out at the row edge — nothing to draw
            const airing = p.start <= nowMs && nowMs < p.stop
            const past = p.stop <= nowMs
            return (
              <View key={`${p.start}-${p.stop}`} style={[styles.cell, { left: r.x, width: Math.max(0, r.w - CELL_GAP) }, airing && styles.cellNow]}>
                <Text style={[styles.cellTitle, past && styles.cellPast]} numberOfLines={1}>{p.title}</Text>
                <Text style={[styles.cellTime, past && styles.cellPast]} numberOfLines={1}>{hhmm(p.start)}–{hhmm(p.stop)}</Text>
                {/* Program progress on the airing cell only; the transparent track
                    keeps the cell's inner layout identical either way. */}
                <ProgressHairline program={airing ? p : null} style={styles.cellHairline} />
              </View>
            )
          })}
      </View>
    </Pressable>
  )
}

// Overlay-mode wrapper: the phone card shows the selected channel's AIRING program
// ("now info" — useEpg's now/next, one cached fetch), plus the second-tap hint.
function OverlayPreview ({ stream, number, playing }: { stream: Stream; number?: number; playing: boolean }) {
  const { t } = useI18n()
  const { data } = useEpg(stream.epgUrl, stream.epgId, stream.guideBase)
  return <GuidePreviewCard stream={stream} number={number} playing={playing} program={data?.now ?? null} hint={t('guide.tapAgainToWatch')} />
}

// ---------------------------------------------------------------------------
// Shared guide chrome (this phone grid + the TV grid header import these).
// ---------------------------------------------------------------------------

// The guide preview pane (WS11) — the live thumbnail's ONE surface in the app's
// lists/guides. Display-only (no focusables — it must never enter the TV focus
// rig or a touch path): the channel the viewer is placed on but has not tuned,
// as a rolling live frame (useChannelThumb, 30 s roll) over identity text.
// `playing` = the placed channel is the one already on air behind/next to this
// guide — the live picture would duplicate it, so the card shows the logo
// version instead; a thumb 404 (the ordinary "no thumbnail" answer) falls back
// the same way. TV mounts it in the grid header (upper right); the phone
// landscape overlay floats it over the grid corner (OverlayPreview above).
export function GuidePreviewCard ({ stream, number, playing, program, hint }: {
  stream: Stream
  number?: number
  playing: boolean
  /** The program to caption (TV: the focused cell; phone: the airing one). */
  program?: EpgProgram | null
  /** Phone overlay only: the second-tap teaching line. */
  hint?: string
}) {
  const { t } = useI18n()
  // No probe at all for the playing channel — undefined thumbBase disarms the hook.
  const [thumbUri, onThumbError] = useChannelThumb(playing ? undefined : stream.thumbBase)
  return (
    <View style={styles.previewCard} pointerEvents="none">
      {thumbUri
        ? <Image source={{ uri: thumbUri }} style={styles.previewArt} resizeMode="cover" onError={onThumbError} accessibilityLabel={t('live.livePreview', { title: stream.title })} />
        : stream.logo
          ? <Image source={{ uri: stream.logo }} style={styles.previewArt} resizeMode="contain" accessibilityLabel={stream.title} />
          : <View style={[styles.previewArt, styles.previewArtFallback]}><Text style={styles.previewInitial}>{(stream.title || '?').slice(0, 1).toUpperCase()}</Text></View>}
      <View style={styles.previewInfo}>
        <Text style={styles.previewName} numberOfLines={1}>{formatChannelNumber(number)}  {stream.title}</Text>
        {program
          ? (
            <>
              <Text style={styles.previewProgram} numberOfLines={1}>{program.title}</Text>
              <Text style={styles.previewTime} numberOfLines={1}>{hhmm(program.start)}–{hhmm(program.stop)}</Text>
            </>
            )
          : null}
        {hint ? <Text style={styles.previewHint} numberOfLines={1}>{hint}</Text> : null}
      </View>
    </View>
  )
}

export function TimeBar ({ windowStart, nowMs, pxPerMin, leadW }: { windowStart: number; nowMs: number; pxPerMin: number; leadW: number }) {
  const { t } = useI18n()
  const hint = dayHint(windowStart, nowMs, t)
  return (
    <View style={styles.timebar}>
      <View style={[styles.timebarLead, { width: leadW }]}>{hint ? <Text style={styles.dayHint} numberOfLines={1}>{hint}</Text> : null}</View>
      {Array.from({ length: GUIDE_SLOTS }, (_, i) => windowStart + i * SLOT_MS).map((t) => (
        <Text key={t} style={[styles.slotLabel, { width: pxPerMin * SLOT_MIN }]}>{hhmm(t)}</Text>
      ))}
    </View>
  )
}

export function CategoryChips ({ model, activeKey, onSelect, onNow, nowPillRef }: {
  model: CategoryModel
  activeKey: string
  onSelect: (key: string) => void
  /** TV only: the NOW pill (reset window + refocus the playing channel). The phone
   *  grid has its own floating pill instead. */
  onNow?: () => void
  nowPillRef?: React.RefObject<any>
}) {
  const parent = splitCategory(activeKey)[0]
  const subs = model.subs[parent] ?? []
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
        {onNow && <NowPill onPress={onNow} innerRef={nowPillRef} />}
        {model.top.map((key) => (
          <GuideChip key={key} label={key} active={key === parent} onPress={() => onSelect(key)} />
        ))}
      </ScrollView>
      {subs.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
          {subs.map((key) => (
            <GuideChip key={key} label={subLabel(key)} active={key === activeKey} onPress={() => onSelect(key)} />
          ))}
        </ScrollView>
      )}
    </View>
  )
}

function GuideChip ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.chip, active && styles.chipActive, focused && styles.chipFocused]}
      accessibilityRole="button"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label.toLocaleUpperCase(getLocale())}</Text>
    </Pressable>
  )
}

// The red NOW pill — live color, border-box focus (the menu-icon grammar).
export function NowPill ({ onPress, innerRef }: { onPress: () => void; innerRef?: React.RefObject<any> }) {
  const { t } = useI18n()
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      ref={innerRef}
      style={[styles.nowPill, focused && styles.chipFocused]}
      accessibilityRole="button"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={styles.nowPillText}>{t('guide.now')}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  panel: { flex: 1 },
  gridArea: { flex: 1 },
  // Header: chips take the width, the optional search chip pins to the right end.
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  headerChips: { flex: 1 },
  searchChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: theme.colors.surface,
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent', marginLeft: theme.spacing(0.75)
  },
  searchChipText: { color: theme.colors.text, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1 },
  // Wraps the FlatList so the preview card can anchor to the grid's own corner
  // (below the time bar — the bar's slot labels stay readable).
  listArea: { flex: 1 },

  // Chips + NOW pill (shared with the TV grid header).
  chipsRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(0.75), paddingBottom: theme.spacing(0.5) },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  chipActive: { backgroundColor: theme.colors.surface },
  chipFocused: { borderColor: theme.colors.focus },
  chipText: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1 },
  chipTextActive: { color: theme.colors.text },
  nowPill: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, backgroundColor: theme.colors.live,
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  nowPillText: { color: theme.colors.onPrimary, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1 },

  // Time bar (shared — the lead column width comes from the host grid).
  timebar: { flexDirection: 'row', alignItems: 'baseline', marginTop: theme.spacing(0.5), marginBottom: theme.spacing(0.5) },
  timebarLead: { paddingLeft: theme.spacing(1) }, // the TV grid's original lead — keep TV pixel-stable
  dayHint: { color: theme.colors.accent, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1 },
  slotLabel: { color: theme.colors.textDim, fontSize: theme.type.caption, fontVariant: ['tabular-nums'] },

  // Phone grid rows — the TV grid's grammar (playing accent, past dim, airing
  // border, hairlines) at phone density.
  row: {
    flexDirection: 'row', alignItems: 'center', height: PH_ROW_INNER_H, marginBottom: PH_ROW_MB,
    borderLeftWidth: 3, borderLeftColor: 'transparent'
  },
  rowPlaying: { borderLeftColor: theme.colors.accent },
  // Overlay selection (WS11): the light fill is the app's "you are here" grammar
  // (ChannelRow's focus fill); the program cells keep their own surface on top, so
  // the fill reads on the channel column and the cell gaps.
  rowSelected: { backgroundColor: theme.colors.focusFill, borderRadius: 8 },
  chTextSelected: { color: theme.colors.focusFillText },
  chCol: { width: PH_COL_W, alignItems: 'center', justifyContent: 'center', paddingRight: 4 },
  chNumber: { color: theme.colors.textDim, fontSize: theme.type.caption - 1, fontVariant: ['tabular-nums'] },
  chLogo: { width: PH_LOGO_W, height: PH_LOGO_H, borderRadius: 4, backgroundColor: theme.colors.surface, marginTop: 1 },
  chLogoFallback: { alignItems: 'center', justifyContent: 'center' },
  chInitial: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800' },
  strip: { height: PH_ROW_INNER_H, overflow: 'hidden' },
  cell: {
    position: 'absolute', top: 0, height: PH_ROW_INNER_H, borderRadius: 6,
    backgroundColor: theme.colors.surface, paddingHorizontal: 8, paddingVertical: 4,
    borderWidth: 2, borderColor: 'transparent', overflow: 'hidden', justifyContent: 'center'
  },
  cellAtStart: { left: 0 },
  cellNow: { borderColor: theme.colors.accent },
  cellTitle: { color: theme.colors.text, fontSize: theme.type.caption, fontWeight: '700' },
  cellTime: { color: theme.colors.textDim, fontSize: theme.type.caption - 2, fontVariant: ['tabular-nums'], marginTop: 1 },
  cellPast: { opacity: 0.5 },
  cellEmpty: { color: theme.colors.textDim, fontStyle: 'italic', fontWeight: '400' },
  cellHairline: { position: 'absolute', left: 6, right: 6, bottom: 3 },

  nowFloat: {
    position: 'absolute', right: theme.spacing(1), bottom: theme.spacing(1),
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999, backgroundColor: theme.colors.live,
    elevation: 4
  },

  // Preview pane (WS11). Phone overlay: floats over the grid's upper-right corner
  // (below the time bar), pointer-transparent. TV: the SAME card mounts inline in
  // the grid header row (GuideScreen reserves the space — no overlap there).
  previewOverlay: { position: 'absolute', top: theme.spacing(0.5), right: theme.spacing(0.5), elevation: 4, zIndex: 4 },
  previewCard: {
    flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1),
    backgroundColor: theme.isTV ? theme.colors.surface : theme.colors.overlayStrong,
    borderRadius: 10, padding: theme.spacing(0.75),
    // A constant footprint (art + padding tall): the TV header must not breathe as
    // the focus walks rows, and the phone card must not resize between guided and
    // guide-less channels.
    width: theme.isTV ? 420 : 300, height: theme.isTV ? 108 : 80
  },
  // 16:9 — the frames the broadcaster rolls into the feed (logo letterboxes in the
  // same box, so thumb→logo fallback never moves the card's text).
  previewArt: { width: theme.isTV ? 160 : 96, height: theme.isTV ? 90 : 54, borderRadius: 6, backgroundColor: theme.colors.surface },
  previewArtFallback: { alignItems: 'center', justifyContent: 'center' },
  previewInitial: { color: theme.colors.textDim, fontSize: theme.type.title, fontWeight: '800' },
  previewInfo: { flex: 1 },
  previewName: { color: theme.colors.text, fontSize: theme.isTV ? theme.type.body : theme.type.label, fontWeight: '800' },
  previewProgram: { color: theme.colors.text, fontSize: theme.isTV ? theme.type.label : theme.type.caption, marginTop: 2 },
  previewTime: { color: theme.colors.textDim, fontSize: theme.type.caption, fontVariant: ['tabular-nums'], marginTop: 1 },
  previewHint: { color: theme.colors.textDim, fontSize: theme.type.caption - 1, fontStyle: 'italic', marginTop: 2 }
})
