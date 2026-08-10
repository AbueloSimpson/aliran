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
//   - a GRINDING relay — the refinement that beat the compared digits in two earlier
//     revisions — gets nothing either: the commit-reveal SAS cannot be precomputed off a
//     raw socket, so the harvest is inert and the code is spent after a single claim (2j);
//   - a peer that reveals a nonce its commitment does not open to is read as a relay, not
//     as a hiccup (2k);
//   - the TV's own ordering gates hold: no PIN round before the comparison round, and no
//     second reveal on one channel (2l);
//   - the comparison round tells a REFUSAL from a SILENCE, because a phone that changed
//     network is not a TV that declined anything (2m);
//   - a peer on another WIRE_VERSION fails closed in both directions, and is legible in the
//     one direction that can be (2n);
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
  newSigninCode, signinKeys, remoteProof, remotePinProof, REMOTE_ROLES,
  remoteNonce, remoteNonceCommit, remoteNonceCommitValid, remoteCommittedSas
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

  // Wire the honest step-3 proof and step-4 COMMIT-REVEAL onto a hand-rolled peer that
  // ANSWERS (a fake TV, or the relay's phone-facing leg): commit a fresh nonce in the hello
  // reply, reveal it in signin-nonce. A hostile peer needs this to reach the rounds after
  // step 4 at all — the real phone will not draw a PIN until it has been shown a SAS, and
  // that needs the reveal. Returns { me, hh, nonce } for the peer's own bookkeeping.
  const respondSas = (rpc, socket, secret) => {
    const me = roleOf(socket)
    const hh = socket.handshakeHash
    const nonce = remoteNonce()
    rpc.respond('signin-hello', () => body({ v: 2, ok: true, proof: hex(remoteProof(secret, hh, me)), commit: hex(remoteNonceCommit(secret, hh, nonce)) }))
    rpc.respond('signin-nonce', (buf) => { parse(buf); return body({ v: 2, ok: true, nonce: hex(nonce) }) })
    return { me, hh, nonce }
  }
  // Run step 3 + step 4 as the CLIENT (the relay's TV-facing leg): prove, then send our
  // nonce and collect the peer's revealed one. Drives the real TV all the way to showing its
  // SAS. Returns { me, hh, myNonce, theirNonce } or null.
  const requestSas = async (rpc, socket, secret) => {
    const me = roleOf(socket)
    const hh = socket.handshakeHash
    const hello = parse(await rpc.request('signin-hello', body({ v: 2, proof: hex(remoteProof(secret, hh, me)) }), { timeout: 15000 }))
    if (!hello || !hello.ok || !hello.commit) return null
    const myNonce = remoteNonce()
    const nres = parse(await rpc.request('signin-nonce', body({ v: 2, nonce: hex(myNonce) }), { timeout: 15000 }))
    if (!nres || !nres.nonce) return null
    return { me, hh, myNonce, theirNonce: b4a.from(nres.nonce, 'hex') }
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
        answer = parse(await rpc.request('signin-hello', body({ v: 2, proof }), { timeout: 10000 })) || { error: 'unparseable' }
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
    ['claims success with no proof at all', () => ({ v: 2, ok: true })],
    ['claims success with ok:true and junk', () => ({ v: 2, ok: true, proof: hex(hcrypto.randomBytes(32)) })],
    ['guesses one of the ten thousand PINs', (secret, hh, me) => ({ v: 2, ok: true, proof: hex(remotePinProof(secret, hh, me, '0000')) })]
  ]) {
    // The attacker mints the code itself and shows it to the viewer — the phish this
    // round exists to price, and a stronger model than shoulder-surfing an honest one. It
    // runs step 4 HONESTLY (one connection, so its committed SAS agrees with the phone's and
    // a truthful viewer confirms) — the compared digits were never what stops it. The typed
    // PIN is.
    const code = newSigninCode().code
    const { topic, secret } = signinKeys(code)
    const hostileSwarm = newSwarm()
    const seen = { payload: false }
    hostileSwarm.on('connection', (socket) => {
      socket.on('error', () => {})
      let rpc = null
      try { rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL }) } catch { return }
      const sas = respondSas(rpc, socket, secret) // step 3 proof + step 4 commit-reveal, played straight
      rpc.respond('signin-pin', () => body(answerPin(secret, sas.hh, sas.me)))
      rpc.respond('signin-payload', () => { seen.payload = true; return body({ v: 2, ok: true }) })
      rpc.respond('signin-abort', () => body({ v: 2, ok: true }))
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

    // Leg B: relay -> the real TV. Claim the code before the phone can (deterministic race)
    // and run step 4 against it — hello, then the nonce round — so the real TV shows digits.
    const legB = newSwarm()
    legB.on('connection', async (socket) => {
      socket.on('error', () => {})
      if (relay.legB) return
      try {
        const rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL })
        const r = await requestSas(rpc, socket, secret)
        if (r) relay.legB = { rpc, ...r }
      } catch {}
    })
    joinLooking(legB, topic)
    await waitFor(() => relay.legB, 30000, 'the relay to claim the real TV and run its SAS round')
    check(handle.st.sas !== null, 'the real TV linked (to the relay) and is showing its digits')
    // The honest caveat, asserted rather than asserted-about: the relay took PART in leg B's
    // commit-reveal, so it knows both nonces and can compute the TV's screen exactly. What it
    // cannot do is make its OTHER leg show the same digits — that leg has a different
    // transcript AND a different pair of nonces, and it committed each before it could line
    // them up (2j drives that point home against a grinding relay, not just this single one).
    const legBsas = relay.legB.me === REMOTE_ROLES.initiator
      ? remoteCommittedSas(secret, relay.legB.hh, relay.legB.myNonce, relay.legB.theirNonce)
      : remoteCommittedSas(secret, relay.legB.hh, relay.legB.theirNonce, relay.legB.myNonce)
    check(legBsas === handle.st.sas, 'the relay can compute the real TV\'s digits (it took part in the round) — the comparison does not depend on secrecy')

    // Leg A: relay -> the real phone, announcing on the same public topic. It plays step 4
    // straight here too, so the phone shows a well-formed SAS — it is just not the TV's,
    // because leg A and leg B are two transcripts with two independent nonce pairs.
    const legA = newSwarm()
    legA.on('connection', (socket) => {
      socket.on('error', () => {})
      let rpc = null
      try { rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL }) } catch { return }
      const sas = respondSas(rpc, socket, secret)
      rpc.respond('signin-pin', async () => {
        relay.pinAsked = true
        const ans = parse(await relay.legB.rpc.request('signin-pin', body({ v: 2 }), { timeout: 120000 }))
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
        return body(recovered ? { v: 2, ok: true, proof: hex(remotePinProof(secret, sas.hh, sas.me, recovered)) } : { v: 2, error: 'pin' })
      })
      rpc.respond('signin-payload', (buf) => { relay.payload = parse(buf).payload; return body({ v: 2, ok: true }) })
      rpc.respond('signin-abort', () => body({ v: 2, ok: true }))
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
  // The cap is the BACKSTOP behind the commit-reveal SAS (2j is the primary defence). A
  // relay that wants to grind the compared digits now has to open a channel and run a full
  // commit-reveal for every candidate — and this counter burns the code once too many
  // channels have opened, on either role. The guard cannot wait for a valid proof (a grind
  // proves on none until it is ready), so it counts every connection that OPENS the
  // aliran-signin channel.
  //
  // SEQUENTIAL, AND EACH ONE CLOSED BEFORE THE NEXT OPENS. That is the shape a relay uses —
  // one connection after another across the whole TTL — and it is the only shape that tests
  // what the cap claims to be. At most ONE of these connections is alive at any instant, so
  // a cap that decremented on close would never trip here and this block would fail. (It
  // cannot decrement: nothing in sdk/signin-pair.js lowers signinConns. This is the test
  // that would notice if that changed. An earlier version of this test held every socket
  // open until after the burn, which a concurrency limit would have passed identically.)
  //
  // What makes this bound real, where an identical cap in an earlier revision bounded
  // nothing: the SAS used to be computable off a raw handshake hash with no channel at all,
  // so a grind never tripped this counter. The commit-reveal (core/remote.js) ties every SAS
  // candidate to an opened channel; 2j is the end-to-end proof that the raw harvest is now
  // inert. This test is the channel-flood half.
  {
    // Mirrors the module-private constant in sdk/signin-pair.js, the way SIGNIN_PROTOCOL
    // above mirrors its. The MAGNITUDE is the half that was untested: `n > 1` passes with a
    // cap of 2, which would refuse an ordinary NAT rebind as a grind.
    const MAX_SIGNIN_CONNECTIONS = 8 // must match sdk/signin-pair.js
    const handle = await announcedReceiver({ swarm: newSwarm(), ttlMs: 120000, pinMs: 120000 })
    let burned = null
    handle.result.then(() => {}, (e) => { burned = e.code })
    const { topic } = signinKeys(handle.canonical)
    const capDht = new DHT({ bootstrap }); cleanups.push(() => capDht.destroy())
    const found = new Set()
    for await (const r of capDht.lookup(topic)) for (const p of r.peers) found.add(hex(p.publicKey))
    const tvKey = b4a.from([...found][0], 'hex')

    // One channel-opening connection, then GONE. Each PROVES NOTHING — it just opens the
    // channel — which is exactly the connection a grind uses and a proof-counter misses.
    const openOne = async () => {
      const s = capDht.connect(tvKey, { keyPair: DHT.keyPair() })
      s.on('error', () => {})
      await new Promise((r) => { if (s.handshakeHash) return r(); s.once('open', r); s.once('error', r) })
      const rpc = new ProtomuxRPC(s, { protocol: SIGNIN_PROTOCOL })
      try { await rpc.fullyOpened() } catch {}
      await sleep(150) // let the TV count the open…
      try { s.destroy() } catch {}
      await sleep(100) // …and let it go away again before the next one arrives
    }

    await openOne()
    check(burned === null, 'a single channel-opening connection leaves the code live — the legit flow uses one')
    for (let i = 1; i < MAX_SIGNIN_CONNECTIONS; i++) await openOne()
    check(burned === null, 'exactly MAX_SIGNIN_CONNECTIONS (' + MAX_SIGNIN_CONNECTIONS + ') opens, one at a time and none overlapping, still leave it live')
    await openOne()
    await waitFor(() => burned, 10000, 'the connection past the cap to burn the code')
    check(burned === SIGNIN_PAIR_ERRORS.flooded, 'and the very next one burns it (flooded) — the cap is total over the code\'s life, not concurrent')

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

  // ---- 2j. THE GRINDING RELAY, defeated by the commit-reveal SAS ----
  // 2g's relay lost its ONE pair of transcripts a 1-in-10,000 chance; a GRINDING relay used
  // to beat even a truthful viewer. Holding the code, it read each leg's SAS straight off the
  // RAW handshake hash — no channel, nothing this feature's cap saw — harvested a pile, drove
  // the phone to a fixed leg-A SAS, kept dialing the TV until a raw leg-B's precomputed SAS
  // matched, and CLAIMED on exactly that socket, so both screens showed the same digits and a
  // TRUTHFUL viewer confirmed. Built and run end to end against the pre-fix revision (the PoC
  // lived under tools/ during development and was deleted). The commit-reveal removes the
  // thing it harvested; this test pins that removal, which is the whole point of the change.
  {
    // (1) The pure (secret, handshake-hash) SAS — the function the harvest called — is gone.
    const core = await import('@aliran/core')
    check(core.remoteSas === undefined, 'the pure (secret, handshake-hash) SAS is gone from core — the harvest has no function left to call')
    check(typeof core.remoteCommittedSas === 'function' && typeof core.remoteNonceCommit === 'function', 'and the nonce-committed SAS replaced it')

    // (2) A relay still harvests raw TV sockets for free — but they are now INERT: a socket
    // that opens no channel gets no nonce out of the TV, so there is no SAS to precompute.
    const tvSw = newSwarm()
    const handle = await announcedReceiver({ swarm: tvSw, ttlMs: 120000, pinMs: 120000 })
    const { secret } = signinKeys(handle.canonical)
    const tvKey = tvSw.keyPair.publicKey
    const grindDht = new DHT({ bootstrap }); cleanups.push(() => grindDht.destroy())
    const rawSocket = async () => {
      const s = grindDht.connect(tvKey, { keyPair: DHT.keyPair() })
      s.on('error', () => {})
      await new Promise((r) => { if (s.handshakeHash) return r(); s.once('open', r); s.once('error', r) })
      return s
    }
    const raw = []
    for (let i = 0; i < 8; i++) raw.push(await rawSocket())
    check(raw.every((s) => s.handshakeHash && s.handshakeHash.length === 64), 'the relay still reads a handshake hash off every raw socket, exactly as before the fix')
    check(handle.st.sas === null, 'but the TV has shown NO digits — a socket that opens no channel yields no nonce, so nothing to harvest')

    // (3) To learn even ONE candidate the relay must open the channel and CLAIM — which runs
    // the commit-reveal and spends the code. It gets exactly one, and only for a counted
    // channel.
    const claimRpc = new ProtomuxRPC(raw[0], { protocol: SIGNIN_PROTOCOL })
    const me0 = roleOf(raw[0])
    const h0 = parse(await claimRpc.request('signin-hello', body({ v: 2, proof: hex(remoteProof(secret, raw[0].handshakeHash, me0)) }), { timeout: 15000 }))
    check(h0 && h0.ok && h0.commit, 'claiming a leg costs a full in-channel round and yields the TV\'s commitment — one candidate')
    const n0 = parse(await claimRpc.request('signin-nonce', body({ v: 2, nonce: hex(remoteNonce()) }), { timeout: 15000 }))
    check(n0 && n0.nonce, 'and its reveal — so the relay learns this one leg\'s SAS, but only after opening a channel the cap counts')
    await waitFor(() => handle.st.sas, 15000, 'the real TV to show its one SAS')

    // (4) A SECOND claim, on another harvested socket, is refused — the code is spent. The
    // relay cannot turn its pile of raw sockets into a pile of SAS candidates: the pool is
    // size one, so there is no colliding pair to find and no way to beat a truthful viewer
    // beyond the flat 1-in-10,000 that 2g already prices.
    const rpc1 = new ProtomuxRPC(raw[1], { protocol: SIGNIN_PROTOCOL })
    const me1 = roleOf(raw[1])
    const h1 = parse(await rpc1.request('signin-hello', body({ v: 2, proof: hex(remoteProof(secret, raw[1].handshakeHash, me1)) }), { timeout: 15000 }))
    check(h1 && h1.error && !h1.commit, 'a second claim is refused (' + (h1 && h1.error) + ') with NO commitment — the harvest cannot grow past one')
    for (const s of raw) { try { s.destroy() } catch {} }
    handle.cancel()
    try { await handle.result } catch {}
  }

  // ---- 2k. a TV that REVEALS A NONCE IT DID NOT COMMIT TO ----
  // The active tamper on the one round that sees a relay, and the branch remoteNonceCommitValid
  // exists for. A peer that could open its commitment to a second nonce could pick its
  // contribution AFTER seeing the phone's, which is exactly the steering the commit-reveal was
  // added to prevent — so the phone treats a reveal that does not verify as a relay sighting
  // ('mismatch'), not as a protocol hiccup. Nothing else in this suite drives that line.
  {
    const code = newSigninCode().code
    const { topic, secret } = signinKeys(code)
    const sw = newSwarm()
    const seen = { payload: false, tamperIsReal: null }
    sw.on('connection', (socket) => {
      socket.on('error', () => {})
      let rpc = null
      try { rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL }) } catch { return }
      const me = roleOf(socket)
      const hh = socket.handshakeHash
      const committed = remoteNonce()
      const revealed = remoteNonce() // a DIFFERENT one — the tamper
      const commit = remoteNonceCommit(secret, hh, committed)
      // Establish that the tamper is a real one BEFORE asking the phone to catch it: a pass
      // below must not be able to come from the commitment happening to open to both.
      seen.tamperIsReal = remoteNonceCommitValid(secret, hh, revealed, commit) === false
      rpc.respond('signin-hello', () => body({ v: 2, ok: true, proof: hex(remoteProof(secret, hh, me)), commit: hex(commit) }))
      rpc.respond('signin-nonce', () => body({ v: 2, ok: true, nonce: hex(revealed) }))
      rpc.respond('signin-pin', () => body({ v: 2, ok: true }))
      rpc.respond('signin-payload', () => { seen.payload = true; return body({ v: 2, ok: true }) })
      rpc.respond('signin-abort', () => body({ v: 2, ok: true }))
    })
    sw.join(topic, { server: true, client: false })
    await sw.flush()

    const p = await phoneSender(code, { swarm: newSwarm(), timeoutMs: 30000 })
    let err = null
    try { await p.result } catch (e) { err = e }
    check(seen.tamperIsReal === true, 'the revealed nonce genuinely does not open the commitment — the tamper is real')
    check(err && err.code === SIGNIN_PAIR_ERRORS.mismatch, "a reveal that does not open its commitment is reported as 'mismatch' — the relay wording, not a retry")
    check(p.st.sas === null, 'and no digits were ever shown, so no viewer could confirm a comparison that never ran')
    check(seen.payload === false, 'and not a byte of the account was released')
  }

  // ---- 2l. the TV's ORDERING gates: no PIN before the comparison, no second reveal ----
  // Two refusals the TV owns, both of which a relay would want and neither of which anything
  // else here drives. The second is advertised as a feature — one nonce pair per channel is
  // what makes every extra SAS candidate cost a fresh, counted channel — so it is worth a
  // test rather than a comment.
  {
    const handle = await announcedReceiver({ swarm: newSwarm(), ttlMs: 120000, pinMs: 120000 })
    const { topic, secret } = signinKeys(handle.canonical)
    const sw = newSwarm()
    const out = { hello: null, earlyPin: null, nonce1: null, nonce2: null }
    let ran = false
    sw.on('connection', async (socket) => {
      socket.on('error', () => {})
      if (ran) return
      ran = true
      try {
        const rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL })
        const me = roleOf(socket)
        const hh = socket.handshakeHash
        out.hello = parse(await rpc.request('signin-hello', body({ v: 2, proof: hex(remoteProof(secret, hh, me)) }), { timeout: 15000 }))
        // Straight to the PIN round, skipping step 4 entirely — the ordering a peer would
        // want if it had no intention of letting two screens be compared.
        out.earlyPin = parse(await rpc.request('signin-pin', body({ v: 2 }), { timeout: 15000 }))
        out.nonce1 = parse(await rpc.request('signin-nonce', body({ v: 2, nonce: hex(remoteNonce()) }), { timeout: 15000 }))
        // …and a second reveal with a FRESH nonce, which is what a grind for a colliding SAS
        // looks like inside one channel.
        out.nonce2 = parse(await rpc.request('signin-nonce', body({ v: 2, nonce: hex(remoteNonce()) }), { timeout: 15000 }))
      } catch {}
    })
    joinLooking(sw, topic)
    await waitFor(() => out.nonce2, 30000, 'the hand-rolled peer to run its four requests')
    check(out.hello && out.hello.ok && out.hello.commit, 'the peer proved the code and was given the TV\'s commitment')
    check(out.earlyPin && out.earlyPin.error === SIGNIN_PAIR_ERRORS.unauthorized, 'the TV refuses the PIN round before the comparison round has run')
    check(handle.st.pinEntry === false, '…and never asked its own viewer for digits, so none could be typed')
    check(out.nonce1 && out.nonce1.nonce, 'the first reveal is answered')
    check(out.nonce2 && out.nonce2.error === SIGNIN_PAIR_ERRORS.used, 'and a SECOND reveal on the same channel is refused — one nonce pair per channel, so a fresh candidate costs a fresh counted channel')
    handle.cancel()
    try { await handle.result } catch {}
  }

  // ---- 2m. the comparison round: SILENCE is a timeout, a REFUSAL is 'refused' ----
  // The distinction a host UI keys on, and the one this round got wrong: every silence used
  // to be reported as the TV refusing. The realistic silence is not an attacker at all — it
  // is the phone changing network in the ~15 s between the hello (which SPENT the code) and
  // the reveal, and telling that viewer their TV declined a step is both wrong and useless.
  for (const [what, mode, want] of [
    ['answers the comparison round with a refusal', 'error', SIGNIN_PAIR_ERRORS.refused],
    ['goes quiet in the comparison round', 'silent', SIGNIN_PAIR_ERRORS.timeout]
  ]) {
    const code = newSigninCode().code
    const { topic, secret } = signinKeys(code)
    const sw = newSwarm()
    sw.on('connection', (socket) => {
      socket.on('error', () => {})
      let rpc = null
      try { rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL }) } catch { return }
      const me = roleOf(socket)
      const hh = socket.handshakeHash
      const nonce = remoteNonce()
      rpc.respond('signin-hello', () => body({ v: 2, ok: true, proof: hex(remoteProof(secret, hh, me)), commit: hex(remoteNonceCommit(secret, hh, nonce)) }))
      // 'error' answers and declines. 'silent' registers NO responder, so protomux-rpc
      // rejects the request at the RPC layer — the same branch (ask() -> null) that an RPC
      // timeout, a hangup and a destroyed channel land in, and the only one a test can reach
      // without waiting out RPC_MS.
      if (mode === 'error') rpc.respond('signin-nonce', () => body({ v: 2, error: SIGNIN_PAIR_ERRORS.used }))
      rpc.respond('signin-abort', () => body({ v: 2, ok: true }))
    })
    sw.join(topic, { server: true, client: false })
    await sw.flush()

    const p = await phoneSender(code, { swarm: newSwarm(), timeoutMs: 30000 })
    let err = null
    try { await p.result } catch (e) { err = e }
    check(err && err.code === want, 'a TV that ' + what + " is reported as '" + want + "'")
    check(p.st.sas === null, '…with no digits shown either way (' + want + ')')
  }

  // ---- 2n. A PEER ON ANOTHER WIRE VERSION, both directions ----
  // WIRE_VERSION exists because a phone and a TV are routinely on different app versions, and
  // until now nothing tested it: every `v: 1` in this suite was rewritten to `v: 2` when the
  // commit-reveal landed. Both directions fail closed. Only ONE of them can be made legible,
  // and the asymmetry is the point — see WIRE_VERSION in sdk/signin-pair.js.
  {
    // (A) NEWER phone, OLDER TV. The older responder's parser requires its own version, so it
    // discards the newer hello and answers in its own dialect. The phone reads the envelope,
    // sees a `v` that is not ours, and says so — where before it reported a bare timeout that
    // sent the viewer to re-check a code that was never the problem.
    const code = newSigninCode().code
    const { topic } = signinKeys(code)
    const sw = newSwarm()
    let sawHello = false
    sw.on('connection', (socket) => {
      socket.on('error', () => {})
      let rpc = null
      try { rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL }) } catch { return }
      rpc.respond('signin-hello', (buf) => {
        sawHello = true
        const b = parse(buf)
        return body(b && b.v === 1 ? { v: 1, ok: true } : { v: 1, error: 'malformed' })
      })
    })
    sw.join(topic, { server: true, client: false })
    await sw.flush()

    const p = await phoneSender(code, { swarm: newSwarm(), timeoutMs: 10000 })
    let err = null
    try { await p.result } catch (e) { err = e }
    check(sawHello, 'the older TV did receive the newer phone\'s hello — this is a version failure, not a lookup failure')
    check(err && err.code === SIGNIN_PAIR_ERRORS.version, "a phone facing an older TV reports 'version', not the timeout that says nobody answered")
    check(/version/i.test(err.message) && !/both devices are online/.test(err.message), 'and the wording points at the app version rather than the network')
    check(p.st.sas === null, 'nothing linked, so nothing was compared or sent')
  }
  {
    // (B) OLDER phone, NEWER TV. The TV NAMES the mismatch on the wire instead of calling it
    // malformed — which a v1 phone cannot read, and that is the limit being recorded here
    // rather than a fix. What matters for the viewer is the second half: the TV's code is
    // untouched, because a version-mismatched hello never reaches claim(). The real phone
    // still signs in on the same code afterwards.
    const handle = await announcedReceiver({ swarm: newSwarm(), ttlMs: 120000, pinMs: 60000 })
    const { topic, secret } = signinKeys(handle.canonical)
    const sw = newSwarm()
    let answer = null
    sw.on('connection', async (socket) => {
      socket.on('error', () => {})
      if (answer) return
      try {
        const rpc = new ProtomuxRPC(socket, { protocol: SIGNIN_PROTOCOL })
        // A hello whose PROOF is perfectly good and whose version is not — the strongest
        // form of the case, so the refusal cannot be mistaken for the proof failing.
        const req = body({ v: 1, proof: hex(remoteProof(secret, socket.handshakeHash, roleOf(socket))) })
        answer = parse(await rpc.request('signin-hello', req, { timeout: 15000 })) || { error: 'unparseable' }
      } catch { answer = { error: 'threw' } }
    })
    joinLooking(sw, topic)
    await waitFor(() => answer, 30000, 'the TV to answer the older phone')
    check(answer.error === SIGNIN_PAIR_ERRORS.version, "the TV names the wire-version mismatch instead of the generic 'malformed'")
    check(answer.v === 2 && !answer.commit && !answer.proof, 'and hands over nothing with it — no commitment, no proof')
    check(handle.st.sas === null, 'and shows no digits for a peer it could not parse')

    // THE HALF THE VIEWER SEES: the code is still live. An older phone must not be able to
    // burn a code just by being old.
    const p = await phoneSender(handle.code, { swarm: newSwarm(), timeoutMs: 30000 })
    await waitFor(() => p.st.sas, 30000, 'the current-version phone to link on the same code')
    check(p.st.sas === handle.st.sas, 'the version-mismatched peer never spent the code — the real phone links on it')
    check(p.confirmMatch(true) === true, 'the viewer confirms')
    await waitFor(() => p.st.pin, 20000, 'the phone to draw the digits')
    await waitFor(() => handle.submitPin(p.st.pin), 15000, 'the TV to take the digits')
    check((await p.result).username === 'alice', 'and the handover completes normally')
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
