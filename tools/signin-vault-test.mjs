// Unit test for client/backend/signin-vault.mjs — the at-rest half of a phone -> TV
// sign-in. No network, no DHT, no panel: this is the part that can be reasoned about on
// its own, and the part whose mistakes are silent.
//
// The interesting assertions are the LAST THREE groups. terminalSignInError() decides whether
// a television keeps the account it is holding or erases it, and erasing is the only
// irreversible thing in this feature: it sends a viewer to another room for a phone. It
// decides on the wording of errors that sdk/login.js writes and codes that panel/src/rpc.js
// answers with.
//
// THE SECOND-TO-LAST GROUP asks the same question of the documents, because a rule is only as
// good as the copy somebody else reads. sdk/index.d.ts told embedders to ERASE on
// 'session failed: device-limit' — which this predicate has never done — so an SDK consumer
// who followed the type definitions destroyed a viewer's account keys over an operator's full
// device slots. English is not parsed: each prose surface carries one table in a fixed form
// between two markers, this file GENERATES that table from the same two authorities, and the
// copies are compared line by line. Then the checker is run against surfaces broken on
// purpose, so it cannot quietly stop matching — which is the failure mode that let the .d.ts
// sit wrong, and the same one that hid a panel code from the regex below when it moved out of
// a `return json({...})` literal.
//
// The LAST group is about the other half of the same judgement: a code classified KEEP is a
// code the device RETRIES, and a retry that reaches the panel costs a `login` the panel's
// throttle counts. So it reads the panel's threshold, the worklet's per-resume cap and the
// screen's rule off the disk and checks the arithmetic between them still leaves a
// television unable to lock out its own account. Nothing else in the tree connects those
// four files, and nothing was counting logins across attempts at all.
//
// AND THE COUPLING IS TO THOSE FILES, not to a copy of their prose. An earlier revision of
// this lane claimed to "pin the engine's error prose so a reworded message cannot turn a
// revocation into an endless retry", and did no such thing: the strings were literals
// typed HERE, asserted against the predicate, both in the same commit. Rewording the
// panel's 'account disabled' left this lane and CI green while a disabled account retried
// for ever. So the last group READS panel/src/rpc.js and sdk/login.js off the disk, pulls
// out every error they can actually produce, and fails when one of them is not classified
// — a reword, an addition or a removal all break it, which is the only version of this
// claim worth making.
//
// Exits 0 on PASS.  Run: npm run test:signin-vault
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import {
  SIGNIN_VAULT_VERSION, FILE_KEY_BYTES,
  gateSignInKeys, gateVaultRecord, sealSignIn, openSignIn,
  terminalSignInError, accountNotReplicatedYet
} from '../client/backend/signin-vault.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let passed = 0
const check = (ok, label) => { if (!ok) throw new Error('FAILED: ' + label); passed++; console.log('  ok  ', label) }
const hex = (n) => b4a.toString(hcrypto.randomBytes(n), 'hex')

