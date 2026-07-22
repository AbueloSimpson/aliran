// Splash / device authorization (the reference's boot screen): brand surface with the
// wordmark centered and a small "Authorizing device" status + spinner in the top-right
// corner. Boot, panel connect, and auto-login with saved credentials (D1) all happen
// BEHIND this screen — login is the exception path, not the default. Falls through to
// LoginScreen when there are no saved credentials or auth genuinely fails.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Image, ActivityIndicator, StyleSheet } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { backend } from '../worklet'
import { hasBakedKey, loadServiceDescriptor } from '../config'
import { theme } from '../theme'

const service = loadServiceDescriptor()

// Transient backend states while the swarm dials (same policy as LoginScreen).
const TRANSIENT = /not connected|channel closed/i
const RETRY_MS = 2500
const MAX_RETRIES = 24 // ≈1 minute of dialing before giving up to Login

type Props = NativeStackScreenProps<RootStackParamList, 'Splash'> & { backendReady: boolean }

export function SplashScreen ({ navigation, backendReady }: Props) {
  const [status, setStatus] = useState('Connecting')
  const routed = useRef(false)
  const tries = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const route = (name: 'Connect' | 'Login' | 'Menu') => {
    if (routed.current) return
    routed.current = true
    navigation.replace(name)
  }

  useEffect(() => {
    // Prefs live on the device (no network) — ask right away; the SDK queues the
    // request if the worklet is still booting.
    backend.requestPrefs()
    const off = backend.onMessage((m) => {
      if (m.type === 'prefs') {
        if (routed.current) return
        // Public (keyless) flavor: nothing baked, so the persisted runtime service
        // decides — connect to it, or land on Connect for first-run entry. A baked
        // key ignores any persisted service entirely (precedence: baked > runtime).
        if (!hasBakedKey()) {
          if (!m.service) { route('Connect'); return }
          backend.connect(m.service.panelPubKey)
        }
        if (m.creds) {
          setStatus('Authorizing device')
          backend.login(m.creds.username, m.creds.password)
        } else {
          route('Login')
        }
      }
      if (m.type === 'streams') route('Menu')
      if (m.type === 'login-error') {
        if (routed.current) return
        if (TRANSIENT.test(m.message) && tries.current < MAX_RETRIES) {
          tries.current += 1
          timer.current = setTimeout(() => {
            const c = backend.creds
            if (c && !routed.current) backend.login(c.username, c.password)
          }, RETRY_MS)
        } else {
          // Real auth failure (changed password, revoked account, unreachable
          // service): drop to Login — it prefills the saved username.
          route('Login')
        }
      }
    })
    return () => { off(); if (timer.current) clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (backendReady && !routed.current && backend.prefsLoaded && backend.creds) {
      setStatus('Authorizing device')
    }
  }, [backendReady])

  return (
    <View style={styles.container}>
      <View style={styles.corner}>
        <Text style={styles.status}>{status === 'Connecting' ? 'Connecting' : 'Authorizing device'}</Text>
        <ActivityIndicator size="small" color={theme.colors.primary} />
      </View>
      {service.branding?.logo
        // Baked splash logo (white-label §8): an Android drawable name (brand builds,
        // shown before any network) or an https URL. Falls back to the name wordmark.
        ? <Image source={{ uri: service.branding.logo }} style={styles.logo} resizeMode="contain" />
        : <Text style={styles.wordmark}>{service.name}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.brandSurface, alignItems: 'center', justifyContent: 'center' },
  corner: { position: 'absolute', top: theme.safeY + 8, right: theme.safeX, flexDirection: 'row', alignItems: 'center', gap: 8 },
  status: { color: theme.colors.brandText, opacity: 0.65, fontSize: theme.type.caption },
  wordmark: { color: theme.colors.brandText, fontSize: theme.type.display + 10, fontWeight: '800', letterSpacing: 1 },
  logo: { width: '70%', height: '30%' }
})
