// Boots the Bare worklet (the P2P backend) via the @aliran/react-native binding —
// this app dogfoods the public SDK surface. See sdk/react-native and backend/backend.mjs.

import { AliranBackend, type HybridConfig } from '@aliran/react-native'
// Base64-encoded Bare bundle produced by `npm run bundle-backend` (app.bundle.js is a
// generated CommonJS module: `module.exports = "<base64>"`). The binding decodes it.
import bundleBase64 from '../backend/app.bundle.js'

export type { Stream, BackendMessage } from '@aliran/react-native'

class Backend extends AliranBackend {
  boot (panelPubKey: string, hybrid?: HybridConfig) {
    // debug: every backend message hits `adb logcat -s ReactNativeJS` — this
    // instrumentation has caught every on-device failure so far; keep it.
    this.start(bundleBase64, { panelPubKey, hybrid, debug: true })
  }
}

export const backend = new Backend()
