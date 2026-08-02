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
  /** Access control: PIN-gate this channel (parental control); hidden while no PIN is set. */
  restricted?: boolean
  /** Public https JSON feed with this channel's program schedule (fetched on demand). */
  epgUrl?: string
  /** This channel's id INSIDE the epgUrl feed (matches feed `channels[].id`). */
  epgId?: string
  /** P2P guide base (loopback /epg/v1/<id> from the replicated guide drive) — tried
   *  before epgUrl; a 404 falls back to https. */
  guideBase?: string
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
  'Sent with your report: the problem you picked, the channel you were ' +
  'watching, your app version and device type, how many peers you were connected to, and the ' +
  'last few things the player did. Your account name and password are never sent.'

/** Free-text cap (characters) — the panel enforces its own copy of this. */
export const REPORT_TEXT_MAX = 300

/** Panel-delivered external VOD provider config (S53) — the operator's switch plus the
 *  coordinates the APP uses to call the provider DIRECTLY (the panel never proxies it,
 *  and stores no viewer credential for it: each viewer authenticates with their own
 *  account). Delivered ONLY while the operator has a provider enabled, so its absence
 *  IS "no VOD section". Read at login — an operator change lands at the next login. */
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

/** One provider catalog row, already stripped by main/vod-provider.js to what the
 *  poster grid renders (the raw list can be tens of megabytes). */
export interface VodItem {
  id: string
  name: string
  /** Original-language title; often differs from the localized `name`. */
  nameOriginal: string
  /** Poster URL, or '' when the provider has none. */
  icon: string
  /** Unix seconds the provider added the title (0 when unknown) — the default sort. */
  added: number
  /** Release year as the provider states it (string, may be ''). */
  anio: string
  /** Provider category ids. The mapping is unknown, so v1 carries but ignores them. */
  categories: number[]
}

/** Which catalog a 'vod-list' request is for (S54a). The result echoes it back. */
export type VodKind = 'movies' | 'series'

/** One season of a series, stripped by main/vod-provider.js. */
export interface VodSeason {
  id: string
  /** Season number as the provider states it (0 when it states none). */
  number: number
  title: string
  icon: string
  /** First-air date, verbatim ('' when absent). */
  airDate: string
  /** Episodes the provider claims for this season (the tile badge). */
  episodeCount: number
}

/** One episode. `url` is ALREADY playable — main substituted the provider's `{token}`
 *  placeholder before the reply crossed the bridge. */
export interface VodEpisode {
  id: string
  seasonId: string
  number: number
  title: string
  plot: string
  icon: string
  /** '' = no usable path (or a cleartext one, which the app refuses to dial with a
   *  viewer password) — show a notice instead of playing. */
  url: string
  durationSec: number | null
}

/** Everything the series detail screen renders. The flat fields are verbatim provider
 *  text (the screen formats them); seasons/episodes are stripped lists. */
export interface VodSeriesDetail {
  plot: string
  genre: string
  director: string
  cast: string
  rating: string
  /** Run range as the provider states it, e.g. "2019-10-05 - 2026-07-18". */
  releasedate: string
  icon: string
  seasons: VodSeason[]
  episodes: VodEpisode[]
}

/** One saved "My List" entry (S54a, design D9) — DEVICE-LOCAL: main persists it in
 *  userData and nothing about it ever reaches the panel or the provider. */
export interface VodListEntry {
  kind: 'movie' | 'series'
  id: string
}

/** One watch-history entry (S54a, design D9) — device-local, newest first, one per
 *  title/episode. `positionSec` 0 means "watched, start from the top again". */
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

/** Why a provider call could not be answered. Deliberately coarse: the UI names
 *  "sign-in" vs "connection" and never shows a code or a provider message. */
export type VodErrorCode = 'auth' | 'network' | 'bad-response'

export type VodListResult = { ok: true; items: VodItem[] } | { ok: false; error: VodErrorCode }
/** The provider's genre names, in ITS order — `VodItem.categories` are indexes into
 *  this array (S54d), so the order must never be sorted or filtered in transit. */
