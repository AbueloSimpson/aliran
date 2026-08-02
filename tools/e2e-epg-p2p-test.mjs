// End-to-end EPG-over-P2P test: the standalone epg/ service ingests a fixture guide,
// writes per-channel-per-day files into its epoch drive (byte-compared — a quiet
// re-ingest appends NOTHING), publishes the drive pointer through the panel's
// publisher-scoped setEpgKey RPC, and a viewer-shaped client resolves meta/epgKey,
// sparse-replicates only the file it asks for, and serves it over loopback with the
// drive-version ETag (poll → 304). Rotation flips the pointer (one bee record) and
// the copied guide survives; a WARM viewer keeps answering after the panel dies.
// No ffmpeg. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import http from 'http'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import createTestnet from 'hyperdht/testnet.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { addPublisher } from '../panel/src/ops.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { createDriveHandler } from '../sdk/serve.js'
import { startEpg } from '../epg/src/index.js'
import { providerManual } from '../epg/src/ingest.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) } throw new Error('timeout: ' + label) }
function httpGet (port, p, headers = {}) { return new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: p, agent: false, headers }, (res) => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })) }).on('error', reject) }) }
const log = (...a) => console.log(...a)

const dirs = {
  panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eepg-panel-')),
  epg: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eepg-svc-')),
  cli: fs.mkdtempSync(path.join(os.tmpdir(), 'e2eepg-cli-'))
}
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

