// Corruption-recovery test: if the client app dies mid-write (e.g. an emulator GPU
// crash during playback), reopening a replica namespace can throw
// `OPLOG_CORRUPT: Oplog file appears corrupt or out of date` — permanently. The client
// backend treats its Corestore as a disposable cache: detect the corruption, purge the
// store, retry the open once (client/backend/recover.mjs). This reproduces the crash
// on a local store and asserts the recovery heals it. No ffmpeg, no network. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { isCorruptionError, withRecovery } from '../client/backend/recover.mjs'

const log = (...a) => console.log(...a)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2ec-store-'))

// Corestore lays each core out as <dir>/cores/<xx>/<yy>/<discoveryKey>/{oplog,tree,...}
function findOplogs (root) {
  const out = []
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const fp = path.join(root, e.name)
    if (e.isDirectory()) out.push(...findOplogs(fp))
    else if (e.name === 'oplog') out.push(fp)
  }
  return out
}

let store = null
async function cleanup () { if (store) { try { await store.close() } catch {} } try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }

try {
  // ===== 1. Seed a drive in the store (stands in for a feed replica namespace) =====
  store = new Corestore(dir); await store.ready()
  const seed = new Hyperdrive(store.namespace('replica:test'))
  await seed.ready()
  await seed.put('/index.m3u8', b4a.from('#EXTM3U\n#EXT-X-VERSION:3\n'))
  const key = b4a.toString(seed.key, 'hex')
  await store.close(); store = null
  log('seeded drive', key.slice(0, 16) + '… in', dir)

  // ===== 2. Corrupt every oplog, as if the process died mid-write =====
  const oplogs = findOplogs(dir)
  assert.ok(oplogs.length > 0, 'store must contain oplog files')
  for (const f of oplogs) {
    const fd = fs.openSync(f, 'r+')
    fs.writeSync(fd, b4a.alloc(8192, 0xff), 0, 8192, 0) // trash both 4K header pages
    fs.closeSync(fd)
  }
  log('corrupted', oplogs.length, 'oplog file(s)')

  // ===== 3. Reopen -> must fail with a detectable corruption error =====
  store = new Corestore(dir); await store.ready()
  let corruptErr = null
  try {
    const broken = new Hyperdrive(store.namespace('replica:test'), b4a.from(key, 'hex'))
    await broken.ready()
  } catch (err) { corruptErr = err }
  assert.ok(corruptErr, 'reopening a corrupted store must throw')
  log('reopen failed as expected:', (corruptErr.code || '(no code)') + ' —', corruptErr.message)
  assert.strictEqual(isCorruptionError(corruptErr), true, 'isCorruptionError must detect the reopen failure')
  assert.strictEqual(isCorruptionError(new Error('not connected to panel')), false, 'ordinary errors must not be flagged')
  try { await store.close() } catch {}
  store = null

  // ===== 4. withRecovery: purge + retry heals the open (mirrors the backend's purge) =====
  let purges = 0
  const open = async () => {
    if (!store) { store = new Corestore(dir); await store.ready() }
    const drive = new Hyperdrive(store.namespace('replica:test'), b4a.from(key, 'hex'))
    await drive.ready()
    return drive
  }
  const purgeStore = async () => {
    purges++
    if (store) { try { await store.close() } catch {} store = null }
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const drive = await withRecovery(open, purgeStore)
  assert.strictEqual(purges, 1, 'store must have been purged exactly once')
  assert.ok(drive.key, 'drive must reopen after the purge')
  assert.ok(fs.existsSync(dir), 'store dir must be recreated by the retried open')
  log('withRecovery: purged once, drive reopened clean (fresh replica, re-replicates from peers)')

  // ===== 5. Non-corruption errors must pass through without purging =====
  let purges2 = 0
  await assert.rejects(
    () => withRecovery(() => { throw new Error('login failed: invalid credentials') }, async () => { purges2++ }),
    /invalid credentials/,
    'non-corruption errors must propagate unchanged'
  )
  assert.strictEqual(purges2, 0, 'non-corruption errors must not purge the store')

  log('\nRESULT: PASS ✅  (corrupt store detected → purged → reopened clean; ordinary errors untouched)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
