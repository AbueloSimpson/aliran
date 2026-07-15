// Login screen — the EXCEPTION path since the redesign: Splash auto-authorizes with
// saved credentials and only lands here when there are none (first run / after sign
// out) or they stopped working. Username + password -> backend OPRF login; no
// plaintext leaves the device. On success the credentials are saved device-local
// ("remember me", D1) so the next boot authorizes automatically.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { backend } from '../worklet'
import { loadServiceDescriptor } from '../config'
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

export function LoginScreen ({ navigation, backendReady }: Props) {
  // Prefill the last-known username (e.g. Splash fell through on a changed password).
  const [username, setUsername] = useState(backend.creds?.username ?? dev?.username ?? '')
  const [password, setPassword] = useState(dev?.password ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState<'user' | 'pass' | 'submit' | null>(null)
  const tries = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const creds = useRef({ username: '', password: '' })

  useEffect(() => {
    const off = backend.onMessage((m) => {
      if (m.type === 'streams') {
        // Remember me (D1): persist the credentials that worked so the next boot
        // auto-authorizes behind the splash. Sign out (Settings) clears them.
        if (creds.current.username) backend.saveCredentials(creds.current.username, creds.current.password)
        setBusy(false)
        navigation.replace('Menu')
      }
      if (m.type === 'login-error') {
        if (TRANSIENT.test(m.message) && tries.current < MAX_RETRIES) {
          tries.current += 1
          timer.current = setTimeout(() => backend.login(creds.current.username, creds.current.password), RETRY_MS)
        } else {
          setBusy(false)
          setError(TRANSIENT.test(m.message) ? 'Cannot reach the service — check your connection.' : m.message)
        }
      }
    })
    return () => { off(); if (timer.current) clearTimeout(timer.current) }
  }, [navigation])

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
        placeholder="Username"
        placeholderTextColor={theme.colors.textDim}
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
        onFocus={() => setFocused('user')}
        onBlur={() => setFocused(null)}
      />
      <TextInput
        style={[styles.input, focused === 'pass' && styles.focused]}
        placeholder="Password"
        placeholderTextColor={theme.colors.textDim}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        onFocus={() => setFocused('pass')}
        onBlur={() => setFocused(null)}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable
        style={[styles.button, focused === 'submit' && styles.focused]}
        disabled={busy || !backendReady}
        hasTVPreferredFocus
        onFocus={() => setFocused('submit')}
        onBlur={() => setFocused(null)}
        onPress={onSubmit}
      >
        {busy ? <ActivityIndicator color={theme.colors.onPrimary} /> : <Text style={styles.buttonText}>{backendReady ? 'Sign in' : 'Connecting…'}</Text>}
      </Pressable>
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
  error: { color: theme.colors.live, marginBottom: 10 }
})
