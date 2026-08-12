// Persistent bottom menu shown while a channel is open and the left menu is gone
// (overlay 'none'). Replaces the old transient bottom OSD: instead of a channel-identity
// chip that peeked on a tap and faded, the bottom of fullscreen now carries a standing
// bar — derived number + logo + title/synopsis + wall clock on top, a row of touch
// controls (Search / Info / Favorite) beneath. Search (WS15) replaced the Channels
// button: it opens the in-player channel search overlay so the viewer never backs
// fully out — the channel list itself stays one tap away on the video (landscape).
//
// Touch model: the container is pointerEvents "box-none" and the identity row is "none",
// so only the three buttons capture touches — a tap anywhere else on the bar (or the
// video) falls through to the fullscreen catcher, which opens the left menu. The button
// row is PHONE-ONLY: on TV it would sit in the D-pad path and hijack the up/down zap
// focus engine (the S7 lesson), so TV keeps the identity-only bar and zaps as before.
//
// vod transport (S8a): when the playing record is a library title the bar grows a
// transport row — play/pause, elapsed / runtime, and a scrubbable seek bar (tap or
// drag; pure JS, no native slider dep). Phone-only interactivity for the same S7
// reason; TV renders the row display-only (position + runtime, no focusables).
//
// REMOTE LEGEND (TV only): a line of key caps under the identity row naming what the
// D-pad does here — ▲▼ changes channel, ◀/OK open the channel list, ▶ opens channel
// info, BACK leaves for the menu. It exists because none of that was DISCOVERABLE: the
// keys are answered by invisible focus strips (the S7 focus engine), so nothing on
// screen ever named them, and a viewer who pressed a key that did nothing had no way
// to find the ones that did. One measured on a TCL set pressed LEFT and RIGHT, got
// silence, and reported channel changing as broken when it had worked the whole time.
//
// The caps are display-only Text — never focusables, which is the S7 rule the whole
// screen is built around. The host fades them on a timer of their OWN, shorter than the
// bar's: the legend is for learning the keys and stops earning its space long before the
// channel identity does, so it clears first and the bar outlives it.
import React, { useRef, useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet, PanResponder, Animated } from 'react-native'
import type { Stream } from '../worklet'
import { useI18n } from '@aliran/i18n'
import { formatChannelNumber, formatDuration } from '../catalog'
import { useEpg } from '@aliran/react-native'
import { VolumeControl } from './VolumeControl'
import { ProgressHairline } from './ProgressHairline'
import { theme } from '../theme'

/** Transport state for a vod title (position/duration in seconds). */
export interface VodTransport {
  position: number
  duration: number
  paused: boolean
}

export interface NowPlayingBarProps {
  stream: Stream
  number?: number
  clock: string
  favorite: boolean
  onSearch: () => void
  onInfo: () => void
  onToggleFavorite: () => void
  onReport: () => void
  /** The current stream carries subtitle/CC or multiple audio tracks — show the CC button. */
  hasTracks?: boolean
  /** Open the subtitle/audio track selector. */
  onTracks?: () => void
  /** vod only (S8a): current transport state — renders the seek/pause row. */
  vod?: VodTransport | null
  /** vod: toggle play/pause. */
  onTogglePause?: () => void
  /** vod: seek to an absolute position (seconds) — tap or drag-release on the bar. */
  onSeek?: (seconds: number) => void
  /** In-app volume (QA round 3) — the control renders when the handler is given.
   *  Phone-only like the rest of the button row. */
  volume?: number
  muted?: boolean
  onVolume?: (volume: number, muted: boolean) => void
  /**
   * Open the "Play on a TV" picker. Absent = no button, which is the answer on a device
   * that can neither cast (no Play Services — the Fire OS sticks and AOSP boxes in this
   * fleet) nor see a television of this account to hand the channel to.
   *
   * PHONE ONLY, and not by convention: this whole row is inside the `!theme.isTV` gate
   * because a focusable over the video hijacks the TV D-pad zap engine (the S7 lesson in
   * the file header). A cast button on a television is also meaningless — the set IS the
   * receiver.
   */
  onSendToTv?: () => void
  /** A send is running — light the button. Casting leaves the local picture playing, so
   *  this is the only sign on the screen that the phone is serving a television. */
  sendingToTv?: boolean
  /** TV only: render the remote legend (see the file header). Ignored on phone, which
   *  teaches itself — every action there is a labelled button on this same bar. */
  hint?: boolean
  /** The legend's own fade, owned by the host (LiveScreen) alongside the bar's. */
  hintOpacity?: Animated.Value
}

