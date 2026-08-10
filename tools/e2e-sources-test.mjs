// End-to-end test for remote channel sources (S27). Deterministic: in-process
// panel store + admin server + a loopback HTTP feed server — no DHT, no ffmpeg
// (belongs in the REQUIRED core CI lane).
//
// Covers: add-source validation → first sync (mapping, redirect entries, category,
// art fallback, epg pointers, skips, conflicts with manual channels, auto-grant)
// → idempotency (ETag 304 AND same-content 200 both append NOTHING to the bee)
// → feed mutation (update/remove/add + curation fields surviving, feed winning on
// mapped fields) → create-user auto-grant hook → autoGrant toggle + reconcile →
// channel cap truncation → oversized/unreachable feed failure keeping last good
// state → scheduler (never-synced source syncs itself) → remove with keepChannels
// (detach) and without (purge) → M3U sources (group filter + `filtered` count, ids
// slugged from the display names with -2 dedup, #EXTVLCOPT playback headers with
// per-key degrade, no EPG pointers, exclude-by-slug, token rotation really appending,
// 304 idempotency, cross-format hints keeping the last good state) → redirect playback
// headers over the admin API (allowlist, no-url refusal, url-clear clearing them).
// Exits 0 on PASS.
import assert from 'assert'
import http from 'http'
import os from 'os'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, loadSecrets } from '../panel/src/store.js'
import { makeRing } from '../panel/src/activity.js'
import * as ops from '../panel/src/ops.js'
import * as sources from '../panel/src/sources.js'
import { startAdminServer } from '../panel/src/admin-server.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(150) } throw new Error('timeout: ' + label) }

const ADMIN_PASSWORD = 'correct-horse-battery'

// Fast Argon2 + tight source caps so truncation/oversize are testable.
const config = {
  argon2: { memKiB: 8192, time: 1 },
  maxDevicesDefault: 2,
  sources: { maxChannels: 5, fetchTimeoutMs: 5000, maxBytes: 64 * 1024 }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2esrc-'))
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }

// ---------------------------------------------------------------- feed server
// Mutable per-path feeds + toggleable ETag support (etag = `"v<rev>"`). `texts` holds
// the RAW-TEXT fixtures (m3u playlists) — same paths, same ETag machinery, only the
// content type and the serialization differ, so both formats are exercised against one
// server and the 304 assertions mean the same thing for each.
const feeds = { '/anime.json': null, '/kids.json': null }
const texts = { '/events.m3u': null }
let rev = 1
let etagOn = true
let hits304 = 0
const feedSrv = http.createServer((req, res) => {
  const p = req.url.split('?')[0]
  const isText = Object.prototype.hasOwnProperty.call(texts, p)
  const feed = isText ? texts[p] : feeds[p]
  if (feed == null) { res.writeHead(404); res.end(); return }
  const etag = `"v${rev}"`
  if (etagOn && req.headers['if-none-match'] === etag) { hits304++; res.writeHead(304); res.end(); return }
  const body = isText ? feed : JSON.stringify(feed)
  const headers = { 'content-type': isText ? 'application/vnd.apple.mpegurl' : 'application/json', 'content-length': Buffer.byteLength(body) }
  if (etagOn) headers.etag = etag
  res.writeHead(200, headers)
  res.end(body)
})
await new Promise((r) => feedSrv.listen(0, '127.0.0.1', r))
cleanups.push(() => new Promise((r) => feedSrv.close(r)))
const feedBase = `http://127.0.0.1:${feedSrv.address().port}`
const animeUrl = feedBase + '/anime.json'
const eventsUrl = feedBase + '/events.m3u'

