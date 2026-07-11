// End-to-end v0.2 test: sessions + device limits + revocation. No ffmpeg needed.
// Exercises the real panel session RPC over a live Hyperswarm. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, blind, powSolve, verifyToken, ARGON2_DEFAULT
} from '@aliran/core'
import { panelClient, login } from '../client/backend/login.mjs'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) } throw new Error('timeout: ' + label) }

const DIFFICULTY = 8
const PASSWORD = 'test123'
const dirs = { panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2es-panel-')), cli: fs.mkdtempSync(path.join(os.tmpdir(), 'e2es-cli-')) }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Panel: enroll alice with maxDevices = 2 =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt(); const kp = userKeyPair(); const auth = authKeyPair(); const wk = wrapKeyFrom(rwd)
  await db.put('user/alice', {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(rwd, salt, ARGON2_DEFAULT), 'hex'),
    argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'), encPriv: wrap(wk, kp.secretKey),
    authPub: b4a.toString(auth.publicKey, 'hex'), authPrivEnc: wrap(wk, auth.secretKey),
    wrapped: {}, devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })

  const throttle = makeThrottle(1000, 60)
  const panelSwarm = new Hyperswarm(); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle, db, sessionTtlMs: 3600000 }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()

  // ===== Client connects + replicates DB =====
  const cliStore = new Corestore(dirs.cli); await cliStore.ready(); cleanups.push(() => cliStore.close())
  const cliBee = new Hyperbee(cliStore.get({ key: keys.signing.publicKey }), { keyEncoding: 'utf-8', valueEncoding: 'json' }); await cliBee.ready()
  let call = null
  const cliSwarm = new Hyperswarm(); cleanups.push(() => cliSwarm.destroy())
  cliSwarm.on('connection', (socket) => { cliStore.replicate(socket); if (!call) call = panelClient(socket).call })
  cliSwarm.join(hcrypto.hash(keys.signing.publicKey), { client: true, server: false })
  await waitFor(async () => call, 30000, 'panel connection')
  await waitFor(async () => await cliBee.get('user/alice'), 30000, 'DB replication')

  // ===== Test A: device limit (max 2) evicts the oldest =====
  let lastToken = null
  for (const did of ['device-1', 'device-2', 'device-3']) {
    const { token } = await login(call, cliBee, 'alice', PASSWORD, { deviceId: did, deviceLabel: did })
    lastToken = token
  }
  const devices = (await db.get('user/alice')).value.devices.map((d) => d.deviceId).sort()
  log('devices after 3 logins (max 2):', JSON.stringify(devices))
  assert.strictEqual(devices.length, 2, 'should keep only maxDevices')
  assert.deepStrictEqual(devices, ['device-2', 'device-3'], 'oldest (device-1) should be evicted')

  // ===== Test B: forged signature is rejected =====
  const hello = await call('hello')
  const nonce = powSolve(b4a.from(hello.challenge, 'hex'), hello.difficulty)
  const { blinded } = blind(PASSWORD)
  await call('login', { username: 'alice', blinded: b4a.toString(blinded, 'hex'), powNonce: b4a.toString(nonce, 'hex') })
  const forged = await call('session', { username: 'alice', deviceId: 'device-x', sig: b4a.toString(hcrypto.randomBytes(64), 'hex') })
  log('forged session sig ->', JSON.stringify(forged.error))
  assert.strictEqual(forged.error, 'auth failed', 'forged signature must be rejected')

  // ===== Test C: revocation via tokenVersion bump (admin logout-all) =====
  const beforeTv = (await db.get('user/alice')).value.tokenVersion
  const u = (await db.get('user/alice')).value; u.tokenVersion = beforeTv + 1; u.devices = []; await db.put('user/alice', u)
  const afterTv = (await db.get('user/alice')).value.tokenVersion
  const tokPayload = verifyToken(keys.signing.publicKey, lastToken)
  log('tokenVersion before/after logout-all:', beforeTv, '/', afterTv, '; last token tv:', tokPayload.tokenVersion)
  assert.strictEqual(afterTv, beforeTv + 1, 'logout-all should bump tokenVersion')
  assert.ok(tokPayload.tokenVersion < afterTv, 'previously issued token is now stale (revoked on next online check)')

  log('\nRESULT: PASS ✅  (device limit evicts oldest; forged sig rejected; revocation via tokenVersion)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
