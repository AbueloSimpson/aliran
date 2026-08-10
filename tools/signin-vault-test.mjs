// Unit test for client/backend/signin-vault.mjs — the at-rest half of a phone -> TV
// sign-in. No network, no DHT, no panel: this is the part that can be reasoned about on
// its own, and the part whose mistakes are silent.
//
// The interesting assertion is the LAST group. terminalSignInError() decides whether a
// television keeps the account it is holding or erases it, and it decides on the wording
// of errors that sdk/login.js writes. That coupling is fine — the engine's prose is
// English by design and stable, and the screens already match on it the same way — but it
// has to be pinned, because a reworded error would silently turn an operator's revocation
// into an infinite retry loop against a device nobody can see.
//
// Exits 0 on PASS.  Run: npm run test:signin-vault
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import {
  SIGNIN_VAULT_VERSION, FILE_KEY_BYTES,
  gateSignInKeys, gateVaultRecord, sealSignIn, openSignIn, terminalSignInError
} from '../client/backend/signin-vault.mjs'

let passed = 0
const check = (ok, label) => { if (!ok) throw new Error('FAILED: ' + label); passed++; console.log('  ok  ', label) }
const hex = (n) => b4a.toString(hcrypto.randomBytes(n), 'hex')

try {
  const KEYS = { username: 'alice', panelPubKey: hex(32), priv: hex(32), authPriv: hex(64) }

  // --- the shape gate on the way IN --------------------------------------------------
  console.log('gateSignInKeys')
  check(!!gateSignInKeys(KEYS), 'accepts a well-formed handover')
  check(gateSignInKeys({ ...KEYS, priv: KEYS.priv.toUpperCase() }).priv === KEYS.priv, 'normalizes hex case')
  check(gateSignInKeys({ ...KEYS, priv: hex(31) }) === null, 'refuses a short X25519 key')
  check(gateSignInKeys({ ...KEYS, authPriv: hex(32) }) === null, 'refuses a 32-byte Ed25519 key (it is 64)')
  check(gateSignInKeys({ ...KEYS, panelPubKey: 'zz' }) === null, 'refuses a panel key that is not hex')
  check(gateSignInKeys({ ...KEYS, username: '' }) === null, 'refuses an empty username')
  check(gateSignInKeys({ ...KEYS, username: 'a'.repeat(65) }) === null, 'refuses an over-long username')
  check(gateSignInKeys(null) === null && gateSignInKeys('alice') === null, 'refuses non-objects')
  // The gate is what stops an unusable record reaching the disk: every one of the lengths
  // above is one sdk/login.js would refuse on the way back in, and a device that stored it
  // would fail its resume for ever with no way to tell why.
  check(gateSignInKeys({ ...KEYS, extra: 'x' }).extra === undefined, 'drops unknown fields rather than storing them')

  // --- the envelope -------------------------------------------------------------------
  console.log('sealSignIn / openSignIn')
  const fileKey = hcrypto.randomBytes(FILE_KEY_BYTES)
  const box = sealSignIn(fileKey, KEYS)
  check(typeof box === 'string' && /^[0-9a-f]+$/.test(box), 'the box is hex')
  check(!box.includes(KEYS.priv) && !box.includes(KEYS.authPriv), 'and carries neither key in the clear')
  const out = openSignIn(fileKey, box)
  check(out && out.priv === KEYS.priv && out.authPriv === KEYS.authPriv && out.username === KEYS.username && out.panelPubKey === KEYS.panelPubKey,
    'it opens back to exactly what went in')
  check(openSignIn(hcrypto.randomBytes(FILE_KEY_BYTES), box) === null, 'a different file key opens nothing')
  check(openSignIn(fileKey, box.slice(0, box.length - 2)) === null, 'a truncated box opens nothing')
  check(openSignIn(fileKey, box.slice(0, 40) + (box[40] === 'a' ? 'b' : 'a') + box.slice(41)) === null, 'a flipped byte opens nothing (the MAC is checked)')
  check(openSignIn(fileKey, 'not hex') === null && openSignIn(fileKey, '') === null && openSignIn(null, box) === null,
    'garbage in every argument answers null, never a throw')
  check(openSignIn(b4a.alloc(16), box) === null, 'a wrong-length file key answers null')
  let threw = null
  try { sealSignIn(fileKey, { ...KEYS, priv: 'nope' }) } catch (e) { threw = e }
  check(!!threw, 'sealing malformed keys THROWS rather than writing them (the one loud failure here)')

  // --- the shape gate on the way OUT ---------------------------------------------------
  console.log('gateVaultRecord')
  const stored = { v: SIGNIN_VAULT_VERSION, box, key: 'QUJDRA==', at: Date.now() }
  check(!!gateVaultRecord(stored), 'accepts a well-formed record')
  check(gateVaultRecord({ ...stored, v: SIGNIN_VAULT_VERSION + 1 }) === null, 'refuses a future version rather than guessing at it')
  check(gateVaultRecord({ ...stored, box: undefined }) === null, 'refuses a record with no box')
  check(gateVaultRecord({ ...stored, key: '' }) === null, 'refuses a record with no wrapped key')
  check(gateVaultRecord({ ...stored, key: 'not base64!' }) === null, 'refuses a wrapped key that is not base64')
  check(gateVaultRecord({ ...stored, key: 'A'.repeat(5000) }) === null, 'refuses an implausibly large wrapped key')
  check(gateVaultRecord({ ...stored, at: 'yesterday' }).at === 0, 'a bad timestamp degrades to 0 rather than failing the record')
  check(gateVaultRecord(null) === null && gateVaultRecord([]) === null, 'refuses non-objects')

  // --- keep or erase --------------------------------------------------------------------
  // Every string below is a substring of a message sdk/login.js or sdk/player.js actually
  // produces. Read them as the list of ways a stored sign-in can die.
  console.log('terminalSignInError — ERASE')
  for (const m of [
    'session failed: account disabled',            // the operator disabled the account
    'session failed: device-limit',                // maxDevices, policy 'reject'
    'session failed: auth failed',                 // the Ed25519 key does not sign for this account
    'session failed: unknown user',
    'unknown user',                                // the account is gone from the signed record
    'key handover does not match this account',    // WHAT A PASSWORD ROTATION LOOKS LIKE
    'panel returned an invalid session token',
    'the panel issued no session token — the key handover did not sign this device in',
    'priv must be 32 bytes (hex or buffer)',       // our own stored record is malformed
    'authPriv must be 64 bytes (hex or buffer)'
  ]) check(terminalSignInError(new Error(m)) === true, m)

  console.log('terminalSignInError — KEEP AND RETRY')
  for (const m of [
    'not connected to panel',                      // the swarm is still dialling
    'CHANNEL_CLOSED',                              // the panel socket died mid-call
    'login failed: locked (retry 900s)',           // the panel throttle, not a verdict
    'login failed: bad proof-of-work',
    'session failed: sessions unavailable',        // the PANEL is missing its signing key
    'the panel issued no session challenge — it is too old for a key handover',
    'timeout: panel connection',
    'EPARTIALREAD'                                 // store corruption; recovery handles it
  ]) check(terminalSignInError(new Error(m)) === false, m)

  check(terminalSignInError(null) === false && terminalSignInError('') === false && terminalSignInError(undefined) === false,
    'no message at all is not a verdict — keep')
  check(terminalSignInError('SESSION FAILED: account disabled') === true, 'the match is case-insensitive and takes a bare string')

  console.log(`\nPASS — ${passed} checks`)
  process.exit(0)
} catch (err) {
  console.log('\nFAIL:', err && err.message)
  process.exit(1)
}
