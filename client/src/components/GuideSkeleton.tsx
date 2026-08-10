// Guide skeleton frame (WS17 — S22 round 7: "touch the guide and it opens to the
// guide loading but the frame is there"): the cheap, STATIC placeholder LiveScreen
// mounts in the guide's bed while the real GuidePanel waits for the deferred mount
// (useMountDeferred). It echoes the panel's exact phone geometry — the header
// silhouette (grey chip pills + the search chip spot), the REAL TimeBar (times are
// known synchronously, so rendering them buys authenticity for free), and a column
// of skeleton rows (grey logo box in the PH_COL_W channel column + the shared
// SkeletonCells strip) — so the swap to the real grid is seamless: the frame stays,
// the content pops in. NO animation on purpose: a shimmer would jank the very
// transition this frame exists to smooth (and reduced-motion is moot when nothing
// moves). Every color is a theme surface/overlay token; no strings (imagery only —
// nothing to translate). Metrics import from GuidePanel/guide rather than being
// duplicated, so a density retune there re-shapes this frame automatically.
import React, { useState } from 'react'
import { View, StyleSheet } from 'react-native'
import {
  TimeBar, SkeletonCells,
  PH_COL_W, PH_LOGO_W, PH_LOGO_H, PH_ROW_INNER_H, PH_ROW_MB
} from './GuidePanel'
import { GUIDE_SLOTS, GUIDE_WINDOW_MIN, MIN_CELL_W, snapToNow } from '../guide'
import { theme } from '../theme'

// ~10 rows reads as a full guide on the 8-12-channel phone grid; the row column
// clips at the bed's bottom edge, so an overshoot on short screens is invisible.
export const SKELETON_ROW_COUNT = 10

// Header pill silhouettes — a few category chips' worth of grey, then the search
// chip spot pinned right (the real header's layout: chips flex, search at the end).
const CHIP_WIDTHS = [52, 72, 60, 80]

export function GuideSkeleton () {
  // The same measured-width geometry as GuidePanel: the host decides how wide the
  // bed is; the strip spreads the slots over what remains beside the channel column
  // (same floor, so the pre-layout frame matches the panel's too).
  const [panelW, setPanelW] = useState(0)
  const stripW = Math.max(GUIDE_SLOTS * MIN_CELL_W, panelW - PH_COL_W)
  const pxPerMin = stripW / GUIDE_WINDOW_MIN
  const now = Date.now()

  return (
    <View style={styles.panel} onLayout={(e) => setPanelW(e.nativeEvent.layout.width)}>
      <View style={styles.headerRow}>
        <View style={styles.headerChips}>
          {CHIP_WIDTHS.map((w, i) => <View key={i} style={[styles.chipGhost, { width: w }]} />)}
        </View>
        <View style={[styles.chipGhost, styles.searchGhost]} />
      </View>
      {/* REAL times — the window grid is known synchronously (snapToNow), and an
          authentic time bar is what makes the frame read as "the guide, loading". */}
      <TimeBar windowStart={snapToNow(now)} nowMs={now} pxPerMin={pxPerMin} leadW={PH_COL_W} />
      <View style={styles.rows}>
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
          <View key={i} style={styles.row}>
            <View style={styles.chCol}>
              <View style={styles.numberGhost} />
              <View style={styles.logoGhost} />
            </View>
            <View style={[styles.strip, { width: stripW }]}>
              <SkeletonCells stripW={stripW} seed={i} />
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: { flex: 1 },
  // The real headerRow + chipsRow footprint (chips gap + the row's bottom padding).
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  headerChips: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.spacing(0.75), paddingBottom: theme.spacing(0.5) },
  // A chip's silhouette: the real chip is caption text inside 6px vertical padding
  // and a full-round border box — a surface-color pill of that height.
  chipGhost: { height: theme.type.caption + 14, borderRadius: 999, backgroundColor: theme.colors.surface },
  searchGhost: { width: 90, marginLeft: theme.spacing(0.75) },
  // Rows clip at the bed's bottom edge (short screens) instead of overflowing it.
  rows: { flex: 1, overflow: 'hidden' },
  // The real row geometry: PH_ROW_INNER_H + the 2px gap, transparent accent border.
  row: {
    flexDirection: 'row', alignItems: 'center', height: PH_ROW_INNER_H, marginBottom: PH_ROW_MB,
    borderLeftWidth: 3, borderLeftColor: 'transparent'
  },
  chCol: { width: PH_COL_W, alignItems: 'center', justifyContent: 'center', paddingRight: 4 },
  // The channel number line + the 16:9 logo box (the real chLogo box, surface bed).
  numberGhost: { width: 24, height: 8, borderRadius: 4, backgroundColor: theme.colors.surface },
  logoGhost: { width: PH_LOGO_W, height: PH_LOGO_H, borderRadius: 4, backgroundColor: theme.colors.surface, marginTop: 3 },
  strip: { height: PH_ROW_INNER_H, overflow: 'hidden' }
})