try {
  const KEYS = { username: 'alice', panelPubKey: hex(32), priv: hex(32), authPriv: hex(64) }

  // --- the shape gate on the way IN --------------------------------------------------
  console.log('gateSignInKeys')
  check(!!gateSignInKeys(KEYS), 'accepts a well-formed handover')
  check(gateSignInKeys({ ...KEYS, priv: KEYS.priv.toUpperCase() }).priv === KEYS.priv, 'normalizes hex case')
  check(gateSignInKeys({ ...KEYS, priv: hex(31) }) === null, 'refuses a short X25519 key')
  check(gateSignInKeys({ ...KEYS, authPriv: hex(32) }) === null, 'refuses a 32-byte Ed25519 key (it is 64)')
  check(gateSignInKeys({ ...KEYS, panelPubKey: 'zz' }) === null, 'refuses a panel key that is not hex')
  check(gateSignInKeys({ ...KEYS, username: '' }) === null, 'refuses an empty username')
  check(gateSignInKeys({ ...KEYS, username: 'a'.repeat(65) }) === null, 'refuses an over-long username')
  check(gateSignInKeys(null) === null && gateSignInKeys('alice') === null, 'refuses non-objects')
  // The gate is what stops an unusable record reaching the disk: every one of the lengths
  // above is one sdk/login.js would refuse on the way back in, and a device that stored it
  // would fail its resume for ever with no way to tell why.
  check(gateSignInKeys({ ...KEYS, extra: 'x' }).extra === undefined, 'drops unknown fields rather than storing them')

  // --- the envelope -------------------------------------------------------------------
  console.log('sealSignIn / openSignIn')
  const fileKey = hcrypto.randomBytes(FILE_KEY_BYTES)
  const box = sealSignIn(fileKey, KEYS)
  check(typeof box === 'string' && /^[0-9a-f]+$/.test(box), 'the box is hex')
  check(!box.includes(KEYS.priv) && !box.includes(KEYS.authPriv), 'and carries neither key in the clear')
  const out = openSignIn(fileKey, box)
  check(out && out.priv === KEYS.priv && out.authPriv === KEYS.authPriv && out.username === KEYS.username && out.panelPubKey === KEYS.panelPubKey,
    'it opens back to exactly what went in')
  check(openSignIn(hcrypto.randomBytes(FILE_KEY_BYTES), box) === null, 'a different file key opens nothing')
  check(openSignIn(fileKey, box.slice(0, box.length - 2)) === null, 'a truncated box opens nothing')
  check(openSignIn(fileKey, box.slice(0, 40) + (box[40] === 'a' ? 'b' : 'a') + box.slice(41)) === null, 'a flipped byte opens nothing (the MAC is checked)')
  check(openSignIn(fileKey, 'not hex') === null && openSignIn(fileKey, '') === null && openSignIn(null, box) === null,
    'garbage in every argument answers null, never a throw')
  check(openSignIn(b4a.alloc(16), box) === null, 'a wrong-length file key answers null')
  let threw = null
  try { sealSignIn(fileKey, { ...KEYS, priv: 'nope' }) } catch (e) { threw = e }
  check(!!threw, 'sealing malformed keys THROWS rather than writing them (the one loud failure here)')

  // --- the shape gate on the way OUT ---------------------------------------------------
  console.log('gateVaultRecord')
  const stored = { v: SIGNIN_VAULT_VERSION, box, key: 'QUJDRA==', at: Date.now() }
  check(!!gateVaultRecord(stored), 'accepts a well-formed record')
  check(gateVaultRecord({ ...stored, v: SIGNIN_VAULT_VERSION + 1 }) === null, 'refuses a future version rather than guessing at it')
  check(gateVaultRecord({ ...stored, box: undefined }) === null, 'refuses a record with no box')
  check(gateVaultRecord({ ...stored, key: '' }) === null, 'refuses a record with no wrapped key')
  check(gateVaultRecord({ ...stored, key: 'not base64!' }) === null, 'refuses a wrapped key that is not base64')
  check(gateVaultRecord({ ...stored, key: 'A'.repeat(5000) }) === null, 'refuses an implausibly large wrapped key')
  check(gateVaultRecord({ ...stored, at: 'yesterday' }).at === 0, 'a bad timestamp degrades to 0 rather than failing the record')
  check(gateVaultRecord(null) === null && gateVaultRecord([]) === null, 'refuses non-objects')

  // --- keep or erase --------------------------------------------------------------------
  // Every string below is a substring of a message sdk/login.js or sdk/player.js actually
  // produces. Read them as the list of ways a stored sign-in can die.
  console.log('terminalSignInError — ERASE')
  for (const m of [
    'session failed: account disabled',            // the operator disabled the account
    'session failed: unknown user',                // the PANEL's own db has no such account
    'key handover does not match this account',    // WHAT A PASSWORD ROTATION LOOKS LIKE
    'panel returned an invalid session token',
    'the panel issued no session token — the key handover did not sign this device in',
    'priv must be 32 bytes (hex or buffer)',       // our own stored record is malformed
    'authPriv must be 64 bytes (hex or buffer)'
  ]) check(terminalSignInError(new Error(m)) === true, m)

  console.log('terminalSignInError — KEEP AND RETRY')
  for (const m of [
    'not connected to panel',                      // the swarm is still dialling
    'CHANNEL_CLOSED',                              // the panel socket died mid-call
    'login failed: locked (retry 900s)',           // the panel throttle, not a verdict
    'login failed: bad proof-of-work',
    'session failed: sessions unavailable',        // the PANEL is missing its signing key
    'session failed: device-limit',                // the operator's SLOTS are full, and a
                                                   // slot frees itself — see the note in
                                                   // signin-vault.mjs. Reclassified from
                                                   // ERASE, and only once the restore
                                                   // door's budget stopped counting
                                                   // seconds: keeping means retrying
                                                   // every boot.
    'the panel issued no session challenge — it is too old for a key handover',
    'timeout: panel connection',
    'EPARTIALREAD'                                 // store corruption; recovery handles it
  ]) check(terminalSignInError(new Error(m)) === false, m)

  // THE FOUR REQUEST REFUSALS. panel/src/rpc.js answers all of them from the same `session`
  // responder, behind the same 'session failed: ' prefix as a real verdict — and matching
  // the PREFIX rather than the code meant a malformed call, a lost one-shot challenge, or a
  // panel-side record with an undecodable authPub each destroyed an account on its first
  // occurrence.
  console.log('terminalSignInError — a refusal of the REQUEST is not a verdict on the device')
  for (const m of [
    'session failed: bad request',
    'session failed: no session challenge (login first)',
    'session failed: missing deviceId',
    'session failed: auth failed'
  ]) check(terminalSignInError(new Error(m)) === false, m)

  // …and the bare form, which sdk/login.js throws after reading the LOCAL replica. On a
  // cold start it means "not replicated yet" at least as often as "gone", and the panel's
  // authoritative answer arrives prefixed (asserted ERASE above).
  console.log('terminalSignInError — the replication gap')
  check(terminalSignInError(new Error('unknown user')) === false, 'a bare "unknown user" is the local replica, not a verdict — keep')
  check(accountNotReplicatedYet(new Error('unknown user')) === true, '…and is recognised as the record not having arrived yet')
  check(accountNotReplicatedYet(new Error('session failed: unknown user')) === false, 'the panel\'s own "unknown user" is NOT the replication gap')
  check(accountNotReplicatedYet(new Error('not connected to panel')) === false, 'and neither is anything else')

  check(terminalSignInError(null) === false && terminalSignInError('') === false && terminalSignInError(undefined) === false,
    'no message at all is not a verdict — keep')
  check(terminalSignInError('SESSION FAILED: account disabled') === true, 'the match is case-insensitive and takes a bare string')
  check(terminalSignInError('  session failed: account disabled  ') === true, 'and survives surrounding whitespace')

  // --- COUPLED TO THE REAL SOURCES ------------------------------------------------------
  // Everything above is this file asserting against itself. What follows reads the two
  // files that WRITE these messages and fails if either grows, loses or rewords one that
  // this predicate has never been taught about.
  console.log('coupling — panel/src/rpc.js `session` responder')
  const rpc = read('panel/src/rpc.js')
  const sessionStart = rpc.indexOf("rpc.respond('session'")
  check(sessionStart > 0, 'the session responder is where this test expects it')
  // The responder ends where the next one begins; everything between is its own.
  const sessionBody = rpc.slice(sessionStart, rpc.indexOf('rpc.respond(', sessionStart + 20))
  const sessionCodes = [...sessionBody.matchAll(/json\(\{\s*error:\s*'([^']+)'/g)].map((m) => m[1])
  check(sessionCodes.length >= 8, `the responder answers ${sessionCodes.length} error codes`)

  // The two halves, declared here and checked against what the panel really answers. A new
  // code in that responder lands in neither list and fails the last check in this group —
  // which is the point: somebody has to decide whether it evicts a television.
  //
  // The second list is NOT "malformed requests". It is everything that is not a judgement
  // on these keys, and it holds three different kinds: a refusal of the REQUEST (a bad
  // call, a lost one-shot challenge, a signature that did not verify), a panel that cannot
  // issue sessions at all, and an operator whose device slots are full. Only the first kind
  // is a bug somewhere; the other two are configuration, and configuration changes.
  const VERDICTS = ['account disabled', 'unknown user']
  const NOT_VERDICTS = [
    'sessions unavailable', //                the PANEL is missing its own signing key
    'device-limit', //                        maxDevices with devicePolicy 'reject' — slots, not keys
    'bad request',
    'no session challenge (login first)',
    'auth failed',
    'missing deviceId'
  ]
  for (const code of VERDICTS) {
    check(sessionCodes.includes(code), `the panel still answers '${code}' (a verdict)`)
    check(terminalSignInError(new Error('session failed: ' + code)) === true, `…and '${code}' erases`)
  }
  for (const code of NOT_VERDICTS) {
    check(sessionCodes.includes(code), `the panel still answers '${code}' (not a verdict)`)
    check(terminalSignInError(new Error('session failed: ' + code)) === false, `…and '${code}' keeps`)
  }
  const unclassified = sessionCodes.filter((c) => !VERDICTS.includes(c) && !NOT_VERDICTS.includes(c))
  check(unclassified.length === 0, 'every code the session responder can answer is classified — unclassified: ' + JSON.stringify(unclassified))
  // 'device-limit' is the one entry here that is unreachable on anything this repo ships:
  // rpc.js takes devicePolicy as a parameter defaulting to 'evict' and index.js never passes
  // it. Pinned, because the classification above is written for the operator who DOES set
  // it, and because a default that silently became 'reject' would change what a household's
  // spare phone can do to a television.
  check(/devicePolicy = 'evict'/.test(rpc), "rpc.js still defaults devicePolicy to 'evict'")
  check(!/devicePolicy/.test(read('panel/src/index.js')), 'panel/src/index.js still never passes devicePolicy')

  console.log('coupling — sdk/login.js prose')
  const loginSrc = read('sdk/login.js')
  // The prefix the predicate splits on, and the length guard its regex matches, are both
  // composed at runtime — so assert the pieces still exist rather than a whole message.
  check(loginSrc.includes("throw new Error('session failed: ' + sres.error)"), "login.js still composes 'session failed: ' + the panel's code")
  check(loginSrc.includes("' must be ' + len + ' bytes (hex or buffer)'"), 'login.js still writes the key-length guard this predicate matches')
  // Every message login.js throws as a FIXED string, and what each one means for a stored
  // sign-in. Rewording any of them, or adding one, fails the reconciliation below.
  const LOGIN_PROSE = {
    'unknown user': false, //                                       the LOCAL replica has not caught up
    'invalid credentials': false, //                                password path only; never reaches a resume
    'key recovery failed': false, //                                password path only
    'the panel issued no session challenge — it is too old for a key handover': false,
    'key handover does not match this account': true, //            a password rotation, seen from here
    'the panel issued no session token — the key handover did not sign this device in': true,
    'panel returned an invalid session token': true
  }
  const thrown = [...loginSrc.matchAll(/throw new Error\('([^']+)'\)/g)].map((m) => m[1])
  for (const m of thrown) {
    check(Object.prototype.hasOwnProperty.call(LOGIN_PROSE, m), `login.js's "${m}" is classified`)
    check(terminalSignInError(new Error(m)) === LOGIN_PROSE[m], `…and is ${LOGIN_PROSE[m] ? 'ERASE' : 'KEEP'}`)
  }
  const missing = Object.keys(LOGIN_PROSE).filter((m) => !thrown.includes(m))
  check(missing.length === 0, 'every classified message is one login.js still throws — stale: ' + JSON.stringify(missing))

  // --- COUPLED TO THE PROSE THAT TELLS SOMEBODY ELSE WHAT TO DO -------------------------
  // Everything above binds the classification to the code that PRODUCES these messages.
  // Nothing above bound it to the documents that tell an embedder what to DO with them —
  // and sdk/index.d.ts spent a long time listing 'session failed: device-limit' among the
  // rejections that must erase, which is the opposite of what signin-vault.mjs has always
  // done. An SDK consumer who followed the type definitions destroyed a viewer's account
  // keys over an operator's full device slots.
  //
  // Prose cannot be parsed, so it is not parsed. Each surface carries ONE table in a fixed
  // machine-readable form between two markers, this file GENERATES that table from the
  // authorities it already reads, and the copies are compared line by line and in order.
  // A missing block, a line that does not parse, a message the table has lost, a message
  // it has grown, or a verdict that disagrees with the predicate all fail — and a surface
  // that quietly stops carrying a block fails loudest of all, because that is the shape of
  // the failure this whole file exists to prevent.
  //
  // Outside the block, a document may NAME a message. It may not decide anything about one:
  // a line that holds a message AND a word like "erase" or "keep" is a second opinion, and
  // the whole point is that there is one. That check is deliberately blind to what the
  // sentence actually says — it never has to be right about English, only about whether a
  // claim is being made somewhere it should not be.
  console.log('coupling — the erase/keep table an embedder reads')
  const MARK_BEGIN = 'signin-verdicts: BEGIN'
  const MARK_END = 'signin-verdicts: END'
  const CLAIM = /\b(eras\w*|evict\w*|destroy\w*|destruct\w*|discard\w*|delet\w*|wipe[sd]?|keep\w*|kept|retain\w*)\b/i
  const SURFACES = ['sdk/index.d.ts', 'docs/sdk-guide.md', 'docs/security-model.md']

  // The table itself: every message the panel's `session` responder and sdk/login.js can
  // produce — both read off the disk above, neither typed here — plus one instance of the
  // length guard login.js composes at runtime. The verdict column is the predicate's own
  // answer, so the table cannot be stale with respect to the code it documents.
  const verdictOf = (message) => (terminalSignInError(new Error(message)) ? 'ERASE' : 'KEEP')
  const documented = [
    ...sessionCodes.map((c) => 'session failed: ' + c),
    ...Object.keys(LOGIN_PROSE),
    'authPriv must be 64 bytes (hex or buffer)'
  ]
  const rows = new Map()
  for (const message of documented) rows.set(message, { message, verdict: verdictOf(message) })
  // ERASE first, then KEEP, each in plain byte order — a total order that does not move
  // when panel/src/rpc.js reorders its own answers, so the three copies stay diffable.
  const TABLE = [...rows.values()].sort((a, b) =>
    a.verdict !== b.verdict ? (a.verdict === 'ERASE' ? -1 : 1) : a.message < b.message ? -1 : a.message > b.message ? 1 : 0)
  const renderRow = (r) => r.verdict.padEnd(5) + '  ' + r.message
  const CANONICAL = TABLE.map(renderRow).join('\n')
  // A message that collided with another would leave one of them undocumented and nothing
  // downstream would notice: the copies would agree with a table that had lost a row.
  check(TABLE.length === documented.length,
    `the table carries all ${documented.length} messages — ${sessionCodes.length} the panel answers, ` +
    `${Object.keys(LOGIN_PROSE).length} login.js throws, and the length guard it composes`)

  /** Everything wrong with one surface, as a list of sentences. Empty means it agrees. */
  function verdictProblems (name, text, table) {
    const out = []
    const lines = text.split(/\r?\n/)
    const begin = lines.findIndex((l) => l.includes(MARK_BEGIN))
    const end = lines.findIndex((l, i) => i > begin && l.includes(MARK_END))
    if (begin < 0 || end < 0 || end <= begin) {
      out.push(`${name} carries no '${MARK_BEGIN}' … '${MARK_END}' block — there is nothing to check, which is the failure`)
      return out
    }
    if (lines.slice(begin + 1).some((l) => l.includes(MARK_BEGIN))) out.push(`${name} opens a second verdict block`)

    // The block. Comment furniture and code fences are stripped; ANY other line has to be
    // a verdict line, so a sentence smuggled in beside the table is a failure and not a
    // line the parser skips.
    const body = []
    for (let i = begin + 1; i < end; i++) {
      const raw = lines[i].replace(/^\s*\*/, '').trim()
      if (raw === '' || raw.startsWith('```')) continue
      const m = /^(ERASE|KEEP)\s+(\S.*?)\s*$/.exec(raw)
      if (!m) { out.push(`${name}:${i + 1}: not a verdict line: ${JSON.stringify(raw)}`); continue }
      body.push({ verdict: m[1], message: m[2], line: i + 1 })
    }
    for (let i = 0; i < Math.max(body.length, table.length); i++) {
      const got = body[i]
      const want = table[i]
      if (!got) { out.push(`${name} has lost a row: ${renderRow(want)}`) } else if (!want) {
        out.push(`${name}:${got.line}: "${got.message}" is not a message this classification knows`)
      } else if (got.message !== want.message) {
        out.push(`${name}:${got.line}: expected ${JSON.stringify(want.message)}, found ${JSON.stringify(got.message)}`)
      } else if (got.verdict !== want.verdict) {
        out.push(`${name}:${got.line}: says ${got.verdict} for "${got.message}" — client/backend/signin-vault.mjs says ${want.verdict}`)
      }
    }

    // …and nothing outside it decides anything. Naming a message is fine; naming one on a
    // line that also erases, evicts, keeps or destroys is a second copy of the rule.
    const terms = [...new Set([...table.map((r) => r.message), ...sessionCodes])].sort((a, b) => b.length - a.length)
    for (let i = 0; i < lines.length; i++) {
      if (i >= begin && i <= end) continue
      const hit = terms.find((t) => lines[i].includes(t))
      if (hit && CLAIM.test(lines[i])) {
        out.push(`${name}:${i + 1}: "${hit}" on a line that decides its fate — only the table decides: ${lines[i].trim()}`)
      }
    }
    return out
  }

  for (const surface of SURFACES) {
    const problems = verdictProblems(surface, read(surface), TABLE)
    check(problems.length === 0, `${surface} agrees with the predicate` +
      (problems.length ? '\n         ' + problems.join('\n         ') + '\n\n       the table these surfaces must carry:\n\n' + CANONICAL + '\n' : ''))
  }

  // AND THE CHECKER IS PROVED TO STILL BITE. Nothing above fails when verdictProblems()
  // stops matching, and a guard that silently stops matching is worse than no guard: it is
  // exactly how a code went invisible to the regex in the group above when it moved out of
  // a `return json({...})` literal. So the checker is run against surfaces built here, each
  // broken one way, and each one has to be caught.
  console.log('the checker itself — planted contradictions must be caught')
  const fixture = (body) => ['prose above.', MARK_BEGIN, ...body, MARK_END, 'prose below.'].join('\n')
  const good = TABLE.map((r) => '   * ' + renderRow(r))
  check(verdictProblems('fixture', fixture(good), TABLE).length === 0,
    'a surface that agrees raises nothing (so the fixtures below fail for their own reason)')
  const flipped = good.map((l) => (l.includes('device-limit') ? l.replace('KEEP  ', 'ERASE ') : l))
  check(flipped.join() !== good.join() && verdictProblems('fixture', fixture(flipped), TABLE).some((p) => p.includes('device-limit')),
    'a flipped verdict is caught — THE DEFECT THIS GROUP EXISTS FOR')
  check(verdictProblems('fixture', 'prose with no block at all.', TABLE).length > 0,
    'a surface that dropped its block is caught')
  check(verdictProblems('fixture', fixture(good.filter((l) => !l.includes('account disabled'))), TABLE).length > 0,
    'a row quietly deleted from the table is caught')
  check(verdictProblems('fixture', fixture([...good, '   * ERASE  session failed: whatever']), TABLE).length > 0,
    'a row invented in the table is caught')
  check(verdictProblems('fixture', fixture([...good, '   * and device-limit erases, by the way']), TABLE).length > 0,
    'a sentence smuggled into the block is caught')
  check(verdictProblems('fixture', fixture(good) + '\nand a device-limit refusal erases the stored keys.', TABLE).length > 0,
    'a second opinion in the prose OUTSIDE the block is caught')
  check(verdictProblems('fixture', fixture(good) + '\nthe panel answers device-limit when the slots are full.', TABLE).length === 0,
    '…while prose that only NAMES a code is left alone')

  // --- WHAT A BOOT MAY SPEND AT THE PANEL -----------------------------------------------
  // The other currency of a retry, and the one nothing was counting. A KEPT sign-in is
  // retried, every keep above buys another retry, and a retry that reaches the panel costs
  // a `login` the panel's throttle counts — so the classification group above is only safe
  // while the loop that acts on it is bounded in LOGINS rather than in seconds. It was not:
  // the restore door's budget was 45 s of wall clock, which admits two attempts when each
  // dials for 25 s and nineteen when each comes back fast. Six resumes × three logins = 18,
  // against a threshold of 10, and the television locked out its own account.
  //
  // Nothing here can run the screen (client/__tests__/SplashDoors.test.tsx does that). What
  // it pins is the arithmetic between four files that have no other connection.
  console.log('coupling — the login budget of one boot')
  const cfg = read('panel/src/config.js')
  const threshold = Number((cfg.match(/int\(process\.env\.LOCKOUT_THRESHOLD,\s*(\d+)\)/) || [])[1])
  const lockoutSec = Number((cfg.match(/int\(process\.env\.LOCKOUT_SECONDS,\s*(\d+)\)/) || [])[1])
  check(Number.isInteger(threshold) && threshold > 0, `panel/src/config.js LOCKOUT_THRESHOLD defaults to ${threshold}`)
  check(Number.isInteger(lockoutSec) && lockoutSec > 0, `…for LOCKOUT_SECONDS ${lockoutSec}`)
  // Counted on EVERY attempt, not only failed ones — which is the fact the old comment in
  // backend.mjs got wrong by omission and the reason the ceiling has to be so conservative.
  const loginBody = rpc.slice(rpc.indexOf("rpc.respond('login'"), rpc.indexOf("rpc.respond('session'"))
  check(/const t = throttle\(\(username \|\| ''\) \+ '\|' \+ peerHex\)/.test(loginBody),
    'the login responder still throttles on (username|peer), before it knows if the attempt is good')

  const worklet = read('client/backend/backend.mjs')
  const perResume = Number((worklet.match(/const RESUME_RECORD_TRIES = (\d+)/) || [])[1])
  check(Number.isInteger(perResume) && perResume > 0, `one resume may spend ${perResume} logins (RESUME_RECORD_TRIES)`)
  // The screen's rule is "an attempt that reached the panel ends this door", so a boot's
  // whole restore-door spend is one resume's worth. Held to a third of the panel's
  // tolerance rather than to the whole of it: the password door's fall-through runs on the
  // same socket in the same window, and a viewer who then types at the sign-in screen needs
  // attempts left after both.
  check(perResume * 3 <= threshold,
    `the restore door's ceiling (${perResume}) is a third of the panel's threshold (${threshold}) or better`)

  // …and that the rule is the one actually written. A revert to a pure deadline puts the
  // door back where it was, and both halves of the mechanism have to be present for it to
  // work: the worklet has to report the cost, and the screen has to gate on it.
  check(/logins: cost\.logins/.test(worklet), 'the worklet reports what a resume cost')
  check(/if \(NOT_CONNECTED\.test\(message\) && purges === storePurges\) cost\.logins--/.test(worklet),
    '…refunds the one error that proves no RPC left the device — and not when a store purge re-ran the call')
  check(/storePurges\+\+/.test(worklet), '…which needs the engine\'s recovery to be counted at all')
  const splash = read('client/src/screens/SplashScreen.tsx')
  check(/restoreLogins\.current \+= typeof res\.logins === 'number' \? res\.logins : 1/.test(splash),
    'the screen charges what the worklet reported, and charges an ABSENT cost as a paid one')
  check(/res\.retry && restoreLogins\.current === 0 && Date\.now\(\) < restoreUntil\.current/.test(splash),
    '…and retries only while this door has reached the panel not at all')
  // The absent cost is not hypothetical: it is what the binding sends when nothing came back
  // while the worklet may still be inside signInWithKeys().
  const binding = read('sdk/react-native/src/backend.ts')
  const timeoutLine = (binding.match(/if \(!m \|\| m\.type !== 'signin-resumed'\) return \{[^}]*\}/) || [''])[0]
  check(/error: 'timeout'/.test(timeoutLine) && !/logins/.test(timeoutLine),
    'the binding still answers a timeout with NO cost on it — absent, not zero')

  console.log(`\nPASS — ${passed} checks`)
  process.exit(0)
} catch (err) {
  console.log('\nFAIL:', err && err.message)
  process.exit(1)
}
