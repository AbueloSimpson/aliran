// "Sign in with your phone", RECEIVING half — the screen a television shows while a
// phone that is already signed in hands this device an account (sdk/signin-pair.js).
// Mounted by LoginScreen (baked builds) and ConnectScreen (the public keyless build):
// those are the two places a device with no session lands.
//
// The whole point is that NO PASSWORD IS TYPED HERE. The TV shows twelve characters,
// the viewer types them on the phone, and then two checks run — in this order, because
// each one catches an attacker the other cannot:
//
//   1  COMPARE. Both screens show the same four digits. This screen only DISPLAYS them;
//      the viewer answers on the phone, which is the device that already holds the
//      account. A peer relaying between the two devices holds the code and therefore
//      satisfies every proof in the exchange, but it terminates two connections and
//      cannot make two screens agree — so this is the only check that sees it.
//   2  TYPE. The phone draws four random digits and the viewer keys them in here with
//      the remote. ONE attempt: a wrong entry ends the sign-in and the code is already
//      spent. That is what makes a blind guess one in ten thousand rather than a
//      warm-up, so there is deliberately no retry field.
//
// Then one more question, and it is not ceremony: the handover carries the operator's
// key, so a device that has never been paired learns its SERVICE here too. Nothing in
// the protocol authenticates the sender beyond knowledge of a code that was read off
// this screen, so the key is shown as the operator's printed 12-character code and is
// not adopted until a person says yes.
//
// D-PAD ONLY. Every control is a focusable Pressable — no gesture, no small target, and
// no key-event capture: react-native-tvos on Android does not dispatch HWEvents to
// useTVEventHandler while a view holds focus (the S7 lesson), so a digit stepper driven
// by up/down would simply not work. The digits go in through a row of ten keys instead,
// which is one focus move plus OK per digit and needs no on-screen keyboard.
//
// NOTHING HERE IS LOGGED. The code and both sets of digits are live secrets for the
// length of the exchange; they reach this component to be rendered and nothing else.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, Platform, ActivityIndicator, TVFocusGuideView, BackHandler } from 'react-native'
import type { SigninPairInfo } from '@aliran/react-native'
import { getLocale, useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { formatDuration } from '../catalog'
import { signinFailureText, signinRefusalText } from './signinFailure'
import { theme } from '../theme'

// On phone TVFocusGuideView is just a View; on TV autoFocus restores focus memory (S7).
const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
const PIN_LENGTH = 4

// A step from a FINISHED exchange must never paint a fresh screen. startSignIn() clears
// the SDK's cache anyway; this closes the frame before that lands, and it is what makes
// reading the cache at mount safe (a screen that re-mounts mid-exchange resumes; one
// that opens after a finished one starts clean).
function live (info: SigninPairInfo | null): SigninPairInfo | null {
  if (!info || info.state === 'failed' || info.state === 'signed-in' || info.state === 'sent') return null
  return info
}

export interface SignInWithPhoneProps {
  /** The viewer backed out, or the exchange ended and they closed it. */
  onClose: () => void
  /** The handover completed: the session is live and 'streams' has already fired.
   *  `panelPubKey` is the operator this device is now on — a keyless build persists it
   *  so the next start goes straight to the service instead of back to Connect. */
  onSignedIn: (panelPubKey: string | null) => void
}

export function SignInWithPhone ({ onClose, onSignedIn }: SignInWithPhoneProps) {
  const { t } = useI18n()
  // The engine's own step. Seeded from the SDK's cache so a screen that re-mounts
  // mid-exchange paints the step the engine is waiting on, not a blank one.
  const [info, setInfo] = useState<SigninPairInfo | null>(() => live(backend.signinTv))
  // A refusal of the START itself (a code is already showing, the engine is gone). The
  // exchange's own failures arrive as {state:'failed'} instead.
  const [startError, setStartError] = useState<string | null>(null)
  // The code and its expiry are held SEPARATELY from `info`: they arrive once, on the
  // 'code' state, and the very next state ('announced') carries neither — reading them
  // off the latest event would blank the code off the screen a moment after it appeared.
  const [shown, setShown] = useState<{ code: string; expiresAt: number } | null>(null)
  // The compared digits stay on screen through the typing step: the two checks read as
  // one screen to a viewer, and re-showing them costs nothing.
  const [sas, setSas] = useState<string | null>(null)
  const [pin, setPin] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  // Bumped by "Show a new code": a fresh code is a fresh exchange, so the effect below
  // re-runs rather than the screen being closed and re-opened by hand.
  const [attempt, setAttempt] = useState(0)
  const service = useRef<string | null>(null)
  const finished = useRef(false)

  // BACK. This is an overlay and NOT a Modal, on purpose (LoginScreen says why), so it gets
  // no onRequestClose and nothing else was catching the key: on a television BACK fell
  // straight through to the activity and closed the app to the launcher, mid-exchange, with
  // the code already spent. Measured on a TCL set-top box, and it was the only escape a
  // viewer could find from the dead OK button above.
  //
  // Deliberately IDENTICAL to Cancel rather than its own path: onClose() unmounts this
  // screen, and the unmount effect below is what cancels the exchange. Returning true stops
  // the key propagating, which is the whole point.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true })
    return () => sub.remove()
  }, [onClose])

  useEffect(() => {
    finished.current = false
    const off = backend.onSignInPair((m) => {
      if (m.role !== 'tv') return
      if (m.state === 'code' && m.code) setShown({ code: m.code, expiresAt: m.expiresAt ?? 0 })
      if (m.sas) setSas(m.sas)
      if (m.state === 'confirm-service') service.current = m.panelPubKey ?? null
      if (m.state === 'signed-in' || m.state === 'failed') finished.current = true
      setInfo(m)
    })
    // A code the viewer can read within a moment: this resolves as soon as the code
    // exists, and the rendezvous announce lands just after.
    backend.startSignIn().then((res) => {
      // A refusal of the start, not a failed exchange — catalog only (signinFailure.ts).
      if (!res.ok) setStartError(signinRefusalText(t, res.error))
    })
    return () => {
      off()
      // Leaving the screen ends the code — it is spent either way, and a code nobody is
      // looking at must not stay announced. Never after the exchange ended: the engine
      // has already let go, and a device that just adopted a service must not be told to
      // cancel anything.
      if (!finished.current) backend.cancelSignIn()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  const state = info?.state
  const showingCode = !startError && !!shown && (state === 'code' || state === 'announced')

  // Second by second, only while the code is on screen — the countdown is what tells a
  // viewer whether it is worth walking to the phone.
  useEffect(() => {
    if (!showingCode) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [showingCode])

  const heading = t('sendtv.tvStart').toLocaleUpperCase(getLocale())

  // Everything back to the start, then a new code. Bumping `attempt` re-runs the effect,
  // and its CLEANUP is what makes this safe from either failure: after an exchange the
  // engine has already let go and the cleanup's cancel is a no-op, while after a refused
  // START it may still be holding the handle that caused the refusal — and the cancel
  // clears it before the new code is asked for.
  const restart = () => {
    setInfo(null); setShown(null); setSas(null); setPin('')
    setSubmitted(false); setConfirming(false); setBusy(false); setStartError(null)
    service.current = null
    setAttempt((n) => n + 1)
  }

  if (startError) {
    // The same way out as a failed exchange, and for a reason: the likeliest refusal here
    // is a cancel followed straight away by a re-open, where the engine has not let go of
    // the last handle yet ("a sign-in code is already showing on this device"). Close and
    // re-open was the only recovery, which is exactly the move the viewer just made. This
    // button does it for them and does it properly: bumping `attempt` re-runs the effect,
    // whose cleanup cancels the stale code before the new start goes out.
    return (
      <Panel heading={heading}>
        <Text style={styles.error}>{startError}</Text>
        <Row>
          <Button label={t('sendtv.startAgain')} onPress={restart} focusFirst />
          <Button label={t('common.close')} onPress={onClose} />
        </Row>
      </Panel>
    )
  }

  if (state === 'failed') {
    // See signinFailure.ts: the reason picks the sentence, two of them are security
    // signals rather than retry prompts, and an unknown one still gets words.
    return (
      <Panel heading={heading}>
        <Text style={styles.error}>{signinFailureText(t, info?.reason, info?.message)}</Text>
        <Row>
          <Button label={t('sendtv.startAgain')} onPress={restart} focusFirst />
          <Button label={t('common.close')} onPress={onClose} />
        </Row>
      </Panel>
    )
  }

  if (state === 'signed-in') {
    return (
      <Panel heading={heading}>
        <Text style={styles.big}>{t('sendtv.signedIn')}</Text>
        <Row><Button label={t('common.ok')} onPress={() => onSignedIn(service.current)} focusFirst primary /></Row>
      </Panel>
    )
  }

  if (state === 'confirm-service' && !confirming) {
    // THE OPERATOR-KEY GATE. Shown as the operator's printed 12-character code, never as
    // 64 hex characters — a viewer can check a card, not a key. Focus starts on "No":
    // this is the last step before a device trusts a service with its whole catalog, and
    // a reflexive OK press must not be the thing that decides it.
    return (
      <Panel heading={t('sendtv.confirmTitle')}>
        <Field label={t('sendtv.confirmAccount')} value={info?.username ?? '—'} />
        <Field label={t('sendtv.confirmCode')} value={info?.pairingCode ?? (info?.panelPubKey ? info.panelPubKey.slice(0, 16) + '…' : '—')} big />
        {info?.adopting === true && <Text style={styles.hint}>{t('sendtv.confirmAdopt')}</Text>}
        <Text style={styles.hint}>{t('sendtv.confirmHint')}</Text>
        <Row>
          <Button label={t('sendtv.confirmNo')} onPress={() => { backend.confirmSignInService(false); onClose() }} focusFirst />
          {/* Yes hands the answer over and switches to "wait": adopting a service, finding
              its panel and logging in take real seconds, and the buttons must not stay
              live through them. */}
          <Button label={t('sendtv.confirmYes')} onPress={() => { setConfirming(true); backend.confirmSignInService(true) }} primary />
        </Row>
      </Panel>
    )
  }

  if (state === 'pin-entry' && !submitted) {
    const submit = async () => {
      if (busy || pin.length < PIN_LENGTH) return
      setBusy(true)
      // ONE attempt. A false answer means the engine had nothing waiting any more (the
      // exchange moved on or ended) — the 'failed' state says why, so nothing is
      // invented here.
      const ok = await backend.submitSignInPin(pin)
      setBusy(false)
      if (ok) setSubmitted(true)
      else setPin('')
    }
    return (
      <Panel heading={t('sendtv.pinTitle')}>
        {!!sas && <Text style={styles.compare}>{t('sendtv.matchStill', { digits: sas })}</Text>}
        <Text style={styles.hint}>{t('sendtv.pinHint')}</Text>
        <View style={styles.slots}>
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <Text key={i} style={[styles.slot, pin.length === i && styles.slotNext]}>{pin[i] ?? '–'}</Text>
          ))}
        </View>
        <View style={styles.keys}>
          {DIGITS.map((d, i) => (
            <Button
              key={d}
              label={d}
              wide={false}
              focusFirst={i === 0}
              onPress={() => setPin((p) => (p.length >= PIN_LENGTH ? p : p + d))}
            />
          ))}
        </View>
        <Row>
          <Button label={t('sendtv.pinDelete')} onPress={() => setPin((p) => p.slice(0, -1))} />
          <Button label={t('common.ok')} onPress={submit} primary disabled={pin.length < PIN_LENGTH || busy} />
          <Button label={t('common.cancel')} onPress={onClose} />
        </Row>
      </Panel>
    )
  }

  if (state === 'match') {
    // DISPLAY ONLY. This device gets no yes/no — the answer belongs on the phone, which
    // is the device the viewer already trusts and the one holding the account.
    return (
      <Panel heading={t('sendtv.matchTitle')}>
        <Text style={styles.digits}>{sas ?? '––––'}</Text>
        <Text style={styles.hint}>{t('sendtv.matchHint')}</Text>
        <Row><Button label={t('common.cancel')} onPress={onClose} focusFirst /></Row>
      </Panel>
    )
  }

  if (showingCode) {
    const left = shown.expiresAt ? Math.max(0, Math.round((shown.expiresAt - Date.now()) / 1000)) : 0
    return (
      <Panel heading={heading}>
        <Text style={styles.code}>{shown.code}</Text>
        <Text style={styles.hint}>{t('sendtv.codeHint')}</Text>
        {left > 0 && <Text style={styles.timer} key={tick}>{t('sendtv.expiresIn', { time: formatDuration(left) })}</Text>}
        <Row><Button label={t('common.cancel')} onPress={onClose} focusFirst /></Row>
      </Panel>
    )
  }

  // 'linked', 'received', an answered service question, a submitted PIN, and the moment
  // before the first event: one honest "wait" rather than five near-identical screens.
  const working = state === 'linked' || state === 'received' || submitted || confirming
  return (
    <Panel heading={heading}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
      <Text style={styles.hint}>{working ? t('sendtv.working') : t('sendtv.waiting')}</Text>
      <Row><Button label={t('common.cancel')} onPress={onClose} focusFirst /></Row>
    </Panel>
  )
}

