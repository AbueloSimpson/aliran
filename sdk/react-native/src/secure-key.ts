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
// in an APK built before this library existed, wrap()/unwrap() report 'absent' and status()
// answers "unavailable". Nothing here ever rejects, and nothing here is an error to put in
// front of a viewer.
//
// THE FAILURE CODE IS THE PRODUCT. An earlier revision of this file answered `null` for
// every failure and threw the native module's code away in a bare `catch`. That collapsed
// three unrelated conditions into one — a key store that was busy for a moment at cold
// boot became indistinguishable from a key that is gone for good — and the caller's only
// response to "gone for good" is to ERASE the account the television is holding. So the
// code survives, and the caller decides: 'unavailable' is transient and keeps the record,
// 'locked' and 'bad-blob' mean the sealed bytes can never be opened again.

import { NativeModules, Platform } from 'react-native'

interface AliranSecureKeyNative {
  wrapBytes (plainB64: string): Promise<string>
  unwrapBytes (blobB64: string): Promise<string>
  reset (): Promise<boolean>
  status (): Promise<SecureKeyStatus>
}

/** Why a wrap or unwrap did not produce bytes. Only 'locked' and 'bad-blob' are proof that
 *  what was sealed is unreadable for good; everything else says "not right now". */
export type SecureKeyError =
  /** No key store on this device, or it could not be opened at all (E_UNAVAILABLE). The
   *  Android keystore daemon is not always up the instant an app starts. TRANSIENT. */
  | 'unavailable'
  /** There is no key for this app any more — uninstall/restore, a keystore reset, a wiped
   *  alias (E_LOCKED). Anything sealed under it is unreadable. TERMINAL. */
  | 'locked'
  /** The input was not produced by this key: truncated, corrupted, or from another device
   *  (E_BAD_BLOB). TERMINAL. */
  | 'bad-blob'
  /** No native module here at all — iOS, desktop, jest, or an APK built before this
   *  library shipped. Nothing was attempted. TRANSIENT (there is nothing to erase over). */
  | 'absent'
  /** The module answered with a code this version does not know. TRANSIENT, because an
   *  unrecognised code is not evidence of anything. */
  | 'unknown'

/** What a wrap/unwrap produced: the base64 bytes, or the reason there are none. */
export type SecureKeyResult =
  | { ok: true; data: string }
  | { ok: false; code: SecureKeyError }

/** What the device's key store actually is. Read it to REPORT, never to decide whether to
 *  store — a software-only key still binds the record to this app on this device. */
export interface SecureKeyStatus {
  /** A usable key store exists here. False = this build/device cannot keep a sign-in. */
  available: boolean
  /** The wrapping key lives in secure hardware (TEE or StrongBox). When false, do not
   *  make hardware claims about anything sealed with it. False is also what a device with
   *  no key YET reports — see `keyPresent`. */
  hardwareBacked: boolean
  /** 'strongbox' | 'tee' | 'software' | 'unknown' | 'none' — for diagnostics only.
   *  'unknown' where the store works but has nothing to describe (`keyPresent` false):
   *  Android cannot report a key's security level before the key exists, and status() will
   *  not create one to find out. */
  securityLevel: string
  /** This app already has a wrapping key. False on a device that has never kept a sign-in,
   *  which is why the two fields above cannot describe anything yet. */
  keyPresent?: boolean
}

/** The three codes the native module rejects with, mapped onto the vocabulary above.
 *  An unlisted code is 'unknown' rather than an assumption. */
function codeOf (e: unknown): SecureKeyError {
  const raw = (e as { code?: unknown })?.code
  switch (raw) {
    case 'E_UNAVAILABLE': return 'unavailable'
    case 'E_LOCKED': return 'locked'
    case 'E_BAD_BLOB': return 'bad-blob'
    default: return 'unknown'
  }
}

function native (): AliranSecureKeyNative | null {
  if (Platform.OS !== 'android') return null
  return ((NativeModules as Record<string, unknown>).AliranSecureKey as AliranSecureKeyNative) ?? null
}

/** Seal bytes (base64 in, base64 out) with this app's key-store key, creating it on first
 *  use. A failure means the caller must keep NOTHING rather than fall back to storing it
 *  in the clear — but it may try again, and `code` says whether that is worth doing. */
export async function secureWrap (plainB64: string): Promise<SecureKeyResult> {
  const m = native()
  if (!m) return { ok: false, code: 'absent' }
  try {
    const data = await m.wrapBytes(plainB64)
    return typeof data === 'string' && data.length > 0 ? { ok: true, data } : { ok: false, code: 'unknown' }
  } catch (e) { return { ok: false, code: codeOf(e) } }
}

/** Open what secureWrap() sealed. `code` is the whole point on this side: 'locked' and
 *  'bad-blob' mean these bytes will never open again and the record beside them is dead
 *  weight, while 'unavailable' means the key store could not be reached THIS TIME and the
 *  record must be left exactly where it is. */
export async function secureUnwrap (blobB64: string): Promise<SecureKeyResult> {
  const m = native()
  if (!m) return { ok: false, code: 'absent' }
  try {
    const data = await m.unwrapBytes(blobB64)
    return typeof data === 'string' && data.length > 0 ? { ok: true, data } : { ok: false, code: 'unknown' }
  } catch (e) { return { ok: false, code: codeOf(e) } }
}

/** Destroy this app's wrapping key, so anything sealed under it is unreadable for good.
 *  Sign-out calls this beside clearing the record itself. Never rejects. */
export async function secureReset (): Promise<boolean> {
  const m = native()
  if (!m) return false
  try { return await m.reset() } catch { return false }
}

/** Describe the key store (diagnostics, and honest wording in a security note). Never
 *  rejects: an absent module answers unavailable.
 *
 *  READ-ONLY, and it has to be: this is exported from the package, so a host may call it on
 *  a phone that will never keep a sign-in. It reports what is there and CREATES NOTHING —
 *  an earlier revision minted the wrapping key as a side effect of describing it, which
 *  left a permanent Keystore entry behind on every device that merely asked. */
export async function secureKeyStatus (): Promise<SecureKeyStatus> {
  const m = native()
  const none: SecureKeyStatus = { available: false, hardwareBacked: false, securityLevel: 'none', keyPresent: false }
  if (!m) return none
  try {
    const s = await m.status()
    return {
      available: s?.available === true,
      hardwareBacked: s?.hardwareBacked === true,
      securityLevel: typeof s?.securityLevel === 'string' ? s.securityLevel : 'unknown',
      keyPresent: s?.keyPresent === true
    }
  } catch { return none }
}
