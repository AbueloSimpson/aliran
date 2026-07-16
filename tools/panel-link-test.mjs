// Unit test for the broadcaster's PanelLink op queue (S15b) and its reconnect
// hardening (post-S15c). No network, no ffmpeg — the panel side is a fake RPC client
// injected through _onConnection, and the discovery session is a stub, so this runs in
// well under a second. Covers the 2026-07-16 VPS incident class headlessly:
//  1. ops queued with NO connection are delivered when a LATE connection arrives
//  2. latest-state-wins across an outage; status names the blocker ("no panel
//     connection for Ns") instead of a silent null, and clears it on delivery
//  3. while ops are stranded the link force-refreshes the topic lookup with backoff,
//     and stands down the moment a connection lands
// Exits 0 on PASS.
import assert from 'assert'
import { EventEmitter } from 'events'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { PanelLink, RELOOKUP_MIN_MS, NO_LINK_REPORT_MS } from '../broadcaster/src/panel-link.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The panel's register responder, faked at the RPC-call boundary: hands out a challenge
// on hello, rotates it on register (same one-challenge-per-socket contract as the real
// panel — see panel-link.js on why ops must be serialized). Signatures aren't verified;
// the queue mechanics under test don't depend on that.
function fakePanel () {
  const registered = [] // payloads in delivery order
  let challenge = b4a.toString(hcrypto.randomBytes(32), 'hex')
  const call = async (method, payload) => {
    if (method === 'hello') return { challenge }
    if (method === 'register') {
      challenge = b4a.toString(hcrypto.randomBytes(32), 'hex')
      registered.push(payload.payload)
      return { ok: true }
    }
    throw new Error('unexpected RPC method: ' + method)
  }
  return { call, registered }
}

class FakeSocket extends EventEmitter {
  constructor () { super(); this.destroyed = false }
  drop () { this.destroyed = true; this.emit('close') }
}

const kp = hcrypto.keyPair()
const config = {
  panelPubKey: b4a.toString(hcrypto.randomBytes(32), 'hex'),
  publisherKey: b4a.toString(kp.secretKey, 'hex')
}

try {
  // ===== 1: a late connection drains ops that queued while there was no socket =====
  // connect() is deliberately NOT called — no real swarm; connections are injected.
  const link = new PanelLink(config)
  assert.strictEqual(link.enabled, true, 'link enabled with panelPubKey+publisherKey')
  const seq1 = link.setDesired('ch1', { streamId: 'ch1', feedKey: null, isLive: true })
  assert.strictEqual(await link.flush('ch1', seq1, 300), false, 'nothing delivered without a connection')
  assert.strictEqual(link.isRegistered('ch1'), false, 'not registered without a connection')

  const panel = fakePanel()
  const sock1 = new FakeSocket()
  link._onConnection(sock1, { rpc: null, call: panel.call })
  assert.ok(await link.flush('ch1', seq1, 2000), 'queued op delivered after the late connection')
  assert.strictEqual(link.isRegistered('ch1'), true, 'registered after delivery')
  assert.strictEqual(link.lastError('ch1'), null, 'no error after delivery')
  assert.strictEqual(panel.registered.length, 1, 'exactly one register cycle')
  log('1: ops queued with no socket; _process resumes and delivers on a late connection ✓')

  // ===== 2: outage → latest-state-wins + the status message names the blocker =====
  sock1.drop() // the panel "goes down"
  const seq2 = link.setDesired('ch1', { streamId: 'ch1', feedKey: null, isLive: false })
  assert.strictEqual(await link.flush('ch1', seq2, 300), false, 'op strands while disconnected')
  // Not down long enough yet → no scary message (boot/restart churn stays quiet)...
  assert.strictEqual(link.lastError('ch1'), null, 'quiet before the report threshold')
  // ...but once the outage persists past the threshold, status says what's wrong.
  link._disconnectedSince = Date.now() - (NO_LINK_REPORT_MS + 5000) // backdate the drop
  assert.match(link.lastError('ch1'), /^no panel connection for \d+s$/, 'status names the blocker')
  assert.ok(link.health().pendingOps === 1 && !link.health().connected, 'health reflects stranded+disconnected')

  const seqStale = link.setDesired('ch1', { streamId: 'ch1', feedKey: null, isLive: true })
  const seqFinal = link.setDesired('ch1', { streamId: 'ch1', feedKey: null, isLive: false })
  link._onConnection(new FakeSocket(), { rpc: null, call: panel.call })
  assert.ok(await link.flush('ch1', seqFinal, 2000), 'stranded state delivered on reconnect')
  assert.strictEqual(panel.registered.length, 2, 'superseded states collapsed to ONE delivery (latest wins)')
  assert.strictEqual(panel.registered[1].isLive, false, 'the latest state is what landed')
  assert.strictEqual(link.lastError('ch1'), null, 'blocker message cleared on delivery')
  assert.strictEqual(link.isRegistered('ch1'), false, 'isLive:false → not registered-live')
  assert.ok(seqStale < seqFinal, 'sanity: sequence increased')
  await link.close()
  log('2: latest-state-wins across the outage; "no panel connection for Ns" surfaces then clears ✓')

  // ===== 3: stranded ops force topic re-lookups with backoff; a connection stands it down =====
  const link2 = new PanelLink(config)
  let refreshes = 0
  link2._discovery = { // stub PeerDiscoverySession
    refresh ({ client, server }) {
      assert.strictEqual(client, true, 'refresh re-queries as client')
      assert.strictEqual(server, false, 'refresh never announces')
      refreshes++
      return Promise.resolve()
    }
  }
  link2._disconnectedSince = Date.now()
  link2._relookupDelay = 40 // shrink the 5 s floor so the test runs in milliseconds
  link2.setDesired('chX', { streamId: 'chX', feedKey: null, isLive: true }) // strands → arms the nudger
  await sleep(500)
  assert.ok(refreshes >= 2, `kept forcing re-lookups while stranded (got ${refreshes})`)
  assert.ok(link2._relookupDelay > 40, 'backoff grew between re-lookups')

  const panel2 = fakePanel()
  link2._onConnection(new FakeSocket(), { rpc: null, call: panel2.call })
  await link2.flushAll(2000)
  assert.strictEqual(link2._relookupDelay, RELOOKUP_MIN_MS, 'connection resets the backoff')
  const settled = refreshes
  await sleep(300)
  assert.strictEqual(refreshes, settled, 'no more re-lookups once connected')
  await link2.close()
  log('3: forced re-lookup nudger fires with backoff, stands down on connection ✓')

  // ===== 4: a link without panel config is inert =====
  const off = new PanelLink({})
  assert.strictEqual(off.enabled, false, 'disabled without panel config')
  const seqOff = off.setDesired('x', { streamId: 'x', isLive: true })
  assert.strictEqual(await off.flush('x', seqOff, 100), true, 'flush is a no-op when disabled')
  assert.deepStrictEqual(off.health(), { enabled: false, connected: false, disconnectedForMs: 0, pendingOps: 1 }, 'health stays honest when disabled')
  await off.close()
  log('4: seed-only (no panel) link is inert ✓')

  log('\nRESULT: PASS ✅  (PanelLink queue survives late/lost connections; stranded ops force topic re-lookups; status names a dead link)')
  process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  process.exit(1)
}
