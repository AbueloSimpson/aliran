// End-to-end OTA app-update test: the REAL panel (openStore creates the updates
// Hyperdrive and advertises meta/updatesKey at boot) publishes artifacts through the
// REAL ops (precheckUpdate/putUpdate — the same path the admin server's streaming
// intake drives), and the REAL SDK engine (connect + OPRF login against the real
// login RPC) discovers the drive lazily, answers checkUpdate() for every verdict
// (none on an empty drive / available+mandatory / current / none / unknown on a junk
// entry), then downloadUpdate() streams the artifact over P2P with throttled
// progress, verifies its sha256 and lands the file on disk — while a manifest entry
// whose sha256 does not match its blob must be discarded, surfaced as an error, and
// never produce a final file. Also: the stale-download sweep, and the updates topic
// joined client-only (a viewer never re-serves APK blobs).
// Local DHT testnet only (never the public DHT). No ffmpeg. Exits 0 on PASS.
import Hyperswarm from 'hyperswarm'
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
import { precheckUpdate, putUpdate, updateTarget } from '../panel/src/ops.js'
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
const JUNK_ID = 'com.aliranclient.junk'
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('e2eu-panel-'), cli: tmp('e2eu-cli-') }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Local DHT testnet (this lane must not be flaky) =====
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap
  log('testnet up:', JSON.stringify(bootstrap))

  // ===== Panel: keys, one enrolled viewer + catalog record, real login RPC.
  // openStore itself creates the updates drive and advertises meta/updatesKey.
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db, updates } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const ctx = { updates } // the ops ctx slice the updates publishers use
  const ptr = (await db.get('meta/updatesKey'))?.value
  assert.ok(ptr && ptr.key === b4a.toString(updates.key, 'hex'), 'openStore advertises the updates drive key')
  assert.strictEqual(ptr.blobsKey, b4a.toString(updates.blobs.core.key, 'hex'), 'pointer carries the blobs key')
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
  log('panel: serving login RPC; updates drive advertised at boot; pubkey', panelPubKey.slice(0, 16) + '…')

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

  // ===== Pre-publish: pointer advertised, drive EMPTY -> 'none' (and bad args throw) =====
  // The panel always advertises the drive now, so an operator who never uploaded
  // reads as an honest 'none', not 'unknown'. (waitFor: the first sparse metadata
  // sync of the drive may briefly answer 'unknown' while cold.)
  const pre = await waitFor(async () => {
    const r = await player.checkUpdate({ appId: APP_ID, platform: 'android', versionCode: 4 })
    return r.status !== 'unknown' ? r : null
  }, 60000, 'pre-publish verdict (empty drive)')
  assert.strictEqual(pre.status, 'none', "an advertised but EMPTY updates drive must answer 'none', got " + JSON.stringify(pre))
  await assert.rejects(async () => player.checkUpdate({ appId: APP_ID, platform: 'ios', versionCode: 4 }), /platform/, 'unsupported platform must throw (host bug)')
  await assert.rejects(async () => player.checkUpdate({ appId: APP_ID, platform: 'android', versionCode: 4.5 }), /versionCode/, 'non-integer versionCode must throw (host bug)')
  log("check: pre-publish (empty drive) verdict is 'none'; bad arguments throw")

  // A leftover from "a previous install run": the first manifest read must sweep it.
  fs.mkdirSync(path.join(dirs.cli, 'updates'), { recursive: true })
  const stalePath = path.join(dirs.cli, 'updates', 'com.aliranclient.e2e-1.apk')
  fs.writeFileSync(stalePath, crypto.randomBytes(1024))

  // ===== Publish through the REAL panel ops (the admin server's streaming order:
  // precheck -> artifact into the drive -> putUpdate with the stream's hash) =====
  const good = crypto.randomBytes(2 * 1024 * 1024) // ~2 MB artifact
  const bad = crypto.randomBytes(300 * 1024)
  const goodMeta = { platform: 'android', versionCode: 5, versionName: '0.5.1', minVersionCode: 3, notes: 'e2e test build' }
  const goodTarget = await precheckUpdate(ctx, APP_ID, goodMeta)
  assert.strictEqual(goodTarget.file, `/pkg/${APP_ID}-5.apk`, 'precheck derives the artifact path')
  await updates.put(goodTarget.file, good)
  const put1 = await putUpdate(ctx, APP_ID, { ...goodMeta, sha256: sha256(good), size: good.length })
  assert.strictEqual(put1.entry.file, goodTarget.file, 'putUpdate publishes the streamed path')
  // The corrupt case: the artifact bytes and the manifest sha256 disagree — putUpdate
  // trusts the (server-side) stream hash, so a wrong hash models a corrupted blob.
  const badTarget = updateTarget(BAD_ID, 'android', 2)
  await updates.put(badTarget.file, bad)
  await putUpdate(ctx, BAD_ID, { platform: 'android', versionCode: 2, versionName: '0.2.0', sha256: sha256(good), size: bad.length })
  // A junk entry the real ops REFUSE to write (updateTarget validates versionCode) —
  // inject it raw to model a broken publisher: the SDK must answer 'unknown', never
  // 'current' with garbage attached.
  const rawManifest = JSON.parse(b4a.toString(await updates.get('/manifest.json')))
  rawManifest[JUNK_ID] = { platform: 'android', versionCode: '7', versionName: 'not-a-real-build', sha256: sha256(good), size: 1, file: `/pkg/${JUNK_ID}-7.apk`, releasedAt: new Date().toISOString() }
  await updates.put('/manifest.json', b4a.from(JSON.stringify(rawManifest)))
  log('publisher: 2 artifacts published via precheckUpdate/putUpdate; junk entry injected raw')

  // ===== checkUpdate: every verdict =====
  const avail = await waitFor(async () => {
    const r = await player.checkUpdate({ appId: APP_ID, platform: 'android', versionCode: 4 })
    return r.status === 'available' ? r : null
  }, 90000, "checkUpdate 'available' once the published manifest replicates")
  assert.strictEqual(avail.entry.versionCode, 5, 'entry.versionCode')
  assert.strictEqual(avail.entry.versionName, '0.5.1', 'entry.versionName')
  assert.strictEqual(avail.entry.sha256, sha256(good), 'entry.sha256')
  assert.strictEqual(avail.entry.size, good.length, 'entry.size')
  assert.strictEqual(avail.entry.file, `/pkg/${APP_ID}-5.apk`, 'entry.file')
  assert.ok(avail.entry.releasedAt, 'putUpdate stamps releasedAt')
  assert.strictEqual(avail.mandatory, false, 'versionCode 4 >= minVersionCode 3 must NOT be mandatory')
  // The SDK follows the PANEL's own drive — the pointer openStore advertised.
  assert.strictEqual(b4a.toString(player._updatesDrive.key, 'hex'), b4a.toString(updates.key, 'hex'), 'the SDK replica is the panel-advertised updates drive')
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
  const junk = await player.checkUpdate({ appId: JUNK_ID, platform: 'android', versionCode: 1 })
  assert.strictEqual(junk.status, 'unknown', "a malformed entry (non-integer versionCode) answers 'unknown', never 'current' with junk attached")
  assert.strictEqual(junk.entry, undefined, 'the malformed entry itself must not be handed to the UI')
  assert.ok(!fs.existsSync(stalePath), 'the stale download must be swept on the first manifest read')
  log('check: available(+mandatory both ways) / current / none(appId, platform) / unknown(junk entry) OK; stale file swept; join is client-only')

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

  log('\nRESULT: PASS ✅  (panel-advertised drive -> real precheckUpdate/putUpdate publish -> lazy client-only replica -> check none/available+mandatory/current/unknown -> P2P download + progress + sha256 verify -> corrupt blob refused, stale files swept)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
