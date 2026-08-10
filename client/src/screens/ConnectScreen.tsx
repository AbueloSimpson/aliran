// Connect — the public (keyless) build's first-run screen (S36; mirrors the desktop
// player's public flavor): the viewer identifies their operator's service, adds their
// account, and the app does the rest — connect the engine to that panel, run the normal
// OPRF login, and persist both ONLY once they worked (a typo'd code or password never
// sticks; retry in place). One screen, because that's the whole onboarding contract of
// the platform: no URLs, no ports — discovery is the DHT, identity is the key (the
// operator hands the viewer their service and their account).
// Baked (operator) builds never show this: their key ships in the APK.
//
// TWO WAYS TO NAME THE SERVICE, one outcome. The default is the 12-character SERVICE
// PAIRING CODE ('A3K7-9QF2-M4XR'), typed in three groups of four that advance
// themselves — the panel key is 64 hex characters, which is punishing on a phone
// keyboard and close to impossible on a TV remote. The engine resolves the code over
// the DHT and VERIFIES the answer by re-deriving the code from the key it receives, so
// a wrong service cannot be substituted for the right one (sdk/pairing.js). The 64-hex
// field is still there behind one press for anyone who was given a key instead.
//
// A THIRD way in, and on a television the fastest one: "Sign in with your phone"
// (<SignInWithPhone>). A phone that is already signed in hands this device the whole
// thing — the account AND the operator key — so nothing at all is typed here. This
// screen is where a virgin keyless device lands, so it is where that offer belongs; the
// panel's own last step asks the viewer to check the operator's printed code before this
// device adopts it, because the key arrives from the phone and not from the operator.
// Note what it does NOT leave behind: a handover carries key material, which must never
// be written to the prefs file, so there are no saved credentials afterwards. The
// SERVICE is saved (it is public), so a restart lands on Login rather than back here.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { loadServiceDescriptor, PANEL_KEY_RE, PAIRING_GROUPS, PAIRING_GROUP_SIZE, cleanPairingInput } from '../config'
import { SignInWithPhone } from '../components/SignInWithPhone'
import { theme } from '../theme'

const service = loadServiceDescriptor()

// Same transient policy as LoginScreen: the engine joins the panel topic instantly
// ('ready'), but the actual peer socket dials in the background — login retries
// quietly through that window. With a WRONG key no peer ever answers, so exhausting
// the retries is also how "that key reaches nothing" surfaces.
const TRANSIENT = /not connected|channel closed/i
const RETRY_MS = 2500
const MAX_RETRIES = 24 // ≈1 minute of dialing before calling the service unreachable

// A pairing code that failed is never a "try again" — each reason has its own fix.
// The engine's code maps onto a CATALOG LEAF, never onto copy: the sentence is looked
// up at render (t('connect.error.' + …)), so a language change repaints an error that
// is already on screen.
const PAIR_ERROR_CODES: Record<string, string> = {
  malformed: 'malformed',
  timeout: 'timeout',
  // The dangerous one: something DID answer and could not prove it owns the code.
  unverified: 'unverified'
}

// The two things this screen can show: our own copy (a connect.error.* leaf) or the
// engine's message verbatim, which stays English by design (S56 — no error-code
// refactor in the SDK).
type Failure = { code: string } | { text: string }

// The intro is ONE sentence in the catalog, never assembled from translated fragments.
// Its three emphasised nouns arrive as {placeholders} — a translator can move them
// wherever the language needs them — and are re-wrapped in bold at render.
const INTRO_SLOTS = /(\{method\}|\{username\}|\{password\})/

type Props = NativeStackScreenProps<RootStackParamList, 'Connect'>

