// Principal accounts + session tokens for the reseller control API. The verifier
// machinery (argonOpts, makeThrottle, controlKeys, the worker-thread single-flight
// verifier) is a self-contained copy of library/src/control-auth.js — the same
// convention as ever: separate deployables each ship their own copy; if you fix a
// bug here, fix it there. The store is EXTENDED, not just renamed: a principal is
// an admin record plus the reseller hierarchy fields (role, parent, prefix, limits).
//
//   - principals: Argon2id verifiers in DATA_DIR/secrets/principals.json (0600)
//   - tokens: signed with a reseller-local Ed25519 keypair (DATA_DIR/keys/
//     control.json, auto-generated) via core signToken/tokenValid; revocation =
//     bump the principal's tokenVersion
//   - the ROLE IS NEVER TRUSTED FROM THE TOKEN: principalTokenLive() reloads the
//     record per request and hands the LIVE record to the route handlers, so a
//     suspension or role change bites on the target's very next request
//   - lockout: fixed-window throttle (same shape as panel/src/rpc.js makeThrottle)
//   - verify: Argon2id in a worker thread, single-flight (makePrincipalVerifier) — a
//     login flood must never block the event loop (2026-07-16 incident)

import fs from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import crypto from 'hypercore-crypto'
import sodium from 'sodium-native'
import b4a from 'b4a'
import { randomSalt, deriveVerifier } from '@aliran/core'
import { ControlError } from './errors.js'
import { ROLES } from './roles.js'
import { readJsonFile, writeJsonFile } from './store.js'

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
  const kp = crypto.keyPair()
  writeJsonFile(p, {
    publicKey: b4a.toString(kp.publicKey, 'hex'),
    secretKey: b4a.toString(kp.secretKey, 'hex')
  }, { mode: 0o600 })
  return kp
}

function principalsPath (dataDir) { return path.join(dataDir, 'secrets', 'principals.json') }

export function loadPrincipals (dataDir) {
  return readJsonFile(principalsPath(dataDir), {})
}

function savePrincipals (dataDir, principals) {
  writeJsonFile(principalsPath(dataDir), principals, { mode: 0o600 })
}

// Public-safe view of one principal: everything except the credential material.
export function principalSummary (name, p) {
  return {
    name,
    role: p.role,
    root: !!p.root,
    parent: p.parent || null,
    status: p.status || 'active',
    maxDevicesLimit: p.maxDevicesLimit,
    trialDailyCap: p.trialDailyCap,
    createdAt: p.createdAt || null,
    createdBy: p.createdBy || null,
    note: p.note || ''
  }
}

// Create a principal. Capability/hierarchy checks are the CALLER's job (roles.js) —
// this validates shape only: name, password, role.
export function addPrincipal (ctx, { username, password, role, parent = null, maxDevicesLimit, trialDailyCap, root = false, createdBy = null, note = '' }) {
  if (typeof username !== 'string' || !NAME_RE.test(username)) bad('invalid principal name (allowed: letters, digits, _ . - ; max 64)')
  if (typeof password !== 'string' || password.length < 8) bad('password must be at least 8 characters')
  if (!ROLES.includes(role)) bad(`invalid role (one of: ${ROLES.join(', ')})`)
  const principals = loadPrincipals(ctx.dataDir)
  if (principals[username]) throw new ControlError('exists', `principal "${username}" already exists`)
  if (root && Object.values(principals).some((p) => p.root)) throw new ControlError('exists', 'a root admin already exists')
  const salt = randomSalt()
  const argon = argonOpts(ctx.config)
  principals[username] = {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(b4a.from(password), salt, argon), 'hex'),
    argon,
    tokenVersion: 1,
    status: 'active',
    role,
    root: !!root,
    parent,
    // null = INHERIT the parent chain's device policy (roles.js
    // effectiveMaxDevices; the root's fallback is maxDevicesLimitDefault).
    // Only admin tiers may pass an explicit value — the routes gate that.
    maxDevicesLimit: Number.isInteger(maxDevicesLimit) ? maxDevicesLimit : null,
    trialDailyCap: Number.isInteger(trialDailyCap) ? trialDailyCap : ctx.config.trialDailyCapDefault,
    createdAt: Date.now(),
    createdBy,
    note: typeof note === 'string' ? note.slice(0, 200) : ''
  }
  savePrincipals(ctx.dataDir, principals)
  return principalSummary(username, principals[username])
}

// Delete a principal record. The BUSINESS rules (root undeletable, no children, no
// live accounts, balance reclaim) live in the route/ops layer — this only refuses
// the root record as a last line of defense.
export function removePrincipal (ctx, name) {
  const principals = loadPrincipals(ctx.dataDir)
  const p = principals[name]
  if (!p) throw new ControlError('not-found', `no such principal: ${name}`)
  if (p.root) throw new ControlError('forbidden', 'the root admin cannot be deleted')
  delete principals[name]
  savePrincipals(ctx.dataDir, principals)
  return { name, removed: true }
}

