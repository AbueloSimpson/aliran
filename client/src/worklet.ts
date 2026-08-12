// Boots the Bare worklet (the P2P backend) via the @aliran/react-native binding —
// this app dogfoods the public SDK surface. See sdk/react-native and backend/backend.mjs.

import { Platform } from 'react-native'
import { AliranBackend, getAppInfo, type HybridConfig, type RemoteFeatures } from '@aliran/react-native'
// Fallback app version for viewer problem reports (S50c). The REAL version comes
// from the native installer module (getAppInfo().versionName — the installed build's
// gradle versionName, per-brand); package.json only answers where that module is
// absent (dev/desktop/stale APK) and is known-stale there.
import { version as APP_VERSION } from '../package.json'
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

// "Send to TV": which half of it THIS device may play. The flags are not one switch —
// two of them are OPPOSITES on a television, on purpose — and reading them as one is the
// mistake this note exists to prevent.
//
//   sendToTv    the SENDING half. It makes every login keep the account's two private
//               keys in memory for the whole session, because a phone cannot recover them
//               later without the password (sdk/login.js `handover`). So it is asked for
//               only where it is used — a phone or a tablet, which is what a viewer picks
//               up to sign a television in. A television is never the sending device, so
//               a TV build holds nothing it could pass on.
//
//   keepSignIn  the RECEIVING half, and the only one about DISK. A set signed in by a
//               phone has no password to remember, so without this it comes back to the
//               sign-in screen every time Android reclaims the app process — which left a
//               handover-signed-in television WORSE off than a password-signed-in one and
//               defeated the feature. On, the material is kept, sealed under a key held
//               in the Android Keystore, and the set signs itself back in at the next
//               start (backend.resumeSignIn — see client/backend/backend.mjs).
//
//               TELEVISIONS ONLY, and not because a phone could not: a phone signed in by
//               another phone still has a keyboard and a password, so an account's keys at
//               rest on one more device buy nothing there. Every device holding key
//               material is a device an operator has to be able to reason about, so this
//               is on exactly where it is needed and nowhere else.
//
//   control     "Play on my TV" — the rendezvous the account's own devices meet on. ON
//               EVERYWHERE, because both ends of it are this app: a phone joins as the
//               controller that sends, a television joins as the one that announces and
//               takes commands, and a device that never joined is a device that cannot
//               be sent to. What it costs is a derived account secret held for the
//               session — not a key, but a live authenticator and a stable correlator
//               for "these devices are one account", which is why the engine keeps it
//               off until something asks. Nothing here is written down and no topic is
//               joined until startRemote() is called (client/src/sendToTv.ts calls it
//               after login, per role).
//
// Boot-time only, and there is no runtime switch on purpose: by the time one could be
// flipped the login has already happened, so the key material is either retained or
// unrecoverable. Settings hides "Sign in a TV" on the same test.
const REMOTE: RemoteFeatures = { sendToTv: !Platform.isTV, keepSignIn: Platform.isTV, control: true }

// The version stamped on problem reports: the NATIVE versionName when the installer
// module can say (the truth about the installed build), package.json otherwise.
// getAppInfo() never rejects — it resolves null where the module is absent.
async function appVersion (): Promise<string> {
  const info = await getAppInfo()
  return info?.versionName || APP_VERSION
}

// Both boot paths below are called ONCE PER REACT ROOT, not once per app run, and on a
// television that is the difference between a working app and a dead one: Android
// recreates the activity when the viewer leaves for the launcher and comes back, the RN
// root re-runs over a process — and a Bare worklet — that never stopped, and this class
// is booted a second time. AliranBackend.start() re-attaches for exactly that reason
// (see its docstring); nothing here has to detect it.
class Backend extends AliranBackend {
  async boot (panelPubKey: string, hybrid?: HybridConfig) {
    // debug: every backend message hits `adb logcat -s ReactNativeJS` — this
    // instrumentation has caught every on-device failure so far; keep it.
    // prewarm: open the first N channels' feeds right after login so the FIRST zap to a
    // channel is warm (not just re-zaps). Capped so a large lineup doesn't join hundreds
    // of DHT topics at once; a bounded TV lineup warms fully.
    this.start(bundleBase64, { panelPubKey, hybrid, prewarm: PREWARM_CHANNELS, zapPrefetch: ZAP_PREFETCH, remote: REMOTE, appVersion: await appVersion(), debug: true })
  }

  // Public (keyless) flavor, S36: boot the worklet WITHOUT a panel so the persisted
  // prefs — including a runtime-saved service — are readable first. Splash then either
  // connect()s to the saved panel or routes to the Connect screen. Same engine policy
  // as boot(); only the panel key arrives later.
  async bootIdle (hybrid?: HybridConfig) {
    this.start(bundleBase64, { hybrid, prewarm: PREWARM_CHANNELS, zapPrefetch: ZAP_PREFETCH, remote: REMOTE, appVersion: await appVersion(), debug: true })
  }
}

export const backend = new Backend()
