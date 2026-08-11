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
import React, { useRef, useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet, PanResponder } from 'react-native'
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
}

export function NowPlayingBar ({ stream, number, clock, favorite, onSearch, onInfo, onToggleFavorite, onReport, hasTracks, onTracks, vod, onTogglePause, onSeek, volume, muted, onVolume }: NowPlayingBarProps) {
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
