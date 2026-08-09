// Parental-PIN dialogs (RN twin of desktop's components/PinModal.tsx; the modal
// shell follows ReportSheet). Verification is a worklet round-trip
// (backend.parentalVerify) — the digest never crosses into the RN layer.
//   <PinEntryModal>  one field, verified against the stored PIN — gates tuning a
//                    restricted channel and confirms parental-settings changes.
//   <PinSetupModal>  new PIN + confirmation (plus the current PIN when changing).
// Numeric keyboard on phone; the TextInputs are focusable for the TV remote.

import React, { useEffect, useRef, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { getLocale, useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { validPinFormat } from '../parental'
import { theme } from '../theme'

// Both dialogs hold the FAILURE, not its sentence: the copy is looked up at render
// through t('pin.error.' + …), so a language change repaints an error already on the
// card. Every one of these is our own copy — nothing here comes from the worklet.
type PinError = 'wrong' | 'format' | 'mismatch' | 'wrongCurrent'

function PinField ({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [focused, setFocused] = useState(false)
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, focused && styles.inputFocused]}
        value={value}
        onChangeText={(v) => onChange(v.replace(/\D/g, ''))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        secureTextEntry
        keyboardType="number-pad"
        maxLength={8}
        autoFocus={autoFocus}
      />
    </View>
  )
}

function ModalButton ({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.btn, primary && styles.btnPrimary, focused && styles.btnFocused, disabled && styles.btnDisabled]}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={disabled ? undefined : onPress}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  )
}

export function PinEntryModal ({ visible, title, hint, onOk, onClose }: {
  visible: boolean
  title: string
  hint?: string
  /** Called after the entered PIN verified against the stored one (worklet round-trip). */
  onOk: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [pin, setPin] = useState('')
  const [error, setError] = useState<PinError | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    if (visible) { setPin(''); setError(null); busy.current = false }
  }, [visible])

  async function submit () {
    if (busy.current || pin.length < 4) return
    busy.current = true
    if (await backend.parentalVerify(pin)) { onOk(); return }
    busy.current = false
    setPin('')
    setError('wrong')
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{title.toLocaleUpperCase(getLocale())}</Text>
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
          <PinField label={t('pin.label')} value={pin} onChange={(v) => { setPin(v); setError(null) }} autoFocus />
          {error ? <Text style={styles.error}>{t('pin.error.' + error)}</Text> : null}
          <View style={styles.buttons}>
            <ModalButton label={t('common.cancel')} onPress={onClose} />
            <ModalButton label={t('common.ok')} onPress={submit} primary disabled={pin.length < 4} />
          </View>
        </View>
      </View>
    </Modal>
  )
}

export function PinSetupModal ({ visible, change, onDone, onClose }: {
  visible: boolean
  /** true = replace the existing PIN (asks for the current one first). */
  change?: boolean
  onDone: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<PinError | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    if (visible) { setCurrent(''); setNext(''); setConfirm(''); setError(null); busy.current = false }
  }, [visible])

  async function submit () {
    if (busy.current) return
    if (!validPinFormat(next)) { setError('format'); return }
    if (next !== confirm) { setError('mismatch'); setConfirm(''); return }
    busy.current = true
    if (change && !(await backend.parentalVerify(current))) {
      busy.current = false
      setCurrent('')
      setError('wrongCurrent')
      return
    }
    backend.parentalSetPin(next) // the worklet answers with the new prefs
    onDone()
  }

  const incomplete = next.length < 4 || confirm.length < 4 || (!!change && current.length < 4)
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{change ? t('pin.changeTitle') : t('pin.setupTitle')}</Text>
          <Text style={styles.hint}>
            {change ? t('pin.changeHint') : t('pin.setupHint')}
          </Text>
          {change ? <PinField label={t('pin.current')} value={current} onChange={(v) => { setCurrent(v); setError(null) }} autoFocus /> : null}
          <PinField label={t('pin.new')} value={next} onChange={(v) => { setNext(v); setError(null) }} autoFocus={!change} />
          <PinField label={t('pin.repeat')} value={confirm} onChange={(v) => { setConfirm(v); setError(null) }} />
          {error ? <Text style={styles.error}>{t('pin.error.' + error)}</Text> : null}
          <View style={styles.buttons}>
            <ModalButton label={t('common.cancel')} onPress={onClose} />
            <ModalButton label={t('common.save')} onPress={submit} primary disabled={incomplete} />
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.colors.overlayStrong, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 420, backgroundColor: theme.colors.surface, borderRadius: 14, padding: theme.spacing(2) },
  title: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2, marginBottom: 8 },
  hint: { color: theme.colors.textDim, fontSize: theme.type.caption, lineHeight: 18, marginBottom: 12 },
  field: { marginBottom: 12 },
  fieldLabel: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 0.5, marginBottom: 6 },
  input: {
    backgroundColor: theme.colors.background, color: theme.colors.text,
    borderRadius: 10, borderWidth: 2, borderColor: 'transparent',
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 20, letterSpacing: 8
  },
  inputFocused: { borderColor: theme.colors.focus },
  error: { color: theme.colors.live, fontSize: theme.type.caption, marginBottom: 8 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 4 },
  btn: {
    flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 12,
    backgroundColor: theme.colors.background, borderWidth: 2, borderColor: 'transparent'
  },
  btnPrimary: { borderColor: theme.colors.focus },
  btnFocused: { backgroundColor: theme.colors.focus },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' }
})
