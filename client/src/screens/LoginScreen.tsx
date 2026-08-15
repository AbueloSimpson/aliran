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
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, Image } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { loadServiceDescriptor } from '../config'
import { SignInWithPhone } from '../components/SignInWithPhone'
import { useSigninPath } from '../signinPath'
import { isReplicationGap, REPLICATION_GAP_TRIES, REPLICATION_GAP_STEP_MS } from '../loginErrors'
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
// Each attempt now DIALS inside the engine for up to ~10 s (sdk/player.js
// _awaitPanelRpc kicks the topic discovery and waits for the RPC to arm), so 8 attempts
// ≈100 s of genuine dialing — and the common submit succeeds on attempt #1 because the
// engine waits through the arm instead of bouncing to this ladder.
const MAX_RETRIES = 8

// What the screen can show under the fields: our own "cannot reach it" line, or the
// engine's message verbatim (SDK error prose stays English by design — S56).
type Failure = { unreachable: true } | { text: string }

// The doors of this screen (see signinPath.ts). Both end on {type:'streams'}, and only
// one of them has anything to persist:
//   manual  "remember me" (D1) — save the credentials that worked, then go
//   phone   the handover carries key material, which must NEVER reach the prefs file, so
//           there is nothing to save; its panel stays up to say the sign-in worked and
//           navigates on the viewer's press
type SigninDoor =
  | { kind: 'manual'; username: string; password: string }
  | { kind: 'phone' }

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
  // The replication-gap budget (see ../loginErrors): bare 'unknown user' retries are
  // PAID logins, counted apart from the free transient ladder.
  const recordTries = useRef(0)
  // Boot trace (diagnosis): when the viewer pressed Sign in, for the outcome lines below.
  const submitT0 = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Which door is in flight, and therefore what a 'streams' means. A REF (inside the
  // handle), not state, because the listener below is registered once.
  const door = useSigninPath<SigninDoor>()
  // Both doors reach the menu, so one guard decides who navigates.
  const routed = useRef(false)

  const goMenu = useCallback(() => {
    if (routed.current) return
    routed.current = true
    navigation.replace('Menu')
  }, [navigation])

  useEffect(() => {
    const off = backend.onMessage((m) => {
      // Read the owner ONCE (signinPath.ts) — a door that failed owns nothing.
      const d = door.current
      if (m.type === 'streams' && d?.kind === 'manual') {
        // Remember me (D1): persist the credentials THIS door proved, so the next boot
        // auto-authorizes behind the splash. Sign out (Settings) clears them.
        //
        // Only this door writes them. A password that was refused is not made good by a
        // later phone handover succeeding: saving it there would put a dead password in
        // the prefs file (plaintext at rest) and fail every auto-login from then on.
        door.release()
        backend.saveCredentials(d.username, d.password)
        console.log(`[boot-ui] login ok after ${Date.now() - submitT0.current}ms (tries=${tries.current})`)
        setBusy(false)
        goMenu()
      }
      if (m.type === 'login-error' && d?.kind === 'manual') {
        // Boot trace: WHICH error each retry saw (see SplashScreen for the vocabulary).
        console.log(`[boot-ui] login error #${tries.current}: ${m.message}`)
        const retryIn = (ms: number) => {
          timer.current = setTimeout(() => {
            // Re-read: only the door that still owns the outcome retries.
            const still = door.current
            if (still?.kind === 'manual') backend.login(still.username, still.password)
          }, ms)
        }
        if (TRANSIENT.test(m.message) && tries.current < MAX_RETRIES) {
          tries.current += 1
          retryIn(RETRY_MS)
        } else if (isReplicationGap(m.message) && recordTries.current < REPLICATION_GAP_TRIES) {
          // The account record has not replicated to this device yet — retry on its own
          // small PAID budget (see ../loginErrors), never the free ladder above.
          recordTries.current += 1
          retryIn(REPLICATION_GAP_STEP_MS)
        } else {
          // Terminal — this attempt gives the outcome up rather than leaving its
          // password behind for the next door's success to save.
          door.release()
          setBusy(false)
          setError(TRANSIENT.test(m.message) ? { unreachable: true } : { text: m.message })
        }
      }
    })
    return () => { off(); if (timer.current) clearTimeout(timer.current) }
  }, [navigation, goMenu, door])

  const onSubmit = () => {
    setError(null); setBusy(true)
    tries.current = 0
    recordTries.current = 0
    submitT0.current = Date.now()
    door.claim({ kind: 'manual', username, password })
    backend.login(username, password)
  }

  return (
    <View style={styles.container}>
      {/* THE OPERATOR'S MARK, on the one screen that had only their name in plain text.
          This is the first thing a viewer sees on a new device and the place a brand is
          least optional — the splash carries it, and then sign-in dropped it. Brands
          without a logo keep the name, which is what this screen always showed. */}
      {service.branding?.logo
        ? <Image source={{ uri: service.branding.logo }} style={styles.brandLogo} resizeMode="contain" accessibilityLabel={service.name} />
        : <Text style={styles.title}>{service.name}</Text>}
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
        // …AND while the phone panel is open. The two doors already gate each other in
        // one direction (the phone link goes dead during a password attempt); this is the
        // other. The overlay is not a Modal — it must not be, because a Modal is its own
        // focus container and swallows the remote — so on a television this button stays
        // mounted, stays focusable, and carries hasTVPreferredFocus. If the D-pad ever
        // escapes TVFocusGuideView's autoFocus, one OK press claims `manual` over a live
        // `phone` claim, and the handover's own success then writes the empty password
        // sitting in this form. Whether the focus can escape is a property of
        // react-native-tvos that nobody has proved on hardware, so it is closed here
        // rather than relied upon.
        disabled={busy || phoneSignIn || !backendReady}
        hasTVPreferredFocus
        onFocus={() => setFocused('submit')}
        onBlur={() => setFocused(null)}
        onPress={onSubmit}
      >
        {busy ? <ActivityIndicator color={theme.colors.onPrimary} /> : <Text style={styles.buttonText}>{backendReady ? t('login.signIn') : t('login.connecting')}</Text>}
      </Pressable>

      {/* The other door. Below the ordinary one so the D-pad reaches it after the
          password button; disabled until the engine is up — the handover needs the swarm
          the same way a login does — and while a password attempt is still running, so
          the two doors can never be in flight together (Connect does the same). */}
      <Pressable
        style={[styles.link, focused === 'phone' && styles.focused]}
        disabled={busy || !backendReady}
        onFocus={() => setFocused('phone')}
        onBlur={() => setFocused(null)}
        onPress={() => { door.claim({ kind: 'phone' }); setPhoneSignIn(true) }}
      >
        <Text style={styles.linkText}>{t('sendtv.tvStart')}</Text>
      </Pressable>
      <Text style={styles.linkHint}>{t('sendtv.tvStartHint')}</Text>

      {/* An overlay, not a Modal (a Modal is its own focus container on TV). This screen
          already has a service, so nothing needs persisting on success — the handover
          may only bring an account from the operator this device is already on. */}
      {phoneSignIn && (
        <SignInWithPhone
          onClose={() => { door.release(); setPhoneSignIn(false) }}
          onSignedIn={() => { door.release(); goMenu() }}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: theme.colors.text, fontSize: theme.isTV ? 56 : 40, fontWeight: '800', marginBottom: 32 },
  // Sized to the space the name occupied, so a brand with a logo and one without lay the
  // rest of the form out identically. contain, because an operator's mark can be any
  // aspect and cropping someone's logo is not a thing to do to them.
  brandLogo: { width: theme.isTV ? 420 : 260, height: theme.isTV ? 92 : 64, marginBottom: 32 },
  input: { width: theme.isTV ? 480 : 300, backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 14, fontSize: 18, borderWidth: theme.focusRing, borderColor: 'transparent' },
  button: { marginTop: 8, backgroundColor: theme.colors.primary, borderRadius: 10, paddingHorizontal: 32, paddingVertical: 14, minWidth: 200, alignItems: 'center', borderWidth: theme.focusRing, borderColor: 'transparent' },
  focused: { borderColor: theme.colors.focus },
  buttonText: { color: theme.colors.onPrimary, fontSize: 18, fontWeight: '700' },
  error: { color: theme.colors.live, marginBottom: 10 },
  link: { marginTop: 18, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, borderWidth: Math.max(theme.focusRing, 2), borderColor: 'transparent' },
  linkText: { color: theme.colors.accent, fontSize: theme.type.body, fontWeight: '700' },
  linkHint: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 6, maxWidth: theme.isTV ? 640 : 340, textAlign: 'center' }
})
