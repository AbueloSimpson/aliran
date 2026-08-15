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
// The platform key store (Android Keystore). Used for exactly one thing: wrapping the
// file key that seals a stored phone -> TV sign-in, on behalf of the worklet — which
// cannot reach a native module from inside Bare. Degrades to null everywhere else.
import { secureWrap, secureUnwrap, secureReset, type SecureKeyResult } from './secure-key'

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
// bootstrap replaces the PUBLIC DHT's bootstrap nodes with the operator's own
// ('host:port' strings or {host, port}) — self-contained/private deployments only;
// omit it everywhere else, because a viewer that boots onto a private DHT can reach
// exactly the peers that DHT knows and nothing on the public one.
export interface SwarmConfig {
  maxPeers?: number
  bootstrap?: Array<string | { host: string; port: number }>
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
  /**
   * The RECEIVING half of "send to TV", and the only one of the three about DISK: a
   * television that took a sign-in from a phone KEEPS it, sealed under a key held in the
   * Android Keystore, and signs itself back in with resumeSignIn() after a restart.
   * Without it a set that Android reclaims comes back to the sign-in screen and needs the
   * phone again — which is worse than the password path it replaced.
   *
   * NOT the same switch as `sendToTv`, and on a television they are opposites: sendToTv
   * is off there so a set never holds an account it could pass on; this is on there so a
   * set survives a restart. Android only — elsewhere there is no key store to use and the
   * worklet keeps nothing.
   */
  keepSignIn?: boolean
}

/** Why a resumeSignIn() did not sign the device in.
 *
 *  READ `retry`, NOT THIS. Only `offline` and `timeout` are worth retrying, and they are
 *  also the only ones that leave the material in place — everything else means the worklet
 *  has ALREADY erased what it was holding and the device needs a fresh sign-in from a
 *  phone. The worklet is deliberately reluctant to reach the erasing values: a key store
 *  that did not answer, a swarm still dialling and an account record that has not
 *  replicated to this device yet are all 'offline'. */
export type ResumeSignInError =
  /** Nothing was stored (the ordinary answer on a device that has never been signed in). */
  | 'none'
  /** The key store said these bytes will never open again: no key for this app any more,
   *  or a blob it did not produce. NOT a key store that was merely unreachable — that is
   *  'offline'. Erased. */
  | 'locked'
  /** The stored record is not readable — truncated, or written by another build. Erased. */
  | 'corrupt'
  /** The record belongs to a different operator than this device is now on. Erased. */
  | 'service'
  /** The panel refused: disabled account, device limit, or a password rotation that
   *  replaced the account's keys. Erased. */
  | 'rejected'
  /** No engine yet, the panel was unreachable, the key store did not answer, or the
   *  account record has not replicated to this device yet. KEPT — try again. */
  | 'offline'
  /** The worklet did not answer in time. KEPT — try again. */
  | 'timeout'
  | (string & {})

/** Answer to resumeSignIn(). ok=true means 'streams' has already fired and the device is
 *  signed in exactly as a typed login leaves it. */
