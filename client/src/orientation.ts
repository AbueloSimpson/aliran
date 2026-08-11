// Activity orientation lock (phone; S22 round 4 "fullscreen is ALWAYS landscape").
// React Native core cannot set the Android Activity orientation, so a minimal native
// module (android/.../OrientationModule.kt, registered in MainApplication) exposes one
// call. This wrapper is the ONLY way the app talks to it, and it degrades to a no-op
// wherever the native module is absent: jest (no native side at all) and Android TV
// (the module IS registered there, but nothing ever calls this on TV — a TV has no
// orientation to lock, and TV bytes stay identical because this file is phone-path
// only).
import { NativeModules } from 'react-native'

export type OrientationMode = 'landscape' | 'unspecified'

/**
 * 'landscape'   — pin the Activity to sensor landscape (either way up); the OS
 *                 rotates the app immediately regardless of how the phone is held.
 * 'unspecified' — release the pin; the phone returns to its physical orientation.
 */
export function setOrientation (mode: OrientationMode): void {
  const mod = (NativeModules as Record<string, { setOrientation?: (mode: string) => void } | undefined>).AliranOrientation
  mod?.setOrientation?.(mode) // absent native module (jest/TV never wired) = no-op
}
