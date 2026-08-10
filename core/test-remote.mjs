// Unit tests for core/remote.js — the "send to TV" rendezvous + mutual-proof primitives.
// Run: node core/test-remote.mjs   (exit 0 = all pass)
//
// Deterministic and offline: no swarm, no DHT, no clock of its own. The handshake hashes
// here are fixtures, not real Noise transcripts — what matters to this module is that a
// hash is 32 or 64 bytes, identical on both ends of one connection and different on the
// next, and the fixtures model exactly that. The live property (that
// @hyperswarm/secret-stream really hands both peers the same `handshakeHash`) belongs to
// the WP2/WP3 end-to-end lanes, which have a swarm to prove it on.
//
// The load-bearing group is the KNOWN-ANSWER VECTORS. Every byte below is on the wire
// between a phone and a TV that may be running different app versions, so a refactor
// that "improves" a label, a hash orientation or a bit order must fail here rather than
// ship two releases that cannot see each other.

import assert from 'assert'
import b4a from 'b4a'
import {
  pairingTopic, normalizePairingCode, formatPairingCode,
  newSigninCode, signinKeys, signinTopic, signinSecret,
  signinCodeState, consumeSigninCode, SIGNIN_CODE_STATES, SIGNIN_CODE_LENGTH, SIGNIN_CODE_TTL_MS,
  remoteSecret, remoteTopic,
  remoteProof, remoteProofValid, peerRole, REMOTE_ROLES, REMOTE_PROOF_BYTES,
  remoteSas, REMOTE_SAS_DIGITS,
  CROCKFORD_ALPHABET
} from './index.js'

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ok ', name) }
const hex = (x) => b4a.toString(x, 'hex')

// A 64-byte stand-in for a Noise transcript hash (secret-stream 6.9.1 hands out 64), and
// a way to make as many distinct ones as a test needs.
const hh = (seed) => {
  const out = b4a.alloc(64)
  for (let i = 0; i < 64; i++) out[i] = (i * 37) & 0xff
  out[0] = seed & 0xff
  out[1] = (seed >>> 8) & 0xff
  out[2] = (seed >>> 16) & 0xff
  out[3] = (seed >>> 24) & 0xff
  return out // injective in `seed` — every fixture is a distinct transcript
}
const bytes32 = (fill) => { const b = b4a.alloc(32); b.fill(fill); return b }

console.log('@aliran/core remote-pairing tests')

// --------------------------------------------------------------- known-answer vectors
// A fixed code, a fixed private key and a fixed handshake hash, pinned to the exact
// bytes this construction produces today. If one of these changes, the wire changed.
const KAT_CODE = 'A3K7-9QF2-M4XR'
const KAT_PRIV = (() => { const b = b4a.alloc(32); for (let i = 0; i < 32; i++) b[i] = i; return b })()
const KAT_HH = (() => { const b = b4a.alloc(64); for (let i = 0; i < 64; i++) b[i] = 0xa0 + (i % 16); return b })()

test('KAT: sign-in code -> topic and shared secret', () => {
  const k = signinKeys(KAT_CODE)
  assert.strictEqual(hex(k.topic), '22a9903910c7e31ed69138b3b018a6d59e74c61eb88d942517859e67676098d0')
  assert.strictEqual(hex(k.secret), '2614f65e139211c679efeae219dbd332dc204db013c70506e187ac5dc8971dc8')
  assert.strictEqual(k.topic.length, 32)
  assert.strictEqual(k.secret.length, 32)
})

test('KAT: account private key -> shared secret and topic', () => {
  const s = remoteSecret(KAT_PRIV)
  assert.strictEqual(hex(s), '65bfaf5c7a1f8468475d792463065385a1c77fcbfae13e2b429f49ead43c4fec')
  assert.strictEqual(hex(remoteTopic(s)), 'dffb35072b654762d24a21254de0d64e9c31d92c40a8c6183b788f9438618952')
  // Hex and raw bytes are the same key, so they must land on the same secret.
  assert.ok(b4a.equals(remoteSecret(hex(KAT_PRIV)), s))
  assert.ok(b4a.equals(remoteTopic(hex(s)), remoteTopic(s)))
})

