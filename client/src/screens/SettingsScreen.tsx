// Settings — account, service info, live diagnostics (P2P source + peers + entitled
// channel count), "Report a problem", and sign out. Sign out clears the saved
// "remember me" credentials (D1) so the next boot lands on Login instead of
// auto-authorizing. Public (keyless) builds additionally get "Change service…" (S36):
// forget the runtime-entered panel key + sign-in and go back to the Connect screen —
// never offered when the key is baked into the APK (operator flavor).
//
// The report modal (S50c) is built for a TV REMOTE first: one vertical column of
// focusable rows, the category list up top so a viewer can report with four D-pad
// presses and no keyboard at all, and the optional note as the LAST input — every
// path to Submit skips straight past it. Nothing in it is a text-entry trap.
import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Modal, TextInput } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { REPORT_CATEGORIES, REPORT_CATEGORY_LABELS, REPORT_CONSENT, REPORT_TEXT_MAX, type ReportCategory } from '@aliran/react-native'
import { backend } from '../worklet'
import { hasBakedKey, loadServiceDescriptor } from '../config'
import { theme } from '../theme'

const service = loadServiceDescriptor()

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>

export function SettingsScreen ({ navigation }: Props) {
  const [username, setUsername] = useState<string | null>(backend.creds?.username ?? null)
  const [channels, setChannels] = useState(backend.streams.length)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [signOutFocused, setSignOutFocused] = useState(false)
  const [changeFocused, setChangeFocused] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportFocused, setReportFocused] = useState(false)
  // "Smooth zapping" (S21): user-facing switch for the engine's adjacent-channel
  // prefetch. null in prefs = never set -> the app default (off) applies.
  const [smoothZap, setSmoothZap] = useState<boolean>(backend.smoothZapping ?? false)

  useEffect(() => {
    backend.requestPrefs()
    return backend.onMessage((m) => {
      if (m.type === 'prefs') {
        setUsername(m.creds?.username ?? null)
        setSmoothZap(m.smoothZapping ?? false)
      }
      if (m.type === 'streams') setChannels(m.streams.length)
      if (m.type === 'status' && typeof m.peers === 'number') setPeers(m.peers)
      if (m.type === 'port' && m.source) setSource(m.source)
      if (m.type === 'source-changed') setSource(m.source)
    })
  }, [])

  function toggleSmoothZap () {
    const next = !smoothZap
    setSmoothZap(next) // optimistic; the worklet's 'prefs' reply confirms
    backend.setZapPrefetch(next)
  }

  function signOut () {
    backend.clearCredentials()
    backend.streams = [] // drop the session's display list; a fresh login rebuilds it
    navigation.reset({ index: 0, routes: [{ name: 'Login' }] })
  }

  // "Change service…" (public keyless flavor only): forget the runtime panel key AND
  // the sign-in (the credentials belong to that panel), then land on Connect. The
  // engine stays on the old panel until the next Connect submit — the worklet swaps
  // it wholesale when a different key arrives.
  function changeService () {
    backend.clearService()
    backend.clearCredentials()
    backend.streams = []
    navigation.reset({ index: 0, routes: [{ name: 'Connect' }] })
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.header}>SETTINGS</Text>

      <Text style={styles.groupTitle}>ACCOUNT</Text>
      <View style={styles.group}>
        <Row label="Signed in as" value={username ?? '—'} />
        <Row label="Entitled channels" value={String(channels)} />
      </View>

      <Text style={styles.groupTitle}>PLAYBACK</Text>
      <View style={styles.group}>
        <ToggleRow
          label="Smooth zapping"
          hint="Preloads nearby channels while you watch, so channel surfing starts instantly. Uses more data; pauses itself on metered connections or when your stream is struggling."
          value={smoothZap}
          onToggle={toggleSmoothZap}
        />
      </View>

      <Text style={styles.groupTitle}>SERVICE</Text>
      <View style={styles.group}>
        <Row label="Service" value={(hasBakedKey() ? service.name : backend.service?.name) ?? service.name} />
        <Row label="Panel key" value={panelKeyLabel()} />
        <Row label="Playback" value={service.hybrid?.mode ?? 'p2p-only'} />
      </View>

      <Text style={styles.groupTitle}>DIAGNOSTICS</Text>
      <View style={styles.group}>
        <Row label="Active source" value={source ? source.toUpperCase() : '—'} />
        <Row label="Peers" value={peers != null ? String(peers) : '—'} />
        <Pressable
          style={[styles.actionRow, reportFocused && styles.actionRowFocused]}
          onFocus={() => setReportFocused(true)}
          onBlur={() => setReportFocused(false)}
          onPress={() => setReportOpen(true)}
          accessibilityRole="button"
        >
          <View style={styles.toggleTexts}>
            <Text style={styles.rowLabel}>Report a problem</Text>
            <Text style={styles.toggleHint}>Tell the service what went wrong with a channel — no account details are sent.</Text>
          </View>
          <Text style={styles.actionChevron}>›</Text>
        </Pressable>
      </View>

      <ReportModal visible={reportOpen} onClose={() => setReportOpen(false)} />

      <Pressable
        style={[styles.signOut, signOutFocused && styles.signOutFocused]}
        onFocus={() => setSignOutFocused(true)}
        onBlur={() => setSignOutFocused(false)}
        onPress={signOut}
      >
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
      <Text style={styles.signOutHint}>Sign out forgets the saved sign-in on this device.</Text>

      {!hasBakedKey() && (
        <>
          <Pressable
            style={[styles.changeService, changeFocused && styles.changeServiceFocused]}
            onFocus={() => setChangeFocused(true)}
            onBlur={() => setChangeFocused(false)}
            onPress={changeService}
          >
            <Text style={styles.signOutText}>Change service…</Text>
          </Pressable>
          <Text style={styles.signOutHint}>Forgets this service's panel key and sign-in, then returns to the Connect screen.</Text>
        </>
      )}
    </ScrollView>
  )
}

