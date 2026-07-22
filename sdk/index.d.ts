// Type definitions for @aliran/player-sdk (Node entry — index.js).
// Hand-maintained: keep in sync with player.js/login.js/recover.js and with the
// JSON-safe mirror types in sdk/react-native/src/backend.ts.

/** One entry of the display list: catalog metadata only — stream keys stay inside the engine. */
export interface Stream {
  id: string
  title?: string
  description?: string
  category?: string[]
  isLive?: boolean
  /** Panel curation hint: rail/list sort key (lower first; null/absent sorts last). */
  order?: number | null
  /** Panel curation hint: featured stream (hero / menu wallpaper pick). */
  featured?: boolean
  /** Localhost URL (P2P-served art) or absolute https URL (hybrid art passthrough). */
  poster?: string
  backdrop?: string
  logo?: string
  /** Public https JSON feed with this channel's program schedule (fetch on demand). */
  epgUrl?: string
  /** This channel's id INSIDE the epgUrl feed (matches feed `channels[].id`). */
  epgId?: string
}

/**
 * Hybrid CDN<->P2P engine config. NOT a product path — the shipped CDN mechanism is
 * redirect channels (see README). Retained for test harnesses; leave unset
 * (default 'p2p-only') in applications.
 */
export interface HybridConfig {
  mode?: 'p2p-only' | 'hybrid' | 'cdn-only'
  start?: 'preferP2P' | 'preferCDN'
  /** Template string ('{streamId}' substituted) or function. Required unless mode 'p2p-only'. */
  cdnUrl?: string | ((streamId: string) => string)
  readyTimeoutMs?: number
  rebufferMsToFallback?: number
  probeIntervalMs?: number
}

/** Tune self-heal knobs (p2p-only): timeout -> evict + retry -> peer teardown -> friendly error. */
export interface TuneConfig {
  timeoutMs?: number
  relookupMinMs?: number
  relookupMaxMs?: number
}

/** Adjacent-channel warm prefetch ("Smooth zapping"). Costs standing bandwidth — off by default. */
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

/** Tuning for the engine's single Hyperswarm. Ordinary viewers omit this. */
export interface SwarmConfig {
  /** Total-connection budget (lib default 64) — raise on seed nodes / repeater-style hosts. */
  maxPeers?: number
  /** Custom DHT bootstrap nodes (local testnets / private DHT). Omit for the public DHT. */
  bootstrap?: Array<{ host: string; port: number }>
  /** UDP receive-buffer request in MiB (default 2 — a viewer is download-dominant, so
   *  fan-in absorbs into the receive side). 0 leaves the OS/udx default. Mirrors the
   *  servers' SWARM_RCVBUF_MB. Best-effort; the outcome is emitted as a 'status'
   *  event with state 'net:tuned'. */
  rcvbufMb?: number
  /** UDP send-buffer request in MiB (default 0 = untouched — viewer reseed upload is
   *  opportunistic; raise on SDK-based seed nodes). Mirrors SWARM_SNDBUF_MB. */
  sndbufMb?: number
}

/**
 * 'reseed' (default): blocks this viewer replicated are served back to other viewers.
 * 'client-only': join topics unannounced — practically zero viewer-to-viewer upload.
 */
export type UploadPolicy = 'reseed' | 'client-only'

export interface PlayerOptions {
  /** Panel public key (hex) — may instead be passed to connect(). */
  panelPubKey?: string
  /** Disposable replica cache directory (default './aliran-store'). */
  storeDir?: string
  hybrid?: HybridConfig
  /** Warm entitled feeds after login: false (default) | true (all) | integer cap. */
  prewarm?: boolean | number
  tune?: TuneConfig
  zapPrefetch?: boolean | ZapPrefetchConfig
  swarm?: SwarmConfig
  uploadPolicy?: UploadPolicy
}

/** AliranPlayer constructor options: PlayerOptions + injected runtime modules. */
export interface AliranPlayerOptions extends PlayerOptions {
  /** node:http (Node) or bare-http1 (Bare). createPlayer() wires this for you. */
  http: unknown
  /** node:fs (Node) or bare-fs (Bare). createPlayer() wires this for you. */
  fs: unknown
}

export interface ResolveResult {
  /** What to play NOW: localhost URL (p2p) or remote URL (cdn / redirect channel). */
  url: string
  source: 'p2p' | 'cdn'
  /** Localhost HLS URL — undefined for redirect channels (no local serving at all). */
  localUrl?: string
  /** Localhost server port — undefined for redirect channels. */
  port?: number
  /** Current feed key (hex) — null for redirect channels. */
  feedKey: string | null
}

export interface SourceInfo {
  streamId: string
  source: 'p2p' | 'cdn' | null
  url: string | null
}

