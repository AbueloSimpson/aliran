// Operator-brandable theme (the white-label contract, S18/S35): the descriptor's
// branding.colors merge over these defaults and land as CSS custom properties on
// :root — the ONLY place brand colors live in the desktop renderer; every component
// styles itself from var(--c-*). Token names match the phone app's theme.ts.

import type { BrandColors, ServiceDescriptor } from './types'

const DEFAULT_COLORS: Required<BrandColors> = {
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

// Focused-row scale lift (mirror of the client's theme.focusScale). 1.025 is the
// Android TV focus-system value for LARGE elements (bigger element → smaller scale);
// a full-width list row is one, and desktop keyboard focus speaks the same TV
// grammar. Not brandable — it is geometry, not color. Landed as --focus-scale next
// to the colors; styles.css applies it transform-only, wrapped in
// prefers-reduced-motion: no-preference (the DOM twin of client/src/motion.ts).
export const FOCUS_SCALE = 1.025

export function applyTheme (descriptor?: Pick<ServiceDescriptor, 'branding'> | null) {
  const overrides = descriptor?.branding?.colors ?? {}
  const colors: Record<string, string> = { ...DEFAULT_COLORS }
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === 'string' && k in colors) colors[k] = v
  }
  const root = document.documentElement
  for (const [k, v] of Object.entries(colors)) {
    // primary -> --c-primary, focusFillText -> --c-focus-fill-text
    root.style.setProperty('--c-' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), v)
  }
  root.style.setProperty('--focus-scale', String(FOCUS_SCALE))
}
