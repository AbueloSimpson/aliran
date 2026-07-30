// Unit tests for @aliran/core. Run: node core/test.mjs   (exit 0 = all pass)
import assert from 'assert'
import b4a from 'b4a'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeFileAtomic, writeJsonAtomic, atomicTmpPath, isAtomicTmp } from './atomic-write.js'
import {
  oprfKeyGen, blind, evaluate, finalize, evaluateFull,
  randomSalt, deriveVerifier, verify, wrapKeyFrom, wrap, unwrap,
  userKeyPair, sealTo, sealOpen,
  authKeyPair, authSign, authVerify,
  signToken, verifyToken, tokenValid,
  pairingCode, normalizePairingCode, formatPairingCode, pairingTopic, pairingCodeMatches,
  PAIRING_CODE_LENGTH, CROCKFORD_ALPHABET
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

// 9. Pairing code: a deterministic 12-character Crockford alias for a panel key.
test('pairing code is deterministic, 12 Crockford characters, grouped by 4', () => {
  const key = b4a.toString(authKeyPair().publicKey, 'hex')
  const code = pairingCode(key)
  assert.strictEqual(code, pairingCode(key), 'same key must give the same code')
  assert.ok(/^[^-]{4}-[^-]{4}-[^-]{4}$/.test(code), 'display form is XXXX-XXXX-XXXX, got ' + code)
  const canonical = normalizePairingCode(code)
  assert.strictEqual(canonical.length, PAIRING_CODE_LENGTH)
  for (const ch of canonical) assert.ok(CROCKFORD_ALPHABET.includes(ch), 'non-Crockford character ' + ch)
  assert.ok(!/[ILOU]/.test(canonical), 'the confusable characters must never be emitted')
  // The 32 raw bytes and their hex are the same key, so they must give the same code.
  const kp = authKeyPair()
  assert.strictEqual(pairingCode(kp.publicKey), pairingCode(b4a.toString(kp.publicKey, 'hex')))
  assert.strictEqual(pairingCode(kp.publicKey), pairingCode(b4a.toString(kp.publicKey, 'hex').toUpperCase()))
})

// 10. The code FOLLOWS the key: a different panel key is a different code.
test('pairing code changes with the panel key', () => {
  const seen = new Set()
  for (let i = 0; i < 8; i++) seen.add(pairingCode(authKeyPair().publicKey))
  assert.strictEqual(seen.size, 8, 'distinct keys collided')
  // A one-bit change is enough — the KDF output is not a truncation of the key.
  const kp = authKeyPair()
  const flipped = b4a.from(kp.publicKey); flipped[0] ^= 1
  assert.notStrictEqual(pairingCode(kp.publicKey), pairingCode(flipped))
})

// 11. Malformed input is refused rather than given a plausible-looking code.
test('pairing code rejects malformed input', () => {
  for (const bad of ['', 'not-a-key', 'ab'.repeat(31), 'zz'.repeat(32), 'ab'.repeat(33), null, undefined, 42, {}, b4a.alloc(31), b4a.alloc(33)]) {
    assert.throws(() => pairingCode(bad), TypeError, 'accepted ' + JSON.stringify(bad))
  }
})

// 12. Normalization: what a viewer types vs. what the code is.
test('pairing code normalizes viewer typing and rejects non-codes', () => {
  const canonical = 'A3K79QF2M4XR'
  assert.strictEqual(normalizePairingCode('a3k7-9qf2-m4xr'), canonical) // lowercase + dashes
  assert.strictEqual(normalizePairingCode('  A3K7 9QF2 M4XR '), canonical) // spaces
  assert.strictEqual(normalizePairingCode('A3K7.9QF2_M4XR'), canonical) // other separators
  // Crockford decoding: the excluded characters read as their digits.
  assert.strictEqual(normalizePairingCode('a3k7-9qf2-m4xi'), 'A3K79QF2M4X1')
  assert.strictEqual(normalizePairingCode('OL-K79QF2M4XR'), '01K79QF2M4XR')
  // Not codes.
  for (const bad of ['', 'A3K7-9QF2', 'A3K7-9QF2-M4XRX', 'A3K7-9QF2-M4X!', 'A3K7-9QF2-M4XU', null, 42, {}]) {
    assert.strictEqual(normalizePairingCode(bad), null, 'accepted ' + JSON.stringify(bad))
  }
  assert.strictEqual(formatPairingCode(canonical), 'A3K7-9QF2-M4XR')
})

// 13. The topic is a pure function of the code — the panel announces on it, the client
//     joins it holding nothing else — and it is NOT the panel key's own topic.
test('pairing topic derives from the code alone', () => {
  const key = b4a.toString(authKeyPair().publicKey, 'hex')
  const code = pairingCode(key)
  const topic = pairingTopic(code)
  assert.strictEqual(topic.length, 32)
  assert.ok(b4a.equals(topic, pairingTopic('  ' + code.toLowerCase().replace(/-/g, ' ') + '  ')), 'typing variants must reach the same topic')
  assert.ok(!b4a.equals(topic, pairingTopic(pairingCode(authKeyPair().publicKey))), 'different codes must not share a topic')
  assert.throws(() => pairingTopic('nope'), TypeError)
})

// 14. Verification by recomputation — the check that makes a substituted panel key
//     useless to whoever answered on the topic.
test('pairing code verifies against its own key only', () => {
  const kp = authKeyPair()
  const code = pairingCode(kp.publicKey)
  assert.strictEqual(pairingCodeMatches(kp.publicKey, code), true)
  assert.strictEqual(pairingCodeMatches(b4a.toString(kp.publicKey, 'hex'), code.toLowerCase()), true)
  assert.strictEqual(pairingCodeMatches(authKeyPair().publicKey, code), false) // impostor panel
  assert.strictEqual(pairingCodeMatches(kp.publicKey, 'A3K7-9QF2-M4XR'), false) // wrong code
  assert.strictEqual(pairingCodeMatches(kp.publicKey, 'garbage'), false)
  assert.strictEqual(pairingCodeMatches('not-a-key', code), false) // never throws on bad input
})

// ---------------------------------------------------------------- atomic-write.js
// Durability of the JSON registries (channels.json, secrets/streams.json, admins.json,
// publishers.json, packages.json, sources.json, titles.json). The property under test is
// NOT "the bytes are right" — the service suites already cover contents — it is that no
// failure mid-write can leave the LIVE path truncated, and that a secret's 0600 mode
// survives the rename in every case, including over a pre-existing file and over a stale
// .tmp left by an earlier crash.
//
// POSIX modes do not exist on Windows (statSync reports 0666 for everything), so the mode
// assertions are gated and announced as skipped rather than passing vacuously — prod is
// Linux and that is where they must hold.
const POSIX = process.platform !== 'win32'
const modeOf = (f) => fs.statSync(f).mode & 0o777
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-atomic-'))

test('atomic write replaces content and leaves no .tmp behind', () => {
  const d = tmpdir()
  try {
    const f = path.join(d, 'channels.json')
    writeJsonAtomic(f, { 'chan-1': { title: 'One' } })
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { 'chan-1': { title: 'One' } })
    writeJsonAtomic(f, { 'chan-2': { title: 'Two' } })
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { 'chan-2': { title: 'Two' } })
    assert.ok(!fs.existsSync(atomicTmpPath(f)), 'no .tmp survives a successful write')
    assert.deepStrictEqual(fs.readdirSync(d), ['channels.json'], 'no other litter in the dir')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

// The temp file MUST be a sibling of the target: rename() is only atomic within one
// filesystem, and os.tmpdir() is frequently a different one (tmpfs, or another volume in
// a container), where it silently degrades to copy-then-delete.
test('atomic write keeps its temp file in the target directory', () => {
  const d = tmpdir()
  try {
    const f = path.join(d, 'sub', 'deep', 'sources.json')
    assert.strictEqual(path.dirname(atomicTmpPath(f)), path.dirname(f))
    writeJsonAtomic(f, { s: 1 }) // also proves mkdir -p of the intermediate dirs
    assert.ok(fs.existsSync(f))
    assert.ok(isAtomicTmp(atomicTmpPath(f)) && !isAtomicTmp(f))
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

// A stale .tmp cannot be mistaken for real data: no loader in the tree opens one (they
// read exact paths; the analytics prune regexes are anchored to \.json$), and the next
// write truncates it rather than appending to it.
test('a stale .tmp from an earlier crash contributes no bytes to the next write', () => {
  const d = tmpdir()
  try {
    const f = path.join(d, 'packages.json')
    fs.writeFileSync(f, JSON.stringify({ good: true }))
    fs.writeFileSync(atomicTmpPath(f), 'x'.repeat(9999)) // half-written leftover, larger than the new payload
    writeJsonAtomic(f, { fresh: 1 })
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { fresh: 1 }, 'live file is exactly the new value')
    assert.ok(!fs.existsSync(atomicTmpPath(f)), 'the leftover is consumed, not left to grow')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

// The failure this whole module exists to prevent: a write that dies partway must leave the
// PREVIOUS registry readable. Two distinct failure points — before the temp file exists
// (EISDIR on open) and after it exists but before the rename (invalid data at write time,
// which is also the path that must clean the temp file up).
test('a failed atomic write leaves the live registry intact', () => {
  const d = tmpdir()
  try {
    const f = path.join(d, 'channels.json')
    const good = { 'chan-1': { title: 'One', streamKey: 'secret' } }
    writeJsonAtomic(f, good)

    // (a) fails before the temp file is created
    fs.mkdirSync(atomicTmpPath(f))
    assert.throws(() => writeJsonAtomic(f, { clobbered: true }), /EISDIR|EPERM|EACCES/)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), good, 'live file untouched after an open failure')
    fs.rmdirSync(atomicTmpPath(f))

    // (b) fails after the temp file is created, before the rename
    assert.throws(() => writeFileAtomic(f, { not: 'a string' }), /ERR_INVALID_ARG_TYPE/)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), good, 'live file untouched after a write failure')
    assert.ok(!fs.existsSync(atomicTmpPath(f)), 'the temp file is cleaned up when the write throws')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

// The regression that would be easy to introduce here: creating the temp file at the
// default 0644/0666 and only chmod-ing the live path afterwards, which leaves the secret
// world-readable for the width of the write. rename() carries the temp file's mode, so
// 0600 must hold in all three cases — new file, pre-existing looser file, stale looser .tmp.
test('atomic write applies 0600 before the rename, in every case', () => {
  if (!POSIX) { console.log('       (mode assertions skipped on win32 — no POSIX modes)'); return }
  const d = tmpdir()
  try {
    const f = path.join(d, 'streams.json')

    writeJsonAtomic(f, { a: 'key' }, { mode: 0o600 })
    assert.strictEqual(modeOf(f), 0o600, 'new secrets file is 0600')

    // The window that must not exist: sample the temp file's mode at rename time. Creating it
    // at the default 0644/0666 and chmod-ing the live path afterwards would leave the stream
    // keys readable by any local user for the width of the write.
    let atRename = null
    const realRename = fs.renameSync
    fs.renameSync = (from, to) => { atRename = modeOf(from); return realRename(from, to) }
    try { writeJsonAtomic(f, { a: 'key2' }, { mode: 0o600 }) } finally { fs.renameSync = realRename }
    assert.strictEqual(atRename, 0o600, 'the temp file is already 0600 when it is renamed into place')

    // A file that already exists at a looser mode: open()'s mode argument does NOT apply to
    // it, which is exactly why the temp file is created fresh and fchmod-ed.
    fs.chmodSync(f, 0o644)
    writeJsonAtomic(f, { b: 'key' }, { mode: 0o600 })
    assert.strictEqual(modeOf(f), 0o600, 'pre-existing 0644 file comes back 0600')

    // A stale .tmp at a loose mode must not hand that mode to the live path.
    fs.writeFileSync(atomicTmpPath(f), 'junk', { mode: 0o666 })
    fs.chmodSync(atomicTmpPath(f), 0o666)
    writeJsonAtomic(f, { c: 'key' }, { mode: 0o600 })
    assert.strictEqual(modeOf(f), 0o600, 'a stale world-readable .tmp cannot loosen the live file')
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { c: 'key' })

    // dirMode applies to directories mkdir CREATES (the 0700 secrets dir)…
    const nested = path.join(d, 'secrets', 'admins.json')
    writeJsonAtomic(nested, { root: {} }, { mode: 0o600, dirMode: 0o700 })
    assert.strictEqual(modeOf(path.dirname(nested)), 0o700, 'secrets dir created owner-only')
    assert.strictEqual(modeOf(nested), 0o600)

    // …and never touches one that already exists, matching mkdirSync's own semantics.
    const plainDir = path.join(d, 'plain')
    fs.mkdirSync(plainDir, { mode: 0o755 })
    fs.chmodSync(plainDir, 0o755) // mkdir's mode is umask-filtered; assert against a known value
    writeJsonAtomic(path.join(plainDir, 'x.json'), { x: 1 }, { dirMode: 0o700 })
    assert.strictEqual(modeOf(plainDir), 0o755, 'an existing directory is left alone')

    // The mirror of the 0600 requirement: a NON-secret registry must not be silently
    // tightened either, or a backup/restore run as another user stops being readable.
    const plain = path.join(d, 'packages.json')
    writeJsonAtomic(plain, { basic: {} })
    assert.strictEqual(modeOf(plain), 0o666 & ~(process.umask() & 0o777), 'non-secret registries keep the default mode')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

// indent 2 is what every registry writes (readable in a backup / by an operator);
// indent 0 is the compact form the analytics + reports rollups write. Both must round-trip.
test('atomic write preserves each caller\'s on-disk JSON shape', () => {
  const d = tmpdir()
  try {
    const value = { hours: { 13: { logins: { ok: 2 } } } }
    const pretty = path.join(d, 'pretty.json')
    const compact = path.join(d, 'compact.json')
    writeJsonAtomic(pretty, value)
    writeJsonAtomic(compact, value, { indent: 0, fsync: false })
    assert.strictEqual(fs.readFileSync(pretty, 'utf8'), JSON.stringify(value, null, 2))
    assert.strictEqual(fs.readFileSync(compact, 'utf8'), JSON.stringify(value))
    assert.ok(fs.readFileSync(pretty, 'utf8').includes('\n') && !fs.readFileSync(compact, 'utf8').includes('\n'))
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(compact, 'utf8')), value)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

console.log(`\nRESULT: PASS ✅  (${passed} tests)`)
