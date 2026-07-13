// Aliran client app root. One codebase for phone + Android TV (react-native-tvos).
// Boots the Bare backend, then routes Login -> Home (rails) -> Player.
// See docs/client-build.md.

import React, { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack'
import { backend } from './worklet'
import { loadServiceDescriptor } from './config'
import { LoginScreen } from './screens/LoginScreen'
import { HomeScreen } from './screens/HomeScreen'
import { theme } from './theme'

export type RootStackParamList = {
  Login: undefined
  Home: undefined
  Player: { streamId: string; title: string }
}

const Stack = createNativeStackNavigator<RootStackParamList>()

// S6c replaces this with screens/PlayerScreen (react-native-video isn't installed yet,
// so importing the real player here would break the bundle).
function PlayerPlaceholder ({ route }: NativeStackScreenProps<RootStackParamList, 'Player'>) {
  return (
    <View style={placeholderStyles.container}>
      <Text style={placeholderStyles.title}>{route.params.title}</Text>
      <Text style={placeholderStyles.note}>Playback arrives in S6c.</Text>
    </View>
  )
}

const placeholderStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, alignItems: 'center', justifyContent: 'center' },
  title: { color: theme.colors.text, fontSize: 24, fontWeight: '800' },
  note: { color: theme.colors.textDim, marginTop: 8 }
})

export default function App () {
  const [ready, setReady] = useState(false)
  const [hasSession] = useState(false)

  useEffect(() => {
    const service = loadServiceDescriptor()
    const off = backend.onMessage((m) => {
      if (m.type === 'ready') setReady(true)
    })
    backend.start(service.panelPubKey)
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
        <Stack.Screen name="Player" component={PlayerPlaceholder} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
