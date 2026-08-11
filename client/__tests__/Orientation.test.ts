// orientation.ts — the JS side of the fullscreen-is-landscape lock (S22 round 4).
// The native module (android OrientationModule) does not exist under jest, on TV
// nothing ever calls this, and older bundles could meet an app without the module —
// so the wrapper's ONE contract worth pinning here is: absent module = silent no-op,
// present module = the mode string forwarded verbatim. The Activity-side behavior
// (SCREEN_ORIENTATION_SENSOR_LANDSCAPE / UNSPECIFIED) is native and device-verified,
// not jest territory.

import { NativeModules } from 'react-native'
import { setOrientation } from '../src/orientation'

afterEach(() => { delete (NativeModules as Record<string, unknown>).AliranOrientation })

test('no-ops (does not throw) when the native module is absent', () => {
  expect((NativeModules as Record<string, unknown>).AliranOrientation).toBeUndefined()
  expect(() => setOrientation('landscape')).not.toThrow()
  expect(() => setOrientation('unspecified')).not.toThrow()
})

test('forwards the mode verbatim when the native module is present', () => {
  const native = jest.fn()
  ;(NativeModules as Record<string, unknown>).AliranOrientation = { setOrientation: native }
  setOrientation('landscape')
  setOrientation('unspecified')
  expect(native.mock.calls).toEqual([['landscape'], ['unspecified']])
})
