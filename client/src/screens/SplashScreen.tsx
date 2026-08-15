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
// visible here — but the BUDGETS do. They are per-door, and per door they are denominated
// in different things: seconds where a retry is free, PANEL LOGINS where it is not. Missing
// that second half is how a television came to lock itself out of its own account. See
// below.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Image, ActivityIndicator, StyleSheet } from 'react-native'
import { CommonActions } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { hasBakedKey, loadServiceDescriptor } from '../config'
import { useSigninPath } from '../signinPath'
import { isReplicationGap, REPLICATION_GAP_TRIES, REPLICATION_GAP_STEP_MS } from '../loginErrors'
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
// THE PASSWORD DOOR counts, because its attempts are free. An attempt is no longer
// answered in milliseconds: the engine now DIALS through each one (kicking the panel
// topic's discovery and waiting up to ~10 s for the RPC to arm — sdk/player.js
// _awaitPanelRpc) before 'not connected' comes back, so 8 attempts ≈100 s of genuine
// dialling — more real work than the old 24 fast bounces bought — and the common boot
// succeeds on attempt #1 because the engine waits THROUGH the arm instead of bouncing.
const LOGIN_MAX_RETRIES = 8
// THE RESTORE DOOR uses a DEADLINE FOR THE ATTEMPTS THAT COST NOTHING, because those are
// slow: resumeSignIn() dials inside the worklet for RESUME_CONNECT_MS (25 s) before it
// answers retry:true, so an offline set spends ~27.5 s per attempt — and 24 of those is
// eleven minutes of "Authorizing device" with nothing on screen a viewer can press. A
// wall-clock budget cannot drift when that worklet constant changes.
//
// An attempt already under way is never cut short, so the worst case is the budget plus
// one attempt: ≈45 s of trying, ≈53 s before the door gives up. Two attempts offline, and
// the password door then still has its own full minute.
const RESTORE_BUDGET_MS = 45000
//
// …AND A DEADLINE IS THE WRONG BUDGET FOR THE ATTEMPTS THAT DO COST, which is the second
// half of the same lesson: the seconds are ours, the logins are the panel's. A resume that
// reaches the panel spends a `login` RPC, and panel/src/rpc.js counts every one of them
// against (username|peer) — successes included — refusing past LOCKOUT_THRESHOLD (10) for
// LOCKOUT_SECONDS (900). 45 s buys two attempts when each dials for 25 s, and NINETEEN when
// each comes back fast. A set whose account record has not replicated pays 3 logins an
// attempt: six attempts, eighteen logins, and it locks out the account it is restoring —
// after which 'login failed: locked' returns in 20 ms and the loop ACCELERATES.
//
// The peer half of that key is the engine's Hyperswarm public key, which sdk/player.js
// leaves to hyperswarm to mint at random per instance — so the set locks out only itself,
// and only for as long as this app process lives. That sounds mild, and here is what it
// actually costs: the fall-through below then runs the password door on the SAME socket,
// 'login failed: locked (retry 871s)' is not transient, and a viewer standing at the set
// with the correct password is told to wait a quarter of an hour. Restarting the app would
// clear it, which is not a thing anybody knows to try.
//
// THE RULE, and it deliberately names no number: AN ATTEMPT THAT REACHED THE PANEL ENDS
// THIS DOOR. Free attempts keep the deadline they always had. So the most a boot can spend
// here is whatever ONE resume can spend, which is bounded in the only place that knows it
// (client/backend/backend.mjs RESUME_RECORD_TRIES, currently three logins 3 s apart) —
// a third of the panel's tolerance, with the password door's own fall-through still to come
// out of the same window. And repeating a paying attempt was never worth anything anyway:
// the panel had already answered.

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
  // The replication-gap budget (see ../loginErrors): bare 'unknown user' retries are
  // PAID logins, counted apart from the free transient ladder above.
  const recordTries = useRef(0)
  const restoreUntil = useRef(0)
  // What this boot has already spent at the restore door, in PANEL LOGINS. Splash is the
  // initial route and every exit is a replace(), so it mounts once and this counter really
  // is per boot.
  const restoreLogins = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const door = useSigninPath<SigninDoor>()
  // Boot trace (diagnosis): when this screen mounted, so the exit line below can say how
  // long the viewer looked at it and what the wait was spent on (see also the worklet's
  // '[boot-trace]' dumps — this is the RN half of the same picture).
  const bootT0 = useRef(Date.now())
  // Cached warm start: the Menu was PUSHED over this screen on a provisional lineup, and
  // this screen is still alive underneath it running the doors. NOT `routed` — routed is
  // the terminal exit, and every guard in this file keys on it staying false until the
  // real outcome is known.
  const provisionalRouted = useRef(false)

  const route = (name: 'Connect' | 'Login' | 'Menu') => {
    if (routed.current) return
    routed.current = true
    console.log(`[boot-ui] splash -> ${name} after ${Date.now() - bootT0.current}ms (loginTries=${loginTries.current} restoreLogins=${restoreLogins.current}${provisionalRouted.current ? ', upgraded provisional' : ''})`)
    if (provisionalRouted.current) {
      // A provisional Menu is already on top of this screen. replace() would swap the
      // BURIED splash and leave the stack's history wrong, so reset to the outcome:
      // [Menu] when the login landed, [Login] when it terminally failed — the pullback
      // that matches the worklet having just dropped the cache.
      navigation.dispatch(CommonActions.reset({ index: 0, routes: [{ name }] }))
    } else {
      navigation.replace(name)
    }
  }

  // Provisional route: PUSH the Menu and stay mounted (doors, budgets and timers keep
  // running underneath — relocating them was rejected on purpose, their lockout
  // arithmetic lives here). Idempotent; a second provisional emit cannot double-push.
  const routeProvisional = () => {
    if (routed.current || provisionalRouted.current) return
    provisionalRouted.current = true
    console.log(`[boot-ui] splash -> Menu (provisional) after ${Date.now() - bootT0.current}ms`)
    navigation.navigate('Menu')
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
      // Started on the FIRST attempt, so the deadline measures the door and not each try.
      // (The login count needs no such care — it only ever goes up.)
      if (!restoreUntil.current) restoreUntil.current = Date.now() + RESTORE_BUDGET_MS
      door.claim({ kind: 'restore' })
      backend.resumeSignIn().then((res) => {
        if (routed.current) return
        if (res.ok) { door.release(); route('Menu'); return }
        // WHAT THAT ATTEMPT COST, charged before anything is decided. An answer with no
        // cost on it is an answer the worklet never composed — the binding's own timeout,
        // where a login may be in flight this instant — so unknown is charged as paid.
        restoreLogins.current += typeof res.logins === 'number' ? res.logins : 1
        if (res.retry && restoreLogins.current === 0 && Date.now() < restoreUntil.current) {
          timer.current = setTimeout(() => { if (!routed.current) withKept() }, RETRY_MS)
          return
        }
        // Two different endings, one exit. EITHER the sign-in is gone for good — refused
        // by the operator, unreadable, or a service this device has left, all of which the
        // worklet has already erased — OR this door is out of budget (out of time, or out
        // of logins) and the material is still on the disk for the next boot to try.
        // Neither leaves anything to unwind, so both take the same way out: the other door,
        // then the screen.
        door.release()
        withSaved(backend.creds)
      })
    }

    // The provisional lineup can beat this screen's mount (the worklet emits it the
    // moment the loopback server is up) — the message is gone but the binding caches it.
    if (backend.provisional && backend.streams.length > 0) routeProvisional()
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
      if (m.type === 'streams') {
        // Provisional = the disk cache painting early (cached warm start). The doors
        // keep running: only a REAL lineup releases one and takes the terminal exit.
        if (m.provisional === true) routeProvisional()
        else if (d) { door.release(); route('Menu') }
      }
      if (m.type === 'login-error' && d?.kind === 'saved') {
        if (routed.current) return
        // Boot trace: WHICH error each retry saw — 'not connected' means the swarm is
        // still dialing, 'unknown user' means the account record has not replicated.
        console.log(`[boot-ui] splash login-error #${loginTries.current}: ${m.message}`)
        const retryIn = (ms: number) => {
          timer.current = setTimeout(() => {
            // Re-read the owner: the door may have been released while we waited.
            const still = door.current
            if (still?.kind === 'saved' && !routed.current) backend.login(still.username, still.password)
          }, ms)
        }
        if (TRANSIENT.test(m.message) && loginTries.current < LOGIN_MAX_RETRIES) {
          loginTries.current += 1
          retryIn(RETRY_MS)
        } else if (isReplicationGap(m.message) && recordTries.current < REPLICATION_GAP_TRIES) {
          // The account record has not replicated to this device yet — retry on its own
          // small PAID budget (see ../loginErrors), never the free ladder above.
          recordTries.current += 1
          retryIn(REPLICATION_GAP_STEP_MS)
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

  // Back-button edge during the provisional window: popping the Menu lands the viewer on
  // this still-mounted splash with nothing to press. Send them back up — the doors below
  // decide the real exit, and route() resets the stack when they do.
  useEffect(() => {
    return navigation.addListener('focus', () => {
      if (provisionalRouted.current && !routed.current) navigation.navigate('Menu')
    })
  }, [navigation])

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
