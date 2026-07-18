// End-to-end S20 repeater test on a LOCAL DHT testnet (never the public DHT).
// Cast: a real panel (register RPC + S20a blobsKey enrichment), a synthetic origin
// broadcaster (encrypted live Hyperdrive, appended like the hls.js mirror, announced
// server-only like channel.js), the KEYLESS repeater, and real SDK viewers
// (`createPlayer(...).serveFeed(...)` — the direct-play path, over the testnet via the
// SDK's swarm.bootstrap option). Verifies the S20 brief:
//   (1) with the origin's viewer slots taken (the SWARM_MAX_PEERS deployment model —
//       the accept-gate itself is proven by broadcaster-api Test Q), a viewer plays
//       ENTIRELY off the repeater: byte counters both sides — the origin's only
//       connection is the repeater (~one stream out), the viewer's bytes all arrive
//       over its repeater connection, and the viewer still decrypts real plaintext;
//   (2) origin killed mid-play → the buffered window keeps playing off the repeater,
//       including for a COLD viewer that never saw the origin at all;
//   (3) feedKey rotation (source change) → the repeater re-points unattended via the
//       catalog watch and PURGES the old cores from disk;
//   (4) retention: the mirrored window stays bounded across many segment appends,
//       cleared blocks stay cleared (no clear/re-download loop);
//   (5) keyless proof: the repeater's store, config and status contain neither the
//       encryptionKey nor any plaintext, and its package pulls in no drive/crypto lib.
// No ffmpeg needed. Exits 0 on PASS.
import createTestnet from 'hyperdht/testnet.js'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { makeBlobsKeyEnricher } from '../panel/src/blobs-key.js'
import { panelClient as pubRpc, registerWithPanel } from '../broadcaster/src/register.js'
import { Repeater, parseSelection, selects } from '../repeater/src/index.js'
import { createPlayer } from '../sdk/index.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) } throw new Error('timeout: ' + label) }
async function fetchBuf (port, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
const playlistSegs = (text) => text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

// Distinctive PLAINTEXT marker: must show up in what viewers play, must NEVER show up
// anywhere in the repeater's store (it only ever holds ciphertext).
const MARKER = 'ALIRAN-PLAINTEXT-MARKER::only-key-holders-may-read-this::'

const dirs = {
  panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2erp-panel-')),
  origin: fs.mkdtempSync(path.join(os.tmpdir(), 'e2erp-origin-')),
  repeater: fs.mkdtempSync(path.join(os.tmpdir(), 'e2erp-rep-')),
  viewer1: fs.mkdtempSync(path.join(os.tmpdir(), 'e2erp-v1-')),
  viewer2: fs.mkdtempSync(path.join(os.tmpdir(), 'e2erp-v2-')),
  viewer3: fs.mkdtempSync(path.join(os.tmpdir(), 'e2erp-v3-'))
}
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

// Recursive scan of a directory tree for a byte pattern (keyless proof).
function scanDirFor (dir, patterns) {
  const hits = []
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) { walk(p); continue }
      const buf = fs.readFileSync(p)
      for (const [label, pat] of patterns) if (buf.includes(pat)) hits.push(`${label} in ${p}`)
    }
  }
  walk(dir)
  return hits
}
function dirBytes (dir) {
  let n = 0
  const walk = (d) => { for (const name of fs.readdirSync(d)) { const p = path.join(d, name); const st = fs.statSync(p); st.isDirectory() ? walk(p) : n += st.size } }
  walk(dir)
  return n
}
// Bytes stored for one core in a corestore dir (layout: cores/<id02>/<id24>/<id>,
// id = discoveryKey hex). purge() unlinks the core's files; the empty dir may remain.
function coreDirBytes (root, id) {
  const p = path.join(root, 'cores', id.slice(0, 2), id.slice(2, 4), id)
  return fs.existsSync(p) ? dirBytes(p) : 0
}

