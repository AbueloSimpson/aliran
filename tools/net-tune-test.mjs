// Tests for swarm UDP socket tuning (core/net-tune.js). Groups A/B/E are pure — no
// network, no disk. Groups C/D bind real udx sockets on loopback (a Hyperswarm on a
// 1-node testnet), so they are fast and deterministic but do touch the local stack.
// npm run test:nettune
import assert from 'assert'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import {
  evaluateBuffer, readKernelCeilings, tuneSocket, tuneSwarm,
  tuningMessages, logSwarmTuning, _resetTuningLog, SYSCTL_KEYS, DEFAULT_BUFFER_BYTES
} from '../core/net-tune.js'

const log = (...a) => console.log(...a)
const MB = 1048576

// ===== A: evaluateBuffer — the doubling trap =====
// Linux caps a request at net.core.{r,w}mem_max and THEN stores double the capped value.
// So for any request between the ceiling and twice the ceiling, the readback is LARGER
// than what was asked for even though the request was capped. A readback-only check
// reports success there; this is the exact case the /proc ceiling exists to catch.
assert.deepStrictEqual(
  evaluateBuffer({ requested: 3 * MB, achieved: 4 * MB, ceiling: 2 * MB }),
  { requested: 3 * MB, achieved: 4 * MB, ceiling: 2 * MB, ok: false, clamped: true, skipped: false },
  'capped-then-doubled must read as CLAMPED even though achieved > requested')

// Within the ceiling: honoured, doubling is irrelevant.
assert.strictEqual(evaluateBuffer({ requested: 2 * MB, achieved: 4 * MB, ceiling: 4 * MB }).ok, true)
assert.strictEqual(evaluateBuffer({ requested: 2 * MB, achieved: 4 * MB, ceiling: 2 * MB }).ok, true, 'requested == ceiling is honoured')

// No ceiling (Windows/macOS, or /proc absent) → fall back to the readback.
assert.strictEqual(evaluateBuffer({ requested: 2 * MB, achieved: 2 * MB, ceiling: null }).ok, true)
assert.strictEqual(evaluateBuffer({ requested: 2 * MB, achieved: 208 * 1024, ceiling: null }).clamped, true, 'hard clamp still caught without /proc')

// 0 / negative = operator opted out of that direction; never a warning.
for (const requested of [0, -1]) {
  const r = evaluateBuffer({ requested, achieved: 1234, ceiling: 2 * MB })
  assert.strictEqual(r.skipped, true); assert.strictEqual(r.ok, true); assert.strictEqual(r.clamped, false)
}
log('A: evaluateBuffer — ceiling authoritative, doubling trap caught, opt-out clean ✓')

// ===== B: readKernelCeilings never throws =====
assert.deepStrictEqual(readKernelCeilings(() => '8388608'), { recv: 8388608, send: 8388608 })
assert.deepStrictEqual(readKernelCeilings(() => ' 4194304\n'), { recv: 4194304, send: 4194304 }, 'trailing newline from /proc')
assert.deepStrictEqual(readKernelCeilings(() => { throw new Error('ENOENT') }), { recv: null, send: null }, 'non-Linux → nulls, no throw')
assert.deepStrictEqual(readKernelCeilings(() => 'not-a-number'), { recv: null, send: null })
assert.deepStrictEqual(readKernelCeilings(() => '0'), { recv: null, send: null }, '0 is not a usable ceiling')
log('B: readKernelCeilings parses /proc and degrades to null off Linux ✓')

