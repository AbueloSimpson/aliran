// End-to-end v0.2 test: broadcaster auto-registers a feed with the panel, then a granted
// user logs in and recovers the registered key. No ffmpeg needed. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Hyperbee from 'hyperbee'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT
} from '@aliran/core'
import { panelClient as clientRpc, login } from '../client/backend/login.mjs'
import { panelClient as pubRpc, registerWithPanel } from '../broadcaster/src/register.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, loadSecrets } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) } throw new Error('timeout: ' + label) }
const log = (...a) => console.log(...a)

const DIFFICULTY = 8; const PASSWORD = 'test123'
const dirs = { panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-panel-')), feed: fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-feed-')), cli: fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-cli-')) }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Panel =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const throttle = makeThrottle(1000, 60)
  const topic = hcrypto.hash(keys.signing.publicKey)
  const panelSwarm = new Hyperswarm(); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (s) => { panelStore.replicate(s); attachLoginRpc(s, { keys, difficulty: DIFFICULTY, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000 }) })
  panelSwarm.join(topic, { server: true, client: false }); await panelSwarm.flush()

  // ===== Broadcaster feed + auto-register =====
  const encKey = hcrypto.randomBytes(32)
  const feedStore = new Corestore(dirs.feed); await feedStore.ready(); cleanups.push(() => feedStore.close())
  const feed = new Hyperdrive(feedStore.namespace('feed'), { encryptionKey: encKey }); await feed.ready()
  const feedKeyHex = b4a.toString(feed.key, 'hex'); const encKeyHex = b4a.toString(encKey, 'hex')

  const bSwarm = new Hyperswarm(); cleanups.push(() => bSwarm.destroy())
  let pcall = null
  bSwarm.on('connection', (s) => { if (!pcall) pcall = pubRpc(s).call })
  bSwarm.join(topic, { client: true, server: false })
  await waitFor(async () => pcall, 30000, 'broadcaster→panel connection')

  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'news', feedKey: feedKeyHex, encryptionKey: encKeyHex, title: 'News 24', category: ['news'], isLive: true
  })
  log('broadcaster: registered "news" with the panel')

  // catalog is public + has NO encryptionKey; the secret is stored privately
  const cat = (await db.get('catalog/news')).value
  assert.strictEqual(cat.feedKey, feedKeyHex, 'catalog feedKey')
  assert.strictEqual(cat.encryptionKey, undefined, 'catalog must NOT contain encryptionKey')
  assert.strictEqual(cat.isLive, true, 'catalog isLive')
  assert.strictEqual(loadSecrets(dirs.panel).news, encKeyHex, 'panel-private secret stored')
  log('panel: catalog written (no encKey); encryption key stored privately ✓')

  // ===== Unauthorized publisher is rejected =====
  let unauth = false
  try {
    await registerWithPanel(pcall, b4a.toString(authKeyPair().secretKey, 'hex'), { streamId: 'evil', feedKey: feedKeyHex, encryptionKey: encKeyHex })
  } catch (e) { unauth = /unauthorized/.test(e.message) }
  assert.ok(unauth, 'wrong publisher key must be rejected')
  assert.ok(!(await db.get('catalog/evil')), 'unauthorized stream must not be written')
  log('panel: unauthorized publisher rejected ✓')

  // ===== Grant + login recovers the registered key =====
  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt(); const kp = userKeyPair(); const auth = authKeyPair(); const wk = wrapKeyFrom(rwd)
  const secrets = loadSecrets(dirs.panel)
  await db.put('user/alice', {
    salt: b4a.toString(salt, 'hex'), verifier: b4a.toString(deriveVerifier(rwd, salt, ARGON2_DEFAULT), 'hex'), argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'), encPriv: wrap(wk, kp.secretKey),
    authPub: b4a.toString(auth.publicKey, 'hex'), authPrivEnc: wrap(wk, auth.secretKey),
    wrapped: { news: sealTo(kp.publicKey, b4a.from(secrets.news, 'hex')) },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })

  const cliStore = new Corestore(dirs.cli); await cliStore.ready(); cleanups.push(() => cliStore.close())
  const cliBee = new Hyperbee(cliStore.get({ key: keys.signing.publicKey }), { keyEncoding: 'utf-8', valueEncoding: 'json' }); await cliBee.ready()
  let ccall = null
  const cliSwarm = new Hyperswarm(); cleanups.push(() => cliSwarm.destroy())
  cliSwarm.on('connection', (s) => { cliStore.replicate(s); if (!ccall) ccall = clientRpc(s).call })
  cliSwarm.join(topic, { client: true, server: false })
  await waitFor(async () => ccall, 30000, 'client→panel connection')
  await waitFor(async () => await cliBee.get('user/alice'), 30000, 'DB replication')

  const { streams } = await login(ccall, cliBee, 'alice', PASSWORD, { deviceId: 'd1' })
  assert.strictEqual(streams[0]?.encryptionKey, encKeyHex, 'logged-in user recovers the registered encryption key')
  log('client: login recovered the broadcaster-registered key ✓')

  log('\nRESULT: PASS ✅  (auto-register → private secret → grant → login recovers key; unauthorized rejected)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