// The service's panel key, truncated for the row: the baked key when the build ships
// one, else the runtime-entered service's key ('—' before the first Connect).
function panelKeyLabel (): string {
  const key = hasBakedKey() ? service.panelPubKey : backend.service?.panelPubKey
  return key ? key.slice(0, 16) + '…' : '—'
}

// Human text for every error code AliranPlayer.report() can answer with. A viewer
// must never be shown a wire code, and must never be told to retry into a closed
// door: 'unsupported' and the throttles all end with "nothing more to do".
function reportMessage (error: string | undefined, retryAfter?: number): string {
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

// "Report a problem" (S50c). One vertical column of focusable rows so a TV remote can
// drive it: pick a category (D-pad up/down + OK), optionally add a note, submit. The
// note is the LAST input and entirely skippable — a keyboard is never required.
function ReportModal ({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [category, setCategory] = useState<ReportCategory | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  // Subscribe while open so a late 'report-result' (the engine may be dialing) still
  // lands, and so a closed modal never holds a listener.
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
    if (visible) { setCategory(null); setText(''); setSending(false); setResult(null) }
  }, [visible])

  function submit () {
    if (!category || sending) return
    setSending(true)
    setResult(null)
    backend.sendReport(category, text.trim() || undefined)
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <ScrollView style={styles.modalCard} contentContainerStyle={styles.modalContent}>
          <Text style={styles.modalTitle}>REPORT A PROBLEM</Text>

          {result
            ? (
              <>
                <Text style={styles.modalResult}>{result}</Text>
                <FocusButton label="Close" onPress={onClose} primary autoFocus />
              </>
              )
            : (
              <>
                <Text style={styles.modalHint}>What went wrong?</Text>
                {REPORT_CATEGORIES.map((c, i) => (
                  <CategoryRow
                    key={c}
                    label={REPORT_CATEGORY_LABELS[c]}
                    selected={category === c}
                    autoFocus={i === 0}
                    onPress={() => setCategory(c)}
                  />
                ))}

                {/* LAST input, and skippable: the D-pad path from the categories to
                    Send passes over it, and nothing here requires typing. */}
                <Text style={styles.modalHint}>Add a note (optional)</Text>
                <TextInput
                  style={styles.modalInput}
                  value={text}
                  onChangeText={(t) => setText(t.slice(0, REPORT_TEXT_MAX))}
                  placeholder="What did you see?"
                  placeholderTextColor={theme.colors.textDim}
                  maxLength={REPORT_TEXT_MAX}
                  multiline
                  returnKeyType="done"
                  blurOnSubmit
                />

                <Text style={styles.modalConsent}>{REPORT_CONSENT}</Text>

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
      style={[styles.modalButton, primary && styles.modalButtonPrimary, focused && styles.modalButtonFocused, disabled && styles.modalButtonDisabled]}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={() => { if (!disabled) onPress() }}
      hasTVPreferredFocus={autoFocus}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
    >
      <Text style={styles.modalButtonText}>{label}</Text>
    </Pressable>
  )
}

function Row ({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
    </View>
  )
}

// Focusable settings switch (phone tap + TV d-pad select). Rendered as a pill so the
// state reads at TV distance; the hint explains the data cost per the S21 brief.
function ToggleRow ({ label, hint, value, onToggle }: { label: string; hint: string; value: boolean; onToggle: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.toggleRow, focused && styles.toggleRowFocused]}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
    >
      <View style={styles.toggleTexts}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.toggleHint}>{hint}</Text>
      </View>
      <View style={[styles.togglePill, value && styles.togglePillOn]}>
        <Text style={[styles.togglePillText, value && styles.togglePillTextOn]}>{value ? 'ON' : 'OFF'}</Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: theme.safeX, paddingVertical: theme.safeY, maxWidth: 720, alignSelf: 'stretch' },
  header: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1.5) },
  groupTitle: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2, marginTop: theme.spacing(1.5), marginBottom: 6 },
  group: { backgroundColor: theme.colors.surface, borderRadius: 10, paddingHorizontal: theme.spacing(1.5), paddingVertical: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: theme.isTV ? 12 : 10, gap: 16 },
  rowLabel: { color: theme.colors.textDim, fontSize: theme.type.body },
  rowValue: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '600', flexShrink: 1 },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    paddingVertical: theme.isTV ? 12 : 10, borderRadius: 8,
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  toggleRowFocused: { borderColor: theme.colors.focus },
  toggleTexts: { flex: 1, gap: 4 },
  toggleHint: { color: theme.colors.textDim, fontSize: theme.type.caption, lineHeight: 18 },
  togglePill: {
    minWidth: 64, alignItems: 'center', borderRadius: 999,
    paddingVertical: 6, paddingHorizontal: 14, backgroundColor: theme.colors.background
  },
  togglePillOn: { backgroundColor: theme.colors.focus },
  togglePillText: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1 },
  togglePillTextOn: { color: theme.colors.background },
  signOut: {
    marginTop: theme.spacing(2.5), backgroundColor: theme.colors.surface, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center', borderWidth: Math.max(theme.focusRing, 1), borderColor: theme.colors.live
  },
  signOutFocused: { backgroundColor: theme.colors.live, borderColor: theme.colors.focus },
  signOutText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' },
  signOutHint: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 8 },
  changeService: {
    marginTop: theme.spacing(2), backgroundColor: theme.colors.surface, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center', borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  changeServiceFocused: { borderColor: theme.colors.focus, backgroundColor: theme.colors.background },
  // "Report a problem" row (same metrics as ToggleRow, with a chevron instead of a pill)
  actionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    paddingVertical: theme.isTV ? 12 : 10, borderRadius: 8,
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  actionRowFocused: { borderColor: theme.colors.focus },
  actionChevron: { color: theme.colors.textDim, fontSize: theme.type.body, fontWeight: '800' },
  // --- report modal ---
  modalBackdrop: { flex: 1, backgroundColor: theme.colors.overlayStrong, justifyContent: 'center', alignItems: 'center' },
  modalCard: { width: '100%', maxWidth: 640, maxHeight: '90%', backgroundColor: theme.colors.surface, borderRadius: 12 },
  modalContent: { padding: theme.spacing(2), gap: 8 },
  modalTitle: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1) },
  modalHint: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1, marginTop: theme.spacing(1) },
  modalResult: { color: theme.colors.text, fontSize: theme.type.body, marginBottom: theme.spacing(1.5) },
  modalConsent: { color: theme.colors.textDim, fontSize: theme.type.caption, lineHeight: 18, marginTop: theme.spacing(1), marginBottom: theme.spacing(1) },
  modalInput: {
    color: theme.colors.text, fontSize: theme.type.body, minHeight: 72,
    textAlignVertical: 'top', backgroundColor: theme.colors.background, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  categoryRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: theme.isTV ? 12 : 10, paddingHorizontal: 12, borderRadius: 8,
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  categoryRowFocused: { borderColor: theme.colors.focus },
  categoryRowSelected: { backgroundColor: theme.colors.background },
  categoryMark: { color: theme.colors.focus, fontSize: theme.type.body },
  categoryLabel: { color: theme.colors.text, fontSize: theme.type.body, flexShrink: 1 },
  modalButton: {
    marginTop: theme.spacing(1), backgroundColor: theme.colors.background, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center',
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  modalButtonPrimary: { borderColor: theme.colors.focus },
  modalButtonFocused: { backgroundColor: theme.colors.focus, borderColor: theme.colors.focus },
  modalButtonDisabled: { opacity: 0.45 },
  modalButtonText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' }
})
