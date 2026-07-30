// Encrypted key escrow for the panel's identity — the ONE artifact designed to
// leave the box.
//
// WHY THIS EXISTS. `DATA_DIR/keys/` (signing keypair, OPRF key, shared publisher
// key) is the only thing in an Aliran deployment with no replacement cost, because
// it has no replacement. Every installed viewer app pins the signing public key,
// and the service pairing code is derived from it, so a lost identity is not "restore
// the newest backup" — it is a migration that re-points every viewer. Everything else
// survives: broadcasters repopulate channels and per-stream secrets on re-register.
// `deploy/backup.sh` already tars the keys, but the archive stays on the box you are
// insuring against, so today there is no supported route to get them somewhere safe.
// This module is that route. See docs/kb/backup-and-rotation.md.
//
// FORMAT (one JSON file, `aliran-key-escrow` v1):
//
//   { format, version, createdAt,
//     fingerprint: { panelPublicKey, pairingCode, serviceName, files:[{name,bytes}] },
//     kdf:    { algorithm:'argon2id', opslimit, memlimit, salt },
//     cipher: { algorithm:'xchacha20poly1305-ietf', nonce },
//     ciphertext }
//
// The fingerprint block is CLEARTEXT on purpose. Nothing in it is secret — the panel
// public key and the pairing code are both meant to be distributed — and an operator
// who opens this file in two years must be able to tell, without the passphrase,
// whether it is the right copy for the right deployment.
//
// CRYPTO CHOICES, and why.
//   - KDF: Argon2id (libsodium crypto_pwhash, ALG_ARGON2ID13). The passphrase is the
//     only barrier on a file that sits in cold storage for years, so the KDF must be
//     memory-hard, not just slow. Argon2id is also what this deployment already uses
//     for every password verifier (core/password.js), so it is one primitive, not two.
//     The default cost is MODERATE (3 ops, 256 MiB) — the same 256 MiB the panel's own
//     ARGON2_MEM_KIB default already pays on every admin login, so it is a cost the box
//     is proven to absorb. Raise it with ESCROW_ARGON2_MEM_MIB / ESCROW_ARGON2_OPS; the
//     parameters are recorded in the file, so an older file always opens with its own.
//   - AEAD: XChaCha20-Poly1305-IETF. Authenticated, so a corrupted file fails loudly
//     instead of yielding garbage key bytes, and the 24-byte nonce is safe to pick at
//     random with no counter state to keep.
//   - The cleartext header is the AEAD's ADDITIONAL DATA. Editing the recorded public
//     key or pairing code therefore breaks decryption outright — the fingerprint cannot
//     be swapped onto another deployment's ciphertext.
//
// This module holds no policy. Who may export (see admin-server.js: off unless
// ESCROW_EXPORT=1, re-auth, rate limit, activity ring) and where the bytes go
// (admin-cli.js) are the callers' business.

import fs from 'fs'
import path from 'path'
import sodium from 'sodium-native'
import b4a from 'b4a'
import { pairingCode, pairingCodeMatches, authSign, authVerify } from '@aliran/core'

export const ESCROW_FORMAT = 'aliran-key-escrow'
export const ESCROW_VERSION = 1

// A passphrase is the whole security of this file. 16 characters is the floor, not a
// recommendation — the UI and the runbook both ask for a five-or-six word phrase.
export const MIN_PASSPHRASE = 16

export const ESCROW_KDF_DEFAULT = {
  opslimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE, // 3
  memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE // 256 MiB
}

const KEY_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES
const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const MAC_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES

export class EscrowError extends Error {
  constructor (code, message) { super(message); this.code = code }
}
const bad = (code, m) => { throw new EscrowError(code, m) }

// ---------------------------------------------------------------- key material

