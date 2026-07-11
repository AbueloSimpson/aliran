// End-to-end v0.2 test: panel (login RPC + signed DB) + broadcaster (encrypted feed) +
// client (OPRF login -> resolve granted stream -> play). Validates delivered media with
// ffprobe. Requires ffmpeg/ffprobe on PATH + outbound UDP. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Hyperbee from 'hyperbee'
import hcrypto from 'hypercore-crypto'
import http from 'http'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { spawnSync } from 'child_process'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, ARGON2_DEFAULT
} from '@aliran/core'
import { startFfmpeg, mirrorDirToDrive } from '../broadcaster/src/hls.js'
import { driveHandler } from './lib/serve-drive.js'
import { panelClient, login } from '../client/backend/login.mjs'
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
function httpGet (port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

const DIFFICULTY = 8 // low for a fast test
const PASSWORD = 'test123'
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('e2el-panel-'), feed: tmp('e2el-feed-'), cliDb: tmp('e2el-clidb-'), cliFeed: tmp('e2el-clifeed-'), out: tmp('e2el-hls-') }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Broadcaster: encrypted feed =====
  const encKey = hcrypto.randomBytes(32)
  const feedStore = new Corestore(dirs.feed); await feedStore.ready(); cleanups.push(() => feedStore.close())
  const feed = new Hyperdrive(feedStore.namespace('feed'), { encryptionKey: encKey }); await feed.ready()
  const feedSwarm = new Hyperswarm(); cleanups.push(() => feedSwarm.destroy())
  feedSwarm.on('connection', s => feed.replicate(s))
  feedSwarm.join(feed.discoveryKey, { server: true, client: false }); await feedSwarm.flush()
  const ff = startFfmpeg({ input: 'test', hls: { time: 2, listSize: 6 } }, dirs.out); cleanups.push(() => ff.kill())
  const stopMirror = mirrorDirToDrive(dirs.out, feed, { interval: 400 }); cleanups.push(() => stopMirror())
  log('broadcaster: feed key', b4a.toString(feed.key, 'hex').slice(0, 16) + '…')

  // ===== Panel: keys, enroll alice + stream + grant, serve RPC =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  // enroll user alice
  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt()
  const kp = userKeyPair()
  await db.put('user/alice', {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(rwd, salt, ARGON2_DEFAULT), 'hex'),
    argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'),
    encPriv: wrap(wrapKeyFrom(rwd), kp.secretKey),
    wrapped: { news: sealTo(kp.publicKey, encKey) },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', protection: 'self', feedKey: b4a.toString(feed.key, 'hex'), isLive: true, poster: null, status: 'live' })

  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  const throttle = makeThrottle(1000, 60)
  const panelSwarm = new Hyperswarm(); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { oprfKey: keys.oprf, difficulty: DIFFICULTY, throttle }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()
  log('panel: serving login RPC; pubkey', panelPubKey.slice(0, 16) + '…')

  // ===== Client: connect to panel, replicate DB, OPRF login =====
  const cliStore = new Corestore(dirs.cliDb); await cliStore.ready(); cleanups.push(() => cliStore.close())
  const cliBee = new Hyperbee(cliStore.get({ key: b4a.from(panelPubKey, 'hex') }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await cliBee.ready()
  let call = null
  const cliPanelSwarm = new Hyperswarm(); cleanups.push(() => cliPanelSwarm.destroy())
  cliPanelSwarm.on('connection', (socket) => { cliStore.replicate(socket); if (!call) call = panelClient(socket).call })
  cliPanelSwarm.join(hcrypto.hash(keys.signing.publicKey), { client: true, server: false })
  log('client: connecting to panel…')

  await waitFor(async () => call, 30000, 'panel connection')
  await waitFor(async () => await cliBee.get('user/alice'), 30000, 'DB replication to client')
  log('client: DB replicated; logging in…')

  const { streams } = await login(call, cliBee, 'alice', PASSWORD)
  if (!streams.length) throw new Error('no streams after login')
  const s = streams[0]
  log('client: login OK; entitled to', JSON.stringify(streams.map(x => x.id)), '- feedKey', s.feedKey.slice(0, 16) + '…')
  if (b4a.toString(encKey, 'hex') !== s.encryptionKey) throw new Error('recovered encryptionKey mismatch')

  // wrong password must be rejected
  let rejected = false
  try { await login(call, cliBee, 'alice', 'WRONG') } catch { rejected = true }
  if (!rejected) throw new Error('wrong password was NOT rejected')
  log('client: wrong password correctly rejected')

  // ===== Client: play the entitled feed over P2P =====
  const cfStore = new Corestore(dirs.cliFeed); await cfStore.ready(); cleanups.push(() => cfStore.close())
  const replica = new Hyperdrive(cfStore, b4a.from(s.feedKey, 'hex'), { encryptionKey: b4a.from(s.encryptionKey, 'hex') })
  await replica.ready()
  const cliFeedSwarm = new Hyperswarm(); cleanups.push(() => cliFeedSwarm.destroy())
  cliFeedSwarm.on('connection', sock => replica.replicate(sock))
  cliFeedSwarm.join(replica.discoveryKey, { server: true, client: true })
  const server = http.createServer(driveHandler(replica)); cleanups.push(() => server.close())
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const playlist = await waitFor(async () => { const r = await httpGet(port, '/index.m3u8'); return r.status === 200 && r.body.includes('.ts') ? r.body.toString() : null }, 40000, 'playback over P2P')
  const segName = (playlist.match(/[^\s]+\.ts/) || [])[0]
  const full = await httpGet(port, '/' + segName)
  const segPath = path.join(os.tmpdir(), 'e2el-seg.ts'); fs.writeFileSync(segPath, full.body)
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', segPath], { encoding: 'utf8' })
  const probeOut = (probe.stdout || '').trim()
  log('client: played', full.body.length, 'bytes; ffprobe:', JSON.stringify(probeOut))

  const pass = streams.length && full.body.length > 0 && /video/.test(probeOut) && rejected
  log('\nRESULT:', pass ? 'PASS ✅  (login → entitlement → P2P playback verified)' : 'FAIL ❌')
  await cleanup(); process.exit(pass ? 0 : 1)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
