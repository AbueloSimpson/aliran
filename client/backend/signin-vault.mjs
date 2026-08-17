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
// random file key that is inert without a file the RN layer never sees.
//
// WHAT "THE KEYS NEVER LEAVE THE WORKLET" IS, AND IS NOT. It is not a sandbox. Bare runs on
// a thread INSIDE the app's own process: same UID, same files, same debugger. The claim is
// about code organisation and about one wire — the account keys are only ever in this
// runtime's heap, so they never enter the RN message stream, and therefore never the
// logger, never a host listener, never a problem report, never a screen's state. That is
// worth about forty lines of code. It is not a defence against anything running as the app.
// Nor can any of it be zeroed afterwards: the file key and both account keys are immutable
// JavaScript strings, and every hop that handles them makes another copy — the engine's
// payload, the event this file gates, and the record the gate returns. Nothing here can
// overwrite any of them; they sit in the heap until a garbage collector that owes no
// promises gets to them, which in practice means for the life of the process. See
// docs/security-model.md, "Account keys at rest".
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

/** The prefix sdk/login.js puts in front of whatever the panel's `session` responder
 *  answered with: `throw new Error('session failed: ' + sres.error)`. */
const SESSION_FAILED = 'session failed: '

/**
 * The `session` error codes that are a VERDICT ABOUT THIS ACCOUNT ON THIS DEVICE, and
 * therefore the only ones behind that prefix that may erase.
 *
 * The prefix alone is not a verdict, and reading it as one was a real defect: the same
 * responder (panel/src/rpc.js) answers 'bad request', 'no session challenge (login
 * first)', 'missing deviceId' and 'auth failed' — refusals of the REQUEST, produced by a
 * malformed call, a lost one-shot challenge, or a panel-side record whose authPub does not
 * decode. None of them is the operator deciding anything about this television, and every
 * one of them used to erase an account on its first occurrence.
 *
 * 'auth failed' is the one worth naming, because it looks like a verdict and is not. A
 * wrong X25519 key is already caught earlier and by name ('key handover does not match
 * this account'), and the panel mints BOTH keypairs together on set-password — so a
 * password rotation shows up there, not here. What is left is a signature that did not
 * verify against a challenge, which a stale one-shot challenge and an undecodable stored
 * authPub reach just as easily as a genuinely dead key. Keep, and let the bounded retry
 * give up on its own.
 *
 * NOT HERE EITHER, AND IT USED TO BE: 'device-limit'. It reads like a verdict and is not
 * one either — it says the operator's SLOTS ARE FULL, not that these keys are dead, and
 * the two differ in the way that matters: slots free. A viewer signs another device out,
 * an admin revokes one, or the operator raises the limit, and the same stored keys work
 * again. Erasing helps nobody — the viewer must then redo a handover AND still meet the
 * same limit — while keeping means the set signs itself in the moment a slot frees. It
 * belongs beside 'sessions unavailable': a fact about the operator's configuration, not a
 * judgement on this account.
 *
 * What has CHANGED about how a slot frees, and it matters for the sentence above: an
 * enrolment no longer expires on its own. It used to lapse after sessionTtlMs (30 days),
 * which made "wait and it will free itself" literally true. The panel now keeps the
 * enrolment until something removes it — a revoke, a token-version bump, or a new device
 * evicting the LEAST RECENTLY USED one. So the wait is no longer unbounded-but-certain;
 * it is until somebody acts. The classification is unchanged and for the same reason
 * (this is the operator's configuration, not a judgement on these keys), and keeping is
 * now MORE clearly right, not less: under 'reject' a television that erased would have
 * to redo a handover to reach a limit that will not clear itself either.
 *
 * Two things about it are worth having written down, because they cut opposite ways and
 * both are true. It is UNREACHABLE on any deployment this repo ships: panel/src/rpc.js
 * takes `devicePolicy` as a parameter defaulting to 'evict', and panel/src/index.js never
 * passes it, so the limit evicts the least recently used device instead of refusing the new
 * one. And it is the ONLY entry on either list that ANOTHER DEVICE can trigger: on an
 * operator who does set 'reject', a television that lost its slot — evicted while it was
 * switched off, or revoked — comes back as a new device, finds the household's other sets
 * holding every slot, and, under the old classification, destroyed its account keys over
 * somebody else's phone. (It used to reach that state a third way, by its enrolment simply
 * expiring after 30 days. That no longer happens: enrolments are durable, so a set that is
 * merely switched off for a season keeps its slot and never sees this code at all.)
 *
 * KEEPING IT COSTS A RETRY EVERY BOOT, which is why it could not land on its own: a
 * kept-and-refused sign-in is retried, and until the restore door's budget was denominated
 * in panel logins rather than seconds, that retry loop was how a television locked itself
 * out. See client/src/screens/SplashScreen.tsx.
 *
 * NOT HERE, AND THE EASIEST CALL ON THE LIST: 'busy'. The panel settles the account record
 * with a compare-and-swap so a concurrent admin change cannot be lost, and answers 'busy'
 * when it loses that race more times than its bound allows. It is a moment passing, not a
 * fact about anything — the credentials were already verified before the panel got there —
 * and the next attempt normally wins. Keep, and let the bounded retry do its work.
 *
 * tools/signin-vault-test.mjs reads the responder's literals OUT OF panel/src/rpc.js and
 * fails if a code appears there that this list has never classified.
 */
