// "Sign in a TV", SENDING half — opened from Settings on a phone that is already signed
// in (sdk/signin-pair.js). The viewer types the twelve characters the TV shows, answers
// ONE question, and carries four digits back to the remote. What crosses is the
// account's key material, not this phone's session: the TV registers its OWN device id
// and takes its OWN panel-signed token, so the operator's device list and per-device
// revocation keep working exactly as they do for a typed password.
//
// THE QUESTION IS THE FEATURE. Both devices show the same four digits, and the viewer
// confirms HERE that the TV shows them too. A peer relaying between this phone and that
// TV holds the code, so it satisfies every proof in the exchange — but it terminates two
// connections with two transcripts and cannot make two screens agree. So "no" is the one
// answer in the whole flow that sees it, and it is not a retry prompt: it means
// something answered in the middle, and the next attempt does not belong on the same
// network. The two buttons are the same size and the same weight for that reason: no
// default, and no styling that leans on either of them.
//
// The four digits this screen then shows are a DIFFERENT check, against a different
// attacker: a printed code or a forwarded screenshot with no real TV in the session at
// all. They have to be typed into a device that is actually here. One attempt.
//
// Nothing on this path is logged: the code, the compared digits and the drawn digits
// are live secrets for the length of the exchange.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import type { SigninPairInfo } from '@aliran/react-native'
import { useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { PAIRING_GROUPS, PAIRING_GROUP_SIZE, cleanPairingInput } from '../config'
import { signinFailureText, signinRefusalText } from './signinFailure'
import { theme } from '../theme'

// A step from a FINISHED exchange must not paint a fresh sheet; sendSignIn() clears the
// SDK's cache, and this makes reading it at mount safe either way.
function live (info: SigninPairInfo | null): SigninPairInfo | null {
  if (!info || info.state === 'failed' || info.state === 'sent' || info.state === 'signed-in') return null
  return info
}

export interface SendSignInToTvProps {
  onClose: () => void
}

export function SendSignInToTv ({ onClose }: SendSignInToTvProps) {
  const { t } = useI18n()
  const [groups, setGroups] = useState<string[]>(() => Array(PAIRING_GROUPS).fill(''))
  const [info, setInfo] = useState<SigninPairInfo | null>(() => live(backend.signinPhone))
  // A refusal of the SEND itself — a malformed code, no session on this device, or a
  // build that never opted into remote.sendToTv. The exchange's own failures arrive as
  // {state:'failed'}.
  const [sendError, setSendError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The viewer answered the comparison; the engine has not moved on yet. Without it the
  // two buttons stay live and invite a second press at the one step where a second press
  // must never mean anything.
  const [answered, setAnswered] = useState(false)
  const [focused, setFocused] = useState<string | null>(null)
  const groupRefs = useRef<Array<TextInput | null>>([])
  const finished = useRef(false)

  useEffect(() => {
    const off = backend.onSignInPair((m) => {
      if (m.role !== 'phone') return
      if (m.state === 'sent' || m.state === 'failed') finished.current = true
      if (m.state === 'pin') setAnswered(false)
      setInfo(m)
    })
    return () => {
      off()
      // Closing the sheet gives up. The TV's code is spent either way, so the honest
      // thing is to tell the TV now rather than leave it counting down.
      if (!finished.current) backend.cancelSendSignIn()
    }
  }, [])

  // A group fills up -> jump to the next one; deleting out of an empty one jumps back.
  // Twelve characters typed, and the viewer never touches focus (the Connect screen's
  // pattern, and the sign-in code uses the same alphabet).
  const onGroupChange = (i: number, raw: string) => {
    const v = cleanPairingInput(raw).slice(0, PAIRING_GROUP_SIZE)
    setGroups((prev) => prev.map((g, j) => (j === i ? v : g)))
    if (v.length === PAIRING_GROUP_SIZE && i < PAIRING_GROUPS - 1) groupRefs.current[i + 1]?.focus()
  }

  const onGroupKey = (i: number, key: string) => {
    if (key === 'Backspace' && !groups[i] && i > 0) groupRefs.current[i - 1]?.focus()
  }

  const submit = async () => {
    if (busy) return
    const code = groups.join('')
    if (code.length !== PAIRING_GROUPS * PAIRING_GROUP_SIZE) {
      setSendError(signinRefusalText(t, 'malformed'))
      return
    }
    setSendError(null)
    setBusy(true)
    const res = await backend.sendSignIn(code)
    setBusy(false)
    // A refusal of the send, not a failed exchange — catalog only (signinFailure.ts).
    if (!res.ok) setSendError(signinRefusalText(t, res.error))
  }

  const state = info?.state
  // The engine reports {state:'searching'} the moment it joins, which is BEFORE the
  // reply to sendSignIn() lands — so "is this exchange under way?" is the union of the
  // two, or the code-entry form would flash back for a frame in between.
  const running = busy || (state != null && !sendError)

  let body: React.ReactNode
  if (state === 'failed') {
    // Same vocabulary as the TV half, and the same rule — see signinFailure.ts.
    body = (
      <>
        <Text style={styles.error}>{signinFailureText(t, info?.reason, info?.message)}</Text>
        <Row><Button label={t('common.close')} onPress={onClose} /></Row>
      </>
    )
  } else if (state === 'sent') {
    body = (
      <>
        <Text style={styles.big}>{t('sendtv.phone.sent')}</Text>
        <Row><Button label={t('common.ok')} onPress={onClose} primary /></Row>
      </>
    )
  } else if (state === 'pin') {
    body = (
      <>
        <Text style={styles.digits}>{info?.pin ?? '––––'}</Text>
        <Text style={styles.hint}>{t('sendtv.phone.pinHint')}</Text>
        <Row><Button label={t('common.cancel')} onPress={onClose} /></Row>
      </>
    )
  } else if (state === 'match' && !answered) {
    // THE ANTI-RELAY CHECK. Never defaulted, never inferred from a dismissed sheet, and
    // never answered by a "skip": only these two buttons answer it. They are the same
    // size AND the same weight — neither carries `primary`, the accent border every other
    // step's affirmative wears. This is the one step whose whole purpose is making "no"
    // easy to give, so nothing here may point at "yes"; the TV's own confirm-service
    // question does the same thing by starting focus on "No".
    body = (
      <>
        <Text style={styles.subheading}>{t('sendtv.phone.matchTitle')}</Text>
        <Text style={styles.digits}>{info?.sas ?? '––––'}</Text>
        <Text style={styles.hint}>{t('sendtv.phone.matchHint')}</Text>
        <Text style={styles.warn}>{t('sendtv.phone.matchWarn')}</Text>
        <Row>
          <Button label={t('sendtv.phone.matchNo')} onPress={() => { setAnswered(true); backend.confirmSignInMatch(false) }} />
          <Button label={t('sendtv.phone.matchYes')} onPress={() => { setAnswered(true); backend.confirmSignInMatch(true) }} />
        </Row>
      </>
    )
  } else if (running) {
    body = (
      <>
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text style={styles.hint}>{state && state !== 'searching' ? t('sendtv.phone.linked') : t('sendtv.phone.searching')}</Text>
        <Row><Button label={t('common.cancel')} onPress={onClose} /></Row>
      </>
    )
  } else {
    body = (
      <>
        <Text style={styles.hint}>{t('sendtv.phone.codeHint')}</Text>
        <View style={styles.groups}>
          {groups.map((g, i) => (
            <TextInput
              key={i}
              ref={(r) => { groupRefs.current[i] = r }}
              style={[styles.groupInput, focused === 'g' + i && styles.groupInputFocused]}
              placeholder="––––"
              placeholderTextColor={theme.colors.textDim}
              accessibilityLabel={t('sendtv.phone.groupAria', { n: i + 1, total: PAIRING_GROUPS })}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={PAIRING_GROUP_SIZE}
              autoFocus={i === 0}
              value={g}
              onChangeText={(v) => onGroupChange(i, v)}
              onKeyPress={(e) => onGroupKey(i, e.nativeEvent.key)}
              onFocus={() => setFocused('g' + i)}
              onBlur={() => setFocused(null)}
            />
          ))}
        </View>
        {sendError && <Text style={styles.error}>{sendError}</Text>}
        <Row>
          <Button label={t('common.cancel')} onPress={onClose} />
          <Button label={t('common.ok')} onPress={submit} primary disabled={busy} />
        </Row>
      </>
    )
  }

  // An overlay, not a Modal — a sibling of the settings ScrollView, for the same reason
  // the language picker is one (a Modal is its own focus container on TV).
  return (
    <View style={styles.overlay}>
      <View style={styles.panel}>
        <Text style={styles.heading}>{t('settings.sendTv')}</Text>
        {body}
      </View>
    </View>
  )
}

function Row ({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>
}

function Button ({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.btn, primary && styles.btnPrimary, focused && styles.btnFocused, disabled && styles.btnDisabled]}
      accessibilityRole="button"
      accessibilityLabel={label}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={disabled ? undefined : onPress}
    >
      <Text style={[styles.btnText, focused && styles.btnTextFocused]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.overlayStrong, alignItems: 'center', justifyContent: 'center', padding: theme.spacing(1) },
  panel: {
    width: '90%', maxWidth: 520, backgroundColor: theme.colors.surface, borderRadius: 14,
    paddingVertical: theme.spacing(1.5), paddingHorizontal: theme.spacing(1.5), alignItems: 'center'
  },
  heading: {
    color: theme.colors.onPrimary, backgroundColor: theme.colors.primary,
    fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2,
    paddingHorizontal: theme.spacing(1), paddingVertical: theme.spacing(0.75),
    borderRadius: 8, marginBottom: theme.spacing(1), overflow: 'hidden', textAlign: 'center'
  },
  subheading: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '800', textAlign: 'center', marginBottom: theme.spacing(0.5) },
  digits: {
    color: theme.colors.accent, fontSize: theme.type.display + 8, fontWeight: '800',
    letterSpacing: 8, fontVariant: ['tabular-nums'], textAlign: 'center', marginVertical: theme.spacing(0.5)
  },
  big: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700', textAlign: 'center', marginBottom: theme.spacing(0.5) },
  hint: { color: theme.colors.textDim, fontSize: theme.type.body, lineHeight: 22, textAlign: 'center', marginBottom: theme.spacing(0.5) },
  warn: { color: theme.colors.text, fontSize: theme.type.caption, lineHeight: 18, textAlign: 'center', marginBottom: theme.spacing(0.5) },
  error: { color: theme.colors.live, fontSize: theme.type.body, lineHeight: 22, textAlign: 'center', marginBottom: theme.spacing(0.5) },
  groups: { flexDirection: 'row', gap: 10, marginVertical: theme.spacing(0.5) },
  groupInput: {
    width: 96, paddingHorizontal: 8, paddingVertical: 10, textAlign: 'center',
    backgroundColor: theme.colors.background, color: theme.colors.text, borderRadius: 10,
    fontSize: 24, letterSpacing: 2, borderWidth: 2, borderColor: 'transparent'
  },
  groupInputFocused: { borderColor: theme.colors.focus },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: theme.spacing(0.75), marginTop: theme.spacing(0.75) },
  btn: {
    minWidth: 120, alignItems: 'center', borderRadius: 10, paddingVertical: 12, paddingHorizontal: theme.spacing(1),
    backgroundColor: theme.colors.background, borderWidth: 2, borderColor: 'transparent'
  },
  btnPrimary: { borderColor: theme.colors.focus },
  btnFocused: { backgroundColor: theme.colors.focus, borderColor: theme.colors.focus },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' },
  btnTextFocused: { color: theme.colors.background }
})
