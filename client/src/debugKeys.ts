// The DEBUG key from the remote (television only) — INFO or the YELLOW fkey toggles
// the Debug overlay (StatsHud) while watching, no trip to Settings needed.
//
// Same wire as channelKeys.ts, for the same reason: these keys never reach React
// Native on their own (the tvOS fork's key bridge carries the D-pad, ENTER and the
// media transport keys and nothing else), and the focus-strip rig cannot catch them
// either — a strip is only reached by a key that MOVES FOCUS, and INFO moves it
// nowhere. So MainActivity.onKeyDown forwards them and this is the JS end.
//
// Consuming them is safe by the same measurement as the channel keys: with the app
// foregrounded the system publishes KEYCODE_INFO (165) / KEYCODE_PROG_YELLOW (185)
// to our own ViewRootImpl and acts on them nowhere else.
import { DeviceEventEmitter, Platform } from 'react-native'

/** Mirrors MainActivity.DEBUG_KEY_EVENT — the two names must stay identical. */
const EVENT = 'aliranDebugKey'

/**
 * Subscribe to the remote's debug-overlay key. Returns the unsubscribe.
 *
 * A no-op off television: nothing emits the event there — the phone's affordance is
 * the Settings toggle — so callers need no Platform check of their own.
 */
export function onDebugKey (handler: () => void): () => void {
  if (!Platform.isTV) return () => {}
  const sub = DeviceEventEmitter.addListener(EVENT, () => handler())
  return () => sub.remove()
}
