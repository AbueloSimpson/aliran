// End-to-end: a television that a phone signed in SURVIVES A RESTART — on a LOCAL DHT
// testnet, so this belongs in the required CI lane.
//
// The feature under test is the at-rest half of "send to TV". A set signed in by a phone
// has no password to remember, so before this it came back to the sign-in screen every
// time Android reclaimed the app process — worse than the password path it replaced. Now
// the engine hands the material over once, the device seals it, and it signs itself back
// in with sdk/login.js loginWithKeys.
//
// Part 1 — the engine's side of the bargain:
//   - a build with `remote: { keepSignIn: true }` is handed the account material exactly
//     once, as 'signin-keys', at the end of a received handover;
//   - a build WITHOUT it is handed nothing, and the flag is not `sendToTv` in disguise;
//   - the material round-trips through the on-disk envelope unchanged.
//
// Part 2 — the restore itself, on a SEPARATE engine with its own store and device id (the
// next cold start, as far as the panel can tell):
//   - it signs in, recovers the REAL per-stream key, and takes its own panel-signed token;
//   - it enrols as the same device it was, not a new one each boot.
//
// Part 3 — the failures, which is where a feature that stores account keys is decided.
// Each one is checked against terminalSignInError(), the predicate that decides whether
// the device keeps the material or erases it:
//   - a key that is not this account's (what a stolen half-record looks like)  -> ERASE
//   - the account disabled by the operator                                     -> ERASE
//   - the account's password rotated (the panel mints a NEW keypair)           -> ERASE
//   - "log out all devices"                                                    -> SIGNS
//     STRAIGHT BACK IN, and the test asserts that rather than pretending otherwise. It is
//     the same thing that is already true of a saved password, and docs/security-model.md
//     says so in the residual register.
//
// Part 4 — the negative scan: neither private key may appear in anything printed during
// the run, whoever printed it.
//
// Requires loopback UDP only. Exits 0 on PASS.
// Run: npm run test:signin-resume
import Hyperswarm from 'hyperswarm'
import hcrypto from 'hypercore-crypto'
import createTestnet from 'hyperdht/testnet.js'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT
} from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, saveSecrets } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import * as ops from '../panel/src/ops.js'
import { createPlayer } from '../sdk/index.js'
import {
  FILE_KEY_BYTES, SIGNIN_VAULT_VERSION,
  sealSignIn, openSignIn, gateVaultRecord, terminalSignInError
} from '../client/backend/signin-vault.mjs'

// Everything printed during this run, whoever printed it — the same console hook the
// sign-in pairing test uses, for the same reason: a scan over this file's own log() could
// only ever prove that the TEST does not print keys.
const printed = []
const realConsole = { log: console.log, warn: console.warn, error: console.error }
const show = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v) ?? String(v) } catch { return String(v) } }
for (const k of Object.keys(realConsole)) {
  console[k] = (...a) => { try { printed.push(a.map(show).join(' ')) } catch {} realConsole[k](...a) }
}
const unhookConsole = () => { for (const k of Object.keys(realConsole)) console[k] = realConsole[k] }
const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(200) }
  throw new Error('timeout: ' + label)
}

const DIFFICULTY = 8 // low for a fast test
const PASSWORD = 'test123'
const NEW_PASSWORD = 'test456'
// Cheap Argon2id for the ROTATION step only (panel/src/ops.js argonOpts reads this shape).
// The enrollment below still uses ARGON2_DEFAULT, so the login path under test runs at
// production cost.
const FAST_CONFIG = { argon2: { time: 1, memKiB: 8192 } }
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('e2erz-panel-'), tv: tmp('e2erz-tv-'), boot2: tmp('e2erz-boot2-'), plain: tmp('e2erz-plain-') }
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  unhookConsole()
}

let passed = 0
const check = (ok, label) => { if (!ok) throw new Error('FAILED: ' + label); passed++; log('  ok  ', label) }
const hex = (b) => b4a.toString(b, 'hex')

