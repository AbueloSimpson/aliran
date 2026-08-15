// Aliran client app root. One codebase for phone + Android TV (react-native-tvos).
// Boots the Bare backend behind the splash, then:
//
//   Splash (auto-auth with saved credentials, D1)
//     ├─ Connect (public keyless flavor only, S36: no baked key and no persisted
//     │           runtime service — enter the operator's panel key + credentials)
//     ├─ Login   (exception path: no/invalid saved credentials)
//     └─ Menu    (hub: icon bar over the featured stream's wallpaper)
//          ├─ Live        one fullscreen video surface + browse/detail overlays
//          ├─ Vod         Movies & Series from the operator's external provider (S53;
//          │              the tile only exists while the panel delivers an enabled
//          │              provider config) → VodSeries (series detail) and
//          │              VodPlayer, plain react-native-video
//          ├─ Favorites   device-local ★ channels
//          ├─ Search      client-side catalog filter
//          └─ Settings    account / service / diagnostics / sign out
//
// See docs/client-build.md and aliran-ops S18-DESIGN-REFERENCE (organization only —
// every color/string flows from the service descriptor via theme.ts).

import React, { useEffect, useState } from 'react'
import { AppState, InteractionManager, View } from 'react-native'
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack'
import { AliranBackend, EngineNotice } from '@aliran/react-native'
import { setLocale, useI18n } from '@aliran/i18n'
// FIRST i18n import on purpose: this module reads the device language and sets the
// locale as it loads, so the first frame is already in the viewer's language (S56e,
// design D5). The saved override arrives below with the worklet's prefs reply.
import { deviceLocaleTag, pickLocale, serviceDefaultLocale } from './i18n'
import { backend } from './worklet'
import { categoryModel, channelNumbers } from './catalog'
import { blockedWithoutPin, visibleStreams } from './parental'
import { hasBakedKey, loadServiceDescriptor } from './config'
import { checkForUpdate, onUpdateAvailable, type AvailableUpdate } from './update'
import { joinRendezvous, watchPeers } from './sendToTv'
import { theme } from './theme'
import { UpdateBanner } from './components/UpdateBanner'
import { SplashScreen } from './screens/SplashScreen'
import { ConnectScreen } from './screens/ConnectScreen'
import { LoginScreen } from './screens/LoginScreen'
import { MenuScreen } from './screens/MenuScreen'
import { LiveScreen } from './screens/LiveScreen'
import { GuideScreen } from './screens/GuideScreen'
import { FavoritesScreen } from './screens/FavoritesScreen'
import { SearchScreen } from './screens/SearchScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { VodScreen } from './screens/VodScreen'
import { VodSeriesScreen } from './screens/VodSeriesScreen'
import { VodPlayerScreen } from './screens/VodPlayerScreen'

export type RootStackParamList = {
  Splash: undefined
  Connect: undefined
  Login: undefined
  Menu: undefined
  // tuneKey: a fresh stamp per Guide tune, so navigating here with a VALUE-EQUAL
  // streamId (re-tuning the channel the params already name) still fires Live's
  // param effect. Callers that mount Live fresh (Favorites/Search) don't need it.
  // category: the category chip the Guide tuned FROM (Phase 4) — Live scopes its
  // CH+/CH- zap ring and its OK-reopens-the-list context to it. OPTIONAL so every
  // old caller stays valid; absent, Live derives the scope from the channel itself.
  // guide (phone only): open with the guide MODE up — the time-grid around the ONE
  // playing video surface (portrait: 16:9 strip above the grid). The Menu's GUIDE
  // tile uses this on phone; on TV it keeps navigating to the Guide screen.
  // search (phone only): open with the in-player search overlay up (WS15) — same
  // split: the Menu's SEARCH tile uses this on phone; TV keeps the Search screen.
  Live: { streamId?: string; tuneKey?: number; category?: string; guide?: boolean; search?: boolean } | undefined
  // The full EPG guide (WS3). streamId = the channel Live was playing when it opened
  // the guide — the row the grid mounts at and the NOW pill's jump target. Absent
  // when entered from the Menu tile.
  Guide: { streamId?: string } | undefined
  Favorites: undefined
  Search: undefined
  Settings: undefined
  Vod: undefined
  // A series never plays directly (S54, D3): its tile opens a detail screen that asks
  // the provider for seasons + episodes. The grid hands over what it already knows so
  // the header renders before that call answers.
  VodSeries: { id: string; name: string; icon?: string; anio?: string }
  // The provider URL is resolved by whoever opens the player (getMovieInfo on the grid,
  // getSeriesInfo on the series screen) and handed over, so the player screen is a dumb
  // surface: no provider call, no credentials.
  //
  // id/kind (+seriesId for an episode) are what the player writes its DEVICE-LOCAL watch
  // history against (S54c, D9); resumeSec is where it seeks on load. All four are
  // optional — a caller that omits them simply plays the title without being remembered.
  VodPlayer: {
    url: string
    title: string
    durationSec?: number
    id?: string
    kind?: 'movie' | 'episode'
    seriesId?: string
    resumeSec?: number
  }
}

