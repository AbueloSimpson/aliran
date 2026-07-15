// Branded section-loading state (the reference app's "VOD ▶ + spinner over the brand
// surface" pattern): brand wordmark, section name, spinner. Used by any section that
// mounts before its data is ready — never a blank screen.
import React from 'react'
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native'
import { loadServiceDescriptor } from '../config'
import { theme } from '../theme'

const service = loadServiceDescriptor()

export function SectionLoading ({ section, hint }: { section: string; hint?: string }) {
  return (
    <View style={styles.container}>
      <Text style={styles.wordmark}>{service.name}</Text>
      <Text style={styles.section}>{section.toUpperCase()}</Text>
      <ActivityIndicator size="large" color={theme.colors.primary} style={styles.spinner} />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.brandSurface, alignItems: 'center', justifyContent: 'center', padding: theme.spacing(3) },
  wordmark: { color: theme.colors.brandText, fontSize: theme.type.display, fontWeight: '800' },
  section: { color: theme.colors.primary, fontSize: theme.type.title, fontWeight: '800', letterSpacing: 2, marginTop: theme.spacing(1) },
  spinner: { marginTop: theme.spacing(3) },
  hint: { color: theme.colors.brandText, opacity: 0.6, fontSize: theme.type.caption, marginTop: theme.spacing(2), textAlign: 'center' }
})