export interface ResumeSignInResult {
  ok: boolean
  error?: ResumeSignInError
  /** English, from the engine. Show it only where a viewer is already being told
   *  something went wrong. */
  message?: string
  /** The material is still stored and this is worth another attempt. Never true together
   *  with an error that erased. */
  retry?: boolean
  /**
   * WHAT THIS ATTEMPT COST: the number of `login` RPCs it put on the panel.
   *
   * `retry` says the keys survived. It says nothing about price, and the two are genuinely
   * independent — a resume that never found a socket and a resume that spent three logins
   * waiting for an account record to replicate both come back `retry: true`. A host that
   * budgets its loop by wall clock cannot tell them apart. The panel can: it counts EVERY
   * `login` against (username|peer), successes included, and stops answering past
   * LOCKOUT_THRESHOLD (10 by default) for LOCKOUT_SECONDS (900). The peer half is the
   * engine's Hyperswarm key — minted at random per instance, so a device only ever locks
   * out ITSELF, and only for the life of this process. What that costs is the fall-through:
   * the password screen a host shows next is refused too, in front of a viewer holding the
   * right password.
   *
   * So budget the attempts that cost by COUNT, and the ones that cost nothing by the clock.
   *
   * ABSENT MEANS UNKNOWN, NOT ZERO, and unknown must be charged as though it had paid. The
   * only answers that omit it are the ones the worklet did not compose — the `timeout`
   * below, where the worklet may still be inside signInWithKeys() with a login in flight.
   */
  logins?: number
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

// --- "Send to TV": cast a channel to a Chromecast, or hand it to another device ---

/**
 * A live cast session — this device serving one channel to a receiver on the LAN.
 *
 * `url` IS THE SECRET. It carries the per-session token, and it is what makes the whole
 * `cast-` message family invisible to the debug logger. Render nothing from it, log
 * nothing from it, and put it nowhere a crash reporter would follow.
 *
 * And the token is a session SCOPE, not an access boundary: a Cast receiver hands the
 * whole media URL back to any unauthenticated peer that joins its session — measured on
 * a TCL Google TV running the stock receiver. `receiverHost` is what narrows that, and
 * it is off unless the host passed one.
 */
export interface CastSessionInfo {
  /** The URL the receiver loads. Contains the session token — never log it. */
  url: string
  streamId: string
  /** 'p2p' = served off this device's LAN server; 'cdn' = an operator URL, no server. */
  source: 'p2p' | 'cdn'
  /** LAN address the URL advertises AND the server bound to — absent for 'cdn'. */
  host?: string
  port?: number
  /** The addresses this session serves, and nothing else. Absent = it serves ANY peer
   *  that can read the URL off the receiver — a state to show, not to assume. */
  receiverHost?: string[]
  type?: 'live' | 'vod'
  /** Redirect channels only: headers the receiver must send (provider hotlink checks). */
  headers?: Record<string, string>
  /** Every private address this device offered, best guess first. Offer these when a
   *  receiver cannot reach `host`, and start again with a chosen advertiseHost. */
  candidates?: string[]
}

/** Why a cast session ended on its own. None of them is the viewer's doing, and all
 *  three mean the same thing on screen: it stopped, start it again. */
export type CastEndedReason = 'feed-evicted' | 'retune-abandoned' | 'retune-failed'

/** How a device on the account rendezvous describes itself. `deviceId` is a PICKER
 *  HANDLE, not a credential: it proves "some device of this account" and no more. */
export interface RemoteIdentity {
  deviceId: string
  label: string | null
  platform: string | null
  appVersion: string | null
}

/** …plus which end of the feature it runs. Only the peer list carries `role` — a
 *  `from` on a command is the peer's own message and has none. */
export interface RemotePeer extends RemoteIdentity {
  role: 'tv' | 'controller'
}

/** Why a remote command did not land.
 *
 *  'refused' = remote control is switched off there. 'unentitled' = its account cannot
 *  show that channel. 'unavailable' = it TOOK the command and could not carry it out —
 *  the catch-all, and never "nothing is broadcasting". 'timeout' = nothing came back,
 *  and it NEVER means the device declined. */
export type RemoteControlErrorCode =
  | 'malformed' | 'timeout' | 'version' | 'unauthorized'
  | 'refused' | 'unentitled' | 'unavailable' | 'unknown' | 'offline'

/** What a television reports it is doing. */
export type RemoteStatusState = 'playing' | 'paused' | 'stopped'

/**
 * A command this device was given (role 'tv'), or the state of a television this device
 * is pointed at (role 'controller').
 *
 * {state:'play'} IS A COMMAND, NOT A NOTIFICATION. The engine checked the channel
 * against this device's entitlements and deliberately did not tune it — so a
 * `restricted` channel still owes the viewer the same parental-PIN gate a local zap
 * goes through, and the host is what owes it.
 */
export interface RemoteInfo {
  role: 'tv' | 'controller'
  state: 'play' | 'stop' | 'refused' | 'status'
  streamId?: string
  /** state 'play': parental-gated — challenge before tuning. */
  restricted?: boolean
  title?: string
  command?: 'play' | 'stop'
  reason?: RemoteControlErrorCode | string
  /** The sender's own claim about itself. No `role` on it — see RemotePeer. */
  from?: RemoteIdentity
  status?: { streamId: string | null; state: RemoteStatusState; position: number | null }
}

/** Answer to startCast(). ok=false carries the engine's own sentence. */
export interface CastStartResult {
  ok: boolean
  session?: CastSessionInfo
  error?: string
  message?: string
}

/** Answer to remotePlay()/remoteStop(). See RemoteControlErrorCode before writing copy
 *  for `error` — three of those codes are routinely mistaken for each other. */
export interface RemoteCommandResult {
  ok: boolean
  error?: RemoteControlErrorCode | string
  message?: string
}

/** Answer to startRemote(). ok=false with no `error` usually means this build never
 *  asked for `remote: { control: true }` — which cannot be fixed at runtime. */
export interface RemoteStartResult {
  ok: boolean
  role?: 'tv' | 'controller'
  error?: string
  message?: string
}

export type BackendMessage =
  | { type: 'ready' }
  // provisional (cached warm start): a DISK CACHE of the last session's lineup, emitted
  // before any login so the menu can paint — a session does NOT exist yet, resolve()
  // fails until the real (non-provisional) push arrives and replaces it wholesale.
  | { type: 'streams'; streams: Stream[]; vod?: VodConfig; provisional?: boolean }
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
  // signinSaved: this device is holding a phone -> TV sign-in it can resume (the material
  // itself never crosses into the RN layer — this is a yes/no). Absent on worklet bundles
  // older than the field: treat as false, i.e. there is nothing to resume.
  // remoteAccept: the persisted "let my other devices change this television" switch —
  // null/absent = never set, so the join's default (accept) applies. Read it to PAINT the
  // toggle; do not pass it to startRemote(), which resolves it from the prefs file itself.
  | { type: 'prefs'; creds: SavedCredentials | null; favorites: string[]; smoothZapping?: boolean | null; language?: string | null; service?: SavedService | null; vodList?: VodListEntry[]; vodHistory?: VodHistoryEntry[]; parental?: { hide: boolean } | null; remoteAccept?: boolean | null; signinSaved?: boolean }
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
  // Answer to resumeSignIn(): did the stored sign-in put this device back in a session?
  | { type: 'signin-resumed'; ok: boolean; error?: ResumeSignInError; message?: string; retry?: boolean; tag?: string }
  // Answer to startCast(). `session.url` carries the session token, which is why the
  // whole `cast-` family skips the debug logger below.
  | { type: 'cast-started'; ok: boolean; session?: CastSessionInfo; error?: string; message?: string; tag?: string }
  // Answer to stopCast().
  | { type: 'cast-stopped'; ok: boolean; tag?: string }
  // The session ended ON ITS OWN — stop showing "Casting". stopCast() does not produce
  // this: the caller that asked for the stop already knows.
  | { type: 'cast-ended'; state: 'ended'; streamId: string; reason: CastEndedReason | string }
  // The account's own other devices on the rendezvous; re-sent on every change.
  | { type: 'remote-peers'; peers: RemotePeer[]; tag?: string }
  // Answer to startRemote().
  | { type: 'remote-started'; ok: boolean; role?: 'tv' | 'controller'; error?: string; message?: string; tag?: string }
  // Answer to remotePlay()/remoteStop().
  | { type: 'remote-ack'; ok: boolean; error?: RemoteControlErrorCode | string; message?: string; tag?: string }
  // A command this device was given, or a television's status. See RemoteInfo — a
  // {state:'play'} still owes a restricted channel its PIN gate.
  | ({ type: 'remote-info' } & RemoteInfo)

/**
 * The worklet asking THIS layer to use the platform key store on its behalf (Android
 * Keystore — see src/secure-key.ts). Internal: it is handled inside onData() and is
 * deliberately NOT part of BackendMessage, so it never reaches a host listener.
 *
 * `data` is the file key that seals the stored sign-in — 32 opaque bytes, base64. It is
 * not an account key (those stay in the worklet's heap) but it is still the one secret on
 * this channel, so nothing here may be logged.
 */
type VaultRequest = { type: 'vault-request'; op: 'wrap' | 'unwrap'; id: string; data: string }

// How long the two sign-in STARTS may take to answer. Both open the corestore, derive
// the code's rendezvous with Argon2id (~70 ms, more on a cold TV SoC) and join a DHT
// topic before they resolve, so this is deliberately generous — a viewer is watching a
// spinner where the code goes, and "nothing answered" must be the last resort.
const SIGNIN_START_MS = 20000
// …and how long a resume may take. Much longer than a start, because it is a whole login:
// the swarm has to find the panel, the account record has to replicate, and the panel runs
// proof-of-work and a signature check before it issues a token. The worklet gives up on
// its own waits first and answers 'offline', so this ceiling is only reached when the
// worklet itself is gone.
const SIGNIN_RESUME_MS = 45000
// …and the three one-word answers, which are in-memory calls on an exchange that is
// already running. Short: a slow one means the worklet is gone.
const SIGNIN_ACK_MS = 5000
// A cast start opens the feed (a cold DHT lookup on a channel that is not the one
// playing), pins it and binds a server. Sized like a first tune, not like a local call.
const CAST_START_MS = 30000
// A stop is local: close sockets, close the server, forget the token.
const CAST_STOP_MS = 5000
// Joining the rendezvous derives its key and joins a DHT topic.
const REMOTE_START_MS = 20000
// A command crosses to another device and waits for it to accept. The engine has its own
// (shorter) timeout underneath and answers 'timeout' itself, so this ceiling is only
// reached when the worklet is gone.
const REMOTE_CMD_MS = 20000

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
  /** Cross-device features this build may use (see RemoteFeatures). All are OFF by
   *  default and all are BOOT-TIME: by the time a runtime switch could be flipped the
   *  login has already happened, so the material is either retained or unrecoverable.
   *  `sendToTv` is required by sendSignIn() and by nothing else — receiving a sign-in
   *  on a TV needs no flag at all, though KEEPING one across a restart needs
   *  `keepSignIn`, which must be asked for by name. */
  remote?: RemoteFeatures
  /** console.log every backend message (dev instrumentation — shows in `adb logcat -s ReactNativeJS`). */
  debug?: boolean
}