try {
  // ===== Local DHT testnet (never the public DHT — this lane must not be flaky) =====
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap
  log('testnet up:', JSON.stringify(bootstrap))

  // ===== Panel: catalog with an epgId mapping + an enrolled `epg`-scoped publisher =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', protection: 'self', feedKey: 'ab'.repeat(32), isLive: true, status: 'live', epgId: 'PROV-1' })
  const pub = addPublisher({ dataDir: dirs.panel }, 'epg1', { scopes: ['epg'] })
  const throttle = makeThrottle(1000, 60)
  const topic = hcrypto.hash(keys.signing.publicKey)
  const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (s) => { panelStore.replicate(s); attachLoginRpc(s, { keys, difficulty: 8, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000 }) })
  panelSwarm.join(topic, { server: true, client: false }); await panelSwarm.flush()
  const panelKeyHex = b4a.toString(keys.signing.publicKey, 'hex')
  log('panel: catalog/news carries epgId PROV-1; publisher epg1 enrolled with scope "epg"')

  // ===== EPG service: fixture ingest -> epoch drive -> pointer via setEpgKey =====
  const today = new Date().toISOString().slice(0, 10)
  const hour = 3600 * 1000
  const t0 = Date.parse(today) // UTC midnight today
  const mkEpg = (base) => [
    { title: 'Morning Show', start: new Date(base + 8 * hour).toISOString(), stop: new Date(base + 10 * hour).toISOString() },
    { title: 'Midday News', start: new Date(base + 10 * hour).toISOString(), stop: new Date(base + 13 * hour).toISOString() }
  ]
  const fixture = path.join(dirs.epg, 'guide.json')
  const day = 24 * hour
  // Four days of guide → four day-files, so the viewer's one-day fetch is provably
  // a strict subset of the writer's blobs (the sparse assertion below).
  fs.writeFileSync(fixture, JSON.stringify({
    channels: [
      { id: 'PROV-1', epg: [...mkEpg(t0), ...mkEpg(t0 + day), ...mkEpg(t0 + 2 * day), ...mkEpg(t0 + 3 * day)] },
      { id: 'PROV-ORPHAN', epg: mkEpg(t0) } // no catalog epgId matches — must surface as unmatched, never write
    ]
  }))
  const provider = providerManual({ id: 'fixture', file: fixture })
  const svc = await startEpg({
    dataDir: dirs.epg,
    panelPubKey: panelKeyHex,
    publisherKey: pub.secretKey, // addPublisher returns it hex already
    publisherName: 'epg1',
    providers: [provider],
    epochDays: 9999, // rotation in this test is explicit, never time-driven
    graceHours: 1,
    guideDays: 7,
    bootstrap,
    status: { enabled: false }
  })
  cleanups.push(() => svc.close())

  await waitFor(() => svc.guide.status().mappedChannels === 1, 90000, 'catalog replication + epgId mapping')
  const run1 = await svc.ingest.runProvider(provider)
  assert.strictEqual(run1.ok, true, 'ingest run must succeed')
  assert.strictEqual(run1.unmatched, 1, 'PROV-ORPHAN must count as unmatched')
  assert.ok(run1.puts >= 1, 'mapped channel-days must be written')
  log(`epg: ingest #1 wrote ${run1.puts} day-files (unmatched: ${run1.unmatched})`)

  // Frugality: an unchanged re-ingest appends NOTHING (mtime nudged, bytes identical).
  const past = new Date(Date.now() - 1000)
  fs.utimesSync(fixture, past, past); fs.utimesSync(fixture, new Date(), new Date())
  const run2 = await svc.ingest.runProvider(provider)
  assert.strictEqual(run2.puts, 0, 'unchanged re-ingest must put nothing')
  assert.ok(run2.skips >= 1, 'unchanged days must be byte-compare skips')
  log('epg: ingest #2 (unchanged) appended nothing — byte-compare holds')

  // Pointer must land on the panel through the authenticated RPC.
  const ptr1 = await waitFor(async () => (await db.get('meta/epgKey'))?.value, 30000, 'meta/epgKey via setEpgKey RPC')
  assert.strictEqual(ptr1.key, svc.guide.driveInfo().key, 'pointer carries the epoch drive key')
  assert.strictEqual(ptr1.blobsKey, svc.guide.driveInfo().blobsKey, 'pointer carries the blobs key (raw mirrors)')
  assert.strictEqual(ptr1.origin, 'epg1', 'pointer is attributed to the publisher')
  const beeLenAfterPtr = db.core.length
  log(`epg: pointer delivered (epoch ${ptr1.epoch}, drive ${ptr1.key.slice(0, 8)}…)`)

  // ===== Viewer: resolve pointer, sparse-replicate, serve via the SDK core =====
  const cliStore = new Corestore(dirs.cli); await cliStore.ready(); cleanups.push(() => cliStore.close())
  const cliBee = new Hyperbee(cliStore.get({ key: keys.signing.publicKey }), { keyEncoding: 'utf-8', valueEncoding: 'json' }); await cliBee.ready()
  const cliSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => cliSwarm.destroy())
  cliSwarm.on('connection', (s) => cliStore.replicate(s))
  cliSwarm.join(topic, { client: true, server: false })
  const metaNode = await waitFor(async () => await cliBee.get('meta/epgKey'), 30000, 'viewer reads meta/epgKey')

  let epgReplica = new Hyperdrive(cliStore.namespace('epg-replica-1'), b4a.from(metaNode.value.key, 'hex')); await epgReplica.ready()
  cliSwarm.join(epgReplica.discoveryKey, { client: true, server: false })
  const handler = createDriveHandler((p) => p.startsWith('/epg/') ? { drive: epgReplica, path: p.slice('/epg'.length), media: false, etag: 'epg-' + epgReplica.version } : null)
  const server = http.createServer((req, res) => handler(req, res)); cleanups.push(() => server.close())
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const dayPath = `/epg/v1/news/${today}.json`
  const r1 = await waitFor(async () => { const x = await httpGet(port, dayPath); return x.status === 200 ? x : null }, 30000, 'day file served over P2P')
  const rows = JSON.parse(r1.body.toString())
  assert.strictEqual(rows.length, 2, 'both programs served')
  assert.strictEqual(rows[0].title, 'Morning Show', 'programs sorted by start')
  assert.ok(r1.headers.etag, 'ETag present')
  const r304 = await httpGet(port, dayPath, { 'if-none-match': r1.headers.etag })
  assert.strictEqual(r304.status, 304, 'matching If-None-Match answers 304')
  const rMiss = await httpGet(port, '/epg/v1/nope/2020-01-01.json')
  assert.strictEqual(rMiss.status, 404, 'uncovered channel 404s immediately (https fallback trigger)')
  log(`viewer: fetched ${dayPath} -> 200 (${r1.body.length} bytes), poll -> 304, miss -> 404`)

  // Sparse assertion: the viewer holds only the file it asked for — the orphan is
  // not in the drive at all, and the replica's blob core holds strictly fewer
  // blocks than the writer's (the guide has other days the viewer never touched).
  const writerBlobs = await svc.guide._drive.getBlobs()
  const replicaBlobs = await epgReplica.getBlobs()
  let held = 0
  for (let i = 0; i < replicaBlobs.core.length; i++) if (await replicaBlobs.core.has(i)) held++
  assert.ok(held > 0 && held < writerBlobs.core.length, `sparse replica must hold a strict subset of blobs (held ${held}/${writerBlobs.core.length})`)
  log(`viewer: sparse replica holds ${held}/${writerBlobs.core.length} blob blocks`)

  // ===== Rotation: fresh drive, one pointer record, guide survives the copy =====
  await svc.guide.rotate()
  const ptr2 = await waitFor(async () => { const v = (await db.get('meta/epgKey'))?.value; return v && v.key !== ptr1.key ? v : null }, 30000, 'rotated pointer delivered')
  assert.strictEqual(ptr2.epoch, ptr1.epoch + 1, 'epoch increments')
  assert.ok(db.core.length - beeLenAfterPtr <= 2, `rotation must cost ~one bee record (grew ${db.core.length - beeLenAfterPtr})`)
  const meta2 = await waitFor(async () => { const n = await cliBee.get('meta/epgKey'); return n?.value?.key === ptr2.key ? n : null }, 30000, 'viewer sees the rotated pointer')
  await epgReplica.close()
  epgReplica = new Hyperdrive(cliStore.namespace('epg-replica-2'), b4a.from(meta2.value.key, 'hex')); await epgReplica.ready()
  cliSwarm.join(epgReplica.discoveryKey, { client: true, server: false })
  const r2 = await waitFor(async () => { const x = await httpGet(port, dayPath); return x.status === 200 ? x : null }, 30000, 'day file served from the ROTATED drive')
  assert.deepStrictEqual(JSON.parse(r2.body.toString()), rows, 'rotated drive serves the same guide')
  log(`rotation: epoch ${ptr2.epoch} live, guide intact, bee grew by ${db.core.length - beeLenAfterPtr} record(s)`)

  // ===== Repeater as a relay: full guide mirror + catalog ANNOUNCE =====
  const { Repeater } = await import('../repeater/src/index.js')
  dirs.rep = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eepg-rep-'))
  const repeater = new Repeater({
    dataDir: dirs.rep,
    panelPubKey: panelKeyHex,
    channels: 'all',
    epg: true,
    announce: true,
    bootstrap,
    reconcileIntervalMs: 5000
  })
  await repeater.start(); cleanups.push(() => repeater.close())
  await waitFor(() => {
    const s = repeater.status()
    return s.epg && s.epg.key === ptr2.key && s.epg.lengths.length === 2 && s.epg.lengths.every((l) => l > 0)
  }, 60000, 'repeater mirrors the rotated guide drive (both cores)')
  log('repeater: guide mirror armed (announce on the catalog topic active)')

  // ===== Panel + EPG service down: WARM viewer serves; COLD viewer bootstraps from the repeater =====
  await svc.close() // (its cleanup entry re-closes harmlessly — every close is try/catch)
  await panelSwarm.destroy()
  const r3 = await httpGet(port, dayPath)
  assert.strictEqual(r3.status, 200, 'warm viewer still serves the guide with panel AND epg service down')
  log('offline: warm viewer answered from local blocks with the panel and EPG service both dead')

  dirs.cold = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eepg-cold-'))
  const coldStore = new Corestore(dirs.cold); await coldStore.ready(); cleanups.push(() => coldStore.close())
  const coldBee = new Hyperbee(coldStore.get({ key: keys.signing.publicKey }), { keyEncoding: 'utf-8', valueEncoding: 'json' }); await coldBee.ready()
  const coldSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => coldSwarm.destroy())
  coldSwarm.on('connection', (s) => coldStore.replicate(s))
  coldSwarm.join(topic, { client: true, server: false })
  const coldMeta = await waitFor(async () => await coldBee.get('meta/epgKey'), 60000, 'COLD viewer reads meta/epgKey from the repeater (panel dead)')
  assert.strictEqual(coldMeta.value.key, ptr2.key, 'cold viewer sees the current epoch pointer')
  const coldReplica = new Hyperdrive(coldStore.namespace('epg-replica'), b4a.from(coldMeta.value.key, 'hex')); await coldReplica.ready()
  coldSwarm.join(coldReplica.discoveryKey, { client: true, server: false })
  const coldEntry = await waitFor(async () => await coldReplica.get(`/v1/news/${today}.json`).catch(() => null), 60000, 'COLD viewer fetches the guide from the repeater')
  assert.deepStrictEqual(JSON.parse(b4a.toString(coldEntry)), rows, 'cold-bootstrapped guide matches')
  log('relay: COLD viewer bootstrapped catalog + guide from the announcing repeater alone')

  log('\nRESULT: PASS ✅  (ingest → epoch drive → setEpgKey pointer → sparse viewer serve + 304/404 → rotation ≈1 bee record → warm-offline → cold bootstrap via repeater)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
