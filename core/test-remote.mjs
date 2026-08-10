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
// ship two releases that cannot see each other. Every vector was computed from sodium
// and b4a alone, not read back out of the implementation.
//
// The account vectors changed once, deliberately, before anything shipped: the account
// secret now commits to the account's tokenVersion so that "log out all devices" rotates
// the rendezvous (see remoteSecret). The sign-in vectors are byte-identical to the ones
// that came before it, which is the cheap proof that the change did not disturb the
// other half of the file. The PIN vectors (WP2a) were added the same way and are held to
// the same rule.

import assert from 'assert'
import b4a from 'b4a'
import {
  pairingTopic, normalizePairingCode, formatPairingCode, PAIRING_KDF_DEFAULT,
  newSigninCode, signinKeys, signinTopic, signinSecret,
  signinCodeState, consumeSigninCode, SIGNIN_CODE_STATES, SIGNIN_CODE_LENGTH, SIGNIN_CODE_TTL_MS,
  remoteSecret, remoteTopic,
  remoteProof, remoteProofValid, peerRole, REMOTE_ROLES, REMOTE_PROOF_BYTES,
  remoteSas, REMOTE_SAS_DIGITS,
  newRemotePin, remotePinProof, remotePinProofValid, REMOTE_PIN_DIGITS,
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
// A fixed code, a fixed private key, a fixed tokenVersion and a fixed handshake hash,
// pinned to the exact bytes this construction produces today. If one of these changes,
// the wire changed.
const KAT_CODE = 'A3K7-9QF2-M4XR'
const KAT_PRIV = (() => { const b = b4a.alloc(32); for (let i = 0; i < 32; i++) b[i] = i; return b })()
const KAT_HH = (() => { const b = b4a.alloc(64); for (let i = 0; i < 64; i++) b[i] = 0xa0 + (i % 16); return b })()
const KAT_TV = 1 // what panel/src/ops.js createUser stamps on a new account

test('KAT: sign-in code -> topic and shared secret', () => {
  const k = signinKeys(KAT_CODE)
  assert.strictEqual(hex(k.topic), '22a9903910c7e31ed69138b3b018a6d59e74c61eb88d942517859e67676098d0')
  assert.strictEqual(hex(k.secret), '2614f65e139211c679efeae219dbd332dc204db013c70506e187ac5dc8971dc8')
  assert.strictEqual(k.topic.length, 32)
  assert.strictEqual(k.secret.length, 32)
})

test('KAT: account private key + tokenVersion -> shared secret and topic', () => {
  const s = remoteSecret(KAT_PRIV, KAT_TV)
  assert.strictEqual(hex(s), '4f71ea7ff5cac568e9e83e62dd52aae415f7c4aa7752e1c990e1cc1b2f4f2bf6')
  assert.strictEqual(hex(remoteTopic(s)), '241676ee8aafe915f80923cd6e2e8a4b1f62b386efbebd9c2ef52bd0ad8ca4bb')
  // The epoched form is a different topic entirely, and epoch 0 is not "no epoch".
  assert.strictEqual(hex(remoteTopic(s, 0)), 'd19a527fc9d1ff58565a8a2714c14259bf4541c098f1f32e6ed01cd86e1e565c')
  assert.strictEqual(hex(remoteTopic(s, 7)), '16e6aadccf58e0444b6bc14a1dd56f85ed422e16157afa42aa50844e5a16c99f')
  // Hex and raw bytes are the same key, so they must land on the same secret.
  assert.ok(b4a.equals(remoteSecret(hex(KAT_PRIV), KAT_TV), s))
  assert.ok(b4a.equals(remoteTopic(hex(s)), remoteTopic(s)))
  assert.ok(b4a.equals(remoteTopic(hex(s), 7), remoteTopic(s, 7)))
})

test('KAT: proof and SAS', () => {
  const s = remoteSecret(KAT_PRIV, KAT_TV)
  assert.strictEqual(hex(remoteProof(s, KAT_HH, REMOTE_ROLES.initiator)), '4bab66bc7368203ce094f7edd8abeef2d9feccfc3e58d2922f35e3f1f053eaa1')
  assert.strictEqual(hex(remoteProof(s, KAT_HH, REMOTE_ROLES.responder)), '0b5d619bc495df5e1a2e59ffca267d087e259847eec70283170090d0f493ca00')
  assert.strictEqual(remoteSas(s, KAT_HH), '6731')
})

// The PIN proof is the one message on this wire whose absence would let a hostile TV
// assert "the viewer typed it" — so its bytes are pinned as hard as the rest. The
// sign-in-code variant is included because that, not the account secret, is the secret
// the handover actually runs under (sdk/signin-pair.js).
const KAT_PIN = '0473'
test('KAT: PIN proof', () => {
  const s = remoteSecret(KAT_PRIV, KAT_TV)
  assert.strictEqual(hex(remotePinProof(s, KAT_HH, REMOTE_ROLES.initiator, KAT_PIN)), '7a1e464b6f21bd54b462b5b73b79cc8e5034eccb276aea3ed93dde4d13218729')
  assert.strictEqual(hex(remotePinProof(s, KAT_HH, REMOTE_ROLES.responder, KAT_PIN)), '2b2ce67be5387e818c99b4b4cc202d9dde6a72a244da08f5eb87d86ab2dafb67')
  // A different PIN, everything else equal — the digits really do reach the MAC.
  assert.strictEqual(hex(remotePinProof(s, KAT_HH, REMOTE_ROLES.initiator, '0000')), 'ad8d50d06c627fe0a823df46e19bbf34fe93f7d0dedb15bbab9779b470a0f766')
  // Under the sign-in code's secret, which is what a phone and a TV actually share.
  assert.strictEqual(hex(remotePinProof(signinKeys(KAT_CODE).secret, KAT_HH, REMOTE_ROLES.responder, KAT_PIN)), '9cd8aa3ab430af7daf65fee02530fb9e1456a2bdfb534f8580212945d46be244')
  assert.strictEqual(remotePinProof(s, KAT_HH, REMOTE_ROLES.initiator, KAT_PIN).length, REMOTE_PROOF_BYTES)
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
  const s = remoteSecret(KAT_PRIV, KAT_TV)
  const t = remoteTopic(s)
  // The sign-in topic and secret come from ONE Argon2id under two labels: publishing the
  // topic (which joining a swarm does) must not publish the proof key.
  assert.ok(!b4a.equals(k.topic, k.secret))
  // Same rule on the account side, one hash further along.
  assert.ok(!b4a.equals(s, t))
  assert.ok(!b4a.equals(s, KAT_PRIV), 'the secret must not be the private key itself')
  assert.ok(!b4a.equals(t, remoteSecret(s, KAT_TV)), 'the topic label and the secret label must differ')
  // And the two features never collide with each other.
  for (const a of [k.topic, k.secret]) for (const b of [s, t]) assert.ok(!b4a.equals(a, b))
})

test('five labels over one secret land on five different values', () => {
  const s = bytes32(0x5a)
  const seen = new Set([
    hex(remoteTopic(s)),
    hex(remoteProof(s, KAT_HH, REMOTE_ROLES.initiator)),
    hex(remoteProof(s, KAT_HH, REMOTE_ROLES.responder)),
    hex(remoteSecret(s, KAT_TV)),
    hex(remotePinProof(s, KAT_HH, REMOTE_ROLES.initiator, '0473'))
  ])
  assert.strictEqual(seen.size, 5, 'two labels produced the same bytes')
})

// The PIN proof and the mutual proof travel over the same connection under the same
// secret. If one could ever be presented as the other, a peer that passed the first
// round would be handed the second for free — which is the entire round removed.
test('a PIN proof is never a mutual proof, whatever the PIN', () => {
  const s = signinKeys(KAT_CODE).secret
  const h = hh(40)
  const mutual = new Set([
    hex(remoteProof(s, h, REMOTE_ROLES.initiator)),
    hex(remoteProof(s, h, REMOTE_ROLES.responder))
  ])
  for (let n = 0; n < 10000; n++) {
    const pin = String(n).padStart(REMOTE_PIN_DIGITS, '0')
    assert.ok(!mutual.has(hex(remotePinProof(s, h, REMOTE_ROLES.initiator, pin))), 'PIN ' + pin + ' collided with a mutual proof')
    // And no PIN proof is ever accepted BY the mutual verifier, or the other way round.
    assert.strictEqual(remoteProofValid(s, h, REMOTE_ROLES.initiator, remotePinProof(s, h, REMOTE_ROLES.initiator, pin)), false)
  }
  assert.strictEqual(remotePinProofValid(s, h, REMOTE_ROLES.initiator, '0473', remoteProof(s, h, REMOTE_ROLES.initiator)), false)
})

// ------------------------------------------------------------------------ the proof
test('an honest pair verifies each other, in both directions', () => {
  const s = remoteSecret(KAT_PRIV, KAT_TV)
  const h = hh(1)
  const phone = remoteProof(s, h, REMOTE_ROLES.initiator)
  const tv = remoteProof(s, h, REMOTE_ROLES.responder)
  assert.strictEqual(remoteProofValid(s, h, peerRole(REMOTE_ROLES.responder), phone), true)
  assert.strictEqual(remoteProofValid(s, h, peerRole(REMOTE_ROLES.initiator), tv), true)
  assert.strictEqual(remoteProof(s, h, REMOTE_ROLES.initiator).length, REMOTE_PROOF_BYTES)
})

test('a wrong or forged secret fails the proof', () => {
  const h = hh(2)
  const real = remoteSecret(KAT_PRIV, KAT_TV)
  const wrong = remoteSecret(bytes32(0xff), KAT_TV)
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
  const s = remoteSecret(KAT_PRIV, KAT_TV)
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
  const s = remoteSecret(KAT_PRIV, KAT_TV)
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
  const s = remoteSecret(KAT_PRIV, KAT_TV)
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
  const s = remoteSecret(KAT_PRIV, KAT_TV)
  for (const bad of [null, undefined, '', 'a'.repeat(128), 64, {}, b4a.alloc(0), b4a.alloc(16), b4a.alloc(48), b4a.alloc(65)]) {
    assert.throws(() => remoteProof(s, bad, REMOTE_ROLES.initiator), TypeError, 'accepted ' + JSON.stringify(bad))
    assert.throws(() => remoteSas(s, bad), TypeError)
  }
  // 32 bytes is accepted so a future BLAKE2b-256 transcript needs no core release.
  assert.strictEqual(remoteProof(s, b4a.alloc(32), REMOTE_ROLES.initiator).length, REMOTE_PROOF_BYTES)
})

test('malformed secrets and private keys are refused, not silently accepted', () => {
  for (const bad of ['', 'not-a-key', 'zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), null, undefined, 42, {}, b4a.alloc(31), b4a.alloc(33)]) {
    assert.throws(() => remoteSecret(bad, KAT_TV), TypeError, 'remoteSecret accepted ' + JSON.stringify(bad))
    assert.throws(() => remoteTopic(bad), TypeError, 'remoteTopic accepted ' + JSON.stringify(bad))
  }
})

// ------------------------------------------------------- account rendezvous rotation
// remoteSecret commits to the account's tokenVersion so that the panel's "log out all
// devices" (panel/src/ops.js logoutAll — a tokenVersion bump plus a device wipe) moves
// the whole account to a new rendezvous. A device holding only cached material stays on
// the old topic and never meets the ones that logged back in.
test('the account rendezvous moves when tokenVersion moves', () => {
  const v1 = remoteSecret(KAT_PRIV, 1)
  const v2 = remoteSecret(KAT_PRIV, 2)
  assert.strictEqual(hex(v2), '2581f745e7a205e6acc44a83c0d6c98ca687601fbee4ee5583869052e6cd4972')
  assert.ok(!b4a.equals(v1, v2), 'a tokenVersion bump must change the secret')
  assert.ok(!b4a.equals(remoteTopic(v1), remoteTopic(v2)), 'and therefore the topic')
  // Every version lands somewhere different — no short cycle, no collisions.
  const seen = new Set()
  for (let v = 1; v <= 64; v++) seen.add(hex(remoteSecret(KAT_PRIV, v)))
  assert.strictEqual(seen.size, 64)
  // The proof key moves with it, so a stale device cannot even authenticate itself onto
  // a connection if it somehow reached the new topic.
  assert.strictEqual(remoteProofValid(v2, KAT_HH, REMOTE_ROLES.initiator, remoteProof(v1, KAT_HH, REMOTE_ROLES.initiator)), false)
})

// The panel starts every account at tokenVersion 1 and only ever increments. A caller
// that passes 0, or forgets the argument and lets it default, would silently put two
// devices of one household on different topics — they would simply never find each
// other, which is the hardest class of bug to diagnose in the field.
test('tokenVersion must be a real version, not a guess', () => {
  for (const bad of [undefined, null, 0, -1, 1.5, NaN, Infinity, -Infinity, '1', '', {}, [], true]) {
    assert.throws(() => remoteSecret(KAT_PRIV, bad), TypeError, 'accepted tokenVersion ' + JSON.stringify(bad))
  }
  assert.strictEqual(remoteSecret(KAT_PRIV, 1).length, 32)
  assert.strictEqual(remoteSecret(KAT_PRIV, Number.MAX_SAFE_INTEGER).length, 32)
})

// ----------------------------------------------------------------- the topic epoch
// Joining a topic announces it, so a permanent account topic is a permanent public
// correlator: the ~20 DHT nodes nearest that key see the IP:port of every device on the
// account, across time and across networks. The optional epoch bounds that window.
test('an epoch changes the topic, and no epoch is not epoch zero', () => {
  const s = remoteSecret(KAT_PRIV, KAT_TV)
  const plain = remoteTopic(s)
  assert.ok(!b4a.equals(plain, remoteTopic(s, 0)), 'an absent epoch must not alias epoch 0')
  assert.ok(b4a.equals(plain, remoteTopic(s, null)), 'null means absent, the documented default')
  assert.ok(b4a.equals(plain, remoteTopic(s, undefined)))
  const seen = new Set([hex(plain)])
  for (let e = 0; e < 64; e++) seen.add(hex(remoteTopic(s, e)))
  assert.strictEqual(seen.size, 65, 'two epochs produced the same topic')
  // The secret itself is untouched by the epoch — only the rendezvous moves, so an
  // epoch roll never invalidates a proof on an already-open connection.
  assert.ok(b4a.equals(remoteProof(s, KAT_HH, REMOTE_ROLES.initiator), remoteProof(remoteSecret(KAT_PRIV, KAT_TV), KAT_HH, REMOTE_ROLES.initiator)))
})

// The pattern the documentation prescribes for clock skew: both sides join the current
// AND the previous epoch, so two devices that disagree by up to one full period still
// share exactly one topic.
test('joining {epoch, epoch-1} on both sides always overlaps across one boundary', () => {
  const s = remoteSecret(KAT_PRIV, KAT_TV)
  const joined = (e) => [hex(remoteTopic(s, e)), hex(remoteTopic(s, e - 1))]
  const n = 4242
  const slow = joined(n)
  const fast = joined(n + 1)
  const shared = slow.filter((t) => fast.includes(t))
  assert.strictEqual(shared.length, 1, 'devices one epoch apart must still meet')
  assert.strictEqual(shared[0], hex(remoteTopic(s, n)))
  // Two epochs apart is out of tolerance, and the docs say so rather than pretending.
  assert.strictEqual(joined(n).filter((t) => joined(n + 2).includes(t)).length, 0)
})

test('an epoch must be a non-negative integer', () => {
  const s = remoteSecret(KAT_PRIV, KAT_TV)
  for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, '3', '', {}, [], true]) {
    assert.throws(() => remoteTopic(s, bad), TypeError, 'accepted epoch ' + JSON.stringify(bad))
  }
  assert.strictEqual(remoteTopic(s, 0).length, 32)
  assert.strictEqual(remoteTopic(s, Number.MAX_SAFE_INTEGER).length, 32)
})

