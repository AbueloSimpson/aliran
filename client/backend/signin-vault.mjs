// The at-rest half of a phone -> TV sign-in: how the account keys a handover delivered
// are turned into something a television may keep on its disk, and how a refusal to sign
// back in with them is read.
//
// PURE ON PURPOSE. Nothing here touches the filesystem, the IPC channel or the Android
// Keystore — backend.mjs owns all three. What is left is the part worth testing off a
// television (tools/signin-vault-test.mjs) and the part worth reading on its own: the
// record format, the shape gate, and the one judgement that decides whether a device
// keeps trying or erases the account it is holding.
//
// THE ENVELOPE, AND WHY THERE IS ONE.
//
//   fileKey       32 random bytes, minted HERE, in the Bare worklet
//   box           secretbox(JSON{username, panelPubKey, priv, authPriv}, fileKey)
//   key           fileKey, wrapped by a hardware-held Android Keystore key
//
// The box sits in the app-private prefs file; the wrapped fileKey sits beside it. Neither
// is any use without the other, and the Keystore half cannot be unwrapped by anything but
// this app on this device.
//
// The alternative — hand the two private keys across the IPC boundary and let the native
// side store them whole — is one fewer moving part and was rejected for one reason: the
// account keys would then exist in the React Native runtime, whose debug logger prints
// short IPC lines verbatim into `adb logcat`. The whole `signin-` message family is
// already excluded from that logger BECAUSE the sign-in code, the compared digits and the
// typed digits pass through it. With this envelope the only secret that ever crosses is a
// random file key that is inert without a file the RN layer never sees, and the account's
// private keys never leave the worklet at all. That is a property that can be stated
// plainly, which is worth about forty lines of code.
//
// See docs/security-model.md, "Account keys at rest", for what the Keystore does and
// does not buy on a television.

import b4a from 'b4a'
import { wrap, unwrap } from '@aliran/core'

/** Record format. Bump this and OLD RECORDS ARE DISCARDED, not migrated — a device that
 *  cannot read what it stored asks for a new handover, which costs a viewer one minute
 *  and costs nobody a half-understood record. */
export const SIGNIN_VAULT_VERSION = 1

/** Bytes in the file key. crypto_secretbox_KEYBYTES; asserted, not assumed. */
export const FILE_KEY_BYTES = 32

const USERNAME_MAX = 64
const HEX = /^[0-9a-f]+$/

function hexOfBytes (v, bytes) {
  return typeof v === 'string' && v.length === bytes * 2 && HEX.test(v.toLowerCase()) ? v.toLowerCase() : null
}

/**
 * The account material a 'signin-keys' event delivered, checked to the byte before it is
 * allowed anywhere near a disk. The lengths are the ones sdk/login.js enforces on the way
 * back IN (X25519 secret 32, Ed25519 secret 64), checked again on the way OUT so a record
 * that could never sign in is never written in the first place.
 *
 * @returns the normalized record, or null — and null always means "do not persist".
 */
export function gateSignInKeys (v) {
  if (!v || typeof v !== 'object') return null
  const username = typeof v.username === 'string' && v.username.length > 0 && v.username.length <= USERNAME_MAX ? v.username : null
  const panelPubKey = hexOfBytes(v.panelPubKey, 32)
  const priv = hexOfBytes(v.priv, 32)
  const authPriv = hexOfBytes(v.authPriv, 64)
  if (!username || !panelPubKey || !priv || !authPriv) return null
  return { username, panelPubKey, priv, authPriv }
}

/**
 * The stored envelope, checked on READ. The prefs file is plain JSON on a device, so what
 * comes back is no more trustworthy than what went in — and a half-written record must
 * resolve to "there is nothing saved" rather than to a confusing failure later.
 */
