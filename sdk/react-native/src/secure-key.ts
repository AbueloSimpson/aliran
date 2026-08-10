// Platform key-store binding (Android): typed wrappers over the NativeModules.AliranSecureKey
// module that ships in this package's android/ library (autolinked into any consuming RN
// app). It wraps and unwraps a few bytes with an AES-GCM key held inside the Android
// Keystore — the app can use that key but cannot read it, and on a device with a hardware
// keymaster it never leaves the TEE.
//
// WHAT IT IS FOR. A television signed in by a phone has no password to remember, so the
// engine's 'signin-keys' material is the only way it can sign itself back in after Android
// reclaims the process. That material is sealed by the worklet under a random file key,
// and the file key is what comes through here. This binding therefore never sees an
// account key — only 32 opaque bytes that are useless without a file it has no access to.
//
// EVERY CALL DEGRADES RATHER THAN THROWING AT IMPORT. On iOS, on desktop, under jest, or
// in an APK built before this library existed, wrap()/unwrap() resolve null and status()
// answers "unavailable". A null from wrap() means "this device cannot keep a sign-in" and
// a null from unwrap() means "whatever was kept cannot be read" — the app treats both as
// "show the sign-in screen", never as an error to put in front of a viewer.

import { NativeModules, Platform } from 'react-native'

interface AliranSecureKeyNative {
  wrapBytes (plainB64: string): Promise<string>
  unwrapBytes (blobB64: string): Promise<string>
  reset (): Promise<boolean>
  status (): Promise<SecureKeyStatus>
}

/** What the device's key store actually is. Read it to REPORT, never to decide whether to
 *  store — a software-only key still binds the record to this app on this device. */
export interface SecureKeyStatus {
  /** A usable key store exists here. False = this build/device cannot keep a sign-in. */
  available: boolean
  /** The wrapping key lives in secure hardware (TEE or StrongBox). When false, do not
   *  make hardware claims about anything sealed with it. */
  hardwareBacked: boolean
  /** 'strongbox' | 'tee' | 'software' | 'unknown' | 'none' — for diagnostics only. */
  securityLevel: string
}

function native (): AliranSecureKeyNative | null {
  if (Platform.OS !== 'android') return null
  return ((NativeModules as Record<string, unknown>).AliranSecureKey as AliranSecureKeyNative) ?? null
}

/** Seal bytes (base64 in, base64 out) with this app's key-store key, creating it on first
 *  use. Resolves null where there is no key store to use — the caller must then keep
 *  nothing rather than fall back to storing it in the clear. */
export async function secureWrap (plainB64: string): Promise<string | null> {
  const m = native()
  if (!m) return null
  try { return await m.wrapBytes(plainB64) } catch { return null }
}

/** Open what secureWrap() sealed. Resolves null for every failure there is — no key any
 *  more, a blob from another device, a corrupted record — because the caller does the
 *  same thing in all of them: erase the record and ask for a new sign-in. */
export async function secureUnwrap (blobB64: string): Promise<string | null> {
  const m = native()
  if (!m) return null
  try { return await m.unwrapBytes(blobB64) } catch { return null }
}

/** Destroy this app's wrapping key, so anything sealed under it is unreadable for good.
 *  Sign-out calls this beside clearing the record itself. Never rejects. */
export async function secureReset (): Promise<boolean> {
  const m = native()
  if (!m) return false
  try { return await m.reset() } catch { return false }
}

/** Describe the key store (diagnostics, and honest wording in a security note). Never
 *  rejects: an absent module answers unavailable. */
export async function secureKeyStatus (): Promise<SecureKeyStatus> {
  const m = native()
  const none: SecureKeyStatus = { available: false, hardwareBacked: false, securityLevel: 'none' }
  if (!m) return none
  try {
    const s = await m.status()
    return {
      available: s?.available === true,
      hardwareBacked: s?.hardwareBacked === true,
      securityLevel: typeof s?.securityLevel === 'string' ? s.securityLevel : 'unknown'
    }
  } catch { return none }
}
