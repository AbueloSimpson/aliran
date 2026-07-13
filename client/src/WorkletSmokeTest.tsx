// S5b smoke test — verifies the react-native-bare-kit worklet runtime works end to end.
//
// This boots a tiny INLINE Bare worklet and round-trips a message over IPC, proving that
// react-native-bare-kit builds + runs on this RN 0.83 (New Arch) app and that the JS<->Bare
// IPC channel works.
//
// It intentionally does NOT boot the real P2P backend (client/backend/app.bundle) yet:
//   1. The Holepunch native addons the bundle needs (sodium-native, udx-native, quickbit,
//      rabin, simdle, crc, fs-native-extensions) are NOT part of the bare-kit runtime and
//      must still be cross-compiled for Android — see the dedicated native-addons segment.
//   2. The real bundle should be delivered to the worklet as a native ASSET (Worklet
//      `assets` + startFile), not embedded as base64 in the JS bundle — embedding ~3.9MB
//      bloats the dev JS bundle and breaks the Metro bundle download. worklet.ts keeps the
//      base64 path as a release-mode reference; asset loading is wired with the addons.
//
// Temporary app root until S6 wires the real Login/Home/Player navigation.

import React, { useEffect, useState } from 'react'
import { ScrollView, Text, View, StyleSheet } from 'react-native'
// @ts-expect-error — native module (react-native-bare-kit)
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'

export default function WorkletSmokeTest () {
  const [hello, setHello] = useState('(booting…)')

  useEffect(() => {
    try {
      const w = new Worklet()
      const source = `
        const { IPC } = BareKit
        IPC.on('data', (data) => { IPC.write(Buffer.from('echo: ' + data.toString())) })
      `
      w.start('/hello.js', source)
      w.IPC.on('data', (d: Uint8Array) => setHello(b4a.toString(d)))
      w.IPC.write(b4a.from('hello from React Native'))
    } catch (e: any) {
      setHello('ERROR: ' + String(e?.message || e))
    }
  }, [])

  const ok = hello.startsWith('echo:')

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.h1}>Aliran — Worklet smoke test</Text>
        <Text style={styles.sub}>S5b · react-native-bare-kit → Bare worklet IPC</Text>

        <View style={styles.card}>
          <Text style={styles.label}>bare-kit runtime (inline hello):</Text>
          <Text style={[styles.value, { color: ok ? '#4ADE80' : '#E2E8F0' }]} selectable>{hello}</Text>
          <Text style={styles.note}>
            {ok
              ? 'Worklet booted and echoed over IPC — the Bare runtime works on-device.'
              : 'Waiting for the worklet to echo back…'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>P2P backend (app.bundle):</Text>
          <Text style={styles.value}>deferred</Text>
          <Text style={styles.note}>
            Needs the Holepunch native addons (sodium-native, udx-native, …) cross-compiled
            for Android + asset-based bundle loading. Tracked as its own segment.
          </Text>
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B1220' },
  body: { padding: 24, paddingTop: 56, gap: 16 },
  h1: { fontSize: 22, fontWeight: 'bold', color: '#E2E8F0' },
  sub: { fontSize: 13, color: '#7DD3FC' },
  card: { backgroundColor: '#111a2e', borderRadius: 12, padding: 16, gap: 6 },
  label: { fontSize: 14, fontWeight: 'bold', color: '#93C5FD' },
  value: { fontSize: 15, color: '#E2E8F0', fontFamily: 'monospace' },
  note: { fontSize: 12, color: '#94A3B8', marginTop: 8 }
})
