// Language picker for Settings (S56e, design D6).
//
// Same shape as SortMenu / TrackMenu: a plain absolutely-positioned overlay (NOT an RN
// Modal — a Modal is its own focus container and on TV it swallows the remote), a dim
// backdrop that dismisses on press, and one focusable row per option. The row already
// in force is marked SELECTED and asks for initial focus, so opening the menu lands the
// remote on the current language.
//
// The 14 language names are rendered in their OWN language and are never translated:
// nobody should have to read a foreign word to find their own language. That is also
// why they are not sorted at render time — SUPPORTED_LOCALES is the picker order.
import React, { useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Platform, TVFocusGuideView } from 'react-native'
import { SUPPORTED_LOCALES, resolveLocale, setLocale, useI18n, type Locale } from '@aliran/i18n'
import { deviceLocaleTag, pickLocale, serviceDefaultLocale } from '../i18n'
import { backend } from '../worklet'
import { theme } from '../theme'

const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

export interface LanguageMenuProps {
  /** The pinned language, or null while the app follows the device. */
  value: string | null
  onClose: () => void
}

export function LanguageMenu ({ value, onClose }: LanguageMenuProps) {
  const { t } = useI18n()
  // Both halves of a choice: repaint now (setLocale is synchronous and every screen
  // re-renders through useI18n) and persist in the worklet prefs. The 'prefs' reply
  // confirms; nothing here waits for it.
  const choose = (code: Locale | null) => {
    setLocale(code ? resolveLocale(code) : pickLocale(deviceLocaleTag(), serviceDefaultLocale()))
    backend.setLanguage(code)
    onClose()
  }
  return (
    <View style={styles.overlay}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" onPress={onClose} />
      <FocusPane autoFocus style={styles.panel}>
        <Text style={styles.heading}>{t('settings.group.language')}</Text>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {/* "Device language" first: it is the default, and the only row whose label
              IS translated (it names a behavior, not a language). */}
          <Row label={t('settings.language.device')} active={value == null} onPress={() => choose(null)} />
          {SUPPORTED_LOCALES.map((l) => (
            <Row key={l.code} label={l.nativeName} active={l.code === value} onPress={() => choose(l.code)} />
          ))}
        </ScrollView>
      </FocusPane>
    </View>
  )
}

function Row ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { t } = useI18n()
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
      {active && <Text style={styles.selected}>{t('common.selected')}</Text>}
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