test('KAT: proof and SAS', () => {
  const s = remoteSecret(KAT_PRIV)
  assert.strictEqual(hex(remoteProof(s, KAT_HH, REMOTE_ROLES.initiator)), '69d445e021091f5bad0b6719e5fcaa7fb24076206fa64a990f8181e1d54236fd')
  assert.strictEqual(hex(remoteProof(s, KAT_HH, REMOTE_ROLES.responder)), '4648f7b604657612988beaedce8692a931500e463146937288a3f670aac65d70')
  assert.strictEqual(remoteSas(s, KAT_HH), '3133')
})

// ------------------------------------------------------------------ domain separation
// core/pairing.js:45-49 — no output of one construction may ever be an input another
// would accept. A sign-in code and a service pairing code share a string space on
// purpose, so nothing but the labels keeps them apart.
test('the same code never reaches the same topic through two constructions', () => {
  assert.strictEqual(hex(pairingTopic(KAT_CODE)), 'd6c696d149c701ff8b2aa39d2d2d6967975da7504d08eb8c9218292c224c8390')
  assert.ok(!b4a.equals(pairingTopic(KAT_CODE), signinTopic(KAT_CODE)), 'a pairing topic must never be a sign-in topic')
})

test('every derivation from one input lands somewhere different', () => {
  const k = signinKeys(KAT_CODE)
  const s = remoteSecret(KAT_PRIV)
  const t = remoteTopic(s)
  // The sign-in topic and secret come from ONE Argon2id under two labels: publishing the
  // topic (which joining a swarm does) must not publish the proof key.
  assert.ok(!b4a.equals(k.topic, k.secret))
  // Same rule on the account side, one hash further along.
  assert.ok(!b4a.equals(s, t))
  assert.ok(!b4a.equals(s, KAT_PRIV), 'the secret must not be the private key itself')
  assert.ok(!b4a.equals(t, remoteSecret(s)), 'the topic label and the secret label must differ')
  // And the two features never collide with each other.
  for (const a of [k.topic, k.secret]) for (const b of [s, t]) assert.ok(!b4a.equals(a, b))
})

test('four labels over one secret land on four different values', () => {
  const s = bytes32(0x5a)
  const seen = new Set([
    hex(remoteTopic(s)),
    hex(remoteProof(s, KAT_HH, REMOTE_ROLES.initiator)),
    hex(remoteProof(s, KAT_HH, REMOTE_ROLES.responder)),
    hex(remoteSecret(s))
  ])
  assert.strictEqual(seen.size, 4, 'two labels produced the same bytes')
})

// ------------------------------------------------------------------------ the proof
test('an honest pair verifies each other, in both directions', () => {
  const s = remoteSecret(KAT_PRIV)
  const h = hh(1)
  const phone = remoteProof(s, h, REMOTE_ROLES.initiator)
  const tv = remoteProof(s, h, REMOTE_ROLES.responder)
  assert.strictEqual(remoteProofValid(s, h, peerRole(REMOTE_ROLES.responder), phone), true)
  assert.strictEqual(remoteProofValid(s, h, peerRole(REMOTE_ROLES.initiator), tv), true)
  assert.strictEqual(remoteProof(s, h, REMOTE_ROLES.initiator).length, REMOTE_PROOF_BYTES)
})

test('a wrong or forged secret fails the proof', () => {
  const h = hh(2)
  const real = remoteSecret(KAT_PRIV)
  const wrong = remoteSecret(bytes32(0xff))
  const proof = remoteProof(real, h, REMOTE_ROLES.initiator)
  assert.strictEqual(remoteProofValid(wrong, h, REMOTE_ROLES.initiator, proof), false)
  // A one-bit change anywhere in the secret is enough.
  const nudged = b4a.from(real); nudged[31] ^= 1
  assert.strictEqual(remoteProofValid(nudged, h, REMOTE_ROLES.initiator, proof), false)
  // And a code-derived secret is not an account-derived one, whatever else is equal.
  assert.strictEqual(remoteProofValid(signinKeys(KAT_CODE).secret, h, REMOTE_ROLES.initiator, proof), false)
})

// This is the whole reason the proof commits to the handshake hash. Without it a proof
// is a bearer token and a relay holding one connection to each device forwards each
// side's proof to the other, sitting in the middle of both.
test('a proof from one connection does not verify on another', () => {
  const s = remoteSecret(KAT_PRIV)
  const a = hh(10)
  const bConn = hh(11)
  assert.ok(!b4a.equals(a, bConn))
  const proof = remoteProof(s, a, REMOTE_ROLES.initiator)
  assert.strictEqual(remoteProofValid(s, a, REMOTE_ROLES.initiator, proof), true)
  assert.strictEqual(remoteProofValid(s, bConn, REMOTE_ROLES.initiator, proof), false)
  // Every connection gets its own proof, even for one secret and one role.
  const seen = new Set()
  for (let i = 0; i < 32; i++) seen.add(hex(remoteProof(s, hh(i), REMOTE_ROLES.initiator)))
  assert.strictEqual(seen.size, 32)
})

