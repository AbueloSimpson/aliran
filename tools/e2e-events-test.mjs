// Ephemeral event channels — a feed, not a ledger (S57). npm run test:events
//
// THE CLAIM UNDER TEST. An `ephemeral` source's sync appends NOTHING to the panel's signed
// Hyperbee. That is the whole feature: the bee is append-only and unreclaimable
// (docs/kb/panel-bee-compaction.md), so ~550 event channels churning every 30 minutes cost
// 200-660 MB/day that nothing can ever give back. The lineup moves to a Hyperdrive, where a
// superseded revision really is freed.
//
// Blocks alone cannot prove it — a count could hold while bytes grew — so the headline is
// asserted on `core.length` AND `core.byteLength` together, across syncs that replace the
// ENTIRE lineup (the steady state, not a quiet one).
//
// Deterministic and local-only: a private DHT testnet for the keyless-mirror and EPG legs,
// a loopback HTTP feed server, temp dirs, no ffmpeg, no public swarm.
//
// Also covered: the default-OFF promise (a panel with no ephemeral source writes no
// pointer, mints no drive and opens no core); the flip, which purges the catalog ONCE and
// then costs zero; a quiet re-sync appending nothing to the DRIVE either; superseded
// revisions cleared AND deleted with the allocation coming back; epoch rotation bounding
// the drive's own metadata bee without orphaning a queued epoch; meta/eventsKey carrying
// both keys so a keyless reader can mirror; user.eventSources gating shards; and the three
// integrations — the EPG guide mapping, package selectors, and the autoIds carve-out that
// stops the flag flip stripping every viewer's entitlement in one pass.
import http from 'http'
import os from 'os'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import hcrypto from 'hypercore-crypto'
import createTestnet from 'hyperdht/testnet.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, loadSecrets, reclaimStrayCores } from '../panel/src/store.js'
import { makeRing } from '../panel/src/activity.js'
import * as ops from '../panel/src/ops.js'
import * as sources from '../panel/src/sources.js'
import * as packages from '../panel/src/packages.js'
import { makeLivenessProber } from '../panel/src/liveness.js'
import { GuideManager } from '../epg/src/guide.js'

const log = (...a) => console.log(...a)
const KiB = 1024
const MiB = 1024 * KiB
const fmt = (n) => (n === null || n === undefined ? 'n/a' : (n / MiB).toFixed(3) + ' MiB')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(120) }
  throw new Error('timeout: ' + label)
}

let failures = 0
function ok (cond, msg) {
  if (cond) log('  ok  ' + msg)
  else { failures++; log('  FAIL ' + msg) }
}

// --- measurement -------------------------------------------------------------------------

// Allocated bytes of a core's block store — NOT the file size. clear() punches holes, so
// `data` keeps its apparent length while its allocation drops (epg-reclaim-test's argument).
async function allocatedBlobBytes (drive) {
  const blobs = await drive.getBlobs()
  const info = await blobs.core.info({ storage: true })
  return info.storage ? info.storage.blocks : null
}

async function heldBlocks (drive) {
  const blobs = await drive.getBlobs()
  let n = 0
  for (let i = 0; i < blobs.core.length; i++) if (await blobs.core.has(i)) n++
  return n
}

// Corestore v6 lays each core out at cores/<dk[0:2]>/<dk[2:4]>/<dk>/ keyed by DISCOVERY key.
// purge() removes the directory outright, so this is how a retired epoch proves it is really
// gone rather than merely unreferenced.
function coreDir (dataDir, publicKeyHex) {
  const dk = b4a.toString(hcrypto.discoveryKey(b4a.from(publicKeyHex, 'hex')), 'hex')
  return path.join(dataDir, 'cores', dk.slice(0, 2), dk.slice(2, 4), dk)
}

// Can this filesystem show a reclaim at all? Where it cannot, the byte figures are REPORTED
// and the bitfield assertions carry the lane — the same honesty gate epg-reclaim-test uses.
async function probePunch () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evreclaim-probe-'))
  try {
    const store = new Corestore(path.join(dir, 'store'))
    await store.ready()
    const core = store.get({ name: 'probe' })
    await core.ready()
    for (let i = 0; i < 32; i++) await core.append(Buffer.alloc(64 * KiB, i))
    const before = (await core.info({ storage: true })).storage?.blocks ?? null
    await core.clear(0, 16)
    const after = (await core.info({ storage: true })).storage?.blocks ?? null
    await store.close()
    return before !== null && after !== null && after < before
  } catch { return false } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
}

// --- fixtures ----------------------------------------------------------------------------

const CHANNELS = 400 // enough shard bytes to span several hyperblobs blocks, so a reclaim is measurable

// One generation of an event playlist. `gen` changes every NAME, which changes every slugged
// id — the real steady state of a sports list, where the whole lineup turns over.
function playlist (gen, { n = CHANNELS } = {}) {
  const out = ['#EXTM3U url-tvg="https://prov.example/guide.xml"']
  for (let i = 0; i < n; i++) {
    const name = `[MLB] Generation ${gen} match ${i} — ${'Home Team '.repeat(3)}at ${'Away Team '.repeat(3)}`
    out.push(`#EXTINF:-1 tvg-id="ev-${gen}-${i}" tvg-logo="https://prov.example/${i}.png" group-title="Live Events",${name}`)
    out.push('#EXTVLCOPT:http-referrer=https://prov.example/')
    out.push(`https://cdn.example/live/${gen}/${i}.m3u8?token=t${gen}`)
  }
  return out.join('\n') + '\n'
}

const dirs = []
function mkdir (prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d }
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

const config = {
  argon2: { memKiB: 8192, time: 1 }, // argonOpts clamps to the sodium minimums
  maxDevicesDefault: 2,
  sources: { maxChannels: 1000, fetchTimeoutMs: 5000, maxBytes: 8 * MiB }
}

