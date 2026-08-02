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
  | { type: 'port'; port?: number; url?: string; source?: 'p2p' | 'cdn'; streamId?: string; recordType?: 'live' | 'vod'; durationSec?: number | null }
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
  | { type: 'prefs'; creds: SavedCredentials | null; favorites: string[]; smoothZapping?: boolean | null; service?: SavedService | null; vodList?: VodListEntry[]; vodHistory?: VodHistoryEntry[]; parental?: { hide: boolean } | null }
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
  // Device-local prefs mirrored from the worklet (see client/backend/backend.mjs):
  // saved "remember me" credentials + favorite stream ids. `prefsLoaded` flips on the
  // first {type:'prefs'} reply — request with requestPrefs().
  creds: SavedCredentials | null = null
  favorites: string[] = []
  /** Persisted "Smooth zapping" choice; null until the user first sets the toggle. */
  smoothZapping: boolean | null = null
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
        // Never log the raw 'prefs' line — it can carry the saved password.
        if (this.debug) console.log('[backend]', msg.type === 'prefs' || line.length > 200 ? msg.type : line)
        if (msg.type === 'prefs') { this.creds = msg.creds; this.favorites = msg.favorites || []; this.smoothZapping = msg.smoothZapping ?? null; this.service = msg.service ?? null; this.vodList = msg.vodList || []; this.vodHistory = msg.vodHistory || []; this.parental = msg.parental ?? null; this.prefsLoaded = true }
        if (msg.type === 'streams') { this.streams = msg.streams; this.vod = msg.vod ?? null }
        if (msg.type === 'port') {
          this.port = msg.port ?? null
          this.url = msg.url ?? (msg.port ? `http://127.0.0.1:${msg.port}/index.m3u8` : null)
          this.source = msg.source ?? (this.url ? 'p2p' : null)
          if (msg.streamId) this.activeStreamId = msg.streamId
          this.recordType = msg.recordType ?? null
          this.durationSec = msg.durationSec ?? null
        }
        if (msg.type === 'fallback') { this.url = msg.url; this.source = 'cdn' }
        if (msg.type === 'source-changed') { this.url = msg.url; this.source = msg.source }
        if (msg.type === 'feed-changed') this.url = msg.url // unchanged localhost URL; the source (p2p) is unchanged too
        this.listeners.forEach(fn => fn(msg))
      } catch { /* ignore partial/invalid */ }
    }
  }
}
