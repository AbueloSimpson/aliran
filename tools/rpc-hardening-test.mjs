// Panel login-RPC hardening regression tests (loopback, deterministic — no DHT).
//
// Covers the S42 hardening pass:
//   A. Malformed RPC payloads must FAIL CLOSED, never crash the process. Before the
//      fix, a client-supplied hex field that was a JSON object/number (not a string)
//      made b4a.from(x,'hex') throw a TypeError; protomux-rpc funnels the throw to
//      safety-catch, which RETHROWS TypeError into a microtask → an uncaught crash.
//      `login {powNonce:{}}` was an UNAUTHENTICATED remote panel kill. We wire the real
//      attachLoginRpc over a real @hyperswarm/secret-stream pair and fire the bad
//      payloads; a crash would take this test process down, so surviving with clean
//      error replies IS the assertion (plus explicit uncaught/rejection guards).
//   B. Register replay protection: a captured, validly-signed register cannot be
//      replayed to roll a channel's feedKey back — the per-connection challenge rotates
//      one-shot, so the second submission fails signature verification.
//   C. makeThrottle boundedness: a flood of distinct keys cannot grow the map without
//      bound; normal fixed-window limiting still triggers.
//   D. Legacy-publisher sunset predicate: the boot warning fires exactly when the
//      shared init key is still enabled while named publishers are enrolled.
//
// Exits 0 on PASS, 1 on any failure.

import os from 'os'
import fs from 'fs'
import path from 'path'
import SecretStream from '@hyperswarm/secret-stream'
import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { blind, powSolve, authKeyPair, authSign } from '@aliran/core'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { legacyPublisherActiveWithNamed } from '../panel/src/ops.js'

let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { console.error('  FAIL', msg); failures++ } }

// Any uncaught exception / unhandled rejection here means a handler crashed the way the
// bug did — record it as a hard failure rather than letting the process die silently.
let crashed = null
process.on('uncaughtException', (e) => { crashed = e; console.error('  FAIL uncaughtException:', e && e.message); failures++ })
process.on('unhandledRejection', (e) => { crashed = e; console.error('  FAIL unhandledRejection:', e && e.message); failures++ })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A connected, encrypted SecretStream pair — the same stream type a real swarm hands
// attachLoginRpc, but loopback and DHT-free.
function streamPair () {
  const a = new SecretStream(true)
  const b = new SecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  return [a, b]
}

// Minimal in-memory stand-in for the signed account/catalog Hyperbee.
function fakeDb (seed = {}) {
  const m = new Map(Object.entries(seed))
  return {
    async get (k) { return m.has(k) ? { value: m.get(k) } : null },
    async put (k, v) { m.set(k, v) },
    async del (k) { m.delete(k) },
    _map: m
  }
}

function rpcClient (stream) {
  const rpc = new ProtomuxRPC(stream)
  const call = async (method, payload) => {
    const buf = payload === undefined ? b4a.alloc(0) : b4a.from(JSON.stringify(payload))
    // A responder that crashes never sends a reply, so the request would hang forever.
    // Bound it: a timeout here means the handler died — exactly the regression to catch.
    let timer
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`rpc '${method}' timed out — handler likely crashed`)), 4000) })
    try {
      const res = await Promise.race([rpc.request(method, buf), timeout])
      return JSON.parse(b4a.toString(res))
    } finally { clearTimeout(timer) }
  }
  return { rpc, call }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-hardening-'))
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }

