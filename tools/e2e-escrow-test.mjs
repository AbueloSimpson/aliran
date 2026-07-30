// Key escrow drill: prove the panel can put its identity somewhere safe, that what
// leaves the box is CIPHERTEXT, and that a copy can be verified without standing up a
// second panel. The mechanical half of the escrow runbook in
// docs/kb/backup-and-rotation.md.
//
// What this asserts, in order:
//   1. the export route does not exist while ESCROW_EXPORT is off
//   2. a valid admin token alone cannot export — the password is re-checked
//   3. the exported bytes contain NO recognisable key material
//   4. the cleartext fingerprint names the LIVE panel key and its pairing code
//   5. the sealed bundle really is that identity (the keypairs sign and verify)
//   6. a wrong passphrase, a corrupted ciphertext, and an EDITED fingerprint are all
//      refused — the header is the AEAD's additional data, so it cannot be swapped
//   7. the export is rate-limited, and every attempt lands in the activity ring
//   8. the offline CLI verify agrees, and --restore-to reproduces the original files
//
// Loopback HTTP only, no DHT — deterministic, belongs in the required CI lane.
import assert from 'assert'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import b4a from 'b4a'
import { pairingCode } from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeRing } from '../panel/src/activity.js'
import * as pops from '../panel/src/ops.js'
import { startAdminServer } from '../panel/src/admin-server.js'
import { openEscrow, verifyBundle, checkEnvelope, serializeEscrow, readKeyFiles, EscrowError } from '../panel/src/escrow.js'

const log = (...a) => console.log(...a)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'panel', 'src', 'admin-cli.js')

