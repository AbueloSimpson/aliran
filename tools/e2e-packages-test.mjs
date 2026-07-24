// End-to-end test for channel packages / bouquets (S44). Deterministic:
// in-process panel store + admin server + a loopback HTTP feed server for the
// source-coexistence cases — no DHT, no ffmpeg (belongs in the REQUIRED core CI
// lane, like test:sources).
//
// Covers: package CRUD validation → member selectors (explicit id, id glob,
// category:<slug> incl. parent-covers-child, source:<name>) resolving against
// the live catalog → assignment materializing SEALED grants → the provenance
// split (manualGrants vs packages vs source auto-grants) → revoke removing the
// manual entitlement while a covering package re-seals → package removal
// keeping manual grants → reconcile triggers (stream add/retag/delete, source
// sync picking up feed drift for source: members) → default packages at
// createUser beside the S27 auto-grant hook → autoGrant coexistence (a package
// reconcile never touches autoGrant-source grants; flipping autoGrant off hands
// them to package/manual governance) → pre-S44 record migration (additive,
// auto-grants not misattributed as manual) → bee idempotency (a converged
// reconcile appends nothing). Exits 0 on PASS.
import assert from 'assert'
import http from 'http'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, loadSecrets } from '../panel/src/store.js'
import { makeRing } from '../panel/src/activity.js'
import * as ops from '../panel/src/ops.js'
import * as packages from '../panel/src/packages.js'
import { startAdminServer } from '../panel/src/admin-server.js'

const log = (...a) => console.log(...a)

const ADMIN_PASSWORD = 'correct-horse-battery'

// Fast Argon2 (argonOpts clamps to the sodium minimums).
const config = {
  argon2: { memKiB: 8192, time: 1 },
  maxDevicesDefault: 2
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2epkg-'))
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }

// ---------------------------------------------------------------- feed server
// Mutable per-path feeds + ETag (`"v<rev>"`) — the source-coexistence cases need
// real syncs of a changing feed.
const feeds = { '/anime.json': null, '/movies.json': null }
let rev = 1
const feedSrv = http.createServer((req, res) => {
  const feed = feeds[req.url.split('?')[0]]
  if (!feed) { res.writeHead(404); res.end(); return }
  const etag = `"v${rev}"`
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return }
  const body = JSON.stringify(feed)
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), etag })
  res.end(body)
})
await new Promise((r) => feedSrv.listen(0, '127.0.0.1', r))
cleanups.push(() => new Promise((r) => feedSrv.close(r)))
const feedBase = `http://127.0.0.1:${feedSrv.address().port}`

