// The TV main menu's LEFT rail (2026-08-15): the section tiles moved from the old
// horizontal top bar to the phone's vertical left-rail grammar, keeping the TV focus
// contract — entries are FOCUS-driven Pressables (accent ring via onFocus, preferred
// focus on the first) inside a VERTICAL ScrollView, and the wordmark moved into the
// hero area (the old absolute bottom-left footer would sit under the rail).
//
// ⚠ HARNESS: this suite USED to fake the television by assigning `theme.isTV = true`
// in a beforeEach — that is, after the ESM import of MenuScreen had already run its
// StyleSheet.create. It therefore rendered the TV branch with PHONE numbers baked in,
// and measured (this is not a guess — it was dumped from the old harness):
//
//     theme.px(100)  68  (the phone ramp)     entry.minWidth  92  (the phone rung)
//     glyph fontSize 13  (TV: 17)             label fontSize   9  (TV: 11)
//     tile padding    7  (TV: 10)             rail padding    13  (TV: 26)
//     entries         5  (TV: 6)
//
// The entry count is the sharp end of it: the exit tile is gated on the REAL
// `Platform.isTV`, which the theme mutation never touched, so SALIR — the entry that
// was actually being clipped below the fold — was not in the tree at all. No sizing
// assertion written against that harness could have caught the 602dp rail. Fake the
// platform before the module graph loads, exactly as TvCategoryRail/TvLiveDpad do.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { ScrollView, Text, StyleSheet } from 'react-native'

const { Platform } = require('react-native')
const realIsTV = Object.getOwnPropertyDescriptor(Platform, 'isTV')!
Object.defineProperty(Platform, 'isTV', { get: () => true, configurable: true })
// AFTER the isTV fake: theme.ts snapshots Platform.isTV at module load and MenuScreen
// bakes the result into StyleSheet.create, so an ESM import would hoist above the
// override and put phone metrics in this "TV" suite. requires below see the TV theme.
const { theme } = require('../src/theme')
const { MenuScreen } = require('../src/screens/MenuScreen')
const { backend } = require('../src/worklet')

afterAll(() => { Object.defineProperty(Platform, 'isTV', realIsTV) })

const navigation = { navigate: jest.fn() } as any

const mounted: RendererInstance[] = []
async function mount () {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<MenuScreen navigation={navigation} route={{} as any} />) })
  await ReactTestRenderer.act(async () => {})
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  backend.streams = []
  navigation.navigate.mockClear()
})

/** The rail's ScrollView and its focus-driven entries. */
function rail (tree: RendererInstance) {
  const scrollers = tree.root.findAllByType(ScrollView)
  const entries = scrollers[0].findAll(n => typeof n.props?.onFocus === 'function' && typeof n.props?.onPress === 'function')
  return { scrollers, entries }
}

test('TV renders the sections as a focus-driven VERTICAL rail, not a top bar', async () => {
  const tree = await mount()
  const { scrollers, entries } = rail(tree)

  // One ScrollView, and it scrolls vertically — the horizontal top bar is gone.
  expect(scrollers).toHaveLength(1)
  expect(scrollers[0].props.horizontal).toBeFalsy()

  // The entries are the FOCUS-driven kind: onFocus/onBlur handlers (the accent-ring
  // grammar a remote navigates by), never the phone rail's press-only tiles.
  expect(entries.length).toBeGreaterThanOrEqual(3) // Live TV + Settings (+ Guide/Search/Exit per descriptor)

  // The first tile takes preferred focus; the rest must not fight it.
  expect(entries[0].props.hasTVPreferredFocus).toBe(true)
  for (const e of entries.slice(1)) expect(e.props.hasTVPreferredFocus).toBeFalsy()

  // OK on the first tile (Live TV) navigates.
  await ReactTestRenderer.act(async () => { entries[0].props.onPress() })
  expect(navigation.navigate).toHaveBeenCalledWith('Live', {})
})

test('the rail really renders under a TELEVISION theme, not phone metrics', async () => {
  // The guard on the harness itself. Every assertion here is a value that a module-load
  // ternary resolved from Platform.isTV, so each one reads the phone rung if the fake
  // lands late — the failure mode this suite shipped with. All four were wrong before.
  expect(theme.isTV).toBe(true)
  expect(theme.focusRing).toBe(3) // phone: 0
  // The TV rung of the type ramp; the phone's label is px(13). Written against px()
  // rather than a literal so a future SCALE hand-tune does not have to touch this.
  expect(theme.type.label).toBe(theme.px(16))

  const tree = await mount()
  const { entries } = rail(tree)
  // MenuScreen's own `theme.isTV ? 132 : 92` — off the ramp, so it is a clean read of
  // which branch StyleSheet.create took. It measured 92 under the old harness.
  expect(StyleSheet.flatten(entries[0].props.style).minWidth).toBe(132)
  // Six by default (live, guide, favorites, search, settings, exit) — no VOD provider
  // configured. Five here would mean Platform.isTV is not really on: exit is the tile
  // gated on it, and the one the layout bug was clipping.
  expect(entries).toHaveLength(6)
})

