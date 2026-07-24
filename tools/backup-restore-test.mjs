// Backup/restore drill (S41): prove a COLD COPY of the panel's DATA_DIR is a
// complete backup — a panel reopened from the copy signs with the same identity,
// verifies the same admins, and serves the same accounts + catalog over its admin
// API. This is the mechanical half of docs/kb/backup-and-rotation.md; the runbook's
// tar pipeline moves the same bytes this test copies.
// Loopback HTTP only, no DHT — deterministic, belongs in the required CI lane.
import assert from 'assert'
import os from 'os'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeRing } from '../panel/src/activity.js'
import * as pops from '../panel/src/ops.js'
import { startAdminServer } from '../panel/src/admin-server.js'

const log = (...a) => console.log(...a)
const fastArgon = { memKiB: 8192, time: 1 }
const dirs = {
  live: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ebak-live-')),
  copy: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ebak-copy-'))
}
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

async function api (port, method, p, body, token) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, body: json }
}

try {
  // ===== 1. A live panel with real state =====
  initKeys(dirs.live)
  const keys1 = openKeys(dirs.live)
  const identity = b4a.toString(keys1.signing.publicKey, 'hex')
  {
    const { store, db, assets } = await openStore(dirs.live, keys1)
    const pctx = { config: { argon2: fastArgon, maxDevicesDefault: 2 }, keys: keys1, db, assets, dataDir: dirs.live, activity: makeRing(200) }
    pops.addAdmin(pctx, 'ops', 'drill-password-123')
    const srv = await startAdminServer(pctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 100, seconds: 60 } })
    const { body: login } = await api(srv.port, 'POST', '/api/login', { username: 'ops', password: 'drill-password-123' })
    assert.ok(login.token, 'live panel: admin login')
    let r = await api(srv.port, 'POST', '/api/users', { username: 'alice', password: 'alice-pass-1234' }, login.token)
    assert.ok(r.status < 300, 'live panel: user created (' + r.status + ')')
    r = await api(srv.port, 'POST', '/api/streams', { id: 'ch1', title: 'Channel One' }, login.token)
    assert.ok(r.status < 300, 'live panel: stream created (' + r.status + ')')
    r = await api(srv.port, 'POST', '/api/users/alice/grants', { streamId: 'ch1' }, login.token)
    assert.ok(r.status < 300, 'live panel: grant added (' + r.status + ')')
    await srv.close()
    await store.close() // COLD: the copy below happens with the store closed
  }
  log('live panel populated (admin + user + stream + grant), closed cold ✓')

  // ===== 2. The "backup": a plain cold copy of DATA_DIR =====
  fs.cpSync(dirs.live, dirs.copy, { recursive: true })
  for (const f of ['keys/signing.json', 'keys/oprf.key', 'keys/publisher.json', 'secrets/admins.json']) {
    assert.ok(fs.existsSync(path.join(dirs.copy, f)), `backup contains ${f}`)
  }
  log('cold copy taken; keys + secrets present in the archive set ✓')

  // ===== 3. Restore: a panel booted from the copy is the same deployment =====
  const keys2 = openKeys(dirs.copy)
  assert.strictEqual(b4a.toString(keys2.signing.publicKey, 'hex'), identity, 'restored panel signs with the SAME identity')
  const { store, db, assets } = await openStore(dirs.copy, keys2)
  cleanups.push(() => store.close())
  const pctx2 = { config: { argon2: fastArgon, maxDevicesDefault: 2 }, keys: keys2, db, assets, dataDir: dirs.copy, activity: makeRing(200) }
  const srv2 = await startAdminServer(pctx2, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 100, seconds: 60 } })
  cleanups.push(() => srv2.close())
  const { body: login2 } = await api(srv2.port, 'POST', '/api/login', { username: 'ops', password: 'drill-password-123' })
  assert.ok(login2.token, 'restored panel verifies the same admin credentials')
  let r = await api(srv2.port, 'GET', '/api/users/alice', undefined, login2.token)
  assert.strictEqual(r.status, 200, 'restored panel serves the account DB')
  const alice = JSON.stringify(r.body)
  assert.ok(alice.includes('alice') && alice.includes('ch1'), 'account record carries the user and its grant')
  r = await api(srv2.port, 'GET', '/api/streams', undefined, login2.token)
  const ids = (r.body.streams || r.body || []).map((s) => s.id || s.streamId)
  assert.ok(r.status === 200 && ids.includes('ch1'), 'restored panel serves the catalog')
  const hz = await fetch(`http://127.0.0.1:${srv2.port}/healthz`)
  assert.strictEqual(hz.status, 200, 'restored panel healthz answers')
  log('restored panel: same identity, same admins, same accounts + catalog ✓')

  console.log('\nRESULT: PASS ✅  (a cold DATA_DIR copy is a complete panel backup — identity, credentials, accounts and catalog all restore)')
  await cleanup()
  process.exit(0)
} catch (err) {
  console.error('\nFAIL:', err)
  await cleanup()
  process.exit(1)
}
