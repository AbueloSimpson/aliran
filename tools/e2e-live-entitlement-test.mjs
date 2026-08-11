// End-to-end LIVE ENTITLEMENT test (S57) on a LOCAL DHT testnet — never the public DHT,
// so it is deterministic and safe to gate CI on. tools/e2e-sdk-test.mjs covers the same
// ground inside its much larger public-DHT run; this lane exists so the feature stays
// verifiable when public-DHT conditions make that one unusable.
//
// A viewer with the app OPEN must follow their own grants without re-logging in. The
// SDK watches its own panel-signed `user/<name>` record (the same record sdk/login.js
// reads its grants from) and re-derives the entitled set from it. What is asserted:
//   1. a channel cataloged AND granted mid-session becomes playable — url + headers
//      verbatim, cdn shape, no re-login;
//   2. a newly granted P2P channel is NOT admitted (its key is sealed to the account
//      public key and the engine keeps no private key after login) — next login;
//   3. a revoked redirect channel leaves the lineup and can no longer be resolved, WITHOUT
//      tearing down the active play;
//   4. a P2P grant SURVIVES the panel's ordinary two-put revoke->reconcile, because
//      removal is symmetric with admission — dropping a P2P id would be a one-way door.
//
// Redirect channels need no broadcaster, no ffmpeg and no feed — exactly the shape the
// operator's m3u "events" source produces. Requires outbound UDP only. Exits 0 on PASS.
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import hcrypto from 'hypercore-crypto'
import http from 'http'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT
} from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { createPlayer } from '../sdk/index.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(200) }
  throw new Error('TIMEOUT: ' + label)
}
async function assertRejects (fn, re, label) {
  let msg = null
  try { await fn() } catch (e) { msg = String(e.message) }
  if (msg === null) throw new Error(label + ' must reject, but it resolved')
  if (!re.test(msg)) throw new Error(label + ' rejected with the wrong error: ' + msg)
}

const DIFFICULTY = 8
const PASSWORD = 'test123'
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('le-panel-'), cli: tmp('le-cli-') }
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