export function NowPlayingBar ({ stream, number, clock, favorite, onSearch, onInfo, onToggleFavorite, onReport, hasTracks, onTracks, vod, onTogglePause, onSeek, volume, muted, onVolume, onSendToTv, sendingToTv, hint, hintOpacity }: NowPlayingBarProps) {
  const { t } = useI18n()
  // What's on NOW from the program guide (S27) — the airing program is more useful on
  // the bar than the channel synopsis. Falls back to the description ("via demotv")
  // for channels without an EPG. The channel synopsis still lives in the Info panel.
  const { data } = useEpg(stream.epgUrl, stream.epgId, stream.guideBase)
  const subtitle = data?.now?.title || stream.description
  // No live thumb on the bar (WS11): the bar sits under/next to the ACTUAL live
  // video, so a rolling feed frame here only duplicated the picture (and cost an
  // off-layout probe per zap). The thumb's one surface is the guide preview pane.
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.bar} pointerEvents="box-none">
        <View style={styles.info} pointerEvents="none">
          {!!stream.logo && <Image source={{ uri: stream.logo }} style={styles.logo} resizeMode="contain" />}
          <Text style={styles.number}>{formatChannelNumber(number)}</Text>
          <View style={styles.main}>
            <View style={styles.titleLine}>
              <Text style={styles.title} numberOfLines={1}>{stream.title}</Text>
              {stream.isLive && <Text style={styles.live}>{t('common.liveBadge')}</Text>}
            </View>
            {!!subtitle && <Text style={styles.desc} numberOfLines={1}>{subtitle}</Text>}
            {/* Program progress under the title/now line — the zap-flash surface, so a
                zap instantly shows how far into the program the channel is. Guide-less
                channels render it transparent (same bar height either way). */}
            {!vod && <ProgressHairline program={data?.now} style={styles.hairline} />}
          </View>
          <View style={styles.divider} />
          <Text style={styles.clock}>{clock}</Text>
        </View>

        {/* vod transport (S8a) — interactive on phone; display-only on TV (no
            focusables in the D-pad zap path, the S7 lesson). */}
        {vod && (
          <View style={styles.transport} pointerEvents={theme.isTV ? 'none' : 'auto'}>
            {!theme.isTV && (
              <Pressable style={({ pressed }) => [styles.playBtn, pressed && styles.btnActive]} onPress={() => onTogglePause?.()}>
                <Text style={styles.playGlyph}>{vod.paused ? '▶' : '❚❚'}</Text>
              </Pressable>
            )}
            <SeekBar position={vod.position} duration={vod.duration} onSeek={onSeek} />
          </View>
        )}

        {/* The remote legend — TV only, display-only, on its own fade (file header). */}
        {theme.isTV && hint && (
          <Animated.View
            style={[styles.legend, hintOpacity ? { opacity: hintOpacity } : null]}
            pointerEvents="none"
          >
            <LegendKey caps="▲ ▼" label={t('live.hint.channel')} />
            {/* Two markings, one action: OK and LEFT both open the channel list. */}
            <LegendKey caps="◀ OK" label={t('live.bar.channels')} />
            <LegendKey caps="▶" label={t('live.bar.info')} />
            {/* The one cap that is TRANSLATED. Remotes print OK and the arrows the same
                way everywhere, so those are markings rather than prose; the back key is
                a WORD, and it is the word in the language the viewer set. */}
            <LegendKey caps={t('common.back')} label={t('live.hint.menu')} />
          </Animated.View>
        )}

        {/* Touch controls — phone only (see file header). */}
        {!theme.isTV && (
          <View style={styles.buttons}>
            {/* ⌕ (text presentation) — U+1F50D renders as a COLOR emoji on Android,
                which would break the monochrome glyph set (☰ ⓘ ★ ⚑). */}
            <BarButton glyph="⌕" label={t('menu.search')} onPress={onSearch} />
            <BarButton glyph="ⓘ" label={t('live.bar.info')} onPress={onInfo} />
            <BarButton glyph={favorite ? '★' : '☆'} label={t('live.bar.favorite')} active={favorite} onPress={onToggleFavorite} />
            <BarButton glyph="⚑" label={t('live.bar.report')} onPress={onReport} />
            {hasTracks && <BarButton glyph="CC" label={t('live.bar.subtitles')} onPress={() => onTracks?.()} />}
            {/* A two-letter glyph like CC above, and for the same reason: the pictorial
                alternatives (📺, the Cast chevron) are COLOR emoji on Android and would
                break the monochrome set. */}
            {onSendToTv && <BarButton glyph="TV" label={t('tvplay.bar')} active={sendingToTv} onPress={onSendToTv} />}
            {onVolume && <VolumeControl volume={volume ?? 1} muted={!!muted} onChange={onVolume} />}
          </View>
        )}
      </View>
    </View>
  )
}

