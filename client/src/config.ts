// Loads the operator service descriptor (panel public key + branding + sections).
//
// THE WHITE-LABEL CONTRACT (S18): screens and components render ONLY from this
// descriptor (via theme.ts makeTheme) — no brand names, colors, or section lists are
// hardcoded anywhere else in client/src. One codebase, any operator's APK; S19 adds
// the per-brand packaging (gradle flavors + baked launcher/splash assets).
//
// Two supported paths (see docs/client-build.md):
//   - Build-time (operator flavor): bundle config/service.json WITH a panelPubKey into
//     the app (tools/brand.mjs swaps it per brand). The key is baked; the app never
//     shows the Connect screen and the key is not changeable at runtime.
//   - Runtime (public flavor, S36): bake the committed KEYLESS config/service.public.json
//     (panelPubKey: "") instead. First run shows the Connect screen (panel key +
//     username + password), and the descriptor persists in the worklet prefs beside
//     the other device-local settings. Settings gains "Change service…".
// Precedence: a baked key always wins — a build that ships one ignores any persisted
// runtime service and never offers to change it (mirrors the desktop player flavors).

import service from '../config/service.json'
import type { HybridConfig } from '@aliran/react-native'

// Full brandable color token set. Anything omitted falls back to theme.ts defaults.
export interface BrandColors {
  primary?: string
  background?: string
  surface?: string
  accent?: string
  text?: string
  textDim?: string
  live?: string
  focus?: string
  /** Text/icons on primary/live/accent fills; the bed behind video. */
  onPrimary?: string
  videoBackground?: string
  /** Dark translucent panel over playing video (live browse/detail overlays). */
  overlay?: string
  overlayStrong?: string
  /** Focused list-row fill (the reference's light row highlight) + text on it. */
  focusFill?: string
  focusFillText?: string
  /** The light "brand world" surfaces (splash / section loading) + text on them. */
  brandSurface?: string
  brandText?: string
}

// Menu-hub sections an operator can toggle. Absent = the default noted per field.
export interface SectionToggles {
  /** VOD catalog — default false until VOD ships (S8). */
  vod?: boolean
  /** Favorites section — default true. */
  favorites?: boolean
  /** Search section — default true. */
  search?: boolean
  /** Settings section — default true. */
  settings?: boolean
  /** Exit item — default: TV only (Android back already exits on phone, D7). */
  exit?: boolean
}

export interface ServiceDescriptor {
  panelPubKey: string
  name: string
  branding?: {
    logo?: string
    /** Menu-hub wallpaper fallback when no featured stream has a backdrop
     *  (https URL; per-brand bundled art is S19's job). */
    wallpaper?: string
    colors?: BrandColors
  }
  sections?: SectionToggles
  bootstrap?: string[]
  // Optional hybrid CDN<->P2P playback policy (cdnUrl is a '{streamId}' template
  // string). Omit for pure P2P. See sdk/react-native and sdk/README.md.
  hybrid?: HybridConfig
  // Dev-only auto-login credentials for the worklet smoke test (local service.json
  // is gitignored). Never present in a shipped descriptor.
  dev?: { username: string; password: string }
}

// An operator panel public key: 32 bytes as lowercase hex — the one thing a viewer
// types on the Connect screen (everything else is DHT discovery).
export const PANEL_KEY_RE = /^[0-9a-f]{64}$/

export function loadServiceDescriptor (): ServiceDescriptor {
  // An EMPTY panelPubKey is the deliberate keyless marker (the committed
  // service.public.json): the public flavor, which connects at runtime via the
  // Connect screen. Only a missing/unedited key is a configuration mistake.
  if (service?.panelPubKey == null || service.panelPubKey.startsWith('REPLACE_')) {
    throw new Error('Configure config/service.json with your panel public key (see service.example.json).')
  }
  return service as ServiceDescriptor
}

// True when this build ships an operator key (baked flavor): the app boots straight
// onto it, ignores any persisted runtime service, and never offers "Change service…".
export function hasBakedKey (): boolean {
  return PANEL_KEY_RE.test(service?.panelPubKey ?? '')
}