try {
  // ===== A stub "provider" the redirect urls point at =====
  const cdn = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2,\nseg0.ts\n')
  })
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const cdnPort = cdn.address().port
  cleanups.push(() => new Promise((resolve) => cdn.close(resolve)))

  // ===== Local DHT testnet =====
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap

  // ===== Panel =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
  const throttle = makeThrottle(1000, 60)
  panelSwarm.on('connection', (s) => { panelStore.replicate(s); attachLoginRpc(s, { keys, difficulty: DIFFICULTY, throttle, db, sessionTtlMs: 3600000 }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false })
  await panelSwarm.flush()
  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  log('panel: announced on the local testnet')

  // ===== Catalog + one granted redirect channel =====
  const urlOf = (n) => `http://127.0.0.1:${cdnPort}/index.m3u8?src=${n}`
  const hsig = (h) => h == null ? '<none>' : Object.keys(h).sort().map((k) => k + '=' + h[k]).join('&')
  const redirectRec = (title, n, headers) => ({ title, category: ['events'], type: 'live', protection: 'self', feedKey: null, blobsKey: null, redirect: true, url: urlOf(n), headers, isLive: true, status: 'live' })
  await db.put('catalog/promo', redirectRec('Promo', 'promo', { referer: 'https://provider.example/live/', 'user-agent': 'AliranTest/1.0' }))

  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt()
  const wk = wrapKeyFrom(rwd)
  const kp = userKeyPair()
  const authKp = authKeyPair()
  await db.put('user/alice', {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(rwd, salt, ARGON2_DEFAULT), 'hex'),
    argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'),
    encPriv: wrap(wk, kp.secretKey),
    authPub: b4a.toString(authKp.publicKey, 'hex'),
    authPrivEnc: wrap(wk, authKp.secretKey),
    wrapped: { promo: sealTo(kp.publicKey, hcrypto.randomBytes(32)) },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })

  // ===== Viewer =====
  const ev = { lastStreams: null, errors: [] }
  const player = createPlayer({ panelPubKey, storeDir: dirs.cli, swarm: { bootstrap, rcvbufMb: 0 } })
  player.on('streams', (s) => { ev.lastStreams = s })
  player.on('error', (e) => ev.errors.push(String(e.message)))
  cleanups.push(() => player.stop())
  await player.connect()
  let streams = null
  const deadline = Date.now() + 60000
  while (!streams) {
    if (Date.now() > deadline) throw new Error('TIMEOUT: login')
    try { const s = await player.login('alice', PASSWORD); if (s.length >= 1) streams = s } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!streams) await sleep(800)
  }
  log('sdk: login OK; entitled to', JSON.stringify(streams.map((s) => s.id)))
  if (streams.length !== 1 || streams[0].id !== 'promo') throw new Error('setup: expected exactly the promo grant at login')

  const inList = (id) => (ev.lastStreams || []).some((s) => s.id === id)
  const grantRec = async (mutate) => {
    const cur = (await db.get('user/alice')).value
    mutate(cur.wrapped)
    await db.put('user/alice', cur)
  }

  // ===== (1) a BRAND-NEW redirect channel, cataloged AND granted mid-session =====
  // login() is NOT called again from here on.
  const lateHeaders = { referer: 'https://provider.example/late/' }
  await db.put('catalog/late', redirectRec('Late Addition', 'late', lateHeaders))
  await grantRec((w) => { w.late = sealTo(kp.publicKey, hcrypto.randomBytes(32)) })
  await waitFor(async () => inList('late'), 30000, 'mid-session grant reaches the display list with no re-login')
  const rLate = await player.resolve('late')
  if (rLate.url !== urlOf('late')) throw new Error('mid-session grant resolved to the wrong url: ' + rLate.url)
  if (hsig(rLate.headers) !== hsig(lateHeaders)) throw new Error('mid-session grant lost its headers: ' + hsig(rLate.headers))
  if (rLate.source !== 'cdn' || rLate.port !== undefined) throw new Error('mid-session grant resolved with the wrong shape: ' + JSON.stringify(rLate))
  log('PASS 1: channel added AND granted mid-session became playable, no re-login')

  // ===== (2) a newly granted P2P channel must NOT be admitted =====
  await db.put('catalog/p2plate', { title: 'P2P Late', category: ['misc'], type: 'live', protection: 'self', feedKey: b4a.toString(hcrypto.randomBytes(32), 'hex'), blobsKey: null, isLive: true, status: 'live' })
  await grantRec((w) => { w.p2plate = sealTo(kp.publicKey, hcrypto.randomBytes(32)) })
  await sleep(5000) // generous room for the watcher to WRONGLY admit it
  if (inList('p2plate') || player._entitled.has('p2plate')) throw new Error('a mid-session-granted P2P channel must NOT be admitted (engine keeps no private key)')
  await assertRejects(() => player.resolve('p2plate'), /not entitled/, 'resolve() of an unadmitted P2P grant')
  log('PASS 2: mid-session-granted P2P channel correctly waits for the next login')

  // ===== (3) revoke: leaves the lineup, blocks resolve, does NOT kill the active play =====
  await player.resolve('promo') // make promo unambiguously the active play
  if (!player._active || player._active.streamId !== 'promo') throw new Error('setup: promo should be active before the revoke')
  await grantRec((w) => { delete w.promo })
  await waitFor(async () => !inList('promo'), 30000, 'revoked grant leaves the display list')
  await assertRejects(() => player.resolve('promo'), /not entitled/, 'resolve() of a revoked grant')
  if (!player._active || player._active.streamId !== 'promo') throw new Error('a revoke must NOT tear down the active play')
  if (!inList('late')) throw new Error('a revoke must not disturb the surviving grants')
  log('PASS 3: revoke removed the channel and blocked re-resolve; active play untouched')

  // ===== (4) the panel's ORDINARY revoke is TWO puts; a P2P grant must survive it =====
  // admin-server.js / admin-cli.js both call ops.revoke() and THEN reconcilePackages(),
  // and the intermediate record is grant-less. Removal is symmetric with admission for
  // exactly this reason: dropping a P2P id would be a one-way door (nothing can re-seal
  // it without the account key), so a package-covered channel would vanish for the rest
  // of the session even though the panel's END state still grants it.
  await db.put('catalog/p2pkeep', { title: 'P2P Keep', category: ['misc'], type: 'live', protection: 'self', feedKey: b4a.toString(hcrypto.randomBytes(32), 'hex'), blobsKey: null, isLive: true, status: 'live' })
  const p2pSealed = sealTo(kp.publicKey, hcrypto.randomBytes(32))
  // Log in fresh so the P2P channel is in _entitled the way a real session gets it.
  const player2 = createPlayer({ panelPubKey, storeDir: tmp('le-cli2-'), swarm: { bootstrap, rcvbufMb: 0 } })
  const ev2 = { lastStreams: null }
  player2.on('streams', (s) => { ev2.lastStreams = s })
  cleanups.push(() => player2.stop())
  await grantRec((w) => { w.p2pkeep = p2pSealed })
  await player2.connect()
  let s2 = null
  const dl2 = Date.now() + 60000
  while (!s2) {
    if (Date.now() > dl2) throw new Error('TIMEOUT: login 2')
    try { const s = await player2.login('alice', PASSWORD); if (s.some((x) => x.id === 'p2pkeep')) s2 = s } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    if (!s2) await sleep(800)
  }
  if (!player2._entitled.has('p2pkeep')) throw new Error('setup: p2pkeep should be entitled at login')
  await grantRec((w) => { delete w.p2pkeep }) // put 1: ops.revoke()
  await sleep(2500)
  await grantRec((w) => { w.p2pkeep = p2pSealed }) // put 2: reconcilePackages() re-seals
  await sleep(2500)
  if (!player2._entitled.has('p2pkeep')) throw new Error('a P2P grant must SURVIVE the panel revoke->reconcile two-put (one-way door)')
  await player2.resolve('p2pkeep').catch((e) => {
    if (/not entitled/.test(String(e.message))) throw new Error('P2P channel became unresolvable after revoke->reconcile')
  })
  log('PASS 4: P2P grant survived the panel two-put revoke->reconcile')

  if (ev.errors.length) throw new Error("engine emitted 'error': " + JSON.stringify(ev.errors))
  log('\nRESULT: PASS  (live entitlement: mid-session grant + P2P hold-back + revoke + P2P survives the two-put revoke->reconcile)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('\nRESULT: FAIL')
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
