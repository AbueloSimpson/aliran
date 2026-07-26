// "Report a problem" from the player (S51). One vertical column of focusable rows so
// a TV remote can drive it: pick a category (D-pad up/down + OK), then Send. There is
// deliberately NO free-text input — the report carries the channel being watched plus
// the engine's own diagnostics, which is the specific signal the operator needs; a
// keyboard is never required anywhere in the flow.
//
// The 'login' category is excluded here on purpose: this sheet only opens while a
// channel is playing, which means login worked. (The category still exists on the
// wire; the panel's login alert rule is unaffected.)

import React, { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { REPORT_CATEGORIES, REPORT_CATEGORY_LABELS, REPORT_CONSENT, type ReportCategory } from '@aliran/react-native'
import { backend } from '../worklet'
import { theme } from '../theme'

const PLAYER_CATEGORIES = REPORT_CATEGORIES.filter((c) => c !== 'login')

// Human text for every error code AliranPlayer.report() can answer with. A viewer
// must never be shown a wire code, and must never be told to retry into a closed
// door: 'unsupported' and the throttles all end with "nothing more to do".
export function reportMessage (error: string | undefined, retryAfter?: number): string {
  const mins = retryAfter ? Math.max(1, Math.round(retryAfter / 60)) : 10
  switch (error) {
    case undefined: return 'Thanks — your report was sent.'
    case 'cooldown':
    case 'locked': return `You already reported this. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`
    case 'unsupported': return "This service doesn't accept problem reports."
    case 'not-logged-in':
    case 'unauthorized':
    case 'expired': return 'Please sign in again, then report the problem.'
    case 'offline': return 'Not connected to the service right now — try again in a moment.'
    default: return "Couldn't send the report. Try again in a moment."
  }
}

export function ReportSheet ({ visible, channelTitle, onClose }: { visible: boolean; channelTitle?: string; onClose: () => void }) {
  const [category, setCategory] = useState<ReportCategory | null>(null)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  // Subscribe while open so a late 'report-result' (the engine may be dialing) still
  // lands, and so a closed sheet never holds a listener.
  useEffect(() => {
    if (!visible) return
    return backend.onMessage((m) => {
      if (m.type !== 'report-result') return
      setSending(false)
      setResult(reportMessage(m.ok ? undefined : (m.error ?? 'failed'), m.retryAfter))
    })
  }, [visible])

  // Fresh state per opening — a stale "thanks" over a new report would be a lie.
  useEffect(() => {
    if (visible) { setCategory(null); setSending(false); setResult(null) }
  }, [visible])

  function submit () {
    if (!category || sending) return
    setSending(true)
    setResult(null)
    backend.sendReport(category)
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <ScrollView style={styles.card} contentContainerStyle={styles.content}>
          <Text style={styles.title}>REPORT A PROBLEM</Text>
          {channelTitle ? <Text style={styles.channel}>{channelTitle}</Text> : null}

          {result
            ? (
              <>
                <Text style={styles.result}>{result}</Text>
                <FocusButton label="Close" onPress={onClose} primary autoFocus />
              </>
              )
            : (
              <>
                <Text style={styles.hint}>What went wrong?</Text>
                {PLAYER_CATEGORIES.map((c, i) => (
                  <CategoryRow
                    key={c}
                    label={REPORT_CATEGORY_LABELS[c]}
                    selected={category === c}
                    autoFocus={i === 0}
                    onPress={() => setCategory(c)}
                  />
                ))}

                <Text style={styles.consent}>{REPORT_CONSENT}</Text>

                <FocusButton
                  label={sending ? 'Sending…' : 'Send report'}
                  onPress={submit}
                  primary
                  disabled={!category || sending}
                />
                <FocusButton label="Cancel" onPress={onClose} />
              </>
              )}
        </ScrollView>
      </View>
    </Modal>
  )
}

function CategoryRow ({ label, selected, autoFocus, onPress }: { label: string; selected: boolean; autoFocus?: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.categoryRow, focused && styles.categoryRowFocused, selected && styles.categoryRowSelected]}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      hasTVPreferredFocus={autoFocus}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <Text style={styles.categoryMark}>{selected ? '●' : '○'}</Text>
      <Text style={styles.categoryLabel}>{label}</Text>
    </Pressable>
  )
}

function FocusButton ({ label, onPress, primary, disabled, autoFocus }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean; autoFocus?: boolean }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.button, primary && styles.buttonPrimary, focused && styles.buttonFocused, disabled && styles.buttonDisabled]}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={() => { if (!disabled) onPress() }}
      hasTVPreferredFocus={autoFocus}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.colors.overlayStrong, justifyContent: 'center', alignItems: 'center' },
  card: { width: '100%', maxWidth: 640, maxHeight: '90%', backgroundColor: theme.colors.surface, borderRadius: 12 },
  content: { padding: theme.spacing(2), gap: 8 },
  title: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2 },
  channel: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '600', marginBottom: theme.spacing(1) },
  hint: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1, marginTop: theme.spacing(1) },
  result: { color: theme.colors.text, fontSize: theme.type.body, marginBottom: theme.spacing(1.5) },
  consent: { color: theme.colors.textDim, fontSize: theme.type.caption, lineHeight: 18, marginTop: theme.spacing(1), marginBottom: theme.spacing(1) },
  categoryRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: theme.isTV ? 12 : 10, paddingHorizontal: 12, borderRadius: 8,
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  categoryRowFocused: { borderColor: theme.colors.focus },
  categoryRowSelected: { backgroundColor: theme.colors.background },
  categoryMark: { color: theme.colors.focus, fontSize: theme.type.body },
  categoryLabel: { color: theme.colors.text, fontSize: theme.type.body, flexShrink: 1 },
  button: {
    marginTop: theme.spacing(1), backgroundColor: theme.colors.background, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center',
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  buttonPrimary: { borderColor: theme.colors.focus },
  buttonFocused: { backgroundColor: theme.colors.focus, borderColor: theme.colors.focus },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' }
})
