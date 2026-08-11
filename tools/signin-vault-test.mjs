// Unit test for client/backend/signin-vault.mjs — the at-rest half of a phone -> TV
// sign-in. No network, no DHT, no panel: this is the part that can be reasoned about on
// its own, and the part whose mistakes are silent.
//
// The interesting assertions are the LAST TWO groups. terminalSignInError() decides whether
// a television keeps the account it is holding or erases it, and erasing is the only
// irreversible thing in this feature: it sends a viewer to another room for a phone. It
// decides on the wording of errors that sdk/login.js writes and codes that panel/src/rpc.js
// answers with.
//
// AND THE COUPLING IS TO THOSE FILES, not to a copy of their prose. An earlier revision of
// this lane claimed to "pin the engine's error prose so a reworded message cannot turn a
// revocation into an endless retry", and did no such thing: the strings were literals
// typed HERE, asserted against the predicate, both in the same commit. Rewording the
// panel's 'account disabled' left this lane and CI green while a disabled account retried
// for ever. So the last group READS panel/src/rpc.js and sdk/login.js off the disk, pulls
// out every error they can actually produce, and fails when one of them is not classified
// — a reword, an addition or a removal all break it, which is the only version of this
// claim worth making.
//
// Exits 0 on PASS.  Run: npm run test:signin-vault
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import {
  SIGNIN_VAULT_VERSION, FILE_KEY_BYTES,
  gateSignInKeys, gateVaultRecord, sealSignIn, openSignIn,
  terminalSignInError, accountNotReplicatedYet
} from '../client/backend/signin-vault.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

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
    'session failed: unknown user',                // the PANEL's own db has no such account
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

  // THE FOUR REQUEST REFUSALS. panel/src/rpc.js answers all of them from the same `session`
  // responder, behind the same 'session failed: ' prefix as a real verdict — and matching
  // the PREFIX rather than the code meant a malformed call, a lost one-shot challenge, or a
  // panel-side record with an undecodable authPub each destroyed an account on its first
  // occurrence.
  console.log('terminalSignInError — a refusal of the REQUEST is not a verdict on the device')
  for (const m of [
    'session failed: bad request',
    'session failed: no session challenge (login first)',
    'session failed: missing deviceId',
    'session failed: auth failed'
  ]) check(terminalSignInError(new Error(m)) === false, m)

  // …and the bare form, which sdk/login.js throws after reading the LOCAL replica. On a
  // cold start it means "not replicated yet" at least as often as "gone", and the panel's
  // authoritative answer arrives prefixed (asserted ERASE above).
  console.log('terminalSignInError — the replication gap')
  check(terminalSignInError(new Error('unknown user')) === false, 'a bare "unknown user" is the local replica, not a verdict — keep')
  check(accountNotReplicatedYet(new Error('unknown user')) === true, '…and is recognised as the record not having arrived yet')
  check(accountNotReplicatedYet(new Error('session failed: unknown user')) === false, 'the panel\'s own "unknown user" is NOT the replication gap')
  check(accountNotReplicatedYet(new Error('not connected to panel')) === false, 'and neither is anything else')

  check(terminalSignInError(null) === false && terminalSignInError('') === false && terminalSignInError(undefined) === false,
    'no message at all is not a verdict — keep')
  check(terminalSignInError('SESSION FAILED: account disabled') === true, 'the match is case-insensitive and takes a bare string')
  check(terminalSignInError('  session failed: account disabled  ') === true, 'and survives surrounding whitespace')

  // --- COUPLED TO THE REAL SOURCES ------------------------------------------------------
  // Everything above is this file asserting against itself. What follows reads the two
  // files that WRITE these messages and fails if either grows, loses or rewords one that
  // this predicate has never been taught about.
  console.log('coupling — panel/src/rpc.js `session` responder')
  const rpc = read('panel/src/rpc.js')
  const sessionStart = rpc.indexOf("rpc.respond('session'")
  check(sessionStart > 0, 'the session responder is where this test expects it')
  // The responder ends where the next one begins; everything between is its own.
  const sessionBody = rpc.slice(sessionStart, rpc.indexOf('rpc.respond(', sessionStart + 20))
  const sessionCodes = [...sessionBody.matchAll(/json\(\{\s*error:\s*'([^']+)'/g)].map((m) => m[1])
  check(sessionCodes.length >= 8, `the responder answers ${sessionCodes.length} error codes`)

  // The two halves, declared here and checked against what the panel really answers. A new
  // code in that responder lands in neither list and fails the last check in this group —
  // which is the point: somebody has to decide whether it evicts a television.
  const VERDICTS = ['account disabled', 'device-limit', 'unknown user']
  const REQUEST_REFUSALS = ['sessions unavailable', 'bad request', 'no session challenge (login first)', 'auth failed', 'missing deviceId']
  for (const code of VERDICTS) {
    check(sessionCodes.includes(code), `the panel still answers '${code}' (a verdict)`)
    check(terminalSignInError(new Error('session failed: ' + code)) === true, `…and '${code}' erases`)
  }
  for (const code of REQUEST_REFUSALS) {
    check(sessionCodes.includes(code), `the panel still answers '${code}' (a request refusal)`)
    check(terminalSignInError(new Error('session failed: ' + code)) === false, `…and '${code}' keeps`)
  }
  const unclassified = sessionCodes.filter((c) => !VERDICTS.includes(c) && !REQUEST_REFUSALS.includes(c))
  check(unclassified.length === 0, 'every code the session responder can answer is classified — unclassified: ' + JSON.stringify(unclassified))

  console.log('coupling — sdk/login.js prose')
  const loginSrc = read('sdk/login.js')
  // The prefix the predicate splits on, and the length guard its regex matches, are both
  // composed at runtime — so assert the pieces still exist rather than a whole message.
  check(loginSrc.includes("throw new Error('session failed: ' + sres.error)"), "login.js still composes 'session failed: ' + the panel's code")
  check(loginSrc.includes("' must be ' + len + ' bytes (hex or buffer)'"), 'login.js still writes the key-length guard this predicate matches')
  // Every message login.js throws as a FIXED string, and what each one means for a stored
  // sign-in. Rewording any of them, or adding one, fails the reconciliation below.
  const LOGIN_PROSE = {
    'unknown user': false, //                                       the LOCAL replica has not caught up
    'invalid credentials': false, //                                password path only; never reaches a resume
    'key recovery failed': false, //                                password path only
    'the panel issued no session challenge — it is too old for a key handover': false,
    'key handover does not match this account': true, //            a password rotation, seen from here
    'the panel issued no session token — the key handover did not sign this device in': true,
    'panel returned an invalid session token': true
  }
  const thrown = [...loginSrc.matchAll(/throw new Error\('([^']+)'\)/g)].map((m) => m[1])
  for (const m of thrown) {
    check(Object.prototype.hasOwnProperty.call(LOGIN_PROSE, m), `login.js's "${m}" is classified`)
    check(terminalSignInError(new Error(m)) === LOGIN_PROSE[m], `…and is ${LOGIN_PROSE[m] ? 'ERASE' : 'KEEP'}`)
  }
  const missing = Object.keys(LOGIN_PROSE).filter((m) => !thrown.includes(m))
  check(missing.length === 0, 'every classified message is one login.js still throws — stale: ' + JSON.stringify(missing))

  console.log(`\nPASS — ${passed} checks`)
  process.exit(0)
} catch (err) {
  console.log('\nFAIL:', err && err.message)
  process.exit(1)
}
