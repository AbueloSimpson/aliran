// End-to-end test for the panel admin HTTP API (S11a). No ffmpeg needed.
//
// Boots a panel store + the admin server in-process, then over real HTTP:
// admin login (bad creds rejected, lockout enforced) → create user + stream +
// grant + meta + art → asserts the signed DB/secrets/assets reflect every write →
// finally a real viewer logs in over a live Hyperswarm and receives the granted
// stream key. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { panelClient, login, checkSession, sessionLive } from '../sdk/login.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, loadSecrets } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { makeRing } from '../panel/src/activity.js'
import * as ops from '../panel/src/ops.js'
import { startAdminServer } from '../panel/src/admin-server.js'
import { panelClient as pubRpc, registerWithPanel } from '../broadcaster/src/register.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) } throw new Error('timeout: ' + label) }

const ADMIN_PASSWORD = 'correct-horse-battery'
const USER_PASSWORD = 'bob-secret-1'
const PNG_1PX = b4a.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

// Fast Argon2 for the test (argonOpts clamps to the sodium minimums).
const config = { argon2: { memKiB: 8192, time: 1 }, maxDevicesDefault: 2 }

const dirs = { panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ea-panel-')), cli: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ea-cli-')) }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Panel store + one bootstrapped admin (the `admin-cli add-admin` path) =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db, assets } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const ring = makeRing(200)
  const ctx = { config, keys, db, assets, dataDir: dirs.panel, activity: ring } // ctx.swarm attached in Test D

  assert.throws(() => ops.addAdmin(ctx, 'root', 'short'), /8 characters/, 'weak admin password must be rejected')
  ops.addAdmin(ctx, 'root', ADMIN_PASSWORD)
  assert.throws(() => ops.addAdmin(ctx, 'root', ADMIN_PASSWORD), /exists/, 'duplicate admin must be rejected')

  const { port, close } = await startAdminServer(ctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 5, seconds: 60 } })
  cleanups.push(close)
  const base = `http://127.0.0.1:${port}`
  const api = async (method, p, body, { token, raw, contentType } = {}) => {
    const headers = {}
    if (token) headers.authorization = 'Bearer ' + token
    if (body !== undefined && !raw) headers['content-type'] = 'application/json'
    if (contentType) headers['content-type'] = contentType
    const res = await fetch(base + p, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  log('admin API listening on', base)

  // ===== Test A: auth — bad creds rejected, no/garbage token rejected =====
  const badLogin = await api('POST', '/api/login', { username: 'root', password: 'wrong-password' })
  assert.strictEqual(badLogin.status, 401, 'bad credentials must be 401')
  const noToken = await api('GET', '/api/users')
  assert.strictEqual(noToken.status, 401, 'missing token must be 401')
  const junkToken = await api('GET', '/api/users', undefined, { token: 'AAAA.BBBB' })
  assert.strictEqual(junkToken.status, 401, 'garbage token must be 401')
  const goodLogin = await api('POST', '/api/login', { username: 'root', password: ADMIN_PASSWORD })
  assert.strictEqual(goodLogin.status, 200, 'valid credentials must log in')
  const token = goodLogin.body.token
  assert.ok(token && goodLogin.body.expiresAt > Date.now(), 'login returns a token + expiry')
  log('A: bad creds / missing token / garbage token -> 401; valid login -> token ✓')

  // ===== Test B: CRUD over HTTP =====
  let r = await api('POST', '/api/users', { username: 'bob', password: USER_PASSWORD }, { token })
  assert.strictEqual(r.status, 201, 'create user: ' + JSON.stringify(r.body))
  r = await api('POST', '/api/users', { username: 'bob', password: USER_PASSWORD }, { token })
  assert.strictEqual(r.status, 409, 'duplicate user must be 409')

  r = await api('POST', '/api/streams', { id: 'movie-night', title: 'Movie Night', category: 'film' }, { token })
  assert.strictEqual(r.status, 201, 'add stream: ' + JSON.stringify(r.body))
  const encKey = r.body.encryptionKey
  assert.match(encKey, /^[0-9a-f]{64}$/, 'add-stream returns the encryption key once')
  assert.strictEqual(r.body.catalog.order, null, 'curation default: order null')
  assert.strictEqual(r.body.catalog.featured, false, 'curation default: featured false')
  r = await api('POST', '/api/streams', { id: 'movie-night' }, { token })
  assert.strictEqual(r.status, 409, 'duplicate stream must be 409')

  const feedKey = b4a.toString(hcrypto.randomBytes(32), 'hex')
  r = await api('PATCH', '/api/streams/movie-night', { description: 'Friday premiere', feedKey, isLive: true }, { token })
  assert.strictEqual(r.status, 200, 'set-meta: ' + JSON.stringify(r.body))

  r = await api('POST', '/api/users/bob/grants', { streamId: 'movie-night' }, { token })
  assert.strictEqual(r.status, 200, 'grant: ' + JSON.stringify(r.body))
  assert.deepStrictEqual(r.body.grants, ['movie-night'])
  r = await api('POST', '/api/users/bob/grants', { streamId: 'no-such-stream' }, { token })
  assert.strictEqual(r.status, 404, 'grant of unknown stream must be 404')

  r = await api('POST', '/api/streams/movie-night/art/poster', PNG_1PX, { token, raw: true, contentType: 'image/png' })
  assert.strictEqual(r.status, 200, 'upload art: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.poster, 'assets/movie-night/poster.png')

  r = await api('POST', '/api/users/bob/max-devices', { maxDevices: 3 }, { token })
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.maxDevices, 3)

  r = await api('GET', '/api/users', undefined, { token })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.next, null, 'single page -> next is null')
  const bobRow = r.body.users.find((u) => u.username === 'bob')
  assert.ok(bobRow && bobRow.grants.includes('movie-night'), 'user list shows the grant')
  assert.strictEqual(bobRow.salt, undefined, 'user list must not leak record secrets')

  r = await api('GET', '/api/streams', undefined, { token })
  assert.ok(r.body.find((s) => s.id === 'movie-night' && s.title === 'Movie Night'), 'stream list')
  assert.strictEqual(JSON.stringify(r.body).includes(encKey), false, 'catalog must not contain the encryption key')

  r = await api('GET', '/api/status', undefined, { token })
  assert.strictEqual(r.status, 200)
  assert.ok(r.body.users >= 1 && r.body.streams >= 1 && r.body.admins === 1, 'status summary')
  log('B: users/streams/grants/meta/art/max-devices/list/status over HTTP ✓')

  // ===== Test C: the signed DB + private files reflect the writes =====
  const bob = (await db.get('user/bob')).value
  assert.ok(bob.wrapped['movie-night'], 'grant sealed into the user record')
  const cat = (await db.get('catalog/movie-night')).value
  assert.strictEqual(cat.description, 'Friday premiere')
  assert.strictEqual(cat.feedKey, feedKey)
  assert.strictEqual(cat.isLive, true)
  assert.strictEqual(cat.poster, 'assets/movie-night/poster.png')
  assert.strictEqual(loadSecrets(dirs.panel)['movie-night'], encKey, 'secret stored panel-private')
  const art = await assets.get('/movie-night/poster.png')
  assert.ok(art && b4a.equals(art, PNG_1PX), 'art bytes in the assets drive')
  log('C: signed DB, secrets file and assets drive reflect the API writes ✓')

  // ===== Test D: a real viewer can log in and open the granted stream key =====
  const throttle = makeThrottle(1000, 60)
  const panelSwarm = new Hyperswarm(); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: 8, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000, activity: ring }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()
  ctx.swarm = panelSwarm // observability (Test N) reports these connections

  const cliStore = new Corestore(dirs.cli); await cliStore.ready(); cleanups.push(() => cliStore.close())
  const cliBee = new Hyperbee(cliStore.get({ key: keys.signing.publicKey }), { keyEncoding: 'utf-8', valueEncoding: 'json' }); await cliBee.ready()
  let call = null
  const cliSwarm = new Hyperswarm(); cleanups.push(() => cliSwarm.destroy())
  cliSwarm.on('connection', (socket) => { cliStore.replicate(socket); if (!call) call = panelClient(socket).call })
  cliSwarm.join(hcrypto.hash(keys.signing.publicKey), { client: true, server: false })
  await waitFor(async () => call, 30000, 'panel connection')
  await waitFor(async () => await cliBee.get('user/bob'), 30000, 'DB replication')

  const session = await login(call, cliBee, 'bob', USER_PASSWORD, { deviceId: 'test-device', deviceLabel: 'e2e' })
  const stream = session.streams.find((s) => s.id === 'movie-night')
  assert.ok(stream, 'viewer sees the granted stream')
  assert.strictEqual(stream.encryptionKey, encKey, 'viewer unseals the exact stream key the API created')
  assert.ok(session.token, 'viewer got a session token')
  log('D: viewer logged in over Hyperswarm and unsealed the granted key ✓')

  // ===== Test E: login lockout (threshold 5; A used 2 attempts) =====
  for (let i = 0; i < 3; i++) {
    const bad = await api('POST', '/api/login', { username: 'root', password: 'wrong-' + i })
    assert.strictEqual(bad.status, 401, `attempt ${i} still 401 (not yet locked)`)
  }
  const locked = await api('POST', '/api/login', { username: 'root', password: 'wrong-final' })
  assert.strictEqual(locked.status, 429, 'over threshold must be locked')
  assert.ok(locked.body.retryAfter > 0, 'locked response carries retryAfter')
  const lockedGood = await api('POST', '/api/login', { username: 'root', password: ADMIN_PASSWORD })
  assert.strictEqual(lockedGood.status, 429, 'lockout also blocks valid creds')
  log('E: lockout after threshold, valid creds blocked while locked ✓')

  // ===== Test F: revoke + disable =====
  r = await api('GET', '/api/users/bob/devices', undefined, { token })
  assert.strictEqual(r.status, 200)
  assert.ok(r.body.find((d) => d.deviceId === 'test-device'), 'device list shows the viewer session')

  r = await api('DELETE', '/api/users/bob/grants/movie-night', undefined, { token })
  assert.strictEqual(r.status, 200)
  assert.deepStrictEqual(r.body.grants, [], 'grant revoked')
  assert.ok(!(await db.get('user/bob')).value.wrapped['movie-night'], 'sealed key removed from the record')

  const tvBefore = (await db.get('user/bob')).value.tokenVersion
  r = await api('POST', '/api/users/bob/status', { status: 'disabled' }, { token })
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, 'disabled')
  const bobAfter = (await db.get('user/bob')).value
  assert.strictEqual(bobAfter.status, 'disabled')
  assert.strictEqual(bobAfter.tokenVersion, tvBefore + 1, 'disable revokes sessions (tokenVersion bump)')
  assert.deepStrictEqual(bobAfter.devices, [], 'disable clears devices')
  log('F: revoke + disable land in the signed DB ✓')

  // ===== Test G: dashboard static files + authed assets endpoint (S11b) =====
  const home = await fetch(base + '/')
  assert.strictEqual(home.status, 200, 'dashboard index served')
  assert.match(home.headers.get('content-type'), /text\/html/)
  const homeHtml = await home.text()
  assert.ok(homeHtml.includes('Aliran'), 'index.html is the dashboard')
  for (const marker of ['data-tab="admins"', 'data-tab="overview"', 'user-search', 'users-more', 'add-admin-form', 'activity-feed']) {
    assert.ok(homeHtml.includes(marker), `dashboard carries the S16b surface: ${marker}`)
  }
  for (const f of ['app.js', 'style.css']) {
    const fr = await fetch(base + '/' + f)
    assert.strictEqual(fr.status, 200, f + ' served')
  }
  const appJs = await (await fetch(base + '/app.js')).text()
  for (const marker of ['api/observability', 'api/admins', 'order-input', 'featured-input', 'device-x', 'Purge permanently']) {
    assert.ok(appJs.includes(marker), `app.js wires the S16b flows: ${marker}`)
  }
  const trav = await fetch(base + '/%2e%2e/package.json')
  assert.strictEqual(trav.status, 404, 'path traversal must be 404')
  const artNoAuth = await fetch(base + '/api/assets/movie-night/poster.png')
  assert.strictEqual(artNoAuth.status, 401, 'assets endpoint requires auth')
  const artRes = await fetch(base + '/api/assets/movie-night/poster.png', { headers: { authorization: 'Bearer ' + token } })
  assert.strictEqual(artRes.status, 200, 'assets endpoint serves art')
  assert.strictEqual(artRes.headers.get('content-type'), 'image/png')
  assert.ok(b4a.equals(b4a.from(await artRes.arrayBuffer()), PNG_1PX), 'asset bytes match the upload')
  log('G: dashboard static files, traversal guard, authed art endpoint ✓')

  // ===== Test H: admins management (S16a) =====
  r = await api('GET', '/api/admins', undefined, { token })
  assert.strictEqual(r.status, 200)
  assert.ok(r.body.find((a) => a.name === 'root'), 'admin list shows root')
  assert.strictEqual(JSON.stringify(r.body).includes('verifier'), false, 'admin list must not leak verifiers')

  r = await api('POST', '/api/admins', { username: 'ops2', password: 'short' }, { token })
  assert.strictEqual(r.status, 400, 'weak admin password rejected over HTTP')
  r = await api('POST', '/api/admins', { username: 'ops2', password: 'ops2-password' }, { token })
  assert.strictEqual(r.status, 201, 'create admin over HTTP')
  r = await api('POST', '/api/admins', { username: 'ops2', password: 'ops2-password' }, { token })
  assert.strictEqual(r.status, 409, 'duplicate admin rejected')
  r = await api('POST', '/api/admins', { username: 'root2', password: 'root2-password' }, { token })
  assert.strictEqual(r.status, 201)

  const loginR2 = await api('POST', '/api/login', { username: 'root2', password: 'root2-password' })
  assert.strictEqual(loginR2.status, 200)
  const tokenR2 = loginR2.body.token
  r = await api('GET', '/api/status', undefined, { token: tokenR2 })
  assert.strictEqual(r.status, 200, 'root2 token works before rotation')

  r = await api('POST', '/api/admins/root2/password', { password: 'nope' }, { token })
  assert.strictEqual(r.status, 400, 'weak rotated password rejected')
  r = await api('POST', '/api/admins/root2/password', { password: 'root2-NEW-password' }, { token })
  assert.strictEqual(r.status, 200, 'admin password rotated')
  r = await api('GET', '/api/status', undefined, { token: tokenR2 })
  assert.strictEqual(r.status, 401, 'rotation kills the old admin token (tokenVersion bump)')
  r = await api('POST', '/api/login', { username: 'root2', password: 'root2-password' })
  assert.strictEqual(r.status, 401, 'old admin password no longer logs in')
  r = await api('POST', '/api/login', { username: 'root2', password: 'root2-NEW-password' })
  assert.strictEqual(r.status, 200, 'new admin password logs in')

  const tokenOps2 = (await api('POST', '/api/login', { username: 'ops2', password: 'ops2-password' })).body.token
  r = await api('DELETE', '/api/admins/ops2', undefined, { token })
  assert.strictEqual(r.status, 200, 'admin removed')
  r = await api('GET', '/api/status', undefined, { token: tokenOps2 })
  assert.strictEqual(r.status, 401, 'removed admin token dies immediately')
  r = await api('DELETE', '/api/admins/ops2', undefined, { token })
  assert.strictEqual(r.status, 404, 'removing a missing admin is 404')
  log('H: admins list/create/rotate/delete; rotation + removal kill live tokens ✓')

  // ===== Test I: user prefix search + cursor paging (S16a) =====
  for (let i = 0; i < 12; i++) {
    const name = 'pguser' + String(i).padStart(2, '0')
    r = await api('POST', '/api/users', { username: name, password: 'pw-' + name }, { token })
    assert.strictEqual(r.status, 201, 'create ' + name)
  }
  r = await api('GET', '/api/users?prefix=pguser&limit=5', undefined, { token })
  assert.strictEqual(r.status, 200)
  assert.deepStrictEqual(r.body.users.map((u) => u.username), ['pguser00', 'pguser01', 'pguser02', 'pguser03', 'pguser04'], 'page 1')
  assert.strictEqual(r.body.next, 'pguser04', 'page 1 cursor')
  r = await api('GET', '/api/users?prefix=pguser&limit=5&after=' + r.body.next, undefined, { token })
  assert.deepStrictEqual(r.body.users.map((u) => u.username), ['pguser05', 'pguser06', 'pguser07', 'pguser08', 'pguser09'], 'page 2')
  r = await api('GET', '/api/users?prefix=pguser&limit=5&after=' + r.body.next, undefined, { token })
  assert.deepStrictEqual(r.body.users.map((u) => u.username), ['pguser10', 'pguser11'], 'last page')
  assert.strictEqual(r.body.next, null, 'last page has no cursor')
  r = await api('GET', '/api/users?prefix=pguser1', undefined, { token })
  assert.deepStrictEqual(r.body.users.map((u) => u.username), ['pguser10', 'pguser11'], 'narrower prefix')
  r = await api('GET', '/api/users?prefix=bob', undefined, { token })
  assert.deepStrictEqual(r.body.users.map((u) => u.username), ['bob'], 'prefix isolates')
  r = await api('GET', '/api/users?limit=0', undefined, { token })
  assert.strictEqual(r.status, 400, 'limit must be >= 1')
  r = await api('GET', '/api/users?limit=abc', undefined, { token })
  assert.strictEqual(r.status, 400, 'non-numeric limit rejected')
  log('I: prefix search + cursor paging over 12 users ✓')

  // ===== Test J: typed curation fields + register-merge preservation (S16a) =====
  r = await api('PATCH', '/api/streams/movie-night', { order: 3, featured: true }, { token })
  assert.strictEqual(r.status, 200)
  let cat2 = (await db.get('catalog/movie-night')).value
  assert.strictEqual(cat2.order, 3, 'order lands typed')
  assert.strictEqual(cat2.featured, true, 'featured lands typed')
  r = await api('PATCH', '/api/streams/movie-night', { order: '7', featured: 'false' }, { token })
  assert.strictEqual(r.status, 200)
  cat2 = (await db.get('catalog/movie-night')).value
  assert.strictEqual(cat2.order, 7, 'string order coerced to int')
  assert.strictEqual(cat2.featured, false, 'string featured coerced to bool')
  for (const badOrder of [10000, -1, 1.5, 'x']) {
    r = await api('PATCH', '/api/streams/movie-night', { order: badOrder }, { token })
    assert.strictEqual(r.status, 400, 'bad order must be rejected: ' + badOrder)
  }
  r = await api('PATCH', '/api/streams/movie-night', { order: null }, { token })
  assert.strictEqual(r.status, 200)
  assert.strictEqual((await db.get('catalog/movie-night')).value.order, null, 'null clears order')
  r = await api('POST', '/api/streams', { id: 'temp-curated', order: 2, featured: true }, { token })
  assert.strictEqual(r.status, 201)
  assert.strictEqual(r.body.catalog.order, 2, 'add-stream accepts order')
  assert.strictEqual(r.body.catalog.featured, true, 'add-stream accepts featured')
  r = await api('PATCH', '/api/streams/movie-night', { order: 5, featured: true, epgUrl: 'https://epg.example/g.json', epgId: 'mn' }, { token })
  assert.strictEqual(r.status, 200)

  // a broadcaster re-register must NOT erase admin curation/art/EPG — AND (S27e) must not
  // change the admin-owned title/description/category of an EXISTING channel: the panel is
  // authoritative for what viewers see; the broadcaster is just the stream.
  let pcall = null
  const pubSwarm = new Hyperswarm(); cleanups.push(() => pubSwarm.destroy())
  pubSwarm.on('connection', (s) => { if (!pcall) pcall = pubRpc(s).call })
  pubSwarm.join(hcrypto.hash(keys.signing.publicKey), { client: true, server: false })
  await waitFor(async () => pcall, 30000, 'publisher connection')
  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'movie-night', feedKey, title: 'Movie Night LIVE', category: ['broadcaster-cat'], isLive: true
  })
  cat2 = (await db.get('catalog/movie-night')).value
  assert.strictEqual(cat2.title, 'Movie Night', 'panel-authoritative: re-register does NOT change an existing title')
  assert.deepStrictEqual(cat2.category, ['film'], 'panel-authoritative: re-register does NOT change an existing category')
  assert.strictEqual(cat2.order, 5, 'register preserves order')
  assert.strictEqual(cat2.featured, true, 'register preserves featured')
  assert.strictEqual(cat2.poster, 'assets/movie-night/poster.png', 'register preserves art')
  assert.strictEqual(cat2.epgUrl, 'https://epg.example/g.json', 'register preserves admin EPG pointer (epgUrl)')
  assert.strictEqual(cat2.epgId, 'mn', 'register preserves admin EPG pointer (epgId)')
  // …but a FIRST register (new channel) SEEDS title/category from the broadcaster.
  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'seeded-chan', feedKey, title: 'Seeded From Broadcaster', category: ['seed-cat'], isLive: true
  })
  const seeded = (await db.get('catalog/seeded-chan')).value
  assert.strictEqual(seeded.title, 'Seeded From Broadcaster', 'first register seeds title on a new channel')
  assert.deepStrictEqual(seeded.category, ['seed-cat'], 'first register seeds category on a new channel')
  log('J: curation/art/EPG preserved; title/category panel-authoritative (seed on create, never overwrite) ✓')

  // ===== Test K: stream delete = FULL purge (S16a) =====
  r = await api('POST', '/api/users', { username: 'carol', password: 'carol-secret-1' }, { token })
  assert.strictEqual(r.status, 201)
  r = await api('POST', '/api/users/carol/grants', { streamId: 'movie-night' }, { token })
  assert.strictEqual(r.status, 200)
  r = await api('POST', '/api/users/bob/grants', { streamId: 'movie-night' }, { token })
  assert.strictEqual(r.status, 200, 're-grant to bob (revoked in F)')
  assert.ok(loadSecrets(dirs.panel)['movie-night'], 'precondition: private secret exists')
  assert.ok(await assets.get('/movie-night/poster.png'), 'precondition: art exists')

  r = await api('DELETE', '/api/streams/movie-night', undefined, { token })
  assert.strictEqual(r.status, 200, 'purge: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.grantsRevoked, 2, 'both grants scrubbed')
  assert.strictEqual(await db.get('catalog/movie-night'), null, 'catalog record gone')
  assert.strictEqual(loadSecrets(dirs.panel)['movie-night'], undefined, 'private secret gone')
  assert.ok(!('movie-night' in ((await db.get('user/bob')).value.wrapped || {})), 'bob grant scrubbed')
  assert.ok(!('movie-night' in ((await db.get('user/carol')).value.wrapped || {})), 'carol grant scrubbed')
  assert.strictEqual(await assets.get('/movie-night/poster.png'), null, 'art gone from the assets drive')
  r = await api('DELETE', '/api/streams/movie-night', undefined, { token })
  assert.strictEqual(r.status, 404, 'double delete is 404')
  r = await api('DELETE', '/api/streams/temp-curated', undefined, { token })
  assert.strictEqual(r.status, 200, 'purge of a grantless/artless stream works')

  r = await api('POST', '/api/streams', { id: 'movie-night', title: 'Movie Night II' }, { token })
  assert.strictEqual(r.status, 201, 're-adding the purged id works')
  assert.notStrictEqual(r.body.encryptionKey, encKey, 're-added stream mints a FRESH key')
  log('K: purge scrubs catalog+secret+grants+art; re-add mints a fresh key ✓')

  // ===== Test L: user delete (S16a) =====
  r = await api('DELETE', '/api/users/carol', undefined, { token })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(await db.get('user/carol'), null, 'user record gone')
  r = await api('GET', '/api/users/carol', undefined, { token })
  assert.strictEqual(r.status, 404)
  r = await api('DELETE', '/api/users/carol', undefined, { token })
  assert.strictEqual(r.status, 404, 'double delete is 404')
  log('L: user delete removes the record ✓')

  // ===== Test M: per-device revoke (no tokenVersion bump) + SDK cooperative check (S16a) =====
  r = await api('POST', '/api/users/bob/status', { status: 'active' }, { token })
  assert.strictEqual(r.status, 200, 're-enable bob (disabled in F)')
  const session2 = await login(call, cliBee, 'bob', USER_PASSWORD, { deviceId: 'device-2', deviceLabel: 'e2e-2' })
  assert.ok(session2.token, 'bob logged in again')
  const payload2 = checkSession(keys.signing.publicKey, session2.token)
  assert.ok(payload2 && payload2.deviceId === 'device-2', 'token payload carries the device')
  await waitFor(async () => sessionLive(cliBee, payload2), 30000, 'sessionLive true after login (replication)')

  r = await api('DELETE', '/api/users/bob/devices/nope', undefined, { token })
  assert.strictEqual(r.status, 404, 'unknown device is 404')
  const tvBeforeRevoke = (await db.get('user/bob')).value.tokenVersion
  r = await api('DELETE', '/api/users/bob/devices/device-2', undefined, { token })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.devices, 0, 'enrollment removed')
  const bobPost = (await db.get('user/bob')).value
  assert.strictEqual(bobPost.tokenVersion, tvBeforeRevoke, 'device revoke must NOT bump tokenVersion')
  assert.deepStrictEqual(bobPost.devices, [], 'device gone from the record')
  await waitFor(async () => !(await sessionLive(cliBee, payload2)), 30000, 'sessionLive false after revoke (replication)')
  assert.ok(checkSession(keys.signing.publicKey, session2.token), 'offline token check still passes (inherent) — the online check is what notices')
  log('M: device revoke drops the enrollment; SDK sessionLive notices; tokenVersion untouched ✓')

  // ===== Test N: observability (S16a) =====
  r = await api('GET', '/api/observability', undefined, { token })
  assert.strictEqual(r.status, 200)
  const ob = r.body
  assert.ok(Number.isInteger(ob.uptimeSec) && ob.uptimeSec >= 0, 'uptimeSec')
  assert.ok(ob.mem.rss > 0 && ob.mem.heapUsed > 0, 'mem counters')
  assert.ok(ob.swarm.connections >= 1, 'swarm connections visible (viewer/publisher connected)')
  assert.ok(ob.swarm.peers >= 1, 'swarm peers visible')
  assert.ok(ob.data.bytes > 0, 'data dir size measured')
  assert.ok(ob.data.diskFree === null || ob.data.diskFree > 0, 'diskFree from statfs')
  assert.ok(Array.isArray(ob.activity) && ob.activity.length > 0, 'activity feed populated')
  assert.ok(ob.activity.every((e) => typeof e.t === 'number' && typeof e.type === 'string'), 'activity entry shape')
  assert.ok(ob.activity[0].t >= ob.activity[ob.activity.length - 1].t, 'activity is newest-first')
  const kinds = new Set(ob.activity.map((e) => e.type + (e.op ? ':' + e.op : '')))
  assert.ok(kinds.has('admin:stream-delete'), 'admin mutations recorded')
  assert.ok(kinds.has('admin:user-create'), 'user creates recorded')
  assert.ok(kinds.has('session'), 'viewer sessions recorded')
  assert.ok(kinds.has('register'), 'broadcaster registers recorded')
  log('N: observability shape + activity ring (admin/session/register events) ✓')

  // ===== Test O: redirect channels (S23) — a CDN-link class in the catalog =====
  // Create: url implies redirect:true and live-by-default (no broadcaster heartbeat
  // will ever flip a redirect channel's liveness).
  r = await api('POST', '/api/streams', { id: 'redirect-1', title: 'Redirect One', url: 'https://cdn.example.com/r1/index.m3u8?tok=abc' }, { token })
  assert.strictEqual(r.status, 201, 'add redirect stream: ' + JSON.stringify(r.body))
  assert.strictEqual(r.body.catalog.redirect, true, 'url implies redirect:true')
  assert.strictEqual(r.body.catalog.url, 'https://cdn.example.com/r1/index.m3u8?tok=abc', 'url stored verbatim (query string kept)')
  assert.strictEqual(r.body.catalog.feedKey, null)
  assert.strictEqual(r.body.catalog.isLive, true, 'redirect channels default live')
  assert.strictEqual(r.body.catalog.status, 'live')

  // Validation: https-only, size/linebreak caps, class exclusivity — and a rejected
  // create must leave nothing behind (no record, no minted secret).
  r = await api('POST', '/api/streams', { id: 'redirect-bad', url: 'http://cdn.example.com/x.m3u8' }, { token })
  assert.strictEqual(r.status, 400, 'http:// url must be rejected')
  r = await api('POST', '/api/streams', { id: 'redirect-bad', url: 'https://cdn.example.com/' + 'a'.repeat(2048) }, { token })
  assert.strictEqual(r.status, 400, 'oversize url must be rejected')
  r = await api('POST', '/api/streams', { id: 'redirect-bad', url: 'https://cdn.example.com/a\nb' }, { token })
  assert.strictEqual(r.status, 400, 'linebreak url must be rejected')
  r = await api('POST', '/api/streams', { id: 'redirect-bad', url: 'https://cdn.example.com/x.m3u8', feedKey: b4a.toString(hcrypto.randomBytes(32), 'hex') }, { token })
  assert.strictEqual(r.status, 400, 'url + feedKey must be rejected (different class)')
  r = await api('POST', '/api/streams', { id: 'redirect-bad', redirect: true }, { token })
  assert.strictEqual(r.status, 400, 'redirect:true without url must be rejected')
  assert.strictEqual(await db.get('catalog/redirect-bad'), null, 'no partial record from rejected creates')
  assert.strictEqual(loadSecrets(dirs.panel)['redirect-bad'], undefined, 'no minted secret from rejected creates')

  // PATCH: url onto an existing plain entry makes it a redirect. Liveness defaults
  // fire only when isLive/status are absent from the SAME request; explicit wins;
  // an empty url clears the class (and defaults liveness back off).
  r = await api('POST', '/api/streams', { id: 'redirect-2', title: 'Plain' }, { token })
  assert.strictEqual(r.status, 201)
  assert.strictEqual(r.body.catalog.isLive, false, 'plain feedless entry stays idle')
  r = await api('PATCH', '/api/streams/redirect-2', { url: 'https://cdn.example.com/r2.m3u8' }, { token })
  assert.strictEqual(r.status, 200)
  let catR = (await db.get('catalog/redirect-2')).value
  assert.strictEqual(catR.redirect, true)
  assert.strictEqual(catR.isLive, true, 'PATCH url defaults isLive true')
  assert.strictEqual(catR.status, 'live')
  r = await api('PATCH', '/api/streams/redirect-2', { url: 'https://cdn.example.com/r2b.m3u8', isLive: false, status: 'offline' }, { token })
  assert.strictEqual(r.status, 200)
  catR = (await db.get('catalog/redirect-2')).value
  assert.strictEqual(catR.url, 'https://cdn.example.com/r2b.m3u8')
  assert.strictEqual(catR.isLive, false, 'explicit isLive wins over the redirect default')
  assert.strictEqual(catR.status, 'offline', 'explicit status wins')
  r = await api('PATCH', '/api/streams/redirect-2', { url: '' }, { token })
  assert.strictEqual(r.status, 200)
  catR = (await db.get('catalog/redirect-2')).value
  assert.strictEqual(catR.redirect, false, 'empty url clears the class')
  assert.strictEqual(catR.url, null)
  assert.strictEqual(catR.isLive, false, 'cleared redirect defaults back to idle')
  assert.strictEqual(catR.status, 'idle')
  r = await api('PATCH', '/api/streams/redirect-2', { redirect: true }, { token })
  assert.strictEqual(r.status, 400, 'redirect:true with no url must be rejected on PATCH too')

  // Class exclusivity holds on PATCH: a feed-backed entry cannot become a redirect.
  r = await api('POST', '/api/streams', { id: 'redirect-3', feedKey: b4a.toString(hcrypto.randomBytes(32), 'hex') }, { token })
  assert.strictEqual(r.status, 201)
  r = await api('PATCH', '/api/streams/redirect-3', { url: 'https://cdn.example.com/r3.m3u8' }, { token })
  assert.strictEqual(r.status, 400, 'url on a feed-backed entry must be rejected')

  // A broadcaster re-register must NOT clobber the redirect class (same rule as curation).
  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'redirect-1', feedKey: b4a.toString(hcrypto.randomBytes(32), 'hex'), title: 'Registered Over', isLive: true
  })
  catR = (await db.get('catalog/redirect-1')).value
  assert.strictEqual(catR.redirect, true, 'register preserves redirect')
  assert.strictEqual(catR.url, 'https://cdn.example.com/r1/index.m3u8?tok=abc', 'register preserves url')

  // Purge works on redirect entries like any other stream.
  r = await api('DELETE', '/api/streams/redirect-1', undefined, { token })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(await db.get('catalog/redirect-1'), null)
  r = await api('DELETE', '/api/streams/redirect-2', undefined, { token }); assert.strictEqual(r.status, 200)
  r = await api('DELETE', '/api/streams/redirect-3', undefined, { token }); assert.strictEqual(r.status, 200)
  log('O: redirect class — url⇒redirect+live defaults, https/size/class validation, explicit-wins, clear, register-preserve, purge ✓')

  // ===== Test P: enrolled publishers — per-site keys + channel scopes (S26) =====
  r = await api('POST', '/api/publishers', { name: 'east', scopes: ['east-*'] }, { token })
  assert.strictEqual(r.status, 201, 'enroll publisher: ' + JSON.stringify(r.body))
  assert.match(r.body.secretKey, /^[0-9a-f]{128}$/, 'enrollment returns the secret key once')
  assert.match(r.body.publicKey, /^[0-9a-f]{64}$/, 'and the public key')
  assert.deepStrictEqual(r.body.scopes, ['east-*'])
  const eastSecret = r.body.secretKey
  r = await api('POST', '/api/publishers', { name: 'east' }, { token })
  assert.strictEqual(r.status, 409, 'duplicate publisher must be 409')
  r = await api('POST', '/api/publishers', { name: '.bad' }, { token })
  assert.strictEqual(r.status, 400, 'invalid publisher name rejected')
  r = await api('POST', '/api/publishers', { name: 'west', scopes: ['bad scope'] }, { token })
  assert.strictEqual(r.status, 400, 'invalid scope glob rejected')
  r = await api('GET', '/api/publishers', undefined, { token })
  assert.strictEqual(r.status, 200)
  const eastRow = r.body.find((p) => p.name === 'east')
  assert.ok(eastRow && eastRow.status === 'active' && eastRow.scopes.includes('east-*'), 'publisher list shows the enrollment')
  assert.strictEqual(JSON.stringify(r.body).includes(eastSecret), false, 'list must never contain a secret (none is stored)')

  // The enrolled key registers in-scope over the real swarm; origin lands in the
  // catalog and the activity feed.
  const eastFeed = b4a.toString(hcrypto.randomBytes(32), 'hex')
  const eastEnc = b4a.toString(hcrypto.randomBytes(32), 'hex')
  await registerWithPanel(pcall, eastSecret, { publisher: 'east', streamId: 'east-1', feedKey: eastFeed, encryptionKey: eastEnc, title: 'East One', isLive: true })
  let catP = (await db.get('catalog/east-1')).value
  assert.strictEqual(catP.origin, 'east', 'catalog record stamped origin:east')
  assert.strictEqual(catP.title, 'East One')
  assert.strictEqual(loadSecrets(dirs.panel)['east-1'], eastEnc, 'named register stored the private secret')
  let regErr = null
  try { await registerWithPanel(pcall, eastSecret, { publisher: 'east', streamId: 'west-1', feedKey: eastFeed, isLive: true }) } catch (e) { regErr = e.message }
  assert.match(regErr, /out-of-scope/, 'streamId outside the scopes rejected')
  assert.strictEqual(await db.get('catalog/west-1'), null, 'out-of-scope wrote nothing')

  // Scope edit via the API applies to the very next register (file-based registry).
  r = await api('POST', '/api/publishers/east/scopes', { scopes: ['east-*', 'west-*'] }, { token })
  assert.strictEqual(r.status, 200)
  assert.deepStrictEqual(r.body.scopes, ['east-*', 'west-*'])
  await registerWithPanel(pcall, eastSecret, { publisher: 'east', streamId: 'west-1', feedKey: eastFeed, isLive: true })
  assert.strictEqual((await db.get('catalog/west-1')).value.origin, 'east', 'widened scope live immediately')

  // Revoke via the API: same key now bounces; invalid status rejected.
  r = await api('POST', '/api/publishers/east/status', { status: 'nope' }, { token })
  assert.strictEqual(r.status, 400, 'invalid status rejected')
  r = await api('POST', '/api/publishers/east/status', { status: 'revoked' }, { token })
  assert.strictEqual(r.status, 200)
  regErr = null
  try { await registerWithPanel(pcall, eastSecret, { publisher: 'east', streamId: 'east-1', feedKey: eastFeed, isLive: false }) } catch (e) { regErr = e.message }
  assert.match(regErr, /revoked/, 'revoked publisher rejected')
  assert.strictEqual((await db.get('catalog/east-1')).value.isLive, true, 'revoked register flipped nothing')

  // Hard delete: unknown-publisher from then on; 404 on repeat.
  r = await api('DELETE', '/api/publishers/east', undefined, { token })
  assert.strictEqual(r.status, 200)
  r = await api('DELETE', '/api/publishers/east', undefined, { token })
  assert.strictEqual(r.status, 404, 'double delete is 404')
  regErr = null
  try { await registerWithPanel(pcall, eastSecret, { publisher: 'east', streamId: 'east-1', feedKey: eastFeed, isLive: true }) } catch (e) { regErr = e.message }
  assert.match(regErr, /unknown-publisher/, 'removed publisher is unknown')

  // Activity feed carries the audit trail; the dashboard ships the publishers card.
  r = await api('GET', '/api/observability', undefined, { token })
  const kindsP = new Set(r.body.activity.map((e) => e.type + (e.op ? ':' + e.op : '')))
  assert.ok(kindsP.has('admin:publisher-create'), 'publisher enrollments recorded')
  assert.ok(kindsP.has('admin:publisher-status'), 'publisher revokes recorded')
  assert.ok(r.body.activity.some((e) => e.type === 'register' && e.origin === 'east'), 'register activity attributes origin')
  const homeHtmlP = await (await fetch(base + '/')).text()
  for (const marker of ['data-tab="publishers"', 'add-publisher-form', 'publishers-table']) {
    assert.ok(homeHtmlP.includes(marker), `dashboard carries the publishers card: ${marker}`)
  }
  const appJsP = await (await fetch(base + '/app.js')).text()
  for (const marker of ['api/publishers', 'renderPublishers', 'PUBLISHER_NAME']) {
    assert.ok(appJsP.includes(marker), `app.js wires the publisher flows: ${marker}`)
  }
  r = await api('DELETE', '/api/streams/east-1', undefined, { token }); assert.strictEqual(r.status, 200)
  r = await api('DELETE', '/api/streams/west-1', undefined, { token }); assert.strictEqual(r.status, 200)
  log('P: publishers — enroll/list (secret once), scoped register + origin stamp, live scope edit, revoke, delete, activity + UI ✓')

  log('\nRESULT: PASS ✅  (admin auth + lockout; CRUD, admins mgmt, purge/delete, paging, curation, redirect channels, publishers + scopes, device revoke + sessionLive, observability — all land in the signed DB; viewer login works end-to-end)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
