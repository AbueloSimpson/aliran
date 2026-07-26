// Shared renderer types — the desktop mirror of @aliran/react-native's JSON-safe
// message/stream types (sdk/react-native/src/backend.ts). Kept in sync by hand; the
// one deliberate difference is SavedIdentity: the desktop main process never returns
// the saved password to the renderer (safeStorage wraps it), so 'prefs' carries the
// username only.

export interface Stream {
  id: string
  title?: string
  description?: string
  category?: string[]
  isLive?: boolean
  poster?: string
  backdrop?: string
  logo?: string
  /** Panel curation hint: rail/list sort key (lower first; null/absent sorts last). */
  order?: number | null
  /** Panel curation hint: featured stream (hero / menu wallpaper pick). */
  featured?: boolean
  /** Public https JSON feed with this channel's program schedule (fetched on demand). */
  epgUrl?: string
  /** This channel's id INSIDE the epgUrl feed (matches feed `channels[].id`). */
  epgId?: string
  /** Record class (S8a): 'vod' = an on-demand library title (seek/pause UI, no
   *  live-edge machinery); 'live' (or absent on old records). */
  type?: 'live' | 'vod'
  /** Title duration in seconds — vod records only. */
  durationSec?: number | null
  /** Catalog status ('live'/'idle'; vod: 'available'/'unavailable' — gray out the latter). */
  status?: string
}

/** Saved sign-in identity — username only; the password stays in the main process. */
export interface SavedIdentity { username: string }

// Viewer problem reports (S50c). This is the desktop copy of the closed category enum
// (renderer code cannot import the engine's sdk/report.js — the engine lives in the
// main process): the e2e drift guard in tools/e2e-reports-test.mjs reads this file
// alongside sdk/report.js, sdk/react-native/src/report.ts and panel/src/reports.js and
// requires all four to be deep-equal. Change one, change all four.
export type ReportCategory =
  | 'no-audio'
  | 'black-screen'
  | 'visual-artifacts'
  | 'buffering'
  | 'wrong-content'
  | 'login'
  | 'other'

/** Error codes a 'report-result' may carry (see AliranPlayer.report()). */
export type ReportError =
  | 'bad-category'
  | 'not-logged-in'
  | 'offline'
  | 'cooldown'
  | 'locked'
  | 'unsupported'
  | 'unauthorized'
  | 'expired'

export const REPORT_CATEGORIES: ReportCategory[] = [
  'no-audio',
  'black-screen',
  'visual-artifacts',
  'buffering',
  'wrong-content',
  'login',
  'other'
]

// Symptom-shaped, not cause-shaped: a viewer cannot tell a decoder fault from a dead
// upstream, and a label that asks them to diagnose produces worse data.
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  'no-audio': 'No sound',
  'black-screen': 'Black screen / nothing plays',
  'visual-artifacts': 'Broken or glitchy picture',
  buffering: 'Keeps buffering or freezing',
  'wrong-content': 'Wrong programme on this channel',
  login: 'Trouble signing in',
  other: 'Something else'
}

// Shown VERBATIM above the submit control (S50-DESIGN D1) — the viewer's only view of
// what a report contains. The closing promise about the account name is one the
// protocol structurally guarantees: the report carries a session token that the panel
// immediately reduces to an HMAC pseudonym.
export const REPORT_CONSENT =
  'Sent with your report: the problem you picked, anything you type, the channel you were ' +
  'watching, your app version and device type, how many peers you were connected to, and the ' +
  'last few things the player did. Your account name and password are never sent.'

/** Free-text cap (characters) — the panel enforces its own copy of this. */
export const REPORT_TEXT_MAX = 300

export type BackendMessage =
  | { type: 'ready' }
  | { type: 'streams'; streams: Stream[] }
  | { type: 'login-error'; message: string }
  // streamId names the stream this play() reply is for — the video component uses it
  // to tell "the served channel just CHANGED under the shared localhost URL" (remount)
  // from a re-resolve of the channel already playing. recordType/durationSec mirror
  // the engine's ResolveResult (S8a): 'vod' = finished library title.
  | { type: 'port'; port?: number; url?: string; source?: 'p2p' | 'cdn'; streamId?: string; recordType?: 'live' | 'vod'; durationSec?: number | null }
  | { type: 'status'; peers?: number; state?: string; message?: string }
  | { type: 'error'; message: string }
  | { type: 'fallback'; streamId: string; url: string; reason: 'timeout' | 'stall' }
  | { type: 'source-changed'; streamId: string; source: 'p2p' | 'cdn'; url: string }
  // The active stream's feedKey rotated (broadcaster source change / restart); the
  // engine swapped the served feed behind the SAME url — remount the player.
  | { type: 'feed-changed'; streamId: string; feedKey: string; url: string }
  | { type: 'zap-prefetch'; enabled?: boolean; state?: 'suspended' | 'resumed'; reason?: 'metered' | 'stall' | 'thin' }
  | { type: 'upload-policy'; policy: 'reseed' | 'client-only'; reason?: string }
  | { type: 'prefs'; creds: SavedIdentity | null; favorites: string[]; smoothZapping?: boolean | null }
  // Answer to a 'report' (S50c). ok=true means the panel accepted it (possibly
  // deduplicated or folded into an open alert — either way, "we heard you").
  // 'unsupported' = this panel predates reports or has them disabled.
  | { type: 'report-result'; ok: boolean; error?: ReportError | string; retryAfter?: number; id?: string }
  // The runtime descriptor was accepted ('set-service', public flavor) — the engine
  // is booting on it; theme/branding may re-apply.
  | { type: 'service'; descriptor: ServiceDescriptor }

// Brandable color token set — same contract as the phone app's service descriptor
// (client/src/config.ts). Anything omitted falls back to the theme defaults.
export interface BrandColors {
  primary?: string
  background?: string
  surface?: string
  accent?: string
  text?: string
  textDim?: string
  live?: string
  focus?: string
  onPrimary?: string
  videoBackground?: string
  overlay?: string
  overlayStrong?: string
  focusFill?: string
  focusFillText?: string
  brandSurface?: string
  brandText?: string
}

export interface SectionToggles {
  favorites?: boolean
  search?: boolean
  settings?: boolean
  /** Exit item — default true on desktop (a windowed app still benefits from an
   *  explicit leave-the-couch-UI action; Alt+F4 always works too). */
  exit?: boolean
}

export interface ServiceDescriptor {
  panelPubKey: string
  name: string
  branding?: {
    logo?: string
    wallpaper?: string
    colors?: BrandColors
  }
  sections?: SectionToggles
  /** Dev-only auto-fill credentials (gitignored local service.json — never shipped). */
  dev?: { username: string; password: string }
}

/** The initial-state snapshot main returns from 'aliran:state' (see EngineHost.state). */
export interface EngineState {
  ready: boolean
  streams: Stream[]
  port: number | null
  url: string | null
  source: 'p2p' | 'cdn' | null
  streamId: string | null
  recordType: 'live' | 'vod' | null
  durationSec: number | null
  creds: SavedIdentity | null
  favorites: string[]
  smoothZapping: boolean | null
  /** null when no descriptor is baked OR stored — the app shows the Connect screen. */
  descriptor: ServiceDescriptor | null
  /** 'baked' (operator build) | 'runtime' (entered on the Connect screen) | null. */
  descriptorSource: 'baked' | 'runtime' | null
}

// The preload surface (main/preload.cjs).
declare global {
  interface Window {
    aliran: {
      send (msg: unknown): void
      state (): Promise<EngineState>
      onMessage (fn: (msg: BackendMessage) => void): () => void
    }
  }
}