// Every regular file in DATA_DIR/keys/ is identity by definition, so the bundle is the
// DIRECTORY rather than a hardcoded list of three names — a future fourth key file is
// escrowed the day it appears, instead of being silently left behind.
export function readKeyFiles (dataDir) {
  const dir = path.join(dataDir, 'keys')
  let names = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    bad('no-keys', 'no key directory at ' + dir + ' — this panel is not initialized')
  }
  if (!names.length) bad('no-keys', 'the key directory ' + dir + ' is empty')
  const files = {}
  for (const name of names) {
    const buf = fs.readFileSync(path.join(dir, name))
    const text = buf.toString('utf8')
    // The payload is JSON, so every file travels as a UTF-8 string. Today all key
    // files are text (JSON and hex). A future BINARY one would round-trip through
    // this lossily, and a corrupted key that still decrypts is the worst possible
    // failure — so refuse it here and bump the format version instead.
    if (!b4a.equals(b4a.from(text, 'utf8'), buf)) {
      bad('binary-key-file', `${name} is not UTF-8 text; this escrow format (v${ESCROW_VERSION}) cannot carry it without loss`)
    }
    files[name] = text
  }
  if (!files['signing.json']) bad('no-keys', 'no signing.json in ' + dir + ' — refusing to escrow an identity that has no signing key')
  return files
}

// ---------------------------------------------------------------- KDF

// Synchronous and memory-hard by design: on the panel's main thread this would freeze
// the event loop (catalog replication, viewer logins) for seconds, exactly the defect
// admin-verify-worker.js exists to avoid. The admin API therefore calls this THROUGH
// escrow-worker.js. The CLI, which has no event loop worth protecting, calls it here.
export function deriveKey (passphrase, salt, kdf = ESCROW_KDF_DEFAULT) {
  const out = b4a.alloc(KEY_BYTES)
  sodium.crypto_pwhash(out, b4a.from(String(passphrase), 'utf8'), salt,
    kdf.opslimit, kdf.memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13)
  return out
}

const syncDerive = async (passphrase, salt, kdf) => deriveKey(passphrase, salt, kdf)

// ---------------------------------------------------------------- envelope

// The AEAD's additional data. Rebuilt from the PARSED values in a fixed order rather
// than from the file's raw bytes, so re-indenting the JSON is harmless while changing
// any recorded value is fatal — which is the property the fingerprint needs.
function aad (env) {
  return b4a.from(JSON.stringify({
    format: env.format,
    version: env.version,
    createdAt: env.createdAt,
    fingerprint: {
      panelPublicKey: env.fingerprint.panelPublicKey,
      pairingCode: env.fingerprint.pairingCode,
      serviceName: env.fingerprint.serviceName,
      files: env.fingerprint.files.map((f) => ({ name: f.name, bytes: f.bytes }))
    },
    kdf: env.kdf,
    cipher: env.cipher
  }), 'utf8')
}

/**
 * Seal the panel identity into an escrow envelope.
 *
 * `derive` is injectable so the admin API can push the Argon2id grind onto a worker
 * thread; it defaults to the in-process synchronous derivation.
 * Returns { envelope, fingerprint, filename }.
 */
export async function sealEscrow ({ dataDir, files, passphrase, serviceName = null, code = null, kdf = ESCROW_KDF_DEFAULT, derive = syncDerive }) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    bad('weak-passphrase', `the escrow passphrase must be at least ${MIN_PASSPHRASE} characters`)
  }
  const bundle = files || readKeyFiles(dataDir)
  const signing = parseSigning(bundle['signing.json'])

  // The pairing code is a ~70 ms Argon2id derivation, so a caller that already has the
  // boot-derived one (the panel does) passes it in rather than paying for it twice.
  const pairing = code || pairingCode(signing.publicKeyHex)

  const salt = b4a.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.randombytes_buf(salt)
  const nonce = b4a.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)

  const env = {
    format: ESCROW_FORMAT,
    version: ESCROW_VERSION,
    createdAt: new Date().toISOString(),
    fingerprint: {
      panelPublicKey: signing.publicKeyHex,
      pairingCode: pairing,
      serviceName: serviceName || null,
      files: Object.keys(bundle).sort().map((name) => ({ name, bytes: b4a.byteLength(bundle[name], 'utf8') }))
    },
    kdf: {
      algorithm: 'argon2id',
      opslimit: kdf.opslimit,
      memlimit: kdf.memlimit,
      salt: b4a.toString(salt, 'hex')
    },
    cipher: {
      algorithm: 'xchacha20poly1305-ietf',
      nonce: b4a.toString(nonce, 'hex')
    }
  }

  const plaintext = b4a.from(JSON.stringify({ files: bundle }), 'utf8')
  const key = await derive(passphrase, salt, kdf)
  const cipher = b4a.alloc(plaintext.length + MAC_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(cipher, plaintext, aad(env), null, nonce, key)
  sodium.sodium_memzero(key)
  sodium.sodium_memzero(plaintext)
  env.ciphertext = b4a.toString(cipher, 'base64')

  return { envelope: env, fingerprint: env.fingerprint, filename: escrowFilename(env) }
}