export type VodCategoriesResult = { ok: true; categories: string[] } | { ok: false; error: VodErrorCode }
export type VodInfoResult =
  | { ok: true; url: string; durationSec: number | null }
  | { ok: false; error: VodErrorCode }
export type VodSeriesInfoResult =
  | { ok: true; detail: VodSeriesDetail }
  | { ok: false; error: VodErrorCode }

export type BackendMessage =
  | { type: 'ready' }
  | { type: 'streams'; streams: Stream[]; vod?: VodConfig }
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
  // vodList/vodHistory (S54a): the device-local VOD arrays main persists — absent only
  // on a main process older than the field; treat as empty.
  | { type: 'prefs'; creds: SavedIdentity | null; favorites: string[]; smoothZapping?: boolean | null; vodList?: VodListEntry[]; vodHistory?: VodHistoryEntry[] }
  // Answer to a 'report' (S50c). ok=true means the panel accepted it (possibly
  // deduplicated or folded into an open alert — either way, "we heard you").
  // 'unsupported' = this panel predates reports or has them disabled.
  | { type: 'report-result'; ok: boolean; error?: ReportError | string; retryAfter?: number; id?: string }
  // Answers to the external-VOD requests (S53c, S54a). The provider is called in the
  // MAIN process (the renderer is file:// — CORS — and the credential is the
  // viewer's password); these carry only what the grid, the detail page and the
  // player need. `kind` echoes the request so Movies and Series can be in flight at
  // once (absent = movies, the pre-S54a shape).
  | { type: 'vod-list-result'; kind?: VodKind; ok: boolean; items?: VodItem[]; error?: VodErrorCode }
  | { type: 'vod-info-result'; id: string; ok: boolean; url?: string; durationSec?: number | null; error?: VodErrorCode }
  | { type: 'vod-series-info-result'; id: string; ok: boolean; detail?: VodSeriesDetail; error?: VodErrorCode }
  // The provider's genre names (S54d) — served from the SAME cached catalog download
  // as 'vod-list', so asking for them costs no extra provider request.
  | { type: 'vod-categories-result'; ok: boolean; categories?: string[]; error?: VodErrorCode }
  // The runtime descriptor was accepted ('set-service', public flavor) — the engine
  // is booting on it; theme/branding may re-apply.
  | { type: 'service'; descriptor: ServiceDescriptor }
  // Answer to 'pair-resolve': the panel key a SERVICE PAIRING CODE stands for, after
  // main verified it by re-deriving the code from that key. error 'malformed' = not a
  // code; 'timeout' = nobody answered; 'unverified' = a peer answered and could not
  // prove it owns the code — a wrong service, never a retry.
  | { type: 'pair-result'; ok: boolean; panelPubKey?: string; name?: string; code?: string; error?: PairingErrorCode | string; message?: string }

/** Why a pairing code did not resolve. 'malformed' — not a 12-character code, nothing
 *  left the machine; 'timeout' — no service answered it; 'unverified' — a peer answered
 *  with a panel key that does not own the code, so it was refused. */
export type PairingErrorCode = 'malformed' | 'timeout' | 'unverified'

/** What resolvePairing() hands back. On ok the panel key is verified: main re-derived
 *  the code from it and got what the viewer typed. */
export interface PairingResult {
  ok: boolean
  panelPubKey?: string
  name?: string
  code?: string
  error?: PairingErrorCode | string
  message?: string
}

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
  /** Movies & Series (external VOD provider, S53) — default true, but the section
   *  only exists at all while the PANEL delivers an enabled provider config. Set
   *  false to keep the tile off a brand that has a provider enabled. */
  vod?: boolean
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
  /** S53: the panel's VOD provider config, or null (no provider / disabled). */
  vod: VodConfig | null
  port: number | null
  url: string | null
  source: 'p2p' | 'cdn' | null
  streamId: string | null
  recordType: 'live' | 'vod' | null
  durationSec: number | null
  creds: SavedIdentity | null
  favorites: string[]
  smoothZapping: boolean | null
  /** S54a: device-local "My List" + watch history (design D9), newest first. */
  vodList: VodListEntry[]
  vodHistory: VodHistoryEntry[]
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