// -------------------------------------------------------------------------------- SAS
test('honest peers agree on the SAS; a relay does not', () => {
  const s = remoteSecret(KAT_PRIV, KAT_TV)
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
  assert.notStrictEqual(remoteSas(s, h), remoteSas(remoteSecret(bytes32(0x11), KAT_TV), h))
  // The SAS is role-free — the two sides compare, they do not challenge.
  assert.strictEqual(remoteSas(s, h), remoteSas(b4a.from(s), b4a.from(h)))
})

// Two checks, both deterministic — the same 100,000 transcript hashes every run, so a
// pass is a pass and not a lucky sample. The first is the general shape. The second is
// aimed at the specific regression worth naming: narrow the draw to 16 bits and drop the
// rejection step, and `draw % 10000` gives 0000-5535 seven preimages against the rest's
// six — a 17% excess, which is enormous for digits a viewer compares.
test('SAS is uniform over 0000-9999 — no modulo bias', () => {
  const s = remoteSecret(KAT_PRIV, KAT_TV)
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

// The uniformity test above almost never reaches the rejection branch: a draw is
// rejected about once in 589,000, so 100,000 samples exercise it maybe one run in six
// and assert nothing about it either way. This fixture hits it on purpose.
//
// secret = 0x03 x 32, handshake hash = the 32-bit big-endian encoding of 78385 in the
// first four bytes and zeros in the other sixty. Found by brute force over that seed
// space and re-derived from sodium alone:
//
//   draw 0 = 4294960529  >= SAS_DRAW_LIMIT (4294960000)  -> rejected
//   draw 1 =  249251776  -> 249251776 % 10000 = 1776
//
// Delete the `draw < SAS_DRAW_LIMIT` guard and this returns '0529' (4294960529 % 10000),
// which is exactly the biased answer the rejection step exists to refuse — so the test
// pins both halves: the value that must come out, and the value that must not.
test('the SAS rejection branch is taken, and the biased answer is not returned', () => {
  const secret = bytes32(0x03)
  const rejecting = (() => {
    const out = b4a.alloc(64)
    const n = 78385
    out[0] = (n >>> 24) & 0xff
    out[1] = (n >>> 16) & 0xff
    out[2] = (n >>> 8) & 0xff
    out[3] = n & 0xff
    return out
  })()
  assert.strictEqual(remoteSas(secret, rejecting), '1776')
  assert.notStrictEqual(remoteSas(secret, rejecting), '0529', 'the rejected draw leaked through')
})

// ------------------------------------------------------------------------- the entry PIN
// The round the SAS explicitly cannot serve: the viewer TYPES these digits into the TV,
// so they must be a value the TV cannot derive. Everything below is about the two ways
// that could quietly stop being true — the digits becoming guessable (bias), or the
// proof becoming producible without them (binding).

test('the honest pair agrees on the PIN proof, in both directions', () => {
  const s = signinKeys(KAT_CODE).secret
  const h = hh(50)
  for (const role of [REMOTE_ROLES.initiator, REMOTE_ROLES.responder]) {
    const proof = remotePinProof(s, h, role, '0473')
    assert.strictEqual(remotePinProofValid(s, h, role, '0473', proof), true)
    // The verifier is the peer, so it checks the PROVER's role — peerRole() of its own.
    assert.strictEqual(remotePinProofValid(s, h, peerRole(role), '0473', proof), false)
  }
})

// The whole security claim of the round, stated as a test: of the ten thousand possible
// PINs, exactly one verifies. A device that did not learn the digits is left with a
// 1-in-10,000 guess, and sdk/signin-pair.js allows it exactly one.
test('exactly one of the ten thousand PINs verifies — the other 9999 do not', () => {
  const s = signinKeys(KAT_CODE).secret
  const h = hh(51)
  const real = '4207'
  const proof = remotePinProof(s, h, REMOTE_ROLES.responder, real)
  let accepted = 0
  for (let n = 0; n < 10000; n++) {
    const pin = String(n).padStart(REMOTE_PIN_DIGITS, '0')
    if (remotePinProofValid(s, h, REMOTE_ROLES.responder, pin, proof)) accepted++
  }
  assert.strictEqual(accepted, 1, 'a PIN proof verified under ' + accepted + ' different PINs')
  assert.strictEqual(remotePinProofValid(s, h, REMOTE_ROLES.responder, real, proof), true)
})

// Without the handshake binding, a relay that already holds the sign-in code could take
// the proof the viewer produced on its leg to the real TV and present it on its leg to
// the phone. With it, the two legs are two transcripts and the proof does not carry.
test('a PIN proof from one connection does not verify on another', () => {
  const s = signinKeys(KAT_CODE).secret
  const legA = hh(52)
  const legB = hh(53)
  const proof = remotePinProof(s, legA, REMOTE_ROLES.responder, '0473')
  assert.strictEqual(remotePinProofValid(s, legA, REMOTE_ROLES.responder, '0473', proof), true)
  assert.strictEqual(remotePinProofValid(s, legB, REMOTE_ROLES.responder, '0473', proof), false)
  // One PIN, one secret, one role — and still a different proof on every connection.
  const seen = new Set()
  for (let i = 0; i < 32; i++) seen.add(hex(remotePinProof(s, hh(100 + i), REMOTE_ROLES.responder, '0473')))
  assert.strictEqual(seen.size, 32)
  // A stranger's secret gets a stranger nowhere, even holding the right digits.
  assert.strictEqual(remotePinProofValid(bytes32(0x77), legA, REMOTE_ROLES.responder, '0473', proof), false)
})

// Leading zeros are the field bug this construction is most likely to meet: one pairing
// in ten draws a PIN below 1000, and a caller that let '0473' become 473 (or 473 become
// '473') would produce a proof the other side cannot reproduce — presenting to the
// viewer as "the TV says the PIN is wrong" on a PIN they typed correctly.
test('a PIN is four ASCII digits, leading zeros and all — nothing is coerced', () => {
  const s = signinKeys(KAT_CODE).secret
  const h = hh(54)
  assert.notStrictEqual(hex(remotePinProof(s, h, REMOTE_ROLES.responder, '0473')), hex(remotePinProof(s, h, REMOTE_ROLES.responder, '4730')))
  for (const bad of ['473', '04730', '', '047', 473, 4730, null, undefined, {}, [], '047a', ' 473', '473 ', '0.47', '-473', '٠٤٧٣']) {
    assert.throws(() => remotePinProof(s, h, REMOTE_ROLES.responder, bad), TypeError, 'accepted PIN ' + JSON.stringify(bad))
    // The verifier never throws — it runs on a connection handler's hot path.
    assert.strictEqual(remotePinProofValid(s, h, REMOTE_ROLES.responder, bad, remotePinProof(s, h, REMOTE_ROLES.responder, '0473')), false)
  }
  // All ten thousand well-formed PINs are accepted as INPUT, including every zero-padded one.
  for (let n = 0; n < 10000; n++) assert.strictEqual(remotePinProof(s, h, REMOTE_ROLES.responder, String(n).padStart(4, '0')).length, REMOTE_PROOF_BYTES)
})

test('PIN verification refuses malformed input instead of throwing', () => {
  const s = signinKeys(KAT_CODE).secret
  const h = hh(55)
  const good = remotePinProof(s, h, REMOTE_ROLES.responder, '0473')
  for (const bad of [null, undefined, 'deadbeef', 42, {}, [], b4a.alloc(0), b4a.alloc(31), b4a.alloc(33), b4a.alloc(64)]) {
    assert.strictEqual(remotePinProofValid(s, h, REMOTE_ROLES.responder, '0473', bad), false, 'accepted ' + JSON.stringify(bad))
  }
  for (const bad of [null, undefined, 'nope', b4a.alloc(31)]) {
    assert.strictEqual(remotePinProofValid(bad, h, REMOTE_ROLES.responder, '0473', good), false)
    assert.strictEqual(remotePinProofValid(s, bad, REMOTE_ROLES.responder, '0473', good), false)
    assert.strictEqual(remotePinProofValid(s, h, bad, '0473', good), false)
  }
  assert.strictEqual(remotePinProofValid(s, h, REMOTE_ROLES.responder, '0473', b4a.alloc(REMOTE_PROOF_BYTES)), false)
  // The same null-handshake-hash trap the mutual proof has: binding to nothing is loud.
  for (const bad of [null, b4a.alloc(0), b4a.alloc(16), b4a.alloc(65)]) {
    assert.throws(() => remotePinProof(s, bad, REMOTE_ROLES.responder, '0473'), TypeError)
  }
  for (const bad of ['', 'INITIATOR', 'client', null, 0, {}]) {
    assert.throws(() => remotePinProof(s, h, bad, '0473'), TypeError)
  }
})

test('a fresh PIN is four digits and is not a sequence', () => {
  const seen = new Set()
  for (let i = 0; i < 256; i++) {
    const pin = newRemotePin()
    assert.strictEqual(typeof pin, 'string')
    assert.strictEqual(pin.length, REMOTE_PIN_DIGITS)
    assert.ok(/^[0-9]{4}$/.test(pin), 'malformed PIN ' + pin)
    seen.add(pin)
  }
  // 256 draws from 10,000 values: a collision or two is ordinary, a small set is not.
  assert.ok(seen.size > 230, 'only ' + seen.size + ' distinct PINs in 256 draws')
})

// The PIN is drawn from the CSPRNG rather than derived, so this is the SAS uniformity
// argument transplanted: reduce a 16-bit draw modulo 10,000 and 0000-5535 get seven
// preimages against the rest's six — a 17% excess on digits whose whole job is to be
// unguessable. Thresholds are 6 sd, so a false failure is a 1-in-500-million event even
// though the sample is genuinely random each run.
test('a fresh PIN is uniform over 0000-9999 — no modulo bias', () => {
  const N = 100000
  const buckets = new Array(100).fill(0)
  let low = 0
  for (let i = 0; i < N; i++) {
    const v = Number(newRemotePin())
    buckets[Math.floor(v / 100)]++
    if (v < 5536) low++
  }
  for (let i = 0; i < buckets.length; i++) {
    assert.ok(Math.abs(buckets[i] - 1000) < 189, 'bucket ' + i + ' held ' + buckets[i] + ' of an expected 1000')
  }
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

// The whole 60-bit argument in the module header is an argument about Argon2id cost as
// much as about code length. A caller that trims the limits to make a slow TV box feel
// snappier collapses the precomputation barrier and nothing else in the system notices,
// so INTERACTIVE is a floor and not merely a default.
test('KDF limits below INTERACTIVE are refused, naming the constant', () => {
  const { opslimit, memlimit } = PAIRING_KDF_DEFAULT
  assert.throws(() => signinKeys(KAT_CODE, { opslimit: opslimit - 1, memlimit }), /OPSLIMIT_INTERACTIVE/)
  assert.throws(() => signinKeys(KAT_CODE, { opslimit, memlimit: memlimit - 1 }), /MEMLIMIT_INTERACTIVE/)
  assert.throws(() => signinTopic(KAT_CODE, { opslimit: 1, memlimit }), RangeError)
  assert.throws(() => signinSecret(KAT_CODE, { opslimit, memlimit: 8 * 1024 * 1024 }), RangeError)
  for (const bad of [{}, { opslimit }, { memlimit }, { opslimit: '2', memlimit }, { opslimit: 2.5, memlimit }, null]) {
    assert.throws(() => signinKeys(KAT_CODE, bad), RangeError, 'accepted limits ' + JSON.stringify(bad))
  }
  // Heavier than INTERACTIVE stays allowed — the floor is a floor, not a pin. It also
  // has to land somewhere else, or the parameter was being ignored.
  const heavier = signinKeys(KAT_CODE, { opslimit: opslimit + 1, memlimit })
  assert.strictEqual(heavier.topic.length, 32)
  assert.ok(!b4a.equals(heavier.topic, signinKeys(KAT_CODE).topic))
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

// The TTL is not cosmetic: item 3 of the length analysis leans on it to bound the set of
// codes live worldwide, which is what makes 60 bits enough. A clock that stopped being a
// number stopped enforcing that, so every function that reads one refuses it the same
// way newSigninCode() does — loudly, and identically, rather than reading `live` off a
// record that expired four seconds ago.
test('a clock that is not a finite number is refused everywhere, not just at issue', () => {
  const t0 = 1700000000000
  const rec = newSigninCode({ now: t0, ttlMs: 1000 })
  for (const bad of [NaN, Infinity, -Infinity, 'x', '1700000000000', null, {}, [], true]) {
    assert.throws(() => signinCodeState(rec, bad), TypeError, 'signinCodeState accepted clock ' + JSON.stringify(bad))
    assert.throws(() => consumeSigninCode(rec, bad), TypeError, 'consumeSigninCode accepted clock ' + JSON.stringify(bad))
    assert.throws(() => newSigninCode({ now: bad }), TypeError)
  }
  // undefined still means "ask the platform clock", the documented default.
  assert.strictEqual(signinCodeState(rec, undefined), SIGNIN_CODE_STATES.expired)
  // And the case that actually bit: a record four seconds past its TTL never reads live.
  assert.strictEqual(signinCodeState(rec, t0 + 5000), SIGNIN_CODE_STATES.expired)
})

// The second-order failure a NaN clock used to cause. consumeSigninCode(rec, NaN) stamped
// usedAt: NaN; JSON turns NaN into null; a TV that persisted the record across an app
// restart reloaded a SPENT code as live and could hand the account over twice.
test('a spend stamp can never be NaN, and a corrupt one never reads live', () => {
  const t0 = 1700000000000
  const rec = newSigninCode({ now: t0 })
  assert.throws(() => consumeSigninCode(rec, NaN), TypeError, 'a NaN clock must not produce a record at all')
  // Belt and braces for a record that reached disk some other way.
  for (const bad of [NaN, Infinity, -Infinity, 'yesterday', {}, []]) {
    const corrupt = { ...rec, usedAt: bad }
    assert.strictEqual(signinCodeState(corrupt, t0), SIGNIN_CODE_STATES.malformed, 'accepted usedAt ' + JSON.stringify(bad))
    assert.strictEqual(consumeSigninCode(corrupt, t0), null)
  }
  // The round trip that used to launder a spent code back into a live one.
  const used = consumeSigninCode(rec, t0 + 1000)
  const reloaded = JSON.parse(JSON.stringify(used))
  assert.strictEqual(reloaded.usedAt, t0 + 1000, 'a real stamp must survive JSON')
  assert.strictEqual(signinCodeState(reloaded, t0 + 2000), SIGNIN_CODE_STATES.used)
})

// One shot means one shot WITHIN one call: the liveness check and the state change
// happen together, so a caller cannot test liveness, await a peer, and then spend a code
// that expired in between. That is all it is. It is a pure function and it excludes
// nothing — the assertion at the end of this test is the proof, and it is why the module
// tells WP2 to serialize read -> consume -> store and keep one handover in flight.
test('consuming a code is one-shot and pure — exclusion is the caller\'s job', () => {
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
  // NOT a lock. Two connection handlers that both read the stored record before either
  // writes back both get a used record — and in WP2 that means two peers handed account
  // key material off one code. The sign-in topic is public, so this is the realistic
  // failure, not a theoretical one.
  const first = consumeSigninCode(rec, t0 + 2000)
  const second = consumeSigninCode(rec, t0 + 2000)
  assert.ok(first && second, 'purity means both calls succeed — the caller must serialize')
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
