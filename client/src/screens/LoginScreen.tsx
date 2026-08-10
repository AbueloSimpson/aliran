// Login screen — the EXCEPTION path since the redesign: Splash auto-authorizes with
// saved credentials and only lands here when there are none (first run / after sign
// out) or they stopped working. Username + password -> backend OPRF login; no
// plaintext leaves the device. On success the credentials are saved device-local
// ("remember me", D1) so the next boot authorizes automatically.
//
// Second way in, and the one a television should take: "Sign in with your phone"
// (<SignInWithPhone>). Spelling a password out with a D-pad is the worst minute in the
// product, so a phone that is already signed in hands this device the account instead.
// It leaves NO saved credentials behind — key material is not written to the prefs file
// (sdk/index.d.ts is explicit that it must not be stored) — so a device signed in this
// way comes back to this screen after a restart and does the handover again.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { loadServiceDescriptor } from '../config'
import { SignInWithPhone } from '../components/SignInWithPhone'
import { theme } from '../theme'

const service = loadServiceDescriptor()

// Dev-only convenience: the gitignored local service.json may carry dev credentials
// (see config.ts ServiceDescriptor.dev) — prefill them so a dev build signs in with
// one tap. Absent in any shipped descriptor, so production builds start empty.
const dev = service.dev

type Props = NativeStackScreenProps<RootStackParamList, 'Login'> & { backendReady: boolean }

// The backend's {type:'ready'} fires right after swarm.join, BEFORE the panel connection
// exists, so an early submit gets "not connected to panel"; a mid-login socket drop gets
// "CHANNEL_CLOSED". Both are transient — keep retrying quietly while the swarm (re)dials;
// only surface real errors (bad credentials, lockout, rate limit).
const TRANSIENT = /not connected|channel closed/i
const RETRY_MS = 2500
const MAX_RETRIES = 24 // ≈1 minute of dialing before giving up

// What the screen can show under the fields: our own "cannot reach it" line, or the
// engine's message verbatim (SDK error prose stays English by design — S56).
type Failure = { unreachable: true } | { text: string }

export function LoginScreen ({ navigation, backendReady }: Props) {
  const { t } = useI18n()
  // Prefill the last-known username (e.g. Splash fell through on a changed password).
  const [username, setUsername] = useState(backend.creds?.username ?? dev?.username ?? '')
  const [password, setPassword] = useState(dev?.password ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Failure | null>(null)
  const [focused, setFocused] = useState<'user' | 'pass' | 'submit' | 'phone' | null>(null)
  const [phoneSignIn, setPhoneSignIn] = useState(false)
  const tries = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const creds = useRef({ username: '', password: '' })
  // Both doors end on the same 'streams' message, so one guard decides who navigates —
  // and a REF, not the state, because the listener below is registered once.
  const routed = useRef(false)
  const phoneMode = useRef(false)

  const goMenu = useCallback(() => {
    if (routed.current) return
    routed.current = true
    navigation.replace('Menu')
  }, [navigation])

  useEffect(() => {
    const off = backend.onMessage((m) => {
      if (m.type === 'streams') {
        // Remember me (D1): persist the credentials that worked so the next boot
        // auto-authorizes behind the splash. Sign out (Settings) clears them. A phone
        // handover has no credentials to save, and its panel stays up to say the
        // sign-in worked — so it navigates on the viewer's press, not on this message.
        if (creds.current.username) backend.saveCredentials(creds.current.username, creds.current.password)
        setBusy(false)
        if (!phoneMode.current) goMenu()
      }
      if (m.type === 'login-error') {
        if (TRANSIENT.test(m.message) && tries.current < MAX_RETRIES) {
          tries.current += 1
          timer.current = setTimeout(() => backend.login(creds.current.username, creds.current.password), RETRY_MS)
        } else {
          setBusy(false)
          setError(TRANSIENT.test(m.message) ? { unreachable: true } : { text: m.message })
        }
      }
    })
    return () => { off(); if (timer.current) clearTimeout(timer.current) }
  }, [navigation, goMenu])

  const onSubmit = () => {
    setError(null); setBusy(true)
    tries.current = 0
    creds.current = { username, password }
    backend.login(username, password)
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{service.name}</Text>
      <TextInput
        style={[styles.input, focused === 'user' && styles.focused]}
        placeholder={t('common.username')}
        placeholderTextColor={theme.colors.textDim}
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
        onFocus={() => setFocused('user')}
        onBlur={() => setFocused(null)}
      />
      <TextInput
        style={[styles.input, focused === 'pass' && styles.focused]}
        placeholder={t('common.password')}
        placeholderTextColor={theme.colors.textDim}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        onFocus={() => setFocused('pass')}
        onBlur={() => setFocused(null)}
      />
      {error && <Text style={styles.error}>{'text' in error ? error.text : t('login.unreachable')}</Text>}
      <Pressable
        style={[styles.button, focused === 'submit' && styles.focused]}
        disabled={busy || !backendReady}
        hasTVPreferredFocus
        onFocus={() => setFocused('submit')}
        onBlur={() => setFocused(null)}
        onPress={onSubmit}
      >
        {busy ? <ActivityIndicator color={theme.colors.onPrimary} /> : <Text style={styles.buttonText}>{backendReady ? t('login.signIn') : t('login.connecting')}</Text>}
      </Pressable>

      {/* The other door. Below the ordinary one so the D-pad reaches it after the
          password button, and disabled until the engine is up — the handover needs the
          swarm the same way a login does. */}
      <Pressable
        style={[styles.link, focused === 'phone' && styles.focused]}
        disabled={!backendReady}
        onFocus={() => setFocused('phone')}
        onBlur={() => setFocused(null)}
        onPress={() => { phoneMode.current = true; setPhoneSignIn(true) }}
      >
        <Text style={styles.linkText}>{t('sendtv.tvStart')}</Text>
      </Pressable>
      <Text style={styles.linkHint}>{t('sendtv.tvStartHint')}</Text>

      {/* An overlay, not a Modal (a Modal is its own focus container on TV). This screen
          already has a service, so nothing needs persisting on success — the handover
          may only bring an account from the operator this device is already on. */}
      {phoneSignIn && (
        <SignInWithPhone
          onClose={() => { phoneMode.current = false; setPhoneSignIn(false) }}
          onSignedIn={() => goMenu()}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: theme.colors.text, fontSize: theme.isTV ? 56 : 40, fontWeight: '800', marginBottom: 32 },
  input: { width: theme.isTV ? 480 : 300, backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 14, fontSize: 18, borderWidth: theme.focusRing, borderColor: 'transparent' },
  button: { marginTop: 8, backgroundColor: theme.colors.primary, borderRadius: 10, paddingHorizontal: 32, paddingVertical: 14, minWidth: 200, alignItems: 'center', borderWidth: theme.focusRing, borderColor: 'transparent' },
  focused: { borderColor: theme.colors.focus },
  buttonText: { color: theme.colors.onPrimary, fontSize: 18, fontWeight: '700' },
  error: { color: theme.colors.live, marginBottom: 10 },
  link: { marginTop: 18, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, borderWidth: Math.max(theme.focusRing, 2), borderColor: 'transparent' },
  linkText: { color: theme.colors.accent, fontSize: theme.type.body, fontWeight: '700' },
  linkHint: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 6, maxWidth: theme.isTV ? 640 : 340, textAlign: 'center' }
})
