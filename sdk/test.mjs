// @aliran/player-sdk unit tests — fast, no network/ffmpeg. The full engine is
// exercised end-to-end by `npm run test:sdk` (tools/e2e-sdk-test.mjs) from the repo root.
import assert from 'assert'
import { AliranPlayer, createPlayer, isCorruptionError, withRecovery } from './index.js'

let n = 0
function ok (name) { n++; console.log('  ok ', name) }

// --- corruption detection (re-exported from recover.js) ---
{
  const err = new Error('nope'); err.code = 'OPLOG_CORRUPT'
  assert.strictEqual(isCorruptionError(err), true)
  assert.strictEqual(isCorruptionError(new Error('Oplog file appears corrupt or out of date')), true)
  assert.strictEqual(isCorruptionError(new Error('ECONNRESET')), false)
  assert.strictEqual(isCorruptionError(null), false)
  ok('isCorruptionError codes + message fallback')
}

// --- withRecovery: purge once on corruption, propagate everything else ---
{
  let purges = 0; let recovered = null
  const corrupt = () => { const e = new Error('bad'); e.code = 'INVALID_CHECKSUM'; return e }
  let failures = 1
  const result = await withRecovery(
    async () => { if (failures-- > 0) throw corrupt(); return 42 },
    async () => { purges++ },
    (err) => { recovered = err }
  )
  assert.strictEqual(result, 42)
  assert.strictEqual(purges, 1)
  assert.ok(recovered && recovered.code === 'INVALID_CHECKSUM')

  purges = 0
  await assert.rejects(
    () => withRecovery(async () => { throw new Error('ordinary') }, async () => { purges++ }),
    /ordinary/
  )
  assert.strictEqual(purges, 0, 'ordinary errors must not purge')
  ok('withRecovery purges once and only on corruption')
}

// --- constructor contract ---
{
  assert.throws(() => new AliranPlayer({}), /injected \{ http, fs \}/)
  const p = createPlayer({ storeDir: './never-created' }) // Node entry injects http/fs
  assert.deepStrictEqual(p.listStreams(), [])
  assert.strictEqual(p.assetUrl('assets/x/poster.png'), undefined, 'no server before login')
  assert.strictEqual(p.assetUrl(null), undefined)
  await assert.rejects(() => p.connect(), /no panelPubKey/)
  await assert.rejects(() => p.resolve('nope'), /not entitled/)
  await assert.rejects(() => p.login('u', 'p'), /not connected to panel/)
  ok('constructor + method guards (no side effects before connect)')
}

// --- hybrid config validation (S10b) ---
{
  assert.throws(() => createPlayer({ hybrid: { mode: 'bogus' } }), /hybrid\.mode/)
  assert.throws(() => createPlayer({ hybrid: { mode: 'hybrid' } }), /cdnUrl/)
  assert.throws(() => createPlayer({ hybrid: { mode: 'cdn-only' } }), /cdnUrl/)
  assert.throws(() => createPlayer({ hybrid: { start: 'sometimes' } }), /hybrid\.start/)
  const p = createPlayer({ hybrid: { mode: 'hybrid', cdnUrl: 'http://cdn.example/{streamId}/index.m3u8' } })
  assert.strictEqual(p.source(), null, 'no active source before resolve')
  const q = createPlayer({}) // p2p-only default needs no cdnUrl
  assert.strictEqual(q.source(), null)
  ok('hybrid config validation (mode/start/cdnUrl); source() null before resolve')
}

// --- swarm option (S20a): validation + plumbing into the ONE Hyperswarm ---
{
  assert.throws(() => createPlayer({ swarm: { maxPeers: 0 } }), /swarm\.maxPeers/)
  assert.throws(() => createPlayer({ swarm: { maxPeers: 1.5 } }), /swarm\.maxPeers/)
  assert.throws(() => createPlayer({ swarm: { maxPeers: 'lots' } }), /swarm\.maxPeers/)
  createPlayer({ swarm: {} }) // maxPeers omitted = default, valid
  const os = await import('os'); const fs = await import('fs'); const path = await import('path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-swarm-'))
  const p = createPlayer({ storeDir: dir, swarm: { maxPeers: 300 } })
  const q = createPlayer({ storeDir: dir + '-b' })
  try {
    await p._ensureStore(); await q._ensureStore() // no join/announce — offline-safe
    assert.strictEqual(p._swarm.maxPeers, 300, 'maxPeers reaches the Hyperswarm instance')
    assert.strictEqual(q._swarm.maxPeers, 64, 'omitted = hyperswarm default untouched')
  } finally {
    await p.stop(); await q.stop()
    for (const d of [dir, dir + '-b']) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  }
  ok('swarm.maxPeers validated + plumbed into Hyperswarm (default preserved)')
}

// --- event emitter basics (on/off/once, no throw on unhandled error) ---
{
  const p = createPlayer({})
  let hits = 0
  const fn = () => hits++
  p.on('status', fn)
  p.emit('status', { state: 'x' })
  p.off('status', fn)
  p.emit('status', { state: 'x' })
  assert.strictEqual(hits, 1)
  p.once('peers', fn)
  p.emit('peers', 1); p.emit('peers', 2)
  assert.strictEqual(hits, 2)
  p.emit('error', new Error('unhandled')) // must not throw
  ok('emitter on/off/once; unhandled error event is safe')
}

console.log(`\nRESULT: PASS ✅  (${n} tests)`)