const PANEL_VERDICTS = [
  'account disabled', // the operator disabled the account
  'unknown user' //      the PANEL's own db has no such account (see the note below)
]

/**
 * Does this refusal mean the stored keys are DEAD — erase them — or only that right now
 * is a bad time to ask?
 *
 * ERASING IS THE ONLY IRREVERSIBLE ACTION IN THIS DESIGN, and its cost is a viewer walking
 * to another room for a phone. So the default runs one way: an unknown failure is
 * transient, and a failure only erases when it is positive evidence that the material can
 * never work again. The four below are that evidence, plus the panel verdicts above:
 *
 *   'key handover does not   the X25519 key no longer opens this account. THIS IS WHAT A
 *    match this account'     PASSWORD ROTATION LOOKS LIKE FROM HERE: the panel mints a
 *                            fresh keypair on set-password, so an operator who changes a
 *                            viewer's password has already evicted every device holding
 *                            the old keys, and the record on this disk is inert.
 *   'panel returned an       the session token does not verify against the signed DB key.
 *    invalid session token'  Whatever this device is talking to, it is not the operator
 *                            these keys belong to.
 *   'the key handover did    the panel accepted the call and issued no token. The only
 *    not sign this device    reason to run this path is to be issued one, so a success
 *    in'                     with no token is a refusal in every way that matters.
 *   'must be N bytes'        our own stored record is malformed (sdk/login.js's length
 *                            guard). It can never succeed, so it can only sit there.
 *
 * NOT HERE, AND DELIBERATELY: a BARE 'unknown user'. sdk/login.js throws it after reading
 * the account out of the LOCALLY REPLICATED signed record, so on a cold start it means
 * "this device's copy of the record does not have that account YET" at least as often as
 * it means the account is gone — the bee is empty for the first moments after the panel
 * socket comes up. The panel's own authoritative answer arrives with the prefix above
 * ('session failed: unknown user') and does erase. See accountNotReplicatedYet().
 *
 * @param {Error|string} err
 * @returns {boolean} true = erase the stored material
 */
export function terminalSignInError (err) {
  const msg = String((err && err.message) || err || '').toLowerCase().trim()
  if (!msg) return false
  // Anything the panel's `session` responder said is decided by the code alone — including
  // 'sessions unavailable', a panel missing its own signing key, which is not a verdict
  // about anybody and is simply absent from the list.
  const at = msg.indexOf(SESSION_FAILED)
  if (at >= 0) {
    const code = msg.slice(at + SESSION_FAILED.length)
    return PANEL_VERDICTS.some((v) => code.startsWith(v))
  }
  return (
    msg.includes('key handover does not match this account') ||
    msg.includes('panel returned an invalid session token') ||
    msg.includes('the key handover did not sign this device in') ||
    /\bmust be \d+ bytes\b/.test(msg)
  )
}

/**
 * Is this the account record simply not having replicated to this device yet?
 *
 * sdk/login.js reads `user/<name>` out of the local hyperbee replica before it proves
 * anything, and throws a bare 'unknown user' when that read comes back empty. At the first
 * instant the panel RPC socket is usable the replica can still be EMPTY — the handover
 * path waits up to 30 s for exactly this (sdk/player.js _applySignIn) and the resume path
 * has to wait too, or a television erases its account over a cold DHT.
 *
 * Matched on the WHOLE message so the panel's authoritative 'session failed: unknown user'
 * — which comes from the panel's own database and IS a verdict — cannot land here.
 *
 * @param {Error|string} err
 * @returns {boolean} true = wait and ask again; the material stays
 */
export function accountNotReplicatedYet (err) {
  return String((err && err.message) || err || '').toLowerCase().trim() === 'unknown user'
}