/**
 * Open an escrow envelope. Returns { files, fingerprint, envelope }.
 * Throws EscrowError('bad-passphrase') for a wrong passphrase OR a damaged file —
 * the AEAD cannot tell those apart, and neither can we honestly claim to.
 */
export async function openEscrow ({ envelope, passphrase, derive = syncDerive }) {
  const env = checkEnvelope(envelope)
  const salt = b4a.from(env.kdf.salt, 'hex')
  const nonce = b4a.from(env.cipher.nonce, 'hex')
  const cipher = b4a.from(env.ciphertext, 'base64')
  if (cipher.length <= MAC_BYTES) bad('malformed', 'the ciphertext is too short to be an escrow payload')

  const key = await derive(passphrase, salt, { opslimit: env.kdf.opslimit, memlimit: env.kdf.memlimit })
  const plain = b4a.alloc(cipher.length - MAC_BYTES)
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(plain, null, cipher, aad(env), nonce, key)
  } catch {
    bad('bad-passphrase', 'cannot decrypt — wrong passphrase, or the file is damaged or edited')
  } finally {
    sodium.sodium_memzero(key)
  }

  let payload = null
  try { payload = JSON.parse(b4a.toString(plain, 'utf8')) } catch {}
  sodium.sodium_memzero(plain)
  if (!payload || !payload.files || typeof payload.files !== 'object') {
    bad('malformed', 'the escrow payload decrypted but does not contain a key bundle')
  }
  return { files: payload.files, fingerprint: env.fingerprint, envelope: env }
}

// Structural checks that need no passphrase — run before the expensive KDF so a
// mistyped filename or a truncated file fails in milliseconds, not seconds.
export function checkEnvelope (envelope) {
  const env = typeof envelope === 'string' ? parseJson(envelope, 'the escrow file is not valid JSON') : envelope
  if (!env || typeof env !== 'object') bad('malformed', 'the escrow file is not an object')
  if (env.format !== ESCROW_FORMAT) bad('malformed', 'not an Aliran key escrow file (format is "' + env.format + '")')
  if (env.version !== ESCROW_VERSION) bad('version', `this file is escrow version ${env.version}; this build reads version ${ESCROW_VERSION}`)
  const f = env.fingerprint
  if (!f || !/^[0-9a-f]{64}$/.test(String(f.panelPublicKey || ''))) bad('malformed', 'the fingerprint has no valid panel public key')
  if (!Array.isArray(f.files)) bad('malformed', 'the fingerprint has no file list')
  if (!env.kdf || env.kdf.algorithm !== 'argon2id' || !/^[0-9a-f]+$/.test(String(env.kdf.salt || ''))) bad('malformed', 'unsupported or missing KDF block')
  if (!Number.isInteger(env.kdf.opslimit) || !Number.isInteger(env.kdf.memlimit)) bad('malformed', 'the KDF block has no cost parameters')
  if (!env.cipher || env.cipher.algorithm !== 'xchacha20poly1305-ietf') bad('malformed', 'unsupported or missing cipher block')
  if (b4a.from(String(env.cipher.nonce || ''), 'hex').length !== NONCE_BYTES) bad('malformed', 'the cipher nonce is the wrong length')
  if (typeof env.ciphertext !== 'string' || !env.ciphertext) bad('malformed', 'the file has no ciphertext')
  return env
}

// ---------------------------------------------------------------- verification

/**
 * Prove a decrypted bundle is the identity its fingerprint claims. This is the half
 * of "does the escrow restore?" that does NOT need a panel: no DATA_DIR, no store, no
 * swarm — so it can never turn into a second writer for the same identity, which the
 * never-two-writers rule makes strictly worse than downtime.
 *
 * Returns { ok, checks:[{name, ok, detail}] }. Every check runs, so one report shows
 * everything that is wrong rather than only the first thing.
 */