try {
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap

  // ===== Panel: one account, one granted stream, login RPC on the testnet =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const panelPubKey = hex(keys.signing.publicKey)

  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt()
  const kp = userKeyPair()
  const auth = authKeyPair()
  const wk = wrapKeyFrom(rwd)
  const encKey = hcrypto.randomBytes(32)
  await db.put('user/alice', {
    salt: hex(salt),
    verifier: hex(deriveVerifier(rwd, salt, ARGON2_DEFAULT)),
    argon: ARGON2_DEFAULT,
    pub: hex(kp.publicKey),
    encPriv: wrap(wk, kp.secretKey),
    authPub: hex(auth.publicKey),
    authPrivEnc: wrap(wk, auth.secretKey),
    wrapped: { news: sealTo(kp.publicKey, encKey) },
    devices: [], tokenVersion: 1, maxDevices: 4, status: 'active'
  })
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', feedKey: hex(hcrypto.randomBytes(32)), isLive: true, status: 'live' })
  // The panel's own copy of the stream key, so a password rotation can re-seal the grant
  // exactly as a live panel would.
  saveSecrets(dirs.panel, { news: hex(encKey) })

  // The two secrets the scan at the end must not find anywhere.
  const PRIV_HEX = hex(kp.secretKey)
  const AUTH_PRIV_HEX = hex(auth.secretKey)
  const HANDOVER = { username: 'alice', panelPubKey, priv: PRIV_HEX, authPriv: AUTH_PRIV_HEX }

  const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => {
    panelStore.replicate(socket)
    attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle: makeThrottle(1000, 60), db, sessionTtlMs: 3600000 })
  })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false })
  await panelSwarm.flush()
  log('panel: announced on the testnet')

  // ============================================================================
  // PART 1 — what the engine hands over, and to whom
  // ============================================================================

  // A build that never asked must be given nothing. This is the DEFAULT, and it is the
  // half of the flag that matters: an app that has nowhere safe to put account keys
  // should not be receiving them from the engine at all.
  {
    const plain = createPlayer({ panelPubKey, storeDir: path.join(dirs.plain, 'store'), deviceId: 'tv-plain', swarm: { bootstrap } })
    cleanups.push(() => plain.stop())
    check(plain._remote.keepSignIn === false, 'keepSignIn is OFF by default')
    // …and the `remote: true` shorthand does not smuggle it in either. That shorthand
    // covers the two features about MEMORY for the length of a session; writing the
    // account to a disk is a property of the BUILD — does it have a key store, does it
    // erase on sign-out — and has to be asked for by name. It used to be included, so a
    // phone that wrote `remote: true` to get sendSignIn() was handed account keys at rest.
    const shorthand = createPlayer({ storeDir: path.join(dirs.plain, 'shorthand'), deviceId: 'tv-short', remote: true })
    check(shorthand._remote.sendToTv === true && shorthand._remote.control === true && shorthand._remote.keepSignIn === false,
      '`remote: true` turns on the two memory features and NOT keepSignIn')
    let handed = 0
    plain.on('signin-keys', () => { handed++ })
    await plain.connect()
    await waitFor(() => db.get('user/alice'), 15000, 'panel record replicated to the plain build')
    setTimeout(() => plain.confirmSignInService(true), 400)
    const s = await waitFor(() => plain._applySignIn({ ...HANDOVER }).catch(() => null), 40000, 'plain build takes a handover')
    check(s.length === 1, 'a build without keepSignIn still completes a handover normally')
    check(handed === 0, '…and is handed NO key material — nothing for it to leak or store')
    await plain.stop()
  }

  // …and a build that DID ask is handed it exactly once, at the end of the handover.
  const tv = createPlayer({ panelPubKey, storeDir: path.join(dirs.tv, 'store'), deviceId: 'tv-1', deviceLabel: 'Living room', swarm: { bootstrap }, remote: { keepSignIn: true } })
  cleanups.push(() => tv.stop())
  check(tv._remote.keepSignIn === true && tv._remote.sendToTv === false,
    'keepSignIn and sendToTv are independent — a TV receives without ever being able to send')
  const handedKeys = []
  tv.on('signin-keys', (k) => handedKeys.push(k))
  await tv.connect()
  await waitFor(() => db.get('user/alice'), 15000, 'panel record replicated to the TV')
  setTimeout(() => tv.confirmSignInService(true), 400)
  const tvStreams = await waitFor(() => tv._applySignIn({ ...HANDOVER }).catch((e) => { log('  (handover retry:', e.message + ')'); return null }), 40000, 'TV takes the handover')
  check(tvStreams.length === 1 && tvStreams[0].id === 'news', 'the TV is signed in by the handover')
  check(handedKeys.length === 1, "'signin-keys' fires exactly once")
  const given = handedKeys[0]
  check(given.username === 'alice' && given.panelPubKey === panelPubKey &&
    given.priv === PRIV_HEX && given.authPriv === AUTH_PRIV_HEX,
  'and carries the whole account: username, operator, and both private keys')

  // The envelope the worklet writes: 32 random bytes seal the record, and the sealed box
  // is what touches the disk. (The Android Keystore wraps the 32 bytes — that half cannot
  // run here, and is on the on-device verification list.)
  const fileKey = hcrypto.randomBytes(FILE_KEY_BYTES)
  const box = sealSignIn(fileKey, given)
  check(!box.includes(PRIV_HEX) && !box.includes(AUTH_PRIV_HEX), 'the sealed box contains neither key in the clear')
  const reopened = openSignIn(fileKey, box)
  check(reopened && reopened.priv === PRIV_HEX && reopened.authPriv === AUTH_PRIV_HEX && reopened.username === 'alice',
    'and opens back to exactly what went in')
  check(openSignIn(hcrypto.randomBytes(FILE_KEY_BYTES), box) === null, 'a different file key opens nothing')
  check(!!gateVaultRecord({ v: SIGNIN_VAULT_VERSION, box, key: 'AAAA', at: Date.now() }), 'the stored envelope passes its own read gate')
  await tv.stop()

  // ============================================================================
  // PART 2 — the next cold start: a fresh engine, a fresh store, the same device
  // ============================================================================
  const boot2 = createPlayer({ panelPubKey, storeDir: path.join(dirs.boot2, 'store'), deviceId: 'tv-1', deviceLabel: 'Living room', swarm: { bootstrap }, remote: { keepSignIn: true } })
  cleanups.push(() => boot2.stop())
  await boot2.connect()
  await waitFor(() => db.get('user/alice'), 15000, 'panel record replicated after restart')
  const back = await waitFor(() => boot2.signInWithKeys(reopened.username, reopened).catch((e) => { log('  (resume retry:', e.message + ')'); return null }), 40000, 'signInWithKeys')
  check(back.length === 1 && back[0].id === 'news', 'the device signs itself back in with no password and no phone')
  check(!!boot2._session && !!boot2._session.token, '…taking its own panel-signed session token')
  check(boot2._entitled.get('news').encryptionKey === hex(encKey),
    '…and really recovering the per-stream key (which only `priv` can open — a token alone would watch nothing)')
  const rec = (await db.get('user/alice')).value
  check(rec.devices.filter((d) => d.deviceId === 'tv-1').length === 1,
    'it re-enrols as the SAME device, so a restart does not eat a slot off maxDevices')

  // ============================================================================
  // PART 3 — the refusals, and what each one means for the material on disk
  // ============================================================================

  // A key that is not this account's. sdk/login.js probes for exactly this, so it fails
  // loudly rather than producing a signed-in device with an empty catalog.
  {
    let err = null
    try { await boot2.signInWithKeys('alice', { priv: hex(hcrypto.randomBytes(32)), authPriv: AUTH_PRIV_HEX }) } catch (e) { err = e }
    check(!!err, 'a wrong X25519 key is refused (an authPriv-only record would be exactly this)')
    check(terminalSignInError(err), '…and is classified TERMINAL: erase what is stored')
  }

  // "Log out all devices". It ends live sessions, and it does NOT stop a device that still
  // holds working keys from taking a fresh one — the same as a device holding a saved
  // password. This test exists so that fact cannot quietly change without somebody noticing.
  {
    const before = (await db.get('user/alice')).value.tokenVersion
    await ops.logoutAll({ db, keys, dataDir: dirs.panel, config: FAST_CONFIG }, 'alice')
    const after = (await db.get('user/alice')).value.tokenVersion
    check(after === before + 1, 'logout-all bumped tokenVersion')
    const again = await waitFor(() => boot2.signInWithKeys('alice', reopened).catch(() => null), 40000, 'resume after logout-all')
    check(again.length === 1, 'logout-all does NOT evict a device holding the keys — it signs straight back in')
    check(!terminalSignInError(new Error('nothing was refused')), '…so nothing is erased, which is the honest behaviour to document')
  }

  // The operator disabling the account. This one does stop it.
  {
    await ops.setUserStatus({ db, keys, dataDir: dirs.panel, config: FAST_CONFIG }, 'alice', 'disabled')
    await sleep(500)
    let err = null
    try { await boot2.signInWithKeys('alice', reopened) } catch (e) { err = e }
    check(!!err && /account disabled/i.test(err.message), 'a disabled account refuses the resume by name')
    check(terminalSignInError(err), '…and is TERMINAL: the stored keys are erased')
    await ops.setUserStatus({ db, keys, dataDir: dirs.panel, config: FAST_CONFIG }, 'alice', 'active')
  }

  // A password rotation. The panel mints a FRESH keypair on set-password and re-seals the
  // grants to it, so every device holding the old keys is evicted — which makes changing
  // a viewer's password the operator's real revocation for this feature.
  {
    await sleep(500)
    const ctx = { db, keys, dataDir: dirs.panel, config: FAST_CONFIG }
    const beforePub = (await db.get('user/alice')).value.pub
    await ops.setPassword(ctx, 'alice', NEW_PASSWORD)
    const afterRec = (await db.get('user/alice')).value
    check(afterRec.pub !== beforePub, 'set-password replaced the account keypair (panel/src/ops.js enroll)')
    check(!!afterRec.wrapped.news, '…and re-sealed the grant to the new key, so the viewer keeps their channels')
    await waitFor(async () => ((await boot2._panelBee.get('user/alice'))?.value?.pub === afterRec.pub) || null, 20000, 'rotated record replicated')
    let err = null
    try { await boot2.signInWithKeys('alice', reopened) } catch (e) { err = e }
    check(!!err && /does not match this account/i.test(err.message), 'the old keys no longer match the account')
    check(terminalSignInError(err), '…and are TERMINAL: erased, so a rotation really does evict a kept sign-in')
  }

  // ============================================================================
  // PART 4 — nothing printed either key
  // ============================================================================
  const leak = printed.filter((line) => line.includes(PRIV_HEX) || line.includes(AUTH_PRIV_HEX))
  check(leak.length === 0, 'neither private key appears in anything printed during the run')

  await cleanup()
  log(`\nPASS — ${passed} checks`)
  process.exit(0)
} catch (err) {
  log('\nFAIL:', err && err.message)
  await cleanup()
  process.exit(1)
}