const Stack = createNativeStackNavigator<RootStackParamList>()

// "Play on my TV" arrives from OUTSIDE the tree — another device of this account sends
// it — so the routing needs a handle that does not belong to any screen. Nothing else
// uses this; screens keep their own navigation prop.
const navRef = createNavigationContainerRef<RootStackParamList>()

// Feed connection-cost changes to the engine so "Smooth zapping" auto-suspends on
// metered networks (cellular / metered hotspots). Optional native module: a build
// without it (or a stale APK) just never reports an expensive network.
let NetInfo: { addEventListener: (fn: (s: any) => void) => () => void } | null = null
try { NetInfo = require('@react-native-community/netinfo').default } catch { NetInfo = null }

// A build either ships the bare-kit native module or not — resolved once. False in
// the legacy flavor (ALIRAN_LEGACY=1: bare-kit excluded so the APK can install below
// Android 10; the engine's native runtime cannot load there — see docs/sdk-guide.md
// "Older Android"). The backend is then silently inactive, so instead of an eternal
// splash the app says so plainly. This is also the reference for SDK hosts: gate on
// isSupported() and mount your own legacy/CDN mode in the unsupported branch.
const engineSupported = AliranBackend.isSupported()

// The SDK's ready-made notice, branded from the service theme (dogfooding the
// exported component; hosts with a fallback method also pass actionLabel/onAction —
// this app has no non-P2P delivery, so it shows the notice alone).
// The notice renders before any prefs exist, so it speaks the DEVICE language — by
// design (D10). The SDK's own default copy stays English; the catalog line is passed
// in as a prop, which is the only seam a host needs.
function EngineUnavailable () {
  const { t } = useI18n()
  return (
    <EngineNotice
      title={loadServiceDescriptor().name}
      message={t('notice.engineUnsupported')}
      colors={{
        background: theme.colors.background,
        text: theme.colors.text,
        textDim: theme.colors.textDim,
        accent: theme.colors.primary,
        onAccent: theme.colors.onPrimary
      }}
    />
  )
}

