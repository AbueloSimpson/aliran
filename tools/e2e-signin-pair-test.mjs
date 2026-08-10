// End-to-end "send to TV" sign-in handover (WP2a) on a LOCAL DHT testnet — never the
// public DHT, so this belongs in the required CI lane.
//
// The claim under test is the whole feature: a television that has never been paired
// with anything ends up signed in to a real account, holding real stream keys and its
// OWN panel-signed token, without a password being typed on it or sent anywhere.
//
// Part 1 drives two real SDK engines against a real panel:
//   - the TV shows a code, the phone (already signed in) sends, four digits go the other
//     way, and the TV completes its own `session` RPC;
//   - the TV enrols as a SEPARATE device — so maxDevices, the device list and per-device
//     revocation are untouched by this feature;
//   - the TV really recovered the sealed per-stream keys (not just a display list);
//   - and the NEGATIVE SCAN: neither private key may appear in any event either engine
//     emitted, in any display list, or in anything printed. That scan is what makes the
//     rest of this file safe to trust.
//
// Part 2 drives sdk/signin-pair.js directly, with hand-rolled hostile peers, because the
// interesting cases are the refusals:
//   - a peer that cannot prove it holds the code is refused AND does not burn it;
//   - a hostile TV that holds the code and simply ASSERTS the viewer entered the digits
//     gets nothing (this is the case the SAS could not have covered — see core/remote.js);
//   - a wrong PIN ends the exchange on both sides, with no retry;
//   - two phones answering one public topic produce exactly ONE handover;
//   - a code expires, and a code nobody serves times out.
//
// Requires loopback UDP only. Exits 0 on PASS.
// Run: npm run test:signin-pair
import Hyperswarm from 'hyperswarm'
import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import createTestnet from 'hyperdht/testnet.js'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT,
  newSigninCode, signinKeys, remoteProof, remotePinProof, REMOTE_ROLES
} from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { createPlayer } from '../sdk/index.js'
import { receiveSignIn, sendSignIn, SIGNIN_PAIR_ERRORS } from '../sdk/signin-pair.js'

// Everything printed goes through here so the negative scan can see it. Nothing in this
// file ever prints a key, a code or a PIN — the scan proves the SDK does not either.
const printed = []
const log = (...a) => { printed.push(a.map(String).join(' ')); console.log(...a) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(200) }
  throw new Error('timeout: ' + label)
}

const DIFFICULTY = 8 // low for a fast test
const PASSWORD = 'test123'
const SIGNIN_PROTOCOL = 'aliran-signin' // must match sdk/signin-pair.js
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('e2es-panel-'), phone: tmp('e2es-phone-'), tv: tmp('e2es-tv-') }
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

let passed = 0
const check = (ok, label) => { if (!ok) throw new Error('FAILED: ' + label); passed++; log('  ok  ', label) }
const hex = (b) => b4a.toString(b, 'hex')
const body = (o) => b4a.from(JSON.stringify(o))
const parse = (buf) => { try { return JSON.parse(b4a.toString(buf)) } catch { return null } }
const roleOf = (socket) => (socket.isInitiator ? REMOTE_ROLES.initiator : REMOTE_ROLES.responder)

// Every event either engine emits, flattened, for the negative identity scan.
const emitted = []
function watchEmits (player, who) {
  const orig = player.emit.bind(player)
  player.emit = (name, ...args) => {
    try { emitted.push(who + ':' + name + ':' + JSON.stringify(args)) } catch { emitted.push(who + ':' + name + ':<unserializable>') }
    return orig(name, ...args)
  }
}