export function ConnectScreen ({ navigation }: Props) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'code' | 'key'>('code')
  const [groups, setGroups] = useState<string[]>(() => Array(PAIRING_GROUPS).fill(''))
  const [panelKey, setPanelKey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'finding' | null>(null)
  const [error, setError] = useState<Failure | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [phoneSignIn, setPhoneSignIn] = useState(false)
  const groupRefs = useRef<Array<TextInput | null>>([])
  const tries = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attempt = useRef<{ key: string; username: string; password: string; name: string } | null>(null)
  const awaitingReady = useRef(false)

  useEffect(() => {
    const off = backend.onMessage((m) => {
      // The engine confirmed (re)connecting to the entered panel — now log in. On a
      // service SWITCH (second try after a wrong key, or after "Change service…")
      // the worklet tears the old engine down first, so waiting for the fresh
      // 'ready' is what keeps the login from racing the teardown.
      if (m.type === 'ready' && awaitingReady.current && attempt.current) {
        awaitingReady.current = false
        backend.login(attempt.current.username, attempt.current.password)
      }
      if (m.type === 'streams' && attempt.current) {
        // Both values proved themselves — persist them now (and only now), so the
        // next boot auto-authorizes straight into this service. The name is the
        // operator's own when the pairing code delivered one, the build's otherwise.
        backend.saveService({ panelPubKey: attempt.current.key, name: attempt.current.name })
        backend.saveCredentials(attempt.current.username, attempt.current.password)
        setBusy(false)
        navigation.replace('Menu')
      }
      if (m.type === 'login-error' && attempt.current) {
        if (TRANSIENT.test(m.message) && tries.current < MAX_RETRIES) {
          tries.current += 1
          timer.current = setTimeout(() => {
            if (attempt.current) backend.login(attempt.current.username, attempt.current.password)
          }, RETRY_MS)
        } else {
          setBusy(false)
          setStatus(null)
          setError(TRANSIENT.test(m.message)
            ? { code: 'unreachable' }
            : { text: m.message })
        }
      }
    })
    return () => { off(); if (timer.current) clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation])

  // A group fills up -> jump to the next one. Deleting the last character of an empty
  // group jumps back. The viewer types 12 characters and never touches focus.
  const onGroupChange = (i: number, raw: string) => {
    const v = cleanPairingInput(raw).slice(0, PAIRING_GROUP_SIZE)
    setGroups((prev) => prev.map((g, j) => (j === i ? v : g)))
    if (v.length === PAIRING_GROUP_SIZE && i < PAIRING_GROUPS - 1) groupRefs.current[i + 1]?.focus()
  }

  const onGroupKey = (i: number, key: string) => {
    if (key === 'Backspace' && !groups[i] && i > 0) groupRefs.current[i - 1]?.focus()
  }

  // Both entry paths end here: one panel key, then the ordinary connect -> ready ->
  // login -> persist-on-success sequence.
  const start = (key: string, name: string) => {
    setError(null)
    setStatus('connecting')
    setBusy(true)
    tries.current = 0
    attempt.current = { key, username, password, name }
    awaitingReady.current = true
    backend.connect(key)
  }

  const onSubmit = async () => {
    if (busy) return
    if (!username || !password) {
      setError({ code: 'credentials' })
      return
    }
    if (mode === 'key') {
      const key = panelKey.trim().toLowerCase()
      if (!PANEL_KEY_RE.test(key)) {
        setError({ code: 'badKey' })
        return
      }
      start(key, service.name)
      return
    }
    const code = groups.join('')
    if (code.length !== PAIRING_GROUPS * PAIRING_GROUP_SIZE) {
      setError({ code: 'malformed' })
      return
    }
    // Resolving is a DHT search plus one memory-hard verification, so it is slow
    // enough to need its own status line.
    setError(null)
    setStatus('finding')
    setBusy(true)
    const res = await backend.resolvePairing(code)
    if (!res.ok || !res.panelPubKey) {
      setBusy(false)
      setStatus(null)
      const known = PAIR_ERROR_CODES[res.error ?? '']
      setError(known ? { code: known } : res.message ? { text: res.message } : { code: 'timeout' })
      return
    }
    start(res.panelPubKey, res.name || service.name)
  }

  const switchMode = () => {
    setError(null)
    setMode((m) => (m === 'code' ? 'key' : 'code'))
  }

  // What each intro placeholder renders as. Resolved every render, so the sentence
  // follows both the current mode and the current language.
  const slots: Record<string, string> = {
    '{method}': mode === 'code' ? t('connect.introCode') : t('connect.introKey'),
    '{username}': t('connect.introUsername'),
    '{password}': t('connect.introPassword')
  }

  // The handover brings the operator key with it, so a device that came in this way is
  // ALREADY on that service — persist it (public, never a secret) and go. There are no
  // credentials to save: key material is not written to disk.
  const onPhoneSignedIn = (panelPubKey: string | null) => {
    if (panelPubKey) backend.saveService({ panelPubKey, name: service.name })
    navigation.replace('Menu')
  }

  // The ScrollView sits inside a viewport-sized root so the sign-in overlay fills the
  // VIEWPORT and not the (much taller) scrollable content box — the same reason the
  // language picker is a sibling of Settings' ScrollView.
  return (
    <View style={styles.root}>
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{service.name}</Text>
      <Text style={styles.intro}>
        {t('connect.intro').split(INTRO_SLOTS).map((part, i) => (
          slots[part] ? <Text key={i} style={styles.introBold}>{slots[part]}</Text> : part
        ))}
      </Text>

      {mode === 'code'
        ? (
          <View style={styles.groups}>
            {groups.map((g, i) => (
              <TextInput
                key={i}
                ref={(r) => { groupRefs.current[i] = r }}
                style={[styles.input, styles.groupInput, focused === 'g' + i && styles.focusedInput]}
                placeholder="––––"
                placeholderTextColor={theme.colors.textDim}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={PAIRING_GROUP_SIZE}
                hasTVPreferredFocus={i === 0}
                value={g}
                onChangeText={(v) => onGroupChange(i, v)}
                onKeyPress={(e) => onGroupKey(i, e.nativeEvent.key)}
                onFocus={() => setFocused('g' + i)}
                onBlur={() => setFocused(null)}
              />
            ))}
          </View>
          )
        : (
          <TextInput
            style={[styles.input, styles.keyInput, focused === 'key' && styles.focusedInput]}
            placeholder={t('connect.keyPlaceholder')}
            placeholderTextColor={theme.colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            hasTVPreferredFocus
            value={panelKey}
            onChangeText={setPanelKey}
            onFocus={() => setFocused('key')}
            onBlur={() => setFocused(null)}
          />
          )}

      <Pressable
        style={[styles.link, focused === 'mode' && styles.focusedInput]}
        onFocus={() => setFocused('mode')}
        onBlur={() => setFocused(null)}
        onPress={switchMode}
      >
        <Text style={styles.linkText}>
          {mode === 'code' ? t('connect.switchToKey') : t('connect.switchToCode')}
        </Text>
      </Pressable>

      <TextInput
        style={[styles.input, focused === 'user' && styles.focusedInput]}
        placeholder={t('common.username')}
        placeholderTextColor={theme.colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        value={username}
        onChangeText={setUsername}
        onFocus={() => setFocused('user')}
        onBlur={() => setFocused(null)}
      />
      <TextInput
        style={[styles.input, focused === 'pass' && styles.focusedInput]}
        placeholder={t('common.password')}
        placeholderTextColor={theme.colors.textDim}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        onFocus={() => setFocused('pass')}
        onBlur={() => setFocused(null)}
      />
      {error && <Text style={styles.error}>{'code' in error ? t('connect.error.' + error.code) : error.text}</Text>}
      {busy && !error && status && <Text style={styles.status}>{t('connect.status.' + status)}</Text>}
      <Pressable
        style={[styles.button, focused === 'submit' && styles.focusedInput]}
        disabled={busy}
        onFocus={() => setFocused('submit')}
        onBlur={() => setFocused(null)}
        onPress={onSubmit}
      >
        {busy ? <ActivityIndicator color={theme.colors.onPrimary} /> : <Text style={styles.buttonText}>{t('connect.submit')}</Text>}
      </Pressable>

      {/* Last, so the D-pad reaches the ordinary form first. Nothing above needs to be
          filled in for it: the phone supplies the service and the account together. */}
      <Pressable
        style={[styles.link, focused === 'phone' && styles.focusedInput]}
        disabled={busy}
        onFocus={() => setFocused('phone')}
        onBlur={() => setFocused(null)}
        onPress={() => setPhoneSignIn(true)}
      >
        <Text style={styles.linkText}>{t('sendtv.tvStart')}</Text>
      </Pressable>
      <Text style={styles.status}>{t('sendtv.tvStartHint')}</Text>
    </ScrollView>

    {phoneSignIn && (
      <SignInWithPhone onClose={() => setPhoneSignIn(false)} onSignedIn={onPhoneSignedIn} />
    )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: theme.colors.text, fontSize: theme.isTV ? 56 : 40, fontWeight: '800', marginBottom: 16 },
  intro: { color: theme.colors.textDim, fontSize: theme.type.body, lineHeight: theme.isTV ? 28 : 22, maxWidth: theme.isTV ? 640 : 340, textAlign: 'center', marginBottom: 24 },
  introBold: { color: theme.colors.text, fontWeight: '700' },
  input: { width: theme.isTV ? 480 : 300, backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 14, fontSize: 18, borderWidth: theme.focusRing, borderColor: 'transparent' },
  // The 64-hex key: wider + smaller type so a pasted key is visible for checking.
  keyInput: { width: theme.isTV ? 640 : 340, fontSize: 14 },
  // The pairing code: three short boxes, big wide-tracked type. Read off a card at
  // arm's length and typed on a remote, so legibility beats compactness here.
  groups: { flexDirection: 'row', gap: 12 },
  groupInput: { width: theme.isTV ? 150 : 96, paddingHorizontal: 8, textAlign: 'center', fontSize: theme.isTV ? 30 : 24, letterSpacing: 2 },
  link: { marginBottom: 14, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: theme.focusRing, borderColor: 'transparent' },
  linkText: { color: theme.colors.accent, fontSize: 14 },
  button: { marginTop: 8, backgroundColor: theme.colors.primary, borderRadius: 10, paddingHorizontal: 32, paddingVertical: 14, minWidth: 200, alignItems: 'center', borderWidth: theme.focusRing, borderColor: 'transparent' },
  focusedInput: { borderColor: theme.colors.focus },
  buttonText: { color: theme.colors.onPrimary, fontSize: 18, fontWeight: '700' },
  error: { color: theme.colors.live, marginBottom: 10, maxWidth: theme.isTV ? 640 : 340, textAlign: 'center' },
  status: { color: theme.colors.textDim, marginBottom: 10 }
})