const ADMIN_PASS = 'drill-password-123'
const ESCROW_PASS = 'six random words go in this passphrase'
// Argon2id at its floor: this lane proves the FORMAT and the policy, not the cost.
// Production defaults to 256 MiB / 3 ops (panel/src/escrow.js).
const fastArgon = { memKiB: 8192, time: 1 }
const fastEscrow = { memMiB: 8, ops: 1 }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eescrow-'))
const restoreDir = path.join(dir, 'restored')
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

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
  // ===== 0. A panel with a real identity =====
  initKeys(dir)
  const keys = openKeys(dir)
  const identity = b4a.toString(keys.signing.publicKey, 'hex')
  const code = pairingCode(identity)
  const raw = {
    signing: fs.readFileSync(path.join(dir, 'keys', 'signing.json'), 'utf8'),
    oprf: fs.readFileSync(path.join(dir, 'keys', 'oprf.key'), 'utf8').trim(),
    publisher: fs.readFileSync(path.join(dir, 'keys', 'publisher.json'), 'utf8')
  }
  const signingSecret = JSON.parse(raw.signing).secretKey
  const publisherSecret = JSON.parse(raw.publisher).secretKey
  const publisherPublic = JSON.parse(raw.publisher).publicKey

  const { store, db, assets } = await openStore(dir, keys)
  cleanups.push(() => store.close())
  const ring = makeRing(200)
  const ctx = (escrowOn) => ({
    config: {
      argon2: fastArgon,
      maxDevicesDefault: 2,
      serviceName: 'Escrow Drill TV',
      escrow: { exportEnabled: escrowOn, argon2: fastEscrow }
    },
    keys,
    db,
    assets,
    dataDir: dir,
    activity: ring,
    pairingCode: code
  })
  pops.addAdmin(ctx(false), 'ops', ADMIN_PASS)
  log('panel initialized —', identity.slice(0, 16) + '…', 'pairing code', code, '✓')

  // ===== 1. Off by default: the route does not exist =====
  {
    const srv = await startAdminServer(ctx(false), { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 100, seconds: 60 } })
    const { body: login } = await api(srv.port, 'POST', '/api/login', { username: 'ops', password: ADMIN_PASS })
    assert.ok(login.token, 'admin login works')
    const st = await api(srv.port, 'GET', '/api/status', undefined, login.token)
    assert.strictEqual(st.body.escrowExport, false, '/api/status reports escrow export OFF')
    const r = await api(srv.port, 'POST', '/api/identity/escrow', { password: ADMIN_PASS, passphrase: ESCROW_PASS }, login.token)
    assert.strictEqual(r.status, 404, 'escrow export 404s while ESCROW_EXPORT is off (got ' + r.status + ')')
    assert.match(r.body.error, /ESCROW_EXPORT/, 'the 404 names the flag that turns it on')
    await srv.close()
  }
  log('ESCROW_EXPORT off → the export route does not exist ✓')

  // ===== 2. On, but a session alone is not enough =====
  const srv = await startAdminServer(ctx(true), { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 100, seconds: 60 } })
  cleanups.push(() => srv.close())
  const { body: login } = await api(srv.port, 'POST', '/api/login', { username: 'ops', password: ADMIN_PASS })
  const token = login.token
  {
    const st = await api(srv.port, 'GET', '/api/status', undefined, token)
    assert.strictEqual(st.body.escrowExport, true, '/api/status reports escrow export ON')
  }

  // ===== 3. The export itself (throttle budget: 3/hour, so count the calls) =====
  const exported = await api(srv.port, 'POST', '/api/identity/escrow', { password: ADMIN_PASS, passphrase: ESCROW_PASS }, token) // 1
  assert.strictEqual(exported.status, 200, 'export succeeds with password + passphrase (got ' + exported.status + ': ' + JSON.stringify(exported.body) + ')')
  const out = exported.body
  assert.ok(out.escrow && out.filename && out.fingerprint, 'the response carries the envelope, a filename and a fingerprint')
  assert.strictEqual(out.verified.ok, true, 'the panel verified its own output before answering')
  assert.match(out.filename, /^aliran-escrow-.+\.json$/, 'the filename names the deployment and the moment')
  log('export →', out.filename, `(argon2id ${out.kdf.memMiB} MiB / ${out.kdf.opslimit} ops, self-verified) ✓`)

  // ===== 4. What leaves the box is CIPHERTEXT =====
  const bytes = serializeEscrow(out.escrow)
  const needles = [
    ['signing secret key', signingSecret],
    ['signing secret key (raw bytes)', b4a.toString(b4a.from(signingSecret, 'hex'), 'base64')],
    ['OPRF key', raw.oprf],
    ['OPRF key (raw bytes)', b4a.toString(b4a.from(raw.oprf, 'hex'), 'base64')],
    ['publisher secret key', publisherSecret],
    ['publisher public key', publisherPublic], // not in the header, so it must be sealed
    ['the literal "secretKey"', 'secretKey']
  ]
  for (const [what, needle] of needles) {
    assert.ok(!bytes.includes(needle), `the exported bytes do not contain ${what}`)
  }
  // …and the ONE key that is deliberately in the clear, because it is public.
  assert.ok(bytes.includes(identity), 'the panel PUBLIC key is readable without the passphrase (by design)')
  log('exported bytes hold no key material —', needles.length, 'needles absent, public key present ✓')

  // ===== 5. The fingerprint names the live deployment =====
  assert.strictEqual(out.fingerprint.panelPublicKey, identity, 'the fingerprint matches the LIVE panel key')
  assert.strictEqual(out.fingerprint.pairingCode, code, 'the fingerprint carries the live pairing code')
  assert.strictEqual(out.fingerprint.serviceName, 'Escrow Drill TV', 'the fingerprint records the service name')
  assert.deepStrictEqual(
    out.fingerprint.files.map((f) => f.name).sort(),
    ['oprf.key', 'publisher.json', 'signing.json'],
    'the fingerprint lists every key file'
  )

  // ===== 6. It really is the identity, and it really opens =====
  const opened = await openEscrow({ envelope: checkEnvelope(bytes), passphrase: ESCROW_PASS })
  assert.strictEqual(opened.files['signing.json'], raw.signing, 'the sealed signing key is byte-identical to the live one')
  assert.strictEqual(opened.files['oprf.key'].trim(), raw.oprf, 'the sealed OPRF key is byte-identical to the live one')
  assert.strictEqual(opened.files['publisher.json'], raw.publisher, 'the sealed publisher key is byte-identical to the live one')
  const verified = verifyBundle(opened.files, out.fingerprint)
  assert.strictEqual(verified.ok, true, 'the bundle verifies: ' + JSON.stringify(verified.checks.filter((c) => !c.ok)))
  log('decrypted bundle is byte-identical to DATA_DIR/keys/ and verifies —', verified.checks.length, 'checks ✓')

  // ===== 7. Refusals: wrong passphrase, corruption, an edited fingerprint =====
  const rejects = async (what, mutate, passphrase = ESCROW_PASS) => {
    const env = JSON.parse(bytes)
    mutate(env)
    await assert.rejects(
      () => openEscrow({ envelope: checkEnvelope(env), passphrase }),
      (err) => err instanceof EscrowError && err.code === 'bad-passphrase',
      what
    )
  }
  await rejects('a wrong passphrase is refused', () => {}, ESCROW_PASS + '!')
  await rejects('a corrupted ciphertext is refused', (env) => {
    const buf = b4a.from(env.ciphertext, 'base64')
    buf[Math.floor(buf.length / 2)] ^= 1 // one flipped bit, anywhere in the payload
    env.ciphertext = b4a.toString(buf, 'base64')
  })
  await rejects('a truncated ciphertext is refused', (env) => {
    const buf = b4a.from(env.ciphertext, 'base64')
    env.ciphertext = b4a.toString(buf.subarray(0, buf.length - 8), 'base64')
  })
  // The cleartext header is the AEAD's additional data. Re-labelling a file as another
  // deployment's therefore destroys it, rather than producing a convincing forgery.
  await rejects('an edited panel key in the fingerprint is refused', (env) => {
    env.fingerprint.panelPublicKey = env.fingerprint.panelPublicKey.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))
  })
  await rejects('an edited pairing code in the fingerprint is refused', (env) => {
    env.fingerprint.pairingCode = 'ZZZZ-ZZZZ-ZZZZ'
  })
  // Re-indenting the file must NOT break it: the additional data is rebuilt from the
  // parsed values, not from the raw bytes.
  const reindented = JSON.stringify(JSON.parse(bytes))
  await openEscrow({ envelope: checkEnvelope(reindented), passphrase: ESCROW_PASS })
  log('refuses wrong passphrase / corruption / truncation / an edited fingerprint; survives re-indenting ✓')

  // Structural rejections need no passphrase at all.
  assert.throws(() => checkEnvelope('{"format":"something-else"}'), /not an Aliran key escrow file/, 'a foreign JSON file is refused')
  assert.throws(() => checkEnvelope('not json'), /not valid JSON/, 'a non-JSON file is refused')

  // ===== 8. Re-auth, weak passphrase, rate limit =====
  {
    const r = await api(srv.port, 'POST', '/api/identity/escrow', { password: 'wrong-password', passphrase: ESCROW_PASS }, token) // 2
    assert.strictEqual(r.status, 401, 'a valid session with the WRONG password cannot export (got ' + r.status + ')')
  }
  {
    const r = await api(srv.port, 'POST', '/api/identity/escrow', { password: ADMIN_PASS, passphrase: 'short' }, token) // 3
    assert.strictEqual(r.status, 400, 'a passphrase under the minimum is refused (got ' + r.status + ')')
    assert.strictEqual(r.body.code, 'weak-passphrase', 'the refusal says why')
  }
  {
    const r = await api(srv.port, 'POST', '/api/identity/escrow', { password: ADMIN_PASS, passphrase: ESCROW_PASS }, token) // 4 > 3
    assert.strictEqual(r.status, 429, 'the 4th attempt in the window is rate-limited (got ' + r.status + ')')
    assert.ok(r.body.retryAfter > 0, 'the 429 says when to come back')
  }
  log('re-auth required · weak passphrase refused · 4th attempt in the hour throttled ✓')

  // ===== 9. Every attempt is a first-class security event =====
  const security = ring.list().filter((e) => e.type === 'security')
  const ops = security.map((e) => e.op)
  for (const op of ['escrow-export', 'escrow-export-denied', 'escrow-export-throttled']) {
    assert.ok(ops.includes(op), `the activity ring records ${op} (saw: ${ops.join(', ') || 'nothing'})`)
  }
  const success = security.find((e) => e.op === 'escrow-export')
  assert.strictEqual(success.admin, 'ops', 'the event names the admin who exported')
  assert.strictEqual(success.pairingCode, code, 'the event names what was exported')
  assert.ok(!JSON.stringify(security).includes(signingSecret), 'the activity ring holds no key material')
  log('activity ring:', ops.length, 'security events —', ops.join(', '), '✓')

  // ===== 10. The offline CLI verify — no panel, no DATA_DIR, no swarm =====
  const file = path.join(dir, out.filename)
  fs.writeFileSync(file, bytes)
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  {
    const r = cli('verify-escrow', file, '--passphrase', ESCROW_PASS)
    assert.strictEqual(r.status, 0, 'CLI verify-escrow exits 0 on a good file:\n' + r.stdout + r.stderr)
    assert.match(r.stdout, /VERIFIED/, 'CLI verify-escrow says VERIFIED')
    assert.ok(r.stdout.includes(identity), 'CLI verify-escrow prints the panel key from the cleartext header')
    assert.ok(r.stdout.includes(code), 'CLI verify-escrow prints the pairing code')
  }
  {
    const r = cli('verify-escrow', file, '--passphrase', 'definitely not the passphrase')
    assert.strictEqual(r.status, 1, 'CLI verify-escrow exits non-zero on a wrong passphrase')
    assert.match(r.stderr, /FAILED/, 'CLI verify-escrow fails loudly')
  }
  {
    const r = cli('verify-escrow', file, '--passphrase', ESCROW_PASS, '--restore-to', restoreDir)
    assert.strictEqual(r.status, 0, 'CLI --restore-to exits 0:\n' + r.stdout + r.stderr)
    assert.match(r.stdout, /Only ONE panel may ever run with this identity/, '--restore-to warns about the never-two-writers rule')
    for (const [name, want] of [['signing.json', raw.signing], ['publisher.json', raw.publisher]]) {
      assert.strictEqual(fs.readFileSync(path.join(restoreDir, name), 'utf8'), want, `restored ${name} is byte-identical`)
    }
    assert.strictEqual(fs.readFileSync(path.join(restoreDir, 'oprf.key'), 'utf8').trim(), raw.oprf, 'restored oprf.key is byte-identical')
    // A second extraction into the same directory must not silently clobber it.
    const again = cli('verify-escrow', file, '--passphrase', ESCROW_PASS, '--restore-to', restoreDir)
    assert.strictEqual(again.status, 1, '--restore-to refuses a non-empty directory')
  }
  log('offline CLI verify: good file ✓ · wrong passphrase rejected ✓ · --restore-to round-trips ✓')

  // ===== 11. The bundle is the DIRECTORY, and it refuses what it cannot carry =====
  // Escrowing every file in keys/ means a future key file is covered the day it
  // appears. The cost is that the payload is JSON, so a BINARY file would round-trip
  // through UTF-8 lossily — and a corrupted key that still decrypts is the worst
  // failure this feature could have. It must refuse rather than truncate.
  {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eescrow-dir-'))
    initKeys(scratch)
    const keysDir = path.join(scratch, 'keys')
    fs.writeFileSync(path.join(keysDir, 'future.json'), '{"k":1}')
    assert.ok(readKeyFiles(scratch)['future.json'], 'a NEW text key file is escrowed automatically')
    fs.writeFileSync(path.join(keysDir, 'future.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]))
    assert.throws(() => readKeyFiles(scratch),
      (err) => err instanceof EscrowError && err.code === 'binary-key-file',
      'a binary key file is refused, not silently corrupted')
    fs.rmSync(path.join(keysDir, 'future.bin'))
    fs.rmSync(path.join(keysDir, 'signing.json'))
    assert.throws(() => readKeyFiles(scratch), /no signing.json/, 'a bundle with no signing key is refused')
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  log('bundle = the whole keys/ directory: new text files included, binary refused ✓')

  await cleanup()
  log('\nescrow drill PASSED')
} catch (err) {
  console.error('\nescrow drill FAILED:', err && err.message ? err.message : err)
  if (err && err.stack) console.error(err.stack)
  await cleanup()
  process.exit(1)
}