export default function App () {
  const [ready, setReady] = useState(false)
  // The available OTA update, when a check found one (App renders the banner; the
  // shared state lives in update.ts so Settings' manual check feeds it too).
  // Dismissing hides it until a LATER check finds it again (never for mandatory).
  const [update, setUpdate] = useState<AvailableUpdate | null>(null)

  // Boot trace: a 1 s heartbeat over the boot window. A timer can only fire late if
  // the JS thread was busy (or the process suspended), so the overshoot measures any
  // grind — including one whose work logs nothing itself (render, layout, bridge
  // traffic). Quiet when the thread is healthy; stops itself after 2 minutes.
  useEffect(() => {
    const t0 = Date.now()
    let last = t0
    const beat = setInterval(() => {
      const now = Date.now()
      const late = now - last - 1000
      if (late > 500) console.log(`[boot-ui] js-thread stalled ~${late}ms (ended t+${now - t0}ms)`)
      last = now
      if (now - t0 > 120_000) clearInterval(beat)
    }, 1000)
    return () => clearInterval(beat)
  }, [])

  useEffect(() => {
    if (!engineSupported) return // nothing to boot — the backend would no-op anyway
    const service = loadServiceDescriptor()
    const off = backend.onMessage((m) => {
      // The update check rides backend readiness (not the meta watcher — the
      // manifest changes without the pointer changing) and each return to the
      // foreground, throttled to 6 h inside checkForUpdate().
      if (m.type === 'ready') { setReady(true); checkForUpdate().catch(() => {}) }
      // The viewer's saved language (S56e). It rides the prefs reply the splash
      // already waits for, so the only screen visible during a swap is the splash.
      // No saved choice (null) means "follow the device", which is what the module
      // import above already decided — recomputing it keeps ONE resolution order.
      if (m.type === 'prefs') setLocale(pickLocale(m.language, deviceLocaleTag(), serviceDefaultLocale()))
      // Warm the catalog derivations the moment a catalog (or a parental change)
      // lands (S22 round 8): the curation sort + category grouping over a large vod
      // library cost seconds of JS, memoized per catalog in catalog.ts/parental.ts.
      // Paying them here, off the interaction path, makes the FIRST guide/live open
      // as instant as the later ones. The locale swap above happens first, so the
      // warm computes under the locale the screens will use.
      if (m.type === 'streams' || m.type === 'prefs') {
        InteractionManager.runAfterInteractions(() => {
          // Boot trace: the warm is one synchronous block on the JS thread — its
          // duration IS the stall every queued timer/message waits out.
          const t0 = Date.now()
          const v = visibleStreams(backend.streams)
          categoryModel(v)
          channelNumbers(v)
          const ms = Date.now() - t0
          if (ms > 50) console.log(`[boot-ui] catalog warm took ${ms}ms (${v.length} visible)`)
        })
      }
      // "Send to TV": the catalog push is the first moment a login is KNOWN to have
      // happened, and startRemote() needs one. It is re-sent live on every panel edit and
      // again after a sign-out/sign-in, so the once-per-session latch lives in
      // sendToTv.ts — where the sign-out that has to clear it can reach it. Never throws,
      // and a build without `remote: { control: true }` simply answers false: the feature
      // is then absent, which is not a failure to report.
      if (m.type === 'streams') joinRendezvous().catch(() => {})
    })
    const offPeers = watchPeers()
    // TELEVISION SIDE. A {state:'play'} is a COMMAND, not a notification: the engine
    // checked the channel against this device's entitlements and deliberately did NOT
    // tune it, precisely so the host still owes a `restricted` channel the SAME parental
    // treatment a local zap gets. That treatment has two clauses, and this is the only
    // route in the app that can reach the second one:
    //
    //   PIN configured   → route it. Live's param path runs play(), which raises the PIN
    //                      modal — the gate this device can actually offer.
    //   NO PIN           → REFUSE. With no PIN a restricted channel does not exist on
    //                      this set (parental.visibleStreams takes it out of every list)
    //                      and there is nothing to challenge for, so falling through to
    //                      the router is not a gate — it is the channel simply playing
    //                      because another device asked for it. The engine says the same
    //                      from its side: a host with no PIN HIDES these rather than
    //                      challenging, so `restricted: true` is a command with one
    //                      defined answer, and this is it.
    //
    // Nothing is shown when it is refused, deliberately: on this device that channel does
    // not exist, and a set that announced "a channel you cannot see was just refused"
    // would leak the very thing hiding it is for.
    const offRemote = backend.onRemote((info) => {
      if (info.role !== 'tv' || !navRef.isReady()) return
      if (info.state === 'play' && info.streamId) {
        // The event's own flag is the authority — the engine reads it off THIS device's
        // catalog record and refuses outright when it cannot read one. The local record
        // is the same fact read twice, for a worklet older than the field: an id that is
        // restricted here must not tune here whatever the message left out.
        const local = backend.streams.find((s) => s.id === info.streamId)
        if (blockedWithoutPin(info.restricted || local?.restricted)) return
        // tuneKey: a value-equal streamId alone would never re-fire Live's param effect,
        // so a second "play this again" from the phone would do nothing.
        navRef.navigate('Live', { streamId: info.streamId, tuneKey: Date.now() })
      } else if (info.state === 'stop') {
        navRef.navigate('Menu')
      }
    })
    const offUpdate = onUpdateAvailable(setUpdate)
    const appState = AppState.addEventListener('change', (s) => {
      if (s === 'active') checkForUpdate().catch(() => {})
    })
    // Baked (operator) flavor: connect to the shipped key right away — unchanged.
    // Public (keyless) flavor: boot the worklet idle; Splash reads the persisted
    // runtime service and either connect()s or routes to the Connect screen.
    // boot()/bootIdle() are async (they await the native app version first); a start()
    // throw must not become an unhandled rejection — surface it on the adb log instead.
    if (hasBakedKey()) backend.boot(service.panelPubKey, service.hybrid, service.bootstrap).catch((e) => console.error('worklet boot failed', e))
    else backend.bootIdle(service.hybrid, service.bootstrap).catch((e) => console.error('worklet boot failed', e))
    let offNet: (() => void) | undefined
    try {
      // Both signals matter: `isConnectionExpensive` gates prefetch, and either that OR
      // being on cellular stops re-seeding (S25) — an unmetered mobile plan still costs
      // the viewer battery and uplink.
      offNet = NetInfo?.addEventListener((s) => backend.setNetworkProfile(!!s?.details?.isConnectionExpensive, s?.type === 'cellular'))
    } catch { /* native module absent (stale APK / jest) — expensive-network gate just stays off */ }
    return () => { off(); offPeers(); offRemote(); offUpdate(); appState.remove(); if (offNet) offNet() }
  }, [])

  if (!engineSupported) return <EngineUnavailable />

  return (
    <NavigationContainer ref={navRef}>
      <View style={{ flex: 1 }}>
        <Stack.Navigator initialRouteName="Splash" screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Splash">
            {(props: NativeStackScreenProps<RootStackParamList, 'Splash'>) => (
              <SplashScreen {...props} backendReady={ready} />
            )}
          </Stack.Screen>
          <Stack.Screen name="Connect" component={ConnectScreen} />
          <Stack.Screen name="Login">
            {(props: NativeStackScreenProps<RootStackParamList, 'Login'>) => (
              <LoginScreen {...props} backendReady={ready} />
            )}
          </Stack.Screen>
          <Stack.Screen name="Menu" component={MenuScreen} />
          <Stack.Screen name="Live" component={LiveScreen} />
          <Stack.Screen name="Guide" component={GuideScreen} />
          <Stack.Screen name="Favorites" component={FavoritesScreen} />
          <Stack.Screen name="Search" component={SearchScreen} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
          <Stack.Screen name="Vod" component={VodScreen} />
          <Stack.Screen name="VodSeries" component={VodSeriesScreen} />
          <Stack.Screen name="VodPlayer" component={VodPlayerScreen} />
        </Stack.Navigator>
        {update && (
          <UpdateBanner
            entry={update.entry}
            mandatory={update.mandatory}
            onDismiss={() => setUpdate(null)}
          />
        )}
      </View>
    </NavigationContainer>
  )
}
