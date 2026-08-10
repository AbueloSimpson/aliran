// Reduced-motion preference (OS accessibility setting). Style arrays want a
// synchronous answer at render time, but RN only exposes an async getter — so the
// answer is cached at module init and kept fresh by the change listener. Defaults to
// false (full motion) until the first resolve; a frame or two of scale on a
// reduced-motion device is the acceptable race. Consumers gate TRANSFORMS only —
// the focus fill/border grammar (theme.ts) always applies.
import { AccessibilityInfo } from 'react-native'

let reduceMotion = false

AccessibilityInfo.isReduceMotionEnabled().then((enabled) => { reduceMotion = enabled }).catch(() => {})
// Module-lifetime subscription (never removed): the cache must track the OS setting
// for as long as the app runs, exactly like the theme singleton.
AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => { reduceMotion = enabled })

/** True when the OS asks for reduced motion — skip scale/slide transforms. */
export function prefersReducedMotion (): boolean {
  return reduceMotion
}
