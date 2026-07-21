// Aliran client app root. One codebase for phone + Android TV (react-native-tvos).
// Boots the Bare backend behind the splash, then:
//
//   Splash (auto-auth with saved credentials, D1)
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
import { backend } from './worklet'
import { loadServiceDescriptor } from './config'
import { SplashScreen } from './screens/SplashScreen'
import { LoginScreen } from './screens/LoginScreen'
import { MenuScreen } from './screens/MenuScreen'
import { LiveScreen } from './screens/LiveScreen'
import { FavoritesScreen } from './screens/FavoritesScreen'
import { SearchScreen } from './screens/SearchScreen'
import { SettingsScreen } from './screens/SettingsScreen'

export type RootStackParamList = {
  Splash: undefined
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

export default function App () {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const service = loadServiceDescriptor()
    const off = backend.onMessage((m) => {
      if (m.type === 'ready') setReady(true)
    })
    backend.boot(service.panelPubKey, service.hybrid)
    let offNet: (() => void) | undefined
    try {
      // Both signals matter: `isConnectionExpensive` gates prefetch, and either that OR
      // being on cellular stops re-seeding (S25) — an unmetered mobile plan still costs
      // the viewer battery and uplink.
      offNet = NetInfo?.addEventListener((s) => backend.setNetworkProfile(!!s?.details?.isConnectionExpensive, s?.type === 'cellular'))
    } catch { /* native module absent (stale APK / jest) — expensive-network gate just stays off */ }
    return () => { off(); if (offNet) offNet() }
  }, [])

  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Splash" screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Splash">
          {(props: NativeStackScreenProps<RootStackParamList, 'Splash'>) => (
            <SplashScreen {...props} backendReady={ready} />
          )}
        </Stack.Screen>
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
