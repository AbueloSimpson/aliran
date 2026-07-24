// Admin accounts + session tokens for the library control API. Self-contained copy of
// broadcaster/src/control-auth.js (itself patterned on panel/src/ops.js) — the same
// convention as ever: panel, broadcaster and library are separate deployables, so each
// ships its own copy. If you fix a bug here, fix it there. Differences: none beyond
// the ControlError import (library/src/titles.js owns the error class here).
//
//   - admins: Argon2id verifiers in DATA_DIR/secrets/admins.json (0600, local-only)
//   - tokens: signed with a broadcaster-local Ed25519 keypair (DATA_DIR/keys/
//     control.json, auto-generated) via core signToken/tokenValid; revocation =
//     bump the admin's tokenVersion
//   - lockout: fixed-window throttle (same shape as panel/src/rpc.js makeThrottle)
//   - verify: Argon2id in a worker thread, single-flight (makeAdminVerifier) — a
//     login flood must never block the event loop (2026-07-16 incident)

import fs from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import crypto from 'hypercore-crypto'
import sodium from 'sodium-native'
import b4a from 'b4a'
import { randomSalt, deriveVerifier } from '@aliran/core'
import { ControlError } from './titles.js'

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

// Fixed-window rate limiter (same as panel/src/rpc.js makeThrottle). BOUNDED: the key
// space is attacker-influenced (arbitrary usernames, per-connection/-IP identity), so
// past maxKeys a call drops expired windows and, if still at the cap, evicts the
// oldest-inserted entries down to half — O(1) amortized, no timer, memory can't be
// exhausted by junk keys. `.size` (non-enumerable) exposes the live key count.
export function makeThrottle (threshold, windowSec, { maxKeys = 20000 } = {}) {
  const map = new Map()
  const windowMs = windowSec * 1000
  const throttle = (key) => {
    const now = Date.now()
    if (map.size >= maxKeys) {
      for (const [k, v] of map) if (now - v.windowStart > windowMs) map.delete(k)
      if (map.size >= maxKeys) { const keep = maxKeys >> 1; for (const k of map.keys()) { if (map.size <= keep) break; map.delete(k) } }
    }
    let e = map.get(key)
    if (!e || now - e.windowStart > windowMs) { e = { count: 0, windowStart: now }; map.set(key, e) }
    e.count++
    if (e.count > threshold) return { locked: true, retryAfter: Math.ceil((e.windowStart + windowMs - now) / 1000) }
    return { locked: false }
  }
  Object.defineProperty(throttle, 'size', { get: () => map.size })
  return throttle
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

// Public-safe admin listing: names + status only, never salts/verifiers.
export function listAdmins (ctx) {
  return Object.entries(loadAdmins(ctx.dataDir)).map(([name, a]) => ({
    name,
    status: a.status || 'active',
    createdAt: a.createdAt || null
  }))
}

// Rotate an admin password: fresh salt + verifier, and a tokenVersion bump so every
// session issued under the old password dies (the caller's own too, if self-rotating).
export function setAdminPassword (ctx, name, password) {
  if (typeof password !== 'string' || password.length < 8) bad('admin password must be at least 8 characters')
  const admins = loadAdmins(ctx.dataDir)
  const a = admins[name]
  if (!a) throw new ControlError('not-found', `no such admin: ${name}`)
  const salt = randomSalt()
  const argon = argonOpts(ctx.config)
  a.salt = b4a.toString(salt, 'hex')
  a.verifier = b4a.toString(deriveVerifier(b4a.from(password), salt, argon), 'hex')
  a.argon = argon
  a.tokenVersion = (a.tokenVersion || 1) + 1
  saveAdmins(ctx.dataDir, admins)
  return { name, tokenVersion: a.tokenVersion }
}

// Equal Argon2 work whether or not the name exists — login timing does not confirm
// admin usernames.
const DUMMY_ADMIN = {
  salt: '00000000000000000000000000000000',
  verifier: '00'.repeat(32)
}

// 503 for "can't verify right now" (busy / timed out / worker died) — the generic
// err.httpStatus path in control-server.js turns it into the HTTP response.
function unavailable (message) {
  const e = new Error(message)
  e.httpStatus = 503
  return e
}

// Admin login verification for the control server. The Argon2id grind runs in a
// dedicated worker thread so it can NEVER block the event loop — on the main thread
// a single verify is a synchronous memory-hard pass (memKiB per call), and on a
// swapping small host that pass takes minutes: the 2026-07-16 incident had 4-5
// queued /api/login verifies starve the control API AND swarm replication for 25+
// minutes. Policy on top of the worker:
//
//   - single-flight: one verify in flight, ever. A concurrent login is rejected
//     immediately with 503 instead of queueing behind the grind.
//   - timeout: a verify that outlives timeoutMs gets its worker terminated (a fresh
//     one spawns for the next attempt) and the login fails 503 — a thrashing box
//     keeps serving media even if logins are temporarily impossible.
//   - unknown names still cost the same work as real ones (DUMMY_ADMIN), so login
//     timing does not confirm admin usernames.
export function makeAdminVerifier (ctx, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000
  let worker = null
  let inflight = null // { id, worker, settle } — the one verify we're waiting on
  let seq = 0

  function spawnWorker () {
    const w = new Worker(new URL('./control-verify-worker.js', import.meta.url))
    w.unref() // must not hold the process open; close() still terminates it
    w.on('message', (m) => {
      if (inflight && inflight.id === m.id) { const f = inflight; inflight = null; f.settle(null, m.ok) }
    })
    const gone = () => {
      if (worker === w) worker = null
      if (inflight && inflight.worker === w) { const f = inflight; inflight = null; f.settle(unavailable('login verification unavailable (worker died)')) }
    }
    w.on('error', gone)
    w.on('exit', gone)
    return w
  }

  function dispatch (job) {
    return new Promise((resolve, reject) => {
      if (!worker) worker = spawnWorker()
      const w = worker
      const id = ++seq
      const timer = setTimeout(() => {
        if (!inflight || inflight.id !== id) return
        inflight = null
        if (worker === w) worker = null
        try { w.terminate() } catch {}
        reject(unavailable(`login verification timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      if (timer.unref) timer.unref()
      inflight = {
        id,
        worker: w,
        settle: (err, ok) => { clearTimeout(timer); err ? reject(err) : resolve(ok) }
      }
      w.postMessage({ id, ...job })
    })
  }

  return {
    get busy () { return !!inflight },

    // Resolves { name, tokenVersion } on success, null on bad credentials; throws
    // httpStatus 503 when busy / timed out / the worker died.
    async verify (name, password) {
      if (typeof name !== 'string' || typeof password !== 'string') return null
      if (inflight) throw unavailable('a login verification is already in flight — retry shortly')
      const admins = loadAdmins(ctx.dataDir)
      const a = admins[name]
      const rec = a || DUMMY_ADMIN
      const argon = rec.argon || argonOpts(ctx.config)
      const ok = await dispatch({ password, saltHex: rec.salt, verifierHex: rec.verifier, argon })
      if (!a || !ok || a.status !== 'active') return null
      return { name, tokenVersion: a.tokenVersion || 1 }
    },

    close () {
      const w = worker
      worker = null
      if (inflight) { const f = inflight; inflight = null; f.settle(unavailable('control server closing')) }
      if (w) { try { w.terminate() } catch {} }
    }
  }
}

export function adminTokenLive (ctx, payload) {
  if (!payload || payload.role !== 'admin' || !payload.adminId) return false
  const a = loadAdmins(ctx.dataDir)[payload.adminId]
  return !!a && a.status === 'active' && (a.tokenVersion || 1) === (payload.tokenVersion || 1)
}
