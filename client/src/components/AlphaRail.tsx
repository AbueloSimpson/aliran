// The vertical A–Z rail down the right edge of the Movies & Series grid (S54b, D5 /
// mockup screen 1). Plain stacked letters, no boxes — only the letters the grid
// actually contains, and only while the ALPHABETICAL sort is in force.
//
// This component is deliberately presentational: it renders letters and reports the
// one that was chosen. The jump itself (scrollToIndex over the grid, with the exact
// row math) belongs to the screen that owns the FlatList ref — see VodScreen.
//
// D-pad: the rail is its own focus zone (TVFocusGuideView on TV, a plain View on
// phone), so a remote crosses into it from the grid, moves up/down the letters and
// keeps its place when it comes back. On phone the letters are ordinary taps.
import React, { useState } from 'react'
import { View, Text, Pressable, StyleSheet, Platform, TVFocusGuideView } from 'react-native'
import { theme } from '../theme'

const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

/** Reserved width — the screen subtracts this from the grid before doing column math,
 *  so turning the rail on never re-flows a tile off the right edge. */
export const ALPHA_RAIL_W = theme.isTV ? 44 : 26

export interface AlphaRailProps {
  /** Bucket letters, in grid order (letterBuckets() from src/vod/sort). */
  letters: readonly string[]
  /** The letter of the first visible tile — highlighted as the grid scrolls. */
  active: string
  onSelect: (letter: string) => void
}

export function AlphaRail ({ letters, active, onSelect }: AlphaRailProps) {
  if (letters.length === 0) return null
  return (
    <FocusPane style={styles.rail}>
      {letters.map((l) => (
        <Letter key={l} letter={l} active={l === active} onPress={() => onSelect(l)} />
      ))}
    </FocusPane>
  )
}

function Letter ({ letter, active, onPress }: { letter: string; active: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={styles.hit}
      accessibilityRole="button"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={[styles.letter, active && styles.letterActive, focused && styles.letterFocused]}>{letter}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  rail: { width: ALPHA_RAIL_W, alignItems: 'center', justifyContent: 'space-around', paddingVertical: theme.spacing(0.5) },
  // A letter glyph is a tiny target on a phone — the Pressable is wider than the text.
  hit: { width: '100%', alignItems: 'center', paddingVertical: 1 },
  letter: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '700', letterSpacing: 1 },
  letterActive: { color: theme.colors.accent },
  letterFocused: { color: theme.colors.text }
})