export class AliranBackend {
  // Last entitlement list from the backend. Screens that mount AFTER login (e.g. a
  // home screen navigated to on {type:'streams'}) read this instead of missing the
  // one-shot message.
  streams: Stream[] = []
  /** True while `streams` is the PROVISIONAL disk cache (cached warm start): the menu
   *  may paint, but no session exists yet — resolve() fails until the real login's push
   *  clears this. A real push always wins; a provisional message never overwrites one. */
  provisional = false
  private streamsReal = false
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
  /**
   * "Play on my TV", the per-set take-over switch, as persisted (device-local, kept
   * across sign-out like the parental PIN). null = the viewer never chose, so a join
   * accepts. This is for PAINTING the Settings toggle and nothing else: startRemote()
   * reads the same preference out of the prefs file, which is the copy that cannot be
   * stale, so never pass this value back in as `acceptPlay`.
   */
  remoteAccept: boolean | null = null
  /**
   * This device is holding a phone -> TV sign-in it can resume — call resumeSignIn()
   * instead of showing the sign-in screen. A yes/no and nothing more: the key material
   * lives in the worklet, sealed under an Android Keystore key, and never crosses here.
   *
   * Only ever true on a build started with `remote: { keepSignIn: true }`.
   */
  signinSaved = false
  prefsLoaded = false
  /**
   * The engine has reported {type:'ready'} — it is on its panel and will take a login.
   *
   * Cached for the same reason `streams` and `signinTv` are: it is a ONE-SHOT message, so
   * a screen (or a whole RN root) that starts after it fired can never see it. Read this
   * at mount instead of waiting for a message that has already been and gone.
   */
  engineReady = false
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
  /**
   * The account's other devices on the rendezvous, latest push. Empty until
   * startRemote() joins one. Build a "send to" list from the peers whose `role` is
   * 'tv' — a play to anything else is refused 'unknown'.
   */
  remotes: RemotePeer[] = []
  /**
   * The live cast session, or null. Set by startCast(), cleared by stopCast() AND by
   * the session ending on its own ({type:'cast-ended'}) — so a sheet that re-mounts
   * reads the truth rather than a session that stopped while it was closed.
   *
   * HOLDS THE SESSION URL, which holds the token. Same rule as the sign-in fields
   * above: render what you need from `host`/`streamId`, log and serialize nothing.
   */
  castSession: CastSessionInfo | null = null

