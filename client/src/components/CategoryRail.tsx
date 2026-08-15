// Far-left category rail (vertical text list). Two-level: at the top level it lists the
// categories (a "›" marks ones with sub-categories); OK/tap on such a category DRILLS
// in — the rail then shows a pinned "‹ Parent" back header with the parent's
// sub-categories scrolling beneath it, and OK on a sub scopes the channel list.
// Selected = a filled accent pill (onPrimary text); a merely-focused item gets the
// light focusFill pill — the same fill grammar the channel rows use. On TV the D-pad
// focus moves ONLY the focusFill pill: nothing is selected, scoped, or drilled until
// OK (the operator's ask — walking the rail must not redraw the channel list), so the
// accent pill stays where the last pick left it while the focus pill travels. On
// phone, tap. The drill state itself lives in LiveScreen; this component just renders
// what it's given (items + optional parent header).
import React, { useState } from 'react'
import { View, ScrollView, Text, Pressable, StyleSheet } from 'react-native'
import { getLocale } from '@aliran/i18n'
import { theme } from '../theme'

export interface CategoryRailItem {
  /** Full category key ('All' | 'Anime' | 'Anime/Español'). */
  key: string
  /** FINISHED display text, rendered verbatim — the host already applied the
   *  viewer-locale casing (LiveScreen's railItems memo; see the S56f note below). */
  label: string
  /** Top-level category that has sub-categories → show a drill-in "›". */
  hasChildren?: boolean
}

export interface CategoryRailProps {
  items: CategoryRailItem[]
  selected: string
  /** When drilled into a parent, its name + a back action, pinned above the scroll. */
  parentHeader?: { label: string; onBack: () => void }
  /**
   * ENTER this category — fired by OK (and by a tap on phone, which has no focus
   * step). Scoping the list, drilling into a parent's sub-categories: this is the
   * rail's ONE state-changing gesture. D-pad focus deliberately fires nothing —
   * walking the rail must be free: it has to pass parents without entering them,
   * and it must not re-scope the list on every stop (see the header note).
   */
  onActivate: (key: string) => void
  /** Fired on user interaction (item focus / press / scroll) to defer the auto-hide timer. */
  onActivity?: () => void
}

// The rail is MIXED copy: 'All' is ours and translated, every other label is the
// operator's own category name in the operator's language. There is no casing rule that
// is right for both, so the whole rail follows the VIEWER's locale (S56f decision) —
// a Turkish viewer's "i" upper-cases to "İ" everywhere on the surface, consistently.
// WHERE the casing happens moved (S56f, memo fix): item labels are cased by the
// HOST, inside LiveScreen's railItems useMemo (already keyed on the locale), and
// RailItem renders them verbatim — RailItem is React.memo'd with no locale
// subscription, and operator labels are locale-identical STRINGS, so a casing
// call in here froze the old locale's casing after a language switch (the memo
// never broke; only the translated 'All' changed). BackHeader below is unmemoized
// and keeps its own toLocaleUpperCase.
function CategoryRailInner ({ items, selected, parentHeader, onActivate, onActivity }: CategoryRailProps) {
  return (
    <View style={styles.rail}>
      {parentHeader && (
        <BackHeader label={parentHeader.label} onBack={parentHeader.onBack} onActivity={onActivity} />
      )}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} onScrollBeginDrag={onActivity}>
        {items.map((it) => (
          <RailItem
            key={it.key}
            itemKey={it.key}
            label={it.label}
            hasChildren={it.hasChildren}
            active={it.key === selected}
            onActivate={onActivate}
            onActivity={onActivity}
          />
        ))}
      </ScrollView>
    </View>
  )
}
export const CategoryRail = React.memo(CategoryRailInner)

function BackHeader ({ label, onBack, onActivity }: { label: string; onBack: () => void; onActivity?: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.back, focused && styles.pillFocused]}
      onFocus={() => { setFocused(true); onActivity?.() }}
      onBlur={() => setFocused(false)}
      onPress={() => { onActivity?.(); onBack() }}
    >
      <Text style={[styles.backText, focused && styles.textOnFill]} numberOfLines={1}>‹ {label.toLocaleUpperCase(getLocale())}</Text>
    </Pressable>
  )
}