// An overlay, not a Modal: on TV a Modal is its own focus container and swallows the
// remote (the SortMenu / TrackMenu / LanguageMenu lesson).
function Panel ({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <View style={styles.overlay}>
      <FocusPane autoFocus style={styles.panel}>
        <Text style={styles.heading}>{heading}</Text>
        {children}
      </FocusPane>
    </View>
  )
}

function Row ({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>
}

function Field ({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, big && styles.fieldValueBig]} numberOfLines={1}>{value}</Text>
    </View>
  )
}

function Button ({ label, onPress, primary, disabled, focusFirst, wide = true }: {
  label: string
  onPress: () => void
  primary?: boolean
  disabled?: boolean
  focusFirst?: boolean
  wide?: boolean
}) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.btn, wide && styles.btnWide, primary && styles.btnPrimary, focused && styles.btnFocused, disabled && styles.btnDisabled]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      // `disabled` used to reach only the STYLE and the handler, never the Pressable, so a
      // disabled button stayed FOCUSABLE: on a television the D-pad landed on it, it lit up
      // like a live control, and OK did nothing. Measured on a TCL set-top box — a viewer
      // part-way through the PIN pressed down, got the highlighted-but-dead OK, and had no
      // way forward. `disabled` on the Pressable takes it out of the focus path entirely,
      // so down from the keypad reaches Delete/Cancel, which are real. Cheaper to keep than
      // to explain: a control that lies is worse than an absent one.
      disabled={disabled}
      focusable={!disabled}
      hasTVPreferredFocus={focusFirst}
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
    width: '86%', maxWidth: theme.isTV ? 900 : 560,
    backgroundColor: theme.colors.surface, borderRadius: 14,
    paddingVertical: theme.spacing(1.5), paddingHorizontal: theme.spacing(2), alignItems: 'center'
  },
  heading: {
    color: theme.colors.onPrimary, backgroundColor: theme.colors.primary,
    fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2,
    paddingHorizontal: theme.spacing(1), paddingVertical: theme.spacing(0.75),
    borderRadius: 8, marginBottom: theme.spacing(1.25), overflow: 'hidden', textAlign: 'center'
  },
  // The code is read across a room, so it is the largest thing on the screen.
  code: {
    color: theme.colors.accent, fontSize: theme.type.display + (theme.isTV ? 14 : 4),
    fontWeight: '800', letterSpacing: theme.isTV ? 10 : 4, fontVariant: ['tabular-nums'],
    textAlign: 'center', marginBottom: theme.spacing(1)
  },
  digits: {
    color: theme.colors.accent, fontSize: theme.type.display + (theme.isTV ? 20 : 8),
    fontWeight: '800', letterSpacing: theme.isTV ? 16 : 8, fontVariant: ['tabular-nums'],
    textAlign: 'center', marginBottom: theme.spacing(1)
  },
  compare: { color: theme.colors.textDim, fontSize: theme.type.body, fontVariant: ['tabular-nums'], marginBottom: theme.spacing(0.75), textAlign: 'center' },
  big: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700', textAlign: 'center', marginBottom: theme.spacing(1) },
  hint: { color: theme.colors.textDim, fontSize: theme.type.body, lineHeight: theme.isTV ? 28 : 22, textAlign: 'center', marginTop: theme.spacing(0.5), marginBottom: theme.spacing(0.5) },
  timer: { color: theme.colors.textDim, fontSize: theme.type.caption, fontVariant: ['tabular-nums'], marginBottom: theme.spacing(0.5) },
  error: { color: theme.colors.live, fontSize: theme.type.body, lineHeight: theme.isTV ? 28 : 22, textAlign: 'center', marginBottom: theme.spacing(1) },
  field: { alignSelf: 'stretch', marginBottom: theme.spacing(0.75) },
  fieldLabel: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1 },
  fieldValue: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700' },
  fieldValueBig: { fontSize: theme.type.title, letterSpacing: 3, fontVariant: ['tabular-nums'] },
  slots: { flexDirection: 'row', gap: theme.spacing(1), marginVertical: theme.spacing(0.75) },
  slot: {
    minWidth: theme.isTV ? 64 : 44, textAlign: 'center',
    color: theme.colors.text, fontSize: theme.type.display, fontWeight: '800', fontVariant: ['tabular-nums'],
    backgroundColor: theme.colors.background, borderRadius: 10, paddingVertical: 4,
    borderWidth: 2, borderColor: 'transparent'
  },
  slotNext: { borderColor: theme.colors.focus },
  keys: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: theme.spacing(0.5), marginTop: theme.spacing(0.5) },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: theme.spacing(0.75), marginTop: theme.spacing(1) },
  btn: {
    minWidth: theme.isTV ? 72 : 52, alignItems: 'center', borderRadius: 10,
    paddingVertical: theme.isTV ? 12 : 10, paddingHorizontal: theme.spacing(1),
    backgroundColor: theme.colors.background, borderWidth: 2, borderColor: 'transparent'
  },
  btnWide: { minWidth: theme.isTV ? 180 : 120 },
  btnPrimary: { borderColor: theme.colors.focus },
  btnFocused: { backgroundColor: theme.colors.focus, borderColor: theme.colors.focus },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' },
  // The focus fill is a light accent, so the label has to flip to the dark ground —
  // the same pairing the settings toggle pill uses.
  btnTextFocused: { color: theme.colors.background }
})