export function verifyBundle (files, fingerprint) {
  const checks = []
  const add = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); return ok }

  // 1. The signing keypair is present, parses, and actually signs.
  let signing = null
  try {
    signing = parseSigning(files['signing.json'])
    add('signing key parses', true, signing.publicKeyHex.slice(0, 16) + '…')
  } catch (err) {
    add('signing key parses', false, err.message)
  }
  if (signing) {
    let works = false
    try {
      const msg = b4a.from('aliran-escrow-verify')
      works = authVerify(signing.publicKey, msg, authSign(signing.secretKey, msg))
    } catch {}
    add('signing keypair is usable', works, works ? 'a test signature verifies against the public key' : 'the secret key does not sign for the public key')
  }

  // 2. The OPRF key: 32 bytes of hex. Lose it and every stored password verifier is
  //    dead weight, so its presence is not optional in a bundle worth keeping.
  const oprfRaw = typeof files['oprf.key'] === 'string' ? files['oprf.key'].trim() : ''
  add('OPRF key is 32 bytes', /^[0-9a-fA-F]{64}$/.test(oprfRaw), oprfRaw ? '' : 'missing or empty oprf.key')

  // 3. The shared publisher keypair, when the bundle carries one. Optional: a panel
  //    initialized before named publishers existed, or one that deleted it, is valid.
  if (files['publisher.json'] !== undefined) {
    let works = false
    let detail = ''
    try {
      const p = parseSigning(files['publisher.json'], 'publisher.json')
      const msg = b4a.from('aliran-escrow-verify')
      works = authVerify(p.publicKey, msg, authSign(p.secretKey, msg))
      detail = works ? p.publicKeyHex.slice(0, 16) + '…' : 'the secret key does not sign for the public key'
    } catch (err) { detail = err.message }
    add('publisher keypair is usable', works, detail)
  }

  // 4. The cleartext fingerprint describes what is actually sealed inside. The AEAD
  //    already refuses an edited header, so a mismatch here means the file was BUILT
  //    wrong, not tampered with — still worth catching before someone trusts it.
  if (fingerprint && signing) {
    add('fingerprint matches the sealed key',
      fingerprint.panelPublicKey === signing.publicKeyHex,
      fingerprint.panelPublicKey === signing.publicKeyHex ? '' : 'the header names a different panel key')
    const codeOk = pairingCodeMatches(signing.publicKeyHex, fingerprint.pairingCode || '')
    add('pairing code re-derives from the sealed key', codeOk, fingerprint.pairingCode || '(none recorded)')
  }
  if (fingerprint && Array.isArray(fingerprint.files)) {
    const listed = fingerprint.files.map((f) => f.name).sort().join(',')
    const sealed = Object.keys(files).sort().join(',')
    add('file list matches the header', listed === sealed, sealed)
  }

  return { ok: checks.every((c) => c.ok), checks }
}

// ---------------------------------------------------------------- helpers

function parseJson (text, msg) {
  try { return JSON.parse(text) } catch { bad('malformed', msg) }
}

function parseSigning (text, what = 'signing.json') {
  if (typeof text !== 'string' || !text) bad('malformed', `no ${what} in the bundle`)
  const j = parseJson(text, `${what} is not valid JSON`)
  const pub = String(j.publicKey || '')
  const sec = String(j.secretKey || '')
  if (!/^[0-9a-f]{64}$/i.test(pub)) bad('malformed', `${what} has no 32-byte public key`)
  if (!/^[0-9a-f]{128}$/i.test(sec)) bad('malformed', `${what} has no 64-byte secret key`)
  return { publicKeyHex: pub.toLowerCase(), publicKey: b4a.from(pub, 'hex'), secretKey: b4a.from(sec, 'hex') }
}

// Names the deployment and the moment, so a folder of these files from several
// deployments stays sortable and unambiguous without opening any of them.
export function escrowFilename (env) {
  const code = String(env.fingerprint.pairingCode || env.fingerprint.panelPublicKey.slice(0, 12)).replace(/[^A-Za-z0-9-]/g, '')
  const stamp = env.createdAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  return `aliran-escrow-${code}-${stamp}.json`
}

// The bytes that go on disk / over the wire. Indented: a human reads the fingerprint
// block out of this file years from now, possibly with nothing but a text editor.
export function serializeEscrow (env) {
  return JSON.stringify(env, null, 2) + '\n'
}
