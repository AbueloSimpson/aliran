// Far-left category rail (vertical text list). Two-level: at the top level it lists the
// categories (a "›" marks ones with sub-categories); tapping such a category DRILLS in —
// the rail then shows a pinned "‹ Parent" back header with the parent's sub-categories
// scrolling beneath it, and picking a sub scopes the channel list. Selected = accent
// underline (the reference's focus grammar). On TV, focusing a name selects it; on phone,
// tap. The drill state itself lives in LiveScreen; this component just renders what it's
// given (items + optional parent header).
import React, { useState } from 'react'
import { View, ScrollView, Text, Pressable, StyleSheet, Platform } from 'react-native'
import { theme } from '../theme'

export interface CategoryRailItem {
  /** Full category key ('All' | 'Anime' | 'Anime/Español'). */
  key: string
  /** Display text (top-level name, or the sub's leaf label). */
  label: string
  /** Top-level category that has sub-categories → show a drill-in "›". */
  hasChildren?: boolean
}

export interface CategoryRailProps {
  items: CategoryRailItem[]
  selected: string
  /** When drilled into a parent, its name + a back action, pinned above the scroll. */
  parentHeader?: { label: string; onBack: () => void }
  onSelect: (key: string) => void
  /** Fired on user interaction (item focus / press / scroll) to defer the auto-hide timer. */
  onActivity?: () => void
}

export function CategoryRail ({ items, selected, parentHeader, onSelect, onActivity }: CategoryRailProps) {
  return (
    <View style={styles.rail}>
      {parentHeader && (
        <BackHeader label={parentHeader.label} onBack={parentHeader.onBack} onActivity={onActivity} />
      )}
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} onScrollBeginDrag={onActivity}>
        {items.map((it) => (
          <RailItem
            key={it.key}
            label={it.label}
            hasChildren={it.hasChildren}
            active={it.key === selected}
            onSelect={() => onSelect(it.key)}
            onActivity={onActivity}
          />
        ))}
      </ScrollView>
    </View>
  )
}

function BackHeader ({ label, onBack, onActivity }: { label: string; onBack: () => void; onActivity?: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={styles.back}
      onFocus={() => { setFocused(true); onActivity?.() }}
      onBlur={() => setFocused(false)}
      onPress={() => { onActivity?.(); onBack() }}
    >
      <Text style={[styles.backText, focused && styles.labelActive]} numberOfLines={1}>‹ {label.toUpperCase()}</Text>
    </Pressable>
  )
}

function RailItem ({ label, hasChildren, active, onSelect, onActivity }: { label: string; hasChildren?: boolean; active: boolean; onSelect: () => void; onActivity?: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={styles.item}
      // Focus-selects is the TV D-pad behavior ONLY. On phone, Android's touch-mode
      // focus lands on a rail item right after a tap elsewhere in the rail and would
      // instantly revert the tapped selection.
      onFocus={() => { setFocused(true); onActivity?.(); if (Platform.isTV) onSelect() }}
      onBlur={() => setFocused(false)}
      onPress={() => { onActivity?.(); onSelect() }}
    >
      <View style={styles.itemRow}>
        <Text style={[styles.label, (active || focused) && styles.labelActive]} numberOfLines={1}>
          {label.toUpperCase()}
        </Text>
        {hasChildren && <Text style={[styles.chevron, (active || focused) && styles.labelActive]}>›</Text>}
      </View>
      <Text style={[styles.underline, active && styles.underlineActive]}> </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  rail: { flexGrow: 0 },
  scroll: { flexGrow: 0 },
  back: { paddingVertical: theme.isTV ? 10 : 8, paddingHorizontal: theme.spacing(1), marginBottom: theme.spacing(0.5) },
  backText: { color: theme.colors.accent, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 1 },
  item: { paddingVertical: theme.isTV ? 10 : 8, paddingHorizontal: theme.spacing(1) },
  itemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  label: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '700', letterSpacing: 1, flexShrink: 1 },
  chevron: { color: theme.colors.textDim, fontSize: theme.type.body, fontWeight: '800' },
  labelActive: { color: theme.colors.text },
  underline: { height: 3, marginTop: 4, borderRadius: 2, backgroundColor: 'transparent', alignSelf: 'flex-start', minWidth: 28 },
  underlineActive: { backgroundColor: theme.colors.accent }
})