try {
  // ===== panel store + admin server (in-process, same shape as e2e-sources) =====
  initKeys(dir)
  const keys = openKeys(dir)
  const { store, db, assets } = await openStore(dir, keys); cleanups.push(() => store.close())
  const ring = makeRing(200)
  const ctx = { config, keys, db, assets, dataDir: dir, activity: ring }
  ops.addAdmin(ctx, 'root', ADMIN_PASSWORD)
  const { port, close } = await startAdminServer(ctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 5, seconds: 60 } })
  cleanups.push(close)
  const base = `http://127.0.0.1:${port}`
  const api = async (method, p, body, tok) => {
    const headers = {}
    if (tok) headers.authorization = 'Bearer ' + tok
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  const token = (await api('POST', '/api/login', { username: 'root', password: ADMIN_PASSWORD })).body.token
  assert.ok(token, 'admin login')
  const getUser = async (u) => (await api('GET', '/api/users/' + u, undefined, token)).body

  // Catalog the selectors resolve against, and a user that PRE-DATES every
  // package (bob must never receive a default).
  for (const [id, category] of [['news', 'News'], ['espn-east', 'Deportes'], ['espn-west', 'Deportes'], ['kids-tv', 'Kids/Junior']]) {
    const r = await api('POST', '/api/streams', { id, category }, token)
    assert.strictEqual(r.status, 201, 'add stream ' + id)
  }
  await api('POST', '/api/users', { username: 'bob', password: 'bob-secret-1' }, token)

  // ===== Test A: CRUD validation + registry basics =====
  let r = await api('POST', '/api/packages', { name: 'bad name!' }, token)
  assert.strictEqual(r.status, 400, 'invalid package name must be rejected')
  r = await api('POST', '/api/packages', { name: 'basic', members: 'category:' }, token)
  assert.strictEqual(r.status, 400, 'empty category selector must be rejected')
  r = await api('POST', '/api/packages', { name: 'basic', members: 'category:a/b/c' }, token)
  assert.strictEqual(r.status, 400, 'three-level category selector must be rejected')
  r = await api('POST', '/api/packages', { name: 'basic', members: 'source:no way' }, token)
  assert.strictEqual(r.status, 400, 'invalid source selector must be rejected')
  r = await api('POST', '/api/packages', { name: 'basic', members: 'bad id!' }, token)
  assert.strictEqual(r.status, 400, 'invalid member id must be rejected')
  r = await api('POST', '/api/packages', { name: 'basic', members: 'a'.repeat(64) + '*' }, token)
  assert.strictEqual(r.status, 400, 'oversized glob must be rejected')
  r = await api('POST', '/api/packages', { name: 'basic', label: 'x'.repeat(65) }, token)
  assert.strictEqual(r.status, 400, 'oversized label must be rejected')
  r = await api('POST', '/api/packages', { name: 'basic', label: 'Basic', members: 'news, news', default: true }, token)
  assert.strictEqual(r.status, 201, 'add package: ' + JSON.stringify(r.body))
  assert.deepStrictEqual(r.body.members, ['news'], 'members deduped')
  assert.strictEqual(r.body.default, true)
  r = await api('POST', '/api/packages', { name: 'basic', members: 'news' }, token)
  assert.strictEqual(r.status, 409, 'duplicate package must be 409')
  r = await api('GET', '/api/packages', undefined, token)
  assert.strictEqual(r.body.length, 1)
  assert.deepStrictEqual(r.body[0].resolved, ['news'])
  assert.strictEqual(r.body[0].holders, 0, 'nobody holds it yet')
  assert.ok(fs.existsSync(path.join(dir, 'packages.json')), 'registry is DATA_DIR/packages.json (plain, not secrets/)')
  assert.ok(ring.list().some((e) => e.type === 'admin' && e.op === 'package-create' && e.package === 'basic'), 'activity ring records the create')
  log('A: package CRUD validation, dedupe, duplicate 409, plain registry file, activity ring ✓')

  // ===== Test B: member selectors resolve against the catalog =====
  await api('POST', '/api/packages', { name: 'sports', members: 'category:Deportes' }, token)
  await api('POST', '/api/packages', { name: 'globs', members: 'espn-*' }, token)
  await api('POST', '/api/packages', { name: 'kids', members: 'category:Kids' }, token)
  r = await api('GET', '/api/packages/sports', undefined, token)
  assert.deepStrictEqual(r.body.resolved, ['espn-east', 'espn-west'], 'category selector resolves')
  r = await api('GET', '/api/packages/globs', undefined, token)
  assert.deepStrictEqual(r.body.resolved, ['espn-east', 'espn-west'], 'id glob resolves (publisher-scope matcher)')
  r = await api('GET', '/api/packages/kids', undefined, token)
  assert.deepStrictEqual(r.body.resolved, ['kids-tv'], "parent selector covers 'Kids/Junior'")
  r = await api('GET', '/api/packages/nope', undefined, token)
  assert.strictEqual(r.status, 404)
  log('B: selectors — category (incl. parent→child), id glob, explicit id all resolve ✓')

  // ===== Test C: assignment materializes SEALED grants =====
  r = await api('POST', '/api/users/bob/packages', { packages: ['nope'] }, token)
  assert.strictEqual(r.status, 404, 'assigning an unknown package must fail')
  r = await api('POST', '/api/users/bob/packages', { packages: ['sports'] }, token)
  assert.strictEqual(r.status, 200, 'assign: ' + JSON.stringify(r.body))
  assert.deepStrictEqual(r.body.packages, ['sports'])
  assert.deepStrictEqual(r.body.manualGrants, [], 'package grants are NOT manual')
  assert.ok(r.body.grants.includes('espn-east') && r.body.grants.includes('espn-west'), 'both channels granted')
  const bobRec = (await db.get('user/bob')).value
  assert.ok(bobRec.wrapped['espn-east'] && bobRec.wrapped['espn-west'], 'sealed entries exist in the record')
  // The sealed blob is the same shape ops.grant produces — the wire format the
  // client unseals at login is untouched by the packages machinery.
  await api('POST', '/api/users/bob/grants', { streamId: 'news' }, token)
  const bobRec2 = (await db.get('user/bob')).value
  assert.strictEqual(typeof bobRec2.wrapped['espn-east'], typeof bobRec2.wrapped.news, 'package seal ≡ manual seal shape')
  r = await api('GET', '/api/packages', undefined, token)
  assert.strictEqual(r.body.find((p) => p.name === 'sports').holders, 1, 'holder count tracks assignment')
  log('C: assignment seals the resolved members; unknown package 404; holder count ✓')

  // ===== Test D: provenance — revoke removes the MANUAL entitlement =====
  r = await getUser('bob')
  assert.deepStrictEqual(r.manualGrants, ['news'], 'manual grant recorded')
  await api('POST', '/api/users/bob/grants', { streamId: 'espn-east' }, token) // dual provenance: manual + package
  r = await getUser('bob')
  assert.ok(r.manualGrants.includes('espn-east'))
  r = (await api('DELETE', '/api/users/bob/grants/espn-east', undefined, token)).body
  assert.ok(!r.manualGrants.includes('espn-east'), 'manual entitlement removed')
  assert.ok(r.grants.includes('espn-east'), 'the covering package re-sealed it — access remains, now package-only')
  r = (await api('DELETE', '/api/users/bob/grants/espn-west', undefined, token)).body
  assert.ok(r.grants.includes('espn-west'), 'revoking a pure package grant converges back (the package still covers it)')
  r = (await api('POST', '/api/users/bob/packages', { packages: [] }, token)).body
  assert.ok(!r.grants.includes('espn-east') && !r.grants.includes('espn-west'), 'unassigning the package removes its channels')
  assert.deepStrictEqual(r.grants, ['news'], 'the manual grant survives')
  log('D: revoke = remove manual (package re-seals); unassign removes package channels, manual survives ✓')

  // ===== Test E: package REMOVAL keeps manual + other-package grants =====
  await api('POST', '/api/users/bob/packages', { packages: ['sports', 'globs'] }, token)
  await api('POST', '/api/users/bob/grants', { streamId: 'espn-east' }, token) // manual on top
  r = (await api('DELETE', '/api/packages/sports', undefined, token)).body
  assert.strictEqual(r.removed, true)
  r = await getUser('bob')
  assert.deepStrictEqual(r.packages, ['globs'], 'removed package stripped from the user')
  assert.ok(r.grants.includes('espn-east') && r.grants.includes('espn-west'), "channels survive — still covered by 'globs' + manual")
  await api('POST', '/api/users/bob/packages', { packages: [] }, token)
  r = await getUser('bob')
  assert.deepStrictEqual(r.grants.sort(), ['espn-east', 'news'], 'without any package: manual espn-east + news remain, espn-west gone')
  r = await api('GET', '/api/packages/sports', undefined, token)
  assert.strictEqual(r.status, 404, 'registry entry gone')
  await api('POST', '/api/packages', { name: 'sports', members: 'category:Deportes' }, token) // re-create for later tests
  log('E: removePackage strips assignments + uncovered grants; manual and other-package grants survive ✓')

  // ===== Test F: reconcile triggers — stream add / retag / delete =====
  await api('POST', '/api/users', { username: 'carol', password: 'carol-secret-1' }, token) // gets default 'basic' (news)
  await api('POST', '/api/users/carol/packages', { packages: ['basic', 'sports'] }, token)
  await api('POST', '/api/users/bob/packages', { packages: ['globs'] }, token)
  r = await api('POST', '/api/streams', { id: 'espn-new', category: 'Deportes' }, token)
  assert.strictEqual(r.status, 201)
  assert.ok((await getUser('bob')).grants.includes('espn-new'), 'glob member covers a NEWLY ADDED id immediately')
  assert.ok((await getUser('carol')).grants.includes('espn-new'), 'category member covers it too')
  await api('PATCH', '/api/streams/espn-new', { category: ['Movies'] }, token)
  r = await getUser('carol')
  assert.ok(!r.grants.includes('espn-new'), 'retag moved it out of the category member — carol loses it')
  assert.ok((await getUser('bob')).grants.includes('espn-new'), 'the id still matches the glob — bob keeps it')
  await api('PATCH', '/api/streams/espn-new', { category: ['Deportes'] }, token)
  assert.ok((await getUser('carol')).grants.includes('espn-new'), 'retag back re-seals for carol')
  await api('DELETE', '/api/streams/espn-new', undefined, token)
  r = await getUser('bob')
  assert.ok(!r.grants.includes('espn-new'), 'deleteStream purges the grant')
  assert.strictEqual(loadSecrets(dir)['espn-new'], undefined, 'secret purged')
  // Explicit member for a stream that does not exist yet: seals nothing now,
  // materializes the moment the stream is added.
  await api('POST', '/api/packages', { name: 'future', members: 'later-ch' }, token)
  await api('POST', '/api/users/bob/packages', { packages: ['globs', 'future'] }, token)
  assert.ok(!(await getUser('bob')).grants.includes('later-ch'), 'nothing to seal before the stream exists')
  await api('POST', '/api/streams', { id: 'later-ch' }, token)
  assert.ok((await getUser('bob')).grants.includes('later-ch'), 'add-stream materializes the pre-declared member')
  log('F: triggers — add/retag/delete converge holders; explicit member waits for its stream ✓')

  // ===== Test G: defaults at createUser + S27 auto-grant hook coexist =====
  feeds['/anime.json'] = { channels: [{ id: 'a1', name: 'Anime One', url: 'https://cdn.example/a1.m3u8' }, { id: 'a2', name: 'Anime Two', url: 'https://cdn.example/a2.m3u8' }] }
  r = await api('POST', '/api/sources', { name: 'anime', url: feedBase + '/anime.json', category: 'Anime' }, token)
  assert.strictEqual(r.status, 201)
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.strictEqual(r.body.added, 2, 'source imported')
  assert.ok((await getUser('bob')).grants.includes('anime.a1'), 'existing users got the autoGrant channels')
  r = (await api('POST', '/api/users', { username: 'dave', password: 'dave-secret-1' }, token)).body
  assert.deepStrictEqual(r.packages, ['basic'], 'default package assigned at creation')
  assert.ok(r.grants.includes('news'), 'default package materialized in the create response')
  assert.ok(r.grants.includes('anime.a1') && r.grants.includes('anime.a2'), 'S27 auto-grant hook still works beside defaults')
  assert.deepStrictEqual(r.manualGrants, [], 'neither hook misattributes as manual')
  log('G: createUser — default package + source auto-grant both land, provenance clean ✓')

  // ===== Test H: a package GOVERNS an autoGrant-off source =====
  feeds['/movies.json'] = { channels: [{ id: 'm1', name: 'Movie One', url: 'https://cdn.example/m1.m3u8' }, { id: 'm2', name: 'Movie Two', url: 'https://cdn.example/m2.m3u8' }] }
  await api('POST', '/api/sources', { name: 'movies', url: feedBase + '/movies.json', category: 'Movies', autoGrant: false }, token)
  r = await api('POST', '/api/sources/movies/sync', undefined, token)
  assert.strictEqual(r.body.added, 2)
  assert.strictEqual(r.body.granted, 0, 'autoGrant off — the source grants nobody')
  assert.ok(!(await getUser('dave')).grants.includes('movies.m1'), 'no auto grant')
  await api('POST', '/api/packages', { name: 'cinema', members: 'source:movies' }, token)
  await api('POST', '/api/users/dave/packages', { packages: ['basic', 'cinema'] }, token)
  r = await getUser('dave')
  assert.ok(r.grants.includes('movies.m1') && r.grants.includes('movies.m2'), 'source: member grants the holder')
  assert.ok(!(await getUser('carol')).grants.includes('movies.m1'), 'non-holders stay ungranted')
  // Feed drift: m2 leaves, m3 arrives — the SYNC reconcile follows the member.
  feeds['/movies.json'] = { channels: [{ id: 'm1', name: 'Movie One', url: 'https://cdn.example/m1.m3u8' }, { id: 'm3', name: 'Movie Three', url: 'https://cdn.example/m3.m3u8' }] }
  rev++
  r = await api('POST', '/api/sources/movies/sync', undefined, token)
  assert.ok(r.body.added === 1 && r.body.removed === 1, 'feed drift applied')
  r = await getUser('dave')
  assert.ok(!r.grants.includes('movies.m2'), 'channel that left the feed is gone')
  assert.ok(r.grants.includes('movies.m3'), 'newly imported channel joined the bouquet WITHOUT a package edit')
  await api('POST', '/api/users/dave/packages', { packages: ['basic'] }, token)
  r = await getUser('dave')
  assert.ok(!r.grants.includes('movies.m1') && !r.grants.includes('movies.m3'), 'unassigning removes autoGrant-OFF source channels (no carve-out)')
  rev++ // force a full 200 re-fetch (not a 304) so the sync exercises the whole path
  await api('POST', '/api/sources/movies/sync', undefined, token)
  assert.ok(!(await getUser('dave')).grants.includes('movies.m1'), 'a later sync does NOT flap them back (autoGrant off)')
  log('H: source:-member bouquet governs an autoGrant-off source; follows feed drift; no flap-back ✓')

  // ===== Test I: autoGrant coexistence — package ops never touch auto grants =====
  await api('PATCH', '/api/packages/basic', { members: 'news, kids-tv' }, token) // a full reconcile runs here
  r = await getUser('bob')
  assert.ok(r.grants.includes('anime.a1') && r.grants.includes('anime.a2'), 'package reconcile leaves autoGrant-source grants alone')
  // Flipping autoGrant OFF hands the source's channels to package/manual
  // governance: the next reconcile removes what nothing covers (no silent
  // permanent grants), and re-enabling + sync restores the baseline.
  await api('PATCH', '/api/sources/anime', { autoGrant: false }, token)
  await api('PATCH', '/api/packages/basic', { label: 'Basic tier' }, token) // any package op reconciles
  r = await getUser('bob')
  assert.ok(!r.grants.includes('anime.a1'), 'autoGrant off → formerly-auto grants converge away (nothing covers them)')
  await api('PATCH', '/api/sources/anime', { autoGrant: true }, token)
  r = await api('POST', '/api/sources/anime/sync', undefined, token)
  assert.ok(r.body.granted > 0, 're-enable + sync restores')
  assert.ok((await getUser('bob')).grants.includes('anime.a1'), 'auto grants back after re-enable')
  log('I: coexistence — auto grants survive package ops; autoGrant off converges them away; re-enable restores ✓')

  // ===== Test J: pre-S44 record migration (additive, attribution-correct) =====
  await api('POST', '/api/users', { username: 'erin', password: 'erin-secret-1' }, token)
  await api('POST', '/api/users/erin/grants', { streamId: 'espn-east' }, token)
  // Rewrite erin as a LEGACY record: no provenance fields at all (the pre-S44
  // shape) — wrapped keeps the manual grant, the default-package news grant and
  // the anime auto-grants indistinguishably mixed, like a real upgrade.
  const legacy = (await db.get('user/erin')).value
  delete legacy.manualGrants
  delete legacy.packages
  await db.put('user/erin', legacy)
  const before = Object.keys((await db.get('user/erin')).value.wrapped).sort()
  const rec = await packages.reconcilePackages(ctx) // the panel-boot migration path
  const erin = (await db.get('user/erin')).value
  assert.deepStrictEqual(Object.keys(erin.wrapped).sort(), before, 'migration is ADDITIVE — no grant removed')
  assert.deepStrictEqual(erin.manualGrants.sort(), ['espn-east', 'kids-tv', 'news'], 'non-auto grants adopted as manual (news/kids-tv were package-derived, but a legacy record cannot know that)')
  assert.ok(!erin.manualGrants.includes('anime.a1'), 'autoGrant-source grants NOT misattributed as manual')
  assert.deepStrictEqual(erin.packages, [], 'legacy record starts with no packages')
  assert.ok(rec.users >= 1, 'migration wrote the record')
  // Converged: a second full reconcile appends NOTHING to the bee.
  const v = db.version
  const rec2 = await packages.reconcilePackages(ctx)
  assert.deepStrictEqual(rec2, { sealed: 0, removed: 0, users: 0 }, 'second pass is a no-op')
  assert.strictEqual(db.version, v, 'converged reconcile appends nothing')
  log('J: migration — additive, auto-grants stay unattributed, converged reconcile appends zero ✓')

  // ===== Test K: listing counts + user summary provenance =====
  r = await api('GET', '/api/packages', undefined, token)
  const byName = Object.fromEntries(r.body.map((p) => [p.name, p]))
  assert.strictEqual(byName.basic.holders, 2, 'carol + dave hold basic')
  assert.strictEqual(byName.basic.label, 'Basic tier')
  assert.deepStrictEqual(byName.basic.resolved.sort(), ['kids-tv', 'news'])
  r = await getUser('carol')
  assert.deepStrictEqual(r.packages.sort(), ['basic', 'sports'], 'summary carries the package list')
  assert.ok(Array.isArray(r.manualGrants), 'summary carries manualGrants')
  log('K: listing resolved/holder counts + summary provenance ✓')

  log('\nPASS: channel packages e2e (S44)')
  await cleanup()
  process.exit(0)
} catch (err) {
  console.error('\nFAIL:', err)
  await cleanup()
  process.exit(1)
}
