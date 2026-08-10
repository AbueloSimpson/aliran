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
  /** Access control: PIN-gate this channel (parental control); hide it while no PIN is set. */
  restricted?: boolean
  /** Localhost URL (P2P-served art) or absolute https URL (hybrid art passthrough). */
  poster?: string
  backdrop?: string
  logo?: string
  /** Public https JSON feed with this channel's program schedule (fetch on demand). */
  epgUrl?: string
  /** This channel's id INSIDE the epgUrl feed (matches feed `channels[].id`). */
  epgId?: string
  /**
   * Record class (S8a): 'vod' = an on-demand library title (show seek/pause UI, no
   * live-edge machinery — isLive does not apply); 'live' (or absent on old records).
   */
  type?: 'live' | 'vod'
  /** Title duration in seconds — vod records only. */
  durationSec?: number | null
  /** Catalog status ('live'/'idle'; vod: 'available'/'unavailable' — gray out the latter). */
  status?: string
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
  /**
   * Post-tune zero-peer rescan: how long the ACTIVE live p2p feed may hold zero
   * peers before the engine forces a fresh DHT lookup and re-arms the tune
   * watchdog (status 'feed:rescan'). Default 10000; 0 disables.
   */
  rescanMs?: number
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

/**
 * Which cross-device features this BUILD may use. Both default to false, and both are
 * construction-time only because both change what a login RETAINS for the whole session.
 *
 *   sendToTv  the phone half of "send to TV". On, every login keeps the account's two
 *             private keys in memory (sendSignIn cannot recover them later without the
 *             password). Off, they never leave login()'s own scope. Required by
 *             sendSignIn(); receiving a sign-in needs nothing here.
 *   control   the account rendezvous secret (remoteSecret on the login result). Not a key
 *             — it cannot sign a session or open a stream — but it authenticates this
 *             device to the account's other devices and is a stable account correlator
 *             until "log out all devices".
 *
 * `remote: true` enables all of them.
 */
export interface RemoteFeatures {
  sendToTv?: boolean
  control?: boolean
}

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
  /** Cross-device features this build may use. Off by default — see RemoteFeatures. */
  remote?: boolean | RemoteFeatures
  /**
   * Per-install device id (hex/short string) sent at login. Without one every install
   * of an account collapses onto a single derived fallback id, so device limits and
   * per-device revocation cannot tell them apart. Hosts should generate 8 random bytes
   * once and persist them beside their prefs.
   */
  deviceId?: string
  /** Human-readable device name shown in the panel's device list. */
  deviceLabel?: string
  /** Host app version attached to problem reports (e.g. '0.2.0'). */
  appVersion?: string
  /** Host platform attached to problem reports (e.g. 'windows', 'android 33'). */
  platform?: string
}

/** The seven wire categories a viewer problem report may carry (see report.js). */
export type ReportCategory =
  | 'no-audio'
  | 'black-screen'
  | 'visual-artifacts'
  | 'buffering'
  | 'wrong-content'
  | 'login'
  | 'other'

/** Result of AliranPlayer.report() — never a rejection, always one of these. */
export type ReportResult =
  | { ok: true; id?: string; count?: number; collapsed?: boolean; shed?: boolean }
  | {
      ok?: false
      error:
        | 'bad-category'
        | 'not-logged-in'
        | 'offline'
        | 'cooldown'
        | 'locked'
        | 'unsupported'
        | 'unauthorized'
        | 'expired'
        | string
      /** Seconds to wait, on 'cooldown' and 'locked'. */
      retryAfter?: number
      detail?: string
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
  /**
   * Record class of what resolved (S8a). 'vod': the url is a finished VOD playlist —
   * seek freely (Range-served), pause indefinitely, and expect NO live self-heal
   * events for it (no feed:retune/'feed-changed'; a stalled download is the host
   * player's to surface, with reconnectActiveFeed() as the manual redial).
   */
  type: 'live' | 'vod'
  /** Title duration in seconds (vod; null when the catalog lacks it) — undefined for live. */
  durationSec?: number | null
  /**
   * HTTP request headers the HOST PLAYER must send with `url`: redirect channels
   * whose provider hotlink-checks Referer / Origin / User-Agent serve a 403 without
   * them. Lowercase keys. Undefined everywhere else (p2p localhost serving, cdn
   * templates) — the headers belong to the provider's url, not to playback.
   */
  headers?: Record<string, string>
}