try {
  // ===== Selection parsing (pure, no network) =====
  assert.deepStrictEqual(parseSelection('all'), { mode: 'all' })
  assert.deepStrictEqual(parseSelection(''), { mode: 'all' })
  assert.deepStrictEqual(parseSelection('ch1, ch2'), { mode: 'ids', ids: ['ch1', 'ch2'] })
  assert.deepStrictEqual(parseSelection('category:News, Sports'), { mode: 'category', categories: ['news', 'sports'] })
  assert.throws(() => parseSelection('category:'), /category/)
  assert.ok(selects(parseSelection('all'), 'x', {}))
  assert.ok(selects(parseSelection('ch1'), 'ch1', {}) && !selects(parseSelection('ch1'), 'ch2', {}))
  assert.ok(selects(parseSelection('category:news'), 'x', { category: ['News'] }))
  assert.ok(selects(parseSelection('category:news'), 'x', { category: 'news' }))
  assert.ok(!selects(parseSelection('category:news'), 'x', { category: ['shopping'] }))
  assert.throws(() => new Repeater({ panelPubKey: 'nope' }), /panelPubKey/)
  log('selection parsing + matching; constructor validation ✓')

  // ===== Local DHT testnet =====
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap
  log('testnet up:', JSON.stringify(bootstrap))

  // ===== Panel: signed store + register RPC + blobsKey enrichment =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
  const enrich = makeBlobsKeyEnricher({ store: panelStore, swarm: panelSwarm, db, dataDir: dirs.panel })
  cleanups.push(() => enrich.close())
  const throttle = makeThrottle(1000, 60)
  panelSwarm.on('connection', (s) => { panelStore.replicate(s); attachLoginRpc(s, { keys, difficulty: 8, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000, enrich }) })
  const panelTopic = hcrypto.hash(keys.signing.publicKey)
  panelSwarm.join(panelTopic, { server: true, client: false }); await panelSwarm.flush()
  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  log('panel announced on the testnet')

  // ===== Origin broadcaster (synthetic): encrypted live drive, server-only swarm =====
  const encKey = hcrypto.randomBytes(32)
  const encKeyHex = b4a.toString(encKey, 'hex')
  const originStore = new Corestore(dirs.origin); await originStore.ready()
  let originAlive = true
  cleanups.push(async () => { if (originAlive) await originStore.close() })
  let lockdownPub = null // when set, only this swarm identity may stay connected (models a full SWARM_MAX_PEERS budget — gate proven by broadcaster-api Test Q)
  const originSwarm = new Hyperswarm({ bootstrap })
  cleanups.push(async () => { if (originAlive) await originSwarm.destroy() })
  originSwarm.on('connection', (s) => {
    if (lockdownPub && b4a.toString(s.remotePublicKey, 'hex') !== lockdownPub) { s.destroy(); return }
    originStore.replicate(s)
  })
  async function makeFeed (ns) {
    const drive = new Hyperdrive(originStore.namespace(ns), { encryptionKey: encKey })
    await drive.ready()
    originSwarm.join(drive.discoveryKey, { server: true, client: false })
    return drive
  }
  const drive1 = await makeFeed('feed1')
  const feedKey1 = b4a.toString(drive1.key, 'hex')

  // Live ticker: rolling HLS window, one ~24 KB segment (= one blobs block) per tick.
  let seq = 0
  let liveDrive = drive1
  async function appendSegment () {
    const drive = liveDrive
    const i = seq++
    const seg = Buffer.alloc(24000); seg.fill(`${MARKER}#${i}|`)
    await drive.put(`/seg${i}.ts`, seg)
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${Math.max(0, i - 5)}`]
    for (let k = Math.max(0, i - 5); k <= i; k++) lines.push('#EXTINF:0.4,', `seg${k}.ts`)
    await drive.put('/index.m3u8', b4a.from(lines.join('\n') + '\n'))
    if (i - 8 >= 0) { try { await drive.del(`/seg${i - 8}.ts`) } catch {} }
  }
  await appendSegment(); await appendSegment(); await appendSegment()
  let tickBusy = false
  const ticker = setInterval(() => { if (tickBusy || !originAlive) return; tickBusy = true; appendSegment().catch(() => {}).then(() => { tickBusy = false }) }, 400)
  cleanups.push(() => clearInterval(ticker))
  log('origin: live encrypted feed appending every 400 ms')

  // ===== Register ch1 (mirrored) + ch2 (decoy — proves selection) with the panel =====
  const bSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => bSwarm.destroy())
  let pcall = null
  bSwarm.on('connection', (s) => { if (!pcall) pcall = pubRpc(s).call })
  bSwarm.join(panelTopic, { client: true, server: false })
  await waitFor(() => pcall, 30000, 'broadcaster→panel connection')
  const publisherHex = b4a.toString(keys.publisher.secretKey, 'hex')
  await registerWithPanel(pcall, publisherHex, { streamId: 'ch1', feedKey: feedKey1, encryptionKey: encKeyHex, title: 'Channel One', category: ['news'], isLive: true })
  const decoy = new Hyperdrive(originStore.namespace('decoy'), { encryptionKey: encKey }); await decoy.ready() // never announced
  await registerWithPanel(pcall, publisherHex, { streamId: 'ch2', feedKey: b4a.toString(decoy.key, 'hex'), encryptionKey: encKeyHex, title: 'Decoy', category: ['shopping'], isLive: true })
  log('registered ch1 (news) + ch2 decoy (shopping) with the panel')

  // ===== Repeater: keyless, selects ch1 only, short retention for the test =====
  const RETENTION_S = 12
  const repeater = new Repeater({
    panelPubKey,
    dataDir: dirs.repeater,
    channels: 'ch1',
    retentionSeconds: RETENTION_S,
    swarmMaxPeers: 256,
    bootstrap,
    sampleIntervalMs: 500,
    sweepIntervalMs: 1500,
    statusIntervalSeconds: 0
  })
  cleanups.push(() => repeater.close())
  await repeater.start()
  const ch1Status = () => repeater.status().channels.find((c) => c.streamId === 'ch1')

  // Both cores armed — including the blobs core, whose key ONLY arrives via the
  // panel's async catalog enrichment (the repeater upgrades the mirror when it lands).
  await waitFor(() => { const c = ch1Status(); return c && c.cores.db?.armed && c.cores.blobs?.armed ? c : null }, 120000, 'repeater armed db+blobs tails (catalog feedKey + async blobsKey)')
  assert.ok(!repeater.status().channels.find((c) => c.streamId === 'ch2'), 'selection: decoy ch2 must NOT be mirrored')
  const realBlobsKey1 = b4a.toString((await drive1.getBlobs()).core.key, 'hex')
  assert.strictEqual(ch1Status().blobsKey, realBlobsKey1, 'repeater mirrors the REAL blobs core named in the catalog')
  const b0 = ch1Status().cores.blobs.length
  await sleep(2500)
  assert.ok(ch1Status().cores.blobs.length > b0, 'blobs tail follows appends (live mirror)')
  assert.ok(ch1Status().cores.db.length > 0, 'db tail follows appends')
  log('repeater: ch1 mirrored (db+blobs tails live), ch2 correctly ignored ✓')

  // Bounded bee cache budget (uniformity with broadcaster/SDK): the panel catalog bee
  // must link its per-instance caches into the store's ONE bounded globalCache, else
  // they retain ~1.5 KB of heap per replicated catalog append forever. Linked caches
  // read the SAME shared array, so the two synchronous globalSize reads must agree.
  const beeCache = repeater._store.globalCache
  assert.ok(beeCache && beeCache.maxSize > 0, 'repeater store carries a bounded globalCache')
  assert.strictEqual(repeater._bee._nodeCache.keys.globalSize, beeCache.globalSize, 'panel bee caches linked into the shared budget')
  assert.ok(beeCache.globalSize > 0, 'the budget is actually in use (caches linked, not disabled)')
  assert.ok(beeCache.globalSize <= beeCache.maxSize, 'bee cache stays within its bound')
  log('repeater: panel bee caches share the bounded global budget (globalSize ' + beeCache.globalSize + ' <= ' + beeCache.maxSize + ') ✓')

  // ===== (1) viewer plays ENTIRELY off the repeater; origin egress = repeater only =====
  const repeaterPub = repeater.status().swarm.publicKey
  lockdownPub = repeaterPub
  for (const c of [...originSwarm.connections]) { if (b4a.toString(c.remotePublicKey, 'hex') !== repeaterPub) c.destroy() }
  const viewer1 = createPlayer({ storeDir: dirs.viewer1, swarm: { bootstrap } }); cleanups.push(() => viewer1.stop())
  const port1 = await viewer1.serveFeed(feedKey1, encKeyHex)
  const pl1 = (await fetchBuf(port1, '/index.m3u8')).toString()
  assert.ok(pl1.startsWith('#EXTM3U'), 'viewer serves the playlist')
  await sleep(2500)
  const pl2 = (await fetchBuf(port1, '/index.m3u8')).toString()
  assert.notStrictEqual(pl2, pl1, 'playlist ADVANCES for the viewer (live edge flows through the repeater)')
  const newest = playlistSegs(pl2).pop()
  const segBody = await fetchBuf(port1, '/' + newest)
  assert.ok(segBody.includes(MARKER), 'viewer decrypts real segment plaintext (served via the repeater)')
  // Byte counters, both sides:
  const originConns = [...originSwarm.connections].map((c) => ({ pub: b4a.toString(c.remotePublicKey, 'hex'), tx: c.rawStream.bytesTransmitted }))
  assert.ok(originConns.length >= 1, 'origin still serves someone (the repeater)')
  for (const c of originConns) {
    assert.strictEqual(c.pub, repeaterPub, 'origin egress goes ONLY to the repeater — zero connections to the viewer')
    assert.strictEqual(typeof c.tx, 'number')
  }
  assert.ok(originConns.reduce((a, c) => a + c.tx, 0) > 100000, 'origin→repeater: ~one stream flowing')
  let fromRepeater = 0; let fromOrigin = 0
  for (const c of viewer1._swarm.connections) {
    const pub = b4a.toString(c.remotePublicKey, 'hex')
    const rx = c.rawStream.bytesReceived
    if (pub === repeaterPub) fromRepeater += rx
    else fromOrigin += rx
  }
  assert.ok(fromRepeater > 100000, `viewer received its media from the repeater (${fromRepeater} bytes)`)
  assert.ok(fromOrigin < 5000, `viewer received ~nothing from anyone else (${fromOrigin} bytes)`)
  log(`(1) viewer plays off the repeater ✓  origin egress→repeater only; viewer rx from repeater ${fromRepeater} B, from others ${fromOrigin} B`)

  // ===== (3) feedKey rotation → repeater re-points unattended, old cores purged =====
  lockdownPub = null // the panel's enrichment probe must reach the origin again
  const oldDbDiscovery = b4a.toString(hcrypto.discoveryKey(b4a.from(feedKey1, 'hex')), 'hex')
  assert.ok(coreDirBytes(dirs.repeater, oldDbDiscovery) > 0, 'sanity: old db core present in the repeater store before rotation')
  const drive2 = await makeFeed('feed2')
  const feedKey2 = b4a.toString(drive2.key, 'hex')
  liveDrive = drive2
  await appendSegment() // header + first content exist before (and independent of) registration
  await registerWithPanel(pcall, publisherHex, { streamId: 'ch1', feedKey: feedKey2, encryptionKey: encKeyHex, isLive: true })
  log('rotated ch1 to a NEW feedKey (source-change pattern); waiting for the repeater to follow the catalog…')
  await waitFor(() => { const c = ch1Status(); return c && c.feedKey === feedKey2 && c.cores.blobs?.armed ? c : null }, 120000, 'repeater re-pointed to the rotated feed (new blobsKey enriched + mirrored)')
  const realBlobsKey2 = b4a.toString((await drive2.getBlobs()).core.key, 'hex')
  assert.strictEqual(ch1Status().blobsKey, realBlobsKey2, 'repeater follows the NEW blobs core')
  const rb0 = ch1Status().cores.blobs.length
  await sleep(2000)
  assert.ok(ch1Status().cores.blobs.length > rb0, 'rotated feed is live-mirrored')
  await waitFor(() => coreDirBytes(dirs.repeater, oldDbDiscovery) === 0, 30000, 'old db core PURGED from the repeater store')
  log('(3) rotation followed unattended; old cores purged from disk ✓')

  // ===== (4) retention: bounded window, cleared blocks stay cleared =====
  const tail = repeater._mirrors.get('ch1').tails.get('blobs')
  const armBase = tail.clearedUpTo
  await waitFor(() => tail.clearedUpTo > armBase, RETENTION_S * 1000 + 20000, 'retention watermark advances (clear() running)')
  const clearedIdx = tail.clearedUpTo - 1
  assert.ok(!(await tail.core.has(clearedIdx)), 'expired block is gone from the store')
  await sleep(3500) // two+ sweeps — a clear/re-download loop would re-fetch it
  assert.ok(!(await tail.core.has(clearedIdx)), 'cleared block STAYS cleared across sweeps (no re-download loop)')
  // ~2.5 blocks/s appended; bound = retention window in blocks with generous slack.
  const dbTail = repeater._mirrors.get('ch1').tails.get('db')
  for (let i = 0; i < 3; i++) {
    const heldBlobs = tail.core.length - tail.clearedUpTo
    const heldDb = dbTail.core.length - dbTail.clearedUpTo
    assert.ok(heldBlobs < 90, `blobs window bounded (held ${heldBlobs} blocks)`)
    assert.ok(heldDb < 220, `db window bounded (held ${heldDb} blocks)`)
    await sleep(2000)
  }
  log(`(4) retention holds: blobs held ${tail.core.length - tail.clearedUpTo} blocks (@length ${tail.core.length}), cleared stay cleared ✓`)

  // ===== (2) origin dies mid-play → the buffered window plays off the repeater =====
  const viewer2 = createPlayer({ storeDir: dirs.viewer2, swarm: { bootstrap } }); cleanups.push(() => viewer2.stop())
  const port2 = await viewer2.serveFeed(feedKey2, encKeyHex)
  assert.ok((await fetchBuf(port2, '/index.m3u8')).toString().startsWith('#EXTM3U'), 'viewer2 tuned while the origin is up')
  clearInterval(ticker)
  originAlive = false
  await originSwarm.destroy()
  await originStore.close()
  log('origin KILLED mid-play; the repeater holds the last window')
  const plFrozen = (await fetchBuf(port2, '/index.m3u8')).toString()
  const lastSeg = playlistSegs(plFrozen).pop()
  assert.ok((await fetchBuf(port2, '/' + lastSeg)).includes(MARKER), 'viewer2 keeps playing the buffered window (origin gone)')
  // The strongest form: a COLD viewer that never exchanged a byte with the origin.
  const viewer3 = createPlayer({ storeDir: dirs.viewer3, swarm: { bootstrap } }); cleanups.push(() => viewer3.stop())
  const port3 = await viewer3.serveFeed(feedKey2, encKeyHex)
  const pl3 = (await fetchBuf(port3, '/index.m3u8')).toString()
  const seg3 = playlistSegs(pl3).pop()
  assert.ok((await fetchBuf(port3, '/' + seg3)).includes(MARKER), 'a COLD viewer tunes and plays entirely off the repeater')
  log('(2) buffered window survives origin death — warm viewer keeps playing, cold viewer tunes fresh ✓')

  // ===== (5) keyless proof: no encryptionKey, no plaintext, anywhere on the box =====
  const statusSnapshot = JSON.stringify(repeater.status())
  const configSnapshot = JSON.stringify(repeater.config)
  assert.ok(!statusSnapshot.includes(encKeyHex) && !configSnapshot.includes(encKeyHex), 'repeater config/status never see the encryptionKey')
  assert.ok(!/encryptionKey/i.test(statusSnapshot + configSnapshot), 'repeater config/status have no encryptionKey field at all')
  await viewer1.stop(); await viewer2.stop(); await viewer3.stop()
  await repeater.close() // release handles before scanning the store (Windows)
  const stored = dirBytes(dirs.repeater)
  assert.ok(stored > 100000, `positive control: the repeater DOES hold mirrored data (${stored} bytes on disk)`)
  const hits = scanDirFor(dirs.repeater, [
    ['encryptionKey (raw bytes)', encKey],
    ['encryptionKey (hex text)', Buffer.from(encKeyHex)],
    ['segment plaintext', Buffer.from(MARKER)]
  ])
  assert.deepStrictEqual(hits, [], 'repeater store holds CIPHERTEXT ONLY — no key material, no plaintext: ' + hits.join('; '))
  const repPkg = JSON.parse(fs.readFileSync(new URL('../repeater/package.json', import.meta.url), 'utf8'))
  for (const banned of ['hyperdrive', '@aliran/core', 'sodium-native']) {
    assert.ok(!repPkg.dependencies[banned], `repeater package must not depend on ${banned}`)
  }
  log(`(5) keyless proven: ${stored} B of ciphertext on disk, zero key/plaintext hits; no drive/crypto deps ✓`)

  log('\nRESULT: PASS ✅  (fan-out off the origin → origin-death window → unattended rotation → bounded retention → ciphertext-only box)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