// The reflection attack: a peer that knows nothing bounces the proof it just received
// straight back as its own. The role field is what makes that fail.
test('a reflected proof fails — the two roles are not interchangeable', () => {
  const s = remoteSecret(KAT_PRIV)
  const h = hh(3)
  const fromInitiator = remoteProof(s, h, REMOTE_ROLES.initiator)
  assert.ok(!b4a.equals(fromInitiator, remoteProof(s, h, REMOTE_ROLES.responder)))
  assert.strictEqual(remoteProofValid(s, h, REMOTE_ROLES.responder, fromInitiator), false)
  assert.strictEqual(peerRole(REMOTE_ROLES.initiator), REMOTE_ROLES.responder)
  assert.strictEqual(peerRole(REMOTE_ROLES.responder), REMOTE_ROLES.initiator)
  for (const bad of ['', 'INITIATOR', 'client', null, 0, {}]) assert.throws(() => peerRole(bad), TypeError)
  for (const bad of ['', 'INITIATOR', 'client', null, 0, {}]) assert.throws(() => remoteProof(s, h, bad), TypeError)
})

// remoteProofValid runs on bytes a stranger on a public topic sent, so every malformed
// shape has to come back false rather than throwing into a connection handler.
test('verification refuses malformed input instead of throwing', () => {
  const s = remoteSecret(KAT_PRIV)
  const h = hh(4)
  const good = remoteProof(s, h, REMOTE_ROLES.initiator)
  for (const bad of [null, undefined, 'deadbeef', 42, {}, [], b4a.alloc(0), b4a.alloc(31), b4a.alloc(33), b4a.alloc(64)]) {
    assert.strictEqual(remoteProofValid(s, h, REMOTE_ROLES.initiator, bad), false, 'accepted ' + JSON.stringify(bad))
  }
  for (const bad of [null, undefined, 'nope', b4a.alloc(31)]) {
    assert.strictEqual(remoteProofValid(bad, h, REMOTE_ROLES.initiator, good), false)
    assert.strictEqual(remoteProofValid(s, bad, REMOTE_ROLES.initiator, good), false)
    assert.strictEqual(remoteProofValid(s, h, bad, good), false)
  }
  assert.strictEqual(remoteProofValid(s, h, REMOTE_ROLES.initiator, b4a.alloc(REMOTE_PROOF_BYTES)), false)
})

// The likeliest caller bug by a distance: reading socket.handshakeHash before the
// handshake finishes, where secret-stream still has it as null. Binding a proof to
// nothing must be loud.
test('a missing or wrong-sized handshake hash throws rather than binding to nothing', () => {
  const s = remoteSecret(KAT_PRIV)
  for (const bad of [null, undefined, '', 'a'.repeat(128), 64, {}, b4a.alloc(0), b4a.alloc(16), b4a.alloc(48), b4a.alloc(65)]) {
    assert.throws(() => remoteProof(s, bad, REMOTE_ROLES.initiator), TypeError, 'accepted ' + JSON.stringify(bad))
    assert.throws(() => remoteSas(s, bad), TypeError)
  }
  // 32 bytes is accepted so a future BLAKE2b-256 transcript needs no core release.
  assert.strictEqual(remoteProof(s, b4a.alloc(32), REMOTE_ROLES.initiator).length, REMOTE_PROOF_BYTES)
})

