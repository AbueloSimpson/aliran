// Boots the Bare worklet (the P2P backend) via the @aliran/react-native binding —
// this app dogfoods the public SDK surface. See sdk/react-native and backend/backend.mjs.

import { AliranBackend, type HybridConfig } from '@aliran/react-native'
// Base64-encoded Bare bundle produced by `npm run bundle-backend` (app.bundle.js is a
// generated CommonJS module: `module.exports = "<base64>"`). The binding decodes it.
import bundleBase64 from '../backend/app.bundle.js'

export type { Stream, BackendMessage } from '@aliran/react-native'

// How many channels to pre-warm at login (lowest curated order first). Covers the
// typical zapping range; bounded so a big catalog doesn't open too many topics at once.
const PREWARM_CHANNELS = 12

// Adjacent-channel zap prefetch (keep the next/previous channels' newest segment
// replicated while watching, so CH+/CH- starts from warm bytes). This is only the
// COMPILED DEFAULT for first boot: the Settings "Smooth zapping" toggle persists the
// user's choice in the worklet prefs, which overrides this value on every boot and
// switches the engine live via backend.setZapPrefetch(). OFF by default — unlike
// prewarm it costs standing bandwidth ≈ the neighbors' bitrate while a channel
// plays (the engine's adaptive gate suspends it on metered networks, stalls, or a
// thin pipe — see sdk/player.js).
const ZAP_PREFETCH: boolean = false

class Backend extends AliranBackend {
  boot (panelPubKey: string, hybrid?: HybridConfig) {
    // debug: every backend message hits `adb logcat -s ReactNativeJS` — this
    // instrumentation has caught every on-device failure so far; keep it.
    // prewarm: open the first N channels' feeds right after login so the FIRST zap to a
    // channel is warm (not just re-zaps). Capped so a large lineup doesn't join hundreds
    // of DHT topics at once; a bounded TV lineup warms fully.
    this.start(bundleBase64, { panelPubKey, hybrid, prewarm: PREWARM_CHANNELS, zapPrefetch: ZAP_PREFETCH, debug: true })
  }

  // Public (keyless) flavor, S36: boot the worklet WITHOUT a panel so the persisted
  // prefs — including a runtime-saved service — are readable first. Splash then either
  // connect()s to the saved panel or routes to the Connect screen. Same engine policy
  // as boot(); only the panel key arrives later.
  bootIdle (hybrid?: HybridConfig) {
    this.start(bundleBase64, { hybrid, prewarm: PREWARM_CHANNELS, zapPrefetch: ZAP_PREFETCH, debug: true })
  }
}

export const backend = new Backend()
