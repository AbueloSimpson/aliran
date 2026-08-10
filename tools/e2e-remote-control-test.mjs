// End-to-end "play on my TV" (WP3) on a LOCAL DHT testnet — never the public DHT, so this
// belongs in the required CI lane.
//
// The claim under test: two devices already signed in to the SAME account find each other
// with no code and no viewer interaction, prove themselves to each other, and one changes
// the other's channel — while a peer that cannot prove the account secret is turned away,
// and a build that did not opt into the feature never joins a topic at all.
//
// Part 1 drives two real SDK engines against a real panel:
//   - the television announces, the controller looks it up, both prove, both list the other;
//   - the topics are the EPOCHED ones — current and previous, and the same two on both;
//   - `play` lands the right stream, and it lands as a COMMAND the host tunes (which is what
//     keeps a parental-gated channel behind its PIN — the engine must not tune it itself);
//   - the television's own resolve() is what publishes `status`, so a viewer zapping with
//     the TV's own remote updates the phone too;
//   - `stop` arrives and the status follows it;
//   - an UNENTITLED streamId is refused against the TELEVISION'S own catalogue;
//   - the take-over switch refuses play AND stop when it is off.
//
// Part 2 drives sdk/remote-control.js with a hand-rolled hostile peer, because the
// interesting cases are the refusals. The peer is given the real TOPIC (which it could
// learn by watching the DHT) but a FORGED secret, so it is exactly the adversary the mutual
// proof exists for:
//   - a forged proof is refused and the channel is closed;
//   - `play` without a hello at all is refused;
//   - so is `play` after a refused hello — a peer cannot talk its way past the latch;
//   - another wire version is named rather than reported as silence;
//   - a malformed streamId never reaches the entitlement map.
//
// Part 3 is the epoch: current + previous joined, one full period of tolerated skew, and —
// the half that makes an epoch worth anything — the aged-out topic actually LEFT on a roll.
//
// Part 4 is the gate and teardown: with `remote.control` off, startRemote() refuses and NO
// topic is ever joined; after stopRemote() no topic, no listener and no peer is left behind,
// and a fresh session on the same engines finds the same peers again.
//
// Requires loopback UDP only. Exits 0 on PASS.
// Run: npm run test:remote-control
import Hyperswarm from 'hyperswarm'
import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import createTestnet from 'hyperdht/testnet.js'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT,
  remoteSecret, remoteTopic, remoteProof, REMOTE_ROLES
} from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { createPlayer } from '../sdk/index.js'
import { startRemoteControl, REMOTE_PROTOCOL, REMOTE_CONTROL_ERRORS } from '../sdk/remote-control.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(100) }
  throw new Error('timeout: ' + label)
}

const DIFFICULTY = 8 // low for a fast test
const PASSWORD = 'test123'
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { panel: tmp('e2erc-panel-'), tv: tmp('e2erc-tv-'), phone: tmp('e2erc-phone-'), plain: tmp('e2erc-plain-') }
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

// Every 'remote' / 'remotes' event an engine emitted, for assertions and for the negative
// scan at the end.
function watchRemote (player, who) {
  const seen = []
  const peers = []
  const onRemote = (s) => seen.push({ who, ...s })
  const onPeers = (list) => peers.push(list)
  player.on('remote', onRemote)
  player.on('remotes', onPeers)
  return {
    seen,
    peers,
    last: (state) => [...seen].reverse().find((s) => s.state === state) || null,
    off: () => { player.off('remote', onRemote); player.off('remotes', onPeers) }
  }
}