test('malformed secrets and private keys are refused, not silently accepted', () => {
  for (const bad of ['', 'not-a-key', 'zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), null, undefined, 42, {}, b4a.alloc(31), b4a.alloc(33)]) {
    assert.throws(() => remoteSecret(bad), TypeError, 'remoteSecret accepted ' + JSON.stringify(bad))
    assert.throws(() => remoteTopic(bad), TypeError, 'remoteTopic accepted ' + JSON.stringify(bad))
  }
})

// -------------------------------------------------------------------------------- SAS
test('honest peers agree on the SAS; a relay does not', () => {
  const s = remoteSecret(KAT_PRIV)
  const h = hh(20)
  // Both ends of one connection see the same secret and the same transcript hash.
  assert.strictEqual(remoteSas(s, h), remoteSas(s, h))
  assert.ok(/^[0-9]{4}$/.test(remoteSas(s, h)))
  assert.strictEqual(remoteSas(s, h).length, REMOTE_SAS_DIGITS)
  // A relay terminates two DIFFERENT Noise connections, so the two screens disagree.
  const legA = hh(21)
  const legB = hh(22)
  assert.notStrictEqual(remoteSas(s, legA), remoteSas(s, legB))
  // Different accounts on the same transcript also diverge.
  assert.notStrictEqual(remoteSas(s, h), remoteSas(remoteSecret(bytes32(0x11)), h))
  // The SAS is role-free — the two sides compare, they do not challenge.
  assert.strictEqual(remoteSas(s, h), remoteSas(b4a.from(s), b4a.from(h)))
})

// Two checks, both deterministic — the same 100,000 transcript hashes every run, so a
// pass is a pass and not a lucky sample. The first is the general shape. The second is
// aimed at the specific regression worth naming: narrow the draw to 16 bits and drop the
// rejection step, and `draw % 10000` gives 0000-5535 seven preimages against the rest's
// six — a 17% excess, which is enormous for digits a viewer compares.
test('SAS is uniform over 0000-9999 — no modulo bias', () => {
  const s = remoteSecret(KAT_PRIV)
  const N = 100000
  const buckets = new Array(100).fill(0) // 100 buckets of 100 values each
  let low = 0 // the half a 16-bit modulo would over-produce
  for (let i = 0; i < N; i++) {
    const digits = remoteSas(s, hh(i))
    assert.ok(/^[0-9]{4}$/.test(digits), 'malformed SAS ' + digits)
    const v = Number(digits)
    buckets[Math.floor(v / 100)]++
    if (v < 5536) low++
  }
  // Coarse uniformity: expected 1000 per bucket, sd ~31.5, so 6 sd is +/- 189.
  for (let i = 0; i < buckets.length; i++) {
    assert.ok(Math.abs(buckets[i] - 1000) < 189, 'bucket ' + i + ' held ' + buckets[i] + ' of an expected 1000')
  }
  // Uniform puts 55.36% below 5536 (sd ~157). A 16-bit modulo puts 59.14% there — about
  // 24 sd out, which this refuses at 6.
  assert.ok(Math.abs(low - 55360) < 942, 'low half held ' + low + ' of an expected 55360 — modulo bias')
})

// --------------------------------------------------------------- codes and normalization
test('a fresh sign-in code is 12 Crockford characters, grouped by four', () => {
  const rec = newSigninCode()
  assert.strictEqual(rec.canonical.length, SIGNIN_CODE_LENGTH)
  assert.strictEqual(rec.code, formatPairingCode(rec.canonical))
  assert.ok(/^[^-]{4}-[^-]{4}-[^-]{4}$/.test(rec.code), 'display form is XXXX-XXXX-XXXX, got ' + rec.code)
  for (const ch of rec.canonical) assert.ok(CROCKFORD_ALPHABET.includes(ch), 'non-Crockford character ' + ch)
  assert.ok(!/[ILOU]/.test(rec.canonical), 'the confusable characters must never be emitted')
  assert.strictEqual(normalizePairingCode(rec.code), rec.canonical, 'a fresh code must round-trip')
})

test('codes are random, not a sequence', () => {
  const seen = new Set()
  for (let i = 0; i < 64; i++) seen.add(newSigninCode().canonical)
  assert.strictEqual(seen.size, 64, 'generated codes collided')
})

// What the viewer types is not what the TV printed: lowercase, dashes, spaces, and the
// Crockford characters that decode to digits. All of it has to reach one topic, or the
// viewer is told their operator is unreachable when they typed the code correctly.
test('typing variants of one code reach the same topic and secret', () => {
  const canonical = 'A3K79QF2M4XR'
  const a = signinKeys(canonical)
  const b = signinKeys('  a3k7 9qf2-m4xr  ')
  assert.ok(b4a.equals(a.topic, b.topic), 'lowercase, spaces and dashes must not move the topic')
  assert.ok(b4a.equals(a.secret, b.secret))
  // Crockford confusables: O reads as 0, I and L read as 1.
  assert.strictEqual(normalizePairingCode('oil-k79q-f2m4x'), '011K79QF2M4X')
  const c = signinKeys('011K79QF2M4X')
  const d = signinKeys('OIL-K79Q-F2M4X')
  assert.ok(b4a.equals(c.topic, d.topic), 'I/L/O must decode to their digits')
  assert.ok(!b4a.equals(a.topic, c.topic), 'different codes must not share a topic')
})

test('anything that is not a code is refused, not given a plausible topic', () => {
  for (const bad of ['', 'A3K7-9QF2', 'A3K7-9QF2-M4XRX', 'A3K7-9QF2-M4X!', 'A3K7-9QF2-M4XU', null, undefined, 42, {}]) {
    assert.throws(() => signinKeys(bad), TypeError, 'signinKeys accepted ' + JSON.stringify(bad))
    assert.throws(() => signinTopic(bad), TypeError)
    assert.throws(() => signinSecret(bad), TypeError)
  }
})

test('signinTopic and signinSecret are the halves signinKeys returns', () => {
  const k = signinKeys(KAT_CODE)
  assert.ok(b4a.equals(signinTopic(KAT_CODE), k.topic))
  assert.ok(b4a.equals(signinSecret(KAT_CODE), k.secret))
})

// ---------------------------------------------------------------------- code lifecycle
test('a code is live, then expired, and the caller owns the clock', () => {
  const t0 = 1700000000000
  const rec = newSigninCode({ now: t0 })
  assert.strictEqual(rec.issuedAt, t0)
  assert.strictEqual(rec.expiresAt, t0 + SIGNIN_CODE_TTL_MS)
  assert.strictEqual(rec.usedAt, null)
  assert.strictEqual(signinCodeState(rec, t0), SIGNIN_CODE_STATES.live)
  assert.strictEqual(signinCodeState(rec, rec.expiresAt - 1), SIGNIN_CODE_STATES.live)
  assert.strictEqual(signinCodeState(rec, rec.expiresAt), SIGNIN_CODE_STATES.expired)
  // A caller-supplied TTL is honoured; a nonsensical one is refused.
  assert.strictEqual(newSigninCode({ now: t0, ttlMs: 5000 }).expiresAt, t0 + 5000)
  for (const bad of [0, -1, NaN, Infinity, '60000']) assert.throws(() => newSigninCode({ now: t0, ttlMs: bad }), TypeError)
  for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => newSigninCode({ now: bad }), TypeError)
})

