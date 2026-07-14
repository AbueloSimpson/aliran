// Aliran client app root. One codebase for phone + Android TV (react-native-tvos).
// Boots the Bare backend, then routes Login -> Home (rails) -> Player.
// See docs/client-build.md.

import React, { useEffect, useState } from 'react'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack'
import { backend } from './worklet'
import { loadServiceDescriptor } from './config'
import { LoginScreen } from './screens/LoginScreen'
import { HomeScreen } from './screens/HomeScreen'
import { PlayerScreen } from './screens/PlayerScreen'

export type RootStackParamList = {
  Login: undefined
  Home: undefined
  Player: { streamId: string; title: string }
}

const Stack = createNativeStackNavigator<RootStackParamList>()

export default function App () {
  const [ready, setReady] = useState(false)
  const [hasSession] = useState(false)

  useEffect(() => {
    const service = loadServiceDescriptor()
    const off = backend.onMessage((m) => {
      if (m.type === 'ready') setReady(true)
    })
    backend.boot(service.panelPubKey, service.hybrid)
    // TODO: check for a valid cached session (Keystore); if present, setHasSession(true)
    return off
  }, [])

  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName={hasSession ? 'Home' : 'Login'}
        screenOptions={{ headerShown: false }}
      >
        <Stack.Screen name="Login">
          {(props: NativeStackScreenProps<RootStackParamList, 'Login'>) => (
            <LoginScreen {...props} backendReady={ready} />
          )}
        </Stack.Screen>
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="Player" component={PlayerScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