// Scrubbable progress bar: elapsed | track | runtime. Pure JS (no native slider dep):
// the touch strip is a PanResponder — press/drag previews the target position on the
// fill and the elapsed label, release seeks. While not scrubbing it renders the live
// playhead. Times format via formatDuration (h:mm:ss / m:ss).
function SeekBar ({ position, duration, onSeek }: { position: number; duration: number; onSeek?: (seconds: number) => void }) {
  const [scrub, setScrub] = useState<number | null>(null) // 0..1 preview while touching
  const width = useRef(0)
  // Latest values for the once-created responder handlers (they close over refs only).
  const latest = useRef({ duration, onSeek }); latest.current = { duration, onSeek }
  const frac = (x: number) => (width.current > 0 ? Math.max(0, Math.min(1, x / width.current)) : 0)
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => setScrub(frac(e.nativeEvent.locationX)),
    onPanResponderMove: (e) => setScrub(frac(e.nativeEvent.locationX)),
    onPanResponderRelease: (e) => {
      const f = frac(e.nativeEvent.locationX)
      setScrub(null)
      const { duration: d, onSeek: seek } = latest.current
      if (d > 0) seek?.(f * d)
    },
    onPanResponderTerminate: () => setScrub(null)
  })).current
  const shownFrac = scrub ?? (duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0)
  const shownPos = scrub != null && duration > 0 ? scrub * duration : position
  return (
    <>
      <Text style={styles.time}>{formatDuration(shownPos) || '0:00'}</Text>
      <View style={styles.trackTouch} {...pan.panHandlers} onLayout={(e) => { width.current = e.nativeEvent.layout.width }}>
        <View style={styles.trackLine}>
          <View style={[styles.trackFill, { width: `${shownFrac * 100}%` }]} />
        </View>
        <View style={[styles.thumb, { left: `${shownFrac * 100}%` }]} />
      </View>
      <Text style={styles.time}>{formatDuration(duration) || '--:--'}</Text>
    </>
  )
}

// One legend entry: the cap printed on the remote, beside what that key does here.
// Plain Text on both counts — a Pressable would put the legend in the D-pad path and
// break the very zap engine it is there to explain (the S7 lesson).
function LegendKey ({ caps, label }: { caps: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <Text style={styles.legendCap}>{caps}</Text>
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  )
}

function BarButton ({ glyph, label, active, onPress }: { glyph: string; label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.btn, (pressed || active) && styles.btnActive]} onPress={onPress}>
      <Text style={[styles.btnGlyph, active && styles.btnTextActive]}>{glyph}</Text>
      <Text style={[styles.btnLabel, active && styles.btnTextActive]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: theme.safeX, right: theme.safeX, bottom: theme.safeY + theme.spacing(1) },
  bar: {
    backgroundColor: theme.colors.overlayStrong, borderRadius: 14,
    paddingHorizontal: theme.spacing(1.5), paddingVertical: theme.spacing(1)
  },
  info: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.25) },
  logo: { width: theme.isTV ? 60 : 44, height: theme.isTV ? 34 : 24, borderRadius: 4 },
  hairline: { marginTop: 4 },
  number: { color: theme.colors.accent, fontSize: theme.type.title, fontWeight: '800', fontVariant: ['tabular-nums'] },
  main: { flexShrink: 1, flexGrow: 1 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800', flexShrink: 1 },
  live: { color: theme.colors.live, fontSize: theme.type.caption - 2, fontWeight: '800' },
  desc: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 2 },
  divider: { width: 1, height: 24, backgroundColor: theme.colors.textDim, opacity: 0.3 },
  clock: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700', fontVariant: ['tabular-nums'] },
  // wrap: the row holds 4-6 controls — portrait phones are too narrow for one line.
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing(1), marginTop: theme.spacing(1) },
  // The remote legend (TV). Wraps like the button row above it, for the locales whose
  // words are long enough to run past one line at 10-foot type.
  legend: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing(1.25), marginTop: theme.spacing(0.75) },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // A key CAP: outlined rather than filled, so the legend never competes with a real
  // focus highlight. overflow:hidden is what actually clips the radius on Android.
  legendCap: {
    color: theme.colors.text, fontSize: theme.type.caption, fontWeight: '800',
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 6, overflow: 'hidden',
    borderWidth: 1, borderColor: theme.colors.textDim
  },
  legendLabel: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '700' },
  transport: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1), marginTop: theme.spacing(1) },
  playBtn: { paddingHorizontal: theme.spacing(1.25), paddingVertical: 6, borderRadius: 10, backgroundColor: theme.colors.overlay },
  playGlyph: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700', width: 22, textAlign: 'center' },
  time: { color: theme.colors.text, fontSize: theme.type.caption, fontVariant: ['tabular-nums'], minWidth: 44, textAlign: 'center' },
  // The touch strip is much taller than the 4px line (finger-sized hitbox); the line
  // and thumb center inside it.
  trackTouch: { flex: 1, height: 28, justifyContent: 'center' },
  trackLine: { height: 4, borderRadius: 2, backgroundColor: theme.colors.surface, overflow: 'hidden' },
  trackFill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.accent },
  thumb: { position: 'absolute', top: 8, width: 12, height: 12, borderRadius: 6, marginLeft: -6, backgroundColor: theme.colors.accent },
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: theme.spacing(1.5), paddingVertical: theme.spacing(1),
    borderRadius: 10, backgroundColor: theme.colors.overlay
  },
  btnActive: { backgroundColor: theme.colors.surface },
  btnGlyph: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700' },
  btnLabel: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '700' },
  btnTextActive: { color: theme.colors.accent }
})