// One shot means one shot, and the check and the state change are ONE call so a caller
// cannot test liveness, await a peer, and then spend a code that expired in between.
test('consuming a code is one-shot, atomic and pure', () => {
  const t0 = 1700000000000
  const rec = newSigninCode({ now: t0 })
  const used = consumeSigninCode(rec, t0 + 1000)
  assert.ok(used, 'a live code must be consumable')
  assert.strictEqual(used.usedAt, t0 + 1000)
  assert.strictEqual(used.canonical, rec.canonical)
  assert.strictEqual(rec.usedAt, null, 'consume must not mutate the record it was given')
  assert.strictEqual(signinCodeState(used, t0 + 1000), SIGNIN_CODE_STATES.used)
  assert.strictEqual(consumeSigninCode(used, t0 + 1000), null, 'a spent code cannot be spent again')
  // Expiry beats liveness, and a used code stays used past its expiry.
  assert.strictEqual(consumeSigninCode(rec, rec.expiresAt), null)
  assert.strictEqual(signinCodeState(used, rec.expiresAt + 1), SIGNIN_CODE_STATES.used)
})

test('a record that is not a code reads as malformed, never as live', () => {
  const t0 = 1700000000000
  const rec = newSigninCode({ now: t0 })
  const bad = [
    null, undefined, 42, 'A3K7-9QF2-M4XR', [],
    {},
    { canonical: 'A3K79QF2M4XR' }, // no expiry
    { canonical: 'nope', expiresAt: t0 + 1000 },
    { canonical: 'A3K7-9QF2-M4XR', expiresAt: t0 + 1000 }, // display form, not canonical
    { canonical: 'A3K79QF2M4XU', expiresAt: t0 + 1000 }, // U is not in the alphabet
    { ...rec, expiresAt: 'soon' }
  ]
  for (const b of bad) {
    assert.strictEqual(signinCodeState(b, t0), SIGNIN_CODE_STATES.malformed, 'accepted ' + JSON.stringify(b))
    assert.strictEqual(consumeSigninCode(b, t0), null)
  }
})

console.log(`\nRESULT: PASS ✅  (${passed} tests)`)