try {
  // ===== A local DHT testnet — no public DHT =====
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap

  // ===== Panel: one account, TWO granted redirect channels + one it may NOT watch =====
  // Redirect channels (S23) resolve with no feed open and no swarm join, so resolve() is
  // instant and deterministic here — which is what lets this lane prove the STATUS path
  // through the engine's real resolve() rather than around it.
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const panelPubKey = hex(keys.signing.publicKey)

  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt()
  const kp = userKeyPair()
  const auth = authKeyPair()
  const wk = wrapKeyFrom(rwd)
  const TOKEN_VERSION = 1
  await db.put('user/alice', {
    salt: hex(salt),
    verifier: hex(deriveVerifier(rwd, salt, ARGON2_DEFAULT)),
    argon: ARGON2_DEFAULT,
    pub: hex(kp.publicKey),
    encPriv: wrap(wk, kp.secretKey),
    authPub: hex(auth.publicKey),
    authPrivEnc: wrap(wk, auth.secretKey),
    wrapped: {
      news: sealTo(kp.publicKey, hcrypto.randomBytes(32)),
      sports: sealTo(kp.publicKey, hcrypto.randomBytes(32))
    },
    devices: [], tokenVersion: TOKEN_VERSION, maxDevices: 4, status: 'active'
  })
  await db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', isLive: true, status: 'live', redirect: true, url: 'https://example.invalid/news.m3u8' })
  await db.put('catalog/sports', { title: 'Sports 1', category: ['sport'], type: 'live', isLive: true, status: 'live', redirect: true, url: 'https://example.invalid/sports.m3u8' })
  // In the catalogue, NOT in `wrapped`: the television is not entitled to it.
  await db.put('catalog/movies', { title: 'Movies', category: ['film'], type: 'live', isLive: true, status: 'live', redirect: true, url: 'https://example.invalid/movies.m3u8' })

  // The rendezvous secret this account's devices derive. The test holds the account private
  // key, so it can compute the same value the engines do — that is what makes the topic
  // assertions and the hostile peer below possible.
  const SECRET = hex(remoteSecret(kp.secretKey, TOKEN_VERSION))

  const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => {
    panelStore.replicate(socket)
    attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle: makeThrottle(1000, 60), db, sessionTtlMs: 3600000 })
  })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false })
  await panelSwarm.flush()
  log('panel: announced on the testnet')

  // ============================================================================
  // PART 1 — two real engines on one account
  // ============================================================================

  // `remote.control` is a BUILD switch, off by default: without it a login keeps no
  // rendezvous secret at all (sdk/player.js normalizeRemote). Both halves need it.
  const tv = createPlayer({ panelPubKey, storeDir: path.join(dirs.tv, 'store'), deviceId: 'tv-1', deviceLabel: 'Living Room', platform: 'android', appVersion: '0.6.0', swarm: { bootstrap }, remote: { control: true } })
  const phone = createPlayer({ panelPubKey, storeDir: path.join(dirs.phone, 'store'), deviceId: 'phone-1', deviceLabel: 'Pixel', platform: 'android', appVersion: '0.6.0', swarm: { bootstrap }, remote: { control: true } })
  cleanups.push(() => tv.stop()); cleanups.push(() => phone.stop())
  const tvEvents = watchRemote(tv, 'tv')
  const phoneEvents = watchRemote(phone, 'phone')

  await tv.connect(); await phone.connect()
  await waitFor(() => db.get('user/alice'), 15000, 'panel record')
  const tvStreams = await waitFor(() => tv.login('alice', PASSWORD).catch(() => null), 30000, 'tv login')
  const phoneStreams = await waitFor(() => phone.login('alice', PASSWORD).catch(() => null), 30000, 'phone login')
  check(tvStreams.length === 2 && phoneStreams.length === 2, 'both devices signed in to the same account (2 entitled channels each)')
  check(tv._session.remoteSecret === SECRET, 'the engine derived the SAME rendezvous secret the test computed from the account key')

  const tvStart = await tv.startRemote({ role: 'tv', label: 'Living Room' })
  await tvStart.flushed()
  const phoneStart = await phone.startRemote({ role: 'controller', label: 'Pixel' })
  check(tvStart.topics.length >= 1 && tvStart.topics.length <= 2, 'the television joined the current epoch and (unless it is epoch 0) the previous one')
  check(JSON.stringify(tvStart.topics) === JSON.stringify(phoneStart.topics), 'both devices derived the same rendezvous topics')
  {
    const e = Math.floor(Date.now() / 86400000)
    const want = [hex(remoteTopic(SECRET, e - 1)), hex(remoteTopic(SECRET, e))].sort()
    check(JSON.stringify([...tvStart.topics].sort()) === JSON.stringify(want), 'and those topics are remoteTopic(secret, epoch) for the current DAY and the one before it')
    check(!tvStart.topics.includes(hex(remoteTopic(SECRET))), 'the PERMANENT (un-epoched) topic is never joined')
  }

  const seenTv = await waitFor(() => phone.listRemotes().find((p) => p.deviceId === 'tv-1'), 40000, 'the phone finds the television')
  check(seenTv.label === 'Living Room' && seenTv.role === 'tv' && seenTv.platform === 'android', 'and reads its label, role and platform off the hello')
  const seenPhone = await waitFor(() => tv.listRemotes().find((p) => p.deviceId === 'phone-1'), 20000, 'the television sees the controller too')
  check(seenPhone.role === 'controller', 'and knows which of the two it is talking to')
  check(phoneEvents.peers.length > 0, "the 'remotes' event fired with the list")

  // --- play ---
  // The host is what tunes an accepted play. Wire that here, exactly as a TV app would, and
  // include the parental gate the engine deliberately leaves to the host.
  const tuned = []
  let pinRequired = false
  tv.on('remote', async (s) => {
    if (s.state !== 'play') return
    if (s.restricted && pinRequired) return // a real host challenges here; nothing is tuned
    tuned.push(s.streamId)
    try { await tv.resolve(s.streamId) } catch {}
  })

  const playRes = await phone.remotePlay('tv-1', 'news')
  check(playRes.ok === true, 'the phone asked the television to play "news" and it was accepted')
  await waitFor(() => tuned.includes('news'), 10000, 'the television tunes it')
  const cmd = tvEvents.last('play')
  check(cmd && cmd.streamId === 'news' && cmd.from.deviceId === 'phone-1', 'the television saw the command, with WHICH device sent it')
  check(cmd.restricted === false && cmd.title === 'News 24', 'and the parental flag + title a host needs to gate and label it')
  await waitFor(() => tv.source() && tv.source().streamId === 'news', 10000, 'the television lands on it')
  check(tv.source().streamId === 'news', 'the television is on the right channel')

  // The FIRST status a controller ever gets is the one-off sync sent the moment it verifies
  // — a television that was already playing when the phone arrived. Here that is
  // {streamId:null,state:'stopped'}, so wait for the one the play caused.
  const first = await waitFor(() => phoneEvents.seen.find((s) => s.state === 'status'), 10000, 'the initial status sync')
  check(first.status.streamId === null && first.status.state === 'stopped', 'a controller is told what is on the moment it joins, even when that is nothing')
  const st1 = await waitFor(() => { const s = phoneEvents.last('status'); return s && s.status.streamId === 'news' ? s : null }, 10000, 'the status reaches the phone')
  check(st1.status.state === 'playing', "and it says what is on: {streamId:'news', state:'playing'}")
  check(st1.from.deviceId === 'tv-1', 'attributed to the television that sent it')

  // A LOCAL zap must move the phone too — the status follows the ENGINE, not the command.
  await tv.resolve('sports')
  const st2 = await waitFor(() => { const s = phoneEvents.last('status'); return s && s.status.streamId === 'sports' ? s : null }, 10000, 'a local zap reaches the phone')
  check(st2.status.state === 'playing', 'a channel change made ON the television is pushed to the phone as well')

  // --- unentitled ---
  let refused = null
  try { await phone.remotePlay('tv-1', 'movies') } catch (err) { refused = err }
  check(refused && refused.code === REMOTE_CONTROL_ERRORS.unentitled, 'a channel the television is not entitled to is refused ("unentitled")')
  check(!tuned.includes('movies'), 'and nothing was tuned for it')

  // --- stop ---
  await phone.remoteStop('tv-1')
  const stopped = await waitFor(() => tvEvents.last('stop'), 10000, 'the stop command lands')
  check(stopped.from.deviceId === 'phone-1', 'the phone can stop the television, and it knows who asked')
  const st3 = await waitFor(() => { const s = phoneEvents.last('status'); return s && s.status.state === 'stopped' ? s : null }, 10000, 'the stopped status lands')
  check(st3.status.state === 'stopped', 'and the status follows it')

  // --- the opt-out switch ---
  tv.setRemoteAccept(false)
  let offPlay = null; let offStop = null
  try { await phone.remotePlay('tv-1', 'news') } catch (err) { offPlay = err }
  try { await phone.remoteStop('tv-1') } catch (err) { offStop = err }
  check(offPlay && offPlay.code === REMOTE_CONTROL_ERRORS.refused, 'with remote control switched off, play is refused ("refused")')
  check(offStop && offStop.code === REMOTE_CONTROL_ERRORS.refused, 'and so is stop — "may not change my channel" cannot mean "but may switch it off"')
  const denied = tvEvents.last('refused')
  check(denied && denied.reason === REMOTE_CONTROL_ERRORS.refused && denied.from.deviceId === 'phone-1', 'the attempt still surfaces on the television, so a host can say why nothing happened')
  tv.setRemoteAccept(true)
  check((await phone.remotePlay('tv-1', 'news')).ok === true, 'and turning it back on restores it')
  // A parental-gated channel is the host's to challenge — prove the engine does NOT tune on
  // its own, which is the whole reason an accepted play is a command and not an action.
  pinRequired = true
  await db.put('catalog/sports', { title: 'Sports 1', category: ['sport'], type: 'live', isLive: true, status: 'live', restricted: true, redirect: true, url: 'https://example.invalid/sports.m3u8' })
  await waitFor(() => tv.listStreams().find((s) => s.id === 'sports' && s.restricted), 15000, 'the restricted flag replicates')
  const before = tuned.length
  check((await phone.remotePlay('tv-1', 'sports')).ok === true, 'a parental-gated channel is still ACCEPTED (the account is entitled to it)')
  await sleep(500)
  check(tuned.length === before, '…and the ENGINE tuned nothing — the host refused at its PIN gate, which is where that decision belongs')
  pinRequired = false

  // ============================================================================
  // PART 2 — a peer that knows the topic and NOT the secret
  // ============================================================================

  const topicNow = remoteTopic(SECRET, Math.floor(Date.now() / 86400000))
  const forgedSecret = hex(hcrypto.randomBytes(32))
  const hostile = new Hyperswarm({ bootstrap }); cleanups.push(() => hostile.destroy())
  const hostileSocket = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout: hostile peer never reached the television')), 40000)
    hostile.on('connection', (socket) => { socket.on('error', () => {}); clearTimeout(t); resolve(socket) })
    hostile.join(topicNow, { client: true, server: false })
    hostile.flush().catch(() => {})
  })
  await new Promise((resolve) => { if (hostileSocket.handshakeHash) resolve(); else hostileSocket.once('connect', resolve) })
  const hrpc = new ProtomuxRPC(hostileSocket, { protocol: REMOTE_PROTOCOL })
  const hh = hostileSocket.handshakeHash
  const hRole = roleOf(hostileSocket)
  const hAsk = async (method, obj) => {
    try { return parse(await hrpc.request(method, body(obj), { timeout: 10000 })) } catch (err) { return { thrown: String(err && err.message) } }
  }

  // Straight to a command, with no hello at all.
  const bare = await hAsk('play', { v: 1, streamId: 'news' })
  check(bare && bare.error === REMOTE_CONTROL_ERRORS.unauthorized, 'a peer that never said hello cannot play anything ("unauthorized")')

  // Another wire version: NAMED, so the other end can say "update the app" rather than
  // reporting a silence.
  const wrongVersion = await hAsk('hello', { v: 99, proof: hex(remoteProof(SECRET, hh, hRole)), deviceId: 'ghost' })
  check(wrongVersion && wrongVersion.error === REMOTE_CONTROL_ERRORS.version, 'a peer on another wire version is named, not treated as noise')

  // The real thing: a forged secret.
  const forged = await hAsk('hello', { v: 1, proof: hex(remoteProof(forgedSecret, hh, hRole)), deviceId: 'ghost', label: 'Not Your TV' })
  check(forged && forged.error === REMOTE_CONTROL_ERRORS.unauthorized, 'a proof under a FORGED secret is refused')
  check(!forged.proof, 'and the television does not hand its own proof to an unproven stranger')
  check(!tv.listRemotes().find((p) => p.deviceId === 'ghost'), 'the forged peer never appears in the device list')

  // Talking on past the refusal buys nothing: the latch is the only thing `play` consults.
  const after = await hAsk('play', { v: 1, streamId: 'news' })
  check(after && (after.error === REMOTE_CONTROL_ERRORS.unauthorized || after.thrown), 'and it cannot talk its way past the latch afterwards')

  destroyQuietly(hrpc)

  // The same socket again, this time with the REAL secret — which the test holds because it
  // minted the account. Two things at once:
  //   1. the channel the television dropped after the forged hello is re-openable, which is
  //      the protomux `pair` notify doing its job (a device whose remote session starts
  //      LATER than its peer's has to be able to open on a connection that already exists);
  //   2. a peer that has proved itself still gets its message bodies shape-checked.
  await sleep(200)
  const lab = new ProtomuxRPC(hostileSocket, { protocol: REMOTE_PROTOCOL })
  const lAsk = async (method, obj) => {
    try { return parse(await lab.request(method, body(obj), { timeout: 10000 })) } catch (err) { return { thrown: String(err && err.message) } }
  }
  const greeted = await lAsk('hello', { v: 1, proof: hex(remoteProof(SECRET, hh, hRole)), deviceId: 'lab-remote', label: 'Lab' })
  check(greeted && greeted.ok === true && greeted.role === 'tv', 'a peer that DOES hold the account secret is accepted on a re-opened channel (the late-starting-device path)')
  check(!!greeted.proof, 'and the television proves itself back to it')
  await waitFor(() => tv.listRemotes().find((p) => p.deviceId === 'lab-remote'), 5000, 'it joins the list')
  const traversal = await lAsk('play', { v: 1, streamId: '../../catalog/movies' })
  check(traversal && traversal.error === REMOTE_CONTROL_ERRORS.malformed, 'a malformed streamId is refused on SHAPE, before it can reach the entitlement map')
  const noVersion = await lAsk('play', { streamId: 'news' })
  check(noVersion && noVersion.error === REMOTE_CONTROL_ERRORS.malformed, 'and so is a body with no wire version on it')
  const oversized = await lAsk('play', { v: 1, streamId: 'news', pad: 'x'.repeat(4096) })
  check(oversized && oversized.error === REMOTE_CONTROL_ERRORS.malformed, 'and one over the size bound, which is checked BEFORE the JSON is parsed')
  destroyQuietly(lab)
  destroyQuietly(hostileSocket)
  await waitFor(() => !tv.listRemotes().find((p) => p.deviceId === 'lab-remote'), 10000, 'a dropped socket leaves the list')
  check(true, 'and a peer that goes away leaves the list behind it')

  // ============================================================================
  // PART 3 — the epoch: two topics, one period of skew, and the roll that LEAVES
  // ============================================================================

  {
    const swarmA = new Hyperswarm({ bootstrap }); cleanups.push(() => swarmA.destroy())
    const EPOCH = 1000
    let clock = 10 * EPOCH // epoch 10
    const session = startRemoteControl({
      secret: SECRET,
      role: 'tv',
      identity: { deviceId: 'epoch-tv' },
      swarm: swarmA,
      epochMs: EPOCH,
      tickMs: 25,
      now: () => clock
    })
    check(JSON.stringify(session.epochs()) === '[9,10]', 'a device joins the CURRENT epoch and the PREVIOUS one — one full period of tolerated clock skew')
    check(!!swarmA.status(remoteTopic(SECRET, 10)) && !!swarmA.status(remoteTopic(SECRET, 9)), 'both are really joined on the swarm')

    // A device whose clock is a whole period out still overlaps on one topic — which is the
    // entire reason the previous epoch is joined at all.
    const skewed = [11, 10]
    check(skewed.some((e) => session.epochs().includes(e)), 'a device one whole period ahead still overlaps on a shared topic')

    clock += EPOCH // roll
    await waitFor(() => session.epochs().join() === '10,11', 2000, 'the epoch rolls')
    check(session.epochs().join() === '10,11', 'a roll joins the new current epoch')
    await waitFor(() => swarmA.status(remoteTopic(SECRET, 9)) === null, 2000, 'the aged-out topic is left')
    check(swarmA.status(remoteTopic(SECRET, 9)) === null, '…and LEAVES the aged-out one, which is the half that makes the epoch worth anything')

    await session.destroy()
    check(swarmA.status(remoteTopic(SECRET, 10)) === null && swarmA.status(remoteTopic(SECRET, 11)) === null, 'destroy() leaves every topic behind it')
  }

  // ============================================================================
  // PART 4 — the build gate, and teardown
  // ============================================================================

  {
    const plain = createPlayer({ panelPubKey, storeDir: path.join(dirs.plain, 'store'), deviceId: 'plain-1', swarm: { bootstrap } })
    cleanups.push(() => plain.stop())
    await plain.connect()
    await waitFor(() => plain.login('alice', PASSWORD).catch(() => null), 30000, 'plain login')
    check(plain._session.remoteSecret == null, 'a build without remote.control keeps no rendezvous secret after login')
    let gated = null
    try { await plain.startRemote({ role: 'tv' }) } catch (err) { gated = err }
    check(gated && /remote: \{ control: true \}/.test(String(gated.message)), 'startRemote() refuses on that build, and names the flag')
    const e = Math.floor(Date.now() / 86400000)
    const anyJoined = [e, e - 1].some((n) => plain._swarm.status(remoteTopic(SECRET, n)) !== null)
    check(!anyJoined, 'and NO rendezvous topic was ever joined — the gate is not just a thrown error')
    check(plain.listRemotes().length === 0, 'listRemotes() is empty rather than throwing')
  }

  // Teardown: no topic, no listener, no peer.
  const swarmListeners = tv._swarm.listenerCount('connection')
  const peerSocket = [...tv._swarm.connections][0] || null
  const socketCloses = peerSocket ? peerSocket.listenerCount('close') : 0
  await tv.stopRemote()
  await phone.stopRemote()
  {
    const e = Math.floor(Date.now() / 86400000)
    const left = [e, e - 1].every((n) => tv._swarm.status(remoteTopic(SECRET, n)) === null && phone._swarm.status(remoteTopic(SECRET, n)) === null)
    check(left, 'stopRemote() leaves every rendezvous topic on both devices')
    check(tv._swarm.listenerCount('connection') === swarmListeners - 1, "…removes its 'connection' listener from the borrowed swarm")
    if (peerSocket) check(peerSocket.listenerCount('close') <= socketCloses, "…and its per-socket 'close' listeners, without destroying the socket")
    check(peerSocket ? !peerSocket.destroyed : true, 'the socket itself survives — it is also carrying replication and the panel RPC')
    check(tv.listRemotes().length === 0 && phone.listRemotes().length === 0, 'and both device lists are empty')
  }

  // Idempotent, and re-startable: nothing wedged on the way out.
  await tv.stopRemote()
  await phone.stopRemote()
  const tvAgain = await tv.startRemote({ role: 'tv', label: 'Living Room' })
  await tvAgain.flushed()
  await phone.startRemote({ role: 'controller', label: 'Pixel' })
  await waitFor(() => phone.listRemotes().find((p) => p.deviceId === 'tv-1'), 40000, 'the two devices find each other again')
  check(true, 'a fresh session on the same engines finds the same devices again (nothing was left wedged)')
  check((await phone.remotePlay('tv-1', 'news')).ok === true, 'and commands work on it')

  // stop() must take the rendezvous with it, both windows included.
  await tv.stop()
  check(tv.listRemotes().length === 0, 'stop() takes the rendezvous down with the engine')

  log('\nPASS —', passed, 'checks')
  await cleanup()
  process.exit(0)
} catch (err) {
  console.error('\nFAIL:', err && err.message)
  console.error(err)
  await cleanup()
  process.exit(1)
}

function destroyQuietly (x) { try { if (x) x.destroy() } catch {} }
