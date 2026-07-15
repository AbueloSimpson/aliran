// Far-left category rail (vertical text list; mixes genres and provider groups —
// whatever the operator put in category[]). Selected category = accent underline,
// the reference's focus grammar for rails. On TV, focusing a name selects it (the
// channel list follows live); on phone, tap.
import React, { useState } from 'react'
import { ScrollView, Text, Pressable, StyleSheet, Platform } from 'react-native'
import { theme } from '../theme'

export interface CategoryRailProps {
  categories: string[]
  selected: string
  onSelect: (category: string) => void
}

export function CategoryRail ({ categories, selected, onSelect }: CategoryRailProps) {
  return (
    <ScrollView style={styles.rail} showsVerticalScrollIndicator={false}>
      {categories.map((c) => (
        <RailItem key={c} label={c} active={c === selected} onSelect={() => onSelect(c)} />
      ))}
    </ScrollView>
  )
}

function RailItem ({ label, active, onSelect }: { label: string; active: boolean; onSelect: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={styles.item}
      // Focus-selects is the TV D-pad behavior ONLY. On phone, Android's touch-mode
      // focus lands on a rail item right after a tap elsewhere in the rail and would
      // instantly revert the tapped selection.
      onFocus={() => { setFocused(true); if (Platform.isTV) onSelect() }}
      onBlur={() => setFocused(false)}
      onPress={onSelect}
    >
      <Text style={[styles.label, (active || focused) && styles.labelActive]} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
      <Text style={[styles.underline, active && styles.underlineActive]}> </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  rail: { flexGrow: 0 },
  item: { paddingVertical: theme.isTV ? 10 : 8, paddingHorizontal: theme.spacing(1) },
  label: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '700', letterSpacing: 1 },
  labelActive: { color: theme.colors.text },
  underline: { height: 3, marginTop: 4, borderRadius: 2, backgroundColor: 'transparent', alignSelf: 'flex-start', minWidth: 28 },
  underlineActive: { backgroundColor: theme.colors.accent }
})