async function openPanel (prefix, opts = {}) {
  const dir = mkdir(prefix)
  initKeys(dir)
  const keys = openKeys(dir)
  const { store, db, core, assets, updates, events } = await openStore(dir, keys, opts)
  cleanups.push(async () => { try { await events.close() } catch {}; try { await store.close() } catch {} })
  const ctx = { config, keys, db, assets, updates, events, dataDir: dir, activity: makeRing(200) }
  return { dir, keys, store, db, core, assets, updates, events, ctx }
}

const beeSize = (core) => ({ length: core.length, byteLength: core.byteLength })

// The testnet is created in leg F (the first leg that needs the DHT at all) and reused by
// leg H; everything before it runs with no swarm whatsoever.
let bootstrap = []

// ---- the feed server --------------------------------------------------------------------
const bodies = { '/events.m3u': playlist(1), '/other.m3u': playlist(1, { n: 8 }) }
let rev = 1
const srv = http.createServer((req, res) => {
  const p = req.url.split('?')[0]
  const body = bodies[p]
  if (body == null) { res.writeHead(404); res.end(); return }
  const etag = `"v${rev}"`
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return }
  res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': Buffer.byteLength(body), etag })
  res.end(body)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
cleanups.push(() => new Promise((r) => srv.close(r)))
const feedBase = `http://127.0.0.1:${srv.address().port}`

try {
  const punch = await probePunch()
  log(`hole-punch reclaim observable on this filesystem: ${punch ? 'YES — byte assertions are hard' : 'NO — byte figures reported, bitfield assertions carry the lane'}`)

  // ===== A. DEFAULT OFF: a panel with no ephemeral source is untouched ====================
  log('\nA. nothing is created, advertised or opened until a source asks for it')
  {
    const p = await openPanel('e2eevt-off-')
    ok(p.events.enabled === false, 'the events manager boots INERT')
    ok(p.events.driveInfo() === null, 'and advertises no drive')
    await ops.createUser(p.ctx, 'alice', 'alice-secret-1')
    sources.addSource(p.ctx, 'ordinary', { url: feedBase + '/events.m3u', format: 'm3u', category: 'Live Events', prefix: 'ord.' })
    ok(sources.loadSources(p.dir).ordinary.ephemeral === false, 'ephemeral defaults to false on the registry record')
    const r = await sources.syncSource(p.ctx, 'ordinary')
    ok(r.added === CHANNELS, `an ordinary source still imports into the CATALOG (${r.added} added)`)
    ok(r.granted === CHANNELS, "and still auto-grants every channel — today's behaviour, untouched")
    ok(Object.keys(loadSecrets(p.dir)).length === CHANNELS, 'every channel still minted a stream secret')
    ok((await p.db.get('meta/eventsKey')) === null, 'NO meta/eventsKey record was written')
    ok(!fs.existsSync(path.join(p.dir, 'events-epoch.json')), 'no events-epoch.json on disk')
    ok(p.events.enabled === false, 'and still no drive after a full sync')
    const u = (await p.db.get('user/alice')).value
    ok(u.eventSources === undefined, 'a user record never grows eventSources on a deployment with no ephemeral source')
    ok(Object.keys(u.wrapped).length === CHANNELS, 'and keeps every sealed grant')

    // The flip, from the other side: the SAME source, now ephemeral.
    const before = beeSize(p.core)
    sources.setSource(p.ctx, 'ordinary', { ephemeral: true })
    const flip = await sources.syncSource(p.ctx, 'ordinary')
    ok(flip.catalogPurged === CHANNELS, `the flip retires every catalog record ONCE (${flip.catalogPurged} purged)`)
    ok(flip.published === CHANNELS, 'and republishes the same lineup onto the drive')
    let left = 0
    for await (const { value } of p.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) if (value?.source === 'ordinary') left++
    ok(left === 0, 'nothing of that source is left in the catalog')
    ok(Object.keys(loadSecrets(p.dir)).length === 0, 'and its stream secrets are gone with it')
    ok(p.core.length > before.length, `the flip DOES cost the bee — ${p.core.length - before.length} block(s), ONCE (this is the price of the door)`)

    // …and from here it is free. A whole new generation of events, zero blocks.
    bodies['/events.m3u'] = playlist(2); rev++
    const settled = beeSize(p.core)
    const r2 = await sources.syncSource(p.ctx, 'ordinary')
    ok(r2.added === CHANNELS && r2.removed === CHANNELS, 'the next sync replaces the ENTIRE lineup')
    ok(p.core.length === settled.length && p.core.byteLength === settled.byteLength,
      `and appends nothing at all (length ${settled.length} -> ${p.core.length}, byteLength ${settled.byteLength} -> ${p.core.byteLength})`)
  }

  // ===== B. THE HEADLINE: a full ephemeral sync appends 0 blocks AND 0 bytes ==============
  log('\nB. a full sync of an ephemeral source costs the signed bee exactly nothing')
  const panel = await openPanel('e2eevt-main-')
  const { ctx, db, core, events, dir } = panel
  {
    bodies['/events.m3u'] = playlist(3); rev++
    sources.addSource(ctx, 'live-events', { url: feedBase + '/events.m3u', format: 'm3u', category: 'Live Events', prefix: 'ev.', ephemeral: true })
    sources.addSource(ctx, 'pay-events', { url: feedBase + '/other.m3u', format: 'm3u', category: 'PPV', prefix: 'pay.', ephemeral: true, autoGrant: false })
    for (const u of ['alice', 'bob']) await ops.createUser(ctx, u, u + '-secret-1')
    await sources.syncSource(ctx, 'live-events')
    await sources.syncSource(ctx, 'pay-events')

    // Everything above has converged: the drive exists, the pointer is written, every user
    // record carries its eventSources. THIS is the steady state a live deployment sits in.
    const before = beeSize(core)
    for (const gen of [4, 5, 6]) {
      bodies['/events.m3u'] = playlist(gen); rev++
      const r = await sources.syncSource(ctx, 'live-events')
      ok(r.added === CHANNELS && r.removed === CHANNELS, `generation ${gen}: the whole ${CHANNELS}-channel lineup turned over`)
      ok(r.granted === 0, 'reconcileGrants never ran — there is nothing to seal')
    }
    const after = beeSize(core)
    ok(after.length === before.length,
      `THE HEADLINE — three full lineup replacements appended 0 blocks (core.length ${before.length} -> ${after.length})`)
    ok(after.byteLength === before.byteLength,
      `…and 0 BYTES (core.byteLength ${before.byteLength} -> ${after.byteLength}; a block count alone would pass while bytes grew)`)
    let cat = 0
    for await (const { value } of db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) if (value?.source) cat++
    ok(cat === 0, 'no catalog record was ever written for an ephemeral source')
    ok(Object.keys(loadSecrets(dir)).length === 0, 'no stream secret was ever minted')
    ok(Object.keys((await db.get('user/alice')).value.wrapped).length === 0, 'no sealed grant was ever written')
    ok(events.snapshot().size === CHANNELS + 8, `the drive carries the whole lineup instead (${events.snapshot().size} entries across 2 sources)`)
  }

  // ===== C. a quiet cycle costs the DRIVE nothing either ==================================
  log('\nC. an unchanged feed appends nothing to the drive')
  {
    const drive = events._drive
    const metaBefore = drive.core.length
    const blobsBefore = (await drive.getBlobs()).core.length
    const skipsBefore = events.status().skips
    const revBefore = events.status().rev
    // A fresh 200 with a BYTE-IDENTICAL body: the panel really re-reads and re-maps, so this
    // exercises the byte-compare rather than the ETag short-circuit above it.
    rev++
    const r = await sources.syncSource(ctx, 'live-events')
    ok(r.notModified !== true, 'the feed really was re-fetched and re-mapped (not a 304)')
    ok(r.driveChanged === false, 'the publish short-circuited on the byte-compare')
    ok(events.status().skips === skipsBefore + 1, 'and counted as a skip')
    ok(events.status().rev === revBefore, 'the revision counter did not move')
    ok(drive.core.length === metaBefore, `the drive's metadata bee is unchanged (${metaBefore} blocks)`)
    ok((await drive.getBlobs()).core.length === blobsBefore, `and its blobs core is unchanged (${blobsBefore} blocks)`)
  }

  // ===== D. superseded revisions are cleared AND deleted, and the bytes come back =========
  log('\nD. a superseded revision is clear()ed then del()eted — the allocation drops')
  {
    const drive = events._drive
    let lastShard = events._shards.get('live-events').shard
    const shardBytes = (await drive.get(lastShard)).byteLength
    const shardBlocks = (await drive.entry(lastShard)).value.blob.blockLength
    const beforeBytes = await allocatedBlobBytes(drive)
    const beforeHeld = await heldBlocks(drive)
    for (const gen of [7, 8, 9, 10, 11]) {
      bodies['/events.m3u'] = playlist(gen); rev++
      await sources.syncSource(ctx, 'live-events')
      ok((await drive.entry(lastShard)) === null, `the superseded ${path.basename(lastShard)} no longer resolves (del)`)
      lastShard = events._shards.get('live-events').shard
    }
    const afterBytes = await allocatedBlobBytes(drive)
    const afterHeld = await heldBlocks(drive)
    // ⚠ THE BITFIELD ASSERTION IS THE ONE THAT CARRIES THIS LANE, and the byte one is the
    // weaker of the two — do not "simplify" to bytes alone. `info({storage:true})` has been
    // observed reporting `storage.blocks === 0` while five blocks were held and readable
    // (the allocation is a filesystem reading and depends on hole-punch support, sparse
    // accounting and timing), so a byte-only lane can pass while nothing was ever freed.
    log(`  …  one shard is ${(shardBytes / KiB).toFixed(0)} KiB / ${shardBlocks} block(s); allocation ${fmt(beforeBytes)} -> ${fmt(afterBytes)} across 5 full replacements, held blocks ${beforeHeld} -> ${afterHeld}`)
    ok((await drive.get(lastShard)) !== null, 'the live revision still reads back')
    // THE regression assertion. Under a del()-only implementation this grows by one whole
    // shard per replacement; with clear() first it grows by roughly nothing.
    ok(afterHeld <= beforeHeld + shardBlocks,
      `held blocks did not accumulate five superseded shards (${beforeHeld} -> ${afterHeld}; five stranded copies would be ~${beforeHeld + shardBlocks * 5})`)
    if (punch) {
      ok(afterBytes - beforeBytes <= shardBytes * 1.5,
        `allocated bytes did not accumulate them either (grew ${fmt(afterBytes - beforeBytes)}; five stranded copies would be ~${fmt(shardBytes * 5)})`)
    } else {
      log(`  …  (byte assertion reported, not asserted: no observable hole-punch; grew ${fmt(afterBytes - beforeBytes)} where five stranded copies would be ~${fmt(shardBytes * 5)})`)
    }
    // …and a dropped SOURCE takes its shard with it, entry and bytes together.
    const payShard = events._shards.get('pay-events').shard
    await events.dropSource('pay-events')
    ok((await drive.entry(payShard)) === null, 'dropSource deleted the shard entry')
    const idx = JSON.parse(b4a.toString(await drive.get('/v1/index.json')))
    ok(!idx.sources.some((s) => s.name === 'pay-events'), 'and removed it from the index')
    rev++
    await sources.syncSource(ctx, 'pay-events') // put it back for the entitlement leg below
  }

  // ===== E. epoch rotation bounds the drive's own bee, and orphans nothing ================
  log('\nE. rotation bounds the metadata bee; a queued epoch is never discarded')
  {
    const grownBee = events._drive.core.length
    const e1 = events.driveInfo().key
    await events.rotate()
    const e2 = events.driveInfo().key
    ok(events.status().epoch === 2, 'epoch 2 is live')
    ok(events._drive.core.length < grownBee,
      `the fresh epoch's metadata bee is a fraction of the retired one (${events._drive.core.length} vs ${grownBee} blocks) — this is what rotation is FOR`)
    ok(events.status().pendingPurge === 1, 'epoch 1 is queued for purge, inside its grace window')
    ok((await events._drive.get('/v1/index.json')) !== null, 'the index was copied into the new epoch')
    ok(events.snapshot().size > 0, 'and the lineup survived the flip')
    ok((await db.get('meta/eventsKey')).value.key === e2, 'meta/eventsKey now names epoch 2')

    // ⚠ THE ORPHAN CASE. Rotate AGAIN while epoch 1 is still owed a purge. A single `prev`
    // slot discards it here, and a discarded epoch is unreachable forever: nothing names it,
    // so no code path can ever purge it and its drive sits on disk for the life of the box.
    ok(fs.existsSync(coreDir(dir, e1)), 'epoch 1 is still on disk at this point')
    await events.rotate()
    const e3 = events.driveInfo().key
    ok(events.status().pendingPurge === 2, `both retired epochs are queued (pendingPurge ${events.status().pendingPurge})`)
    ok(events._state.pending.map((p) => p.epoch).join(',') === '1,2', 'the queue is oldest-first and COMPLETE — epoch 1 was not discarded')

    for (const p of events._state.pending) p.purgeAt = Date.now() - 1000
    await events.maintain()
    ok(events._state.pending.length === 0, 'one maintenance tick drained the queue')
    ok(!fs.existsSync(coreDir(dir, e1)), 'epoch 1 — the one a single `prev` slot would have forgotten — is GONE from disk')
    ok(!fs.existsSync(coreDir(dir, e2)), 'epoch 2 is gone from disk')
    ok(fs.existsSync(coreDir(dir, e3)), 'the live epoch is untouched')
    const idx = JSON.parse(b4a.toString(await events._drive.get('/v1/index.json')))
    ok(idx.sources.length === 2 && idx.sources.every((s) => s.count > 0), 'and it still serves the whole index')
    bodies['/events.m3u'] = playlist(12); rev++
    const r = await sources.syncSource(ctx, 'live-events')
    ok(r.driveChanged === true && r.published === CHANNELS, 'a sync into the rotated epoch publishes normally')
  }

  // ===== F. the wire format, and a KEYLESS reader mirroring from the pointer ==============
  log('\nF. meta/eventsKey carries { key, blobsKey } and is enough to mirror the drive')
  {
    const pointer = (await db.get('meta/eventsKey')).value
    ok(/^[0-9a-f]{64}$/.test(pointer.key || ''), 'meta/eventsKey.key is a 64-hex drive key')
    ok(/^[0-9a-f]{64}$/.test(pointer.blobsKey || ''), 'meta/eventsKey.blobsKey rides the record (the keyless-repeater half)')
    ok(pointer.blobsKey === b4a.toString((await events._drive.getBlobs()).core.key, 'hex'), "and it really is this drive's blobs core")

    const idx = JSON.parse(b4a.toString(await events._drive.get('/v1/index.json')))
    ok(Number.isInteger(idx.rev) && typeof idx.updatedAt === 'number' && Array.isArray(idx.sources), '/v1/index.json is { rev, updatedAt, sources[] }')
    const entryIdx = idx.sources.find((s) => s.name === 'live-events')
    ok(entryIdx && /^\/v1\/live-events-\d+\.json$/.test(entryIdx.shard) && entryIdx.count === CHANNELS,
      `the index names each source's shard and count (${JSON.stringify(entryIdx)})`)
    const list = JSON.parse(b4a.toString(await events._drive.get(entryIdx.shard)))
    ok(Array.isArray(list) && list.length === CHANNELS, 'the shard is a bare array of entries')
    const e = list[0]
    for (const f of ['id', 'title', 'description', 'category', 'type', 'protection', 'feedKey', 'redirect', 'url', 'headers', 'isLive', 'logo', 'order', 'restricted', 'status', 'source', 'epgUrl', 'epgId', 'startsAt', 'endsAt']) {
      ok(Object.prototype.hasOwnProperty.call(e, f), `entry carries \`${f}\``)
    }
    ok(e.redirect === true && e.url.startsWith('https://cdn.example/'), 'a redirect entry resolves to its provider url')
    ok(e.headers && e.headers.referer === 'https://prov.example/', 'playback headers ride the entry')
    ok(e.protection === 'none', "protection is 'none' — an ephemeral channel has no minted stream key to seal")
    ok(e.category[0] === 'Live Events' && e.type === 'live' && e.status === 'live', 'and the rest is the catalog record shape a client already renders')

    // A KEYLESS reader: nothing but the two hex strings out of the signed bee.
    const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
    bootstrap = testnet.bootstrap
    const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
    panelSwarm.on('connection', (s) => panel.store.replicate(s))
    panelSwarm.join(hcrypto.hash(panel.keys.signing.publicKey), { server: true, client: false })
    await panelSwarm.flush()

    const mirrorDir = mkdir('e2eevt-mirror-')
    const mstore = new Corestore(mirrorDir); await mstore.ready(); cleanups.push(() => mstore.close())
    const mswarm = new Hyperswarm({ bootstrap }); cleanups.push(() => mswarm.destroy())
    mswarm.on('connection', (s) => mstore.replicate(s))
    mswarm.join(hcrypto.hash(panel.keys.signing.publicKey), { client: true, server: false })
    const mirror = new Hyperdrive(mstore.namespace('ev'), b4a.from(pointer.key, 'hex'))
    await mirror.ready()
    await waitFor(async () => { await mirror.core.update({ wait: true }).catch(() => {}); return mirror.core.length > 0 }, 30000, 'mirror replicated the metadata core')
    const mIdx = JSON.parse(b4a.toString(await mirror.get('/v1/index.json')))
    ok(mIdx.rev === idx.rev, `a keyless reader opened the drive from meta/eventsKey.key alone (rev ${mIdx.rev})`)
    const mList = JSON.parse(b4a.toString(await mirror.get(mIdx.sources.find((s) => s.name === 'live-events').shard)))
    ok(mList.length === CHANNELS, 'and read the whole shard through it')
    // The RAW half, which is what blobsKey is for: a repeater mirrors the shard bytes as
    // blind blocks, hyperdrive-free, holding no key but the two in the pointer record.
    const rawBlobs = mstore.get({ key: b4a.from(pointer.blobsKey, 'hex') })
    await rawBlobs.ready()
    await waitFor(async () => { await rawBlobs.update({ wait: true }).catch(() => {}); return rawBlobs.length > 0 }, 30000, 'raw blobs core length')
    ok(rawBlobs.length > 0, `blobsKey opens the blobs core directly for a raw mirror (${rawBlobs.length} blocks)`)
  }

  // ===== G. entitlement: user.eventSources, not a grant map ===============================
  log('\nG. eventSources names the shards a viewer may read; a record without it is untouched')
  {
    const before = beeSize(core)
    let alice = (await db.get('user/alice')).value
    ok(Array.isArray(alice.eventSources) && alice.eventSources.join(',') === 'live-events',
      `an autoGrant ephemeral source covers everyone (${JSON.stringify(alice.eventSources)}); the autoGrant:false one does not`)
    ok(Object.keys(alice.wrapped).length === 0, 'and it costs zero sealed keys')
    ok(JSON.stringify(alice.eventSources).length < 220, `the whole entitlement is ${JSON.stringify(alice.eventSources).length} bytes, not a sealed key per channel`)

    await packages.addPackage(ctx, 'ppv', { label: 'PPV', members: 'source:pay-events' })
    await packages.setUserPackages(ctx, 'alice', ['ppv'])
    alice = (await db.get('user/alice')).value
    ok(alice.eventSources.join(',') === 'live-events,pay-events', 'a bouquet naming an ephemeral source adds it')
    ok((await db.get('user/bob')).value.eventSources.join(',') === 'live-events', 'and bob, who does not hold it, is unaffected')
    ok(Object.keys(alice.wrapped).length === 0, 'still nothing sealed — this is an ACL, not cryptography')

    // Converged: a full reconcile now writes nothing, which is what makes it safe to run on
    // EVERY sync.
    const settled = beeSize(core)
    const rec = await packages.reconcilePackages(ctx)
    ok(rec.users === 0 && core.length === settled.length && core.byteLength === settled.byteLength,
      'a converged reconcile writes no user record at all')
    await packages.setUserPackages(ctx, 'alice', [])
    ok((await db.get('user/alice')).value.eventSources.join(',') === 'live-events', 'unassigning the bouquet removes the source again')
    log(`  …  the whole entitlement dance cost ${core.length - before.length} block(s); a sealed key per event would have cost hundreds`)

    // A record written by an older build — no eventSources at all — must survive a reconcile
    // with its grants intact.
    const legacy = (await db.get('user/bob')).value
    delete legacy.eventSources
    legacy.wrapped['manual-ch'] = 'x'.repeat(64)
    legacy.manualGrants = ['manual-ch']
    await db.put('user/bob', legacy)
    await packages.reconcilePackages(ctx)
    const bob = (await db.get('user/bob')).value
    ok(bob.wrapped['manual-ch'] === 'x'.repeat(64), 'a pre-existing record keeps its manual grant')
    ok(bob.eventSources.join(',') === 'live-events', 'and converges to the same derived list')
  }

  // ===== H. the three integrations ========================================================
  log('\nH. package selectors, the autoIds carve-out, and the EPG guide mapping')
  {
    // 1. `source:` and `category:` selectors must not silently resolve to empty.
    const pay = await packages.getPackage(ctx, 'ppv')
    ok(pay.resolved.length === 8 && pay.resolved.every((id) => id.startsWith('pay.')),
      `a source: selector on an EPHEMERAL source resolves non-empty (${pay.resolved.length} ids)`)
    await packages.addPackage(ctx, 'rails', { members: 'category:Live Events' })
    const rails = await packages.getPackage(ctx, 'rails')
    ok(rails.resolved.length === CHANNELS, `a category: selector reaches the drive's rails too (${rails.resolved.length} ids)`)
    ok((await packages.listPackages(ctx)).find((p) => p.name === 'ppv').resolved.length === 8, 'and the listing agrees with the single-package read')

    // 2. ⚠ the carve-out must COVER an ephemeral source's ids — by IDENTITY. A wrapped entry
    // for a channel the drive really publishes has no catalog record to justify it, so
    // without the carve-out the very next reconcile strips it, emptying the events lineup of
    // every client still reading `wrapped` in one pass with no feed change to explain it.
    const publishedId = [...events.snapshot().keys()].find((id) => id.startsWith('ev.'))
    const survivor = (await db.get('user/bob')).value
    survivor.wrapped[publishedId] = 'y'.repeat(64)
    await db.put('user/bob', survivor)
    await packages.reconcilePackages(ctx)
    const after = (await db.get('user/bob')).value
    ok(after.wrapped[publishedId] === 'y'.repeat(64), 'a grant for a channel the drive PUBLISHES is carved out, not churned away')
    ok(!after.manualGrants.includes(publishedId), 'and it is not misattributed as a hand-grant either')

    // 3. The EPG service maps epgId -> streamId off the catalog. Ephemeral channels are not
    // in the catalog, so without the drive-side pass the guide goes blind to exactly the
    // lineup an operator most often turns a guide on for.
    sources.setSource(ctx, 'live-events', { epg: true })
    bodies['/events.m3u'] = playlist(13); rev++
    await sources.syncSource(ctx, 'live-events')
    const withGuide = [...events.snapshot().values()].find((e) => e.source === 'live-events' && e.epgId)
    ok(!!withGuide, `the shard carries per-entry guide ids when the source takes them (epgId ${withGuide?.epgId})`)
    await ops.addStream(ctx, 'manual-news', { epgId: 'catalog-guide-id' }) // the catalog half must keep working

    const guide = await new GuideManager({
      dataDir: mkdir('e2eevt-guide-'),
      panelPubKey: b4a.toString(panel.keys.signing.publicKey, 'hex'),
      epochDays: 9999,
      graceHours: 1,
      guideDays: 7,
      eventsRefreshMinutes: 0, // driven explicitly here; the interval is exercised in production
      swarmMaxPeers: 8,
      swarmRcvBuf: 4 * MiB,
      swarmSndBuf: 4 * MiB,
      bootstrap
    }).init()
    cleanups.push(() => guide.close())
    await waitFor(async () => { await guide._rebuildMapping().catch(() => {}); return guide.resolveStreamId('catalog-guide-id') }, 40000, 'catalog mapping')
    ok(guide.resolveStreamId('catalog-guide-id') === 'manual-news', 'the CATALOG half of the mapping still resolves')
    await waitFor(async () => { await guide._refreshEventsMapping().catch(() => {}); return guide.resolveStreamId(withGuide.epgId) }, 40000, 'events mapping')
    ok(guide.resolveStreamId(withGuide.epgId) === withGuide.id,
      `an EPHEMERAL channel's epgId resolves to its stream id (${withGuide.epgId} -> ${withGuide.id})`)
    ok(guide.status().mappedEvents === CHANNELS, `status() reports the drive-side mapping separately (mappedEvents ${guide.status().mappedEvents})`)
    ok(guide.status().mappedChannels === 1, 'and the catalog-side count stays its own number')
    const revSeen = guide.status().eventsRev
    await guide._refreshEventsMapping()
    ok(guide.status().eventsRev === revSeen, 'an unchanged index rev short-circuits the refresh')
  }

  // ===== I. liveness reaches drive-sourced entries, symmetrically ==========================
  log('\nI. an idle event on the drive dims and undims, and never touches the bee')
  {
    const beeBefore = beeSize(core)
    const target = [...events.snapshot().values()].find((e) => e.source === 'live-events')
    let alive = false
    // A stub provider: a real playlist body when it is up, a bare 404 when it is not. Never
    // a network-layer failure, so the self-outage guard stays out of the way.
    const fetchImpl = async () => {
      let sent = false
      return {
        ok: alive,
        status: alive ? 200 : 404,
        headers: new Map([['content-type', 'application/vnd.apple.mpegurl']]),
        body: {
          cancel: async () => {},
          getReader: () => ({
            read: async () => (sent ? { done: true } : (sent = true, { done: false, value: b4a.from('#EXTM3U\n#EXT-X-VERSION:3\n') })),
            cancel: async () => {}
          })
        }
      }
    }
    const activity = makeRing(1000)
    // successesToFlip is DELIBERATELY not set: this exercises the shipped default, which is
    // the historical one (undim on the first success). Drive-sourced entries must not get a
    // different rule from catalog ones just because they live somewhere else.
    const prober = makeLivenessProber({ config: {}, db, activity, events }, {
      intervalMs: 3600000, bootDelayMs: 3600000, timeoutMs: 1000, failsToFlip: 2, concurrency: 16, fetchImpl, log: () => {}
    })
    await prober.probeNow()
    ok(events.snapshot().get(target.id).isLive === true, 'one failed sweep does not dim a drive entry')
    await prober.probeNow()
    ok(events.snapshot().get(target.id).isLive === false, 'the second failed sweep dims it — the DRIVE holds the flag')
    ok(activity.list().some((x) => x.type === 'liveness' && x.streamId === target.id && x.isLive === false), 'and the flip lands in the activity ring')
    alive = true
    await prober.probeNow()
    ok(events.snapshot().get(target.id).isLive === true, 'and the FIRST success undims it — the default is unchanged on this side too')
    prober.close()
    ok(core.length === beeBefore.length && core.byteLength === beeBefore.byteLength,
      'the whole liveness dance appended NOTHING to the signed bee')

    // The opt-in recovery hysteresis reaches drive entries as well.
    alive = false
    const p2 = makeLivenessProber({ config: {}, db, activity: null, events }, { intervalMs: 3600000, bootDelayMs: 3600000, timeoutMs: 1000, failsToFlip: 1, concurrency: 16, fetchImpl, log: () => {} })
    await p2.probeNow()
    p2.close()
    ok(events.snapshot().get(target.id).isLive === false, 'dimmed again at failsToFlip 1')
    alive = true
    const p3 = makeLivenessProber({ config: { liveness: { successesToFlip: 2 } }, db, activity: null, events }, { intervalMs: 3600000, bootDelayMs: 3600000, timeoutMs: 1000, failsToFlip: 1, concurrency: 16, fetchImpl, log: () => {} })
    await p3.probeNow()
    ok(events.snapshot().get(target.id).isLive === false, 'with LIVENESS_SUCCESSES_TO_FLIP=2 one success is not enough')
    await p3.probeNow()
    ok(events.snapshot().get(target.id).isLive === true, 'the second consecutive success undims it')
    // …and back down, so the carry-forward below has a verdict to carry.
    alive = false
    await p3.probeNow()
    p3.close()
    ok(events.snapshot().get(target.id).isLive === false, 'dimmed once more')
    rev++
    const r = await sources.syncSource(ctx, 'live-events') // identical body: the shard must not resurrect the flag
    ok(events.snapshot().get(target.id).isLive === false, 'a re-sync carries the liveness verdict forward instead of undimming it')
    ok(r.driveChanged === false, 'and, carrying it forward, the re-sync is a byte-compare skip')
  }

  // ===== J2. an empty upstream must not rewrite every user record =========================
  log('\nJ2. eventSources is derived from the REGISTRY, so a feed that empties cannot flap it')
  {
    // The configuration this bites in: an ephemeral source with autoGrant OFF, entitled
    // through a `source:` bouquet. Derive the list from the ids the shard currently carries
    // and an upstream that empties overnight drops the source from every holder, then puts
    // it back an hour later — two full record rewrites per oscillation, of exactly the
    // unreclaimable writes this feature exists to delete.
    await packages.setUserPackages(ctx, 'alice', ['ppv'])
    ok((await db.get('user/alice')).value.eventSources.join(',') === 'live-events,pay-events', 'alice holds the pay bouquet')
    const before = beeSize(core)
    for (let i = 0; i < 5; i++) {
      bodies['/other.m3u'] = '#EXTM3U\n'; rev++ // the provider goes quiet
      await sources.syncSource(ctx, 'pay-events')
      ok((await db.get('user/alice')).value.eventSources.includes('pay-events'), `cycle ${i + 1}: an EMPTY shard does not revoke the source`)
      bodies['/other.m3u'] = playlist(20 + i, { n: 8 }); rev++ // …and comes back
      await sources.syncSource(ctx, 'pay-events')
    }
    const after = beeSize(core)
    ok(after.length === before.length && after.byteLength === before.byteLength,
      `five empty/refill cycles appended NOTHING (length ${before.length} -> ${after.length}, byteLength ${before.byteLength} -> ${after.byteLength})`)
    ok(events.entries('pay-events').length === 8, 'and the lineup itself came back')
  }

  // ===== J3. two ephemeral sources cannot publish the same ids ============================
  log('\nJ3. a shard collision is a CONFLICT, not a silent double listing')
  {
    sources.addSource(ctx, 'dupA', { url: feedBase + '/other.m3u', format: 'm3u', category: 'PPV', prefix: 'dup.', ephemeral: true })
    sources.addSource(ctx, 'dupB', { url: feedBase + '/other.m3u', format: 'm3u', category: 'PPV', prefix: 'dup.', ephemeral: true })
    rev++
    const a = await sources.syncSource(ctx, 'dupA')
    const b = await sources.syncSource(ctx, 'dupB')
    ok(a.published === 8 && a.conflicts.length === 0, 'the first source publishes its 8 ids')
    ok(b.published === 0 && b.conflicts.length === 8,
      `the second is refused every one of them — INCUMBENT WINS (published ${b.published}, conflicts ${b.conflicts.length})`)
    const listed = Object.fromEntries((await sources.listSources(ctx)).map((s) => [s.name, s.channels]))
    ok(listed.dupA === 8 && listed.dupB === 0, `and the counts add up to the real channels (dupA ${listed.dupA}, dupB ${listed.dupB})`)
    const idx = JSON.parse(b4a.toString(await events._drive.get('/v1/index.json')))
    ok(idx.sources.filter((s) => s.name.startsWith('dup')).reduce((n, s) => n + s.count, 0) === 8,
      'the index carries each id exactly once across the shards')
    await sources.removeSource(ctx, 'dupB')
    await sources.removeSource(ctx, 'dupA')
  }

  // ===== J4. removing an ephemeral source, and refusing to do it half-way =================
  log('\nJ4. removeSource drops the shard, converges eventSources, and refuses without a drive')
  {
    ok((await db.get('user/alice')).value.eventSources.includes('pay-events'), 'alice still holds pay-events')
    const r = await sources.removeSource(ctx, 'pay-events')
    ok(r.shardDropped === true, 'the shard was cleared and dropped from the index')
    ok((await db.get('user/alice')).value.eventSources.join(',') === 'live-events',
      'and the dead source name left every holder AT ONCE — not on some later sync of an unrelated source')
    ok(!events.sources().includes('pay-events'), 'the drive no longer carries it')
    // ⚠ and the half-way case: no events manager means REFUSE, never "skip the shard drop".
    let refused = null
    try { await sources.removeSource({ ...ctx, events: null }, 'live-events') } catch (e) { refused = e }
    ok(!!refused && /events drive/.test(refused.message), `removing an ephemeral source without a drive is refused (${refused ? refused.code : 'NO THROW'})`)
    ok(!!sources.loadSources(dir)['live-events'], 'and the registry entry is still there — nothing was half-done')
    ok(sources.loadSources(dir)['live-events'].enabled !== false, 'not even the enabled flag moved')
  }

  // ===== J5. the carve-out is by IDENTITY, so revocation still revokes ====================
  log('\nJ5. a manual channel sharing an ephemeral prefix is NOT carved out')
  {
    const p = await openPanel('e2eevt-carve-')
    await ops.createUser(p.ctx, 'carol', 'carol-secret-1')
    // A MANUAL catalog channel whose id merely BEGINS with the ephemeral source's prefix.
    // A prefix-matching carve-out puts it permanently beyond revocation; an identity one
    // never touches it. normPrefix validates the charset only, so prefixes are not unique
    // between sources either — one ordinary source whose prefix begins with an ephemeral
    // one's would put its whole id-space in the same hole.
    await ops.addStream(p.ctx, 'ev.manual-channel', {})
    await packages.addPackage(p.ctx, 'manual', { members: 'ev.manual-channel' })
    await packages.setUserPackages(p.ctx, 'carol', ['manual'])
    ok((await p.db.get('user/carol')).value.wrapped['ev.manual-channel'] !== undefined, 'the manual channel is sealed to carol')
    sources.addSource(p.ctx, 'ev', { url: feedBase + '/other.m3u', format: 'm3u', category: 'Live Events', prefix: 'ev.', ephemeral: true })
    rev++
    await sources.syncSource(p.ctx, 'ev')
    await packages.setUserPackages(p.ctx, 'carol', [])
    ok((await p.db.get('user/carol')).value.wrapped['ev.manual-channel'] === undefined,
      'revoking the bouquet REALLY revokes it — a prefix carve-out would have kept the sealed key for ever')
    ok(Object.keys((await p.db.get('user/carol')).value.wrapped).length === 0, 'nothing else was left behind either')
  }

  // ===== J6. a missing events-epoch.json under an advertised pointer FAILS CLOSED =========
  log('\nJ6. ⚠ the unrecoverable case: state file gone, pointer still advertised')
  {
    const p = await openPanel('e2eevt-lost-')
    sources.addSource(p.ctx, 'ev', { url: feedBase + '/other.m3u', format: 'm3u', category: 'PPV', prefix: 'ev.', ephemeral: true })
    rev++
    await sources.syncSource(p.ctx, 'ev')
    const info = p.events.driveInfo()
    const statePath = path.join(p.dir, 'events-epoch.json')
    const saved = fs.readFileSync(statePath)
    await p.events.close()
    await p.store.close()

    // A file-by-file restore or a migration that did not know events-epoch.json is
    // load-bearing lands exactly here. Booting on would leave the manager inert, the sweep
    // would delete both cores as unaccounted, and `namespaceOf(1)` would then re-mint epoch
    // 1 at the SAME deterministic public key over an empty history — two valid signatures
    // at one length on every client that ever replicated a block, which is the hypercore
    // conflict nothing recovers from.
    fs.rmSync(statePath)
    let refused = null
    try { await openStore(p.dir, openKeys(p.dir)) } catch (e) { refused = e }
    ok(!!refused && /refusing to mint a fresh epoch/.test(refused.message || ''),
      `boot is REFUSED, not carried on with (${refused ? refused.message.slice(0, 60) + '…' : 'NO THROW'})`)
    ok(/events-epoch\.json/.test(refused.message) && /Restore/.test(refused.message), 'and the message names the file and the way out')
    ok(fs.existsSync(coreDir(p.dir, info.key)), 'the metadata core was NOT swept')
    ok(fs.existsSync(coreDir(p.dir, info.blobsKey)), 'and neither was the blobs core')

    // Put the file back and the panel boots on the same drive, same key, same lineup.
    fs.writeFileSync(statePath, saved)
    const re = await openStore(p.dir, openKeys(p.dir))
    cleanups.push(async () => { try { await re.events.close() } catch {}; try { await re.store.close() } catch {} })
    ok(re.events.driveInfo().key === info.key, 'restoring it reopens the SAME drive key')
    ok(re.events.snapshot().size === 8, 'with the whole lineup intact')

    // Belt-and-braces (the second lock on the same door): even with the manager holding
    // nothing open, the sweep keeps what meta/eventsKey advertises.
    await re.events.close()
    const gcArgs = { store: re.store, core: re.core, assets: re.assets, updates: re.updates }
    const pointer = (await re.db.get('meta/eventsKey')).value
    const swept = reclaimStrayCores(p.dir, { ...gcArgs, eventsPointer: pointer })
    ok(swept && swept.removed === 0, `a sweep with the manager closed removed nothing (${swept ? swept.removed : 'null'})`)
    ok(fs.existsSync(coreDir(p.dir, info.key)) && fs.existsSync(coreDir(p.dir, info.blobsKey)), 'both advertised cores survived it')

    // ⚠ A POINTER RECORD THAT EXISTS BUT CARRIES NO USABLE KEY. Both locks used to ask the
    // same question — "is there a usable key" — so one malformed record opened both: the
    // boot check read it as a first boot and the sweep skipped the key it could not parse.
    // Each half must answer "is there a RECORD" instead, so neither can be walked past.
    for (const bad of [{ key: '' }, { key: 'not-hex', blobsKey: pointer.blobsKey }, { blobsKey: pointer.blobsKey }, {}]) {
      const out = reclaimStrayCores(p.dir, { ...gcArgs, eventsPointer: bad })
      ok(out === null, `the sweep fails SAFE on a malformed pointer, deleting nothing (${JSON.stringify(bad).slice(0, 32)})`)
    }
    ok(fs.existsSync(coreDir(p.dir, info.key)) && fs.existsSync(coreDir(p.dir, info.blobsKey)), 'the cores are still there after all four')

    // …and the boot half, on its own: a corrupt record is still a record.
    await re.db.put('meta/eventsKey', { key: '', blobsKey: '' })
    await re.store.close()
    fs.rmSync(statePath)
    let refused2 = null
    try { await openStore(p.dir, openKeys(p.dir)) } catch (e) { refused2 = e }
    ok(!!refused2 && /refusing to mint a fresh epoch/.test(refused2.message || ''),
      'a MALFORMED pointer is still a pointer — boot is refused, not read as a first boot')
    ok(/no usable drive key/.test(refused2.message), 'and the message says the record is corrupt rather than naming a key')
    ok(fs.existsSync(coreDir(p.dir, info.key)) && fs.existsSync(coreDir(p.dir, info.blobsKey)), 'the cores survived that boot too')
  }

  // ===== J. a restart keeps the drive — and the stray-core GC does not eat it =============
  log('\nJ. reopening the panel keeps the drive, its pending epochs and its whole index')
  {
    // ⚠ THE HAZARD. store.js reclaimStrayCores() rmSync-es every 64-hex core directory that
    // is neither one of the panel's five own cores nor a core the corestore currently holds
    // OPEN. An epoch drive is neither, so openStore has to open the live epoch AND every
    // pending one BEFORE the sweep. Get that ordering wrong and the panel deletes its own
    // events drive on the next boot — silently, and with no peer to restore it from.
    await events.rotate() // leave one epoch owed a purge, so there is a pending core to protect
    const live = events.driveInfo().key
    const pending = events._state.pending.map((p) => p.driveKey)
    const revBefore = events.status().rev
    const sizeBefore = events.snapshot().size
    await events.close()
    await panel.store.close()

    const re = await openStore(dir, openKeys(dir))
    cleanups.push(async () => { try { await re.events.close() } catch {}; try { await re.store.close() } catch {} })
    ok(re.events.enabled === true, 'the manager resumed from events-epoch.json')
    ok(re.events.driveInfo().key === live, 'on the same epoch drive, with the same key')
    ok(re.events.status().rev === revBefore, `and the revision counter intact (${revBefore}) — a reused rev would overwrite a live shard`)
    ok(re.events.snapshot().size === sizeBefore, `the whole lineup was re-read from /v1/index.json (${sizeBefore} entries)`)
    ok(fs.existsSync(coreDir(dir, live)), 'the live epoch survived the boot-time stray-core sweep')
    ok(pending.length > 0 && pending.every((k) => fs.existsSync(coreDir(dir, k))),
      `an epoch still owed a purge survived it too (${pending.length} pending) — they are opened BEFORE the sweep`)
    ok(re.reclaimed && re.reclaimed.removed === 0, 'and the sweep removed nothing at all')
  }

  log('')
  if (failures) { log(`RESULT: FAIL ❌  (${failures} failing check${failures === 1 ? '' : 's'})`); await cleanup(); process.exit(1) }
  log('RESULT: PASS ✅  (an ephemeral sync appends 0 blocks and 0 bytes to the signed bee; the drive skips a quiet cycle, clears what it supersedes, rotates without orphaning an epoch, advertises { key, blobsKey } a keyless reader can mirror, gates by user.eventSources, and keeps the guide mapping, package selectors, the autoIds carve-out and drive-sourced liveness working)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
