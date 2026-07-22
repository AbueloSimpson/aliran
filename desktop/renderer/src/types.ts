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
