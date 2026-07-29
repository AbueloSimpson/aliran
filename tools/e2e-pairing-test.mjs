// End-to-end service pairing test: a client that holds ONLY the 12-character pairing
// code reaches the operator's panel and logs in.
//
// The claim under test is the whole feature: a viewer never types the 64-hex panel
// key. So the client half below is written with the code as its ONLY input — the panel
// key is not in scope until resolvePairingCode() hands it back.
//
// Also tests the ways this must fail safely:
//   - a code nobody serves times out (never resolves to something)
//   - a squatter answering on the topic with ITS OWN panel key is REJECTED, not
//     followed — the client re-derives the code and the keys do not match
//   - a peer that sits on the topic and answers nothing reads as a timeout, NOT as an
//     unverified service (the topic is public; strangers are not accusations)
//
// Requires outbound UDP (the public DHT). Exits 0 on PASS.
// Run: npm run test:pairing
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import hcrypto from 'hypercore-crypto'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT,
  pairingCode, pairingTopic, normalizePairingCode
} from '@aliran/core'
import { resolvePairingCode, PAIRING_ERRORS } from '../sdk/pairing.js'
import { panelClient, login } from '../sdk/login.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) }
  throw new Error('timeout: ' + label)
}

const DIFFICULTY = 8 // low for a fast test
const PASSWORD = 'test123'
const SERVICE_NAME = 'Nice Operator TV'
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('e2ep-panel-'), evil: tmp('e2ep-evil-'), cli: tmp('e2ep-cli-') }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

let passed = 0
const check = (ok, label) => { if (!ok) throw new Error('FAILED: ' + label); passed++; log('  ok  ', label) }