  private worklet: WorkletInstance | null = null
  // Whether worklet.start() has already run on THIS instance. See start()'s re-attach
  // branch — the worklet outlives the RN root, so a second start() is an ordinary event
  // and not a host mistake.
  private started = false
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
   *
   * SAFE TO CALL AGAIN, and on Android it WILL be called again. The engine outlives the
   * React root: Android recreates the ACTIVITY — leaving the app for the launcher and
   * coming back to it on a television, a locale or a display change — while the process,
   * the JS runtime and the Bare worklet inside it all survive. The RN root then re-runs,
   * the host boots the module singleton a second time, and the worklet refuses to start
   * twice ('Worklet has already been started'). Measured on a TCL Android TV set-top box.
   *
   * So a second call RE-ATTACHES instead of throwing — see reattach(), which is the half
   * that matters: an error swallowed here would leave the host waiting for a {type:'ready'}
   * that fired before its listener existed, which is the same wedge wearing a quieter face.
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
    if (this.started) { this.reattach(); return }
    const bytes = typeof bundle === 'string' ? b4a.from(bundle, 'base64') : bundle
    if (!this.worklet) {
      if (probeWorklet) { this.worklet = probeWorklet; probeWorklet = null } // reuse the probe's handle
      else this.worklet = new (require('react-native-bare-kit').Worklet as WorkletCtor)()
    }
    this.worklet.start('/app.bundle', bytes as any)
    // AFTER the start, so a start that threw for any OTHER reason is still retryable —
    // the flag says "this worklet is running", not "start() was attempted".
    this.started = true
    this.ipc = this.worklet.IPC
    this.ipc.on('data', (d: Uint8Array) => this.onData(b4a.toString(d)))
    if (opts.panelPubKey) this.connect(opts.panelPubKey)
    const queued = this.pending; this.pending = []
    for (const m of queued) this.send(m)
  }

  /**
   * A fresh React root over an engine that never stopped.
   *
   * WHAT IS NOT DONE HERE, AND WHY EACH ONE WOULD BE A BUG.
   *
   *   worklet.start()  is the throw this whole branch exists to avoid.
   *   ipc.on('data')   the handler wired by the first start() is still attached to the
   *                    same IPC stream. A second one would parse every line twice, so
   *                    every reply would fire its listeners twice and every tagged
   *                    request would resolve on its own duplicate.
   *   connect()        the engine is already on its panel. Sending {panelPubKey} again
   *                    re-runs the engine's _openPanel(): a second Hyperbee over the same
   *                    core, a second swarm join, and fresh catalog/EPG/grant watchers
   *                    that ORPHAN the live ones. Nothing about this is a reconnect.
   *
   * WHAT IS DONE is the state a listener created a moment ago has no way to learn,
   * because the engine reported it once and will not report it again:
   *
   *   ready    a single event per engine, and the one the host gates its screens on. This
   *            is the actual wedge: without it "Connecting…" is permanent and only a
   *            force-stop clears it.
   *   streams  the catalog this session already logged in for.
   *   prefs    NOT replayed but RE-READ. It is a local file the worklet owns, the read is
   *            cheap, and a host routes on `creds`/`service`/`signinSaved` — so the fresh
   *            answer is worth more than this layer's mirror of an older one.
   *
   * Delivered on a microtask, so a host that subscribes on the line after start() still
   * catches it. A host that subscribes later than that reads the same facts off
   * `engineReady` / `streams`, which is what they are cached for.
   */
  private reattach () {
    // Its OWN word, not a message type: this is state being handed back, and a log line
    // that said 'ready' would read as an engine event that never happened. It is also the
    // line somebody will grep for on a device — the failure it replaces was an error in
    // `adb logcat`, and silence would be a worse trade than a breadcrumb.
    if (this.debug) console.log('[backend]', `re-attach (ready=${this.engineReady}, streams=${this.streams.length})`)
    Promise.resolve().then(() => {
      if (this.engineReady) this.deliver({ type: 'ready' })
      if (this.streams.length > 0) this.deliver({ type: 'streams', streams: this.streams, ...(this.vod ? { vod: this.vod } : {}), ...(this.provisional ? { provisional: true } : {}) })
      this.requestPrefs()
    })
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

  /**
   * SIGN OUT: erase everything this device could sign itself back in with.
   *
   * Both of them, deliberately. The saved password is one way back in; a stored phone -> TV
   * sign-in is the other, and a "sign out" that left the second one behind would put a
   * television straight back into the account on its next start. So this clears the record
   * in the worklet AND destroys the Keystore key that record was sealed under — belt and
   * braces, because either one alone already makes the material unreadable, and a partial
   * failure of one must not leave a usable credential behind.
   */
  clearCredentials () {
    this.creds = null
    this.signinSaved = false
    this.send({ type: 'creds-clear' })
    secureReset().catch(() => {})
  }

  /**
   * Sign back in with the phone -> TV sign-in this device kept (see RemoteFeatures
   * `keepSignIn`). Call it INSTEAD of showing the sign-in screen when `signinSaved` is
   * true — on success 'streams' has already fired and the session is indistinguishable
   * from a typed login: this device's own id, its own panel-signed token.
   *
   * Resolves, never rejects. Retry only on `retry: true` ('offline' / 'timeout'); every
   * other failure means the worklet has already erased what it held and the device needs a
   * new handover from a phone.
   *
   * AND BUDGET THAT RETRY BY `logins`, NOT BY THE CLOCK. Read the field's own note: some of
   * these attempts reach the panel and some do not, the panel is counting the ones that do,
   * and a loop that cannot tell the difference walks a television into a lockout on the
   * account it is trying to restore.
   *
   * ONE OWNER OF THE OUTCOME. Do not run this beside a password login on the same screen.
   * Both end on the same {type:'streams'} message, and a host that lets two of them race
   * cannot tell which one won — which is how a failed attempt's state ends up persisted
   * against a session it did not create.
   */
  async resumeSignIn (): Promise<ResumeSignInResult> {
    const m = await this.request('signin-resumed', {
      type: 'signin-resume',
      // The same engine options the {panelPubKey} boot carries: a resume may have to
      // build the engine itself (the record knows its operator), and the engine that
      // comes out of it must be the one this build configured, not a bare default.
      ...this.engineOpts
    }, SIGNIN_RESUME_MS)
    // No `logins` on this one, and it must stay that way: the worklet has no timeout of its
    // own around signInWithKeys, so at this moment it may be inside one with a login already
    // counted by the panel. An absent cost is the honest answer, and the caller reads it as
    // "assume it paid".
    if (!m || m.type !== 'signin-resumed') return { ok: false, error: 'timeout', retry: true, message: 'the engine did not answer' }
    const { type, tag, ...result } = m // eslint-disable-line @typescript-eslint/no-unused-vars
    return result
  }
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
  /**
   * Forget the runtime service ("Change service…" — never affects a baked key).
   *
   * A kept phone -> TV sign-in belongs to the operator it was taken from, so leaving THIS
   * service also abandons it: the worklet erases the record in the same write, and the
   * Keystore key that sealed it is destroyed here, beside it. Before this, the record sat
   * on the disk of a device that had walked away from its operator until some later boot
   * happened to attempt a resume and notice.
   */
  clearService () {
    this.service = null
    this.signinSaved = false
    this.send({ type: 'service-clear' })
    secureReset().catch(() => {})
  }
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

  // --- "Send to TV" ------------------------------------------------------------
  //
  // TWO DIFFERENT THINGS, and a host that presents them as one will mislead a viewer.
  //
  //   startCast()   makes THIS DEVICE the origin server. A second HTTP server binds one
  //                 private address, the feed is pinned for the session, and a receiver
  //                 fetches every segment from here. So this device has to stay awake and
  //                 on the network, it is decrypting and serving the whole time, and the
  //                 media URL is reachable by anything that can read it off the receiver.
  //                 Works with any Chromecast; the host does the discovery.
  //
  //   remotePlay()  asks ANOTHER ALIRAN DEVICE on the same account to tune the channel
  //                 itself. It joins the swarm, it decrypts, it plays. This device sends
  //                 one message and can then be switched off. Nothing is served from
  //                 here and no URL exists to leak. Only works to a device running this
  //                 app, signed into this account, with remote control on.
  //
  // Where both are possible, the second is better in every dimension a viewer would care
  // about. Say so in the picker.

  /**
   * Serve a channel to a Cast receiver on this device's LAN.
   *
   * PASS `receiverHost` WHENEVER YOU KNOW IT. The engine cannot discover it — it does not
   * speak the Cast protocol — and without it the session serves any peer that can read
   * the media URL, which a receiver hands out to anything that joins its session. One
   * address, or an array. A multi-room GROUP fetches from EVERY member, so one address is
   * wrong for a group: pass all of them or none. An EMPTY array is refused rather than
   * treated as "unpinned" — omit the field for that.
   *
   * `advertiseHost` overrides the auto-detected LAN address (a Hyper-V/WSL bridge winning
   * the pick, or a device with no private address at all). The answer's `candidates` are
   * what to offer a viewer whose receiver cannot reach the address that was chosen.
   *
   * Never rejects: the failures are all worth a sentence on a screen.
   */
  async startCast (streamId: string, opts: { receiverHost?: string | string[]; advertiseHost?: string } = {}): Promise<CastStartResult> {
    const m = await this.request('cast-started', {
      type: 'cast-start',
      streamId,
      ...(opts.receiverHost != null ? { receiverHost: opts.receiverHost } : {}),
      ...(opts.advertiseHost ? { advertiseHost: opts.advertiseHost } : {})
    }, CAST_START_MS)
    if (!m || m.type !== 'cast-started') return { ok: false, error: 'timeout', message: 'the engine did not answer' }
    if (m.ok && m.session) this.castSession = m.session
    return { ok: m.ok, session: m.session, error: m.error, message: m.message }
  }

  /** End the cast session — sockets hung up, server closed, token dead. Idempotent, and
   *  it does NOT produce a {type:'cast-ended'}: that message is only ever the session
   *  stopping by itself. */
  async stopCast (): Promise<boolean> {
    const m = await this.request('cast-stopped', { type: 'cast-stop' }, CAST_STOP_MS)
    // Cleared whatever came back. A stop that timed out has still left the host with no
    // way to reach the session, and a UI still showing "Casting" over a dead server is
    // worse than one that stopped a beat early.
    this.castSession = null
    return !!m && m.type === 'cast-stopped' && m.ok === true
  }

  /**
   * Join the account rendezvous — the channel this device's other devices meet on.
   * 'tv' announces itself and accepts commands; 'controller' looks up and sends them.
   *
   * Needs a live session AND a build constructed with `remote: { control: true }`. The
   * second is boot-time only: a false answer on a build that never asked for it is not
   * retryable, and no amount of waiting changes it.
   */
  async startRemote (opts: { role: 'tv' | 'controller'; label?: string; acceptPlay?: boolean }): Promise<RemoteStartResult> {
    const m = await this.request('remote-started', {
      type: 'remote-start',
      role: opts.role,
      ...(opts.label ? { label: opts.label } : {}),
      ...(typeof opts.acceptPlay === 'boolean' ? { acceptPlay: opts.acceptPlay } : {})
    }, REMOTE_START_MS)
    if (!m || m.type !== 'remote-started') return { ok: false, error: 'timeout', message: 'the engine did not answer' }
    return { ok: m.ok, role: m.role, error: m.error, message: m.message }
  }

  /** Leave the rendezvous. Idempotent. */
  stopRemote () { this.send({ type: 'remote-leave' }) }

  /** Ask the worklet to re-send the peer list (it also arrives unprompted on every
   *  change). For a picker that mounted between two pushes. */
  refreshRemotes () { this.send({ type: 'remote-list' }) }

  /**
   * Controller role. Ask a TELEVISION to play a channel. ok=true means it ACCEPTED —
   * it checked its own entitlements and told its host to tune. What then happened
   * arrives as a status push on {type:'remote-info'}.
   *
   * Read `error` before writing the message: 'timeout' NEVER means the device declined,
   * and 'unavailable' is the catch-all, not "nothing is broadcasting".
   */
  async remotePlay (deviceId: string, streamId: string): Promise<RemoteCommandResult> {
    return this.remoteCommand({ type: 'remote-cmd', cmd: 'play', deviceId, streamId })
  }

  /** Controller role. Ask that device to stop. */
  async remoteStop (deviceId: string): Promise<RemoteCommandResult> {
    return this.remoteCommand({ type: 'remote-cmd', cmd: 'stop', deviceId })
  }

  private async remoteCommand (body: Record<string, unknown>): Promise<RemoteCommandResult> {
    const m = await this.request('remote-ack', body, REMOTE_CMD_MS)
    if (!m || m.type !== 'remote-ack') return { ok: false, error: 'timeout', message: 'the engine did not answer' }
    return { ok: m.ok, error: m.error, message: m.message }
  }

  /**
   * TV role. The take-over switch: off refuses play AND stop.
   *
   * PERSISTED, and that is what makes it a mitigation rather than a mood. The worklet
   * writes it beside the parental PIN and every later join reads it back, so a set left
   * switched off comes back switched off — a toggle backed only by module state would read
   * "off" to the viewer and be on again at the next cold boot. It applies to the RUNNING
   * session too, so a viewer who switches it off mid-evening is not waiting for a reboot.
   *
   * `remoteAccept` is NOT written optimistically here, unlike every other prefs mirror on
   * this object. The worklet updates it on the 'prefs' reply it sends once the preference
   * is on disk, and sends nothing if the write failed — so a screen bound to that field
   * shows what a reboot would restore, which for this one switch is the only honest thing
   * it can show. A toggle that sprang to "off" over a failed write would be the exact
   * mitigation-that-lies this switch exists to avoid.
   */
  setRemoteAccept (ok: boolean) { this.send({ type: 'remote-accept', ok }) }

  /** TV role. The two things only a HOST knows — paused, and the playhead. The engine
   *  already publishes the channel and whether it is playing. */
  updateRemoteStatus (status: { state?: RemoteStatusState; position?: number }) {
    this.send({ type: 'remote-status', ...status })
  }

  /** Subscribe to the peer list. Fires with the CURRENT list right away, so a picker
   *  never paints an empty section it has no reason for. Returns the unsubscribe. */
  onRemotes (fn: (peers: RemotePeer[]) => void) {
    const off = this.onMessage((m) => { if (m.type === 'remote-peers') fn(m.peers || []) })
    fn(this.remotes)
    return off
  }

  /** Subscribe to commands and status pushes ({type:'remote-info'}). */
  onRemote (fn: (info: RemoteInfo) => void) {
    return this.onMessage((m) => {
      if (m.type !== 'remote-info') return
      const { type, ...info } = m // eslint-disable-line @typescript-eslint/no-unused-vars
      fn(info)
    })
  }

  /** Subscribe to a cast session ending ON ITS OWN. Not fired by stopCast(). */
  onCastEnded (fn: (info: { streamId: string; reason: CastEndedReason | string }) => void) {
    return this.onMessage((m) => { if (m.type === 'cast-ended') fn({ streamId: m.streamId, reason: m.reason }) })
  }

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
        const msg = JSON.parse(line) as BackendMessage | VaultRequest
        // NEVER log the raw line for these three families, whatever its length:
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
        //   vault-*   carries the file key that seals a stored sign-in. Not an account key
        //             — those never leave the worklet — but it is the one thing on this
        //             channel that would let a reader of the log open the record beside it.
        //   cast-*    carries the cast session URL, and the URL carries the session
        //             token. It is not the boundary a shared network keeps — a receiver
        //             reads it back to any peer that joins its session — but printing it
        //             into `adb logcat` hands it to anything on the DEVICE as well, and
        //             this app ships debug:true in release builds. Excluded as a FAMILY,
        //             like the two above: {type:'cast-ended'} carries no URL at all and
        //             still wears the prefix, because the alternative is a list somebody
        //             has to remember to add to.
        //   remote-info
        //             is not a credential and is treated like one anyway: it carries the
        //             channel TITLE a television was told to play and, on a `play`,
        //             whether that channel is parental-restricted. That is a viewing
        //             record — of somebody else's household set, named by a device that
        //             is not this one — and it is short enough to fall under the raw-line
        //             rule below, so without this it prints in full. The rest of the
        //             `remote-` family stays visible: a peer list is picker handles and
        //             labels, and it is the first thing to look at when a television will
        //             not appear.
        //
        // Everything else: long lines collapse to their type to keep the log readable —
        // EXCEPT 'error', where the payload (often a worklet stack trace) is the only
        // diagnostic there is.
        if (this.debug) {
          const secret = msg.type === 'prefs' || msg.type === 'remote-info' ||
            (typeof msg.type === 'string' && (msg.type.startsWith('signin-') || msg.type.startsWith('vault-') || msg.type.startsWith('cast-')))
          console.log('[backend]', secret ? msg.type : msg.type === 'error' || line.length <= 200 ? line : msg.type)
        }
        // Handled HERE and never relayed: the worklet is asking this layer to use the
        // platform key store, and no host listener has any business seeing the file key
        // that goes with it.
        if (msg.type === 'vault-request') { this.onVaultRequest(msg); continue }
        // One event per engine. Latched so a React root that starts after it — an Android
        // activity restart over a live worklet — can still be told; see reattach().
        if (msg.type === 'ready') this.engineReady = true
        if (msg.type === 'prefs') { this.creds = msg.creds; this.favorites = msg.favorites || []; this.smoothZapping = msg.smoothZapping ?? null; this.language = msg.language ?? null; this.service = msg.service ?? null; this.vodList = msg.vodList || []; this.vodHistory = msg.vodHistory || []; this.parental = msg.parental ?? null; this.remoteAccept = msg.remoteAccept ?? null; this.signinSaved = msg.signinSaved === true; this.prefsLoaded = true }
        if (msg.type === 'streams') {
          // A provisional (cached) lineup must never overwrite a real session's — the
          // worklet guards this ordering too, but a reattach replay makes it reachable.
          if (msg.provisional && this.streamsReal) continue
          this.streams = msg.streams
          this.vod = msg.vod ?? null
          this.provisional = msg.provisional === true
          if (!msg.provisional) this.streamsReal = true
        }
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
        if (msg.type === 'remote-peers') this.remotes = msg.peers || []
        // The session stopped by itself (the feed was evicted, or a retune closed it).
        // Clearing here is what keeps a re-mounting sheet from painting "Casting" over a
        // server that is already closed and a token that is already dead.
        if (msg.type === 'cast-ended') this.castSession = null
        this.deliver(msg as BackendMessage)
      } catch { /* ignore partial/invalid */ }
    }
  }

  /** Hand one message to every host listener. The single delivery path, so a REPLAYED
   *  message (reattach) reaches a host exactly the way the engine's own does. */
  private deliver (msg: BackendMessage) {
    this.listeners.forEach(fn => fn(msg))
  }

  /**
   * The worklet cannot reach the Android Keystore — it is a Bare runtime with no bridge to
   * the native modules — so this layer performs the wrap/unwrap on its behalf and sends
   * the result straight back. That is the whole reason this hop exists.
   *
   * ALWAYS ANSWERS. The worklet is blocked on the reply with a timeout of its own, and a
   * dropped answer would leave a television sitting on a splash screen.
   *
   * AND IT ANSWERS WITH THE REASON. A failure carries `code` (secure-key.ts SecureKeyError)
   * because the worklet's response to an unwrap that cannot be done is to ERASE the account
   * the television is holding — and only two of the codes are evidence that erasing is
   * right. A bare ok:false, which is what this hop used to send, made a key store that was
   * busy for a moment at cold boot look exactly like a key that is gone for good.
   */
  private onVaultRequest (msg: VaultRequest) {
    const done = (r: SecureKeyResult) => this.send(r.ok
      ? { type: 'vault-reply', id: msg.id, ok: true, data: r.data }
      : { type: 'vault-reply', id: msg.id, ok: false, code: r.code })
    const run: Promise<SecureKeyResult> = msg.op === 'wrap'
      ? secureWrap(msg.data)
      : msg.op === 'unwrap'
        ? secureUnwrap(msg.data)
        // A wrap/unwrap this build does not implement. Not a key-store failure, and
        // certainly not proof that anything on disk is unreadable.
        : Promise.resolve({ ok: false, code: 'unknown' } as SecureKeyResult)
    run.then(done).catch(() => done({ ok: false, code: 'unknown' }))
  }
}
