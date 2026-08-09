// Provider VOD playback (S53, design D3) — a fullscreen react-native-video surface
// over a URL the provider handed us.
//
// This screen deliberately does NOT go through <AliranVideo> or the engine: there is
// no feed, no peers, no localhost server and no tune lifecycle here. It is an ordinary
// progressive/HLS URL played directly, exactly the way AliranVideo imports the player
// (`import Video from 'react-native-video'`). Live TV keeps the engine to itself.
//
// The transport mirrors the NowPlayingBar vod row — play/pause, elapsed / runtime and
// a scrubbable seek bar — but is fed by rn-video's own onLoad/onProgress instead of
// the engine's port reply. Phone drives it by touch; TV keeps it display-only for the
// same reason the live bar does (focusables in the D-pad path hijack it, the S7
// lesson) and uses OK/Back on the surface itself.
//
// A playback failure shows a plain sentence. The viewer never sees an ExoPlayer code.
//
// S54c adds two things that are NOT about the picture:
//   - DEVICE-LOCAL watch history (D9). When the caller names the title (id + kind, plus
//     seriesId for an episode) this screen remembers where the viewer got to — throttled
//     to one prefs message per HISTORY_STEP_SEC of progress, flushed when the screen goes
//     away, and NEVER on the playback path: a failed prefs write must not stop a film.
//     A title watched past WATCHED_FRACTION stores position 0 — "seen it, start again".
//   - Subtitle + audio track selection (D7), the same machinery the live player uses:
//     rn-video reports the tracks it found, the app renders its own TrackMenu (native
//     controls are off), and trackChoice() handles the ExoPlayer group-index trap. The CC
//     button is PHONE-ONLY — on TV a focusable over the video hijacks the D-pad (S7), so
//     the TV surface here stays exactly as focus-free as the live one.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, PanResponder, ActivityIndicator, Animated, BackHandler, Platform } from 'react-native'
import Video, { type VideoRef } from 'react-native-video'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { SelectedTrackType, type AudioTrack, type SelectedTrack, type TextTrack, type VodHistoryEntry } from '@aliran/react-native'
import type { RootStackParamList } from '../App'
import { useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { TrackMenu } from '../components/TrackMenu'
import { VolumeControl } from '../components/VolumeControl'
import { formatDuration } from '../catalog'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'VodPlayer'>

/** Seconds of playback between two history writes. The worklet rewrites the whole prefs
 *  file per message, so a per-second write would hammer the disk for a two-hour film. */
export const HISTORY_STEP_SEC = 10
/** Past this much of the runtime a title counts as watched — its stored position becomes
 *  0 so the next "Start" plays it from the top instead of the closing credits. */
export const WATCHED_FRACTION = 0.95
/** The transport fades away this long after it appears / the last interaction, for an
 *  unobstructed picture — the live bar's timing (QA round 2). Paused keeps it up; TV
 *  never hides it (the TV transport is display-only, S7). */
export const BAR_IDLE_MS = 5000
/** The two skip sizes, mirrored around play/pause: ⟲30 ⟲10 ▶ ⟳10 ⟳30. */
export const SKIP_STEPS = [10, 30] as const

export function VodPlayerScreen ({ route, navigation }: Props) {
  const { t } = useI18n()
  const { url, title, durationSec, id, kind, seriesId, resumeSec } = route.params
  const player = useRef<VideoRef | null>(null)
  const [paused, setPaused] = useState(false)
  const [position, setPosition] = useState(0)
  // Runtime: whatever the provider stated until the player reports the real one.
  const [duration, setDuration] = useState(durationSec ?? 0)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  // In-app volume (QA round 3): rn-video's volume/muted props, session-local — the
  // OS keeps hardware volume, this is the trim on top. Phone-only control (S7).
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)

  // Subtitle/CC + audio tracks the player found in THIS title, plus the current picks
  // (subtitles off, audio = the stream's default). Session-local: a track choice is not
  // a preference, it belongs to the title being watched (D7).
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([])
  const [textTracks, setTextTracks] = useState<TextTrack[]>([])
  const [selectedText, setSelectedText] = useState<SelectedTrack>({ type: SelectedTrackType.DISABLED })
  const [selectedAudio, setSelectedAudio] = useState<SelectedTrack | undefined>(undefined)
  const [showTracks, setShowTracks] = useState(false)

  // A different url is a different title: its tracks are not these tracks.
  useEffect(() => {
    setAudioTracks([]); setTextTracks([])
    setSelectedText({ type: SelectedTrackType.DISABLED }); setSelectedAudio(undefined)
    setShowTracks(false)
  }, [url])

  // --- device-local watch history (D9) ---------------------------------------------
  // Only a NAMED title is remembered; a caller that hands over just a url plays without
  // leaving a trace (which is also the escape hatch for anything that must not be).
  const tracked = useMemo(
    () => (id && (kind === 'movie' || kind === 'episode') ? { id, kind } : null),
    [id, kind]
  )
  // Playback state the throttle and the flush read WITHOUT re-rendering. `written` is the
  // playhead at the last write and starts at 0 — the top of the title — so a fresh start
  // costs no write for its first step, while a RESUMED one (which lands far from 0) is
  // recorded straight away.
  const progress = useRef({ position: 0, duration: durationSec ?? 0, written: 0 })

  const writeHistory = useCallback((atSec: number, runtime: number) => {
    if (!tracked) return
    progress.current.written = atSec
    const done = runtime > 0 && atSec >= runtime * WATCHED_FRACTION
    const entry: VodHistoryEntry = {
      kind: tracked.kind,
      id: tracked.id,
      ...(seriesId ? { seriesId } : {}),
      title,
      positionSec: done ? 0 : Math.max(0, Math.floor(atSec)),
      durationSec: Math.max(0, Math.floor(runtime)),
      at: Date.now()
    }
    // Whole-array replace, newest first, one entry per title (the worklet gates and caps
    // what it stores — the 'prefs' reply is the truth, and nothing here waits for it).
    const rest = (backend.vodHistory || []).filter((e) => !(e && e.kind === entry.kind && e.id === entry.id))
    try { backend.setVodHistory([entry, ...rest]) } catch { /* prefs must never break playback */ }
  }, [tracked, seriesId, title])

  // Flushing happens from an unmount cleanup, which must not re-run when a callback's
  // identity changes — so the cleanup reads the LATEST flush through a ref.
  const flush = useRef<() => void>(() => {})
  flush.current = () => {
    const p = progress.current
    if (!tracked || p.position <= 0) return
    if (Math.floor(p.position) === Math.floor(p.written)) return // already stored
    writeHistory(p.position, p.duration)
  }
  useEffect(() => () => { flush.current() }, [])

  // BACK leaves the title (default pop) — nothing to unwind, but the handler makes the
  // intent explicit and keeps a paused title from lingering behind the grid. The history
  // flush rides the unmount that follows.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      navigation.goBack()
      return true
    })
    return () => sub?.remove?.()
  }, [navigation])

  const seek = useCallback((seconds: number) => {
    player.current?.seek(seconds)
    // Optimistic playhead: while paused no progress event confirms the jump, and the
    // bar must not snap back under the finger.
    setPosition(Math.floor(seconds))
    progress.current.position = seconds
  }, [])

  // Relative skip (the ±10/±30 buttons) — the desktop player's nudge(), clamped to
  // the title. An unknown runtime only clamps the low end.
  const nudge = useCallback((delta: number) => {
    const at = progress.current.position + delta
    const d = progress.current.duration
    seek(Math.max(0, d > 0 ? Math.min(d, at) : at))
  }, [seek])

  // --- transport auto-hide (QA round 2) — the live bar's fade, ported -------------
  // `barShown` gates mounting; `barOpacity` fades it. TV never hides (display-only
  // transport, D-pad model); a paused title keeps the bar (and its play control) up.
  const [barShown, setBarShown] = useState(true)
  const barIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const barOpacity = useRef(new Animated.Value(1)).current
  const pausedRef = useRef(false); pausedRef.current = paused
  const tracksOpenRef = useRef(false); tracksOpenRef.current = showTracks

  const clearBarIdle = useCallback(() => { if (barIdle.current) { clearTimeout(barIdle.current); barIdle.current = null } }, [])
  const armBarHide = useCallback(() => {
    clearBarIdle()
    if (theme.isTV) return
    if (pausedRef.current || tracksOpenRef.current) return
    barIdle.current = setTimeout(() => {
      Animated.timing(barOpacity, { toValue: 0, duration: 350, useNativeDriver: true })
        .start(({ finished }) => { if (finished) setBarShown(false) })
    }, BAR_IDLE_MS)
  }, [clearBarIdle, barOpacity])
  const showBar = useCallback(() => {
    clearBarIdle()
    barOpacity.stopAnimation()
    setBarShown(true)
    Animated.timing(barOpacity, { toValue: 1, duration: 160, useNativeDriver: true }).start()
    armBarHide()
  }, [clearBarIdle, armBarHide, barOpacity])
  const hideBar = useCallback(() => {
    clearBarIdle()
    Animated.timing(barOpacity, { toValue: 0, duration: 350, useNativeDriver: true })
      .start(({ finished }) => { if (finished) setBarShown(false) })
  }, [clearBarIdle, barOpacity])

  // Pausing pins the bar; resuming (or closing the track menu) re-arms the fade.
  useEffect(() => {
    if (paused || showTracks) clearBarIdle()
    else armBarHide()
  }, [paused, showTracks, clearBarIdle, armBarHide])
  useEffect(() => clearBarIdle, [clearBarIdle])

  // The tracks (⋮) button follows the live bar's rule: subtitles OR a real audio choice.
  const hasTracks = textTracks.length > 0 || audioTracks.length > 1

  return (
    <View style={styles.container}>
      {!failed && (
        <Video
          ref={player}
          source={{ uri: url }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          controls={false}
          paused={paused}
          volume={muted ? 0 : volume}
          muted={muted}
          progressUpdateInterval={1000}
          selectedAudioTrack={selectedAudio}
          selectedTextTrack={selectedText}
          onAudioTracks={(e: { audioTracks?: AudioTrack[] }) => setAudioTracks(e?.audioTracks ?? [])}
          onTextTracks={(e: { textTracks?: TextTrack[] }) => setTextTracks(e?.textTracks ?? [])}
          onLoad={(e: { duration?: number }) => {
            setLoading(false)
            if (e?.duration && e.duration > 0) { setDuration(e.duration); progress.current.duration = e.duration }
            // Resume, once: the caller said where this device left off (D9). A stored
            // position is always mid-title (a finished one is stored as 0), so there is
            // nothing to guard against here beyond seeking twice.
            if (resumeSec && resumeSec > 0 && progress.current.position <= 0) seek(resumeSec)
          }}
          onProgress={(e: { currentTime: number }) => {
            setPosition(Math.floor(e.currentTime))
            progress.current.position = e.currentTime
            if (Math.abs(e.currentTime - progress.current.written) >= HISTORY_STEP_SEC) {
              writeHistory(e.currentTime, progress.current.duration)
            }
          }}
          onEnd={() => {
            setPaused(true)
            // Ran to the end: stored as watched (position 0), not as "1 second left".
            writeHistory(progress.current.duration, progress.current.duration)
          }}
          onError={() => { setLoading(false); setFailed(true) }}
        />
      )}

      {loading && !failed && (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.accent} />
          <Text style={styles.hint}>{t('vod.player.starting', { title })}</Text>
        </View>
      )}

      {failed && (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>{t('vod.player.failedTitle')}</Text>
          <Text style={styles.hint}>{t('vod.player.failedHint')}</Text>
        </View>
      )}

      {/* Tap on clean video toggles the transport (phone only — a focusable catcher on
          TV would hijack the D-pad, S7). Sits UNDER the bar so bar taps never toggle. */}
      {!failed && !Platform.isTV && (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => { if (barShown) hideBar(); else showBar() }}
        />
      )}

      {!failed && barShown && (
        <Animated.View style={[styles.bar, { opacity: barOpacity }]} pointerEvents="box-none">
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <View style={styles.transport} pointerEvents={theme.isTV ? 'none' : 'auto'}>
            <SeekBar position={position} duration={duration} onSeek={(s) => { seek(s); showBar() }} />
            {!theme.isTV && (
              <VolumeControl volume={volume} muted={muted} onChange={(v, m) => { setVolume(v); setMuted(m); showBar() }} />
            )}
            {!theme.isTV && hasTracks && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('vod.player.tracks')}
                style={({ pressed }) => [styles.playBtn, pressed && styles.playBtnActive]}
                onPress={() => { setShowTracks(true); showBar() }}
              >
                {/* A more-options glyph, not "CC" — the menu offers audio AND subtitles. */}
                <Text style={styles.playGlyph}>⋮</Text>
              </Pressable>
            )}
          </View>
          {/* The skip cluster, centered under the progress bar (QA round 2):
              ⟲30 ⟲10 ▶ ⟳10 ⟳30. */}
          {!theme.isTV && (
            <View style={styles.skipRow} pointerEvents="auto">
              <SkipButton label={`↺${SKIP_STEPS[1]}`} a11y={t('vod.player.back', { n: SKIP_STEPS[1] })} onPress={() => { nudge(-SKIP_STEPS[1]); showBar() }} />
              <SkipButton label={`↺${SKIP_STEPS[0]}`} a11y={t('vod.player.back', { n: SKIP_STEPS[0] })} onPress={() => { nudge(-SKIP_STEPS[0]); showBar() }} />
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [styles.playBtn, pressed && styles.playBtnActive]}
                onPress={() => {
                  // ▶ on a finished title replays from the top (unpausing at the end is
                  // a no-op in the player — it is already "ended").
                  if (paused && duration > 0 && position >= Math.floor(duration) - 1) seek(0)
                  setPaused((p) => !p)
                  showBar()
                }}
              >
                <Text style={styles.playGlyph}>{paused ? '▶' : '❚❚'}</Text>
              </Pressable>
              <SkipButton label={`↻${SKIP_STEPS[0]}`} a11y={t('vod.player.forward', { n: SKIP_STEPS[0] })} onPress={() => { nudge(SKIP_STEPS[0]); showBar() }} />
              <SkipButton label={`↻${SKIP_STEPS[1]}`} a11y={t('vod.player.forward', { n: SKIP_STEPS[1] })} onPress={() => { nudge(SKIP_STEPS[1]); showBar() }} />
            </View>
          )}
        </Animated.View>
      )}

      {/* Bar hidden (phone): a touch in the bottom zone brings it back — the live
          player's reveal zone. */}
      {!failed && !barShown && !Platform.isTV && (
        <Pressable style={styles.barRevealZone} onPress={showBar} />
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
    </View>
  )
}