try {
  // ===== Panel: keys, one account, serve login RPC + the pairing rendezvous =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')

  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt()
  const kp = userKeyPair()
  const auth = authKeyPair()
  const wk = wrapKeyFrom(rwd)
  const encKey = hcrypto.randomBytes(32)
  await db.put('user/alice', {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(rwd, salt, ARGON2_DEFAULT), 'hex'),
    argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'),
    encPriv: wrap(wk, kp.secretKey),
    authPub: b4a.toString(auth.publicKey, 'hex'),
    authPrivEnc: wrap(wk, auth.secretKey),
    wrapped: { news: sealTo(kp.publicKey, encKey) },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', protection: 'self', feedKey: b4a.toString(hcrypto.randomBytes(32), 'hex'), isLive: true, poster: null, status: 'live' })

  // The panel derives its own code — nothing is minted, nothing is stored.
  const code = pairingCode(panelPubKey)
  log('panel: key', panelPubKey.slice(0, 16) + '…', '-> pairing code', code)
  check(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code), 'code is 3 groups of 4 Crockford characters')

  const descriptor = { panelPubKey, name: SERVICE_NAME }
  const throttle = makeThrottle(1000, 60)
  const panelSwarm = new Hyperswarm(); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => {
    panelStore.replicate(socket)
    attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle, db, sessionTtlMs: 3600000, descriptor })
  })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false })
  panelSwarm.join(pairingTopic(code), { server: true, client: false })
  await panelSwarm.flush()
  log('panel: announced on the key topic AND the pairing topic')

  // ===== Client: pair with NOTHING but the code, then log in =====
  // Typed the way a viewer types: lowercase, spaces instead of dashes.
  const typed = code.toLowerCase().replace(/-/g, ' ')
  log('client: viewer typed', JSON.stringify(typed))
  const paired = await resolvePairingCode(typed, { timeoutMs: 60000 })
  check(paired.panelPubKey === panelPubKey, 'resolved the operator panel key from the code alone')
  check(paired.name === SERVICE_NAME, 'descriptor carries the service name for the Connect screen')
  check(normalizePairingCode(paired.code) === normalizePairingCode(code), 'echoes the code back in display form')

  // From here the client is on the ordinary path: it knows a panel key, and nothing
  // about how it learned it.
  const cliStore = new Corestore(dirs.cli); await cliStore.ready(); cleanups.push(() => cliStore.close())
  const cliBee = new Hyperbee(cliStore.get({ key: b4a.from(paired.panelPubKey, 'hex') }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await cliBee.ready()
  let call = null
  const cliSwarm = new Hyperswarm(); cleanups.push(() => cliSwarm.destroy())
  cliSwarm.on('connection', (socket) => { cliStore.replicate(socket); if (!call) call = panelClient(socket).call })
  cliSwarm.join(hcrypto.hash(b4a.from(paired.panelPubKey, 'hex')), { client: true, server: false })
  log('client: dialing the paired panel…')

  await waitFor(async () => call, 30000, 'panel connection')
  await waitFor(async () => await cliBee.get('user/alice'), 30000, 'DB replication to client')
  const { streams, token } = await login(call, cliBee, 'alice', PASSWORD, { deviceId: 'paired-device', deviceLabel: 'Paired TV' })
  check(streams.length === 1 && streams[0].id === 'news', 'logged in and received the entitlement list')
  check(!!token, 'panel issued a session token')
  check(streams[0].encryptionKey === b4a.toString(encKey, 'hex'), 'unsealed the stream key — a real, working session')

  // ===== Failure 1: a code nobody serves =====
  // Flip one character of the real code to get a well-formed code with no panel behind
  // it. Short timeout: the point is that it gives up, not that it waits well.
  const canonical = normalizePairingCode(code)
  const nobody = (canonical[0] === '0' ? '1' : '0') + canonical.slice(1)
  let err = null
  try { await resolvePairingCode(nobody, { timeoutMs: 8000 }) } catch (e) { err = e }
  check(err && err.code === PAIRING_ERRORS.timeout, 'an unserved code times out instead of resolving')

  // ===== Failure 2: a squatter on the real code's topic =====
  // The attack the 60 bits and the memory-hard KDF exist to price out, simulated by
  // GIVING the attacker the collision for free: a second panel, its own keypair, its
  // own OPRF key, announcing on the victim's pairing topic and answering `describe`
  // with its own key. A client that followed it would type real credentials into it.
  initKeys(dirs.evil)
  const evilKeys = openKeys(dirs.evil)
  const { store: evilStore, db: evilDb } = await openStore(dirs.evil, evilKeys); cleanups.push(() => evilStore.close())
  const evilPubKey = b4a.toString(evilKeys.signing.publicKey, 'hex')
  const evilSwarm = new Hyperswarm(); cleanups.push(() => evilSwarm.destroy())
  evilSwarm.on('connection', (socket) => {
    evilStore.replicate(socket)
    attachLoginRpc(socket, { keys: evilKeys, difficulty: DIFFICULTY, throttle: makeThrottle(1000, 60), db: evilDb, sessionTtlMs: 3600000, descriptor: { panelPubKey: evilPubKey, name: 'Nice 0perator TV' } })
  })
  evilSwarm.join(pairingTopic(code), { server: true, client: false })
  await evilSwarm.flush()
  log('impostor: announcing on the victim code\'s topic with key', evilPubKey.slice(0, 16) + '…')

  // Take the real panel off the topic so the impostor is the ONLY answer — otherwise a
  // pass could just mean the client happened to reach the honest peer first.
  await panelSwarm.leave(pairingTopic(code))
  await sleep(1000)
  err = null
  let leaked = null
  try { leaked = await resolvePairingCode(code, { timeoutMs: 20000 }) } catch (e) { err = e }
  check(leaked === null, 'never returned the impostor key')
  check(err && err.code === PAIRING_ERRORS.unverified, 'rejected it as unverified (not a plain timeout — the client saw the lie)')

  // ===== A stranger on the topic is not an accusation =====
  // Any peer may sit on a public topic without speaking `describe` at all. That must
  // read as "nobody answered", NOT as "your operator could not prove itself" — telling
  // a viewer the second thing when the first is true is the one wrong message here.
  await evilSwarm.leave(pairingTopic(code))
  const strangerSwarm = new Hyperswarm(); cleanups.push(() => strangerSwarm.destroy())
  strangerSwarm.join(pairingTopic(code), { server: true, client: false })
  await strangerSwarm.flush()
  await sleep(1000)
  log('stranger: announcing on the topic, answering nothing')
  err = null
  try { await resolvePairingCode(code, { timeoutMs: 15000 }) } catch (e) { err = e }
  check(err && err.code === PAIRING_ERRORS.timeout, 'a silent peer on the topic reports a timeout, not an unverified service')

  // ===== Malformed input never reaches the network =====
  err = null
  try { await resolvePairingCode('not-a-code', { timeoutMs: 1000 }) } catch (e) { err = e }
  check(err && err.code === PAIRING_ERRORS.malformed, 'a malformed code fails before anything is joined')

  log(`\nRESULT: PASS ✅  (${passed} checks — pairing code → panel key → login, with impostor and timeout rejected)`)
  await cleanup(); process.exit(0)
} catch (err) {
  log('\nRESULT: FAIL ❌')
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