// ===== C: tuneSocket against a real bound udx socket =====
{
  const testnet = await createTestnet(1)
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  await swarm.dht.ready()
  const socket = swarm.dht.io.serverSocket

  // udx raises RECV to 1 MiB itself but leaves SEND at the OS default — the asymmetry
  // this whole module exists to close. Assert the send side really is the smaller one
  // before we touch it, so the test fails loudly if a future udx starts tuning both.
  const sendBefore = socket.getSendBufferSize()
  const recvBefore = socket.getRecvBufferSize()
  assert.ok(sendBefore < recvBefore, `expected udx to leave send (${sendBefore}) below recv (${recvBefore})`)

  const ceilings = readKernelCeilings()
  const target = 2 * MB
  const r = tuneSocket(socket, { recvBytes: target, sendBytes: target, ceilings })
  assert.strictEqual(r.error, null, 'tuning a live socket must not error')
  assert.ok(r.recv && r.send, 'both directions reported')

  // Which outcome is correct depends on the HOST, so assert the right one for it. A stock
  // Linux box (wmem_max 212992 — including most CI runners) genuinely cannot grant 2 MiB,
  // and there the correct behaviour is to report the clamp, not to grow. That branch is
  // the one operators actually hit, so it is worth exercising for real rather than mocking.
  const sendAfter = socket.getSendBufferSize()
  assert.ok(sendAfter >= sendBefore, 'tuning must never shrink a buffer')
  if (ceilings.send === null || ceilings.send >= target) {
    assert.ok(sendAfter > sendBefore, 'where the kernel permits it, the send buffer actually grows')
    assert.strictEqual(r.send.clamped, false)
  } else {
    assert.strictEqual(r.send.clamped, true, 'a host whose ceiling is below the target must report the clamp')
  }

  // A socket that refuses setsockopt must be reported, never thrown — tuning is
  // best-effort and must not be able to take a broadcaster down.
  const hostile = { setRecvBufferSize () { throw new Error('EPERM') }, getRecvBufferSize: () => 0, setSendBufferSize () {}, getSendBufferSize: () => 0 }
  const h = tuneSocket(hostile, { recvBytes: MB, sendBytes: MB })
  assert.strictEqual(h.error, 'EPERM'); assert.strictEqual(h.recv, null)

  await swarm.destroy()
  await testnet.destroy()
  log('C: tuneSocket raises the untuned send buffer on a live socket; failures reported not thrown ✓')
}

// ===== D: tuneSwarm covers BOTH dht sockets, and opting out is a no-op =====
{
  const testnet = await createTestnet(1)
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })

  // No dht.ready() first: tuneSwarm must await the lazy socket bind itself, otherwise it
  // would silently find nothing to tune when called right after `new Hyperswarm()`.
  const report = await tuneSwarm(swarm, { recvBytes: 2 * MB, sendBytes: 2 * MB })
  assert.strictEqual(report.error, null)
  assert.deepStrictEqual(report.sockets.map(s => s.name), ['serverSocket', 'clientSocket'], 'both sockets tuned')
  for (const s of report.sockets) assert.ok(s.recv && s.send && !s.error)

  const off = await tuneSwarm(swarm, { recvBytes: 0, sendBytes: 0 })
  assert.deepStrictEqual(off.sockets, [], 'both directions disabled → nothing touched')
  assert.strictEqual(off.clamped, false)

  await swarm.destroy()
  await testnet.destroy()
  log('D: tuneSwarm awaits the lazy bind, tunes both sockets, honours full opt-out ✓')
}

