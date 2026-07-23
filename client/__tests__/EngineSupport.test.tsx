// Older-Android silent degradation: a legacy build (ALIRAN_LEGACY=1) ships WITHOUT
// the bare-kit native module — requiring react-native-bare-kit throws there, and the
// SDK must stay silently inactive: isSupported() false, start() and every method a
// safe no-op, no message ever firing, nothing queueing. The modern build keeps
// today's behavior (lazy Worklet construction is the only shared-path change).
// The real thing is exercised on an API 23 emulator; these tests pin the contract.

import { AliranBackend } from '@aliran/react-native'

describe('modern build (bare-kit present — the jest mock stands in for it)', () => {
  test('isSupported() is true', () => {
    expect(AliranBackend.isSupported()).toBe(true)
  })

  test('start() wires the worklet and flushes the pre-start queue', () => {
    const b = new AliranBackend()
    b.requestPrefs() // pre-start sends queue (splash asks for prefs while booting)
    expect((b as any).pending.length).toBe(1)
    b.start('QQquébec', {}) // any base64-ish string; the mock worklet ignores it
    expect((b as any).ipc).toBeTruthy()
    expect((b as any).pending.length).toBe(0)
  })
})

describe('legacy build (no bare-kit native module)', () => {
  // A fresh module registry where requiring react-native-bare-kit throws, exactly
  // like the real package's TurboModuleRegistry.getEnforcing does in a build that
  // excluded it from autolinking.
  function withEngineless (fn: (B: typeof AliranBackend) => void) {
    jest.isolateModules(() => {
      jest.doMock('react-native-bare-kit', () => { throw new Error('BareKit TurboModule missing') })
      const { AliranBackend: B } = require('@aliran/react-native')
      fn(B)
    })
  }

  test('isSupported() is false', () => {
    withEngineless((B) => expect(B.isSupported()).toBe(false))
  })

  test('start() and every backend method are silent no-ops', () => {
    withEngineless((B) => {
      const b = new B()
      const seen: unknown[] = []
      b.onMessage((m: unknown) => seen.push(m))
      expect(() => {
        b.play('queued-before-start') // pre-start queue path must not throw either
        b.start('QQquébec', { panelPubKey: 'ab'.repeat(32) })
        b.connect('cd'.repeat(32))
        b.login('viewer', 'pw')
        b.play('news')
        b.reconnect()
        b.requestPrefs()
        b.saveCredentials('viewer', 'pw')
        b.clearCredentials()
        b.toggleFavorite('news')
        b.setZapPrefetch(true)
        b.setNetworkProfile(true, true)
      }).not.toThrow()
      expect((b as any).worklet).toBeNull() // never constructed
      expect((b as any).pending.length).toBe(0) // queue dropped, nothing accumulates
      expect(seen).toEqual([]) // no listener ever fires
    })
  })

  test('isSupported() stays false on repeat calls (probe is cached, not re-thrown)', () => {
    withEngineless((B) => {
      expect(B.isSupported()).toBe(false)
      expect(B.isSupported()).toBe(false)
    })
  })
})