export interface PlayerEvents {
  /** connect() joined the panel topic. */
  ready: []
  /** Display list — at login, and re-emitted LIVE on panel catalog edits. */
  streams: [streams: Stream[]]
  status: [status: { state: 'feed:open' | 'feed:ready' | 'feed:retune' | 'feed:reconnect' }]
  /** Peer count of the served feed, every 3 s while serving. */
  peers: [count: number]
  /** Corrupt store purged + operation retried (argument = the corruption error). */
  recovered: [err: Error]
  error: [err: Error]
  /** Hybrid mode only: switched to the CDN URL. */
  fallback: [info: { streamId: string; url: string; reason: 'timeout' | 'stall' }]
  /** Hybrid mode only: active source changed. */
  'source-changed': [info: { streamId: string; source: 'p2p' | 'cdn'; url: string }]
  /** Watched stream's feedKey rotated; served feed swapped behind the SAME url — reload the player. */
  'feed-changed': [info: { streamId: string; feedKey: string; url: string }]
  /** Smooth-zapping lifecycle: {enabled} echoes a toggle; {state,reason} the adaptive gate. */
  'zap-prefetch': [info: { enabled?: boolean; state?: 'suspended' | 'resumed'; reason?: 'metered' | 'stall' | 'thin' }]
  /** setUploadPolicy() applied: how many topic joins were flipped live. */
  'upload-policy': [info: { policy: UploadPolicy; rejoined: number }]
}

/**
 * Headless Aliran player engine. Runtime-agnostic core — construct directly only when
 * injecting { http, fs } yourself (e.g. a Bare worklet); in Node use createPlayer().
 * The event emitter never throws on unhandled 'error'.
 */
export class AliranPlayer {
  constructor(opts: AliranPlayerOptions)

  on<E extends keyof PlayerEvents>(name: E, fn: (...args: PlayerEvents[E]) => void): this
  off<E extends keyof PlayerEvents>(name: E, fn: (...args: PlayerEvents[E]) => void): this
  once<E extends keyof PlayerEvents>(name: E, fn: (...args: PlayerEvents[E]) => void): this
  emit<E extends keyof PlayerEvents>(name: E, ...args: PlayerEvents[E]): boolean

  /** Join the panel topic + replicate its signed DB. Emits 'ready'. */
  connect(panelPubKey?: string): Promise<void>
  /**
   * OPRF login (no plaintext password leaves the process). Resolves to the display
   * list. Throws 'not connected to panel' while the swarm is still dialing: retry.
   */
  login(username: string, password: string): Promise<Stream[]>
  /** Last display list. */
  listStreams(): Stream[]
  /** Replicate + serve an entitled stream; redirect channels return their remote URL. */
  resolve(streamId: string): Promise<ResolveResult>
  /** Active source of the last resolve(), or null. */
  source(): SourceInfo | null
  /** Low-level direct-play by raw keys (no login). Resolves to the localhost port. */
  serveFeed(feedKeyHex: string, encKeyHex: string): Promise<number>
  /** Catalog art path -> localhost URL (absolute http(s) URLs pass through). */
  assetUrl(path: string): string | undefined
  /** Warm entitled feeds' DHT topics now (also runs after login when opted in). */
  prewarm(): Promise<void>
  /** Runtime "Smooth zapping" switch; applies mid-play. */
  setZapPrefetch(v: boolean | ZapPrefetchConfig): void
  /** Host network hint: expensive/metered suspends the zap-prefetch warm loop. */
  setNetworkProfile(profile: { expensive?: boolean }): void
  /** Live upload-policy switch: re-joins topics with the new flag, drops reseed connections. */
  setUploadPolicy(policy: UploadPolicy): Promise<{ policy: UploadPolicy; changed: boolean; rejoined: number }>
  /** Tear down wedged peer connections of the active feed and dial fresh. */
  reconnectActiveFeed(): number
  /** Full teardown. */
  stop(): Promise<void>
}

/** Node entry point: AliranPlayer with node:http/node:fs wired in. */
export function createPlayer(opts?: PlayerOptions): AliranPlayer

// --- login.js (lower-level building blocks; the engine calls these for you) ---

export interface LoginResult {
  streams: Stream[]
  token: string
  expiresAt: number
  deviceId: string
  tokenVersion: number
}

export interface SessionPayload {
  userId: string
  deviceId: string
  tokenVersion?: number
  expiresAt?: number
  [key: string]: unknown
}

/** Wrap a panel socket in the RPC client the login protocol uses. */
export function panelClient(socket: unknown): unknown

/** Run the OPRF login protocol against a panel RPC + replicated DB. */
export function login(
  call: unknown,
  db: unknown,
  username: string,
  password: string,
  opts?: { deviceId?: string; deviceLabel?: string }
): Promise<LoginResult>

/** Offline check: valid panel signature + not expired. Returns the payload or null. */
export function checkSession(panelPublicKey: string | Uint8Array, token: string, now?: number): SessionPayload | null

/** Online companion: device still enrolled with a matching tokenVersion. */
export function sessionLive(db: unknown, payload: SessionPayload | null, now?: number): Promise<boolean>

// --- recover.js (store-corruption recovery) ---

/** True for known store-corruption shapes (EPARTIALREAD, OPLOG_CORRUPT, ...). */
export function isCorruptionError(err: unknown): boolean

/** Run op; on corruption purge() once and retry. Other failures propagate unchanged. */
export function withRecovery<T>(
  op: () => Promise<T> | T,
  purge: (err: Error) => Promise<void> | void,
  onRecover?: (err: Error) => void
): Promise<T>
