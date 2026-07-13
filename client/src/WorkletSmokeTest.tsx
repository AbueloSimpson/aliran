// S5b/S5c smoke test — verifies the react-native-bare-kit worklet runtime end to end.
//
// Card 1 (S5b): boots a tiny INLINE Bare worklet and round-trips a message over IPC,
// proving bare-kit builds + runs on this RN 0.83 (New Arch) app and JS<->Bare IPC works.
//
// Card 2 (S5c): boots the REAL P2P backend (client/backend/app.bundle via bare-pack),
// which imports the whole Holepunch stack — sodium-native (4.x AND 5.x), udx-native,
// quickbit/rabin/simdle/crc, fs-native-extensions — so a `{type:'ready'}` here proves all
// Android addon .so files load and initialize. The panel key comes from config/service.json.
//
// Card 3 (S5b finish): full IPC LOGIN round-trip against the desktop dev panel over the
// DHT — {username,password} -> OPRF login -> {type:'streams'}. `ready` fires right after
// swarm.join (before the panel connection exists), so login retries on
// "not connected to panel" until the swarm connects. Credentials come from the dev
// section of the gitignored config/service.json.
//
// Temporary app root until S6 wires the real Login/Home/Player navigation.

import React, { useEffect, useRef, useState } from 'react'
import { ScrollView, Text, View, StyleSheet } from 'react-native'
// @ts-expect-error — native module (react-native-bare-kit)
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { backend, type BackendMessage } from './worklet'
import { loadServiceDescriptor } from './config'

const LOGIN_RETRY_MS = 3000
const LOGIN_MAX_TRIES = 40 // DHT connect from the emulator can take a while

export default function WorkletSmokeTest () {
  const [hello, setHello] = useState('(booting…)')
  const [log, setLog] = useState<string[]>(['(starting backend worklet…)'])
  const [loginState, setLoginState] = useState('(waiting for backend ready…)')
  const [streams, setStreams] = useState<string[] | null>(null)
  const tries = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  useEffect(() => {
    try {
      const { panelPubKey, dev } = loadServiceDescriptor()
      const tryLogin = () => {
        if (!dev) { setLoginState('(no dev credentials in service.json — skipped)'); return }
        tries.current += 1
        setLoginState(`logging in as "${dev.username}" (attempt ${tries.current})…`)
        backend.login(dev.username, dev.password)
      }
      const off = backend.onMessage((m: BackendMessage) => {
        setLog((prev) => [...prev.slice(-19), JSON.stringify(m)])
        if (m.type === 'ready') {
          tryLogin()
        } else if (m.type === 'streams') {
          if (timer.current) clearTimeout(timer.current)
          setStreams(m.streams.map((s) => `${s.id} — ${s.title}${s.isLive ? ' (LIVE)' : ''}`))
          setLoginState(`LOGIN OK — ${m.streams.length} entitled stream(s)`)
        } else if (m.type === 'login-error') {
          // Not connected yet: the swarm is still dialing the panel — retry.
          if (m.message.includes('not connected') && tries.current < LOGIN_MAX_TRIES) {
            setLoginState(`waiting for panel connection (attempt ${tries.current})…`)
            timer.current = setTimeout(tryLogin, LOGIN_RETRY_MS)
          } else {
            setLoginState('LOGIN FAILED: ' + m.message)
          }
        }
      })
      backend.start(panelPubKey)
      setLog((prev) => [...prev, `started; panel=${panelPubKey.slice(0, 16)}…`])
      return () => { off(); if (timer.current) clearTimeout(timer.current) }
    } catch (e: any) {
      setLog((prev) => [...prev, 'ERROR: ' + String(e?.message || e)])
    }
  }, [])

  const ok = hello.startsWith('echo:')
  const ready = log.some((l) => l.includes('"ready"'))
  const loggedIn = streams !== null

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.h1}>Aliran — Worklet smoke test</Text>
        <Text style={styles.sub}>S5b · bare-kit IPC + login &nbsp;·&nbsp; S5c · real backend + native addons</Text>

        <View style={styles.card}>
          <Text style={styles.label}>bare-kit runtime (inline hello):</Text>
          <Text style={[styles.value, { color: ok ? '#4ADE80' : '#E2E8F0' }]} selectable>{hello}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>P2P backend (app.bundle):</Text>
          <Text style={[styles.value, { color: ready ? '#4ADE80' : '#E2E8F0' }]}>
            {ready ? 'READY — Holepunch addons loaded' : 'waiting for {type:ready}…'}
          </Text>
          {log.map((l, i) => (
            <Text key={i} style={styles.logLine} selectable>{l}</Text>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>OPRF login round-trip (S5b):</Text>
          <Text style={[styles.value, { color: loggedIn ? '#4ADE80' : '#E2E8F0' }]} selectable>{loginState}</Text>
          {(streams || []).map((s, i) => (
            <Text key={i} style={styles.logLine} selectable>{s}</Text>
          ))}
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
  logLine: { fontSize: 11, color: '#94A3B8', fontFamily: 'monospace' }
})