export function listPrincipals (ctx) {
  return Object.entries(loadPrincipals(ctx.dataDir)).map(([name, p]) => principalSummary(name, p))
}

export function getPrincipal (ctx, name) {
  const p = loadPrincipals(ctx.dataDir)[name]
  if (!p) throw new ControlError('not-found', `no such principal: ${name}`)
  return principalSummary(name, p)
}

// Rotate a principal password: fresh salt + verifier, and a tokenVersion bump so
// every session issued under the old password dies (the caller's own too, if
// self-rotating).
export function setPrincipalPassword (ctx, name, password) {
  if (typeof password !== 'string' || password.length < 8) bad('password must be at least 8 characters')
  const principals = loadPrincipals(ctx.dataDir)
  const p = principals[name]
  if (!p) throw new ControlError('not-found', `no such principal: ${name}`)
  const salt = randomSalt()
  const argon = argonOpts(ctx.config)
  p.salt = b4a.toString(salt, 'hex')
  p.verifier = b4a.toString(deriveVerifier(b4a.from(password), salt, argon), 'hex')
  p.argon = argon
  p.tokenVersion = (p.tokenVersion || 1) + 1
  savePrincipals(ctx.dataDir, principals)
  return { name, tokenVersion: p.tokenVersion }
}

// Suspend/reactivate. A suspension also bumps tokenVersion so live sessions die
// immediately (principalTokenLive would reject them on status anyway; the bump
// makes the tokens unusable even if the status later flips back).
export function setPrincipalStatus (ctx, name, status) {
  if (status !== 'active' && status !== 'suspended') bad('status must be "active" or "suspended"')
  const principals = loadPrincipals(ctx.dataDir)
  const p = principals[name]
  if (!p) throw new ControlError('not-found', `no such principal: ${name}`)
  if (p.root) throw new ControlError('forbidden', 'the root admin cannot be suspended')
  if (p.status !== status) {
    p.status = status
    if (status === 'suspended') p.tokenVersion = (p.tokenVersion || 1) + 1
    savePrincipals(ctx.dataDir, principals)
  }
  return principalSummary(name, p)
}

export function setPrincipalLimits (ctx, name, { maxDevicesLimit, trialDailyCap }) {
  const principals = loadPrincipals(ctx.dataDir)
  const p = principals[name]
  if (!p) throw new ControlError('not-found', `no such principal: ${name}`)
  if (maxDevicesLimit !== undefined) {
    // null clears the explicit value → the principal inherits again.
    if (maxDevicesLimit === null) {
      p.maxDevicesLimit = null
    } else {
      if (!Number.isInteger(maxDevicesLimit) || maxDevicesLimit < 1 || maxDevicesLimit > 1000) bad('maxDevicesLimit must be an integer 1-1000 (or null to inherit)')
      p.maxDevicesLimit = maxDevicesLimit
    }
  }
  if (trialDailyCap !== undefined) {
    if (!Number.isInteger(trialDailyCap) || trialDailyCap < 0 || trialDailyCap > 1000) bad('trialDailyCap must be an integer 0-1000')
    p.trialDailyCap = trialDailyCap
  }
  savePrincipals(ctx.dataDir, principals)
  return principalSummary(name, p)
}

// Equal Argon2 work whether or not the name exists — login timing does not confirm
// principal usernames.
const DUMMY_PRINCIPAL = {
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

// Principal login verification. Identical policy to the library's admin verifier:
// worker thread (never block the loop), single-flight (concurrent login → 503),
// timeout kills the worker, unknown names pay the same Argon2 cost as real ones.
export function makePrincipalVerifier (ctx, opts = {}) {
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
      const principals = loadPrincipals(ctx.dataDir)
      const p = principals[name]
      const rec = p || DUMMY_PRINCIPAL
      const argon = rec.argon || argonOpts(ctx.config)
      const ok = await dispatch({ password, saltHex: rec.salt, verifierHex: rec.verifier, argon })
      if (!p || !ok || p.status !== 'active') return null
      return { name, tokenVersion: p.tokenVersion || 1 }
    },

    close () {
      const w = worker
      worker = null
      if (inflight) { const f = inflight; inflight = null; f.settle(unavailable('control server closing')) }
      if (w) { try { w.terminate() } catch {} }
    }
  }
}

// Per-request liveness: returns the LIVE record (with its name attached) or null.
// The record — never the token payload — is what routes must consult for role and
// status, so suspension/role changes bite on the very next request.
export function principalTokenLive (ctx, payload) {
  if (!payload || payload.role !== 'principal' || !payload.principalId) return null
  const p = loadPrincipals(ctx.dataDir)[payload.principalId]
  if (!p || p.status !== 'active' || (p.tokenVersion || 1) !== (payload.tokenVersion || 1)) return null
  return { name: payload.principalId, ...p }
}
