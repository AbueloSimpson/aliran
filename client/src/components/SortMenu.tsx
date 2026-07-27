// "SORT BY" picker for the Movies & Series grid (S54b, design D4 / mockup screen 3).
//
// Same shape as the live player's TrackMenu: a plain absolutely-positioned overlay (NOT
// an RN Modal — a Modal is its own focus container and on TV it swallows the remote),
// a dim backdrop that dismisses on press, and one focusable row per option. The active
// row is marked "SELECTED" on the right, exactly like the mockup.
//
// D-pad: the rows are the only focusables inside, and the CURRENT one asks for initial
// focus, so opening the menu lands the remote on the option already in force and Back
// (hardware) still leaves the screen.
import React, { useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Platform, TVFocusGuideView } from 'react-native'
import { VOD_SORTS, type VodSortKey } from '../vod/sort'
import { theme } from '../theme'

const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

export interface SortMenuProps {
  /** The sort currently in force — its row is the one marked SELECTED. */
  value: VodSortKey
  onSelect: (key: VodSortKey) => void
  onClose: () => void
}

export function SortMenu ({ value, onSelect, onClose }: SortMenuProps) {
  // Choosing a sort applies it AND dismisses: it is a one-shot action and leaving the
  // panel over the grid was the annoyance (same call as TrackMenu's).
  const choose = (key: VodSortKey) => { onSelect(key); onClose() }
  return (
    <View style={styles.overlay}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" onPress={onClose} />
      <FocusPane autoFocus style={styles.panel}>
        <Text style={styles.heading}>SORT BY</Text>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {VOD_SORTS.map((o) => (
            <Row key={o.key} label={o.label} active={o.key === value} onPress={() => choose(o.key)} />
          ))}
        </ScrollView>
      </FocusPane>
    </View>
  )
}

function Row ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.row, (active || focused) && styles.rowActive]}
      accessibilityRole="button"
      hasTVPreferredFocus={active}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={[styles.rowLabel, active && styles.rowLabelActive]} numberOfLines={1}>{label}</Text>
      {active && <Text style={styles.selected}>SELECTED</Text>}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  panel: {
    width: '64%', maxWidth: 460, maxHeight: '82%',
    backgroundColor: theme.colors.overlayStrong, borderRadius: 14,
    paddingVertical: theme.spacing(1.5), paddingHorizontal: theme.spacing(1.5)
  },
  content: { paddingBottom: theme.spacing(1) },
  // The mockup's orange header bar — brand primary here, so a white-label build keeps
  // its own colour (no literal ever enters client/src outside theme.ts).
  heading: {
    color: theme.colors.onPrimary, backgroundColor: theme.colors.primary,
    fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2,
    paddingHorizontal: theme.spacing(1), paddingVertical: theme.spacing(0.75),
    borderRadius: 8, marginBottom: theme.spacing(1), overflow: 'hidden'
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: theme.spacing(1), paddingVertical: theme.spacing(1), paddingHorizontal: theme.spacing(1),
    borderRadius: 10, marginTop: theme.spacing(0.5)
  },
  rowActive: { backgroundColor: theme.colors.surface },
  rowLabel: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '600', flexShrink: 1 },
  rowLabelActive: { color: theme.colors.accent },
  selected: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1 }
})