// ─── Rail fit: six entries must be readable at rest, without touching the remote ───
//
// A 1080p set at density 320 gives a 1920x1080 panel a 540dp viewport. The rail is
// top-aligned in a ScrollView, so an overflow is invisible in a snapshot and invisible
// to every behavioural assertion above — it just puts the last entry below the fold.
// That is exactly how the 602dp rail shipped. This is the mechanical guard: compose the
// tile out of the styles the component actually rendered and check the sum.
//
// The one thing a jest tree cannot give us is a laid-out text height, so the two line
// boxes are modelled from the ratios measured off the device screencaps (see the
// tv-menu-rail-fit commit): ~1.44 for the emoji glyph in Android's emoji font, ~1.17
// for the Latin label. Rounded UP on purpose — a fit guard must over-estimate, never
// under-estimate. Calibration: the model returns 496dp for the six-entry rail and
// 571dp for seven, both of which are the device-measured figures exactly, and 608dp for
// the pre-fix tile against a 602dp measurement (6dp conservative, as intended).
const TV_VIEWPORT_DP = 540
const EMOJI_LINE_BOX = 1.44
const LATIN_LINE_BOX = 1.17
const lineBox = (fontSize: number, ratio: number) => Math.ceil(fontSize * ratio)

interface Tile { borderWidth: number; paddingVertical: number; glyphSize: number; labelMarginTop: number; labelSize: number }
interface Rail { paddingVertical: number; gap: number }

/** Height of `n` stacked tiles plus the content container's own padding and gaps. */
function railHeight (tile: Tile, railBox: Rail, n: number) {
  const entryH =
    2 * tile.borderWidth +
    2 * tile.paddingVertical +
    lineBox(tile.glyphSize, EMOJI_LINE_BOX) +
    tile.labelMarginTop +
    lineBox(tile.labelSize, LATIN_LINE_BOX)
  return 2 * railBox.paddingVertical + n * entryH + (n - 1) * railBox.gap
}

/** Pull the real numbers out of a rendered rail — no style literals restated here. */
function measure (tree: RendererInstance): { tile: Tile; railBox: Rail; count: number } {
  const { scrollers, entries } = rail(tree)
  const entry = StyleSheet.flatten(entries[0].props.style)
  const railBox = StyleSheet.flatten(scrollers[0].props.contentContainerStyle)
  // The two Texts are told apart by their own styles, not by index: the label is the
  // one carrying the tile's letterSpacing/marginTop, the glyph is the bare fontSize.
  const texts = entries[0].findAllByType(Text).map(n => StyleSheet.flatten(n.props.style) as any)
  const label = texts.find(s => s?.letterSpacing != null)
  const glyph = texts.find(s => s?.letterSpacing == null)
  if (!label || !glyph) throw new Error('could not tell the tile glyph from its label')
  return {
    tile: {
      borderWidth: entry.borderWidth as number,
      paddingVertical: entry.paddingVertical as number,
      glyphSize: glyph.fontSize,
      labelMarginTop: label.marginTop,
      labelSize: label.fontSize
    },
    railBox: { paddingVertical: railBox.paddingVertical as number, gap: (railBox as any).gap },
    count: entries.length
  }
}

test('the default six-entry rail fits a 540dp TV viewport at rest', async () => {
  const tree = await mount()
  const { tile, railBox, count } = measure(tree)
  expect(count).toBe(6)

  // 496dp of 540 — about 44dp spare. This is the assertion the SALIR clip needed: it
  // fails the moment a hand-tune (SCALE, the tile padding, the glyph, the label margin)
  // pushes the default rail back below the fold.
  expect(railHeight(tile, railBox, count)).toBeLessThanOrEqual(TV_VIEWPORT_DP)

  // NOT asserted: seven entries (VOD enabled) measure 571dp and legitimately overflow.
  // That case is what the ScrollView is here for, and pinning it would be a guard
  // against the wrong thing — see the tvRail comment in MenuScreen.
})

test('the same arithmetic rejects the tile that shipped the clip', async () => {
  // The pre-fix TV styles, from the device measurement in the tv-menu-rail-fit commit:
  // the glyph, the label margin and the border were all OFF the density ramp, so the
  // tile stood at 86dp and six of them plus padding and gaps came to 602dp.
  const preFix: Tile = { borderWidth: 3, paddingVertical: 11, glyphSize: 25, labelMarginTop: 8, labelSize: 12 }
  const preFixRail: Rail = { paddingVertical: 28, gap: 6 }

  // 608dp by this model against 602dp measured — the ceil()s round up, deliberately.
  // Either way it is well past the fold, which is the point: had this guard existed,
  // the rail could not have shipped clipped.
  expect(railHeight(preFix, preFixRail, 6)).toBeGreaterThan(TV_VIEWPORT_DP)

  // And the guard is not merely rejecting everything — the shipped tile passes it.
  const tree = await mount()
  const { tile, railBox } = measure(tree)
  expect(railHeight(tile, railBox, 6)).toBeLessThan(railHeight(preFix, preFixRail, 6))
})
