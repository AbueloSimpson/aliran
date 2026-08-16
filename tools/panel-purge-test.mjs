// Panel purge mechanics: the batched stream purge (ops.deleteStreams), the art
// reclaim that rides it, and the removeSource guards around both. Deterministic and
// hermetic — in-process store, a loopback feed server with a releasable response, no
// DHT and no ffmpeg (belongs in the REQUIRED core CI lane).
//
// Every section here is a REGRESSION, not a design sketch. The batching itself was the
// production incident (a signed Hyperbee at 12.35 GB filling a 24 GB disk — tools/
// e2e-sources-test.mjs section O owns the byte/block budget for that). What this file
// covers is the ring of correctness properties around it, each of which was found broken
// by review or by fault injection:
//
//   A  per-id grantsRevoked, manual-grant provenance, and whole-set validation
//   B  a stream named `constructor` must not read as "held" by every user
//   C  art: a FAILED upload must not destroy the artwork it was replacing
//   D  art: a successful re-upload must actually free the superseded blob
//   E  removeSource: detach and purge are different intents and must never join
//   F  removeSource: a sync in flight is awaited, and a new one is refused, so a purge
//      cannot be undone by a sync writing back its pre-purge snapshot
//   G  removeSource: a failed purge must not leave the source silently disabled
//
// Exits 0 on PASS.
import assert from 'assert'
import http from 'http'
import os from 'os'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, loadSecrets } from '../panel/src/store.js'
import * as ops from '../panel/src/ops.js'
import * as sources from '../panel/src/sources.js'

const log = (...a) => console.log(...a)
const config = {
  argon2: { memKiB: 8192, time: 1 },
  maxDevicesDefault: 2,
  sources: { maxChannels: 500, fetchTimeoutMs: 5000, maxBytes: 256 * 1024 }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-'))
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }

// Feed server whose response can be HELD open, so a sync can be parked mid-fetch while
// another operation runs. That is the only way to make section F deterministic.
let feed = { channels: [] }
let hold = null // set to a promise to park the next response
const feedSrv = http.createServer(async (req, res) => {
  if (hold) await hold
  const body = JSON.stringify(feed)
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
})
await new Promise((r) => feedSrv.listen(0, '127.0.0.1', r))
cleanups.push(() => new Promise((r) => feedSrv.close(r)))
const feedUrl = `http://127.0.0.1:${feedSrv.address().port}/f.json`

