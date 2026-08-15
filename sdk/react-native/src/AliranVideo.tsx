// <AliranVideo> — drop-in P2P (and hybrid CDN<->P2P) live video on react-native-video.
//
// Plays whatever the engine says is the ACTIVE source: the localhost P2P server, or
// the CDN after a 'fallback', switching back on 'source-changed'. Right after play()
// the P2P playlist can 404 for a few seconds while the live edge replicates from
// peers, so source errors retry with a remount instead of failing (the proven
// behavior from the app's player screen; bounded — see ERROR_GIVE_UP). The component
// is chrome-free: overlays (badges, peer counts, spinners) belong to the host app via
// the state callbacks.
//
// TUNE LIFECYCLE (onTune): ONE localhost URL serves every P2P channel, so raw player
// events are useless as a "channel switch finished" signal — after a zap the OLD
// channel keeps playing (and emitting onProgress/onBuffer) under the same URL until
// the engine flips the served feed, and self-heal remounts re-create the <Video>
// mid-switch (S22 2026-07-16: a pill stuck at "Tuning 90%" over visibly playing
// video, and the opposite — the next zap's pill dismissed instantly by the previous
// channel's events). The component therefore tracks each switch as a TUNE:
//   'start'      a new channel (streamId change / mount) or a stall resync began;
//   'retune'/'reconnect'  the engine's self-heal cycle is running (fresh feed open /
//                wedged-transport teardown) — show "reconnecting", not a frozen bar;
//   'playing'    FIRST real playback of THIS tune: the engine confirmed the URL
//                serves this stream (the 'port' reply, remounting if the channel
//                changed) AND the current mount produced a frame or progress.
// Completion is mount-scoped (see remount()/mountEpoch): events still held by an
// outgoing mount can neither finish a tune nor feed the stall watchdog, and a
// remount mid-tune simply re-arms the same tune on the fresh mount.

import React, { useEffect, useImperativeHandle, useRef, useState } from 'react'
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import Video, {
  SelectedTrackType,
  type VideoRef,
  type BufferConfig,
  type SelectedTrack,
  type AudioTrack,
  type TextTrack,
  type OnAudioTracksData,
  type OnTextTracksData
} from 'react-native-video'
import { AliranBackend, type BackendMessage } from './backend'

// Track selection (and the nested bufferConfig shape) re-exported here so the host
// app imports these from @aliran/react-native (the single binding surface) instead of
// reaching into react-native-video directly. SelectedTrackType is a runtime enum
// (value), the rest are types. index.ts re-exports them again for the package entry point.
export { SelectedTrackType }
export type { SelectedTrack, AudioTrack, TextTrack, BufferConfig }