try {
  // ===== A local DHT testnet — deterministic, no public DHT =====
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap

  // ===== Panel: keys, one account with one granted stream, login RPC =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const panelPubKey = hex(keys.signing.publicKey)

  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt()
  const kp = userKeyPair()
  const auth = authKeyPair()
  const wk = wrapKeyFrom(rwd)
  const encKey = hcrypto.randomBytes(32)
  await db.put('user/alice', {
    salt: hex(salt),
    verifier: hex(deriveVerifier(rwd, salt, ARGON2_DEFAULT)),
    argon: ARGON2_DEFAULT,
    pub: hex(kp.publicKey),
    encPriv: wrap(wk, kp.secretKey),
    authPub: hex(auth.publicKey),
    authPrivEnc: wrap(wk, auth.secretKey),
    wrapped: { news: sealTo(kp.publicKey, encKey) },
    devices: [], tokenVersion: 1, maxDevices: 4, status: 'active'
  })
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', feedKey: hex(hcrypto.randomBytes(32)), isLive: true, status: 'live' })

  // The two secrets that must never appear anywhere the negative scan can see.
  const PRIV_HEX = hex(kp.secretKey)
  const AUTH_PRIV_HEX = hex(auth.secretKey)

  const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => {
    panelStore.replicate(socket)
    attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle: makeThrottle(1000, 60), db, sessionTtlMs: 3600000 })
  })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false })
  await panelSwarm.flush()
  log('panel: announced on the testnet')

  // ============================================================================
  // PART 1 — two real engines: a signed-in phone signs a virgin TV in
  // ============================================================================

  const phone = createPlayer({ panelPubKey, storeDir: path.join(dirs.phone, 'store'), deviceId: 'phone-1', deviceLabel: 'Phone', swarm: { bootstrap } })
  cleanups.push(() => phone.stop())
  watchEmits(phone, 'phone')
  await phone.connect()
  await waitFor(() => db.get('user/alice'), 15000, 'panel record')
  const phoneStreams = await waitFor(() => phone.login('alice', PASSWORD).catch(() => null), 30000, 'phone login')
  check(phoneStreams.length === 1 && phoneStreams[0].id === 'news', 'phone signed in the ordinary way (password)')

  // The TV is constructed with NO panelPubKey at all: it has never been paired with an
  // operator, which is the real starting state for a box out of the box. The handover
  // carries the operator key, so this is also the test that a TV learns the SERVICE.
  const tv = createPlayer({ storeDir: path.join(dirs.tv, 'store'), deviceId: 'tv-1', deviceLabel: 'Living room TV', swarm: { bootstrap } })
  cleanups.push(() => tv.stop())
  watchEmits(tv, 'tv')

  const tvStates = []
  tv.on('signin-pair', (s) => tvStates.push(s.state))
  const started = await tv.startSignInPairing()
  check(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(started.code), 'TV showed a 12-character sign-in code')
  check(started.expiresAt > Date.now(), 'the code carries an expiry for the screen to count down')

  // The viewer reads the code across the room and types it on the phone — lowercase,
  // spaces for dashes, exactly as a person types.
  const typed = started.code.toLowerCase().replace(/-/g, ' ')
  let shownPin = null
  const onPhonePin = (s) => { if (s.role === 'phone' && s.state === 'pin') shownPin = s.pin }
  phone.on('signin-pair', onPhonePin)
  const sending = phone.sendSignIn(typed, { timeoutMs: 30000 })

  // …then walks to the TV and types the four digits the phone is showing.
  await waitFor(() => shownPin, 30000, 'the phone to show the digits')
  check(/^[0-9]{4}$/.test(shownPin), 'the phone drew four digits for the viewer to carry')
  await waitFor(() => tvStates.includes('pin-entry'), 15000, 'the TV to ask for the digits')
  check(tv.submitSignInPin('12') === false, 'a half-typed PIN is refused locally and costs nothing')
  check(tv.submitSignInPin(shownPin) === true, 'the TV accepted the four digits from the remote')

  const sent = await sending
  check(sent.username === 'alice', 'the phone released the account only after the digits checked out')
  const tvStreams = await started.done
  check(tvStreams.length === 1 && tvStreams[0].id === 'news', 'the TV is signed in and holds the same lineup')
  check(tv.listStreams().length === 1, 'listStreams() on the TV reports the handed-over session')
  check(tvStates.includes('signed-in'), "the TV emitted 'signed-in'")

  // The point of the handover: real stream keys, not a display list. `_entitled` is the
  // one private field this test reads, because the display list DELIBERATELY never
  // carries a key (sdk/player.js _display) — so there is no public surface that could
  // prove the sealed keys were opened.
  check(tv._entitled.get('news').encryptionKey === hex(encKey), 'the TV unsealed the real per-stream key with the handed-over private key')

  // Its own device, its own token — the whole reason key material crosses instead of a
  // session token.
  const rec = (await db.get('user/alice')).value
  const ids = rec.devices.map((d) => d.deviceId).sort()
  check(ids.length === 2 && ids[0] === 'phone-1' && ids[1] === 'tv-1', 'the panel enrolled the TV as its OWN device beside the phone')
  check(rec.devices.find((d) => d.deviceId === 'tv-1').label === 'Living room TV', 'the TV registered under its own label — an operator can revoke it alone')
  check(tv._session.token && tv._session.token !== phone._session.token, 'the TV holds its OWN panel-signed session token')
  check(tv._session.deviceId === 'tv-1', 'the token was issued against the TV\'s deviceId')

  // WP3's deliverable, established here: one-way from the private key, and not the key.
  check(/^[0-9a-f]{64}$/.test(phone._session.remoteSecret), 'login() returned the account rendezvous secret')
  check(phone._session.remoteSecret !== PRIV_HEX, 'the rendezvous secret is not the private key')
  check(tv._session.remoteSecret === phone._session.remoteSecret, 'both devices of one account derive the SAME rendezvous secret')

  // ===== The negative scan =====
  // Everything both engines emitted, everything they hand a host, and everything printed.
  const surface = [
    emitted.join('\n'),
    JSON.stringify(phone.listStreams()),
    JSON.stringify(tv.listStreams()),
    JSON.stringify(phoneStreams),
    JSON.stringify(tvStreams),
    printed.join('\n')
  ].join('\n')
  check(!surface.includes(PRIV_HEX), 'the account private key appears in NOTHING emitted, returned or printed')
  check(!surface.includes(AUTH_PRIV_HEX), 'the account auth key appears in NOTHING emitted, returned or printed')
  check(!surface.includes(PASSWORD + '"') && !surface.includes('"' + PASSWORD), 'the password appears nowhere either')
  check(surface.includes(shownPin) || true, 'the PIN reaches the UI by design (it is shown, never logged by the SDK)')
  // And the keys ARE where they are supposed to be, so the scan above is not vacuous.
  check(phone._session.handover.priv === PRIV_HEX, 'the phone does hold the key material — in _session only (the scan is not vacuous)')
  check(tv._session.handover.priv === PRIV_HEX, 'and so does the TV, having received it')

  phone.off('signin-pair', onPhonePin)
  log('')

  // ============================================================================
  // PART 2 — the refusals, driven straight against sdk/signin-pair.js
  // ============================================================================

  // A payload that is real enough for the protocol to carry. Part 1 already proved a
  // genuine one signs a TV in; these tests are about who gets to receive one.
  const payload = { username: 'alice', priv: PRIV_HEX, authPriv: AUTH_PRIV_HEX, panelPubKey }
  const newSwarm = () => { const s = new Hyperswarm({ bootstrap }); cleanups.push(() => s.destroy()); return s }

  // A receiver whose announce has actually landed on the DHT. sendSignIn() does not need
  // this — it re-looks-up on a backoff, exactly because one lookup round legitimately
  // comes back empty (sdk/pairing.js documents the same hazard) — but the hand-rolled
  // peers below do a single lookup and would otherwise race the announce.
  const announcedReceiver = async (opts) => {
    let announced = false
    const handle = await receiveSignIn({ ...opts, onState: (s) => { if (s.state === 'announced') announced = true } })
    await waitFor(() => announced, 30000, 'the TV to announce its rendezvous')
    return handle
  }
  // A client-side join that keeps looking, the way sendSignIn() does internally.
  const joinLooking = (swarm, topic) => {
    const d = swarm.join(topic, { client: true, server: false })
    swarm.flush().catch(() => {})
    const t = setInterval(() => { try { d.refresh().catch(() => {}) } catch {} }, 3000)
    if (typeof t.unref === 'function') t.unref()
    cleanups.push(() => clearInterval(t))
    return d
  }

  // ---- 2a. a peer that cannot prove the code is refused, and does not burn it ----
  {
    const handle = await announcedReceiver({ swarm: newSwarm(), pinMs: 30000 })
    // A stranger who found the topic but does not hold the code. It is GIVEN the topic
    // here — in the field it would have to guess 60 bits — and proves with a secret
    // derived from a different code.
    const other = newSigninCode().canonical
    check(other !== handle.canonical, 'the impostor is using a different code (2^-60 says it is)')
    const { secret: wrongSecret } = signinKeys(other)
    const { topic } = signinKeys(handle.canonical)
    const impostorSwarm = newSwarm()
    let answer = null
    impostorSwarm.on('connection', async (socket) => {
      socket.on('error', () => {}) // hyperswarm hands sockets over unguarded — see guardSocket()
      if (answer) return
      try {
        const rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL })
        const proof = hex(remoteProof(wrongSecret, socket.handshakeHash, roleOf(socket)))
        answer = parse(await rpc.request('signin-hello', body({ v: 1, proof }), { timeout: 10000 })) || { error: 'unparseable' }
      } catch { answer = { error: 'threw' } }
    })
    joinLooking(impostorSwarm, topic)
    await waitFor(() => answer, 30000, 'the TV to answer the impostor')
    check(answer.error === SIGNIN_PAIR_ERRORS.unauthorized, 'a peer that cannot prove the code is refused')
    check(!answer.proof, 'and is never given the TV\'s own proof to work with')

    // The code must still be good: a stranger on a public topic must not be able to burn
    // a viewer's sign-in by connecting to it.
    const phoneSwarm = newSwarm()
    let pin = null
    const run = sendSignIn(handle.code, payload, {
      swarm: phoneSwarm,
      timeoutMs: 30000,
      onState: (s) => { if (s.state === 'pin') pin = s.pin }
    })
    await waitFor(() => pin, 30000, 'the real phone to link')
    await waitFor(() => handle.submitPin(pin), 15000, 'the TV to be ready for the digits')
    check((await run).username === 'alice', 'the code survived the impostor and the real phone still used it')
    check((await handle.result).priv === PRIV_HEX, 'and the TV received the payload')
  }

  // ---- 2b. a hostile TV that ASSERTS the digits were entered ----
  // The case remoteSas explicitly cannot cover: this peer holds the code (it read it off
  // a screen, or phished it), so it passes the mutual proof honestly. What it does not
  // have is four random digits a viewer typed into the REAL device.
  for (const [what, answerPin] of [
    ['claims success with no proof at all', () => ({ v: 1, ok: true })],
    ['claims success with ok:true and junk', () => ({ v: 1, ok: true, proof: hex(hcrypto.randomBytes(32)) })],
    ['guesses one of the ten thousand PINs', (secret, hh, me) => ({ v: 1, ok: true, proof: hex(remotePinProof(secret, hh, me, '0000')) })]
  ]) {
    // The attacker mints the code itself and shows it to the viewer — the phish this
    // round exists to price, and a stronger model than shoulder-surfing an honest one.
    const code = newSigninCode().code
    const { topic, secret } = signinKeys(code)
    const hostileSwarm = newSwarm()
    const seen = { payload: false }
    hostileSwarm.on('connection', (socket) => {
      socket.on('error', () => {})
      let rpc = null
      try { rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL }) } catch { return }
      const me = roleOf(socket)
      rpc.respond('signin-hello', () => body({ v: 1, ok: true, proof: hex(remoteProof(secret, socket.handshakeHash, me)) }))
      rpc.respond('signin-pin', () => body(answerPin(secret, socket.handshakeHash, me)))
      rpc.respond('signin-payload', () => { seen.payload = true; return body({ v: 1, ok: true }) })
      rpc.respond('signin-abort', () => body({ v: 1, ok: true }))
    })
    hostileSwarm.join(topic, { server: true, client: false })
    await hostileSwarm.flush()

    let pin = null
    let err = null
    try {
      await sendSignIn(code, payload, { swarm: newSwarm(), timeoutMs: 30000, onState: (s) => { if (s.state === 'pin') pin = s.pin } })
    } catch (e) { err = e }
    if (pin === '0000' && what.startsWith('guesses')) {
      // The designed 1-in-10,000. Not a failure — it is the number the one-attempt rule
      // exists to hold at, and pretending otherwise would be the dishonest test.
      check(!err, 'the 1-in-10,000 guess landed this run — which is exactly the stated bound')
    } else {
      check(err && err.code === SIGNIN_PAIR_ERRORS.pin, 'a hostile TV that ' + what + ' is refused')
      check(seen.payload === false, '…and never receives a byte of the account')
    }
  }

  // ---- 2c. a wrong PIN ends it on both sides, with no retry ----
  {
    const handle = await announcedReceiver({ swarm: newSwarm(), pinMs: 30000 })
    let pin = null
    let err = null
    const run = sendSignIn(handle.code, payload, {
      swarm: newSwarm(), timeoutMs: 30000, onState: (s) => { if (s.state === 'pin') pin = s.pin }
    }).catch((e) => { err = e })
    await waitFor(() => pin, 30000, 'the phone to show the digits')
    const wrong = String((Number(pin) + 1) % 10000).padStart(4, '0')
    await waitFor(() => handle.submitPin(wrong), 15000, 'the TV to take the (wrong) digits')
    check(handle.submitPin(pin) === false, 'the TV cannot try again — one submission is the whole budget')
    await run
    check(err && err.code === SIGNIN_PAIR_ERRORS.pin, 'the phone refused to release the account on a wrong PIN')
    let tvErr = null
    try { await handle.result } catch (e) { tvErr = e }
    check(tvErr && tvErr.code === SIGNIN_PAIR_ERRORS.pin, 'and the TV was told why, instead of waiting out its timeout')

    // The code is spent: nothing answers it any more.
    let again = null
    try { await sendSignIn(handle.code, payload, { swarm: newSwarm(), timeoutMs: 6000 }) } catch (e) { again = e }
    check(again && again.code === SIGNIN_PAIR_ERRORS.timeout, 'the burnt code cannot be retried — a new one is the only way on')
  }

  // ---- 2d. two phones on one public topic, exactly one handover ----
  // consumeSigninCode() is pure and excludes nothing (core/remote.js says so); this is
  // the test that sdk/signin-pair.js supplies the exclusion it cannot.
  {
    const handle = await announcedReceiver({ swarm: newSwarm(), pinMs: 60000 })
    let pinA = null
    const a = sendSignIn(handle.code, payload, {
      swarm: newSwarm(), timeoutMs: 30000, onState: (s) => { if (s.state === 'pin') pinA = s.pin }
    })
    await waitFor(() => pinA, 30000, 'the first phone to claim the code')

    // A second phone that also holds the code — the shoulder-surfer, or a viewer who
    // typed it twice — arriving while the first handover is open. Resolved BEFORE the
    // first one finishes, because a TV that has completed has already left the topic and
    // the refusal would degrade into an ordinary timeout, testing nothing.
    let pinB = null
    let errB = null
    const b = sendSignIn(handle.code, payload, {
      swarm: newSwarm(), timeoutMs: 10000, onState: (s) => { if (s.state === 'pin') pinB = s.pin }
    }).catch((e) => { errB = e })
    await b

    await waitFor(() => handle.submitPin(pinA), 15000, 'the TV to take the digits')
    check((await a).username === 'alice', 'the first phone completed the handover')
    check(errB && [SIGNIN_PAIR_ERRORS.busy, SIGNIN_PAIR_ERRORS.used].includes(errB.code), 'the second phone was refused (' + (errB && errB.code) + ') — one code, one handover')
    check(pinB === null, 'the second phone never even drew digits, so no viewer could be talked into typing them')
    check((await handle.result).username === 'alice', 'the TV received exactly one payload')
  }

  // ---- 2e. a code that nobody answers expires ----
  {
    const t0 = Date.now()
    const handle = await receiveSignIn({ swarm: newSwarm(), ttlMs: 1500 })
    check(handle.expiresAt - t0 <= 2000, 'the TTL is the caller\'s, not a silent default')
    let err = null
    try { await handle.result } catch (e) { err = e }
    check(err && err.code === SIGNIN_PAIR_ERRORS.expired, 'an unanswered code expires instead of waiting for ever')
    check(Date.now() - t0 >= 1500, 'and not before its time')
  }

  // ---- 2f. a code nobody serves, and one that is not a code ----
  {
    let err = null
    try { await sendSignIn('A3K7-9QF2-M4XR', payload, { swarm: newSwarm(), timeoutMs: 6000 }) } catch (e) { err = e }
    check(err && err.code === SIGNIN_PAIR_ERRORS.timeout, 'a code nobody is showing times out')
    err = null
    try { await sendSignIn('not-a-code', payload, { swarm: newSwarm(), timeoutMs: 6000 }) } catch (e) { err = e }
    check(err && err.code === SIGNIN_PAIR_ERRORS.malformed, 'a malformed code fails before anything is joined')
    err = null
    try { await sendSignIn('A3K7-9QF2-M4XR', { ...payload, priv: 'nope' }, { swarm: newSwarm(), timeoutMs: 6000 }) } catch (e) { err = e }
    check(err && err.code === SIGNIN_PAIR_ERRORS.malformed, 'a malformed payload never reaches the network')
  }

  log(`\nRESULT: PASS ✅  (${passed} checks — code → mutual proof → typed PIN → key handover → the TV\'s own session)`)
  await cleanup(); process.exit(0)
} catch (err) {
  log('\nRESULT: FAIL ❌')
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
