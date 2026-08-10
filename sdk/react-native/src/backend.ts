// AliranBackend — hosts the Aliran engine in a Bare worklet and speaks its IPC
// protocol (line-delimited JSON; see client/backend/backend.mjs). The host app
// supplies the worklet bundle (bare-pack output, base64 string or raw bytes) — the
// binding stays free of build-time coupling to any one backend build.
//
// The bare-kit binding is loaded lazily, on first start(): a legacy Android build
// (minSdk < 29 with react-native-bare-kit excluded from autolinking — see
// docs/sdk-guide.md "Older Android") ships this SDK without the native module. On
// such builds the backend stays SILENTLY inactive — start() and every other method
// are safe no-ops, no message ever fires — and AliranBackend.isSupported() reports
// false so the host can run its own legacy mode instead.

import { Platform, TurboModuleRegistry } from 'react-native'
import b4a from 'b4a'
import type { ReportCategory, ReportError } from './report'

declare const require: (id: string) => any // Metro/CJS both provide it; typed locally so hosts need no @types/node

type WorkletInstance = import('react-native-bare-kit').Worklet
type WorkletCtor = new () => WorkletInstance

// Cached availability verdict + (when the probe had to construct one) the Worklet it
// built, consumed by the first start() so no native handle is ever wasted.
let engineKnown: boolean | undefined
let probeWorklet: WorkletInstance | null = null

function engineAvailable (): boolean {
  if (engineKnown !== undefined) return engineKnown
  // Below Android 10 (API 29) the engine's native runtime cannot load AT ALL (its
  // ELF-TLS libc dependency) — regardless of what this build packaged. A single-APK
  // build (minSdk 24, bare-kit aboard behind a runtime dlopen) relies on this check
  // to never touch — or even construct — the native module on older devices.
  if (Platform.OS === 'android' && Number(Platform.Version) < 29) return (engineKnown = false)
  // The registered native module is the authoritative on-device signal. Checked via
  // react-native — NEVER by whether require('react-native-bare-kit') throws: release
  // bundles inline-require the package's native spec, deferring its "TurboModule
  // missing" throw from package require time into the Worklet constructor, so a bare
  // require() "succeeds" even in an engine-less build.
  try {
    if (TurboModuleRegistry.get('BareKit') != null) return (engineKnown = true)
  } catch { /* fall through to the constructor probe */ }
  // No registered module: an engine-less build/device — or a test env whose bare-kit
  // is a jest stub with no TurboModule behind it. Constructing a Worklet settles it:
  // on an engine-less device the deferred spec require throws right here, before
  // NativeBareKit.init, so the failed probe has no native side effects.
  try {
    const W = require('react-native-bare-kit').Worklet as WorkletCtor
    probeWorklet = new W()
    return (engineKnown = true)
  } catch {
    return (engineKnown = false)
  }
}

export interface Stream {
  id: string
  title: string
  description?: string
  category?: string[]
  isLive?: boolean
  viewerCount?: number
  poster?: string
  backdrop?: string
  logo?: string
  /** Panel curation hint: rail/list sort key (lower first; null/absent sorts last). */
  order?: number | null
  /** Panel curation hint: featured stream (hero / menu wallpaper pick). */
  featured?: boolean
  /** Access control: PIN-gate this channel (parental control); hide it while no PIN is set. */
  restricted?: boolean
  /** EPG feed URL (S27): a public https JSON of channels+schedules the app fetches
   *  on demand for this channel's program guide. Set on source-imported channels. */
  epgUrl?: string
  /** This channel's id INSIDE the epgUrl feed (matches feed `channels[].id`). */
  epgId?: string
  /** P2P guide base (loopback): `http://127.0.0.1:<port>/epg/v1/<id>` — per-day
   *  schedule files served from the panel's replicated guide drive. Tried BEFORE
   *  epgUrl; a 404 (no guide drive / channel not covered) falls back to https. */
  guideBase?: string
  /** Live thumbnail URL (loopback): `http://127.0.0.1:<port>/feedthumb/<id>` — the
   *  rolling frame the broadcaster refreshes into this channel's feed every ~30 s.
   *  Handed out unconditionally: a 404 IS the "no thumbnail right now" signal (channel
   *  off, thumbnails disabled, feed not warm, metered network), so a list shows this
   *  first and falls back to poster/logo art on error. Cache-bust per refresh. */
  thumbBase?: string
  /** Record class (S8a): 'vod' = an on-demand library title (seek/pause UI, no
   *  live-edge machinery — isLive does not apply); 'live' (or absent, old records). */
  type?: 'live' | 'vod'
  /** Title duration in seconds — vod records only. */
  durationSec?: number | null
  /** Catalog status ('live'/'idle'; vod: 'available'/'unavailable' — gray out the latter). */
  status?: string
}

// JSON-safe hybrid CDN<->P2P config, passed through to the engine (sdk/player.js).
// cdnUrl is a template STRING ('{streamId}' is substituted) — functions can't cross IPC.
export interface HybridConfig {
  mode?: 'p2p-only' | 'hybrid' | 'cdn-only'
  start?: 'preferP2P' | 'preferCDN'
  cdnUrl?: string
  readyTimeoutMs?: number
  rebufferMsToFallback?: number
  probeIntervalMs?: number
}

// Tune self-heal knobs (p2p-only mode; see sdk/player.js). timeoutMs bounds one tune
// attempt: the first expiry evicts the cached feed open and retries once, the second
// tears down wedged peer connections (transport-alive but replication-dead) and dials
// fresh, and only then a friendly {type:'error'} surfaces. relookup(Min|Max)Ms pace
// forced DHT re-lookups while a tune is incomplete. Defaults: 30 s / 5 s → error ≤ 90 s.
export interface TuneConfig {
  timeoutMs?: number
  relookupMinMs?: number
  relookupMaxMs?: number
}

// Adjacent-channel zap prefetch (see sdk/player.js normalizeZapPrefetch): while a
// stream plays, keep the newest segment of the next/previous channels in curated
// zap order replicated locally so a CH+/CH- zap starts from warm bytes. OFF by
// default — unlike prewarm this costs STANDING BANDWIDTH (≈ each warmed neighbor's
// bitrate while playing). Runtime-switchable via setZapPrefetch() (the "Smooth
// zapping" toggle) and ADAPTIVE: the engine suspends the warm loop on a metered
// network (setNetworkProfile), while the active stream stalls, or when the pipe
// shows no headroom — and reports it via {type:'zap-prefetch'} messages.
export interface ZapPrefetchConfig {
  neighbors?: number
  intervalMs?: number
  /** Warm only the side of the viewer's last zap once known (default true). */
  directional?: boolean
  /** Suspend when the ACTIVE playlist stops advancing this long (default 12000). */
  stallMs?: number
  /** Clean-advance run required before a stall/thin suspension lifts (default 60000). */
  resumeMs?: number
  /** Required download speed vs realtime for neighbor segments (default 3). */
  minHeadroom?: number
}