// One ±N-seconds transport button — the relative-skip glyph and its size in one label.
function SkipButton ({ label, a11y, onPress }: { label: string; a11y: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => [styles.playBtn, pressed && styles.playBtnActive]}
      onPress={onPress}
    >
      <Text style={styles.skipGlyph}>{label}</Text>
    </Pressable>
  )
}

// Scrubbable progress bar — the NowPlayingBar SeekBar, fed by rn-video. Pure JS (no
// native slider dep): press/drag previews the target on the fill and the elapsed
// label, release seeks.
function SeekBar ({ position, duration, onSeek }: { position: number; duration: number; onSeek: (seconds: number) => void }) {
  const [scrub, setScrub] = useState<number | null>(null)
  const width = useRef(0)
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
      const { duration: d, onSeek: doSeek } = latest.current
      if (d > 0) doSeek(f * d)
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.videoBackground },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: theme.spacing(3) },
  errorTitle: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700', textAlign: 'center' },
  hint: { color: theme.colors.textDim, fontSize: theme.type.body, textAlign: 'center' },
  bar: {
    position: 'absolute', left: theme.safeX, right: theme.safeX, bottom: theme.safeY + theme.spacing(1),
    backgroundColor: theme.colors.overlayStrong, borderRadius: 14,
    paddingHorizontal: theme.spacing(1.5), paddingVertical: theme.spacing(1)
  },
  title: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' },
  transport: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1), marginTop: theme.spacing(1) },
  // The skip cluster: centered under the progress bar, symmetric around play/pause.
  skipRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: theme.spacing(1.5), marginTop: theme.spacing(1) },
  skipGlyph: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700', textAlign: 'center' },
  barRevealZone: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 150 },
  playBtn: { paddingHorizontal: theme.spacing(1.25), paddingVertical: 6, borderRadius: 10, backgroundColor: theme.colors.overlay },
  playBtnActive: { backgroundColor: theme.colors.surface },
  playGlyph: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700', width: 22, textAlign: 'center' },
  time: { color: theme.colors.text, fontSize: theme.type.caption, fontVariant: ['tabular-nums'], minWidth: 44, textAlign: 'center' },
  trackTouch: { flex: 1, height: 28, justifyContent: 'center' },
  trackLine: { height: 4, borderRadius: 2, backgroundColor: theme.colors.surface, overflow: 'hidden' },
  trackFill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.accent },
  thumb: { position: 'absolute', top: 8, width: 12, height: 12, borderRadius: 6, marginLeft: -6, backgroundColor: theme.colors.accent }
})
