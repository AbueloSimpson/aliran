// Mount deferral for heavy subtrees (S22 round 6): a screen that renders its full
// weight in the first commit stalls the navigation transition — the tap "does
// nothing" until the commit lands. Gating the heavy children on this hook lets the
// transition run immediately (the light shell paints first) and mounts the content
// right after the interaction/animation settles.
//
// InteractionManager fires after the nav animation on both platforms; the rAF
// fallback covers environments without pending interactions (and jest, where the
// timers resolve in act()). TV uses this too via LiveScreen only where phone-gated —
// callers keep TV behavior byte-identical by not gating TV paths.
import { useEffect, useState } from 'react'
import { InteractionManager } from 'react-native'

export function useMountDeferred (): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let alive = true
    const task = InteractionManager.runAfterInteractions(() => { if (alive) setReady(true) })
    return () => { alive = false; task.cancel() }
  }, [])
  return ready
}