// Tuning for the engine's single Hyperswarm (see sdk/player.js normalizeSwarmOpts).
// maxPeers raises hyperswarm's total-connection budget (lib default 64) — for
// SDK-based seed nodes / repeater-style hosts that hold big fan-out. Ordinary
// viewers should omit it.
// rcvbufMb / sndbufMb request UDP socket buffer sizes in MiB (0 = leave the OS/udx
// default; mirrors the servers' SWARM_RCVBUF_MB/SWARM_SNDBUF_MB). Engine defaults:
// recv 2 MiB — a viewer's whole download funnels into the one UDP socket pair, and
// an overflowing receive buffer drops packets silently — and send untouched (reseed
// upload is opportunistic; a phone uplink saturates first). Best-effort on-device:
// the outcome arrives as {type:'status', state:'net:tuned', message}.
export interface SwarmConfig {
  maxPeers?: number
  rcvbufMb?: number
  sndbufMb?: number
}

export interface SavedCredentials { username: string; password: string }

/** Runtime-entered operator service (S36): persisted by a keyless public build's
 *  Connect screen. Builds with a baked descriptor never save one (baked wins). */
export interface SavedService { panelPubKey: string; name?: string }

/** Why a pairing code did not resolve. 'malformed' — not a 12-character code, nothing
 *  left the device; 'timeout' — no service answered it; 'unverified' — a peer answered
 *  with a panel key that does not own the code, so it was refused. */
export type PairingErrorCode = 'malformed' | 'timeout' | 'unverified'

/** What resolvePairing() hands back. On ok the panel key is verified: the engine
 *  re-derived the code from it and got what the viewer typed. */
export interface PairingResult {
  ok: boolean
  panelPubKey?: string
  name?: string
  code?: string
  error?: PairingErrorCode | string
  message?: string
}

/** Panel-delivered external VOD provider config (S53) — the operator's switch plus the
 *  coordinates the APP uses to call the provider DIRECTLY. The panel never proxies the
 *  provider's calls or media and stores no viewer credential for it: each viewer
 *  authenticates with their own account. Delivered ONLY while the operator has a
 *  provider enabled, so its ABSENCE is "no VOD section" — a client needs no version
 *  check and no separate absent-vs-disabled branch. Read at login, so an operator's
 *  change lands at the viewer's next login / app start. */
export interface VodConfig {
  enabled: true
  apiBase: string
  service: string
  /** Per-kind source values. Each kind is independent: no `series` value = the app
   *  shows movies only (S54a). */
  sources: { movies?: string; series?: string }
  /** Extra query params appended verbatim to every provider call. */
  params: Record<string, string>
}

/** One saved "My List" entry (S54a, design D9). DEVICE-LOCAL: the worklet persists it
 *  beside the store and nothing about it ever reaches the panel or the provider. */
export interface VodListEntry {
  kind: 'movie' | 'series'
  id: string
}

/** One watch-history entry (S54a, design D9) — device-local, newest first, one per
 *  title/episode. `positionSec` 0 means "watched, start from the top again" (the
 *  players store 0 rather than a near-end position). */
export interface VodHistoryEntry {
  kind: 'movie' | 'episode'
  id: string
  /** The parent series, for an episode — lets a series resume from its last episode. */
  seriesId?: string
  /** What to show when the id is no longer in the provider's catalog. */
  title: string
  positionSec: number
  durationSec: number
  /** Unix seconds this entry was last written (the "recently watched" order). */
  at: number
}

/** Platforms the panel's updates manifest distinguishes (OTA app updates). */
export type UpdatePlatform = 'android' | 'windows'

/** What checkUpdate() sends: the RUNNING build's identity. On Android the native
 *  module's getAppInfo() supplies it (packageName/versionCode) so branded builds
 *  automatically check their own manifest entry. */
export interface AppUpdateInfo {
  appId: string
  platform: UpdatePlatform
  versionCode: number
}

/** One /manifest.json entry on the panel's updates drive (keyed by app id). */
export interface UpdateEntry {
  platform: UpdatePlatform
  versionCode: number
  versionName: string
  /** Hex sha256 of the artifact — the engine verifies it before 'update-ready'. */
  sha256: string
  /** Artifact size in bytes (the progress total). */
  size: number
  /** Drive path of the artifact, e.g. '/pkg/<appId>-<versionCode>.apk'. */
  file: string
  /** Builds below this versionCode must update (the `mandatory` flag). */
  minVersionCode?: number
  notes?: string
  releasedAt?: string
}

/** 'unknown' = cannot say right now (no updates drive advertised, manifest out of
 *  reach) — try again later, never an error. 'none' = the manifest has no entry for
 *  this appId+platform (the operator never uploaded one). */
export type UpdateCheckStatus = 'available' | 'current' | 'none' | 'unknown'

/** Answer to checkUpdate() (the 'update-status' message, minus the envelope). */
export interface UpdateCheckResult {
  status: UpdateCheckStatus
  /** The manifest entry ('available' and 'current'). */
  entry?: UpdateEntry
  /** 'available' only: the running build is below entry.minVersionCode — surface a
   *  persistent (non-dismissable) update banner. */
  mandatory?: boolean
  error?: string
}

/** The update lifecycle messages onUpdate() subscribes to. */
export type UpdateMessage = Extract<BackendMessage,
  { type: 'update-status' } | { type: 'update-progress' } | { type: 'update-ready' } | { type: 'update-error' }>

/** Which of the cross-device features this BUILD may use (engine `remote`, see
 *  sdk/player.js). Construction-time only, and off by default, because turning one on
 *  makes every login RETAIN something it would otherwise drop: `sendToTv` keeps the
 *  account's two private keys in memory for the whole session, which is the only way a
 *  phone can hand an account to a TV without the password. A build that will never send
 *  a sign-in should not be holding them. */
export interface RemoteFeatures {
  /** The PHONE half of "send to TV" (backend.sendSignIn). Receiving needs nothing. */
  sendToTv?: boolean
  /** The account rendezvous secret. Not a key, but a live authenticator and a stable
   *  account correlator — leave it off until a feature needs it. */
  control?: boolean
}

/** Where a phone -> TV sign-in has got to. Three of these are QUESTIONS and the
 *  exchange BLOCKS on each until the host answers: 'match' (phone → confirmSignInMatch),
 *  'pin-entry' (TV → submitSignInPin), 'confirm-service' (TV → confirmSignInService). */
export type SigninPairState =
  | 'code' | 'announced' | 'searching' | 'linked' | 'match' | 'pin' | 'pin-entry'
  | 'received' | 'sent' | 'confirm-service' | 'signed-in' | 'failed'

