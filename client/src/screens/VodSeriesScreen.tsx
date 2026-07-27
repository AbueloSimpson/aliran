// Series detail — PLACEHOLDER (S54b).
//
// S54b lands the series GRID, so a series tile has somewhere to go: this route exists
// from the same commit as the tiles that navigate to it, and there is no crash path
// between the two segments. S54c REPLACES this file with the real screen (mockup
// screen 5: poster + stars + run dates + genres, plot, season tiles with an
// episode-count badge, episode list, "Start"/resume and the My List toggle) driven by
// getSeriesInfo() from src/vod/zencontent.
//
// Until then it is honest rather than empty: it names the title the viewer picked and
// says the detail is not in this build.
import React from 'react'
import { View, Text, Image, Pressable, StyleSheet } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { theme } from '../theme'

type Props = NativeStackScreenProps<RootStackParamList, 'VodSeries'>

export function VodSeriesScreen ({ navigation, route }: Props) {
  const { name, icon, anio } = route.params
  return (
    <View style={styles.container}>
      {!!icon && <Image source={{ uri: icon }} style={styles.poster} resizeMode="cover" />}
      <Text style={styles.title}>{name}{anio ? ` (${anio})` : ''}</Text>
      <Text style={styles.hint}>Episodes are not available in this build yet.</Text>
      <Pressable
        style={styles.button}
        accessibilityRole="button"
        hasTVPreferredFocus
        onPress={() => navigation.goBack()}
      >
        <Text style={styles.buttonText}>BACK</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: theme.colors.background, alignItems: 'center', justifyContent: 'center',
    gap: theme.spacing(1), paddingVertical: theme.safeY, paddingHorizontal: theme.safeX
  },
  poster: { width: theme.isTV ? 190 : 110, aspectRatio: 2 / 3, borderRadius: 8, backgroundColor: theme.colors.surface },
  title: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700', textAlign: 'center' },
  hint: { color: theme.colors.textDim, fontSize: theme.type.body, textAlign: 'center' },
  button: {
    marginTop: theme.spacing(1), paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8,
    backgroundColor: theme.colors.surface, borderWidth: theme.focusRing, borderColor: 'transparent'
  },
  buttonText: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 1 }
})
