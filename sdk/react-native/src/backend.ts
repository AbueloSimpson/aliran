// AliranBackend — hosts the Aliran engine in a Bare worklet and speaks its IPC
// protocol (line-delimited JSON; see client/backend/backend.mjs). The host app
// supplies the worklet bundle (bare-pack output, base64 string or raw bytes) — the
// binding stays free of build-time coupling to any one backend build.

import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'

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
// bitrate while playing). true = { neighbors: 1, intervalMs: 3000 }.
export interface ZapPrefetchConfig {
  neighbors?: number
  intervalMs?: number
}

// Tuning for the engine's single Hyperswarm (see sdk/player.js normalizeSwarmOpts).
// maxPeers raises hyperswarm's total-connection budget (lib default 64) — for
// SDK-based seed nodes / repeater-style hosts that hold big fan-out. Ordinary
// viewers should omit it.
export interface SwarmConfig {
  maxPeers?: number
}

export interface SavedCredentials { username: string; password: string }

export type BackendMessage =
  | { type: 'ready' }
  | { type: 'streams'; streams: Stream[] }
  | { type: 'login-error'; message: string }
  // streamId names the stream this play() reply is for (absent on dev direct-play and
  // on worklet bundles older than the field) — <AliranVideo> uses it to tell "the served
  // channel just CHANGED under the shared localhost URL" (remount) from a re-resolve of
  // the channel already playing (keep the mount).
  | { type: 'port'; port?: number; url?: string; source?: 'p2p' | 'cdn'; streamId?: string }
  | { type: 'status'; peers?: number; state?: string; message?: string }
  | { type: 'error'; message: string }
  | { type: 'fallback'; streamId: string; url: string; reason: 'timeout' | 'stall' }
  | { type: 'source-changed'; streamId: string; source: 'p2p' | 'cdn'; url: string }
  // The active stream's feedKey rotated underneath the viewer (broadcaster source change /
  // RAM restart); the engine re-resolved and swapped the served feed. url is the unchanged
  // localhost URL — remount the player to flush the stale playlist. See sdk/player.js.
  | { type: 'feed-changed'; streamId: string; feedKey: string; url: string }
  | { type: 'prefs'; creds: SavedCredentials | null; favorites: string[] }

export interface StartOptions {
  panelPubKey: string
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
  // Device-local prefs mirrored from the worklet (see client/backend/backend.mjs):
  // saved "remember me" credentials + favorite stream ids. `prefsLoaded` flips on the
  // first {type:'prefs'} reply — request with requestPrefs().
  creds: SavedCredentials | null = null
  favorites: string[] = []
  prefsLoaded = false

  private worklet = new Worklet()
  private ipc: any
  private buf = ''
  private debug = false
  private listeners = new Set<(m: BackendMessage) => void>()
  // Messages sent before start() wires the IPC stream (e.g. a splash screen asking
  // for prefs while the host is still booting the worklet) queue up and flush then.
  private pending: unknown[] = []

  /**
   * Boot the worklet with a bare-pack bundle (base64 string or raw bytes) and connect
   * to the panel. Bytes are passed via startBytes so the binary bundle is preserved
   * intact; the filename extension must be `.bundle`.
   */
  start (bundle: string | Uint8Array, opts: StartOptions) {
    this.debug = !!opts.debug
    const bytes = typeof bundle === 'string' ? b4a.from(bundle, 'base64') : bundle
    this.worklet.start('/app.bundle', bytes as any)
    this.ipc = this.worklet.IPC
    this.ipc.on('data', (d: Uint8Array) => this.onData(b4a.toString(d)))
    this.send({ panelPubKey: opts.panelPubKey, hybrid: opts.hybrid, prewarm: opts.prewarm, tune: opts.tune, zapPrefetch: opts.zapPrefetch, swarm: opts.swarm })
    const queued = this.pending; this.pending = []
    for (const m of queued) this.send(m)
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

  /** Ask the worklet for saved credentials + favorites; answers as {type:'prefs'}. */
  requestPrefs () { this.send({ type: 'prefs-get' }) }
  /** Persist "remember me" credentials (device-local; sign-out clears them). */
  saveCredentials (username: string, password: string) { this.send({ type: 'creds-save', username, password }) }
  clearCredentials () { this.creds = null; this.send({ type: 'creds-clear' }) }
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
        if (msg.type === 'prefs') { this.creds = msg.creds; this.favorites = msg.favorites || []; this.prefsLoaded = true }
        if (msg.type === 'streams') this.streams = msg.streams
        if (msg.type === 'port') {
          this.port = msg.port ?? null
          this.url = msg.url ?? (msg.port ? `http://127.0.0.1:${msg.port}/index.m3u8` : null)
          this.source = msg.source ?? (this.url ? 'p2p' : null)
          if (msg.streamId) this.activeStreamId = msg.streamId
        }
        if (msg.type === 'fallback') { this.url = msg.url; this.source = 'cdn' }
        if (msg.type === 'source-changed') { this.url = msg.url; this.source = msg.source }
        if (msg.type === 'feed-changed') this.url = msg.url // unchanged localhost URL; the source (p2p) is unchanged too
        this.listeners.forEach(fn => fn(msg))
      } catch { /* ignore partial/invalid */ }
    }
  }
}