/**
 * Why a sign-in ended. THREE of these must never be worded as an ordinary "try again",
 * because for each of them a retry is either useless or the wrong move:
 *
 *   mismatch  the viewer said the two screens showed different digits — which is what
 *             something sitting between the two devices looks like from here. The next
 *             attempt does not belong on the same network.
 *   flooded   many devices answered one code, which is what a search for a colliding
 *             pair of digits looks like. The code is gone; a fresh one on the TV.
 *   version   the two devices speak different wire versions of this protocol. The fix
 *             is updating the app on BOTH — no new code will ever help.
 *
 * A DELIBERATE DUPLICATE of sdk/index.d.ts SigninPairErrorCode, and it can fall behind
 * it. This binding has no dependency on the engine package (it hosts the engine over
 * IPC and never imports it), so re-exporting the engine's type would make
 * `@aliran/react-native` fail to typecheck for anyone who installs it on its own —
 * which is every host that is not this repo. The cost of the copy is drift, so the
 * WIRE TYPES below never promise it is complete: a reason arrives as SigninPairReason,
 * and isSigninPairError() is the runtime whitelist. Treat an unrecognised code as a
 * plain failure with words of your own; never render it, and never assert on it.
 */
export type SigninPairErrorCode =
  | 'malformed' | 'timeout' | 'expired' | 'used' | 'busy'
  | 'unauthorized' | 'mismatch' | 'pin' | 'cancelled' | 'refused' | 'version' | 'flooded'

/** The same list at runtime, so a host can whitelist what it renders. */
export const SIGNIN_PAIR_ERRORS: readonly SigninPairErrorCode[] = [
  'malformed', 'timeout', 'expired', 'used', 'busy',
  'unauthorized', 'mismatch', 'pin', 'cancelled', 'refused', 'version', 'flooded'
]

/**
 * A reason AS IT ARRIVES: one this build knows, or a code from an engine newer than it.
 * Typed this way rather than as the bare union because the value comes off a wire shared
 * with a device on another app version — calling that a closed set would be a lie the
 * compiler then helps a host believe.
 */
export type SigninPairReason = SigninPairErrorCode | (string & {})

/** Whether a reason is one THIS build has words for. The whitelist a host needs before
 *  it puts a wire-supplied code anywhere near a screen or a switch statement. */
export function isSigninPairError (v: unknown): v is SigninPairErrorCode {
  return typeof v === 'string' && (SIGNIN_PAIR_ERRORS as readonly string[]).includes(v)
}

/** One step of a phone -> TV sign-in, as the engine reports it.
 *
 *  `code`, `sas` and `pin` are SCREEN MATERIAL and live secrets for the length of the
 *  exchange: show them, and log, store or forward none of them. This binding keeps the
 *  whole `signin-` message family out of its debug logger for that reason. */
export interface SigninPairInfo {
  role: 'tv' | 'phone'
  state: SigninPairState
  /** role 'tv', state 'code': the 12 characters to display, with its expiry. */
  code?: string
  expiresAt?: number
  /** state 'match': four digits BOTH devices show. On the phone, ASK whether the TV
   *  shows the same four and answer with confirmSignInMatch(); on the TV, display only —
   *  the confirmation belongs on the device that already holds the account. */
  sas?: string
  /** role 'phone', state 'pin': four digits to display for the viewer to type INTO the
   *  TV. One attempt: a wrong entry ends the sign-in and the code is already spent. */
  pin?: string
  /** role 'tv', states 'confirm-service' and 'signed-in': the account being signed in. */
  username?: string
  /** role 'tv', state 'confirm-service': the operator key about to be used (hex)… */
  panelPubKey?: string
  /** …the same key as the operator's printed 12-character pairing code, or null. Show
   *  THIS, not the 64 hex characters: it is what a viewer can check against a card. */
  pairingCode?: string | null
  /** …true when this device has no operator yet and is about to adopt that one. */
  adopting?: boolean
  /** state 'failed'. Use it to CHOOSE a sentence, never as one — see SigninPairReason,
   *  and check it with isSigninPairError() before you switch on it. */
  reason?: SigninPairReason
  /** state 'failed', and only where the engine wrote a sentence FOR A VIEWER itself
   *  (the key-handover failures). English by design. Bound it and strip control
   *  characters before rendering: the engine's own vocabulary is curated, but this is
   *  the one field on the stream whose text is not a fixed catalog entry. */
  message?: string
}

/** Answer to startSignIn(). ok=false carries the engine's reason — a code is already
 *  showing on this device, or the engine is not running. */
export interface SignInStartResult {
  ok: boolean
  /** The 12 characters to put on screen, e.g. 'A3K7-9QF2-M4XR'. */
  code?: string
  expiresAt?: number
  error?: SigninPairReason
  message?: string
}

/** Answer to sendSignIn(). ok=true only means the rendezvous was joined — the outcome
 *  of the exchange arrives on the 'signin-pair' stream. */
export interface SignInSendResult {
  ok: boolean
  error?: SigninPairReason
  message?: string
}