export interface SourceInfo {
  streamId: string
  source: 'p2p' | 'cdn' | null
  url: string | null
}

// --- OTA app updates (the panel's updates drive, meta/updatesKey) ---

export type UpdatePlatform = 'android' | 'windows'

/** One /manifest.json entry (keyed by app id) on the panel's updates drive. */
export interface UpdateEntry {
  platform: UpdatePlatform
  versionCode: number
  versionName: string
  /** Hex sha256 of the artifact — verified after download, before 'update-ready'. */
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

export interface UpdateCheckResult {
  /** 'unknown' = cannot say right now (no updates drive advertised, or the manifest
   *  did not land within the bound) — try again later, never an error. */
  status: 'available' | 'current' | 'none' | 'unknown'
  /** The manifest entry ('available' and 'current'). */
  entry?: UpdateEntry
  /** 'available' only: the running build is below entry.minVersionCode. */
  mandatory?: boolean
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
  /** OTA download progress (throttled: ~500 ms / 5% steps). */
  'update-progress': [info: { received: number; total: number }]
  /** OTA artifact downloaded + sha256-verified; path is on this device's disk. */
  'update-ready': [info: { path: string; entry: UpdateEntry }]
  /** OTA download/verify failure — downloadUpdate() also rejects with the same error. */
  'update-error': [info: { message: string }]
  /**
   * Phone -> TV sign-in handover. `code`, `sas` and `pin` are all for a SCREEN and are
   * all live secrets for the length of the exchange — never log any of them.
   *
   * Three of these states are QUESTIONS and the exchange blocks on each until the host
   * answers: 'match' (phone -> confirmSignInMatch), 'pin-entry' (TV -> submitSignInPin),
   * 'confirm-service' (TV -> confirmSignInService).
   */
  'signin-pair': [
    info: {
      role: 'tv' | 'phone'
      state: SigninPairState
      /** role 'tv', state 'code': the 12 characters to display. */
      code?: string
      expiresAt?: number
      /**
       * state 'match': four digits BOTH devices show. On the phone, ask whether the TV
       * shows the same and answer with confirmSignInMatch(); on the TV, display only.
       */
      sas?: string
      /** role 'phone', state 'pin': the four digits to display. */
      pin?: string
      /** role 'tv', states 'confirm-service' and 'signed-in'. */
      username?: string
      /** role 'tv', state 'confirm-service': the operator key about to be used (hex). */
      panelPubKey?: string
      /** …the same key as the operator's printed 12-character code, or null. */
      pairingCode?: string | null
      /** …true when this device has no operator yet and is about to adopt that one. */
      adopting?: boolean
      /** state 'failed'. */
      reason?: SigninPairErrorCode
      message?: string
    }
  ]
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
  /**
   * Send a pseudonymous problem report over the panel RPC socket. NEVER throws or
   * rejects — switch on the result. Attaches the active channel, peer count, the
   * host's appVersion/platform and the engine's recent event breadcrumbs; identity is
   * the session token, which the panel reduces to an HMAC pseudonym on arrival (no
   * username or deviceId is ever stored). Locally rate-limited per channel+category;
   * a pre-S50 panel answers 'unsupported'.
   */
  report(input: { category: ReportCategory; text?: string }): Promise<ReportResult>
  /**
   * Check the panel's updates drive for a newer build of THIS app. Lazy: the first
   * call opens the sparse replica and joins its topic client-only (a viewer never
   * re-serves APK blobs, whatever the uploadPolicy). Only bad arguments throw —
   * an unreachable drive resolves { status: 'unknown' }.
   */
  checkUpdate(appInfo: { appId: string; platform: UpdatePlatform; versionCode: number }): Promise<UpdateCheckResult>
  /**
   * Download + sha256-verify the update the last 'available' checkUpdate() found:
   * throttled 'update-progress' events, then 'update-ready' { path, entry } with the
   * verified file path for the host's installer. A failure deletes the partial file,
   * emits 'update-error' AND rejects. Single-flight while a download runs.
   */
  downloadUpdate(): Promise<{ path: string; entry: UpdateEntry }>
  /**
   * TV role of the phone -> TV sign-in handover. Mints a code, announces its rendezvous
   * and resolves at once with the code to display; the rest arrives as 'signin-pair'
   * events (and on `done`, which is pre-caught so ignoring it is safe). The device does
   * not have to be connected to a panel first — the handover carries the operator key,
   * which is exactly why 'confirm-service' has to be answered before it is adopted.
   */
  startSignInPairing(opts?: {
    ttlMs?: number
    pinMs?: number
    payloadMs?: number
  }): Promise<{ code: string; expiresAt: number; done: Promise<Stream[]> }>
  /**
   * TV role. The four digits the viewer typed on the remote. False for a malformed entry
   * or when nothing is waiting for one. A well-formed submission is FINAL — one attempt,
   * and a wrong one ends the sign-in with the code already spent. This is one of the two
   * checks; it is not the one that catches a relay.
   */
  submitSignInPin(pin: string): boolean
  /**
   * TV role. Answer 'confirm-service': sign in as that account, and (when `adopting`)
   * take that operator key. True adopts; anything else refuses. False when nothing is
   * waiting for an answer.
   */
  confirmSignInService(ok: boolean): boolean
  /** TV role. Abandon the code on screen (it is spent either way). */
  cancelSignInPairing(): void
  /**
   * Phone role. Sign a TV in with the code it is showing. Resolves as soon as the
   * rendezvous is joined; the outcome is `done`. Emits {role:'phone', state:'match', sas}
   * — which MUST be answered with confirmSignInMatch() — and then {state:'pin', pin} with
   * the digits to show the viewer.
   *
   * Requires a live session AND `remote: { sendToTv: true }` at construction.
   */
  sendSignIn(
    code: string,
    opts?: { timeoutMs?: number; matchMs?: number; pinMs?: number; payloadMs?: number }
  ): Promise<{ done: Promise<{ username: string }> }>
  /**
   * Phone role. Answer 'match': do the four digits on this phone appear on the TV? True
   * proceeds; anything else aborts and burns the TV's code. False when nothing is waiting.
   * This is the check that sees a peer relaying between the two devices — never default
   * it and never let a dismissed dialog answer it.
   */
  confirmSignInMatch(ok: boolean): boolean
  /** Phone role. Abandon an in-flight send (the TV's code is spent either way). */
  cancelSendSignIn(): void
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
  /**
   * OPT-IN (`remoteSecret: true`) and ABSENT otherwise. The account's remote-control
   * rendezvous secret (hex), one-way from the private key and rotated by the panel's
   * "log out all devices". Null when the account record carries no usable tokenVersion —
   * never a guessed default, because two devices that guess differently simply never
   * meet. Not a key, but a live authenticator and a stable account correlator: a caller
   * with no rendezvous feature should not ask for one.
   */
  remoteSecret?: string | null
  /**
   * OPT-IN (`handover: true`) and absent otherwise. THIS IS THE ACCOUNT: the two private
   * keys a login recovers. It exists so a signed-in phone can sign a TV in
   * (sdk/signin-pair.js). Keep it in memory, hand it to nothing else, never log or
   * serialize it.
   */
  handover?: { username: string; priv: string; authPriv: string | null }
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
  opts?: { deviceId?: string; deviceLabel?: string; handover?: boolean; remoteSecret?: boolean }
): Promise<LoginResult>

/**
 * The same session entered with the ACCOUNT KEYS instead of the password — the TV half
 * of "send to TV". Registers THIS device's own deviceId and takes its own panel-signed
 * token, so device limits and per-device revocation are unaffected. Works against an
 * unmodified panel.
 */
export function loginWithKeys(
  call: unknown,
  db: unknown,
  username: string,
  keys: { priv: string | Uint8Array; authPriv: string | Uint8Array },
  opts?: { deviceId?: string; deviceLabel?: string; handover?: boolean; remoteSecret?: boolean }
): Promise<LoginResult>

/** Offline check: valid panel signature + not expired. Returns the payload or null. */
export function checkSession(panelPublicKey: string | Uint8Array, token: string, now?: number): SessionPayload | null

/** Online companion: device still enrolled with a matching tokenVersion. */
export function sessionLive(db: unknown, payload: SessionPayload | null, now?: number): Promise<boolean>

// --- report.js (problem-report vocabulary for host UIs) ---

/** The seven wire categories, in display order. Deep-equal to the panel's copy. */
export const REPORT_CATEGORIES: readonly ReportCategory[]
/** Viewer-facing label per category. */
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string>
/** Consent line to show VERBATIM above the submit control (S50-DESIGN D1). */
export const REPORT_CONSENT: string
/** Free-text cap (characters) — mirrors the panel's own cap. */
export const REPORT_TEXT_MAX: number
/** How many engine breadcrumbs ride along, and their per-entry detail cap. */
export const REPORT_EVENT_LIMIT: number
export const REPORT_EVENT_DETAIL_MAX: number
/** Default client-side cooldown per channel+category (ms). */
export const REPORT_COOLDOWN_MS: number
export function isReportCategory(v: unknown): v is ReportCategory
export function reportCategoryLabel(v: string): string

// --- pairing.js (service pairing codes) ---

/** What a resolved pairing code hands back. `code` is the display form of what the
 *  viewer typed; `name`/`branding` are unsigned display text from the panel. */
export interface PairedService {
  panelPubKey: string
  name: string | null
  branding: Record<string, unknown> | null
  code: string
}

/** 'malformed' — not a code, nothing was sent; 'timeout' — nobody answered;
 *  'unverified' — a peer answered with a key that does not own the code. */
export type PairingErrorCode = 'malformed' | 'timeout' | 'unverified'

export class PairingError extends Error {
  code: PairingErrorCode
}

export const PAIRING_ERRORS: Record<PairingErrorCode, PairingErrorCode>

/**
 * Turn the 12 characters a viewer typed ('A3K7-9QF2-M4XR') into the operator's panel
 * public key. Joins a swarm topic derived from the code alone, asks whoever answers to
 * describe itself, and VERIFIES by re-deriving the code from the key it received — an
 * answer that fails that check is discarded, never used.
 */
export function resolvePairingCode(
  code: string,
  opts?: { swarm?: unknown; bootstrap?: string[]; timeoutMs?: number }
): Promise<PairedService>

// --- signin-pair.js (phone -> TV sign-in handover) ---

/**
 * What a signed-in device hands a TV. THIS IS THE ACCOUNT — it only ever travels over a
 * connection that has passed both the mutual proof and the entry-PIN proof.
 */
export interface SigninPayload {
  username: string
  /** X25519 secret (32 bytes, hex) — opens the sealed per-stream keys. */
  priv: string
  /** Ed25519 secret (64 bytes, hex) — signs the panel's session challenge. */
  authPriv: string
  /** Which operator this account belongs to (32 bytes, hex). */
  panelPubKey: string
}

/**
 * 'malformed' — not a code/payload, nothing was sent; 'timeout' — nobody answered or a
 * step ran out; 'expired'/'used' — the code's TTL ran out / it was already spent;
 * 'busy' — a handover is already in flight for it; 'unauthorized' — the peer could not
 * prove it holds the code; 'mismatch' — the viewer said the two screens showed different
 * digits, which is what a relay looks like from here and must NOT be worded as an
 * ordinary retry; 'pin' — the peer could not prove it learned the typed digits;
 * 'cancelled'; 'refused' — the peer answered but declined the step.
 */
export type SigninPairErrorCode =
  | 'malformed' | 'timeout' | 'expired' | 'used' | 'busy'
  | 'unauthorized' | 'mismatch' | 'pin' | 'cancelled' | 'refused'

export type SigninPairState =
  | 'code' | 'announced' | 'searching' | 'linked' | 'match' | 'pin' | 'pin-entry'
  | 'received' | 'sent' | 'confirm-service' | 'signed-in' | 'failed'

export class SigninPairError extends Error {
  code: SigninPairErrorCode
}

export const SIGNIN_PAIR_ERRORS: Record<SigninPairErrorCode, SigninPairErrorCode>

/**
 * A FIXED key set, not an open record: 'pin-entry' is reached as
 * SIGNIN_PAIR_STATES.pinEntry, and the two states the ENGINE emits rather than this
 * module ('confirm-service', 'signed-in') have no entry here at all.
 */
export const SIGNIN_PAIR_STATES: {
  code: 'code'
  announced: 'announced'
  searching: 'searching'
  linked: 'linked'
  match: 'match'
  pin: 'pin'
  pinEntry: 'pin-entry'
  received: 'received'
  sent: 'sent'
  failed: 'failed'
}

export interface SigninPairHandle {
  /** Display form of the code, e.g. 'A3K7-9QF2-M4XR'. */
  code: string
  canonical: string
  expiresAt: number
  /**
   * The digits the viewer typed. False for a malformed entry or nothing pending. The
   * handover sends exactly ONE answer — but note that repeat calls BEFORE the phone asks
   * overwrite the parked entry and also return true, so `true` does not yet mean "locked
   * in".
   */
  submitPin(pin: string): boolean
  cancel(): void
  /** The received payload, or a SigninPairError. */
  result: Promise<SigninPayload>
}

export interface SendSignInHandle {
  canonical: string
  /**
   * The viewer's answer to {state:'match'}: does the TV show these four digits? True
   * proceeds to the typed-PIN round; anything else aborts with 'mismatch' and burns the
   * code. False when there is nothing to answer.
   *
   * MANDATORY — the exchange stops at 'match' until it is called, and it is the only
   * check in the flow that sees a peer relaying between the two devices.
   */
  confirmMatch(ok: boolean): boolean
  cancel(): void
  /** { username } once the TV took the handover, or a SigninPairError. */
  result: Promise<{ username: string }>
}

/**
 * Receiving (TV) role: mint a code, announce its rendezvous, run the mutual proof, show
 * the compared digits, prove the typed digits, and hand back the payload. Resolves as
 * soon as the code exists. The code is ONE-SHOT: the first peer that proves it holds it
 * spends it, and every failure path leaves it spent.
 */
export function receiveSignIn(opts?: {
  swarm?: unknown
  bootstrap?: string[]
  ttlMs?: number
  pinMs?: number
  payloadMs?: number
  kdf?: { opslimit: number; memlimit: number }
  onState?: (s: { state: SigninPairState; code?: string; expiresAt?: number; sas?: string; reason?: SigninPairErrorCode }) => void
}): Promise<SigninPairHandle>

/**
 * Sending (phone) role: join the code's rendezvous, run the mutual proof, show the
 * compared digits and WAIT for confirmMatch(), then draw and display the typed digits,
 * verify ONCE that the TV learned them, and only then release the payload. Exactly one
 * peer is ever spoken to past the mutual proof.
 *
 * Resolves as soon as the rendezvous is joined; the outcome is the handle's `result`. A
 * malformed code or payload THROWS instead — nothing was joined and nothing was sent.
 */
export function sendSignIn(
  code: string,
  payload: SigninPayload,
  opts?: {
    swarm?: unknown
    bootstrap?: string[]
    timeoutMs?: number
    matchMs?: number
    pinMs?: number
    payloadMs?: number
    kdf?: { opslimit: number; memlimit: number }
    onState?: (s: { state: SigninPairState; sas?: string; pin?: string; reason?: SigninPairErrorCode }) => void
  }
): Promise<SendSignInHandle>

/** Shape-check a handover payload. Returns the normalized object, or null. */
export function normalizeSigninPayload(p: unknown): SigninPayload | null

// --- recover.js (store-corruption recovery) ---

/** True for known store-corruption shapes (EPARTIALREAD, OPLOG_CORRUPT, ...). */
export function isCorruptionError(err: unknown): boolean

/** Run op; on corruption purge() once and retry. Other failures propagate unchanged. */
export function withRecovery<T>(
  op: () => Promise<T> | T,
  purge: (err: Error) => Promise<void> | void,
  onRecover?: (err: Error) => void
): Promise<T>