function RailItemInner ({ itemKey, label, hasChildren, active, onActivate, onActivity }: { itemKey: string; label: string; hasChildren?: boolean; active: boolean; onActivate: (key: string) => void; onActivity?: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      // Pill precedence: ACTIVE wins (accent fill, onPrimary text) even while focused;
      // a focused-but-not-active item gets the light focusFill pill. On TV the accent
      // pill marks the last PICK and stays put while the focusFill pill tracks the
      // D-pad — two pills on screen is the correct reading, not a styling accident.
      style={[styles.item, active ? styles.pillActive : focused && styles.pillFocused]}
      // FOCUS ONLY HIGHLIGHTS, OK ENTERS. Focus once scoped the list on every stop
      // (and in its first shape even DRILLED — walking the D-pad down the rail
      // teleported the viewer into the first parent it passed; measured on a TCL set
      // going down from All). Both contracts are retired: a rail walk is free, and
      // the list, the drill, and the selection all wait for OK (LiveScreen
      // activateRail), so nothing beyond the focus pill redraws while the viewer is
      // merely traveling.
      onFocus={() => { setFocused(true); onActivity?.() }}
      onBlur={() => setFocused(false)}
      onPress={() => { onActivity?.(); onActivate(itemKey) }}
    >
      <View style={styles.itemRow}>
        {/* Verbatim — the host cased it (see the S56f note above). */}
        <Text style={[styles.label, active ? styles.textOnAccent : focused && styles.textOnFill]} numberOfLines={1}>
          {label}
        </Text>
        {hasChildren && <Text style={[styles.chevron, active ? styles.textOnAccent : focused && styles.textOnFill]}>›</Text>}
      </View>
    </Pressable>
  )
}
const RailItem = React.memo(RailItemInner)

// Phone metrics one notch tighter (~15%, S22 round 3 — the side panel read too
// large); TV keeps the 10-foot values untouched.
const styles = StyleSheet.create({
  rail: { flexGrow: 0 },
  scroll: { flexGrow: 0 },
  // Curved-display phones (S22 Ultra) have a touch dead zone along the bottom edge:
  // without this, the rail's last item scrolls flush to the glass curve and cannot be
  // tapped. The pad lets the list scroll one item-height past the end, clear of it.
  scrollContent: { paddingBottom: theme.spacing(6) },
  // TV paddings ride the scale ramp with everything else (theme.ts SCALE).
  back: { borderRadius: 999, paddingVertical: theme.isTV ? theme.px(8) : 6, paddingHorizontal: theme.isTV ? theme.px(14) : 7, marginBottom: theme.spacing(0.5) },
  backText: { color: theme.colors.accent, fontSize: theme.isTV ? theme.type.label : theme.type.caption, fontWeight: '800', letterSpacing: 1 },
  // Pill metrics: the old rows carried an underline strip (3 + 4 margin) under wider
  // padding — the pill trades that for a marginVertical so the rail's total rhythm
  // (and its seat beside BackHeader) stays within a pixel of where it was, on BOTH
  // form factors. The phone rail pane is a fixed percentage width, so horizontal
  // padding is label width taken away — phone keeps it near the old spacing(1).
  item: { borderRadius: 999, paddingVertical: theme.isTV ? theme.px(8) : 6, paddingHorizontal: theme.isTV ? theme.px(14) : 7, marginVertical: theme.isTV ? theme.px(5) : 4 },
  pillActive: { backgroundColor: theme.colors.accent },
  pillFocused: { backgroundColor: theme.colors.focusFill },
  itemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  label: { color: theme.colors.textDim, fontSize: theme.isTV ? theme.type.label : theme.type.caption, fontWeight: '700', letterSpacing: 1, flexShrink: 1 },
  chevron: { color: theme.colors.textDim, fontSize: theme.isTV ? theme.type.body : theme.type.label, fontWeight: '800' },
  // onPrimary is the sanctioned "text on accent/primary/live fills" token. Brands with
  // a BRIGHT accent must ship a dark onPrimary for this pill to read (SolTV does:
  // #201204 on #FBBF24); the default theme's white-on-cyan is known-weak at 10 ft and
  // is a default-palette concern, not this component's — tokens only here.
  textOnAccent: { color: theme.colors.onPrimary },
  textOnFill: { color: theme.colors.focusFillText }
})