// ===== E: operator-facing messages + process-wide dedupe =====
{
  const clamped = {
    sockets: [{ name: 'serverSocket', error: null, recv: null, send: { requested: 2 * MB, achieved: 425984, ceiling: 212992, ok: false, clamped: true, skipped: false } }],
    clamped: true, error: null, ceilings: { recv: 212992, send: 212992 }, recvBytes: 2 * MB, sendBytes: 2 * MB
  }
  const msgs = tuningMessages(clamped)
  assert.strictEqual(msgs.length, 1)
  // The warning has to be actionable on its own: the sysctl key AND the value to set.
  assert.ok(msgs[0].includes(SYSCTL_KEYS.send), 'names the sysctl to change')
  assert.ok(msgs[0].includes(`${SYSCTL_KEYS.send}=${2 * MB}`), 'gives the exact command')
  assert.ok(/netstat -su/.test(msgs[0]), 'points at where the drops show up')

  const healthy = { sockets: [{ name: 'serverSocket', error: null, recv: { ok: true, clamped: false }, send: { ok: true, clamped: false } }], clamped: false, error: null, ceilings: { recv: 8 * MB, send: 8 * MB }, recvBytes: 2 * MB, sendBytes: 2 * MB }
  assert.ok(/tuned/.test(tuningMessages(healthy)[0]), 'healthy path still confirms what was applied')

  // The broadcaster tunes one swarm PER CHANNEL. A clamp is a host property, so 43
  // channels must not print 43 identical warnings and bury it.
  _resetTuningLog()
  const seen = []
  for (let i = 0; i < 43; i++) logSwarmTuning(clamped, (m) => seen.push(m))
  assert.strictEqual(seen.length, 1, `expected 1 deduped warning across 43 channels, got ${seen.length}`)
  _resetTuningLog()
  log('E: warnings are actionable and deduped process-wide ✓')
}

// ===== F: the runtime-agnostic core (S33 split for the Bare worklet) =====
// core/net-tune-core.js is what sdk/player.js bundles into the Android worklet, where a
// node:fs edge in the module graph becomes a `builtin:` ref the worklet cannot load. The
// contract is therefore twofold: the file must import NOTHING, and every fs touch must go
// through an injected readFile — absent one, ceilings degrade to null (readback fallback)
// instead of throwing.
{
  const fs = await import('fs')
  const src = fs.readFileSync(new URL('../core/net-tune-core.js', import.meta.url), 'utf8')
  assert.ok(!/^\s*import\s/m.test(src), 'net-tune-core.js must have no import statements (Bare worklet graph)')

  const core = await import('../core/net-tune-core.js')
  assert.deepStrictEqual(core.readKernelCeilings(), { recv: null, send: null }, 'no readFile → nulls, no throw')
  assert.deepStrictEqual(core.readKernelCeilings(() => '8388608'), { recv: 8388608, send: 8388608 }, 'injected readFile honoured')

  // tuneSwarm hands the injected readFile to the ceiling read; a fake swarm keeps this
  // group pure. Buffers are Buffer-typed on bare-fs, so a Buffer return must parse too.
  const calls = []
  const sock = (name) => ({
    setRecvBufferSize: (n) => calls.push([name, 'recv', n]),
    getRecvBufferSize: () => 4 * MB,
    setSendBufferSize: (n) => calls.push([name, 'send', n]),
    getSendBufferSize: () => 4 * MB
  })
  const fakeSwarm = { dht: { ready: async () => {}, io: { serverSocket: sock('server'), clientSocket: sock('client') } } }
  const report = await core.tuneSwarm(fakeSwarm, { recvBytes: 2 * MB, sendBytes: 0, readFile: () => Buffer.from('8388608\n') })
  assert.deepStrictEqual(report.ceilings, { recv: 8388608, send: 8388608 }, 'Buffer readFile output parses (bare-fs returns Buffers)')
  assert.deepStrictEqual(calls, [['server', 'recv', 2 * MB], ['client', 'recv', 2 * MB]], 'recv requested on both sockets, send untouched')
  assert.strictEqual(report.clamped, false)

  // The viewer default is recv-only; its summary must say "untouched", not "0 MiB",
  // which would read as if the send buffer had been shrunk to nothing.
  const line = core.tuningMessages(report)[0]
  assert.ok(/recv 2 MiB, send untouched/.test(line), `viewer-style summary: ${line}`)
  log('F: runtime-agnostic core — no imports, injected readFile, recv-only summary ✓')
}

assert.strictEqual(DEFAULT_BUFFER_BYTES, 2 * MB)
log('\nnet-tune: ALL PASS')
