// End-to-end "send to TV" sign-in handover (WP2a) on a LOCAL DHT testnet — never the
// public DHT, so this belongs in the required CI lane.
//
// The claim under test is the whole feature: a television that has never been paired
// with anything ends up signed in to a real account, holding real stream keys and its
// OWN panel-signed token, without a password being typed on it or sent anywhere.
//
// Part 1 drives two real SDK engines against a real panel:
//   - the TV shows a code, the phone (already signed in) sends, the two screens show the
//     same compared digits and the viewer confirms on the phone, four typed digits go the
//     other way, the TV asks whether to join that service, and only then does it complete
//     its own `session` RPC;
//   - the TV enrols as a SEPARATE device — so maxDevices, the device list and per-device
//     revocation are untouched by this feature;
//   - the TV really recovered the sealed per-stream keys (not just a display list);
//   - and the NEGATIVE SCAN: neither private key may appear in any event either engine
//     emitted, in any display list, or in anything either engine printed — the console is
//     hooked for the whole run, so that scan covers the SDK and not just this file.
//
// Part 2 drives sdk/signin-pair.js directly, with hand-rolled hostile peers, because the
// interesting cases are the refusals:
//   - a peer that cannot prove it holds the code is refused AND does not burn it;
//   - a hostile TV that holds the code and simply ASSERTS the viewer entered the digits
//     gets nothing — the case the compared digits CANNOT cover, because that peer
//     terminates one connection and its SAS therefore agrees;
//   - A RELAY between the real phone and the real TV gets nothing — the case the typed
//     digits cannot cover, because that peer holds the code and can invert a 13.3-bit MAC
//     offline. The two tests are a matched pair: each attacker walks through the check
//     the other one fails.
//   - a wrong PIN ends the exchange on both sides, with no retry;
//   - two phones racing for one public topic produce exactly ONE handover;
//   - a code expires, and a code nobody serves times out.
//
// Part 3 is the operator-key gate: a virgin TV that is told "no" adopts nothing.
//
// Requires loopback UDP only. Exits 0 on PASS.
// Run: npm run test:signin-pair
import Hyperswarm from 'hyperswarm'
import ProtomuxRPC from 'protomux-rpc'
import DHT from 'hyperdht'
import hcrypto from 'hypercore-crypto'
import createTestnet from 'hyperdht/testnet.js'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT,
  newSigninCode, signinKeys, remoteProof, remoteSas, remotePinProof, REMOTE_ROLES
} from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { createPlayer } from '../sdk/index.js'
import { receiveSignIn, sendSignIn, SIGNIN_PAIR_ERRORS } from '../sdk/signin-pair.js'

// EVERYTHING printed during this run, whoever printed it. The three console methods are
// hooked for the whole test so the negative scan below covers the SDK and its
// dependencies — not merely this file's own log(), which could only ever prove that the
// TEST does not print keys. (The claim happens to hold either way: the SDK runtime has no
// console.* at all. The point is that the scan now establishes it.)
const printed = []
const realConsole = { log: console.log, warn: console.warn, error: console.error }
const show = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v) ?? String(v) } catch { return String(v) } }
for (const k of Object.keys(realConsole)) {
  console[k] = (...a) => { try { printed.push(a.map(show).join(' ')) } catch {} realConsole[k](...a) }
}
const unhookConsole = () => { for (const k of Object.keys(realConsole)) console[k] = realConsole[k] }
const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(200) }
  throw new Error('timeout: ' + label)
}

const DIFFICULTY = 8 // low for a fast test
const PASSWORD = 'test123'
const SIGNIN_PROTOCOL = 'aliran-signin' // must match sdk/signin-pair.js
const SAS_RE = /^[0-9]{4}$/
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('e2es-panel-'), phone: tmp('e2es-phone-'), tv: tmp('e2es-tv-'), tv2: tmp('e2es-tv2-') }
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  unhookConsole()
}

let passed = 0
const check = (ok, label) => { if (!ok) throw new Error('FAILED: ' + label); passed++; log('  ok  ', label) }
const hex = (b) => b4a.toString(b, 'hex')
const body = (o) => b4a.from(JSON.stringify(o))
const parse = (buf) => { try { return JSON.parse(b4a.toString(buf)) } catch { return null } }
const roleOf = (socket) => (socket.isInitiator ? REMOTE_ROLES.initiator : REMOTE_ROLES.responder)
const otherRole = (r) => (r === REMOTE_ROLES.initiator ? REMOTE_ROLES.responder : REMOTE_ROLES.initiator)

