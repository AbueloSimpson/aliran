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
import React, { useCallback, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, PanResponder, ActivityIndicator, BackHandler } from 'react-native'
import Video, { type VideoRef } from 'react-native-video'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { formatDuration } from '../catalog'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'VodPlayer'>

export function VodPlayerScreen ({ route, navigation }: Props) {
  const { url, title, durationSec } = route.params
  const player = useRef<VideoRef | null>(null)
  const [paused, setPaused] = useState(false)
  const [position, setPosition] = useState(0)
  // Runtime: whatever the provider stated until the player reports the real one.
  const [duration, setDuration] = useState(durationSec ?? 0)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  // BACK leaves the title (default pop) — nothing to unwind, but the handler makes the
  // intent explicit and keeps a paused title from lingering behind the grid.
  React.useEffect(() => {
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
  }, [])

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
          progressUpdateInterval={1000}
          onLoad={(e: { duration?: number }) => {
            setLoading(false)
            if (e?.duration && e.duration > 0) setDuration(e.duration)
          }}
          onProgress={(e: { currentTime: number }) => setPosition(Math.floor(e.currentTime))}
          onEnd={() => setPaused(true)}
          onError={() => { setLoading(false); setFailed(true) }}
        />
      )}

      {loading && !failed && (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.accent} />
          <Text style={styles.hint}>Starting {title}…</Text>
        </View>
      )}

      {failed && (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>This title won't play</Text>
          <Text style={styles.hint}>The movie catalog couldn't deliver it right now. Try another title, or come back later.</Text>
        </View>
      )}

      {!failed && (
        <View style={styles.bar} pointerEvents="box-none">
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <View style={styles.transport} pointerEvents={theme.isTV ? 'none' : 'auto'}>
            {!theme.isTV && (
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [styles.playBtn, pressed && styles.playBtnActive]}
                onPress={() => {
                  // ▶ on a finished title replays from the top (unpausing at the end is
                  // a no-op in the player — it is already "ended").
                  if (paused && duration > 0 && position >= Math.floor(duration) - 1) seek(0)
                  setPaused((p) => !p)
                }}
              >
                <Text style={styles.playGlyph}>{paused ? '▶' : '❚❚'}</Text>
              </Pressable>
            )}
            <SeekBar position={position} duration={duration} onSeek={seek} />
          </View>
        </View>
      )}
    </View>
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
  playBtn: { paddingHorizontal: theme.spacing(1.25), paddingVertical: 6, borderRadius: 10, backgroundColor: theme.colors.overlay },
  playBtnActive: { backgroundColor: theme.colors.surface },
  playGlyph: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700', width: 22, textAlign: 'center' },
  time: { color: theme.colors.text, fontSize: theme.type.caption, fontVariant: ['tabular-nums'], minWidth: 44, textAlign: 'center' },
  trackTouch: { flex: 1, height: 28, justifyContent: 'center' },
  trackLine: { height: 4, borderRadius: 2, backgroundColor: theme.colors.surface, overflow: 'hidden' },
  trackFill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.accent },
  thumb: { position: 'absolute', top: 8, width: 12, height: 12, borderRadius: 6, marginLeft: -6, backgroundColor: theme.colors.accent }
})
