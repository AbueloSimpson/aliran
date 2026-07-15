// Operator-brandable theme. makeTheme(descriptor) merges the descriptor's
// branding.colors over these defaults — the ONLY place brand colors may live in
// client/src (white-label acceptance, S18). Sizing follows the 10-foot guidance in
// Google's TV design system (developer.android.com/design/ui/tv): larger type scale,
// overscan-safe margins, and a three-part focus grammar — border box (menu icons),
// accent underline (category rail), light row fill (lists).
import { Platform } from 'react-native'
import { loadServiceDescriptor, type ServiceDescriptor } from './config'

const isTV = Platform.isTV

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
    // Android TV uses a "10-foot" UI: larger type, more spacing, focus rings.
    isTV,
    spacing: (n: number) => n * (isTV ? 12 : 8),
    // Overscan-safe screen margins (Google TV: ~48dp horizontal / 27dp vertical).
    safeX: isTV ? 48 : 16,
    safeY: isTV ? 27 : 12,
    // Type scale (TV sizes track the Google TV type ramp; phone a step smaller).
    type: {
      display: isTV ? 42 : 30,
      title: isTV ? 26 : 20,
      body: isTV ? 18 : 15,
      label: isTV ? 16 : 13,
      caption: isTV ? 14 : 12
    },
    cardWidth: isTV ? 240 : 150,
    cardHeight: isTV ? 135 : 84
  }
}

// The app bundles one descriptor per build, so the theme is resolved once at module
// init — screens keep using plain StyleSheet.create over `theme`.
export const theme = makeTheme(loadServiceDescriptor())

export type Theme = ReturnType<typeof makeTheme>
