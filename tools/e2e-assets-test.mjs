// End-to-end v0.2 test: panel assets Hyperdrive (posters/art) replicates to a client and
// serves over localhost at /assets/*. No ffmpeg. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import http from 'http'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { driveHandler } from './lib/serve-drive.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) } throw new Error('timeout: ' + label) }
function httpGet (port, p) { return new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })) }).on('error', reject) }) }
const log = (...a) => console.log(...a)

const dirs = { panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ea-panel-')), cli: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ea-cli-')) }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Panel: catalog + uploaded poster =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db, assets } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', protection: 'self', feedKey: 'ab'.repeat(32), isLive: true, poster: null, status: 'live' })
  const art = b4a.concat([b4a.from([0x89, 0x50, 0x4e, 0x47]), hcrypto.randomBytes(3000)]) // fake PNG
  await assets.put('/news/poster.png', art)
  const cn = (await db.get('catalog/news')).value; cn.poster = 'assets/news/poster.png'; await db.put('catalog/news', cn)
  log('panel: uploaded poster (' + art.length + ' bytes); assetsKey advertised in meta/assetsKey')

  const topic = hcrypto.hash(keys.signing.publicKey)
  const panelSwarm = new Hyperswarm(); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (s) => panelStore.replicate(s))
  panelSwarm.join(topic, { server: true, client: false }); await panelSwarm.flush()

  // ===== Client: discover assetsKey, replicate, serve /assets =====
  const cliStore = new Corestore(dirs.cli); await cliStore.ready(); cleanups.push(() => cliStore.close())
  const cliBee = new Hyperbee(cliStore.get({ key: keys.signing.publicKey }), { keyEncoding: 'utf-8', valueEncoding: 'json' }); await cliBee.ready()
  const cliSwarm = new Hyperswarm(); cleanups.push(() => cliSwarm.destroy())
  cliSwarm.on('connection', (s) => cliStore.replicate(s))
  cliSwarm.join(topic, { client: true, server: false })

  const metaNode = await waitFor(async () => await cliBee.get('meta/assetsKey'), 30000, 'meta/assetsKey replication')
  const catNode = await waitFor(async () => await cliBee.get('catalog/news'), 30000, 'catalog replication')
  assert.strictEqual(catNode.value.poster, 'assets/news/poster.png', 'catalog poster path')

  const assetsReplica = new Hyperdrive(cliStore, b4a.from(metaNode.value.key, 'hex')); await assetsReplica.ready()
  const server = http.createServer(driveHandler(assetsReplica, { mounts: { '/assets': assetsReplica } })); cleanups.push(() => server.close())
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const r = await waitFor(async () => { const x = await httpGet(port, '/' + catNode.value.poster); return x.status === 200 ? x : null }, 30000, 'poster served over P2P')
  log('client: fetched', catNode.value.poster, '->', r.status, r.headers['content-type'], `(${r.body.length} bytes)`)
  assert.ok(b4a.equals(r.body, art), 'poster bytes must match after P2P replication')
  assert.strictEqual(r.headers['content-type'], 'image/png', 'content-type')

  log('\nRESULT: PASS ✅  (assets uploaded → replicated P2P → served on localhost, bytes match)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
