// Operator-brandable theme. makeTheme(descriptor) merges the descriptor's
// branding.colors over these defaults — the ONLY place brand colors may live in
// client/src (white-label acceptance, S18). Sizing follows the 10-foot guidance in
// Google's TV design system (developer.android.com/design/ui/tv): larger type scale,
// overscan-safe margins, and a three-part focus grammar — border box (menu icons),
// accent underline (category rail), light row fill (lists) — plus, on TV only, a
// slight scale lift (focusScale) on the focused list row.
import { Platform } from 'react-native'
import { loadServiceDescriptor, type ServiceDescriptor } from './config'

const isTV = Platform.isTV

// Phone GUI scale: the 10-foot type/spacing ramp reads a touch large up close, so trim
// the PHONE by this factor (TV keeps full 10-foot sizing). Applied to type, spacing,
// safe margins and card sizes below — one knob to tune the overall density.
// Tuned on the S22 across three rounds: 0.85 → 0.80 → 0.68 (a further 15% cut —
// the lettering still read too large on device).
const SCALE = isTV ? 1 : 0.68
const px = (n: number) => Math.round(n * SCALE)

const DEFAULT_COLORS = {
  primary: '#0EA5E9',
  background: '#0B1220',
  surface: '#111A2E',
  accent: '#22D3EE',
  text: '#E5EEF7',
  textDim: '#93A4BF',
  live: '#EF4444',
  focus: '#22D3EE',
  // Text/icons sitting on primary/live/accent fills.
  onPrimary: '#FFFFFF',
  // The bed behind video (letterboxing) — pure black on virtually every brand.
  videoBackground: '#000000',
  // Dark translucent panels over playing video (live browse / channel detail).
  overlay: 'rgba(8, 12, 22, 0.82)',
  overlayStrong: 'rgba(5, 8, 15, 0.94)',
  // Focused list rows use a light fill (the reference's row highlight).
  focusFill: '#E5EEF7',
  focusFillText: '#0B1220',
  // The light "brand world" (splash / section loading screens).
  brandSurface: '#F2F5FA',
  brandText: '#0B1220'
}

export function makeTheme (descriptor?: Pick<ServiceDescriptor, 'branding'>) {
  const overrides = descriptor?.branding?.colors ?? {}
  const colors = { ...DEFAULT_COLORS }
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === 'string' && k in colors) (colors as Record<string, string>)[k] = v
  }
  return {
    colors,
    // D-pad focus ring for the 10-foot UI (invisible border keeps layout stable on phone).
    focusRing: isTV ? 3 : 0,
    // Focused-row scale lift (10-foot polish) — 1 on phone, where touch has no focus
    // state to announce. Skipped entirely under reduced motion (src/motion.ts).
    // 1.025 is the Android TV focus-system value for LARGE elements (bigger element →
    // smaller scale); a full-width list row is one. It also keeps the overhang on a
    // ~730px panel row to ~9px/side, inside what the panel can absorb without the
    // FlatList clipping the lift (device-verify on the emulator).
    focusScale: isTV ? 1.025 : 1,
    // Android TV uses a "10-foot" UI: larger type, more spacing, focus rings.
    isTV,
    spacing: (n: number) => px(n * (isTV ? 12 : 8)),
    // Overscan-safe screen margins (Google TV: ~48dp horizontal / 27dp vertical).
    safeX: px(isTV ? 48 : 16),
    safeY: px(isTV ? 27 : 12),
    // Type scale (TV sizes track the Google TV type ramp; phone a step smaller, then
    // trimmed by SCALE).
    type: {
      display: px(isTV ? 42 : 30),
      title: px(isTV ? 26 : 20),
      body: px(isTV ? 18 : 15),
      label: px(isTV ? 16 : 13),
      caption: px(isTV ? 14 : 12)
    },
    cardWidth: px(isTV ? 240 : 150),
    cardHeight: px(isTV ? 135 : 84)
  }
}

// The app bundles one descriptor per build, so the theme is resolved once at module
// init — screens keep using plain StyleSheet.create over `theme`.
export const theme = makeTheme(loadServiceDescriptor())

export type Theme = ReturnType<typeof makeTheme>
