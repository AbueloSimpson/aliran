// Connect — the public (keyless) build's first-run screen (S36; mirrors the desktop
// player's public flavor): the viewer enters their operator's PANEL PUBLIC KEY plus
// their account, and the app does the rest — connect the engine to that panel, run
// the normal OPRF login, and persist both ONLY once they worked (a typo'd key or
// password never sticks; retry in place). One screen, because that's the whole
// onboarding contract of the platform: no URLs, no ports — discovery is the DHT,
// identity is the key (the operator hands all three values to their viewer).
// Baked (operator) builds never show this: their key ships in the APK.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { backend } from '../worklet'
import { loadServiceDescriptor, PANEL_KEY_RE } from '../config'
import { theme } from '../theme'

const service = loadServiceDescriptor()

// Same transient policy as LoginScreen: the engine joins the panel topic instantly
// ('ready'), but the actual peer socket dials in the background — login retries
// quietly through that window. With a WRONG key no peer ever answers, so exhausting
// the retries is also how "that key reaches nothing" surfaces.
const TRANSIENT = /not connected|channel closed/i
const RETRY_MS = 2500
const MAX_RETRIES = 24 // ≈1 minute of dialing before calling the service unreachable

type Props = NativeStackScreenProps<RootStackParamList, 'Connect'>

export function ConnectScreen ({ navigation }: Props) {
  const [panelKey, setPanelKey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState<'key' | 'user' | 'pass' | 'submit' | null>(null)
  const tries = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attempt = useRef<{ key: string; username: string; password: string } | null>(null)
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
        // next boot auto-authorizes straight into this service.
        backend.saveService({ panelPubKey: attempt.current.key, name: service.name })
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
          setError(TRANSIENT.test(m.message)
            ? 'Cannot reach the service — re-check the panel key (all 64 characters) and your connection.'
            : m.message)
        }
      }
    })
    return () => { off(); if (timer.current) clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation])

  const onSubmit = () => {
    if (busy) return
    const key = panelKey.trim().toLowerCase()
    if (!PANEL_KEY_RE.test(key)) {
      setError('The panel key should be 64 characters (0–9, a–f) — ask your operator for it.')
      return
    }
    if (!username || !password) {
      setError('Enter your username and password.')
      return
    }
    setError(null)
    setBusy(true)
    tries.current = 0
    attempt.current = { key, username, password }
    awaitingReady.current = true
    backend.connect(key)
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{service.name}</Text>
      <Text style={styles.intro}>
        Connect to your operator's service. You need the three things they gave you: the{' '}
        <Text style={styles.introBold}>panel key</Text>, a <Text style={styles.introBold}>username</Text> and a{' '}
        <Text style={styles.introBold}>password</Text>. No URLs — the service is found over the peer-to-peer network.
      </Text>
      <TextInput
        style={[styles.input, styles.keyInput, focused === 'key' && styles.focusedInput]}
        placeholder="Panel public key (64 characters)"
        placeholderTextColor={theme.colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        hasTVPreferredFocus
        value={panelKey}
        onChangeText={setPanelKey}
        onFocus={() => setFocused('key')}
        onBlur={() => setFocused(null)}
      />
      <TextInput
        style={[styles.input, focused === 'user' && styles.focusedInput]}
        placeholder="Username"
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
        placeholder="Password"
        placeholderTextColor={theme.colors.textDim}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        onFocus={() => setFocused('pass')}
        onBlur={() => setFocused(null)}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      {busy && !error && <Text style={styles.status}>Connecting to the service…</Text>}
      <Pressable
        style={[styles.button, focused === 'submit' && styles.focusedInput]}
        disabled={busy}
        onFocus={() => setFocused('submit')}
        onBlur={() => setFocused(null)}
        onPress={onSubmit}
      >
        {busy ? <ActivityIndicator color={theme.colors.onPrimary} /> : <Text style={styles.buttonText}>Connect</Text>}
      </Pressable>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: theme.colors.text, fontSize: theme.isTV ? 56 : 40, fontWeight: '800', marginBottom: 16 },
  intro: { color: theme.colors.textDim, fontSize: theme.type.body, lineHeight: theme.isTV ? 28 : 22, maxWidth: theme.isTV ? 640 : 340, textAlign: 'center', marginBottom: 24 },
  introBold: { color: theme.colors.text, fontWeight: '700' },
  input: { width: theme.isTV ? 480 : 300, backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 14, fontSize: 18, borderWidth: theme.focusRing, borderColor: 'transparent' },
  // The 64-hex key: wider + smaller type so a pasted key is visible for checking.
  keyInput: { width: theme.isTV ? 640 : 340, fontSize: 14 },
  button: { marginTop: 8, backgroundColor: theme.colors.primary, borderRadius: 10, paddingHorizontal: 32, paddingVertical: 14, minWidth: 200, alignItems: 'center', borderWidth: theme.focusRing, borderColor: 'transparent' },
  focusedInput: { borderColor: theme.colors.focus },
  buttonText: { color: theme.colors.onPrimary, fontSize: 18, fontWeight: '700' },
  error: { color: theme.colors.live, marginBottom: 10, maxWidth: theme.isTV ? 640 : 340, textAlign: 'center' },
  status: { color: theme.colors.textDim, marginBottom: 10 }
})