const RETRY_MS = 2500
// …and the BOUND on those retries — the stall ladder's defect class (STALL_GIVE_UP
// below) on a faster clock. Each consecutive hard error doubles the next wait, and the
// fourth gives up with a friendly error instead of remounting again:
//
//   error 1 -> wait 2.5 s -> retry 1     error 3 -> wait 10 s -> retry 3
//   error 2 -> wait 5 s   -> retry 2     error 4 -> GIVE UP, onError
//
// (2.5+5+10 = 17.5 s of waits; ExoPlayer's own ~3 s of internal load retries precede
// each onError, so the give-up lands ~27 s after the first hard error.) Three remounts
// are attempted against a persistent failure, not one every ~5.5 s forever. Unlike the
// stall ladder there is no fourth wait: a stall rung can only learn it failed by
// letting the next window expire, but an error IS the failure signal — once the third
// retry mount reports one, waiting longer to say so would just hold a spinner over a
// player that is never going to be remounted again.
//
// Unbounded, this loop was the SIGABRT recipe measured on the stall path (TCL Android
// 14, 2026-08-14: ~150 serial ExoPlayer/MediaCodec teardown/rebuild cycles until ART
// aborted the process — see STALL_GIVE_UP), cycling ~2x faster, and with even less in
// its way: against a persistent failure (loopback server dead, feed gone, a 404 that
// never heals) no engine error ever arrives, because a redirect channel has no feed
// for the engine's watchdog to fail on, and a dead loopback server cannot report
// anything at all.
//
// THE FIRST RETRY STAYS AT 2.5 s ON PURPOSE — transients are real: right after play()
// the playlist can 404 while the live edge replicates (serve.js's availability wait
// absorbs the routine miss in-band as a ~100 ms response, but e.g. one segment lost to
// a replica rotation edge can still reach the player as an error), so only CONSECUTIVE
// failures back off. RECOVERED means real playback: the ladder resets in onProgress's
// motion branch — the same signal the stall ladder's `p.played` reads — and never on a
// merely successful mount, because a mount that errors again 5 s later is the loop,
// not recovery. And as with the stall ladder, a remount must not buy back attempts
// once the ladder is spent, or a host that keeps the player mounted would loop at the
// give-up boundary; the error text's retry is a host-side re-select, which mounts a
// fresh component whose ladder starts clean.
//
// VOD: deliberately DIVERGES from the stall ladder, which disarms on vod because its
// trigger — a still playhead — is exactly what a paused, seeking, or finished vod
// title looks like by design. A hard error is a real failure on any record class, and
// the error retry (restart-at-0:00 cost and all) has always applied to vod; the bound
// only stops the retry from repeating forever, so it applies to vod too.
const ERROR_GIVE_UP = 4
// Start-buffer tuning (zap latency): ExoPlayer's DefaultLoadControl waits for
// ~2.5 s of media before starting playback — on a 2 s-segment live feed that is
// most of the perceived zap time once bytes flow. 1 s is enough to start (every
// segment begins on a keyframe), and the slightly higher rebuffer risk is covered
// by the self-heal ladder below (stall resync → transport teardown). After a
// rebuffer, ask for a bit more headroom before resuming.
// `live` pins the ExoPlayer live offset (churn headroom): sit ~10 s behind the
// edge so playback rides out a P2P source dying and being replaced — measured
// re-source is seconds-scale, and the engine replicates the whole live window
// on-device, so everything between playhead and edge survives an upstream loss.
// Starts thin (1 s in hand at the target offset) and fills toward the edge, so
// zaps stay fast; minOffsetMs lets ExoPlayer trade a little headroom before it
// stalls. Needs a live window comfortably wider than the offset (fine at the
// 16 s default window; the reference deploy guidance is 24 s). Hosts override
// via the bufferConfig prop (merged over these defaults).
const BUFFER_CONFIG = {
  bufferForPlaybackMs: 1000,
  bufferForPlaybackAfterRebufferMs: 1500,
  live: { targetOffsetMs: 10000, minOffsetMs: 4000 }
}
// Live-edge freeze self-heal: a live HLS window can be tiny (16-24 s on the
// reference deploy), so a network blip longer than the window slides it past the playhead —
// react-native-video fires NO error, the picture just freezes while everything else
// stays healthy (S22 2026-07-16). Once a mount has actually played, a playhead that
// stops advancing for this long (while not paused) forces a remount: a fresh playlist
// load rejoins at the live edge — exactly what a manual zap-away/zap-back did.
// ESCALATION: if the remount itself brings no playback within another window, the
// engine's swarm connection is likely wedged — transport-alive but replication-dead
// (a network flap can leave it that way; the same S22 day, 15+ min stuck with
// "1 peer" showing) — so the ladder calls backend.reconnect() to tear it down and
// dial fresh before each further remount. GIVING UP is part of the ladder too: the
// windows double and the fourth resync surfaces a friendly error instead of remounting
// again (STALL_GIVE_UP), because nothing else on this path ever will — see its note.
// VOD (S8a): the whole ladder is live-edge machinery, so it DISARMS when the engine
// reports the served record is a vod title (the 'port' reply's recordType) — a
// paused, seeking, or finished vod playhead sits still by design, and a resync
// remount would yank playback back to 0:00.
const STALL_MS = 12000
// …and the BOUND on that ladder. Each consecutive resync that fails to restore playback
// waits twice as long as the last, and the fourth gives up with a friendly error:
//
//   wait 12 s -> resync 1     wait 48 s -> resync 3
//   wait 24 s -> resync 2     wait 96 s -> GIVE UP, onError    (12+24+48+96 = ~3 min)
//
// so three remounts are attempted, not the ~150 the unbounded version reached. Both proven
// rungs survive untouched: resync 1 is still a plain remount at 12 s, resync 2 still adds
// the transport teardown.
//
// UNBOUNDED WAS ACTIVELY HARMFUL, not merely wasteful (TCL Android 14, 2026-08-14). A wedged
// ExoPlayer remounted every 12 s for at least 3 minutes — 15 full ExoPlayer/MediaCodec
// teardown/rebuild cycles in the captured window, ~150 by the time ART aborted the process on
// the MediaCodec_loop thread — while the FEED stayed healthy throughout: 1 peer, store growing
// at full live bitrate. Two things make that cadence worse than useless. It re-dials the swarm
// every 12 s, which is shorter than a fresh dial needs to replicate. And each redial re-arms
// the engine's tune watchdog (player.js _startTuneWatchdog), which then stands down within a
// second or two on the healthy feed and clears its timer — so the engine's own friendly-error
// rung, ≤3× timeoutMs, RESTARTS FROM ZERO every cycle and can never fire. The engine measures
// the engine; the component that is actually stuck is the player, and nothing else bounds it.
//
// RE-ARMING IS PLAYBACK-ONLY, BY DESIGN. Once spent, the ladder stays quiet until real motion
// resets it (the `p.played` branch) — a remount alone must not buy back attempts, or a host
// that keeps the player mounted would loop at the give-up boundary forever. The retry the
// error text offers is a host-side re-select, which unmounts the player and mounts a fresh one
// whose refs start clean; see the give-up lane in AliranVideoTune.test.tsx.
const STALL_GIVE_UP = 4
// Offline bounds for the classes NEITHER ladder above can see (the ~80% pill forever,
// 2026-08-15). A redirect channel has no engine watchdog — _resolveStream answers with
// the operator's URL and never arms _startTuneWatchdog ("the host player owns its own
// errors") — and the error ladder only runs if ExoPlayer actually SURFACES an error. A
// dead host that hangs the TCP connect, or answers 200 with something the loader chews
// on forever, produces no error event at all; and a worklet that never answers play()
// leaves url null with no <Video> mounted, so no player event of any kind can ever end
// the tune. Two wall-clock bounds are the only termination for those classes:
//   NO_ANSWER — play() was sent and the engine has not confirmed THIS stream (no
//   'port' reply for it) after 15 s. Resolve is a local catalog read bounded at 5 s
//   and a healthy reply lands in under a second, so 15 s means the worklet is gone,
//   not slow.
//   CDN_TUNE — the engine confirmed a cdn source and 30 s of mounted player produced
//   no first frame. Sits just past the error ladder's ~27 s give-up so whichever
//   signal arrives first ends the tune; a LIVE stream that cannot produce one frame
//   in 30 s is dead for zap purposes. Never armed for p2p (the engine's tune watchdog
//   owns that class — see the STALL_MS note on why measuring the engine is wrong for
//   the player, and vice versa) and never for vod.
// The clock restarts whenever the tune advances a phase (new tune, port confirm,
// fallback, source/feed change, self-heal re-arm, stall resync) so no phase inherits
// time another phase already spent.
const NO_ANSWER_TIMEOUT_MS = 15000
const CDN_TUNE_TIMEOUT_MS = 30000

