// End-to-end OTA app-update test (SDK side): a panel-shaped publisher advertises an
// updates Hyperdrive (meta/updatesKey = { key, blobsKey }) carrying /manifest.json +
// artifacts under /pkg/, and the REAL SDK engine (connect + OPRF login against a real
// panel RPC) discovers it lazily, answers checkUpdate() for every verdict
// (unknown / available+mandatory / current / none), then downloadUpdate() streams the
// artifact over P2P with throttled progress, verifies its sha256 and lands the file on
// disk — while a manifest entry with a WRONG sha256 must be discarded, surfaced as an
// error, and never produce a final file. Also: the stale-download sweep, and the
// updates topic joined client-only (a viewer never re-serves APK blobs).
//
// The publisher half here stands in for the panel's own updates support (segment A,
// built in parallel): the test writes the meta/updatesKey record into the panel bee
// in-process and feeds the drive from its own corestore, using the EXACT record and
// manifest shapes the panel publishes — integration swaps in the real publisher.
// Local DHT testnet only (never the public DHT). No ffmpeg. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import crypto from 'crypto'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import createTestnet from 'hyperdht/testnet.js'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT
} from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { createPlayer } from '../sdk/index.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) }
  throw new Error('timeout: ' + label)
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

const DIFFICULTY = 8 // low for a fast test
const PASSWORD = 'test123'
const APP_ID = 'com.aliranclient.e2e'
const BAD_ID = 'com.aliranclient.bad'
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('e2eu-panel-'), pub: tmp('e2eu-pub-'), cli: tmp('e2eu-cli-') }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Local DHT testnet (this lane must not be flaky) =====
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap
  log('testnet up:', JSON.stringify(bootstrap))

  // ===== Panel: keys, one enrolled viewer + catalog record, real login RPC =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const encKey = hcrypto.randomBytes(32) // never played — login just needs an entitlement to seal
  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt()
  const kp = userKeyPair()
  const auth = authKeyPair()
  const wk = wrapKeyFrom(rwd)
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
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', protection: 'self', feedKey: 'ab'.repeat(32), isLive: true, poster: null, status: 'live' })
  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  const throttle = makeThrottle(1000, 60)
  const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000 }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()
  log('panel: serving login RPC; pubkey', panelPubKey.slice(0, 16) + '…')

  // ===== SDK: connect + login (the real engine, headless) =====
  const ev = { progress: [], ready: [], errors: [] }
  const player = createPlayer({ panelPubKey, storeDir: dirs.cli, swarm: { bootstrap } })
  player.on('update-progress', (e) => ev.progress.push(e))
  player.on('update-ready', (e) => ev.ready.push(e))
  player.on('update-error', (e) => ev.errors.push(e))
  cleanups.push(() => player.stop())
  await player.connect()
  let streams = null
  const deadline = Date.now() + 60000
  while (!streams) {
    if (Date.now() > deadline) throw new Error('timeout: SDK login')
    try {
      const s = await player.login('alice', PASSWORD)
      if (s.length >= 1) streams = s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streams) await sleep(1500)
  }
  log('sdk: login OK; entitled to', JSON.stringify(streams.map(x => x.id)))

  // ===== No updates drive advertised yet -> 'unknown' (and only bad args throw) =====
  const u0 = await player.checkUpdate({ appId: APP_ID, platform: 'android', versionCode: 4 })
  assert.strictEqual(u0.status, 'unknown', "no meta/updatesKey must answer 'unknown', got " + JSON.stringify(u0))
  await assert.rejects(async () => player.checkUpdate({ appId: APP_ID, platform: 'ios', versionCode: 4 }), /platform/, 'unsupported platform must throw (host bug)')
  await assert.rejects(async () => player.checkUpdate({ appId: APP_ID, platform: 'android', versionCode: 4.5 }), /versionCode/, 'non-integer versionCode must throw (host bug)')
  log("check: pre-publish verdict is 'unknown'; bad arguments throw")

  // A leftover from "a previous install run": the first manifest read must sweep it.
  fs.mkdirSync(path.join(dirs.cli, 'updates'), { recursive: true })
  const stalePath = path.join(dirs.cli, 'updates', 'com.aliranclient.e2e-1.apk')
  fs.writeFileSync(stalePath, crypto.randomBytes(1024))

  // ===== Publisher (segment A stand-in): updates drive + manifest + pointer =====
  const upStore = new Corestore(dirs.pub); await upStore.ready(); cleanups.push(() => upStore.close())
  const updates = new Hyperdrive(upStore.namespace('updates')); await updates.ready()
  const upBlobs = await updates.getBlobs()
  const upSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => upSwarm.destroy())
  upSwarm.on('connection', (s) => upStore.replicate(s))
  upSwarm.join(updates.discoveryKey, { server: true, client: false }); await upSwarm.flush()

  const good = crypto.randomBytes(2 * 1024 * 1024) // ~2 MB artifact
  const bad = crypto.randomBytes(300 * 1024)
  await updates.put(`/pkg/${APP_ID}-5.apk`, good)
  await updates.put(`/pkg/${BAD_ID}-2.apk`, bad)
  const manifest = {
    [APP_ID]: {
      platform: 'android',
      versionCode: 5,
      versionName: '0.5.1',
      sha256: sha256(good),
      size: good.length,
      file: `/pkg/${APP_ID}-5.apk`,
      minVersionCode: 3,
      notes: 'e2e test build',
      releasedAt: new Date().toISOString()
    },
    [BAD_ID]: {
      platform: 'android',
      versionCode: 2,
      versionName: '0.2.0',
      sha256: sha256(good), // WRONG on purpose — the blob is `bad`
      size: bad.length,
      file: `/pkg/${BAD_ID}-2.apk`,
      releasedAt: new Date().toISOString()
    }
  }
  await updates.put('/manifest.json', b4a.from(JSON.stringify(manifest)))
  // The exact pointer shape the panel's store advertises (segment A contract).
  await db.put('meta/updatesKey', { key: b4a.toString(updates.key, 'hex'), blobsKey: b4a.toString(upBlobs.core.key, 'hex') })
  log('publisher: updates drive seeded (manifest + 2 artifacts); meta/updatesKey advertised')

  // ===== checkUpdate: every verdict =====
  // The pointer replicates to the viewer's bee and the lazy open joins the drive
  // topic — the first bounded reads may still answer 'unknown' while cold, so poll.
  const avail = await waitFor(async () => {
    const r = await player.checkUpdate({ appId: APP_ID, platform: 'android', versionCode: 4 })
    return r.status === 'available' ? r : null
  }, 90000, "checkUpdate 'available' once the pointer + manifest replicate")
  assert.strictEqual(avail.entry.versionCode, 5, 'entry.versionCode')
  assert.strictEqual(avail.entry.versionName, '0.5.1', 'entry.versionName')
  assert.strictEqual(avail.entry.sha256, sha256(good), 'entry.sha256')
  assert.strictEqual(avail.entry.size, good.length, 'entry.size')
  assert.strictEqual(avail.entry.file, `/pkg/${APP_ID}-5.apk`, 'entry.file')
  assert.strictEqual(avail.mandatory, false, 'versionCode 4 >= minVersionCode 3 must NOT be mandatory')
  // The updates topic must never be announced — whatever the uploadPolicy, a viewer
  // does not re-serve bulk APK blobs.
  assert.strictEqual(player._updatesDiscovery.isClient, true, 'updates topic joined as client')
  assert.strictEqual(player._updatesDiscovery.isServer, false, 'updates topic must NOT be announced (client-only join)')

  const mand = await player.checkUpdate({ appId: APP_ID, platform: 'android', versionCode: 2 })
  assert.strictEqual(mand.status, 'available', 'vc2 sees the update')
  assert.strictEqual(mand.mandatory, true, 'versionCode 2 < minVersionCode 3 must be mandatory')
  const cur = await player.checkUpdate({ appId: APP_ID, platform: 'android', versionCode: 5 })
  assert.strictEqual(cur.status, 'current', 'same versionCode is current')
  const ahead = await player.checkUpdate({ appId: APP_ID, platform: 'android', versionCode: 9 })
  assert.strictEqual(ahead.status, 'current', 'a newer-than-published build is current')
  const nn = await player.checkUpdate({ appId: 'com.example.unknown', platform: 'android', versionCode: 1 })
  assert.strictEqual(nn.status, 'none', "unknown appId answers 'none'")
  const wrongPlat = await player.checkUpdate({ appId: APP_ID, platform: 'windows', versionCode: 1 })
  assert.strictEqual(wrongPlat.status, 'none', "platform mismatch answers 'none'")
  assert.ok(!fs.existsSync(stalePath), 'the stale download must be swept on the first manifest read')
  log('check: available(+mandatory both ways) / current / none(appId, platform) OK; stale file swept; join is client-only')

  // ===== downloadUpdate: P2P stream -> progress -> sha256 verify -> final file =====
  const availAgain = await player.checkUpdate({ appId: APP_ID, platform: 'android', versionCode: 4 })
  assert.strictEqual(availAgain.status, 'available', 're-check before download')
  const res = await player.downloadUpdate()
  assert.ok(res.path.endsWith(`${APP_ID}-5.apk`), 'final path carries the artifact basename: ' + res.path)
  assert.strictEqual(res.entry.sha256, sha256(good), 'result carries the manifest entry')
  const onDisk = fs.readFileSync(res.path)
  assert.strictEqual(onDisk.length, good.length, 'downloaded size')
  assert.strictEqual(sha256(onDisk), sha256(good), 'downloaded bytes verify against the manifest sha256')
  assert.ok(!fs.existsSync(res.path + '.part'), 'no .part file left behind')
  assert.ok(ev.progress.length >= 2, 'throttled progress events fired (' + ev.progress.length + ')')
  for (let i = 1; i < ev.progress.length; i++) assert.ok(ev.progress[i].received >= ev.progress[i - 1].received, 'progress is monotonic')
  const last = ev.progress[ev.progress.length - 1]
  assert.strictEqual(last.received, good.length, 'final progress received == size')
  assert.strictEqual(last.total, good.length, 'progress total == manifest size')
  assert.strictEqual(ev.ready.length, 1, "'update-ready' fired once")
  assert.strictEqual(ev.ready[0].path, res.path, "'update-ready' carries the final path")
  assert.strictEqual(ev.errors.length, 0, 'no update-error on the good artifact')
  log(`download: ${good.length} bytes over P2P, ${ev.progress.length} progress events, sha256 verified, landed at ${res.path}`)

  // ===== Corrupt blob (manifest sha256 wrong): error surfaced, no final file =====
  const badCheck = await player.checkUpdate({ appId: BAD_ID, platform: 'android', versionCode: 1 })
  assert.strictEqual(badCheck.status, 'available', 'the corrupt entry still LOOKS available (the lie is in the hash)')
  await assert.rejects(() => player.downloadUpdate(), /verification|sha256/i, 'a sha256 mismatch must reject')
  await waitFor(() => ev.errors.length >= 1, 5000, "'update-error' after the verify failure")
  assert.ok(/verification|sha256/i.test(ev.errors[0].message), "'update-error' names the verify failure: " + ev.errors[0].message)
  const badFinal = path.join(dirs.cli, 'updates', `${BAD_ID}-2.apk`)
  assert.ok(!fs.existsSync(badFinal), 'a failed verification must never produce a final file')
  assert.ok(!fs.existsSync(badFinal + '.part'), 'the corrupt partial must be deleted')
  assert.strictEqual(ev.ready.length, 1, "no 'update-ready' for the corrupt artifact")
  assert.ok(fs.existsSync(res.path), 'the previously verified good artifact is untouched')
  log('corrupt: wrong manifest sha256 -> rejected + update-error, partial deleted, no final file')

  log('\nRESULT: PASS ✅  (meta/updatesKey -> lazy client-only replica -> check unknown/available+mandatory/current/none -> P2P download + progress + sha256 verify -> corrupt blob refused, stale files swept)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
