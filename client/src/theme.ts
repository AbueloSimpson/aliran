// Operator-brandable theme. makeTheme(descriptor) merges the descriptor's
// branding.colors over these defaults — the ONLY place brand colors may live in
// client/src (white-label acceptance, S18). Sizing follows the 10-foot guidance in
// Google's TV design system (developer.android.com/design/ui/tv): larger type scale,
// overscan-safe margins, and a three-part focus grammar — border box (menu icons),
// accent pill (category rail's selected item), light row fill (lists and the rail's
// merely-focused item) — plus, on TV only, a slight scale lift (focusScale) on the
// focused list row.
import { Platform } from 'react-native'
import { loadServiceDescriptor, type ServiceDescriptor } from './config'

const isTV = Platform.isTV

// GUI scale — ONE KNOB per form factor, applied to type, spacing, safe margins, card
// sizes, and (via theme.px) the components' own geometry. Scaling everything by a single
// factor is the only way to shrink a 10-foot UI without wrecking its internal balance:
// trim a row height on its own and the type inside it simply overflows.
//
// PHONE: the 10-foot ramp reads a touch large up close. Tuned on the S22 across three
// rounds: 0.85 → 0.80 → 0.68 (the lettering still read too large on device).
//
// TELEVISION: full 10-foot sizing is Google's guidance for a living-room set, and on the
// operator's 1080p panel it measured GIANT — the channel list could not fit a channel
// NAME, which is the one thing that list exists to show ("[Amistos…", "[Argentin…").
// Piecemeal trims were tried first and were the wrong lever: shaving the panel width
// took the space out of the name, because the name is the only elastic thing in a row of
// number + name + LIVE badge + logo. Scaling the whole ramp shrinks the number, the
// badge, the logo and the lettering together, and the name gets the difference.
// Tuned on the TCL set: 1.0 → 0.8 (names became readable) → 0.72, the operator's call
// from an actual viewing distance, which is the only place this question can be settled.
//
// ⚠ THIS KNOB IS NEAR ITS FLOOR ALREADY — do not reach for it to make one screen fit.
// It is global (~30 files), and the type it drives is at the bottom of what a 10-foot UI
// can carry. Google's 10-foot floor is ~12sp; at 0.72 `type.caption` is already 10dp and
// the ~19 sites written as `type.caption - 1` / `- 2` are at 9dp and 8dp — the LIVE badges
// (ChannelRow, NowPlayingBar, ChannelInfoPanel, MenuScreen), the remote-key legend, and
// the Debug HUD an end user reads aloud to an operator over the phone. Those subtractions
// land AFTER px() rounds, so they lose 11-12.5% per SCALE step where the ramp loses 8.3%:
// a step to 0.66 puts the badges at 7dp. The focus targets are the other wall — the guide
// grid row is px(62) (45dp at 0.72) and the channel row px(80) (58dp), against Android's
// ~48dp focusable-target guidance.
//
// So: when a single screen overflows, fix that screen's own geometry. The TV main menu's
// left rail overflowed a 540dp viewport at 602dp and was fixed entirely inside
// MenuScreen.tsx, by putting the two parts of its tile that were OFF this ramp (the emoji
// line box and the label's top margin) ON it. SCALE stayed at 0.72. See MenuScreen's
// entry/glyph/label styles.
//
// (The guide's channel column used to be a constraint here — its parts had to sum inside
// CH_COL_W. It is not one any more: GuideScreen's chName is `flex: 1` and takes whatever
// the fixed parts leave, so the remainder can never go negative. That guardrail is gone,
// not merely relaxed.)
const SCALE = isTV ? 0.72 : 0.68
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
    // The scale ramp itself, for the fixed geometry components own (row heights, logo
    // boxes, column widths). Those are 10-foot numbers too, so they have to ride the
    // same knob as the type inside them or the two drift apart the moment it moves.
    px,
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