// Every event either engine emits, flattened, for the negative identity scan.
const emitted = []
function watchEmits (player, who) {
  const orig = player.emit.bind(player)
  player.emit = (name, ...args) => {
    try { emitted.push(who + ':' + name + ':' + JSON.stringify(args)) } catch { emitted.push(who + ':' + name + ':<unserializable>') }
    return orig(name, ...args)
  }
}

// Collect a role's 'signin-pair' events off an engine, so a test can both wait on a state
// and read the fields that came with it.
function watchSignin (player, role) {
  const seen = []
  const fn = (s) => { if (s.role === role) seen.push(s) }
  player.on('signin-pair', fn)
  return {
    seen,
    off: () => player.off('signin-pair', fn),
    states: () => seen.map((s) => s.state),
    at: (state) => seen.find((s) => s.state === state) || null
  }
}

try {
  // ===== A local DHT testnet — no public DHT =====
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

  // `remote` is a BUILD switch and it is off by default (sdk/player.js normalizeRemote):
  // a login on a player without it keeps no account key material and no rendezvous
  // secret at all. Both halves of this feature need it, so both engines opt in.
  const phone = createPlayer({ panelPubKey, storeDir: path.join(dirs.phone, 'store'), deviceId: 'phone-1', deviceLabel: 'Phone', swarm: { bootstrap }, remote: { sendToTv: true, control: true } })
  cleanups.push(() => phone.stop())
  watchEmits(phone, 'phone')
  await phone.connect()
  await waitFor(() => db.get('user/alice'), 15000, 'panel record')
  const phoneStreams = await waitFor(() => phone.login('alice', PASSWORD).catch(() => null), 30000, 'phone login')
  check(phoneStreams.length === 1 && phoneStreams[0].id === 'news', 'phone signed in the ordinary way (password)')

  // The default is the interesting half of that switch: a build that never sends must not
  // be holding the account's private keys for the length of a session.
  {
    const plain = createPlayer({ panelPubKey, storeDir: path.join(dirs.phone, 'store-plain'), deviceId: 'phone-plain', swarm: { bootstrap } })
    cleanups.push(() => plain.stop())
    await plain.connect()
    await waitFor(() => plain.login('alice', PASSWORD).catch(() => null), 30000, 'plain login')
    check(!plain._session.handover, 'a player built WITHOUT remote.sendToTv holds no key material after login')
    check(plain._session.remoteSecret == null, 'and no account rendezvous secret either')
    check(!!plain._session.token, '…while still holding an ordinary session (the gate costs nothing else)')
    let gated = null
    try { await plain.sendSignIn('A3K7-9QF2-M4XR') } catch (e) { gated = e }
    check(gated && /remote.*sendToTv/.test(gated.message), 'and sendSignIn() on such a build refuses by name instead of failing obscurely')
    await plain.stop()
  }

  // The TV is constructed with NO panelPubKey at all: it has never been paired with an
  // operator, which is the real starting state for a box out of the box. The handover
  // carries the operator key, so this is also the test that a TV learns the SERVICE —
  // and, since WP2a, that it ASKS before it does.
  const tv = createPlayer({ storeDir: path.join(dirs.tv, 'store'), deviceId: 'tv-1', deviceLabel: 'Living room TV', swarm: { bootstrap }, remote: { sendToTv: true, control: true } })
  cleanups.push(() => tv.stop())
  watchEmits(tv, 'tv')

  const tvSeen = watchSignin(tv, 'tv')
  const started = await tv.startSignInPairing()
  check(CODE_RE.test(started.code), 'TV showed a 12-character sign-in code')
  check(started.expiresAt > Date.now(), 'the code carries an expiry for the screen to count down')

  // A second D-pad press while the first code is still being minted must not produce a
  // second, invisible handover. The guard is synchronous, so this holds even though the
  // two calls are ~70 ms of Argon2id apart.
  let doubled = null
  try { await tv.startSignInPairing() } catch (e) { doubled = e }
  check(doubled && /already showing/.test(doubled.message), 'a second startSignInPairing() is refused, not silently orphaned')

  // The viewer reads the code across the room and types it on the phone — lowercase,
  // spaces for dashes, exactly as a person types.
  const typed = started.code.toLowerCase().replace(/-/g, ' ')
  const phoneSeen = watchSignin(phone, 'phone')
  const sending = await phone.sendSignIn(typed, { timeoutMs: 30000 })

  // ---- CHECK ONE: the viewer compares the two screens ----
  const phoneMatch = await waitFor(() => phoneSeen.at('match'), 30000, 'the phone to show the compared digits')
  const tvMatch = await waitFor(() => tvSeen.at('match'), 15000, 'the TV to show the compared digits')
  check(SAS_RE.test(phoneMatch.sas), 'the phone showed four digits to compare')
  check(tvMatch.sas === phoneMatch.sas, 'both devices derived the SAME digits — one connection, one transcript')
  check(phoneSeen.at('pin') === null, 'and NOTHING moved on before the viewer answered')
  check(phone.confirmSignInMatch(true) === true, 'the viewer confirmed the match on the phone')

  // ---- CHECK TWO: the viewer walks over and types the phone's digits ----
  const phonePin = await waitFor(() => phoneSeen.at('pin'), 30000, 'the phone to show the digits to type')
  check(SAS_RE.test(phonePin.pin), 'the phone drew four digits for the viewer to carry')
  await waitFor(() => tvSeen.at('pin-entry'), 15000, 'the TV to ask for the digits')
  check(tv.submitSignInPin('12') === false, 'a half-typed PIN is refused locally and costs nothing')
  check(tv.submitSignInPin(phonePin.pin) === true, 'the TV accepted the four digits from the remote')

  const sent = await sending.done
  check(sent.username === 'alice', 'the phone released the account only after BOTH checks passed')

  // ---- THE OPERATOR-KEY GATE: a virgin TV asks before it adopts ----
  const ask = await waitFor(() => tvSeen.at('confirm-service'), 15000, 'the TV to ask about the service')
  check(ask.adopting === true, 'a never-paired TV reports that it is ADOPTING an operator key')
  check(ask.panelPubKey === panelPubKey, 'the question names the exact key it is about to trust')
  check(CODE_RE.test(ask.pairingCode), 'and names it as the operator\'s printed pairing code, which a viewer can actually check')
  check(ask.username === 'alice', 'and names the account being signed in')
  check(tv._panelKey === null, 'NOTHING has been adopted while the question is open')
  check(tv.confirmSignInService(true) === true, 'the viewer approved the service')

  const tvStreams = await started.done
  check(tvStreams.length === 1 && tvStreams[0].id === 'news', 'the TV is signed in and holds the same lineup')
  check(tv.listStreams().length === 1, 'listStreams() on the TV reports the handed-over session')
  check(tvSeen.states().includes('signed-in'), "the TV emitted 'signed-in'")

  // The point of the handover: real stream keys, not a display list. `_entitled` is the
  // one private field this test reads, because the display list DELIBERATELY never
  // carries a key (sdk/player.js _display) — so there is no public surface that could
  // prove the sealed keys were opened.
  check(tv._entitled.get('news').encryptionKey === hex(encKey), 'the TV unsealed the real per-stream key with the handed-over private key')

  // Its own device, its own token — the whole reason key material crosses instead of a
  // session token.
  const rec = (await db.get('user/alice')).value
  const ids = rec.devices.map((d) => d.deviceId).sort()
  check(ids.includes('phone-1') && ids.includes('tv-1'), 'the panel enrolled the TV as its OWN device beside the phone')
  check(rec.devices.find((d) => d.deviceId === 'tv-1').label === 'Living room TV', 'the TV registered under its own label — an operator can revoke it alone')
  check(tv._session.token && tv._session.token !== phone._session.token, 'the TV holds its OWN panel-signed session token')
  check(tv._session.deviceId === 'tv-1', 'the token was issued against the TV\'s deviceId')

  // A TV that already belongs to an operator refuses another one OUTRIGHT — before the
  // question is even asked, because there is nothing for a viewer to weigh up: adopting a
  // second operator mid-engine would leave every open replica pointing at the first.
  {
    let cross = null
    try { await tv._applySignIn({ username: 'alice', priv: PRIV_HEX, authPriv: AUTH_PRIV_HEX, panelPubKey: hex(hcrypto.randomBytes(32)) }) } catch (e) { cross = e }
    check(cross && /different service/.test(cross.message), 'a configured TV refuses an account from another service')
    check(tvSeen.seen.filter((s) => s.state === 'confirm-service').length === 1, '…without even asking — the refusal is not a decision the viewer gets wrong')
    check(String(tv._panelKey).toLowerCase() === panelPubKey, 'and its operator key is unchanged')
  }

  // WP3's deliverable, established here: one-way from the private key, and not the key.
  check(/^[0-9a-f]{64}$/.test(phone._session.remoteSecret), 'login() returned the account rendezvous secret (remote.control)')
  check(phone._session.remoteSecret !== PRIV_HEX, 'the rendezvous secret is not the private key')
  check(tv._session.remoteSecret === phone._session.remoteSecret, 'both devices of one account derive the SAME rendezvous secret')

  // ===== The negative scan =====
  // Everything both engines emitted, everything they hand a host, and everything ANY of
  // them printed to the console (hooked at the top of this file).
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
  // The PIN and the SAS are the deliberate exception: they exist to be put on a screen,
  // so they DO reach the host through 'signin-pair'. Assert that positively rather than
  // pretending it is a leak — an SDK that stopped emitting them would be broken, and a
  // check that cannot fail would not notice either way.
  check(surface.includes(phonePin.pin), 'the typed digits DO reach the host (that is what they are for)')
  check(surface.includes(phoneMatch.sas), 'and so do the compared digits')
  check(!printed.join('\n').includes(started.code), 'but neither engine PRINTED the sign-in code')
  // And the keys ARE where they are supposed to be, so the scan above is not vacuous.
  check(phone._session.handover.priv === PRIV_HEX, 'the phone does hold the key material — in _session only (the scan is not vacuous)')
  check(tv._session.handover.priv === PRIV_HEX, 'and so does the TV, having received it')

  phoneSeen.off(); tvSeen.off()
  log('')

  // ============================================================================
  // PART 2 — the refusals, driven straight against sdk/signin-pair.js
  // ============================================================================

  // A payload that is real enough for the protocol to carry. Part 1 already proved a
  // genuine one signs a TV in; these tests are about who gets to receive one.
  const payload = { username: 'alice', priv: PRIV_HEX, authPriv: AUTH_PRIV_HEX, panelPubKey }
  const newSwarm = () => { const s = new Hyperswarm({ bootstrap }); cleanups.push(() => s.destroy()); return s }

  // A receiver whose announce has actually landed on the DHT, with its states captured.
  // sendSignIn() does not need the announce — it re-looks-up on a backoff, exactly
  // because one lookup round legitimately comes back empty (sdk/pairing.js documents the
  // same hazard) — but the hand-rolled peers below do a single lookup and would otherwise
  // race it.
  const announcedReceiver = async (opts) => {
    const st = { announced: false, sas: null, pinEntry: false }
    const handle = await receiveSignIn({
      ...opts,
      onState: (s) => {
        if (s.state === 'announced') st.announced = true
        if (s.state === 'match') st.sas = s.sas
        if (s.state === 'pin-entry') st.pinEntry = true
      }
    })
    await waitFor(() => st.announced, 30000, 'the TV to announce its rendezvous')
    handle.st = st
    return handle
  }
  // A phone whose states are captured the same way.
  const phoneSender = async (code, opts) => {
    const st = { sas: null, pin: null }
    const handle = await sendSignIn(code, payload, {
      ...opts,
      onState: (s) => {
        if (s.state === 'match') st.sas = s.sas
        if (s.state === 'pin') st.pin = s.pin
      }
    })
    handle.st = st
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
    check(handle.st.sas === null, 'and never got the TV as far as showing digits to compare')

    // The code must still be good: a stranger on a public topic must not be able to burn
    // a viewer's sign-in by connecting to it.
    const p = await phoneSender(handle.code, { swarm: newSwarm(), timeoutMs: 30000 })
    await waitFor(() => p.st.sas, 30000, 'the real phone to link')
    check(p.st.sas === handle.st.sas, 'the real phone and the real TV agree on the compared digits')
    check(p.confirmMatch(true) === true, 'the viewer confirms')
    await waitFor(() => p.st.pin, 20000, 'the phone to draw the digits')
    await waitFor(() => handle.submitPin(p.st.pin), 15000, 'the TV to be ready for the digits')
    check((await p.result).username === 'alice', 'the code survived the impostor and the real phone still used it')
    check((await handle.result).priv === PRIV_HEX, 'and the TV received the payload')
  }

  // ---- 2b. a hostile TV that ASSERTS the digits were entered ----
  // The case the COMPARED digits cannot cover: this peer holds the code (it read it off a
  // screen, or phished it) and terminates a single connection, so its SAS agrees with the
  // phone's and an honest viewer confirms the match truthfully. What it does not have is
  // four random digits a viewer typed into a device that is actually in the session. That
  // is the typed PIN, and it is what stops this one. (2g is the mirror image.)
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

    const p = await phoneSender(code, { swarm: newSwarm(), timeoutMs: 30000 })
    await waitFor(() => p.st.sas, 30000, 'the phone to link to the hostile peer')
    check(SAS_RE.test(p.st.sas), 'the phone still shows digits to compare against the attacker\'s own screen')
    // …and the attacker simply displays those digits, because there is one connection and
    // it can compute the SAS as easily as the phone can. So the honest viewer confirms
    // truthfully, the comparison passes, and everything below is what actually stops it.
    p.confirmMatch(true)
    let err = null
    try { await p.result } catch (e) { err = e }
    if (p.st.pin === '0000' && what.startsWith('guesses')) {
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
    const p = await phoneSender(handle.code, { swarm: newSwarm(), timeoutMs: 30000 })
    let err = null
    const run = p.result.catch((e) => { err = e })
    await waitFor(() => p.st.sas, 30000, 'the phone to show the compared digits')
    p.confirmMatch(true)
    await waitFor(() => p.st.pin, 20000, 'the phone to show the digits')
    const wrong = String((Number(p.st.pin) + 1) % 10000).padStart(4, '0')
    await waitFor(() => handle.submitPin(wrong), 15000, 'the TV to take the (wrong) digits')
    check(handle.submitPin(p.st.pin) === false, 'the TV cannot try again — one submission is the whole budget')
    await run
    check(err && err.code === SIGNIN_PAIR_ERRORS.pin, 'the phone refused to release the account on a wrong PIN')
    let tvErr = null
    try { await handle.result } catch (e) { tvErr = e }
    check(tvErr && tvErr.code === SIGNIN_PAIR_ERRORS.pin, 'and the TV was told why, instead of waiting out its timeout')

    // The code is spent: nothing answers it any more.
    let again = null
    const retry = await sendSignIn(handle.code, payload, { swarm: newSwarm(), timeoutMs: 6000 })
    try { await retry.result } catch (e) { again = e }
    check(again && again.code === SIGNIN_PAIR_ERRORS.timeout, 'the burnt code cannot be retried — a new one is the only way on')
  }

  // ---- 2d. two phones RACING for one public topic, exactly one handover ----
  // consumeSigninCode() is pure and excludes nothing (core/remote.js says so); this is
  // the test that sdk/signin-pair.js supplies the exclusion it cannot. Both senders are
  // started and joined BEFORE either has linked, so the TV's read -> consumeSigninCode ->
  // store really does have to be the thing that separates them — an earlier version of
  // this test awaited the first phone's PIN before starting the second, which only ever
  // exercised claim()'s `if (peer) return busy` line.
  {
    const handle = await announcedReceiver({ swarm: newSwarm(), pinMs: 60000 })
    const a = await phoneSender(handle.code, { swarm: newSwarm(), timeoutMs: 20000 })
    const b = await phoneSender(handle.code, { swarm: newSwarm(), timeoutMs: 20000 })
    check(a.st.sas === null && b.st.sas === null, 'both phones are joined and neither has linked yet')
    const errs = new Map()
    const settled = [a, b].map((h) => h.result.then((v) => v, (e) => { errs.set(h, e); return null }))

    const winner = await waitFor(() => (a.st.sas ? a : (b.st.sas ? b : null)), 30000, 'one of the two phones to claim the code')
    const loser = winner === a ? b : a
    check(winner.confirmMatch(true) === true, 'the winning phone gets the viewer\'s confirmation')
    await waitFor(() => winner.st.pin, 20000, 'the winning phone to draw digits')
    await waitFor(() => handle.submitPin(winner.st.pin), 15000, 'the TV to take the digits')
    const [ra, rb] = await Promise.all(settled)
    const won = winner === a ? ra : rb
    check(won && won.username === 'alice', 'exactly one phone completed the handover')
    check(errs.get(loser) && [SIGNIN_PAIR_ERRORS.busy, SIGNIN_PAIR_ERRORS.used].includes(errs.get(loser).code), 'the other was refused (' + (errs.get(loser) && errs.get(loser).code) + ') — one code, one handover')
    check(loser.st.sas === null && loser.st.pin === null, 'the losing phone never drew digits, so no viewer could be talked into typing them')
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
    const nobody = await sendSignIn('A3K7-9QF2-M4XR', payload, { swarm: newSwarm(), timeoutMs: 6000 })
    try { await nobody.result } catch (e) { err = e }
    check(err && err.code === SIGNIN_PAIR_ERRORS.timeout, 'a code nobody is showing times out')
    err = null
    // These two THROW rather than rejecting a handle: nothing was joined, so there is no
    // handle to reject.
    try { await sendSignIn('not-a-code', payload, { swarm: newSwarm(), timeoutMs: 6000 }) } catch (e) { err = e }
    check(err && err.code === SIGNIN_PAIR_ERRORS.malformed, 'a malformed code fails before anything is joined')
    err = null
    try { await sendSignIn('A3K7-9QF2-M4XR', { ...payload, priv: 'nope' }, { swarm: newSwarm(), timeoutMs: 6000 }) } catch (e) { err = e }
    check(err && err.code === SIGNIN_PAIR_ERRORS.malformed, 'a malformed payload never reaches the network')
  }

  // ---- 2g. A RELAY between the real phone and the real TV ----
  // The mirror image of 2b, and the reason the compared digits exist. This peer read the
  // code off the TV screen, so it satisfies every MAC in the exchange: it claims the real
  // TV honestly, announces on the same public topic, and relays. The typed PIN does NOT
  // stop it — the PIN proof is a MAC under a key derived from the code, which this peer
  // holds, so it recovers the four digits the viewer typed into the real TV by trying all
  // ten thousand offline. What stops it is that it terminates TWO Noise connections, so
  // the two screens show different digits and the viewer says no.
  {
    const handle = await announcedReceiver({ swarm: newSwarm(), pinMs: 60000 })
    const { topic, secret } = signinKeys(handle.canonical)
    const relay = { pinAsked: false, payload: null, legB: null }

    // Leg B: relay -> the real TV. Claim the code before the phone can, which makes the
    // race deterministic rather than something the attacker has to win.
    const legB = newSwarm()
    legB.on('connection', async (socket) => {
      socket.on('error', () => {})
      if (relay.legB) return
      try {
        const rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL })
        const me = roleOf(socket)
        const res = parse(await rpc.request('signin-hello', body({ v: 1, proof: hex(remoteProof(secret, socket.handshakeHash, me)) }), { timeout: 15000 }))
        if (res && res.ok) relay.legB = { rpc, me, hh: socket.handshakeHash }
      } catch {}
    })
    joinLooking(legB, topic)
    await waitFor(() => relay.legB, 30000, 'the relay to claim the real TV')
    check(handle.st.sas !== null, 'the real TV linked (to the relay) and is showing its digits')
    // The honest caveat, asserted rather than asserted-about: holding the code, the relay
    // can compute the digits on the TV's screen exactly. What it cannot do is make its
    // OTHER leg produce the same ones — that leg has a different Noise transcript.
    check(remoteSas(secret, relay.legB.hh) === handle.st.sas, 'the relay can compute the real TV\'s digits (it holds the code) — the comparison does not depend on secrecy')

    // Leg A: relay -> the real phone, announcing on the same public topic.
    const legA = newSwarm()
    legA.on('connection', (socket) => {
      socket.on('error', () => {})
      let rpc = null
      try { rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL }) } catch { return }
      const me = roleOf(socket)
      const hh = socket.handshakeHash
      rpc.respond('signin-hello', () => body({ v: 1, ok: true, proof: hex(remoteProof(secret, hh, me)) }))
      rpc.respond('signin-pin', async () => {
        relay.pinAsked = true
        const ans = parse(await relay.legB.rpc.request('signin-pin', body({ v: 1 }), { timeout: 120000 }))
        // The offline oracle: 13.3 bits under a key this peer holds. Dead code on the
        // passing path (the comparison aborts first) and deliberately kept — if the
        // compared digits were ever removed, this is what would start succeeding again.
        let recovered = null
        if (ans && ans.proof) {
          for (let i = 0; i < 10000; i++) {
            const cand = String(i).padStart(4, '0')
            if (hex(remotePinProof(secret, relay.legB.hh, otherRole(relay.legB.me), cand)) === ans.proof) { recovered = cand; break }
          }
        }
        return body(recovered ? { v: 1, ok: true, proof: hex(remotePinProof(secret, hh, me, recovered)) } : { v: 1, error: 'pin' })
      })
      rpc.respond('signin-payload', (buf) => { relay.payload = parse(buf).payload; return body({ v: 1, ok: true }) })
      rpc.respond('signin-abort', () => body({ v: 1, ok: true }))
    })
    legA.join(topic, { server: true, client: false })
    await legA.flush()

    const p = await phoneSender(handle.code, { swarm: newSwarm(), timeoutMs: 30000 })
    await waitFor(() => p.st.sas, 30000, 'the phone to link (to the relay)')
    check(p.st.sas !== null && handle.st.sas !== null, 'both screens are showing digits')

    if (p.st.sas === handle.st.sas) {
      // 1 in 10,000: the relay's two transcripts happened to hash to the same four
      // digits. Stated rather than papered over — it is the bound this check carries,
      // and core/remote.js records it.
      check(true, 'the 1-in-10,000 SAS collision landed this run — which is exactly the stated bound')
    } else {
      // The viewer does the one thing this check asks of them.
      check(p.confirmMatch(false) === true, 'the two screens DISAGREE and the viewer says so on the phone')
      let err = null
      try { await p.result } catch (e) { err = e }
      check(err && err.code === SIGNIN_PAIR_ERRORS.mismatch, "the phone aborts with 'mismatch' — not a generic timeout a UI would tell the viewer to retry")
      check(relay.payload === null, 'THE RELAY NEVER RECEIVES A BYTE OF THE ACCOUNT')
      check(relay.pinAsked === false, 'and never even reaches the PIN round it could have inverted')
      check(handle.st.pinEntry === false, 'the real TV was never asked for digits, so no viewer typed any')
      // The abort goes to the RELAY, which is under no obligation to pass it on — so the
      // real TV learns nothing here and would sit out its own pinMs. That is correct and
      // unavoidable: a relay controls what each leg hears. The viewer, who is holding the
      // phone that just said "these do not match", is the one being told.
      handle.cancel()
      let tvErr = null
      try { await handle.result } catch (e) { tvErr = e }
      check(tvErr && tvErr.code === SIGNIN_PAIR_ERRORS.cancelled, 'and the real TV\'s code is spent either way — one shot, whatever happened')
    }
  }

  // ---- 2h. THE CONNECTION CAP: a code entertains only so many connections ----
  // 2g's relay won its ONE pair of transcripts a 1-in-10,000 chance. A relay that
  // GRINDS opens many connections and proves on NONE until it finds a colliding SAS
  // pair (core/remote.js remoteSas), so the guard cannot wait for a valid proof: it
  // counts every connection that OPENS the aliran-signin channel and burns the code
  // past a small cap. Tested across SEQUENTIAL connections — a relay opens them one
  // after another over the TTL, so a concurrency limit would be no limit at all.
  //
  // KNOWN CEILING, asserted honestly elsewhere and not here: the cap counts channels,
  // and a relay can read the handshake hash off the bare NoiseSecretStream without
  // opening one (verified on a testnet, core/remote.js records it). This test is the
  // channel-flood the cap DOES stop; it is not a claim that the birthday search is
  // closed.
  {
    const handle = await announcedReceiver({ swarm: newSwarm(), ttlMs: 120000, pinMs: 120000 })
    let burned = null
    handle.result.then(() => {}, (e) => { burned = e.code })
    const { topic } = signinKeys(handle.canonical)
    const capDht = new DHT({ bootstrap }); cleanups.push(() => capDht.destroy())
    const found = new Set()
    for await (const r of capDht.lookup(topic)) for (const p of r.peers) found.add(hex(p.publicKey))
    const tvKey = b4a.from([...found][0], 'hex')

    // One channel-opening connection at a time. Each PROVES NOTHING — it just opens the
    // channel — which is exactly the connection a grind uses and a proof-counter misses.
    const held = []
    const openOne = async () => {
      const s = capDht.connect(tvKey, { keyPair: DHT.keyPair() })
      s.on('error', () => {})
      await new Promise((r) => { if (s.handshakeHash) return r(); s.once('open', r); s.once('error', r) })
      const rpc = new ProtomuxRPC(s, { protocol: SIGNIN_PROTOCOL })
      try { await rpc.fullyOpened() } catch {}
      await sleep(150) // let the TV process the open before the next
      held.push(s)
    }

    await openOne()
    check(burned === null, 'a single channel-opening connection leaves the code live — the legit flow uses one')
    let n = 1
    while (n < 16 && !burned) { await openOne(); n++ }
    check(burned === SIGNIN_PAIR_ERRORS.flooded, 'enough SEQUENTIAL channel-opening connections burn the code (flooded)')
    check(n > 1, 'and only after real headroom above the one connection a legitimate pairing needs (burned at n=' + n + ')')
    for (const s of held) { try { s.destroy() } catch {} }

    // The burned code is dead to an honest sender too — a fresh code is the only way on.
    const late = await sendSignIn(handle.code, payload, { swarm: newSwarm(), timeoutMs: 6000 })
    let lateErr = null
    try { await late.result } catch (e) { lateErr = e }
    check(lateErr && lateErr.code === SIGNIN_PAIR_ERRORS.timeout, 'the burned code times out a fresh honest sign-in')
  }

  // ---- 2i. the cap does NOT touch a legitimate single-connection pairing ----
  // The other half of a cap: it must be invisible to the one connection per side the
  // real flow uses. (Part 1 proves this end to end through two engines; this asserts it
  // directly against sdk/signin-pair.js, beside the flood it refuses.)
  {
    const handle = await announcedReceiver({ swarm: newSwarm(), pinMs: 30000 })
    const p = await phoneSender(handle.code, { swarm: newSwarm(), timeoutMs: 30000 })
    await waitFor(() => p.st.sas, 30000, 'the honest phone to link under the cap')
    check(p.st.sas === handle.st.sas, 'one connection each way, one transcript — the digits agree')
    check(p.confirmMatch(true) === true, 'the viewer confirms')
    await waitFor(() => p.st.pin, 20000, 'the phone to draw the digits')
    await waitFor(() => handle.submitPin(p.st.pin), 15000, 'the TV to take the digits')
    check((await p.result).username === 'alice', 'a legitimate single-connection pairing completes with the cap in place')
    check((await handle.result).priv === PRIV_HEX, 'and the TV received the account')
  }

  log('')

  // ============================================================================
  // PART 3 — the operator-key gate: "no" adopts nothing
  // ============================================================================
  {
    const tv2 = createPlayer({ storeDir: path.join(dirs.tv2, 'store'), deviceId: 'tv-2', deviceLabel: 'Bedroom TV', swarm: { bootstrap } })
    cleanups.push(() => tv2.stop())
    const seen = watchSignin(tv2, 'tv')
    const phone2 = watchSignin(phone, 'phone')
    const start2 = await tv2.startSignInPairing()
    const sender = await phone.sendSignIn(start2.code, { timeoutMs: 30000 })
    await waitFor(() => phone2.at('match') && seen.at('match'), 30000, 'the two devices to link')
    check(phone2.at('match').sas === seen.at('match').sas, 'the second TV and the phone agree on the compared digits')
    check(phone.confirmSignInMatch(true) === true, 'the viewer confirms on the phone')
    const pin2 = await waitFor(() => phone2.at('pin'), 30000, 'the phone to draw digits')
    await waitFor(() => tv2.submitSignInPin(pin2.pin), 20000, 'the second TV to take the digits')
    await sender.done

    const ask2 = await waitFor(() => seen.at('confirm-service'), 20000, 'the second TV to ask about the service')
    check(ask2.adopting === true, 'the second TV is also a virgin device')
    check(tv2.confirmSignInService(false) === true, 'the viewer says NO')
    let refused = null
    try { await start2.done } catch (e) { refused = e }
    check(!!refused, 'the sign-in fails')
    check(tv2._panelKey === null, 'and the TV adopted NO operator key — four digits alone can never do that')
    check(tv2._session === null, 'no session was opened')
    check(seen.states().includes('failed'), "the host was told, through a 'failed' state")
    check(!/session failed|unknown user|key recovery/.test(seen.at('failed').message || ''), 'and the message is viewer-facing, not a forwarded internal')
    phone2.off()
    await tv2.stop()
  }

  log(`\nRESULT: PASS ✅  (${passed} checks — code → mutual proof → compared digits → typed PIN → key handover → the TV's own session)`)
  await cleanup(); process.exit(0)
} catch (err) {
  log('\nRESULT: FAIL ❌')
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
