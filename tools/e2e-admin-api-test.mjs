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
import { panelClient, login } from '../sdk/login.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, loadSecrets } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import * as ops from '../panel/src/ops.js'
import { startAdminServer } from '../panel/src/admin-server.js'

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
  const ctx = { config, keys, db, assets, dataDir: dirs.panel }

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
  const bobRow = r.body.find((u) => u.username === 'bob')
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
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: 8, throttle, db, sessionTtlMs: 3600000 }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()

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
  assert.ok((await home.text()).includes('Aliran'), 'index.html is the dashboard')
  for (const f of ['app.js', 'style.css']) {
    const fr = await fetch(base + '/' + f)
    assert.strictEqual(fr.status, 200, f + ' served')
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

  log('\nRESULT: PASS ✅  (admin auth + lockout; CRUD over HTTP lands in the signed DB; viewer login works end-to-end)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