export type BackendMessage =
  | { type: 'ready' }
  | { type: 'streams'; streams: Stream[]; vod?: VodConfig }
  | { type: 'login-error'; message: string }
  // streamId names the stream this play() reply is for (absent on dev direct-play and
  // on worklet bundles older than the field) — <AliranVideo> uses it to tell "the served
  // channel just CHANGED under the shared localhost URL" (remount) from a re-resolve of
  // the channel already playing (keep the mount). recordType/durationSec (S8a) mirror
  // the engine's ResolveResult type/durationSec — recordType 'vod' means the url is a
  // finished VOD playlist: show seek/pause UI and expect no live self-heal events.
  // (Named recordType because `type` is this union's own discriminant.)
  // headers: request headers the VIDEO PLAYER must send with url, for redirect channels
  // whose provider hotlink-checks Referer/Origin/User-Agent. Present only there.
  | { type: 'port'; port?: number; url?: string; source?: 'p2p' | 'cdn'; streamId?: string; recordType?: 'live' | 'vod'; durationSec?: number | null; headers?: Record<string, string> | null }
  | { type: 'status'; peers?: number; state?: string; message?: string }
  | { type: 'error'; message: string }
  | { type: 'fallback'; streamId: string; url: string; reason: 'timeout' | 'stall' }
  | { type: 'source-changed'; streamId: string; source: 'p2p' | 'cdn'; url: string }
  // The active stream's feedKey rotated underneath the viewer (broadcaster source change /
  // RAM restart); the engine re-resolved and swapped the served feed. url is the unchanged
  // localhost URL — remount the player to flush the stale playlist. See sdk/player.js.
  | { type: 'feed-changed'; streamId: string; feedKey: string; url: string }
  // Smooth-zapping lifecycle: {enabled} echoes a runtime toggle; {state} reports the
  // adaptive gate pausing/resuming the neighbor warm loop (reason 'metered' = host
  // said the network is expensive, 'stall' = the active stream is starving,
  // 'thin' = neighbor downloads show the pipe has no headroom).
  | { type: 'zap-prefetch'; enabled?: boolean; state?: 'suspended' | 'resumed'; reason?: 'metered' | 'stall' | 'thin' }
  // smoothZapping: the persisted "Smooth zapping" choice — null/absent when the user
  // never set the toggle (the app's compiled default applies at boot). service: the
  // runtime-entered operator service — null/absent unless a keyless build saved one.
  // vodList/vodHistory (S54a): the device-local VOD arrays, absent on worklet bundles
  // older than the field — treat as empty, never as "the user has nothing saved".
  // parental: the device parental-control state — null = no PIN on this device;
  // { hide } = a PIN exists (the digest itself never crosses into the RN layer).
  // Absent on worklet bundles older than the field — treat as null.
  // language: the viewer's pinned UI language — null/absent = no override, so the host
  // follows the DEVICE language (the worklet whitelists the code before it stores it).
  | { type: 'prefs'; creds: SavedCredentials | null; favorites: string[]; smoothZapping?: boolean | null; language?: string | null; service?: SavedService | null; vodList?: VodListEntry[]; vodHistory?: VodHistoryEntry[]; parental?: { hide: boolean } | null }
  // Answer to parentalVerify(): did the submitted PIN match? tag echoes the request's.
  | { type: 'parental-verify'; ok: boolean; tag?: string }
  // Answer to resolvePairing(): the panel key a service pairing code stands for, after
  // the engine verified it by re-deriving the code. error 'malformed' = not a code;
  // 'timeout' = nobody answered it; 'unverified' = a peer DID answer and could not
  // prove it owns the code — never treat that as "try again", it is a wrong service.
  | { type: 'pair-result'; ok: boolean; panelPubKey?: string; name?: string; code?: string; error?: PairingErrorCode | string; message?: string; tag?: string }
  // Answer to sendReport() (S50c). ok=true means the panel accepted it (possibly
  // deduplicated or collapsed into an open alert — either way, "we heard you").
  // error 'unsupported' = this panel predates reports or has them disabled; 'cooldown'
  // / 'locked' carry retryAfter seconds; 'not-logged-in' / 'offline' are transient.
  | { type: 'report-result'; ok: boolean; error?: ReportError | string; retryAfter?: number; id?: string }
  // Answer to checkUpdate() (tag echoes the request's). See UpdateCheckResult.
  | { type: 'update-status'; status: UpdateCheckStatus; entry?: UpdateEntry; mandatory?: boolean; error?: string; tag?: string }
  // OTA download progress, throttled by the engine (~500 ms / 5% steps).
  | { type: 'update-progress'; received: number; total: number }
  // OTA artifact downloaded + sha256-verified. path is inside the app sandbox — hand
  // it to the installer promptly (the store dir is a disposable cache).
  | { type: 'update-ready'; path: string; entry: UpdateEntry }
  // OTA download/verify failure (sha256 mismatch, stalled transfer, missing file).
  | { type: 'update-error'; message: string }
  // Phone -> TV sign-in, the whole progress stream (see SigninPairInfo). NOT a reply to
  // anything: both roles report through it, and three of its states are questions the
  // host must answer or the exchange times out. Carries live secrets — never logged.
  | ({ type: 'signin-pair' } & SigninPairInfo)
  // Answer to startSignIn() (TV role). The code also arrives as {state:'code'} on the
  // stream above; this reply exists so a REFUSAL reaches the screen too.
  | { type: 'signin-started'; ok: boolean; code?: string; expiresAt?: number; error?: SigninPairReason; message?: string; tag?: string }
  // Answer to sendSignIn() (phone role): the rendezvous was joined, or why not.
  | { type: 'signin-sending'; ok: boolean; error?: SigninPairReason; message?: string; tag?: string }
  // Answer to the three one-word answers (submitSignInPin / confirmSignInService /
  // confirmSignInMatch). ok=false means the engine had nothing waiting for that answer,
  // or the value was malformed — for a PIN that is the safe outcome and costs nothing.
  | { type: 'signin-ack'; ok: boolean; tag?: string }

// How long the two sign-in STARTS may take to answer. Both open the corestore, derive
// the code's rendezvous with Argon2id (~70 ms, more on a cold TV SoC) and join a DHT
// topic before they resolve, so this is deliberately generous — a viewer is watching a
// spinner where the code goes, and "nothing answered" must be the last resort.
const SIGNIN_START_MS = 20000
// …and the three one-word answers, which are in-memory calls on an exchange that is
// already running. Short: a slow one means the worklet is gone.
const SIGNIN_ACK_MS = 5000

export interface StartOptions {
  /** Omit to boot the worklet WITHOUT connecting (S36 runtime-descriptor flow: read
   *  prefs first, then connect() with the persisted or user-entered panel key). */
  panelPubKey?: string
  hybrid?: HybridConfig
  /**
   * Warm entitled feeds after login so the FIRST zap to a channel is fast (the cold DHT
   * lookup happens in the background). false (default) = off; true = all; a positive
   * integer caps how many (lowest curated order first). Bandwidth-cheap: sparse, so it
   * warms the connection, not a full download.
   */
  prewarm?: boolean | number
  /** Tune self-heal knobs (timeout → evict + one retry → friendly error; forced DHT
   *  re-lookups while tuning). Omit for the engine defaults. */
  tune?: TuneConfig
  /** Keep adjacent channels' newest segment warm while playing so CH+/CH- zaps start
   *  fast. OFF by default — costs standing bandwidth (see ZapPrefetchConfig). */
  zapPrefetch?: boolean | ZapPrefetchConfig
  /** Raise the engine swarm's connection budget (seed nodes / repeater-style hosts
   *  only — viewers keep the hyperswarm default; see SwarmConfig). */
  swarm?: SwarmConfig
  /** 'reseed' (default): replicated blocks are served back to other viewers on
   *  request. 'client-only': never announce on feed/assets topics — practically zero
   *  viewer-to-viewer upload, at the cost of one fewer re-seeder in the swarm. */
  uploadPolicy?: 'reseed' | 'client-only'
  /** Host app version attached to viewer problem reports (S50c), e.g. '0.2.0'. Used
   *  for nothing else — the engine never sends it to the panel outside a report. */
  appVersion?: string
  /** Platform label attached to problem reports. Defaults to `${Platform.OS} ${Platform.Version}`. */
  platform?: string
  /** Cross-device features this build may use (see RemoteFeatures). Both are OFF by
   *  default and both are BOOT-TIME: by the time a runtime switch could be flipped the
   *  login has already happened, so the material is either retained or unrecoverable.
   *  `sendToTv` is required by sendSignIn() and by nothing else — receiving a sign-in
   *  on a TV needs no flag at all. */
  remote?: RemoteFeatures
  /** console.log every backend message (dev instrumentation — shows in `adb logcat -s ReactNativeJS`). */
  debug?: boolean
}