export function gateVaultRecord (v) {
  if (!v || typeof v !== 'object') return null
  if (v.v !== SIGNIN_VAULT_VERSION) return null
  const box = typeof v.box === 'string' && v.box.length > 0 && HEX.test(v.box.toLowerCase()) ? v.box.toLowerCase() : null
  // The wrapped file key is opaque base64 from the platform key store — its shape is the
  // platform's business, so this checks only that it is a plausible non-empty token.
  const key = typeof v.key === 'string' && v.key.length > 0 && v.key.length <= 4096 && /^[A-Za-z0-9+/=\r\n]+$/.test(v.key) ? v.key : null
  if (!box || !key) return null
  return { v: SIGNIN_VAULT_VERSION, box, key, at: Number.isSafeInteger(v.at) ? v.at : 0 }
}

/** Seal gated key material under a file key -> the `box` half of the envelope (hex). */
export function sealSignIn (fileKey, keys) {
  const rec = gateSignInKeys(keys)
  if (!rec) throw new Error('refusing to seal malformed sign-in keys')
  if (!fileKey || fileKey.length !== FILE_KEY_BYTES) throw new Error('file key must be ' + FILE_KEY_BYTES + ' bytes')
  return wrap(fileKey, b4a.from(JSON.stringify(rec)))
}

/**
 * Open the `box` half with a file key. Returns the gated record, or null for every kind
 * of failure there is — a wrong key, a truncated box, JSON that is not this record, a
 * record whose key lengths have drifted. ONE null for all of them on purpose: the caller
 * does the same thing in every case (erase and ask for a new handover), and telling them
 * apart would only invite a caller to treat one of them as recoverable.
 */
export function openSignIn (fileKey, boxHex) {
  try {
    if (!fileKey || fileKey.length !== FILE_KEY_BYTES) return null
    if (typeof boxHex !== 'string' || !boxHex) return null
    const plain = unwrap(fileKey, boxHex)
    if (!plain) return null
    return gateSignInKeys(JSON.parse(b4a.toString(plain)))
  } catch {
    return null
  }
}

/**
 * Does this refusal mean the stored keys are DEAD — erase them — or only that right now
 * is a bad time to ask?
 *
 * The direction of the default matters. Unknown failures are read as transient, because a
 * device that erases an account over a swarm that had not finished dialling sends a viewer
 * to fetch their phone for nothing. What that default must never swallow is the operator
 * saying no, so every way the PANEL can refuse this device is listed explicitly below:
 *
 *   'session failed: …'      the panel looked at this account and this device and said no
 *                            — disabled account, device limit, a failed signature. The one
 *                            exception is 'sessions unavailable', which is the panel
 *                            missing its own signing key, not a verdict about anybody.
 *   'unknown user'           the account is gone from the signed record.
 *   'key handover does not   the X25519 key no longer opens this account. THIS IS WHAT A
 *    match this account'     PASSWORD ROTATION LOOKS LIKE FROM HERE: the panel mints a
 *                            fresh keypair on set-password, so an operator who changes a
 *                            viewer's password has already evicted every device holding
 *                            the old keys, and the record on this disk is inert.
 *   'panel returned an       the session token does not verify against the signed DB key.
 *    invalid session token'  Whatever this device is talking to, it is not the operator
 *                            these keys belong to.
 *   'must be N bytes'        our own stored record is malformed (sdk/login.js's length
 *                            guard). It can never succeed, so it can only sit there.
 *
 * COUPLED TO sdk/login.js PROSE. These are substrings of messages that engine writes;
 * tools/signin-vault-test.mjs pins each one so a reworded error cannot quietly turn an
 * operator's revocation into an infinite retry.
 *
 * @param {Error|string} err
 * @returns {boolean} true = erase the stored material
 */
export function terminalSignInError (err) {
  const msg = String((err && err.message) || err || '').toLowerCase()
  if (!msg) return false
  // A panel that cannot issue sessions at all is broken, not deciding anything.
  if (msg.includes('sessions unavailable')) return false
  return (
    msg.includes('session failed:') ||
    msg.includes('unknown user') ||
    msg.includes('key handover does not match this account') ||
    msg.includes('panel returned an invalid session token') ||
    msg.includes('the key handover did not sign this device in') ||
    /\bmust be \d+ bytes\b/.test(msg)
  )
}
