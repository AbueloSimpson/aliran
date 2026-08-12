// CHANNEL UP / DOWN from the remote (television only).
//
// These two keys never reach React Native on their own. The tvOS fork's Android key
// bridge carries the D-pad, ENTER and the media transport keys and nothing else, and
// this app's own focus-strip rig cannot catch them either: a strip is only ever reached
// by a key that MOVES FOCUS, and CHANNEL UP/DOWN move it nowhere. So the Activity
// forwards them (MainActivity.onKeyDown) and this is the JS end of that wire.
//
// Consuming them was measured to be safe first: with the app in the foreground the
// system publishes keycodes 166/167 straight to our own ViewRootImpl and acts on them
// nowhere else. The VOLUME keys are the opposite case and are deliberately left alone —
// see the note beside the in-app volume state in LiveScreen.
import { DeviceEventEmitter, Platform } from 'react-native'

export type ChannelKey = 'up' | 'down'

/** Mirrors MainActivity.CHANNEL_KEY_EVENT — the two names must stay identical. */
const EVENT = 'aliranChannelKey'

/**
 * Subscribe to the remote's CHANNEL keys. Returns the unsubscribe.
 *
 * A no-op off television: nothing emits the event there, and a phone has no such keys —
 * so callers need no Platform check of their own.
 */
export function onChannelKey (handler: (direction: ChannelKey) => void): () => void {
  if (!Platform.isTV) return () => {}
  const sub = DeviceEventEmitter.addListener(EVENT, (direction: ChannelKey) => {
    if (direction === 'up' || direction === 'down') handler(direction)
  })
  return () => sub.remove()
}
