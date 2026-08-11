// Splash / device authorization (the reference's boot screen): brand surface with the
// wordmark centered and a small "Authorizing device" status + spinner in the top-right
// corner. Boot, panel connect, and signing the device back in all happen BEHIND this
// screen — login is the exception path, not the default. Falls through to LoginScreen
// when there is nothing to sign back in with, or when it genuinely stopped working.
//
// TWO DOORS, and this screen is the only place either of them opens (see signinPath.ts):
//
//   restore   a phone -> TV sign-in this device KEPT. No password was ever typed on it;
//             the account key material is sealed on disk under an Android Keystore key,
//             and the worklet opens it and completes an ordinary login with it. This is
//             what makes a television that a phone signed in survive Android reclaiming
//             the app process — without it, every restart sent the viewer back for their
//             phone, which is worse than the password path it replaced.
//   saved     the "remember me" credentials of a typed login (D1).
//
// The kept sign-in goes first when both exist. It is only ever written by a handover, so
// it is the newer of the two, and it is the path the device it runs on was built for.
// Falling through to the password door — and then to LoginScreen — is a plain sequence
// with no state to unwind, and it happens for two different reasons: the sign-in was
// refused FOR GOOD (the worklet has already erased it) or this door simply ran out of
// budget (the material is still there and the next boot will try it again). Neither leaves
// anything for the next door to trip over, which is why the difference does not have to be
// visible here — but the BUDGETS do, and they are per-door for a reason. See below.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Image, ActivityIndicator, StyleSheet } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { hasBakedKey, loadServiceDescriptor } from '../config'
import { useSigninPath } from '../signinPath'
import { theme } from '../theme'

const service = loadServiceDescriptor()

// Transient backend states while the swarm dials (same policy as LoginScreen).
const TRANSIENT = /not connected|channel closed/i
const RETRY_MS = 2500

// TWO DOORS, TWO BUDGETS, AND THEY ARE NOT THE SAME SHAPE — because an attempt does not
// cost the same thing at each of them. One shared counter of 24 was wrong twice over: it
// gave the restore door eleven minutes, and it let the restore door spend the password
// door's retries before the password door had made a single attempt.
//
// THE PASSWORD DOOR counts, because its attempts are free. backend.login() answers
// 'login-error' in milliseconds when there is no panel socket, so 24 attempts 2.5 s apart
// really is ≈1 minute of dialling before giving up to Login.
const LOGIN_MAX_RETRIES = 24
// THE RESTORE DOOR uses a DEADLINE, because its attempts are anything but free.
// resumeSignIn() dials inside the worklet for RESUME_CONNECT_MS (25 s) before it answers
// retry:true, so an offline set spends ~27.5 s per attempt — and 24 of those is eleven
// minutes of "Authorizing device" with nothing on screen a viewer can press. A wall-clock
// budget cannot drift when that worklet constant changes.
//
// An attempt already under way is never cut short, so the worst case is the budget plus
// one attempt: ≈45 s of trying, ≈53 s before the door gives up. Two attempts offline, and
// the password door then still has its own full minute.
const RESTORE_BUDGET_MS = 45000

// The doors of this screen (see signinPath.ts). Both end on {type:'streams'}, neither
// persists anything — the material each one used was already on the device — so what the
// ownership buys here is the OTHER direction: a 'login-error' belongs to the password
// door alone, and its retry loop must never fire while a restore is the thing in flight.
type SigninDoor =
  | { kind: 'restore' }
  | { kind: 'saved'; username: string; password: string }

type Props = NativeStackScreenProps<RootStackParamList, 'Splash'> & { backendReady: boolean }

export function SplashScreen ({ navigation, backendReady }: Props) {
  const { t } = useI18n()
  // The status is held as a STATE NAME, not as copy: the string is looked up at render
  // so a locale change (the prefs reply carries the saved language) repaints it.
  const [status, setStatus] = useState<'connecting' | 'authorizing'>('connecting')
  const routed = useRef(false)
  // One budget PER DOOR. A television holding both a kept sign-in and a saved password and
  // booting offline used to run the restore door through the single shared counter, fall
  // through to the password door with nothing left, and drop to LoginScreen on its first
  // transient — having never once tried the password it had.
  const loginTries = useRef(0)
  const restoreUntil = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const door = useSigninPath<SigninDoor>()

  const route = (name: 'Connect' | 'Login' | 'Menu') => {
    if (routed.current) return
    routed.current = true
    navigation.replace(name)
  }

  useEffect(() => {
    // The password door. Also the fall-through target of a kept sign-in that is gone.
    const withSaved = (creds: { username: string; password: string } | null) => {
      if (routed.current) return
      if (!creds) { door.release(); route('Login'); return }
      setStatus('authorizing')
      door.claim({ kind: 'saved', username: creds.username, password: creds.password })
      backend.login(creds.username, creds.password)
    }

    // The restore door. resumeSignIn() resolves and never rejects, and `retry` is the only
    // answer that means the material is still there — every other failure has either erased
    // it or found nothing to erase, so there is nothing to clean up out of any branch.
    const withKept = () => {
      if (routed.current) return
      setStatus('authorizing')
      // Started on the FIRST attempt, so the budget measures the door and not each try.
      if (!restoreUntil.current) restoreUntil.current = Date.now() + RESTORE_BUDGET_MS
      door.claim({ kind: 'restore' })
      backend.resumeSignIn().then((res) => {
        if (routed.current) return
        if (res.ok) { door.release(); route('Menu'); return }
        if (res.retry && Date.now() < restoreUntil.current) {
          timer.current = setTimeout(() => { if (!routed.current) withKept() }, RETRY_MS)
          return
        }
        // Two different endings, one exit. EITHER the sign-in is gone for good — refused
        // by the operator, unreadable, or a service this device has left, all of which the
        // worklet has already erased — OR this door simply ran out of budget and the
        // material is still on the disk for the next boot to try. Neither leaves anything
        // to unwind, so both take the same way out: the other door, then the screen.
        door.release()
        withSaved(backend.creds)
      })
    }

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
        // THE GATE (signinPath.ts): at most one door is ever open. Neither of these has a
        // control a viewer can press, so the whole gate is this line — but it is not
        // optional, because the worklet answers with fresh prefs after EVERY write,
        // including the ones a resume itself causes, and a second open would run a second
        // login against the same account and race its own result.
        if (door.current) return
        if (m.signinSaved) withKept()
        else withSaved(m.creds)
      }
      // Read the owner ONCE (signinPath.ts) — a door that failed owns nothing.
      const d = door.current
      if (m.type === 'streams' && d) { door.release(); route('Menu') }
      if (m.type === 'login-error' && d?.kind === 'saved') {
        if (routed.current) return
        if (TRANSIENT.test(m.message) && loginTries.current < LOGIN_MAX_RETRIES) {
          loginTries.current += 1
          timer.current = setTimeout(() => {
            // Re-read the owner: the door may have been released while we waited.
            const still = door.current
            if (still?.kind === 'saved' && !routed.current) backend.login(still.username, still.password)
          }, RETRY_MS)
        } else {
          // Real auth failure (changed password, revoked account, unreachable
          // service): drop to Login — it prefills the saved username.
          door.release()
          route('Login')
        }
      }
    })
    return () => { off(); if (timer.current) clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (backendReady && !routed.current && backend.prefsLoaded && (backend.creds || backend.signinSaved)) {
      setStatus('authorizing')
    }
  }, [backendReady])

  return (
    <View style={styles.container}>
      <View style={styles.corner}>
        <Text style={styles.status}>{status === 'connecting' ? t('splash.connecting') : t('splash.authorizing')}</Text>
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
