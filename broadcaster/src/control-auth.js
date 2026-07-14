// Admin accounts + session tokens for the broadcaster control API. Same pattern as
// the panel's admin auth (panel/src/ops.js — the reference implementation), kept
// self-contained because panel and broadcaster are separate deployables:
//
//   - admins: Argon2id verifiers in DATA_DIR/secrets/admins.json (0600, local-only)
//   - tokens: signed with a broadcaster-local Ed25519 keypair (DATA_DIR/keys/
//     control.json, auto-generated) via core signToken/tokenValid; revocation =
//     bump the admin's tokenVersion
//   - lockout: fixed-window throttle (same shape as panel/src/rpc.js makeThrottle)

import fs from 'fs'
import path from 'path'
import crypto from 'hypercore-crypto'
import sodium from 'sodium-native'
import b4a from 'b4a'
import { randomSalt, deriveVerifier, verify } from '@aliran/core'
import { ControlError } from './channel.js'

const bad = (m) => { throw new ControlError('bad-request', m) }
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// Argon2id cost from config, clamped to the sodium minimums (config.argon2 is
// { memKiB, time }, matching the panel's env knobs).
export function argonOpts (config) {
  return {
    opslimit: Math.max(config.argon2.time, sodium.crypto_pwhash_OPSLIMIT_MIN),
    memlimit: Math.max(config.argon2.memKiB * 1024, sodium.crypto_pwhash_MEMLIMIT_MIN)
  }
}

// Fixed-window rate limiter (same as panel/src/rpc.js makeThrottle).
export function makeThrottle (threshold, windowSec) {
  const map = new Map()
  return (key) => {
    const now = Date.now()
    let e = map.get(key)
    if (!e || now - e.windowStart > windowSec * 1000) { e = { count: 0, windowStart: now }; map.set(key, e) }
    e.count++
    if (e.count > threshold) return { locked: true, retryAfter: Math.ceil((e.windowStart + windowSec * 1000 - now) / 1000) }
    return { locked: false }
  }
}

// Load-or-create the Ed25519 keypair that signs control session tokens.
export function controlKeys (dataDir) {
  const p = path.join(dataDir, 'keys', 'control.json')
  if (fs.existsSync(p)) {
    const k = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { publicKey: b4a.from(k.publicKey, 'hex'), secretKey: b4a.from(k.secretKey, 'hex') }
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const kp = crypto.keyPair()
  fs.writeFileSync(p, JSON.stringify({
    publicKey: b4a.toString(kp.publicKey, 'hex'),
    secretKey: b4a.toString(kp.secretKey, 'hex')
  }, null, 2), { mode: 0o600 })
  return kp
}

function adminsPath (dataDir) { return path.join(dataDir, 'secrets', 'admins.json') }

export function loadAdmins (dataDir) {
  const p = adminsPath(dataDir)
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

function saveAdmins (dataDir, admins) {
  const p = adminsPath(dataDir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(admins, null, 2), { mode: 0o600 })
}

export function addAdmin (ctx, name, password) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) bad('invalid admin name (allowed: letters, digits, _ . - ; max 64)')
  if (typeof password !== 'string' || password.length < 8) bad('admin password must be at least 8 characters')
  const admins = loadAdmins(ctx.dataDir)
  if (admins[name]) throw new ControlError('exists', `admin "${name}" already exists`)
  const salt = randomSalt()
  const argon = argonOpts(ctx.config)
  admins[name] = {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(b4a.from(password), salt, argon), 'hex'),
    argon,
    tokenVersion: 1,
    status: 'active',
    createdAt: Date.now()
  }
  saveAdmins(ctx.dataDir, admins)
  return { name, status: 'active' }
}

export function removeAdmin (ctx, name) {
  const admins = loadAdmins(ctx.dataDir)
  if (!admins[name]) throw new ControlError('not-found', `no such admin: ${name}`)
  delete admins[name]
  saveAdmins(ctx.dataDir, admins)
  return { name, removed: true }
}

// Equal Argon2 work whether or not the name exists — login timing does not confirm
// admin usernames.
const DUMMY_ADMIN = {
  salt: '00000000000000000000000000000000',
  verifier: '00'.repeat(32)
}

export function verifyAdmin (ctx, name, password) {
  if (typeof name !== 'string' || typeof password !== 'string') return null
  const admins = loadAdmins(ctx.dataDir)
  const a = admins[name]
  const rec = a || DUMMY_ADMIN
  const argon = rec.argon || argonOpts(ctx.config)
  const ok = verify(b4a.from(password), b4a.from(rec.salt, 'hex'), b4a.from(rec.verifier, 'hex'), argon)
  if (!a || !ok || a.status !== 'active') return null
  return { name, tokenVersion: a.tokenVersion || 1 }
}

export function adminTokenLive (ctx, payload) {
  if (!payload || payload.role !== 'admin' || !payload.adminId) return false
  const a = loadAdmins(ctx.dataDir)[payload.adminId]
  return !!a && a.status === 'active' && (a.tokenVersion || 1) === (payload.tokenVersion || 1)
}