try {
  // Shared server-side crypto material for the authenticated paths.
  const oprfKey = hcrypto.randomBytes(32)
  const signing = hcrypto.keyPair()
  const publisher = authKeyPair() // legacy shared publisher key
  const alice = authKeyPair() // a user's auth keypair (session proof)
  const db = fakeDb({
    'user/alice': { authPub: b4a.toString(alice.publicKey, 'hex'), status: 'active', devices: [], tokenVersion: 1, maxDevices: 2 }
  })

  // ---------- A. malformed payloads must not crash ----------
  console.log('A. malformed RPC payloads fail closed (no crash)')
  {
    const [cli, srv] = streamPair()
    cleanups.push(() => { cli.destroy(); srv.destroy() })
    const throttle = makeThrottle(1000, 900)
    attachLoginRpc(srv, { keys: { signing, publisher }, oprfKey, difficulty: 1, throttle, db, dataDir: tmp, legacyPublisher: true })
    const { call } = rpcClient(cli)

    // The headline: an UNAUTHENTICATED login with a non-string powNonce.
    for (const [label, powNonce] of [['object', {}], ['number', 5], ['array', [1, 2, 3]], ['bool', true]]) {
      const res = await call('login', { username: 'x', blinded: '00'.repeat(32), powNonce })
      ok(res && typeof res.error === 'string', `login powNonce=${label} → error, no crash (${res && res.error})`)
    }
    // Non-string / malformed blinded, with a VALID proof-of-work so we pass the PoW gate.
    {
      const chal = b4a.from((await call('hello')).challenge, 'hex')
      const nonce = powSolve(chal, 1)
      const res = await call('login', { username: 'x', blinded: {}, powNonce: b4a.toString(nonce, 'hex') })
      ok(res && typeof res.error === 'string', `login blinded={} → error, no crash (${res.error})`)
    }
    // Well-formed login (valid PoW + valid blinded) to arm a sessionChallenge…
    {
      const chal = b4a.from((await call('hello')).challenge, 'hex')
      const nonce = powSolve(chal, 1)
      const { blinded } = blind('pw')
      const res = await call('login', { username: 'alice', blinded: b4a.toString(blinded, 'hex'), powNonce: b4a.toString(nonce, 'hex') })
      ok(res && !res.error && typeof res.sessionChallenge === 'string', 'valid login returns a sessionChallenge')
      // …then a malformed session signature must be "auth failed", not a crash.
      for (const [label, sig] of [['object', {}], ['number', 7], ['badhex', 'zz'], ['short', 'ab']]) {
        const r = await call('session', { username: 'alice', deviceId: 'd1', sig })
        ok(r && typeof r.error === 'string', `session sig=${label} → error, no crash (${r && r.error})`)
        // each session consumes the one-shot challenge, so re-arm for the next case
        const c2 = b4a.from((await call('hello')).challenge, 'hex')
        const n2 = powSolve(c2, 1)
        const { blinded: bl2 } = blind('pw')
        await call('login', { username: 'alice', blinded: b4a.toString(bl2, 'hex'), powNonce: b4a.toString(n2, 'hex') })
      }
    }
    // Malformed register signatures (legacy path is reachable unauthenticated).
    for (const [label, sig] of [['object', {}], ['number', 9], ['array', [1, 2]], ['badhex', 'zz'], ['short', 'ab']]) {
      const res = await call('register', { payload: { streamId: 'news', feedKey: '11'.repeat(32) }, sig })
      ok(res && typeof res.error === 'string', `register sig=${label} → error, no crash (${res && res.error})`)
    }
    // Truncated/garbage top-level payloads.
    for (const [label, p] of [['null-payload', { sig: '00'.repeat(64) }], ['payload-string', { payload: 'x', sig: '00'.repeat(64) }], ['no-streamId', { payload: {}, sig: '00'.repeat(64) }]]) {
      const res = await call('register', p)
      ok(res && typeof res.error === 'string', `register ${label} → error, no crash (${res && res.error})`)
    }
    await sleep(50) // let any deferred microtask-thrown error surface before we judge
  }

  // ---------- B. register replay cannot roll a feedKey back ----------
  console.log('B. a captured register payload cannot be replayed')
  {
    const [cli, srv] = streamPair()
    cleanups.push(() => { cli.destroy(); srv.destroy() })
    attachLoginRpc(srv, { keys: { signing, publisher }, oprfKey, difficulty: 1, throttle: makeThrottle(1000, 900), db, dataDir: tmp, legacyPublisher: true })
    const { call } = rpcClient(cli)

    const payload = { streamId: 'sports', feedKey: 'aa'.repeat(32), isLive: true }
    const sign = (chalHex) => {
      const msg = hcrypto.hash(b4a.concat([b4a.from(chalHex, 'hex'), b4a.from(JSON.stringify(payload))]))
      return b4a.toString(authSign(publisher.secretKey, msg), 'hex')
    }
    const chal1 = (await call('hello')).challenge
    const sig1 = sign(chal1)
    const first = await call('register', { payload, sig: sig1 })
    ok(first && first.ok === true, 'first register accepted')

    // Replay the EXACT captured (payload, sig): the challenge rotated one-shot, so it fails.
    const replay = await call('register', { payload, sig: sig1 })
    ok(replay && replay.error === 'unauthorized', `replay of the captured register rejected (${replay && (replay.error || 'ok:' + replay.ok)})`)

    // A fresh hello + re-sign works again — proving it is challenge binding, not a nonce blacklist.
    const chal2 = (await call('hello')).challenge
    const again = await call('register', { payload, sig: sign(chal2) })
    ok(again && again.ok === true, 're-signing against a fresh challenge is accepted')
  }

  // ---------- C. throttle map is bounded ----------
  console.log('C. makeThrottle bounds its key map')
  {
    const th = makeThrottle(1000, 900, { maxKeys: 100 })
    for (let i = 0; i < 10000; i++) th('user' + i + '|peer')
    ok(th.size <= 100, `10k distinct keys → map stayed bounded (size=${th.size} ≤ 100)`)

    // Fixed-window limiting still works for a hot key.
    const lim = makeThrottle(2, 900)
    const r1 = lim('bob|ip'); const r2 = lim('bob|ip'); const r3 = lim('bob|ip')
    ok(!r1.locked && !r2.locked && r3.locked, 'threshold enforcement intact (3rd hit locks with threshold 2)')
  }

  // ---------- D. legacy-publisher sunset predicate ----------
  console.log('D. legacy-publisher boot-warning predicate')
  {
    ok(legacyPublisherActiveWithNamed(true, { east: {}, west: {} }) === true, 'warns: legacy on + named publishers enrolled')
    ok(legacyPublisherActiveWithNamed(true, {}) === false, 'silent: legacy on + no named publishers (single-broadcaster)')
    ok(legacyPublisherActiveWithNamed(false, { east: {} }) === false, 'silent: legacy already closed')
    ok(legacyPublisherActiveWithNamed(true, null) === false, 'silent: no publishers file yet')
  }

  ok(!crashed, 'no uncaught exception / unhandled rejection fired during the run')
} catch (err) {
  console.error('  FAIL (threw):', err && err.stack ? err.stack : err)
  failures++
} finally {
  await cleanup()
}

console.log(failures ? `\nrpc-hardening: FAIL (${failures})` : '\nrpc-hardening: PASS')
process.exit(failures ? 1 : 0)
