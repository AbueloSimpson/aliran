// Unit tests for @aliran/core. Run: node core/test.mjs   (exit 0 = all pass)
import assert from 'assert'
import b4a from 'b4a'
import {
  oprfKeyGen, blind, evaluate, finalize, evaluateFull,
  randomSalt, deriveVerifier, verify, wrapKeyFrom, wrap, unwrap,
  userKeyPair, sealTo, sealOpen,
  authKeyPair, authSign, authVerify,
  signToken, verifyToken, tokenValid
} from './index.js'

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ok ', name) }

console.log('@aliran/core tests')

// 1. OPRF: blinded path equals the direct (enrollment) evaluation.
test('OPRF blind/evaluate/finalize == evaluateFull', () => {
  const k = oprfKeyGen()
  const pw = 'correct horse battery staple'
  const { blinded, r } = blind(pw)
  const evaluated = evaluate(k, blinded)
  const rwdLogin = finalize(pw, r, evaluated)
  const rwdEnroll = evaluateFull(k, pw)
  assert.ok(b4a.equals(rwdLogin, rwdEnroll), 'rwd mismatch')
})

// 2. OPRF is deterministic per (key,password) but blinding is randomized each time.
test('OPRF deterministic output, randomized blinding', () => {
  const k = oprfKeyGen()
  const a = blind('pw'); const b = blind('pw')
  assert.ok(!b4a.equals(a.blinded, b.blinded), 'blinded values should differ')
  assert.ok(b4a.equals(finalize('pw', a.r, evaluate(k, a.blinded)), finalize('pw', b.r, evaluate(k, b.blinded))))
})

// 3. Wrong password / wrong key -> different rwd.
test('wrong password yields different rwd', () => {
  const k = oprfKeyGen()
  assert.ok(!b4a.equals(evaluateFull(k, 'pw'), evaluateFull(k, 'PW')))
  assert.ok(!b4a.equals(evaluateFull(k, 'pw'), evaluateFull(oprfKeyGen(), 'pw')))
})

// 4. Enroll -> verify: correct password passes, wrong password fails.
test('enroll + verify (correct vs incorrect)', () => {
  const k = oprfKeyGen()
  const salt = randomSalt()
  const verifier = deriveVerifier(evaluateFull(k, 'hunter2'), salt)
  // login with correct password
  const good = blind('hunter2')
  const rwdGood = finalize('hunter2', good.r, evaluate(k, good.blinded))
  assert.strictEqual(verify(rwdGood, salt, verifier), true)
  // login with wrong password
  const bad = blind('hunter3')
  const rwdBad = finalize('hunter3', bad.r, evaluate(k, bad.blinded))
  assert.strictEqual(verify(rwdBad, salt, verifier), false)
})

// 5. Key wrapping: per-user seal/open; wrong key fails to open.
test('wrap/unwrap stream key (right vs wrong key)', () => {
  const streamKey = b4a.alloc(32); streamKey.fill(7)
  const rwd = evaluateFull(oprfKeyGen(), 'pw')
  const wk = wrapKeyFrom(rwd)
  const boxed = wrap(wk, streamKey)
  assert.ok(b4a.equals(unwrap(wk, boxed), streamKey), 'roundtrip failed')
  const otherKey = wrapKeyFrom(evaluateFull(oprfKeyGen(), 'pw'))
  assert.strictEqual(unwrap(otherKey, boxed), null, 'wrong key must not open')
})

// 6. Full account simulation with GRANT-AFTER-ENROLLMENT (no password at grant time):
//    enroll (keypair; priv sealed under password) -> grant by sealing to pub ->
//    login recovers priv -> opens the sealed stream key.
test('end-to-end account: enroll -> grant (no pw) -> login -> open stream key', () => {
  const k = oprfKeyGen()
  const streamKey = b4a.alloc(32); streamKey.fill(0xab)

  // enrollment (panel/admin, has the password once)
  const rwdE = evaluateFull(k, 's3cret')
  const salt = randomSalt()
  const kp = userKeyPair()
  const record = {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(rwdE, salt), 'hex'),
    pub: b4a.toString(kp.publicKey, 'hex'),
    encPriv: wrap(wrapKeyFrom(rwdE), kp.secretKey), // private key sealed under password
    wrapped: {}
  }

  // grant LATER, admin does NOT have the password — seals to the user's public key
  record.wrapped.news = sealTo(b4a.from(record.pub, 'hex'), streamKey)

  // login (client, only has the password)
  const { blinded, r } = blind('s3cret')
  const rwdL = finalize('s3cret', r, evaluate(k, blinded))
  assert.strictEqual(verify(rwdL, b4a.from(record.salt, 'hex'), b4a.from(record.verifier, 'hex')), true)
  const priv = unwrap(wrapKeyFrom(rwdL), record.encPriv)
  assert.ok(priv, 'could not recover private key')
  const got = sealOpen(b4a.from(record.pub, 'hex'), priv, record.wrapped.news)
  assert.ok(got && b4a.equals(got, streamKey), 'client could not open the granted stream key')

  // an attacker with the DB but the WRONG password cannot recover the key
  const bad = blind('wrong'); const rwdBad = finalize('wrong', bad.r, evaluate(k, bad.blinded))
  assert.strictEqual(unwrap(wrapKeyFrom(rwdBad), record.encPriv), null, 'wrong password must not recover priv')
})

// 7. Auth keypair: prove login by signing a challenge; wrong key / tampered msg fail.
test('auth keypair sign/verify a challenge', () => {
  const kp = authKeyPair()
  const challenge = b4a.from('panel-challenge-123')
  const sig = authSign(kp.secretKey, challenge)
  assert.strictEqual(authVerify(kp.publicKey, challenge, sig), true)
  assert.strictEqual(authVerify(authKeyPair().publicKey, challenge, sig), false) // wrong key
  assert.strictEqual(authVerify(kp.publicKey, b4a.from('other'), sig), false)     // tampered msg
})

// 8. Session tokens: panel-signed, offline-verifiable, tamper-evident, expiry-aware.
test('session token sign/verify/expiry/tamper', () => {
  const panel = authKeyPair() // stands in for the panel Ed25519 signing key
  const now = Date.now()
  const token = signToken(panel.secretKey, { userId: 'alice', deviceId: 'd1', issuedAt: now, expiresAt: now + 1000, tokenVersion: 1 })
  const payload = verifyToken(panel.publicKey, token)
  assert.ok(payload && payload.userId === 'alice', 'valid token should verify')
  assert.strictEqual(verifyToken(authKeyPair().publicKey, token), null, 'wrong panel key must fail')
  assert.strictEqual(verifyToken(panel.publicKey, token.slice(0, -2) + 'xx'), null, 'tampered sig must fail')
  assert.ok(tokenValid(panel.publicKey, token, now), 'unexpired token valid')
  assert.strictEqual(tokenValid(panel.publicKey, token, now + 2000), null, 'expired token invalid')
})

console.log(`\nRESULT: PASS ✅  (${passed} tests)`)