try {
  // ===== panel store + admin server (in-process, same shape as e2e-admin-api) =====
  initKeys(dir)
  const keys = openKeys(dir)
  const { store, db, assets } = await openStore(dir, keys); cleanups.push(() => store.close())
  const ring = makeRing(200)
  const ctx = { config, keys, db, assets, dataDir: dir, activity: ring }
  ops.addAdmin(ctx, 'root', ADMIN_PASSWORD)
  const { port, close } = await startAdminServer(ctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 5, seconds: 60 } })
  cleanups.push(close)
  const base = `http://127.0.0.1:${port}`
  const api = async (method, p, body, token) => {
    const headers = {}
    if (token) headers.authorization = 'Bearer ' + token
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  const token = (await api('POST', '/api/login', { username: 'root', password: ADMIN_PASSWORD })).body.token
  assert.ok(token, 'admin login')

  // A user that exists BEFORE the first sync, and a manual channel whose id
  // collides with a feed entry (must never be adopted or modified).
  await api('POST', '/api/users', { username: 'bob', password: 'bob-secret-1' }, token)
  await ops.addStream(ctx, 'anime.manual', { title: 'Hands Off', url: 'https://example.com/manual.m3u8' })

  // ===== Test A0: EPG pointers on a MANUAL (non-source) channel via setMeta =====
  // Proves the program-guide fields work on any channel, not just imported ones.
  let m = await api('PATCH', '/api/streams/anime.manual', { epgUrl: 'https://guide.example/tv.json', epgId: 'hands-off' }, token)
  assert.strictEqual(m.status, 200, 'set epg on a manual channel: ' + JSON.stringify(m.body))
  let mc = (await db.get('catalog/anime.manual')).value
  assert.strictEqual(mc.epgUrl, 'https://guide.example/tv.json')
  assert.strictEqual(mc.epgId, 'hands-off')
  m = await api('PATCH', '/api/streams/anime.manual', { epgUrl: 'http://insecure.example/tv.json' }, token)
  assert.strictEqual(m.status, 400, 'http epgUrl must be rejected')
  m = await api('PATCH', '/api/streams/anime.manual', { epgUrl: '', epgId: '' }, token)
  assert.strictEqual(m.status, 200)
  mc = (await db.get('catalog/anime.manual')).value
  assert.strictEqual(mc.epgUrl, null, 'empty epgUrl clears')
  assert.strictEqual(mc.epgId, null, 'empty epgId clears')
  log('A0: EPG pointers set/clear on a manual channel via setMeta; http epgUrl rejected ✓')

  // ===== Test A: add-source validation =====
  let r = await api('POST', '/api/sources', { name: 'anime', url: 'http://not-loopback.example/feed.json', category: 'Anime' }, token)
  assert.strictEqual(r.status, 400, 'non-loopback http feed url must be rejected: ' + JSON.stringify(r.body))
  r = await api('POST', '/api/sources', { name: 'anime', url: animeUrl }, token)
  assert.strictEqual(r.status, 400, 'missing category must be rejected')
  r = await api('POST', '/api/sources', { name: 'bad name!', url: animeUrl, category: 'X' }, token)
  assert.strictEqual(r.status, 400, 'invalid source name must be rejected')
  r = await api('POST', '/api/sources', { name: 'anime', url: animeUrl, category: 'Anime' }, token)
  assert.strictEqual(r.status, 201, 'add source: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.prefix, 'anime.', 'default prefix = name + dot')
  assert.strictEqual(r.body.autoGrant, true, 'autoGrant defaults on')
  r = await api('POST', '/api/sources', { name: 'anime', url: animeUrl, category: 'Anime' }, token)
  assert.strictEqual(r.status, 409, 'duplicate source must be 409')
  log('A: source url/name/category validation + loopback-http carve-out + duplicate 409 ✓')

  // ===== Test B: first sync — mapping, skips, conflict, grants =====
  feeds['/anime.json'] = {
    name: 'Anime ES',
    channels: [
      { id: 'moon-cat', number: 1001175, name: 'Moon Cat', description: 'The great detective', logo: 'https://img.example/moon-cat.png', url: 'https://cdn.example/moon-cat.m3u8', categories: ['Anime'], provider: 'demotv', epg: [{ title: 'ep1' }] },
      { id: 'ninja-run', name: 'Ninja Run', logo: 'http://insecure.example/ninja-run.png', url: 'https://cdn.example/ninja-run.m3u8' },
      { id: 'star-quest', name: 'Star Quest', url: 'https://cdn.example/op.m3u8' },
      { id: 'manual', name: 'Imposter', url: 'https://cdn.example/imposter.m3u8' },
      { id: 'badurl', name: 'Bad URL', url: 'http://insecure.example/x.m3u8' },
      { id: 'bad id!', name: 'Bad Id', url: 'https://cdn.example/y.m3u8' },
      { id: 'moon-cat', name: 'Duplicate', url: 'https://cdn.example/dup.m3u8' }
    ]
  }
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.status, 200, 'sync: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.added, 3, 'three valid new channels')
  assert.deepStrictEqual(r.body.conflicts, ['anime.manual'], 'colliding manual id reported as conflict')
  assert.strictEqual(r.body.skippedCount, 3, 'bad url + bad id + duplicate skipped')
  assert.strictEqual(r.body.granted, 3, 'bob auto-granted the three channels')

  const mooncat = (await db.get('catalog/anime.moon-cat')).value
  assert.strictEqual(mooncat.title, 'Moon Cat')
  assert.strictEqual(mooncat.description, 'The great detective', 'description seeded from the feed field on create')
  assert.strictEqual((await db.get('catalog/anime.ninja-run')).value.description, '', 'no feed description -> empty (no more "via provider")')
  assert.deepStrictEqual(mooncat.category, ['Anime'], 'category = source label (not the feed\'s)')
  assert.strictEqual(mooncat.redirect, true)
  assert.strictEqual(mooncat.url, 'https://cdn.example/moon-cat.m3u8')
  assert.strictEqual(mooncat.logo, 'https://img.example/moon-cat.png')
  assert.strictEqual(mooncat.order, 0)
  assert.strictEqual(mooncat.isLive, true)
  assert.strictEqual(mooncat.status, 'live')
  assert.strictEqual(mooncat.featured, false)
  assert.strictEqual(mooncat.source, 'anime')
  assert.strictEqual(mooncat.epgUrl, animeUrl, 'epg pointer = the feed url')
  assert.strictEqual(mooncat.epgId, 'moon-cat')
  assert.strictEqual(mooncat.feedKey, null, 'redirect channel has no P2P feed')
  const ninjarun = (await db.get('catalog/anime.ninja-run')).value
  assert.strictEqual(ninjarun.logo, null, 'http logo degrades to no art, channel kept')
  assert.strictEqual(ninjarun.order, 1)
  const manual = (await db.get('catalog/anime.manual')).value
  assert.strictEqual(manual.title, 'Hands Off', 'manual channel untouched by the colliding feed entry')
  assert.strictEqual(manual.source, undefined)

  const secrets = loadSecrets(dir)
  for (const id of ['anime.moon-cat', 'anime.ninja-run', 'anime.star-quest']) assert.match(secrets[id], /^[0-9a-f]{64}$/, 'secret minted for ' + id)
  const bob = (await db.get('user/bob')).value
  for (const id of ['anime.moon-cat', 'anime.ninja-run', 'anime.star-quest']) assert.ok(bob.wrapped[id], 'bob sealed grant for ' + id)
  assert.strictEqual(bob.wrapped['anime.manual'], undefined, 'conflict channel NOT granted by the source')

  r = await api('GET', '/api/sources', undefined, token)
  assert.strictEqual(r.body.length, 1)
  assert.strictEqual(r.body[0].channels, 3, 'owned-channel count')
  assert.ok(r.body[0].lastSync && !r.body[0].lastError && r.body[0].lastReport.added === 3, 'registry sync state persisted')
  assert.ok(ring.list().some((e) => e.type === 'source' && e.op === 'sync' && e.source === 'anime'), 'activity ring records the sync')
  log('B: first sync — 3 added, conflict skipped, invalids skipped, art fallback, epg pointers, bob granted ✓')

  // ===== Test C: idempotency — 304 AND same-content 200 append nothing =====
  const v1 = db.version
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.body.notModified, true, 'etag revalidation → 304 path')
  assert.ok(hits304 >= 1, 'server actually answered 304')
  assert.strictEqual(db.version, v1, '304 sync appends nothing to the bee')
  etagOn = false
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.body.notModified, false)
  assert.strictEqual(r.body.added + r.body.updated + r.body.removed, 0, 'same content → zero writes')
  assert.strictEqual(r.body.unchanged, 3)
  assert.strictEqual(db.version, v1, 'unchanged full-body sync appends nothing to the bee')
  etagOn = true
  log('C: idempotent — ETag 304 and same-content 200 both leave the bee untouched (version ' + v1 + ') ✓')

  // ===== Test D: mutation — update/remove/add; curation survives; feed wins on mapped fields =====
  await api('PATCH', '/api/streams/anime.moon-cat', { featured: true, description: 'A cat detective on the moon' }, token) // operator-owned fields
  feeds['/anime.json'] = {
    channels: [
      { id: 'moon-cat', name: 'Moon Cat HD', logo: 'https://img.example/moon-cat.png', url: 'https://cdn.example/moon-cat.m3u8', provider: 'demotv' },
      { id: 'ninja-run', name: 'Ninja Run', url: 'https://cdn.example/ninja-run-v2.m3u8' },
      { id: 'robo-kid', name: 'Robo Kid', url: 'https://cdn.example/robo-kid.m3u8' }
    ]
  }
  rev++
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.body.updated, 2, 'title + url changes: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.removed, 1, 'star-quest left the feed → REMOVED')
  assert.strictEqual(r.body.added, 1, 'robo-kid added')
  assert.deepStrictEqual(r.body.conflicts, [], 'no conflicts this round')
  assert.ok(db.version > v1, 'real changes append')

  assert.strictEqual((await db.get('catalog/anime.star-quest')), null, 'removed channel gone from catalog')
  assert.strictEqual(loadSecrets(dir)['anime.star-quest'], undefined, 'removed channel secret purged')
  const bob2 = (await db.get('user/bob')).value
  assert.strictEqual(bob2.wrapped['anime.star-quest'], undefined, 'removed channel grant revoked from bob')
  assert.ok(bob2.wrapped['anime.robo-kid'], 'new channel granted to bob')
  const mooncat2 = (await db.get('catalog/anime.moon-cat')).value
  assert.strictEqual(mooncat2.title, 'Moon Cat HD', 'feed wins on mapped fields')
  assert.strictEqual(mooncat2.featured, true, 'operator curation on unmapped fields survives the sync')
  assert.strictEqual(mooncat2.description, 'A cat detective on the moon', 'operator-edited description survives the sync (not feed-managed)')
  assert.strictEqual((await db.get('catalog/anime.ninja-run')).value.url, 'https://cdn.example/ninja-run-v2.m3u8')
  log('D: mutation — ~2 updated, -1 removed (grants+secret purged), +1 added, curation survives ✓')

  // ===== Test E: create-user hook — fresh accounts converge immediately =====
  r = await api('POST', '/api/users', { username: 'carol', password: 'carol-secret-1' }, token)
  assert.strictEqual(r.status, 201)
  assert.ok(r.body.grants.includes('anime.moon-cat') && r.body.grants.includes('anime.robo-kid'), 'create-user response already shows source grants: ' + JSON.stringify(r.body.grants))
  assert.strictEqual(r.body.grants.length, 3, 'carol granted exactly the source channels')
  log('E: create-user auto-grant hook — carol got all 3 source channels at creation ✓')

  // ===== Test F: autoGrant off → no grants; on → reconcile catches up =====
  await api('PATCH', '/api/sources/anime', { autoGrant: false }, token)
  r = await api('POST', '/api/users', { username: 'dave', password: 'dave-secret-1' }, token)
  assert.deepStrictEqual(r.body.grants, [], 'autoGrant off → dave starts with nothing')
  await api('PATCH', '/api/sources/anime', { autoGrant: true }, token)
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.body.granted, 3, 'reconcile seals the 3 channels for dave')
  assert.ok((await db.get('user/dave')).value.wrapped['anime.moon-cat'], 'dave granted on reconcile')
  log('F: autoGrant toggle — off leaves new users empty, re-enable + sync reconciles ✓')

  // ===== Test G: caps + failures keep last good state =====
  const seven = []
  for (let i = 0; i < 7; i++) seven.push({ id: 'ch' + i, name: 'Ch ' + i, url: `https://cdn.example/ch${i}.m3u8` })
  feeds['/anime.json'] = { channels: seven }; rev++
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.body.truncated, 2, 'cap 5 → 2 truncated')
  assert.strictEqual(r.body.added, 5, 'five under the cap imported')
  assert.strictEqual(r.body.removed, 3, 'previous trio left the feed')
  let owned = 0
  for await (const { value } of db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) if (value.source === 'anime') owned++
  assert.strictEqual(owned, 5)

  feeds['/anime.json'] = { channels: [{ id: 'big', name: 'X'.repeat(100000), url: 'https://cdn.example/big.m3u8' }] }; rev++
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.status, 400, 'oversized feed → sync fails')
  assert.match(r.body.error, /too large/)
  r = await api('GET', '/api/sources', undefined, token)
  assert.match(r.body[0].lastError, /too large/, 'lastError recorded')
  assert.strictEqual(r.body[0].channels, 5, 'failed sync keeps the last good channels')

  await api('PATCH', '/api/sources/anime', { url: 'http://127.0.0.1:9/nothing.json' }, token) // closed port
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.status, 400, 'unreachable feed → sync fails, channels intact')
  await api('PATCH', '/api/sources/anime', { url: animeUrl }, token)

  feeds['/anime.json'] = { channels: seven.slice(0, 3) }; rev++
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.status, 200)
  assert.strictEqual((await api('GET', '/api/sources', undefined, token)).body[0].lastError, null, 'recovery clears lastError')
  log('G: channel cap + oversized/unreachable feeds fail safe, last good state kept, recovery clears the error ✓')

  // ===== Test H: scheduler — a never-synced source syncs itself =====
  feeds['/kids.json'] = { channels: [{ id: 'k1', name: 'Kids One', url: 'https://cdn.example/k1.m3u8' }] }
  r = await api('POST', '/api/sources', { name: 'kids', url: feedBase + '/kids.json', category: 'Kids' }, token)
  assert.strictEqual(r.status, 201)
  const sched = sources.makeSourcesScheduler(ctx, { tickMs: 300, bootDelayMs: 50 })
  cleanups.push(() => sched.close())
  await waitFor(async () => (await db.get('catalog/kids.k1')), 8000, 'scheduler imports the kids feed')
  const kidsRow = (await api('GET', '/api/sources', undefined, token)).body.find((s) => s.name === 'kids')
  assert.ok(kidsRow.lastSync, 'scheduler stamped lastSync')
  assert.ok((await db.get('user/bob')).value.wrapped['kids.k1'], 'scheduler sync auto-granted bob')
  sched.close()
  log('H: scheduler picked up the never-synced source and imported + granted it ✓')

  // ===== Test I: deselect (exclude) channels — removed, kept out, re-includable =====
  r = await api('GET', '/api/sources/anime/channels', undefined, token)
  assert.strictEqual(r.status, 200)
  assert.deepStrictEqual(r.body.channels.map((c) => c.feedId), ['ch0', 'ch1', 'ch2'], 'channels dialog lists imported entries in feed order')
  assert.ok(r.body.channels.every((c) => !c.excluded), 'nothing excluded yet')

  r = await api('PATCH', '/api/sources/anime', { exclude: [{ id: 'ch1', title: 'Ch 1' }] }, token)
  assert.strictEqual(r.body.exclude.length, 1, 'exclusion stored')
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.body.notModified, false, 'exclude change resets the ETag — a 304 must not mask it')
  assert.strictEqual(r.body.removed, 1, 'excluded channel removed')
  assert.strictEqual(r.body.excluded, 1, 'feed entry counted as excluded, not as an error')
  assert.strictEqual((await db.get('catalog/anime.ch1')), null, 'excluded channel gone from catalog')
  assert.strictEqual(loadSecrets(dir)['anime.ch1'], undefined, 'excluded channel secret purged')
  assert.strictEqual((await db.get('user/bob')).value.wrapped['anime.ch1'], undefined, 'excluded channel grant revoked')

  r = await api('GET', '/api/sources/anime/channels', undefined, token)
  const exRow = r.body.channels.find((c) => c.feedId === 'ch1')
  assert.ok(exRow && exRow.excluded && exRow.title === 'Ch 1', 'dialog shows the excluded entry with its captured label')

  const vExcl = db.version
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.body.notModified, true, 'unchanged feed + standing exclusion → 304 again')
  assert.strictEqual(db.version, vExcl, 'the feed cannot re-add an excluded channel (zero appends)')

  r = await api('PATCH', '/api/sources/anime', { exclude: [] }, token)
  assert.strictEqual(r.body.exclude.length, 0)
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.body.added, 1, 're-included channel comes back')
  assert.ok((await db.get('catalog/anime.ch1')), 'catalog entry restored')
  assert.ok((await db.get('user/bob')).value.wrapped['anime.ch1'], 'grant re-sealed on re-include')
  log('I: deselect — excluded channel purged + kept out through 304s, label preserved, re-include restores + re-grants ✓')

  // ===== Test J: removal — detach (keepChannels) vs purge =====
  r = await api('DELETE', '/api/sources/kids?keepChannels=1', undefined, token)
  assert.strictEqual(r.body.detached, 1)
  const k1 = (await db.get('catalog/kids.k1')).value
  assert.strictEqual(k1.source, undefined, 'detached channel lost the source stamp')
  assert.strictEqual(k1.epgUrl, undefined)
  assert.strictEqual(k1.redirect, true, 'detached channel still a working redirect channel')
  assert.ok((await db.get('user/bob')).value.wrapped['kids.k1'], 'detach keeps grants')

  r = await api('DELETE', '/api/sources/anime', undefined, token)
  assert.strictEqual(r.body.removed, 3, 'purge removes the owned trio')
  for await (const { key, value } of db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
    assert.ok(!value.source, 'no source-stamped channels left: ' + key)
  }
  assert.ok((await db.get('catalog/anime.manual')), 'manual channel survives the source purge')
  const bob3 = (await db.get('user/bob')).value
  assert.strictEqual(Object.keys(bob3.wrapped).filter((id) => id.startsWith('anime.')).length, 0, 'purged grants gone from bob')
  assert.strictEqual((await api('GET', '/api/sources', undefined, token)).body.length, 0, 'registry empty')
  log('J: keepChannels detaches (grants kept), plain remove purges channels+grants, manual survives ✓')

  // ===== Test K: source/operator split — sync owns MEMBERSHIP, catmeta owns PRESENTATION =====
  // The whole point of the presentation registry: a provider feed rewrites which channels
  // carry its category on every sync, while the operator's label/order/hidden live in a
  // DIFFERENT keyspace and therefore cannot be clobbered. Before this split, manual edits
  // to a source-mapped field simply did not stick (admin-ui/app.js said so in a hint).
  feeds['/kids.json'] = { channels: [
    { id: 'k1', name: 'Kid One', url: 'https://cdn.example/k1.m3u8' },
    { id: 'k2', name: 'Kid Two', url: 'https://cdn.example/k2.m3u8' }
  ] }; rev++ // bump or the ETag serves a 304 and the sync no-ops
  r = await api('POST', '/api/sources', { name: 'split', url: feedBase + '/kids.json', category: 'Kids' }, token)
  assert.strictEqual(r.status, 201, 'source re-created for the split test')
  assert.strictEqual((await api('POST', '/api/sources/split/sync', undefined, token)).body.added, 2, 'first sync imported')

  // operator sets presentation on the source's category
  await ops.upsertCategory(ctx, 'Kids', { label: 'Children', order: 7, hidden: true })
  const before = (await db.get('catmeta/Kids')).value

  // provider changes membership: k2 disappears, k3 arrives
  feeds['/kids.json'] = { channels: [
    { id: 'k1', name: 'Kid One', url: 'https://cdn.example/k1.m3u8' },
    { id: 'k3', name: 'Kid Three', url: 'https://cdn.example/k3.m3u8' }
  ] }; rev++
  r = await api('POST', '/api/sources/split/sync', undefined, token)
  assert.ok(r.body.added === 1 && r.body.removed === 1, 'sync still owns membership')

  const after = (await db.get('catmeta/Kids')).value
  assert.deepStrictEqual(after, before, 'sync did NOT touch the operator presentation')
  assert.strictEqual(after.label, 'Children', 'operator label survived a sync')
  assert.strictEqual(after.hidden, true, 'operator hidden flag survived a sync')
  assert.deepStrictEqual((await db.get('catalog/split.k3')).value.category, ['Kids'], 'new channel carries the source category')

  // Renaming the RAIL of a source-owned category: the honest, two-sided answer.
  await ops.renameCategory(ctx, 'Kids', 'Infantil')
  assert.deepStrictEqual((await db.get('catalog/split.k1')).value.category, ['Infantil'], 'rename moved the channel')

  // (a) an unchanged feed (ETag 304) never refetches, so the rename simply stands
  await api('POST', '/api/sources/split/sync', undefined, token)
  assert.deepStrictEqual((await db.get('catalog/split.k1')).value.category, ['Infantil'], 'a 304 sync leaves the operator rename alone')

  // (b) but a real refetch reasserts the SOURCE's category, because membership is the
  // source's half of the split. Renaming a source-owned rail therefore means renaming
  // the SOURCE's category (PATCH /api/sources/:name), not just the catmeta entry.
  rev++
  await api('POST', '/api/sources/split/sync', undefined, token)
  assert.deepStrictEqual((await db.get('catalog/split.k1')).value.category, ['Kids'], 'a real re-sync reasserts the source category — membership is the source half')
  r = await api('PATCH', '/api/sources/split', { category: 'Infantil' }, token)
  assert.strictEqual(r.status, 200, 'rename the SOURCE category')
  rev++
  await api('POST', '/api/sources/split/sync', undefined, token)
  assert.deepStrictEqual((await db.get('catalog/split.k1')).value.category, ['Infantil'], 'source-category rename is the durable way to move an imported rail')
  log('K: source/operator split — sync owns membership, catmeta presentation survives sync ✓')

  // ===== Test L: M3U playlists — groups, slug ids, playback headers =====
  // The live-events shape: entries in several group-titles, #EXTVLCOPT header lines,
  // a header value poisoned with a bare CR, two entries that slug to the same id, and
  // URLs whose token the provider rotates. Everything the operator's real playlist has.
  const eventsM3U = (tok) => [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id=".dummy." tvg-name="Alpha" tvg-logo="https://img.example/alpha.png" group-title="Live Events",Alpha vs Beta',
    '#EXTVLCOPT:http-referrer=https://provider.example/',
    '#EXTVLCOPT:http-origin=https://provider.example',
    '#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Aliran)',
    `https://cdn.example/e/alpha.m3u8?token=${tok}`,
    '#EXTINF:-1 group-title="Live Events",Gamma vs Delta',
    `https://cdn.example/e/gamma.m3u8?token=${tok}`,
    '#EXTINF:-1 tvg-logo="https://img.example/movie.png" group-title="Movies",Some Movie',
    'https://cdn.example/m/movie.m3u8',
    '#EXTINF:-1 group-title="Live Events",Poison Match',
    '#EXTVLCOPT:http-referrer=https://provider.example/ok',
    '#EXTVLCOPT:http-user-agent=Bad\rUA: injected', // bare CR — this ONE key must degrade away
    `https://cdn.example/e/poison.m3u8?token=${tok}`,
    '#EXTINF:-1 group-title="Live Events",Alpha vs Beta', // same name again → -2 suffix
    `https://cdn.example/e/alpha-backup.m3u8?token=${tok}`,
    ''
  ].join('\n')
  texts['/events.m3u'] = eventsM3U('t1'); rev++

  // groups deliberately lower-cased here: the match is case-insensitive and exact.
  r = await api('POST', '/api/sources', { name: 'events', url: eventsUrl, format: 'm3u', category: 'Live Events', groups: ['live events'], prefix: 'ev.' }, token)
  assert.strictEqual(r.status, 201, 'add m3u source: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.format, 'm3u')
  assert.deepStrictEqual(r.body.groups, ['live events'])
  r = await api('POST', '/api/sources', { name: 'badfmt', url: eventsUrl, format: 'xspf', category: 'X' }, token)
  assert.strictEqual(r.status, 400, 'unknown format must be rejected')

  r = await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual(r.status, 200, 'm3u sync: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.added, 4, 'four Live Events entries imported')
  assert.strictEqual(r.body.filtered, 1, 'the Movies entry is outside the groups — filtered, not skipped')
  assert.strictEqual(r.body.skippedCount, 0, 'nothing invalid in the playlist')

  const alpha = (await db.get('catalog/ev.Alpha-vs-Beta')).value
  assert.ok(alpha, 'id slugged from the display name, with the source prefix')
  assert.strictEqual(alpha.title, 'Alpha vs Beta')
  assert.strictEqual(alpha.url, 'https://cdn.example/e/alpha.m3u8?token=t1')
  assert.strictEqual(alpha.logo, 'https://img.example/alpha.png')
  assert.deepStrictEqual(alpha.category, ['Live Events'])
  assert.deepStrictEqual(alpha.headers, {
    referer: 'https://provider.example/',
    origin: 'https://provider.example',
    'user-agent': 'Mozilla/5.0 (Aliran)'
  }, 'EXTVLCOPT lines land as lowercase-keyed catalog headers')
  assert.strictEqual(alpha.epgUrl, null, 'a playlist is not a program guide')
  assert.strictEqual(alpha.epgId, null)
  assert.strictEqual((await db.get('catalog/ev.Gamma-vs-Delta')).value.headers, null, 'an entry with no EXTVLCOPT lines has no headers')
  const poison = (await db.get('catalog/ev.Poison-Match')).value
  assert.ok(poison, 'the entry with a poisoned header line is still imported')
  assert.deepStrictEqual(poison.headers, { referer: 'https://provider.example/ok' }, 'the CR-poisoned user-agent degraded away, the good key survived')
  assert.ok((await db.get('catalog/ev.Alpha-vs-Beta-2')), 'a name collision inside one playlist gets a -2 suffix')
  assert.strictEqual((await db.get('catalog/ev.Some-Movie')), null, 'a filtered group is never imported')
  assert.ok((await db.get('user/bob')).value.wrapped['ev.Alpha-vs-Beta'], 'imported events auto-granted')

  r = await api('GET', '/api/sources/events/channels', undefined, token)
  assert.ok(r.body.channels.some((c) => c.feedId === 'Alpha-vs-Beta'), 'channels dialog reports the slug as the feed id (no epgId to fall back on): ' + JSON.stringify(r.body.channels.map((c) => c.feedId)))
  const evRow = (await api('GET', '/api/sources', undefined, token)).body.find((s) => s.name === 'events')
  assert.strictEqual(evRow.lastReport.filtered, 1, 'the filtered count reaches the dashboard report')

  // Token rotation: the same events, new URLs. The stringify guard must NOT suppress
  // these — this is exactly how a fresh token reaches viewers.
  const vTok = db.version
  texts['/events.m3u'] = eventsM3U('t2'); rev++
  r = await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual(r.body.updated, 4, 'rotated tokens produce updated puts: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.added + r.body.removed, 0, 'a token rotation is not a channel change')
  assert.ok(db.version > vTok, 'rotated URLs really append')
  assert.strictEqual((await db.get('catalog/ev.Alpha-vs-Beta')).value.url, 'https://cdn.example/e/alpha.m3u8?token=t2')

  // …and an UNCHANGED playlist still costs nothing.
  const vIdem = db.version
  r = await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual(r.body.notModified, true, 'unchanged m3u revalidates to 304')
  assert.strictEqual(db.version, vIdem, 'a 304 m3u sync appends nothing to the bee')

  // Exclusion works on the SLUG (the m3u has no feed ids of its own).
  r = await api('PATCH', '/api/sources/events', { exclude: [{ id: 'Gamma-vs-Delta', title: 'Gamma vs Delta' }] }, token)
  assert.strictEqual(r.status, 200)
  r = await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual(r.body.removed, 1, 'excluded slug removed')
  assert.strictEqual(r.body.excluded, 1)
  assert.strictEqual((await db.get('catalog/ev.Gamma-vs-Delta')), null)
  await api('PATCH', '/api/sources/events', { exclude: [] }, token)
  r = await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual(r.body.added, 1, 're-included slug comes back')

  // A filter/format edit must reset the ETag, or a 304 would mask it.
  let reg = sources.loadSources(dir).events
  assert.ok(reg.etag, 'a synced source holds an etag')
  await api('PATCH', '/api/sources/events', { groups: ['live events', 'movies'] }, token)
  assert.strictEqual(sources.loadSources(dir).events.etag, null, 'a groups change resets the etag')
  r = await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual(r.body.notModified, false, 'the widened filter really re-read the body')
  assert.strictEqual(r.body.added, 1, 'the Movies entry joins once its group is selected')
  assert.strictEqual(r.body.filtered, 0)
  await api('PATCH', '/api/sources/events', { groups: ['live events'] }, token)
  await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual((await db.get('catalog/ev.Some-Movie')), null, 'narrowing the filter takes its channels back out')
  reg = sources.loadSources(dir).events
  assert.ok(reg.etag, 'etag re-established after the sync')

  // A group the provider renamed (or the operator mistyped) matches NOTHING. Pruning the
  // rail is correct — the feed is the membership — but it must not happen in silence.
  await api('PATCH', '/api/sources/events', { groups: ['Live Eventz'] }, token)
  r = await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual(r.body.added + r.body.updated, 0, 'a filter that matches nothing imports nothing')
  assert.strictEqual(r.body.removed, 4, 'and prunes the whole rail')
  assert.strictEqual(r.body.emptiedByFilter, true, 'the report FLAGS an empty-filter prune instead of doing it quietly')
  await api('PATCH', '/api/sources/events', { groups: ['live events'] }, token)
  r = await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual(r.body.added, 4, 'fixing the group name brings the rail back')
  assert.strictEqual(r.body.emptiedByFilter, false, 'and the flag clears')

  await api('PATCH', '/api/sources/events', { format: 'json' }, token)
  assert.strictEqual(sources.loadSources(dir).events.etag, null, 'a format change resets the etag too')

  // Cross-format bodies: a pointed hint, and the last good state untouched.
  r = await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual(r.status, 400, 'a playlist on a json source fails')
  assert.match(r.body.error, /set the source format to m3u/, 'the error names the fix: ' + r.body.error)
  assert.ok((await db.get('catalog/ev.Alpha-vs-Beta')), 'the failed sync kept the last good channels')
  await api('PATCH', '/api/sources/events', { format: 'm3u', url: feedBase + '/anime.json' }, token)
  r = await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual(r.status, 400, 'JSON on an m3u source fails')
  assert.match(r.body.error, /set the source format to json/, 'the reverse hint: ' + r.body.error)
  assert.ok((await db.get('catalog/ev.Alpha-vs-Beta')), 'still the last good channels')
  await api('PATCH', '/api/sources/events', { url: eventsUrl }, token)
  r = await api('POST', '/api/sources/events/sync', undefined, token)
  assert.strictEqual(r.status, 200, 'back on the playlist, the source recovers')
  assert.strictEqual((await api('GET', '/api/sources', undefined, token)).body.find((s) => s.name === 'events').lastError, null, 'recovery clears lastError')
  // Two parser traps, checked directly because neither can be provoked through a normal
  // playlist without distorting the counts above.
  const trap = sources.parseM3U('#EXTM3U\n#EXTINF:-1 group-title="Live Events",Movie group-title="Movies" special\nhttps://cdn.example/x.m3u8\n')
  assert.strictEqual(trap.entries[0].group, 'Live Events', 'a group-title written inside the TITLE cannot override the real group')
  assert.strictEqual(trap.entries[0].name, 'Movie group-title="Movies" special', 'and the title keeps that text verbatim')
  const decapitated = sources.parseM3U('#EXTM3U\nhttps://cdn.example/orphan.m3u8\nhttps://cdn.example/orphan2.m3u8\n')
  assert.strictEqual(decapitated.entries.length, 0)
  assert.strictEqual(decapitated.stray, 2, 'urls with no #EXTINF are COUNTED — "0 added, 0 skipped" must be impossible on a broken playlist')
  log('L: m3u — group filter + filtered count, slug ids with -2 dedup, EXTVLCOPT headers (per-key degrade), null EPG, exclude-by-slug, token rotation appends, 304 idempotency, empty-filter prune flagged, format hints keep last good state, title/stray parser traps ✓')

  // ===== Test M: redirect playback headers over the admin API (Part A) =====
  r = await api('POST', '/api/streams', { id: 'hdr-one', url: 'https://cdn.example/hdr.m3u8', headers: { Referer: 'https://provider.example/', 'USER-AGENT': ' Mozilla/5.0 ' } }, token)
  assert.strictEqual(r.status, 201, 'create a redirect channel with headers: ' + JSON.stringify(r.body))
  let hdr = (await db.get('catalog/hdr-one')).value
  assert.deepStrictEqual(hdr.headers, { referer: 'https://provider.example/', 'user-agent': 'Mozilla/5.0' }, 'keys lowercased, values trimmed')

  r = await api('POST', '/api/streams', { id: 'hdr-two', headers: { referer: 'https://provider.example/' } }, token)
  assert.strictEqual(r.status, 400, 'headers without a redirect url must be rejected')
  r = await api('POST', '/api/streams', { id: 'hdr-two', url: 'https://cdn.example/x.m3u8', headers: { authorization: 'Bearer x' } }, token)
  assert.strictEqual(r.status, 400, 'a header outside the allowlist must be rejected')
  assert.match(r.body.error, /referer, origin and user-agent/)

  r = await api('PATCH', '/api/streams/hdr-one', { headers: { referrer: 'https://other.example/' } }, token)
  assert.strictEqual(r.status, 200, 'the referrer alias is accepted')
  hdr = (await db.get('catalog/hdr-one')).value
  assert.deepStrictEqual(hdr.headers, { referer: 'https://other.example/' }, 'alias folds onto referer, and the patch REPLACES the map')
  r = await api('PATCH', '/api/streams/hdr-one', { headers: {} }, token)
  assert.strictEqual((await db.get('catalog/hdr-one')).value.headers, null, 'an empty object clears')

  await api('PATCH', '/api/streams/hdr-one', { headers: { origin: 'https://provider.example' } }, token)
  r = await api('PATCH', '/api/streams/hdr-one', { url: '' }, token)
  assert.strictEqual(r.status, 200, 'clearing the url: ' + JSON.stringify(r.body))
  hdr = (await db.get('catalog/hdr-one')).value
  assert.strictEqual(hdr.url, null)
  assert.strictEqual(hdr.headers, null, 'clearing the url clears the headers with it')
  r = await api('PATCH', '/api/streams/hdr-one', { headers: { origin: 'https://provider.example' } }, token)
  assert.strictEqual(r.status, 400, 'headers on a channel with no url are refused whatever the field order')
  log('M: redirect headers — stored lowercase/trimmed, allowlist enforced, no-url refused, url-clear clears them ✓')

  // ===== Test N: a FAILING source keeps its own retry cadence =====
  // lastSync is stamped on SUCCESS only, so a due-check that reads it alone leaves a
  // broken source permanently due — it would re-fetch on EVERY tick, and the tick default
  // is 5 minutes. The due-check reads the last ATTEMPT instead, so a failure waits.
  r = await api('POST', '/api/sources', { name: 'broken', url: 'http://127.0.0.1:9/nothing.json', category: 'Broken', intervalMs: 60000 }, token)
  assert.strictEqual(r.status, 201)
  r = await api('POST', '/api/sources/broken/sync', undefined, token)
  assert.strictEqual(r.status, 400, 'the unreachable source fails as expected')
  const errAt = sources.loadSources(dir).broken.lastErrorAt
  assert.ok(errAt, 'the failure stamped lastErrorAt')
  const sched2 = sources.makeSourcesScheduler(ctx, { tickMs: 1e9, bootDelayMs: 1e9 })
  cleanups.push(() => sched2.close())
  await sched2.tick()
  assert.strictEqual(sources.loadSources(dir).broken.lastErrorAt, errAt, 'a source that just failed is NOT retried on the next tick')
  sched2.close()
  log('N: a failing source is not re-fetched every tick — the retry floor holds ✓')

  log('\nPASS: remote channel sources e2e (S27)')
  await cleanup()
  process.exit(0)
} catch (err) {
  console.error('\nFAIL:', err)
  await cleanup()
  process.exit(1)
}