export class AliranBackend {
  // Last entitlement list from the backend. Screens that mount AFTER login (e.g. a
  // home screen navigated to on {type:'streams'}) read this instead of missing the
  // one-shot message.
  streams: Stream[] = []
  // Panel-delivered external VOD provider config (S53), or null when the operator has
  // none / has it disabled — null IS "no VOD section". Login-scoped: it rides the
  // 'streams' message and never changes mid-session.
  vod: VodConfig | null = null
  // Last media-server port / active-source URL. The server is persistent (one port
  // per session), and the one-shot {type:'port'} reply to play() can land before the
  // player screen mounts.
  port: number | null = null
  url: string | null = null
  source: 'p2p' | 'cdn' | null = null
  // The stream the engine last confirmed serving (from the 'port' reply). ONE localhost
  // URL serves whatever feed is active, so this — not the URL — is what identifies the
  // channel behind the player. Survives screen unmounts (module-singleton backend).
  activeStreamId: string | null = null
  // Record class of the active serve (S8a): 'vod' = a finished library title (seek/pause
  // UI, no live self-heal), with its durationSec beside it. null until a reply carries
  // them (worklet bundles older than the field never do — treat as live).
  recordType: 'live' | 'vod' | null = null
  durationSec: number | null = null
  // Request headers the video player must send with `url` (redirect channels behind a
  // provider hotlink check). Tracked beside url because they are only valid FOR that
  // url: every event that replaces url with a localhost or CDN one clears this.
  headers: Record<string, string> | null = null
  // Device-local prefs mirrored from the worklet (see client/backend/backend.mjs):
  // saved "remember me" credentials + favorite stream ids. `prefsLoaded` flips on the
  // first {type:'prefs'} reply — request with requestPrefs().
  creds: SavedCredentials | null = null
  favorites: string[] = []
  /** Persisted "Smooth zapping" choice; null until the user first sets the toggle. */
  smoothZapping: boolean | null = null
  /** The viewer's pinned UI language; null while they follow the device language.
   *  The SDK stores and relays it — WHAT it means is the host app's business (this
   *  binding renders no localized copy of its own). */
  language: string | null = null
  /** Runtime-entered operator service mirrored from the worklet prefs (S36); null
   *  until a keyless build's Connect screen saves one. */
  service: SavedService | null = null
  /** Device-local VOD "My List" + watch history mirrored from the worklet prefs
   *  (S54a, D9). Newest first. The worklet re-validates and caps whatever is sent
   *  (500 / 200), so what lands back on the next {type:'prefs'} is the truth. */
  vodList: VodListEntry[] = []
  vodHistory: VodHistoryEntry[] = []
  /** Parental controls (device-local): null = no PIN set; { hide } = PIN exists +
   *  the hide-restricted-channels toggle. The PIN digest stays in the worklet. */
  parental: { hide: boolean } | null = null
  prefsLoaded = false
  /**
   * The last step of a phone -> TV sign-in, per role — so a screen that mounts (or
   * REmounts) mid-exchange paints the step the engine is actually waiting on instead of
   * a blank one. The exchange lives in the worklet and survives a screen unmount; its
   * states are one-shot messages, exactly like {type:'streams'} and {type:'port'}.
   *
   * Only ever the LATEST step, and startSignIn()/sendSignIn() clear it — so a stale
   * 'failed' cannot paint a fresh code, and the digits of a finished exchange are
   * replaced by the next state rather than kept. Holds screen secrets while a step is
   * live (`code`, `sas`, `pin`): render them, log and serialize neither.
   */
  signinTv: SigninPairInfo | null = null
  signinPhone: SigninPairInfo | null = null

  private worklet: WorkletInstance | null = null
  // Flips when start() finds no engine in this build/device: every later send()
  // becomes a silent no-op (nothing queues, nothing throws, no listener ever fires).
  private inactive = false
  private ipc: any
  private buf = ''
  private debug = false
  private listeners = new Set<(m: BackendMessage) => void>()
  // Messages sent before start() wires the IPC stream (e.g. a splash screen asking
  // for prefs while the host is still booting the worklet) queue up and flush then.
  private pending: unknown[] = []
  // Engine options stashed by start() so a later connect() (runtime-descriptor flow)
  // boots the engine with the same policy the host compiled in.
  private engineOpts: Omit<StartOptions, 'panelPubKey' | 'debug'> = {}

  /**
   * Whether this build/device can run the P2P engine. False when the app was built
   * without the bare-kit native module (the legacy Android flavor — the engine's
   * hard floor is Android 10 / API 29, see docs/sdk.md "Minimum requirements").
   * When false the whole backend is silently inactive: start() and every other
   * method are safe no-ops and no message ever fires. This is the host app's
   * switch for its own legacy mode (e.g. operator-provided CDN playback outside
   * this SDK) — below Android 10 no P2P data is reachable at all.
   */
  static isSupported (): boolean { return engineAvailable() }

  /**
   * Boot the worklet with a bare-pack bundle (base64 string or raw bytes) and connect
   * to the panel. Bytes are passed via startBytes so the binary bundle is preserved
   * intact; the filename extension must be `.bundle`. Omit opts.panelPubKey to boot
   * WITHOUT connecting — prefs are readable right away, and connect() dials the panel
   * once the host knows which one (persisted runtime service, or the Connect screen).
   */
  start (bundle: string | Uint8Array, opts: StartOptions) {
    if (!engineAvailable()) { this.inactive = true; this.pending = []; return } // no engine here — stay silent
    this.debug = !!opts.debug
    this.engineOpts = {
      hybrid: opts.hybrid,
      prewarm: opts.prewarm,
      tune: opts.tune,
      zapPrefetch: opts.zapPrefetch,
      swarm: opts.swarm,
      uploadPolicy: opts.uploadPolicy,
      appVersion: opts.appVersion,
      remote: opts.remote,
      // A coarse device/OS label for problem reports — 'android 33', 'ios 17'. Coarse
      // ON PURPOSE: an exact device model plus an operator's account list is enough to
      // start re-identifying a pseudonymous reporter.
      platform: opts.platform ?? `${Platform.OS} ${Platform.Version}`
    }
    const bytes = typeof bundle === 'string' ? b4a.from(bundle, 'base64') : bundle
    if (!this.worklet) {
      if (probeWorklet) { this.worklet = probeWorklet; probeWorklet = null } // reuse the probe's handle
      else this.worklet = new (require('react-native-bare-kit').Worklet as WorkletCtor)()
    }
    this.worklet.start('/app.bundle', bytes as any)
    this.ipc = this.worklet.IPC
    this.ipc.on('data', (d: Uint8Array) => this.onData(b4a.toString(d)))
    if (opts.panelPubKey) this.connect(opts.panelPubKey)
    const queued = this.pending; this.pending = []
    for (const m of queued) this.send(m)
  }

