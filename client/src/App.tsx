// Aliran client app root. One codebase for phone + Android TV (react-native-tvos).
// Boots the Bare backend behind the splash, then:
//
//   Splash (auto-auth with saved credentials, D1)
//     ├─ Connect (public keyless flavor only, S36: no baked key and no persisted
//     │           runtime service — enter the operator's panel key + credentials)
//     ├─ Login   (exception path: no/invalid saved credentials)
//     └─ Menu    (hub: icon bar over the featured stream's wallpaper)
//          ├─ Live        one fullscreen video surface + browse/detail overlays
//          ├─ Favorites   device-local ★ channels
//          ├─ Search      client-side catalog filter
//          └─ Settings    account / service / diagnostics / sign out
//
// See docs/client-build.md and aliran-ops S18-DESIGN-REFERENCE (organization only —
// every color/string flows from the service descriptor via theme.ts).

import React, { useEffect, useState } from 'react'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack'
import { AliranBackend, EngineNotice } from '@aliran/react-native'
import { backend } from './worklet'
import { hasBakedKey, loadServiceDescriptor } from './config'
import { theme } from './theme'
import { SplashScreen } from './screens/SplashScreen'
import { ConnectScreen } from './screens/ConnectScreen'
import { LoginScreen } from './screens/LoginScreen'
import { MenuScreen } from './screens/MenuScreen'
import { LiveScreen } from './screens/LiveScreen'
import { FavoritesScreen } from './screens/FavoritesScreen'
import { SearchScreen } from './screens/SearchScreen'
import { SettingsScreen } from './screens/SettingsScreen'

export type RootStackParamList = {
  Splash: undefined
  Connect: undefined
  Login: undefined
  Menu: undefined
  Live: { streamId?: string } | undefined
  Favorites: undefined
  Search: undefined
  Settings: undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()

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
function EngineUnavailable () {
  return (
    <EngineNotice
      title={loadServiceDescriptor().name}
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

  useEffect(() => {
    if (!engineSupported) return // nothing to boot — the backend would no-op anyway
    const service = loadServiceDescriptor()
    const off = backend.onMessage((m) => {
      if (m.type === 'ready') setReady(true)
    })
    // Baked (operator) flavor: connect to the shipped key right away — unchanged.
    // Public (keyless) flavor: boot the worklet idle; Splash reads the persisted
    // runtime service and either connect()s or routes to the Connect screen.
    if (hasBakedKey()) backend.boot(service.panelPubKey, service.hybrid)
    else backend.bootIdle(service.hybrid)
    let offNet: (() => void) | undefined
    try {
      // Both signals matter: `isConnectionExpensive` gates prefetch, and either that OR
      // being on cellular stops re-seeding (S25) — an unmetered mobile plan still costs
      // the viewer battery and uplink.
      offNet = NetInfo?.addEventListener((s) => backend.setNetworkProfile(!!s?.details?.isConnectionExpensive, s?.type === 'cellular'))
    } catch { /* native module absent (stale APK / jest) — expensive-network gate just stays off */ }
    return () => { off(); if (offNet) offNet() }
  }, [])

  if (!engineSupported) return <EngineUnavailable />

  return (
    <NavigationContainer>
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
        <Stack.Screen name="Favorites" component={FavoritesScreen} />
        <Stack.Screen name="Search" component={SearchScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
