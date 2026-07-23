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
  /** EPG feed URL (S27): a public https JSON of channels+schedules the app fetches
   *  on demand for this channel's program guide. Set on source-imported channels. */
  epgUrl?: string
  /** This channel's id INSIDE the epgUrl feed (matches feed `channels[].id`). */
  epgId?: string
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

export type BackendMessage =
  | { type: 'ready' }
  | { type: 'streams'; streams: Stream[] }
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
  | { type: 'prefs'; creds: SavedCredentials | null; favorites: string[]; smoothZapping?: boolean | null; service?: SavedService | null }

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
  /** console.log every backend message (dev instrumentation — shows in `adb logcat -s ReactNativeJS`). */
  debug?: boolean
}

export class AliranBackend {
  // Last entitlement list from the backend. Screens that mount AFTER login (e.g. a
  // home screen navigated to on {type:'streams'}) read this instead of missing the
  // one-shot message.
  streams: Stream[] = []
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
    this.engineOpts = { hybrid: opts.hybrid, prewarm: opts.prewarm, tune: opts.tune, zapPrefetch: opts.zapPrefetch, swarm: opts.swarm, uploadPolicy: opts.uploadPolicy }
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

  /** Ask the worklet for saved credentials + favorites; answers as {type:'prefs'}. */
  requestPrefs () { this.send({ type: 'prefs-get' }) }
  /** Persist "remember me" credentials (device-local; sign-out clears them). */
  saveCredentials (username: string, password: string) { this.send({ type: 'creds-save', username, password }) }
  clearCredentials () { this.creds = null; this.send({ type: 'creds-clear' }) }
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
        if (msg.type === 'prefs') { this.creds = msg.creds; this.favorites = msg.favorites || []; this.smoothZapping = msg.smoothZapping ?? null; this.service = msg.service ?? null; this.prefsLoaded = true }
        if (msg.type === 'streams') this.streams = msg.streams
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
