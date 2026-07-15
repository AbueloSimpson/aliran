// Loads the operator service descriptor (panel public key + branding + sections).
//
// THE WHITE-LABEL CONTRACT (S18): screens and components render ONLY from this
// descriptor (via theme.ts makeTheme) — no brand names, colors, or section lists are
// hardcoded anywhere else in client/src. One codebase, any operator's APK; S19 adds
// the per-brand packaging (gradle flavors + baked launcher/splash assets).
//
// Two supported paths (see docs/client-build.md):
//   - Build-time: bundle config/service.json into the app (tools/brand.mjs swaps it).
//   - Runtime: accept a service descriptor via a QR/deep link and persist it.
//
// This stub imports a bundled JSON; swap in runtime loading if you ship one generic APK.

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

export function loadServiceDescriptor (): ServiceDescriptor {
  if (!service?.panelPubKey || service.panelPubKey.startsWith('REPLACE_')) {
    throw new Error('Configure config/service.json with your panel public key (see service.example.json).')
  }
  return service as ServiceDescriptor
}