  /** Connect (or re-connect) the engine to a panel. With the engine already on a
   *  DIFFERENT panel this is a service switch: the worklet tears the old engine down
   *  and boots fresh — wait for the new {type:'ready'} before logging in. */
  connect (panelPubKey: string) {
    this.send({ ...this.engineOpts, panelPubKey })
  }

  onMessage (fn: (m: BackendMessage) => void) {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) } // void, so it can be a useEffect cleanup
  }

  login (username: string, password: string) { this.send({ username, password }) }
  play (streamId: string) { this.send({ streamId }) }
  /** Dev direct-play by raw keys (no login). */
  playRaw (feedKey: string, encryptionKey: string) { this.send({ feedKey, encryptionKey }) }
  /** Tear down the active feed's swarm connections and dial fresh (wedged-transport
   *  escalation — see AliranVideo's stall ladder). The engine re-arms its tune
   *  watchdog, so the outcome is either playback resuming or a friendly error. */
  reconnect () { this.send({ type: 'reconnect' }) }

  /** Runtime "Smooth zapping" toggle: enable/disable (or reconfigure) adjacent-channel
   *  prefetch mid-play. Echoed back as {type:'zap-prefetch', enabled}. At boot, pass
   *  the persisted preference via StartOptions.zapPrefetch instead. */
  setZapPrefetch (v: boolean | ZapPrefetchConfig) { this.send({ type: 'zap-prefetch-set', zapPrefetch: v }) }

  /** Pin the viewer's UI language (device-local, survives restarts), or pass null to
   *  clear it and follow the device language again. The worklet whitelists the code
   *  and answers with a {type:'prefs'} carrying what it actually stored. */
  setLanguage (language: string | null) {
    this.language = language // optimistic; the 'prefs' reply confirms
    this.send({ type: 'language-set', language })
  }
  /** Host network profile (feed RN NetInfo changes down): expensive=true suspends
   *  zap prefetch immediately; false lifts the suspension on the next tick. */
  // `cellular` is separate from `expensive` on purpose: an unmetered cellular plan
  // reports isConnectionExpensive === false, but the viewer is still on mobile data and
  // uploading there is what burns their battery and allowance. Either signal limits
  // upload (S25); only `expensive` gates prefetch.
  setNetworkProfile (expensive: boolean, cellular = false) { this.send({ type: 'net-info', expensive, cellular }) }

  /**
   * Send a viewer problem report (S50c). Fire-and-forget: the answer arrives as
   * {type:'report-result'} on the message feed, so a modal subscribes before calling.
   * The engine attaches the active channel, peer count, app version/platform and its
   * recent event breadcrumbs; identity is the SESSION TOKEN, which the panel reduces
   * to a pseudonym on arrival — no username or device id is ever stored there.
   * Show REPORT_CONSENT before submitting.
   */
  sendReport (category: ReportCategory, text?: string) {
    this.send({ type: 'report', category, ...(text ? { text } : {}) })
  }

  /**
   * Check the panel's updates drive for a newer build of THIS app (OTA app updates).
   * Lazy engine-side: the first check opens the sparse manifest replica and joins its
   * topic client-only — a viewer never re-serves APK blobs. Resolves (never rejects):
   * 'available' carries the manifest entry + the mandatory flag, 'unknown' means
   * "cannot say right now — try again later" (also the verdict on an engine-less
   * build, a dead engine, or a 30 s reply timeout).
   */
  checkUpdate (appInfo: AppUpdateInfo): Promise<UpdateCheckResult> {
    if (this.inactive) return Promise.resolve({ status: 'unknown' })
    return new Promise((resolve) => {
      const tag = Math.random().toString(36).slice(2, 10)
      const timer = setTimeout(() => { off(); resolve({ status: 'unknown', error: 'timeout' }) }, 30000)
      const off = this.onMessage((m) => {
        if (m.type !== 'update-status' || m.tag !== tag) return
        clearTimeout(timer)
        off()
        const { type, tag: _tag, ...result } = m // eslint-disable-line @typescript-eslint/no-unused-vars
        resolve(result as UpdateCheckResult)
      })
      this.send({ type: 'update-check', ...appInfo, tag })
    })
  }

  /** Download + verify the update the last 'available' checkUpdate() found.
   *  Fire-and-forget: subscribe with onUpdate() first — progress arrives as
   *  {type:'update-progress'}, the verified file path as {type:'update-ready'}
   *  (hand it to the installer), a failure as {type:'update-error'}. */
  downloadUpdate () { this.send({ type: 'update-download' }) }

  /** Subscribe to the update lifecycle messages only (status/progress/ready/error).
   *  Returns the unsubscribe function (usable as a useEffect cleanup). */
  onUpdate (fn: (m: UpdateMessage) => void) {
    return this.onMessage((m) => {
      if (m.type === 'update-status' || m.type === 'update-progress' || m.type === 'update-ready' || m.type === 'update-error') fn(m)
    })
  }

  /** Ask the worklet for saved credentials + favorites + the device-local VOD arrays;
   *  answers as {type:'prefs'}. */
  requestPrefs () { this.send({ type: 'prefs-get' }) }
  /** Persist "remember me" credentials (device-local; sign-out clears them). */
  saveCredentials (username: string, password: string) { this.send({ type: 'creds-save', username, password }) }
  clearCredentials () { this.creds = null; this.send({ type: 'creds-clear' }) }
  /**
   * Resolve a 12-character SERVICE PAIRING CODE ('A3K7-9QF2-M4XR') to the operator's
   * panel public key, so a viewer never types 64 hex characters on a TV remote.
   *
   * The engine finds the service over the DHT and VERIFIES the answer by re-deriving
   * the code from the key it received — an `ok` result is a key that provably owns the
   * code. It persists nothing: connect() with the key, log in, and save the service
   * only once both worked, exactly as with a typed key.
   *
   * Resolves (never rejects) — a failure arrives as { ok: false, error }. Waits up to
   * 45 s: the engine's own search is 30 s, and this must outlast it to report the
   * engine's reason rather than its own timeout.
   */
  resolvePairing (code: string): Promise<PairingResult> {
    return new Promise((resolve) => {
      const tag = Math.random().toString(36).slice(2, 10)
      const timer = setTimeout(() => { off(); resolve({ ok: false, error: 'timeout' }) }, 45000)
      const off = this.onMessage((m) => {
        if (m.type !== 'pair-result' || m.tag !== tag) return
        clearTimeout(timer)
        off()
        const { type, tag: _tag, ...result } = m // eslint-disable-line @typescript-eslint/no-unused-vars
        resolve(result as PairingResult)
      })
      this.send({ type: 'pair-resolve', code, tag })
    })
  }

  /** Persist the runtime-entered operator service (keyless public builds; S36). */
  saveService (service: SavedService) { this.service = service; this.send({ type: 'service-save', service }) }
  /** Forget the runtime service ("Change service…" — never affects a baked key). */
  clearService () { this.service = null; this.send({ type: 'service-clear' }) }
  /** Toggle a favorite; the worklet persists and answers with the new prefs. */
  toggleFavorite (streamId: string) {
    const next = this.favorites.includes(streamId)
      ? this.favorites.filter(id => id !== streamId)
      : [...this.favorites, streamId]
    this.favorites = next // optimistic; the 'prefs' reply confirms
    this.send({ type: 'favorites-set', favorites: next })
  }

  isFavorite (streamId: string) { return this.favorites.includes(streamId) }

  /** Create/replace the parental PIN (4-8 digits; the caller verifies the old one
   *  first when changing). The worklet salts + hashes it and answers with 'prefs'. */
  parentalSetPin (pin: string) { this.send({ type: 'parental-set-pin', pin }) }
  /** Remove the PIN entirely — restricted channels go back to being hidden. */
  parentalClear () { this.parental = null; this.send({ type: 'parental-clear' }) }
  /** Set the hide-restricted-channels toggle (only meaningful while a PIN exists). */
  parentalSetHide (hide: boolean) {
    if (this.parental) this.parental = { ...this.parental, hide } // optimistic; 'prefs' confirms
    this.send({ type: 'parental-hide-set', hide })
  }

  /** Verify a PIN against the stored digest (worklet round-trip). Resolves false on
   *  a wrong PIN, no PIN, or an engine that never answers (3 s timeout). */
  parentalVerify (pin: string): Promise<boolean> {
    return new Promise((resolve) => {
      const tag = Math.random().toString(36).slice(2, 10)
      const timer = setTimeout(() => { off(); resolve(false) }, 3000)
      const off = this.onMessage((m) => {
        if (m.type !== 'parental-verify' || m.tag !== tag) return
        clearTimeout(timer)
        off()
        resolve(m.ok === true)
      })
      this.send({ type: 'parental-verify', pin, tag })
    })
  }

  /**
   * Replace the device-local VOD "My List" (S54a, D9). Whole-array replace, newest
   * first — the worklet gates the shapes and caps the length, then answers with a
   * {type:'prefs'} carrying what it actually stored. Device-local: nothing about a
   * viewer's list ever reaches the panel or the provider.
   */
  setVodList (entries: VodListEntry[]) {
    this.vodList = entries // optimistic; the 'prefs' reply confirms
    this.send({ type: 'vod-list-set', entries })
  }

  /** Replace the device-local watch history (S54a, D9) — same contract as setVodList.
   *  Called by the VOD players on a throttle, so keep the array small and ordered. */
  setVodHistory (entries: VodHistoryEntry[]) {
    this.vodHistory = entries // optimistic; the 'prefs' reply confirms
    this.send({ type: 'vod-history-set', entries })
  }

  // --- phone -> TV sign-in handover ---------------------------------------------------
  //
  // Signing in on a television means spelling out a password with a D-pad. This replaces
  // that: the TV shows twelve characters, a phone that is already signed in types them,
  // TWO checks run, and the phone hands over the account key material so the TV signs
  // ITSELF in — its own device id, its own panel-signed token. See sdk/signin-pair.js.
  //
  // THREE OF THE STATES ARE QUESTIONS and the exchange BLOCKS on each one: 'match' on
  // the phone (confirmSignInMatch), 'pin-entry' on the TV (submitSignInPin) and
  // 'confirm-service' on the TV (confirmSignInService). A host that renders the states
  // as progress and never answers gets timeouts — which is correct: none of the three
  // has a default, and none may be answered on the viewer's behalf.
  //
  // NOTHING ON THIS PATH MAY BE LOGGED. The code, the compared digits and the typed
  // digits are live secrets for the length of the exchange; onData() below keeps the
  // whole `signin-` family out of the debug logger.

  /**
   * TV role. Mint a sign-in code, announce its rendezvous and wait for a phone. Resolves
   * as soon as the code exists — the viewer is looking at the screen — with the 12
   * characters to display; everything after that arrives through onSignInPair().
   *
   * The device does NOT have to be connected to a panel first: the handover carries the
   * operator key, which is exactly why 'confirm-service' has to be answered before that
   * key is adopted.
   *
   * Resolves (never rejects): a refusal arrives as { ok: false, message }.
   */
  async startSignIn (opts: { ttlMs?: number } = {}): Promise<SignInStartResult> {
    // A new code, so nothing of the last exchange may still be on a screen.
    this.signinTv = null
    const m = await this.request('signin-started', {
      type: 'signin-start',
      ...this.engineOpts, // a never-paired TV starts this with no panel — see the worklet
      ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {})
    }, SIGNIN_START_MS)
    if (!m || m.type !== 'signin-started') return { ok: false, error: 'timeout', message: 'the engine did not answer' }
    const { type, tag, ...result } = m // eslint-disable-line @typescript-eslint/no-unused-vars
    return result
  }

  /**
   * TV role. The four digits the viewer typed on the remote. False for a malformed entry
   * or when nothing is waiting for one, so a screen may validate as the digits go in.
   *
   * A well-formed submission is FINAL: right or wrong, it is the only answer this
   * handover ever sends, and a wrong one ends the sign-in with the code already spent.
   * One attempt is what makes a blind guess one in ten thousand instead of a warm-up.
   */
  async submitSignInPin (pin: string): Promise<boolean> {
    const m = await this.request('signin-ack', { type: 'signin-submit-pin', pin }, SIGNIN_ACK_MS)
    return !!m && m.type === 'signin-ack' && m.ok === true
  }

  /**
   * TV role. The viewer's answer to 'confirm-service': sign in as that account and, when
   * `adopting`, take that operator key. True adopts; anything else refuses, and the code
   * is spent either way.
   *
   * Ask it as the operator's printed 12-character pairing code (`pairingCode`), never as
   * 64 hex characters — a viewer can check a card, not a key.
   */
  async confirmSignInService (ok: boolean): Promise<boolean> {
    const m = await this.request('signin-ack', { type: 'signin-confirm-service', ok }, SIGNIN_ACK_MS)
    return !!m && m.type === 'signin-ack' && m.ok === true
  }

  /** TV role. Abandon the code on screen. It is spent either way — a new one is the
   *  only way forward. */
  cancelSignIn () { this.send({ type: 'signin-cancel' }) }

  /**
   * Phone role. Sign a TV in with the code it is showing ('a3k7 9qf2 m4xr' is fine —
   * the engine normalizes it). Resolves as soon as the rendezvous is joined; the
   * exchange itself arrives through onSignInPair(), and it STOPS at {state:'match'}
   * until confirmSignInMatch() answers.
   *
   * Requires a live session on this device AND a build started with
   * `remote: { sendToTv: true }` — the payload is key material the login recovered,
   * which cannot be reconstructed later without the password, so a build that never
   * sends does not keep it. Resolves (never rejects); refusals carry the reason.
   */
  async sendSignIn (code: string): Promise<SignInSendResult> {
    this.signinPhone = null
    const m = await this.request('signin-sending', { type: 'signin-send', code }, SIGNIN_START_MS)
    if (!m || m.type !== 'signin-sending') return { ok: false, error: 'timeout', message: 'the engine did not answer' }
    const { type, tag, ...result } = m // eslint-disable-line @typescript-eslint/no-unused-vars
    return result
  }

  /**
   * Phone role. The viewer's answer to 'match': do the four digits on this phone appear
   * on the TV? True proceeds to the typed-digit round; anything else aborts and burns
   * the TV's code.
   *
   * FALSE IS THE IMPORTANT ANSWER. This is the only check in the exchange that sees a
   * peer relaying between the phone and the TV — such a peer holds the code, so it
   * satisfies every other proof, but it terminates two connections and cannot make two
   * screens agree. Never default it, never infer it from a dismissed dialog, and never
   * let a "skip" answer it.
   */
  async confirmSignInMatch (ok: boolean): Promise<boolean> {
    const m = await this.request('signin-ack', { type: 'signin-confirm-match', ok }, SIGNIN_ACK_MS)
    return !!m && m.type === 'signin-ack' && m.ok === true
  }

  /** Phone role. Abandon an in-flight send (the TV's code is spent either way). */
  cancelSendSignIn () { this.send({ type: 'signin-send-cancel' }) }

  /** Subscribe to the sign-in progress stream only. Returns the unsubscribe function
   *  (usable as a useEffect cleanup). A screen that mounts late should also read
   *  `signinTv` / `signinPhone` — the step it missed is cached there. */
  onSignInPair (fn: (info: SigninPairInfo) => void) {
    return this.onMessage((m) => {
      if (m.type !== 'signin-pair') return
      const { type, ...info } = m // eslint-disable-line @typescript-eslint/no-unused-vars
      fn(info)
    })
  }

  /**
   * One tagged request/reply round trip. Resolves null when the worklet never answers
   * (or when there is no engine in this build) — never hangs and never throws, so every
   * caller above can present a plain "nothing answered" instead of an unhandled
   * rejection on a screen a viewer is waiting at.
   */
  private request (reply: BackendMessage['type'], body: Record<string, unknown>, timeoutMs: number): Promise<BackendMessage | null> {
    if (this.inactive) return Promise.resolve(null)
    return new Promise((resolve) => {
      const tag = Math.random().toString(36).slice(2, 10)
      const timer = setTimeout(() => { off(); resolve(null) }, timeoutMs)
      const off = this.onMessage((m) => {
        if (m.type !== reply || (m as { tag?: string }).tag !== tag) return
        clearTimeout(timer)
        off()
        resolve(m)
      })
      this.send({ ...body, tag })
    })
  }

  private send (obj: unknown) {
    if (this.inactive) return // engine-less build/device: drop silently, never queue
    if (!this.ipc) { this.pending.push(obj); return }
    this.ipc.write(b4a.from(JSON.stringify(obj) + '\n'))
  }

  private onData (chunk: string) {
    this.buf += chunk
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as BackendMessage
        // NEVER log the raw line for these two families, whatever its length:
        //
        //   prefs     carries the saved password.
        //   signin-*  carries the sign-in code, the four compared digits and the four
        //             typed digits. Every one of them is a LIVE SECRET for the length of
        //             the exchange, and every message in the family is far shorter than
        //             the 200-character cut-off below — so without this test a debug
        //             build would print the whole handover into `adb logcat`, where a
        //             second app can read it. The engine (sdk/signin-pair.js) goes to
        //             considerable trouble never to log any of it; this is the boundary
        //             where that care would otherwise be undone. The test is on the
        //             PREFIX, not on one message type, so a message added to the family
        //             later is excluded by default rather than by remembering.
        //
        // Everything else: long lines collapse to their type to keep the log readable —
        // EXCEPT 'error', where the payload (often a worklet stack trace) is the only
        // diagnostic there is.
        if (this.debug) {
          const secret = msg.type === 'prefs' || (typeof msg.type === 'string' && msg.type.startsWith('signin-'))
          console.log('[backend]', secret ? msg.type : msg.type === 'error' || line.length <= 200 ? line : msg.type)
        }
        if (msg.type === 'prefs') { this.creds = msg.creds; this.favorites = msg.favorites || []; this.smoothZapping = msg.smoothZapping ?? null; this.language = msg.language ?? null; this.service = msg.service ?? null; this.vodList = msg.vodList || []; this.vodHistory = msg.vodHistory || []; this.parental = msg.parental ?? null; this.prefsLoaded = true }
        if (msg.type === 'streams') { this.streams = msg.streams; this.vod = msg.vod ?? null }
        if (msg.type === 'port') {
          this.port = msg.port ?? null
          this.url = msg.url ?? (msg.port ? `http://127.0.0.1:${msg.port}/index.m3u8` : null)
          this.source = msg.source ?? (this.url ? 'p2p' : null)
          if (msg.streamId) this.activeStreamId = msg.streamId
          this.recordType = msg.recordType ?? null
          this.durationSec = msg.durationSec ?? null
          this.headers = msg.headers ?? null
        }
        // Both of these hand out a DIFFERENT url — the localhost server or the operator's
        // CDN template — so the previous channel's provider headers must not follow it.
        // Clearing here is defensive: they only ever fire for P2P channels, which never
        // carry headers in the first place. ('feed-changed' keeps the same localhost url
        // and is P2P-only for the same reason, so it leaves this alone.)
        if (msg.type === 'fallback') { this.url = msg.url; this.source = 'cdn'; this.headers = null }
        if (msg.type === 'source-changed') { this.url = msg.url; this.source = msg.source; this.headers = null }
        if (msg.type === 'feed-changed') this.url = msg.url // unchanged localhost URL; the source (p2p) is unchanged too
        // The sign-in step a late-mounting (or re-mounting) screen would otherwise have
        // missed. Kept per role, latest only — see the fields' own note.
        if (msg.type === 'signin-pair') {
          const { type, ...info } = msg // eslint-disable-line @typescript-eslint/no-unused-vars
          if (info.role === 'tv') this.signinTv = info
          else if (info.role === 'phone') this.signinPhone = info
        }
        this.listeners.forEach(fn => fn(msg))
      } catch { /* ignore partial/invalid */ }
    }
  }
}