// Cheap stable signature of a playback-header set (sorted k=v, '' for none). Two uses,
// and they must agree: spotting a HEADERS-ONLY change in the 'port' handler, and keying
// the mount so the fresh headers cannot be missed.
function headersSig (h: Record<string, string> | null | undefined) {
  return h ? Object.keys(h).sort().map((k) => k + '=' + h[k]).join('&') : ''
}

// What container is at `url`? react-native-video passes `source.type` to ExoPlayer as
// overrideExtension; with no type ExoPlayer infers from the url's LAST PATH SEGMENT
// (Util.inferContentType) and an EXTENSION-LESS one falls through to CONTENT_TYPE_OTHER
// -> ProgressiveMediaSource, which feeds an HLS text playlist to the mp4/mkv extractors
// and dies with UnrecognizedInputFormatException.
//
// The localhost server always serves index.m3u8, so this only ever bites REDIRECT
// channels — operator urls under no obligation to describe themselves. Every Samsung
// TV Plus KR channel arrives as https://jmp2.uk/stvp-<id> with no extension at all, and
// all 177 of them failed this way (2026-08-13); the wire was fine the whole time
// (Content-Type: application/x-mpegURL), the container was just decided before the
// request. Pluto's shortlinks carry .m3u8, which is why only Korea broke.
//
// A url that DOES name its container is left alone (undefined = infer), so a .mpd
// redirect still opens DASH instead of being forced to HLS.
export function sourceType (url: string) {
  const path = url.split(/[?#]/)[0]
  const segment = path.slice(path.lastIndexOf('/') + 1)
  return /\.[a-z0-9]{1,5}$/i.test(segment) ? undefined : 'm3u8'
}

export type TunePhase = 'start' | 'retune' | 'reconnect' | 'playing'

// Imperative surface (React ref): seek, for vod transport UI. The handle survives the
// component's internal remounts (source switches, error retries) — it always talks to
// the CURRENT <Video> mount.
export interface AliranVideoHandle {
  /** Seek to an absolute position in seconds. Meant for vod titles (the localhost
   *  server does full Range, so the whole timeline is seekable); no-op before the
   *  player mounts. */
  seek: (seconds: number) => void
}

export interface TuneEvent {
  /** Monotonic per-component tune counter — a new id on every 'start' (channel change,
   *  mount, stall resync), so hosts can key their indicator and drop stale events. */
  id: number
  streamId: string
  phase: TunePhase
}

export interface AliranVideoProps {
  backend: AliranBackend
  streamId: string
  /** Send play() on mount (default true). Disable if the host already called it. */
  autoPlay?: boolean
  style?: StyleProp<ViewStyle>
  controls?: boolean
  paused?: boolean
  resizeMode?: 'contain' | 'cover' | 'stretch' | 'none'
  onSource?: (url: string, source: 'p2p' | 'cdn') => void
  onFallback?: (e: { url: string; reason: string }) => void
  onSourceChanged?: (e: { url: string; source: 'p2p' | 'cdn' }) => void
  /** The active stream's feed rotated (broadcaster source change / restart); the player
   *  was remounted onto the same URL to flush the stale playlist. */
  onFeedChanged?: (e: { feedKey: string; url: string }) => void
  onPeers?: (peers: number) => void
  onBuffering?: (buffering: boolean) => void
  /** A friendly, viewer-showable failure — the tune ENDS here and your error UI owns the
   *  screen. Four sources: the engine (tune timeout, corrupt store, not entitled), the
   *  stall ladder giving up after STALL_GIVE_UP failed resyncs, the error retry ladder
   *  giving up after ERROR_GIVE_UP consecutive load failures, and the offline watchdog
   *  (NO_ANSWER / CDN_TUNE). Every text ends in "switch to it again to retry", so the
   *  retry has to be a RE-SELECT that unmounts this component and mounts a fresh one —
   *  a spent ladder is only re-armed by real playback, never by a remount, so leaving
   *  the player mounted leaves it spent.
   *  `info.code === 'offline'` marks the failures that mean THE CHANNEL ITSELF is not
   *  answering (dead redirect url, permanent HTTP refusal, silent worklet) — the host
   *  can show a "channel offline" screen instead of generic error prose. The message
   *  string stays English either way (SDK prose is not localized by design). */
  onError?: (message: string, info?: { code?: 'offline' }) => void
  /** A frozen live edge was detected and the player is resyncing (remount onto a fresh
   *  playlist load at the live edge; consecutive failed resyncs additionally tear down
   *  the engine's wedged peer connection via backend.reconnect()). The same moment also
   *  fires onTune {phase:'start'} — drive tuning UI off onTune, use this for logging.
   *  Fires once per resync, so it stops after the ladder gives up (onError fires instead). */
  onStall?: () => void
  /** Tune lifecycle for the host's tuning indicator: 'start' arms it (reset — never
   *  inherit the previous tune's progress), 'retune'/'reconnect' are the engine's
   *  self-heal cycle (say "reconnecting", don't freeze), 'playing' dismisses it — the
   *  first REAL playback of this tune, raw player events can't be trusted for that
   *  (see the tune-lifecycle note above). */
  onTune?: (e: TuneEvent) => void
  /** Currently selected audio track — { type: SelectedTrackType.INDEX, value } to pick one.
   *  Streams here are single-audio, but multi-audio streams can still be switched. */
  selectedAudioTrack?: SelectedTrack
  /** Currently selected subtitle/CC track — { type: SelectedTrackType.DISABLED } for off,
   *  { type: SelectedTrackType.INDEX, value } to show a WebVTT / CEA-608 track. */
  selectedTextTrack?: SelectedTrack
  /** The available audio tracks the player found (on load / track change). */
  onAudioTracks?: (tracks: AudioTrack[]) => void
  /** The available subtitle/CC text tracks the player found. */
  onTextTracks?: (tracks: TextTrack[]) => void
  /** How long the playhead may sit still (while playing) before a resync; 0 disables.
   *  Default 12000 — the ladder fires once the ~10 s of local headroom the live
   *  offset keeps in hand is exhausted (at the recommended 12-segment window the
   *  total time-to-heal is ~22 s — intended). Auto-disabled while the engine
   *  reports the served record is a vod title (recordType 'vod').
   *  This is the FIRST rung only: each failed resync doubles the wait, and the whole
   *  ladder ends in onError after 15x this value (12+24+48+96 s at the default). */
  stallTimeoutMs?: number
  /** ExoPlayer load-control overrides, merged over the zap-tuned defaults
   *  (bufferForPlaybackMs 1000 / bufferForPlaybackAfterRebufferMs 1500). */
  bufferConfig?: BufferConfig
  /** Extra props spread onto the underlying <Video>. */
  videoProps?: Record<string, unknown>
}

export const AliranVideo = React.forwardRef<AliranVideoHandle, AliranVideoProps>(function AliranVideo ({
  backend, streamId, autoPlay = true, style, controls = true, paused,
  resizeMode = 'contain', onSource, onFallback, onSourceChanged, onFeedChanged, onPeers,
  onBuffering, onError, onStall, onTune, selectedAudioTrack, selectedTextTrack,
  onAudioTracks, onTextTracks, stallTimeoutMs = STALL_MS, bufferConfig, videoProps
}: AliranVideoProps, ref) {
  const [url, setUrl] = useState<string | null>(backend.url)
  // Request headers that belong to THIS url (a redirect channel behind a provider's
  // Referer/Origin/User-Agent hotlink check). Tracked in state beside url, seeded from
  // the backend for a re-entry onto an already-resolved channel, and handed to the
  // player inside the source prop — without them the provider answers 403.
  const [headers, setHeaders] = useState<Record<string, string> | null>(backend.headers ?? null)
  // Signature of the headers the CURRENT mount was opened with. A provider that rotates
  // only its User-Agent leaves the url alone, so this is the only way the 'port' handler
  // can see that the player has to be torn down — and it has to go through remount(), not
  // the key alone: the key would swap the mount WITHOUT bumping the epoch (late events
  // from the dead mount would then pass the staleness guard) and without re-running the
  // [url, attempt] effect that disarms the stall ladder for a fresh mount.
  const headersRef = useRef(headersSig(backend.headers ?? null))
  const [attempt, setAttempt] = useState(0) // remounts <Video>; trails epoch (see remount)
  // Synchronous shadow of `attempt`: bumped BEFORE the remounting setState, so event
  // callbacks still held by the outgoing mount (they captured `attempt` at its render)
  // identify themselves as stale in the gap before React commits the new mount.
  const epoch = useRef(0)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cb = useRef({ onSource, onFallback, onSourceChanged, onFeedChanged, onPeers, onBuffering, onError, onStall, onTune, onAudioTracks, onTextTracks })
  cb.current = { onSource, onFallback, onSourceChanged, onFeedChanged, onPeers, onBuffering, onError, onStall, onTune, onAudioTracks, onTextTracks }
  // The in-flight tune (see the tune-lifecycle note in the header). `live` = the engine
  // confirmed the shared localhost URL serves THIS tune's stream; only then can the
  // current mount's playback complete the tune.
  const tune = useRef({ id: 0, streamId, tuning: false, live: false })
  // Which channel the engine last confirmed serving — the backend remembers it across
  // screen unmounts, so re-entering on the resumed channel doesn't force a remount.
  const served = useRef<string | null>(backend.activeStreamId)
  // Live-edge stall detection: last playhead position + when it advanced. `played`
  // arms the watchdog only after THIS mount has produced motion — the tune phase owns
  // its own recovery (error-retry remounts + the engine's tune watchdog), and a dead
  // feed must not hot-loop remounts.
  const progress = useRef({ time: -1, at: Date.now(), played: false })
  // Consecutive stall resyncs with no playback in between: 1 = plain remount, ≥2 =
  // the remount didn't restore playback, escalate to a transport teardown.
  const resyncs = useRef(0)
  // Consecutive error-retry remounts with no real playback in between — `resyncs`'s
  // mirror for hard player errors (see ERROR_GIVE_UP). At ERROR_GIVE_UP the ladder is
  // SPENT: the friendly error is up, and only real playback (or a zap) re-arms it.
  const failures = useRef(0)
  // When the current tune PHASE began — the offline watchdog's clock (NO_ANSWER /
  // CDN_TUNE). Restarted at every phase advance so no phase inherits spent time.
  const tuneStart = useRef(Date.now())
  // The served record is a vod title (engine's 'port' recordType) — the stall ladder
  // disarms (see the STALL_MS note). Seeded from the backend for re-entry on a title
  // the engine already serves; every port reply for OUR stream refreshes it.
  const vod = useRef(backend.activeStreamId === streamId && backend.recordType === 'vod')
  // The current <Video> mount, for the imperative seek() handle (vod transport UI).
  const videoRef = useRef<VideoRef | null>(null)

  useImperativeHandle(ref, () => ({
    seek: (seconds: number) => { videoRef.current?.seek(seconds) }
  }), [])

  function remount () {
    // Any remount supersedes a pending error retry: that timer belongs to a mount that
    // is going away, and letting it fire would remount the fresh player a second time
    // (and bill the error ladder an attempt no error of its own earned). If the source
    // is still broken the fresh mount errors on its own and restarts the cycle cleanly.
    if (retry.current) { clearTimeout(retry.current); retry.current = null }
    epoch.current++
    setAttempt(epoch.current)
  }

  // First real playback of the CURRENT tune → 'playing'. Callers are mount-scoped
  // (epoch-checked), so only the live mount can get here.
  function completeTune () {
    const t = tune.current
    if (!t.tuning || !t.live) return
    t.tuning = false
    cb.current.onTune?.({ id: t.id, streamId: t.streamId, phase: 'playing' })
  }

  useEffect(() => {
    // A new channel (or the first mount) starts a new TUNE. If the engine's last
    // confirmed serve already IS this stream (re-entering the screen on the resumed
    // channel), the mount is live from the start — first playback completes the tune
    // without waiting for the play() reply.
    tune.current = { id: tune.current.id + 1, streamId, tuning: true, live: served.current === streamId }
    tuneStart.current = Date.now()
    // Re-derive the record class for the (possibly new) channel: known when the engine
    // already serves it, else assumed live until this channel's port reply says vod —
    // so a vod→live zap re-arms the stall ladder immediately.
    vod.current = backend.activeStreamId === streamId && backend.recordType === 'vod'
    cb.current.onTune?.({ id: tune.current.id, streamId, phase: 'start' })
    const off = backend.onMessage((m: BackendMessage) => {
      if (m.type === 'port' && backend.url) {
        setUrl(backend.url)
        setHeaders(backend.headers ?? null) // null for everything but a hotlink-checked redirect url
        if (backend.source) cb.current.onSource?.(backend.url, backend.source)
        const sid = m.streamId ?? streamId // pre-streamId worklet bundles: assume ours
        const changed = sid !== served.current
        served.current = sid
        if (sid === streamId) {
          // The engine confirmed OUR stream is what the shared URL serves now. If that
          // is a switch, remount to flush the previous channel's playlist/buffer —
          // otherwise the old channel plays on until ExoPlayer stumbles into the swap.
          // A HEADERS-ONLY change (a provider rotating its User-Agent behind a stable
          // url) is the same kind of event: the open player is still sending the old
          // set, so it has to go too — and through remount(), which is what bumps the
          // epoch and re-arms the per-mount stall state.
          const sig = headersSig(backend.headers ?? null)
          const headersChanged = sig !== headersRef.current
          headersRef.current = sig
          if (changed || headersChanged) remount()
          tune.current.live = true
          tuneStart.current = Date.now() // confirmed serve: the CDN_TUNE clock starts here
          // Record class of the confirmed serve (absent on pre-S8a worklet bundles →
          // keep the live assumption).
          if (m.recordType) vod.current = m.recordType === 'vod'
        }
        // else: a stale reply from an outrun zap — recorded; ours is still on the way.
      }
      if (m.type === 'fallback' && m.streamId === streamId) {
        // A different url (the operator's CDN template) — the previous provider's
        // headers do not belong to it. P2P-only event, so this only ever clears null.
        setUrl(m.url); setHeaders(null); headersRef.current = ''; remount()
        served.current = streamId
        tune.current.live = true
        tuneStart.current = Date.now() // fresh source, fresh offline clock
        cb.current.onFallback?.({ url: m.url, reason: m.reason })
      }
      if (m.type === 'source-changed' && m.streamId === streamId) {
        setUrl(m.url); setHeaders(null); headersRef.current = ''; remount() // same reason as 'fallback' above
        served.current = streamId
        tune.current.live = true
        tuneStart.current = Date.now() // fresh source, fresh offline clock
        cb.current.onSourceChanged?.({ url: m.url, source: m.source })
      }
      if (m.type === 'feed-changed' && m.streamId === streamId) {
        // Same localhost URL, new feed behind it — remount to flush the old playlist/
        // segments the player has already buffered. Headers are left alone on purpose:
        // this event is P2P-only (a redirect channel opens no feed to rotate), so they
        // are already null — clearing would be noise, carrying them would be a bug.
        setUrl(m.url); remount()
        tune.current.live = true
        tuneStart.current = Date.now() // fresh feed, fresh offline clock
        cb.current.onFeedChanged?.({ feedKey: m.feedKey, url: m.url })
      }
      if (m.type === 'status' && typeof m.peers === 'number') cb.current.onPeers?.(m.peers)
      if (m.type === 'status' && (m.state === 'feed:retune' || m.state === 'feed:reconnect')) {
        // The engine's self-heal cycle on the active feed (tune watchdog / wedged-
        // transport teardown). Re-arm completion — the cycle ends in fresh playback or
        // a friendly error — and surface the phase so the host can say "reconnecting"
        // instead of freezing its indicator.
        tune.current.tuning = true
        tuneStart.current = Date.now() // self-heal re-arm: the offline clock must not bill it
        cb.current.onTune?.({ id: tune.current.id, streamId: tune.current.streamId, phase: m.state === 'feed:retune' ? 'retune' : 'reconnect' })
      }
      if (m.type === 'error') {
        tune.current.tuning = false // the friendly error ENDS the tune — the host's error UI takes over
        cb.current.onError?.(m.message) // e.g. tune timeout, corrupt store, not entitled
      }
    })
    if (autoPlay) backend.play(streamId)
    return () => {
      off()
      if (retry.current) clearTimeout(retry.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, streamId])

  // Every remount (source switch, error retry, feed rotation, stall resync) disarms the
  // stall watchdog until the fresh mount plays again.
  useEffect(() => {
    progress.current = { time: -1, at: Date.now(), played: false }
  }, [url, attempt])

  // A zap or source switch starts a fresh tune — both escalation ladders reset with it.
  // (A feed rotation or headers-only change does NOT pass here — same url — and must
  // not: those remounts neither spend attempts nor buy any back.)
  useEffect(() => { resyncs.current = 0; failures.current = 0 }, [streamId, url])

  // Stall watchdog: playing but the playhead has not moved for stallTimeoutMs → the
  // live window slid past the playhead (no error event exists for this) → remount.
  // If a resync mount then FAILS to play within another window, a remount alone can't
  // help — the engine's peer connection is wedged (transport-alive, replication-dead):
  // tear it down via backend.reconnect() so the swarm dials fresh.
  //
  // ⚠ THAT REDIAL DOES NOT HAND THE OUTCOME TO THE ENGINE, though it re-arms the engine's
  // tune watchdog and this comment used to say it did. That watchdog stands down as soon as
  // the playlist advances and is servable — which, when the feed is healthy and only the
  // PLAYER is stuck, is within a second or two, every time. So its ladder never reaches the
  // friendly error and this loop owned its own termination all along, whether or not it knew
  // it. STALL_GIVE_UP is that termination; see its note for the incident.
  useEffect(() => {
    if (!stallTimeoutMs) return
    const timer = setInterval(() => {
      const p = progress.current
      if (vod.current) { p.at = Date.now(); return } // vod: a still playhead (paused/seeking/finished) is by design — never resync
      if (paused) { p.at = Date.now(); return } // a paused playhead is not a stall
      if (p.played) resyncs.current = 0 // motion since the last resync — the ladder resets
      else if (resyncs.current === 0) return // never played: the tune phase owns recovery
      else if (resyncs.current >= STALL_GIVE_UP) return // spent: the error is up, only real playback re-arms
      // Back off: a resync that changed nothing earns the next attempt twice the window.
      if (Date.now() - p.at < stallTimeoutMs * 2 ** resyncs.current) return
      progress.current = { time: -1, at: Date.now(), played: false }
      resyncs.current++
      if (resyncs.current >= STALL_GIVE_UP) {
        // Remounting again cannot help, and the engine will never say so — its watchdog keeps
        // standing down on the healthy feed. End the tune and hand the viewer the same retry
        // the engine's friendly error offers; the host's error UI takes it from here.
        tune.current.tuning = false
        cb.current.onError?.(`playback stalled: no video from '${tune.current.streamId}' — the channel may be unreachable right now, switch to it again to retry`)
        return
      }
      // A resync re-arms the tune under a NEW id — the host's indicator restarts from
      // scratch, and the remount below must produce fresh playback before 'playing'.
      const t = tune.current
      tune.current = { id: t.id + 1, streamId: t.streamId, tuning: true, live: t.live }
      tuneStart.current = Date.now() // resync is a fresh tune — fresh offline clock too
      cb.current.onStall?.()
      cb.current.onTune?.({ id: tune.current.id, streamId: t.streamId, phase: 'start' })
      if (resyncs.current >= 2) backend.reconnect()
      remount() // fresh playlist load at the live edge
    }, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, paused, stallTimeoutMs])

  // Offline watchdog — the wall-clock bound for the classes no player event can end
  // (see NO_ANSWER/CDN_TUNE). Runs regardless of whether a <Video> is mounted: the
  // NO_ANSWER class is precisely the one where `url` never arrives and nothing below
  // this hook ever renders. Reads refs (and backend.source, a plain mirror property),
  // so the interval closure never goes stale.
  useEffect(() => {
    const timer = setInterval(() => {
      const t = tune.current
      if (!t.tuning || progress.current.played || vod.current) return
      const waited = Date.now() - tuneStart.current
      // NO_ANSWER: the engine never confirmed this stream. CDN_TUNE: confirmed cdn,
      // no first frame. p2p is deliberately out of scope — the engine's own tune
      // watchdog owns it, and it WILL answer (retune/reconnect/error), each of which
      // restarts this clock.
      const noAnswer = !t.live && waited >= NO_ANSWER_TIMEOUT_MS
      const cdnDead = t.live && backend.source === 'cdn' && waited >= CDN_TUNE_TIMEOUT_MS
      if (!noAnswer && !cdnDead) return
      // End the tune exactly the way a spent error ladder does: kill any pending
      // retry (no zombie remounts behind the error UI), mark the ladder spent, and
      // hand the host the re-select retry. 'offline' tells the host this is the
      // channel's fault, not the player's.
      if (retry.current) { clearTimeout(retry.current); retry.current = null }
      failures.current = ERROR_GIVE_UP
      t.tuning = false
      cb.current.onError?.("channel is not answering — it may be offline right now, switch to it again to retry", { code: 'offline' })
    }, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend])

  if (!url) return null

  const { onProgress: hostOnProgress, ...restVideoProps } = videoProps ?? {}
  const mountEpoch = attempt // the epoch this render's callbacks belong to (see remount)
  // Belt and braces on top of the 'port' handler's remount: the headers also key the
  // mount, so no path can leave the open player sending a stale set (ExoPlayer reads
  // source.headers once, when it opens the media). Both fire in the same commit, so this
  // is still a single unmount/mount.
  const sig = headersSig(headers)

  return (
    <Video
      key={url + ':' + sig + ':' + attempt}
      ref={videoRef}
      source={{ uri: url, type: sourceType(url), headers: headers ?? undefined, bufferConfig: { ...BUFFER_CONFIG, ...bufferConfig } }}
      style={style ?? StyleSheet.absoluteFill}
      controls={controls}
      paused={paused}
      resizeMode={resizeMode}
      selectedAudioTrack={selectedAudioTrack}
      selectedTextTrack={selectedTextTrack}
      onAudioTracks={(e: OnAudioTracksData) => cb.current.onAudioTracks?.(e.audioTracks ?? [])}
      onTextTracks={(e: OnTextTracksData) => cb.current.onTextTracks?.(e.textTracks ?? [])}
      onBuffer={({ isBuffering }: { isBuffering: boolean }) => {
        cb.current.onBuffering?.(isBuffering)
        if (!isBuffering && mountEpoch === epoch.current) completeTune()
      }}
      onReadyForDisplay={() => {
        cb.current.onBuffering?.(false)
        if (mountEpoch === epoch.current) completeTune()
      }}
      onProgress={(e: { currentTime: number }) => {
        if (mountEpoch === epoch.current) {
          const p = progress.current
          if (e.currentTime !== p.time) {
            progress.current = { time: e.currentTime, at: Date.now(), played: true }
            failures.current = 0 // real playback — the error retry ladder re-arms (a mount alone never does)
            completeTune() // an advancing playhead is playback, whatever else fired
          }
        }
        ;(hostOnProgress as ((e: { currentTime: number }) => void) | undefined)?.(e)
      }}
      onError={(e: { error?: unknown }) => {
        // Playlist/segments not replicated yet (or a live-edge hiccup) — retry, on the
        // bounded ladder (see ERROR_GIVE_UP). Consecutive means no real playback since:
        // only onProgress motion resets `failures`. Handoff remounts (port / fallback /
        // source-changed / feed-changed / stall resync) neither count as attempts nor
        // reset the count — they just cancel the pending retry (see remount()).
        if (failures.current >= ERROR_GIVE_UP) return // spent: the error is up, only real playback re-arms
        // A permanent HTTP refusal (a 4xx that will not heal) from a cdn/redirect
        // source earns ONE retry, not three: event playlists rotate tokens, so a
        // single 403 can be a rotation race — but the SECOND consecutive one is the
        // provider saying no, and ten more seconds of spinner will not change the
        // answer. The field names inside react-native-video's error payload vary by
        // platform and version, so match the stringified event rather than a path.
        const permanent = /response code:?\s*(401|403|404|410|451)/i.test(JSON.stringify(e?.error ?? {}))
        const cdn = backend.source === 'cdn'
        if (failures.current === ERROR_GIVE_UP - 1 || (cdn && permanent && failures.current >= 1)) {
          // The last rung gives up: consecutive retry mounts just took the same error,
          // and no engine report is coming (see the ERROR_GIVE_UP note). End the tune
          // and hand the viewer the same re-select retry the other give-ups offer; the
          // host's error UI takes it from here. On a cdn source this is the channel
          // refusing to play, not the player breaking — say 'offline'.
          if (retry.current) clearTimeout(retry.current) // a double-fired error must not leave a timer running behind the error UI
          failures.current = ERROR_GIVE_UP
          tune.current.tuning = false
          cb.current.onError?.(`playback failed: '${tune.current.streamId}' will not load — the channel may be broken right now, switch to it again to retry`, cdn ? { code: 'offline' } : undefined)
          return
        }
        cb.current.onBuffering?.(true)
        if (retry.current) clearTimeout(retry.current)
        // The delay belongs to the attempt this error asks for: 2.5 s for the first
        // (fast — the transient contract), doubled for each consecutive failure. The
        // attempt is counted when the remount actually happens, so N error events that
        // collapse into one scheduled retry spend one attempt, not N.
        retry.current = setTimeout(() => { failures.current++; remount() }, RETRY_MS * 2 ** failures.current)
      }}
      {...restVideoProps}
    />
  )
})