try {
  initKeys(dir)
  const keys = openKeys(dir)
  const { store, db, assets } = await openStore(dir, keys)
  cleanups.push(() => store.close())
  const ctx = { config, keys, db, assets, dataDir: dir }
  const blobs = await assets.getBlobs()
  const heldBlocks = async () => {
    let n = 0
    for (let i = 0; i < blobs.core.length; i++) if (await blobs.core.has(i)) n++
    return n
  }
  const grantsOf = async (u) => Object.keys((await db.get('user/' + u)).value.wrapped)

  // ===== A: per-id grantsRevoked, provenance, and whole-set validation =====
  for (const id of ['s1', 's2', 's3']) await ops.addStream(ctx, id, { title: id })
  await ops.createUser(ctx, 'holder', 'holder-secret-1')
  await ops.createUser(ctx, 'bystander', 'bystander-secret-1')
  for (const id of ['s1', 's2']) await ops.grant(ctx, 'holder', id)
  // Manual PROVENANCE for s3 with no sealed grant: it must be pruned, and it must NOT
  // count as a revoked grant — grantsRevoked has always meant "users who held a key".
  const by = (await db.get('user/bystander')).value
  by.manualGrants = ['s3']
  await db.put('user/bystander', by)

  const vA = db.version
  await assert.rejects(() => ops.deleteStreams(ctx, ['s1', 'nope']), (e) => e.code === 'not-found', 'a bad id must reject')
  assert.strictEqual(db.version, vA, 'a rejected batch appends NOTHING — validation runs before any mutation')
  assert.ok(await db.get('catalog/s1'), 's1 survived the rejected batch')

  const outA = await ops.deleteStreams(ctx, ['s1', 's2', 's3', 's3'])
  assert.deepStrictEqual(outA.ok, [
    { id: 's1', deleted: true, grantsRevoked: 1 },
    { id: 's2', deleted: true, grantsRevoked: 1 },
    { id: 's3', deleted: true, grantsRevoked: 0 }
  ], 'per-id grantsRevoked, deduped: ' + JSON.stringify(outA.ok))
  assert.deepStrictEqual(outA.failed, [])
  assert.deepStrictEqual((await db.get('user/bystander')).value.manualGrants, [], 'provenance dies with the stream')
  assert.deepStrictEqual(await grantsOf('holder'), [], 'sealed grants gone')
  for (const id of ['s1', 's2', 's3']) {
    assert.strictEqual(loadSecrets(dir)[id], undefined, 'secret purged: ' + id)
    assert.strictEqual(await db.get('catalog/' + id), null, 'catalog purged: ' + id)
  }
  await ops.addStream(ctx, 's4', { title: 's4' })
  await ops.grant(ctx, 'holder', 's4')
  assert.deepStrictEqual(await ops.deleteStream(ctx, 's4'), { id: 's4', deleted: true, grantsRevoked: 1 }, 'the one-element wrapper keeps its shape')
  await assert.rejects(() => ops.deleteStream(ctx, 's4'), (e) => e.code === 'not-found')
  const tol = await ops.deleteStreams(ctx, ['ghost'], { tolerant: true })
  assert.deepStrictEqual(tol.ok, [])
  assert.strictEqual(tol.failed.length, 1, 'tolerant reports rather than throws')
  assert.strictEqual(tol.failed[0].id, 'ghost')
  log('A: per-id grantsRevoked (manual provenance excluded), dedup, whole-set validation appends nothing, wrapper contract, tolerant reporting ✓')

  // ===== B: a stream named `constructor` is a NAME, not a prototype member =====
  // checkName admits every Object.prototype member ('constructor', 'toString', 'valueOf',
  // …). Probing `wrapped[id] !== undefined` makes such a stream read as held by EVERY
  // user, which writes accounts that held nothing — the one thing the batched pass must
  // never do, because the SDK's _watchGrants wakes every connected device on a write —
  // and reports a fabricated grantsRevoked to the operator.
  for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
    await ops.addStream(ctx, name, { title: name })
    await ops.createUser(ctx, 'proto-' + name.toLowerCase(), 'proto-secret-1')
  }
  await ops.grant(ctx, 'holder', 'constructor')
  const vB = db.version
  const outB = await ops.deleteStreams(ctx, ['constructor', 'toString', 'hasOwnProperty'])
  assert.deepStrictEqual(outB.ok.map((r) => r.grantsRevoked), [1, 0, 0], 'only the real grant counts: ' + JSON.stringify(outB.ok))
  assert.strictEqual(db.version - vB, 1 + 3, 'exactly one user put + three catalog deletes — no user who held nothing was written')
  log('B: prototype-named streams — `constructor`/`toString`/`hasOwnProperty` revoke only real grants and write only real holders ✓')

  // ===== C: a FAILED art upload must not destroy the art it was replacing =====
  // Reclaiming before the replacement lands is how a disk-full box loses the artwork it
  // still had: the put fails with ENOSPC, the catalog still names the file, and the
  // retry fails the same way. ENOSPC is exactly the condition this reclaim exists for.
  await ops.addStream(ctx, 'news', { title: 'News' })
  const artV1 = b4a.alloc(256 * 1024, 1)
  await ops.uploadArt(ctx, 'news', 'poster', artV1, '.png')
  const realPut = assets.put.bind(assets)
  assets.put = async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) }
  await assert.rejects(() => ops.uploadArt(ctx, 'news', 'poster', b4a.alloc(256 * 1024, 2), '.png'), /ENOSPC/, 'the failing upload must surface its error')
  assets.put = realPut
  // wait:false so a blob whose bytes were freed FAILS here instead of parking forever
  // waiting for a peer to supply them — the whole point is that they are still local.
  const survived = await assets.get('/news/poster.png', { wait: false }).catch((e) => e)
  assert.ok(b4a.isBuffer(survived) && b4a.equals(survived, artV1), 'the artwork the failed upload was replacing is still readable, not freed: ' + survived)
  assert.strictEqual((await db.get('catalog/news')).value.poster, 'assets/news/poster.png', 'and the record still points at it')
  log('C: an upload that fails mid-flight (ENOSPC) leaves the previous artwork intact and readable ✓')

  // ===== D: a SUCCESSFUL re-upload frees the superseded blob =====
  // hyperdrive.clear() returns null and frees nothing while drive.blobs is unset, so the
  // whole reclaim is a silent no-op unless getBlobs() is awaited first.
  const heldAfterFirst = await heldBlocks()
  await ops.uploadArt(ctx, 'news', 'poster', b4a.alloc(256 * 1024, 3), '.png')
  const heldAfterSecond = await heldBlocks()
  assert.strictEqual(heldAfterSecond, heldAfterFirst, `a re-upload must not grow held blocks (${heldAfterFirst} -> ${heldAfterSecond}) — the superseded blob was not freed`)
  const current = await assets.get('/news/poster.png', { wait: false }).catch((e) => e)
  assert.ok(b4a.isBuffer(current) && current[0] === 3, 'and the CURRENT blob is intact — clear must target the captured descriptor, never the live path: ' + current)
  await ops.deleteStream(ctx, 'news')
  assert.strictEqual(await heldBlocks(), 0, 'purging the stream frees every art block it held')
  log(`D: art reclaim is real — a re-upload holds ${heldAfterSecond} blocks (not ${heldAfterFirst * 2}), the live blob survives, and a purge frees them all ✓`)

  // ===== E: detach and purge are DIFFERENT intents and must never share a promise =====
  // keepChannels is not a detail: joining across it answers a DETACH request with a
  // completed PURGE — HTTP 200, `detached: 0`, and every channel, grant, secret and art
  // blob destroyed. Three front doors carry the flag (admin API, CLI, MCP).
  feed = { channels: Array.from({ length: 6 }, (_, i) => ({ id: 'c' + i, name: 'C' + i, url: `https://cdn.example/${i}.m3u8` })) }
  sources.addSource(ctx, 'keep', { url: feedUrl, category: 'K', prefix: 'k.' })
  await sources.syncSource(ctx, 'keep')
  const keepIds = Array.from({ length: 6 }, (_, i) => 'k.c' + i)
  for (const id of keepIds) assert.ok(await db.get('catalog/' + id), 'imported ' + id)

  const detachP = sources.removeSource(ctx, 'keep', { keepChannels: true })
  assert.throws(() => sources.removeSource(ctx, 'keep'), (e) => e.code === 'bad-request' && /detached/.test(e.message),
    'a PURGE must never join a running DETACH')
  const detached = await detachP
  assert.strictEqual(detached.detached, 6, 'the detach really detached: ' + JSON.stringify(detached))
  assert.strictEqual(detached.removed, 0, 'and destroyed nothing')
  for (const id of keepIds) {
    const c = (await db.get('catalog/' + id))?.value
    assert.ok(c, id + ' still exists')
    assert.strictEqual(c.source, undefined, id + ' lost its source stamp')
  }
  // …and the mirror image: a DETACH must not join a running purge either.
  sources.addSource(ctx, 'gone', { url: feedUrl, category: 'G', prefix: 'g.' })
  await sources.syncSource(ctx, 'gone')
  const purgeP = sources.removeSource(ctx, 'gone')
  assert.throws(() => sources.removeSource(ctx, 'gone', { keepChannels: true }), (e) => e.code === 'bad-request' && /purged/.test(e.message),
    'a DETACH must never join a running PURGE')
  assert.strictEqual((await purgeP).removed, 6)
  // An IDENTICAL intent still joins — that is the timed-out-dashboard retry this guards.
  sources.addSource(ctx, 'twice', { url: feedUrl, category: 'T', prefix: 't.' })
  await sources.syncSource(ctx, 'twice')
  const [r1, r2] = await Promise.all([sources.removeSource(ctx, 'twice'), sources.removeSource(ctx, 'twice')])
  assert.strictEqual(r1, r2, 'the identical-intent retry joins the running purge')
  assert.strictEqual(r1.removed, 6)
  log('E: detach vs purge never join (both directions refused, 400), identical intent still single-flights ✓')

  // ===== F: a purge cannot be undone by a sync writing back its pre-purge snapshot =====
  // applyFeed computes from a snapshot taken when the sync began. A removal finishing in
  // between deletes those ids, their secrets and their grants — and the sync then writes
  // the snapshot back as records owned by a source no longer in the registry: permanently
  // ungrantable, and unreachable by every repair path, because they can never be synced
  // again. `enabled:false` alone does NOT prevent this (a tick snapshots the registry
  // once, and doSync ignores `enabled` so manual syncs keep working).
  feed = { channels: Array.from({ length: 40 }, (_, i) => ({ id: 'r' + i, name: 'R' + i, url: `https://cdn.example/r/${i}.m3u8` })) }
  sources.addSource(ctx, 'race', { url: feedUrl, category: 'R', prefix: 'r.' })
  await sources.syncSource(ctx, 'race')
  const raceIds = Array.from({ length: 40 }, (_, i) => 'r.r' + i)
  for (const u of ['holder', 'bystander']) assert.ok((await grantsOf(u)).some((id) => id.startsWith('r.')), u + ' holds race grants')

  let release
  hold = new Promise((r) => { release = r })
  const syncP = sources.syncSource(ctx, 'race') // parks inside fetch, holding the pre-purge snapshot
  const removeP = sources.removeSource(ctx, 'race') // disables, then must WAIT for that sync
  release()
  await syncP.catch(() => {}) // the parked sync may legitimately finish OR be refused
  const removed = await removeP
  hold = null

  assert.ok(!(await sources.listSources(ctx)).some((s) => s.name === 'race'), 'the registry entry came off')
  const survivors = []
  for await (const { key, value } of db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    const id = key.slice('catalog/'.length)
    if ((value && value.source === 'race') || raceIds.includes(id)) survivors.push(id)
  }
  assert.deepStrictEqual(survivors, [], `the purge must be final — ${survivors.length} channel(s) were written back after it: ` + survivors.slice(0, 5).join(', '))
  const secretsAfter = loadSecrets(dir)
  for (const id of raceIds) assert.strictEqual(secretsAfter[id], undefined, 'no orphan secret for ' + id)
  for (const u of ['holder', 'bystander']) {
    assert.deepStrictEqual((await grantsOf(u)).filter((id) => id.startsWith('r.')), [], u + ' holds no grant to a channel that no longer exists')
  }
  assert.strictEqual(removed.removed, 40, 'and every channel was accounted for: ' + JSON.stringify(removed))

  // The other half of the fence: a sync that tries to START while a purge holds the name
  // is refused outright, so it never spends a fetch on records that are being deleted.
  // `purging` is claimed synchronously by removeSource, so this call sees it immediately.
  feed = { channels: [{ id: 'y0', name: 'Y0', url: 'https://cdn.example/y0.m3u8' }] }
  sources.addSource(ctx, 'gate', { url: feedUrl, category: 'Y', prefix: 'y.' })
  await sources.syncSource(ctx, 'gate')
  const gateP = sources.removeSource(ctx, 'gate')
  await assert.rejects(() => sources.syncSource(ctx, 'gate'), (e) => e.code === 'not-found' && /being removed/.test(e.message),
    'a new sync must be refused while a purge holds the name')
  await gateP
  log('F: a sync parked mid-fetch is awaited, a new one is refused, and the purge leaves no resurrected channel, orphan secret or dangling grant ✓')

  // ===== G: a FAILED purge must not leave the source silently disabled =====
  // The scheduler skips `enabled === false`, so a source left disabled by a crashed
  // removal simply stops importing, with nothing anywhere saying why.
  feed = { channels: [{ id: 'x0', name: 'X0', url: 'https://cdn.example/x0.m3u8' }] }
  sources.addSource(ctx, 'boom', { url: feedUrl, category: 'B', prefix: 'b.' })
  await sources.syncSource(ctx, 'boom')
  const realGet = db.get.bind(db)
  let armed = true
  db.get = async (k, ...rest) => {
    if (armed && typeof k === 'string' && k.startsWith('catalog/b.')) { armed = false; throw new Error('injected store failure') }
    return realGet(k, ...rest)
  }
  await assert.rejects(() => sources.removeSource(ctx, 'boom', { keepChannels: true }), /injected store failure/)
  db.get = realGet
  const boom = (await sources.listSources(ctx)).find((s) => s.name === 'boom')
  assert.ok(boom, 'the source is still registered after a failed removal')
  assert.notStrictEqual(boom.enabled, false, 'and it is NOT left silently disabled — the scheduler would stop importing it')
  await sources.removeSource(ctx, 'boom')
  log('G: a removal that fails partway restores `enabled` instead of leaving the source quietly stopped ✓')

  log('\nPASS: panel purge mechanics (batched deleteStreams, art reclaim, removeSource guards)')
  await cleanup()
  process.exit(0)
} catch (err) {
  console.error('\nFAIL:', err)
  await cleanup()
  process.exit(1)
}
