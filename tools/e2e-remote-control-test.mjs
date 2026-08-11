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
//   - the take-over switch refuses play AND stop when it is off;
//   - a command aimed at a CONTROLLER is named, not misreported as a timeout;
//   - rapid channel changes COALESCE into one status carrying where the viewer ended up;
//   - and a channel this device is entitled to but cannot READ fails CLOSED — refused,
//     rather than reported to the host as unrestricted from a record nobody found.
//
// Part 2 drives sdk/remote-control.js with hand-rolled hostile peers, because the
// interesting cases are the refusals. They are given the real TOPIC (which they could learn
// by watching the DHT) but a FORGED secret, so they are exactly the adversary the mutual
// proof exists for. BOTH DIRECTIONS, which is the half that used to be missing:
//
//   answering  — what this television REPLIES to a stranger:
//                - a forged proof is refused and the channel is closed;
//                - `play` without a hello at all is refused;
//                - so is `play` after a refused hello — a peer cannot talk its way past the
//                  latch, and now cannot talk at all: the refusal took the channel;
//                - a malformed body is a refusal that ALSO ends the channel, so a stranger
//                  that sends nothing else cannot sit on this socket forever;
//                - another wire version is named rather than reported as silence;
//                - a malformed streamId never reaches the entitlement map.
//   opening    — what this television SENDS a peer that has proved nothing. It offers its
//                channel to every connection its swarm has, and protomux writes the bytes
//                before the far mux decides whether to accept the channel at all — so a
//                peer that merely registers a responder reads the opening hello. It must
//                find a proof in it and NOTHING else: no deviceId (a truncation of the
//                account public key when the host passes none), no label, no platform, no
//                version, no role. Identity follows verification, in both directions.
//
// Part 3 is the epoch: current + previous joined, a real second session one whole period
// ahead sharing exactly one topic with the first, and — the half that makes an epoch worth
// anything — the aged-out topic actually LEFT on a roll.
//
// Part 4 is the gate and teardown: with `remote.control` off, startRemote() refuses and NO
// topic is ever joined; after stopRemote() no topic, no listener and no peer is left behind,
// and a fresh session on the same engines finds the same peers again. It also pins the
// per-socket teardown a rejected channel leaves behind — the notify that unpairs a stranger's
// mux must OUTLIVE the channel close, or a television running for weeks against a churning
// swarm retains one Protomux, one dead NoiseSecretStream and one session-wide closure per
// peer it ever met.
//
// EVERY EPOCH IN THIS FILE COMES FROM THE SESSION'S OWN epochs(), never from a fresh
// Date.now(). Wall-clock reads scattered through a lane disagree with each other, and with
// the session, if a run straddles UTC midnight — a millisecond window, but a required lane
// must not carry one.
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
  remoteSecret, remoteTopic, remoteProof, REMOTE_ROLES, REMOTE_PROOF_BYTES
} from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { createPlayer } from '../sdk/index.js'
import { startRemoteControl, REMOTE_PROTOCOL, REMOTE_CONTROL_ERRORS, REMOTE_EPOCH_MS } from '../sdk/remote-control.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(100) }
  throw new Error('timeout: ' + label)
}

const DIFFICULTY = 8 // low for a fast test
// Mirrors STATUS_MIN_MS in sdk/remote-control.js, which is deliberately not exported (it is
// a property of the protocol, not a knob). Only used here to wait out a trailing send.
const STATUS_FLOOR_MS = 1000
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
  // The session's OWN epochs, read once and reused everywhere below — see the header note
  // about UTC midnight. epochs() is ascending, so DAY[1] is the current one.
  const DAY = tv._remoteCtl.epochs()
  {
    check(DAY.length === 2 && DAY[1] === DAY[0] + 1, 'those two epochs are consecutive — the current period and the one before it')
    // The period itself, read off the module rather than recomputed from a clock: a second
    // Date.now() here is the midnight race the header warns about, for a constant.
    check(REMOTE_EPOCH_MS === 24 * 60 * 60 * 1000, 'and the period is ONE DAY — the linkage window the epoch bounds')
    const want = DAY.map((e) => hex(remoteTopic(SECRET, e))).sort()
    check(JSON.stringify([...tvStart.topics].sort()) === JSON.stringify(want), 'and each topic is remoteTopic(secret, epoch) for one of them')
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

  // --- a controller is a PEER, not a TARGET ---
  // Two devices of one account verify each other whichever ends they are running, so the
  // television lists the phone exactly as the phone lists the television. Sending a channel
  // change to it reaches a device with no `play` responder: protomux-rpc answers
  // UNKNOWN_METHOD, ask() cannot tell that from silence, and this used to surface as
  // `timeout` — the one code the vocabulary promises means "it did not answer". A viewer who
  // tapped their own other phone in a picker would have been told their television had
  // dropped off Wi-Fi.
  let notATv = null
  try { await tv.remotePlay('phone-1', 'news') } catch (err) { notATv = err }
  check(notATv && notATv.code === REMOTE_CONTROL_ERRORS.unknown, 'a command aimed at a CONTROLLER is refused as "unknown", not misreported as a timeout')

  // --- coalescing ---
  // "At most one message a second, carrying where the viewer ended up" is one of the three
  // decisions the status design makes and nothing exercised it. Three channel changes back
  // to back on a redirect channel (resolve() opens no feed and joins no topic, so each is
  // sub-millisecond) cannot produce three pushes: the first may flush on the spot if the
  // floor has already elapsed, but the two after it fall inside the window and share one
  // trailing send. Asserted as "fewer than three" rather than "exactly two" because which
  // side of the floor the FIRST one lands on is a real timing question and not the claim.
  {
    const statusCount = () => phoneEvents.seen.filter((s) => s.state === 'status').length
    const n0 = statusCount()
    await tv.resolve('sports'); await tv.resolve('news'); await tv.resolve('sports')
    const settled = await waitFor(() => {
      const s = phoneEvents.last('status')
      return s && s.status.streamId === 'sports' && statusCount() > n0 ? s : null
    }, 10000, 'the coalesced status reaches the phone')
    await sleep(STATUS_FLOOR_MS + 500) // any trailing send still owed has landed by now
    check(statusCount() - n0 < 3, 'three channel changes inside the one-second floor produce FEWER than three status pushes — they coalesce')
    check(settled.status.streamId === 'sports' && phoneEvents.last('status').status.streamId === 'sports', '…and what lands says where the viewer ENDED UP, not where they passed through')
  }

  // --- fail closed on a channel this device cannot describe ---
  // `_entitled` and `_streams` are different objects and they legitimately disagree:
  // _pushCatalog() rebuilds the display list only from records that READ BACK, so an id
  // whose catalog record has not replicated (or that the operator just removed) drops out of
  // `_streams` while it stays in `_entitled`; and a re-login fills `_entitled` an await
  // before _publishLogin() assigns `_streams`. Reproduced directly here, on a channel that
  // really IS parental-gated — which is the whole point. A remote `play` is the only path
  // that can name a channel absent from the display list; a local zap cannot.
  {
    const keptStreams = tv.listStreams()
    check(!!keptStreams.find((s) => s.id === 'sports' && s.restricted), 'the channel about to go missing is a restricted one')
    const playsBefore = tvEvents.seen.filter((s) => s.state === 'play').length
    const tunedBefore = tuned.length
    tv._streams = keptStreams.filter((s) => s.id !== 'sports')
    let blind = null
    try { await phone.remotePlay('tv-1', 'sports') } catch (err) { blind = err }
    tv._streams = keptStreams
    check(blind && blind.code === REMOTE_CONTROL_ERRORS.unavailable, 'a play for a channel the television is entitled to but cannot READ is REFUSED')
    check(tvEvents.seen.filter((s) => s.state === 'play').length === playsBefore, '…no command reached the host at all, so nothing was reported to it as unrestricted from a record nobody found')
    check(tuned.length === tunedBefore, '…and nothing was tuned')
  }

  // --- a playhead belongs to the channel it was measured on ---
  // `position` is sticky on purpose: the host sends one, it is stored, and it rides the next
  // push some real change caused. But a channel change is exactly the change it must NOT
  // ride — zapping A -> B used to publish B's status carrying A's playhead.
  {
    await tv.resolve('news')
    await waitFor(() => { const s = phoneEvents.last('status'); return s && s.status.streamId === 'news' ? s : null }, 10000, 'the phone follows the television to news')
    await sleep(STATUS_FLOOR_MS + 200) // clear of the floor, so the next change sends at once
    tv.updateRemoteStatus({ position: 1234 }) // stored; a position alone never sends anything
    await tv.resolve('sports')
    const zapped = await waitFor(() => { const s = phoneEvents.last('status'); return s && s.status.streamId === 'sports' ? s : null }, 10000, 'and on to sports')
    check(zapped.status.position === null, '…carrying NO playhead: the one the host set belongs to the channel that is no longer on')

    // …and it does ride a change on the SAME channel, which is the half that was always right.
    await sleep(STATUS_FLOOR_MS + 200)
    tv.updateRemoteStatus({ position: 99 })
    tv.updateRemoteStatus({ state: 'paused' })
    const paused = await waitFor(() => { const s = phoneEvents.last('status'); return s && s.status.state === 'paused' ? s : null }, 10000, 'a host-reported pause reaches the phone')
    check(paused.status.position === 99 && paused.status.streamId === 'sports', '…still carrying the playhead the host set, because the channel did not change')
    tv.updateRemoteStatus({ state: 'playing' })
  }

  // ============================================================================
  // PART 2 — a peer that knows the topic and NOT the secret
  // ============================================================================

  const topicNow = remoteTopic(SECRET, DAY[1])
  const forgedSecret = hex(hcrypto.randomBytes(32))
  const hostile = new Hyperswarm({ bootstrap }); cleanups.push(() => hostile.destroy())
  const hostileSocket = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout: hostile peer never reached the television')), 40000)
    hostile.on('connection', (socket) => { socket.on('error', () => {}); clearTimeout(t); resolve(socket) })
    hostile.join(topicNow, { client: true, server: false })
    hostile.flush().catch(() => {})
  })
  await new Promise((resolve) => { if (hostileSocket.handshakeHash) resolve(); else hostileSocket.once('connect', resolve) })
  const hh = hostileSocket.handshakeHash
  const hRole = roleOf(hostileSocket)

  // --- 2a. what this television ANSWERS a stranger ---
  //
  // ONE CHANNEL PER PROBE, because every refusal to an unproven peer now tears the channel
  // down: a stranger that sends nothing but malformed bodies used to be able to talk forever
  // on a socket that is also carrying a viewer's feed. A real adversary re-opens, so this is
  // the more faithful harness as well as the necessary one — and each re-open exercises the
  // protomux `pair` notify that lets a late-starting device reach an existing connection.
  const channel = () => {
    const rpc = new ProtomuxRPC(hostileSocket, { protocol: REMOTE_PROTOCOL })
    const ask = async (method, obj) => {
      try { return parse(await rpc.request(method, body(obj), { timeout: 10000 })) } catch (err) { return { thrown: String(err && err.message) } }
    }
    return { rpc, ask, close: async () => { destroyQuietly(rpc); await sleep(200) } }
  }
  const probe = async (method, obj) => {
    const c = channel()
    const out = await c.ask(method, obj)
    await c.close()
    return out
  }

  // Straight to a command, with no hello at all.
  const bare = await probe('play', { v: 1, streamId: 'news' })
  check(bare && bare.error === REMOTE_CONTROL_ERRORS.unauthorized, 'a peer that never said hello cannot play anything ("unauthorized")')

  // Another wire version: NAMED, so the other end can say "update the app" rather than
  // reporting a silence.
  const wrongVersion = await probe('hello', { v: 99, proof: hex(remoteProof(SECRET, hh, hRole)), deviceId: 'ghost' })
  check(wrongVersion && wrongVersion.error === REMOTE_CONTROL_ERRORS.version, 'a peer on another wire version is named, not treated as noise')

  // The real thing: a forged secret — and then talking on past the refusal, on the SAME
  // channel, because "it cannot talk its way past the latch" is a claim about one channel.
  {
    const c = channel()
    const forged = await c.ask('hello', { v: 1, proof: hex(remoteProof(forgedSecret, hh, hRole)), deviceId: 'ghost', label: 'Not Your TV' })
    check(forged && forged.error === REMOTE_CONTROL_ERRORS.unauthorized, 'a proof under a FORGED secret is refused')
    check(!forged.proof && !forged.deviceId && !forged.label, 'and the REFUSAL carries nothing — not the television\'s proof, not its name (what it sends UNPROMPTED is 2b below)')
    check(!tv.listRemotes().find((p) => p.deviceId === 'ghost'), 'the forged peer never appears in the device list')
    const after = await c.ask('play', { v: 1, streamId: 'news' })
    check(after && (after.error === REMOTE_CONTROL_ERRORS.unauthorized || after.thrown), 'and it cannot talk its way past the latch afterwards — the refusal took the channel with it')
    await c.close()
  }

  // A MALFORMED BODY IS A REFUSAL THAT ALSO ENDS THE CHANNEL. It used not to be: only a
  // failed proof tore anything down, so "every failure path tears down" was untrue as
  // written and a stranger sending junk was never dropped.
  {
    const c = channel()
    const junk = await c.ask('hello', { proof: hex(remoteProof(SECRET, hh, hRole)) }) // no `v`
    check(junk && junk.error === REMOTE_CONTROL_ERRORS.malformed, 'a hello with no wire version on it is refused as malformed')
    // The refusal is WRITTEN FIRST and the drop lands on the next tick, so that the stranger
    // still reads why. A message already in flight can therefore still find the channel open
    // — this asserts the settled state, which is the claim.
    await sleep(500)
    const next = await c.ask('hello', { v: 1, proof: hex(remoteProof(SECRET, hh, hRole)) })
    check(next && next.thrown, '…and the channel is then GONE, so a stranger that sends nothing but junk cannot sit on this socket')
    await c.close()
  }

  // The same socket again, this time with the REAL secret — which the test holds because it
  // minted the account. Three things at once:
  //   1. the channel the television dropped after each refusal is re-openable, which is the
  //      protomux `pair` notify doing its job (a device whose remote session starts LATER
  //      than its peer's has to be able to open on a connection that already exists);
  //   2. the TWO ROUNDS: `hello` proves and gets identity back, `whoami` sends identity and
  //      is what actually puts this peer on the list;
  //   3. a peer that has proved itself still gets its message bodies shape-checked — and is
  //      NOT dropped for one bad body, because on a real account that is a version skew.
  // Identity offered without a proof first, on its own channel: `whoami` is the only place a
  // peer's name is read off the wire, so it has to be gated on the same latch `play` is.
  const unproven = await probe('whoami', { v: 1, role: 'controller', deviceId: 'sneak' })
  check(unproven && unproven.error === REMOTE_CONTROL_ERRORS.unauthorized, 'a whoami on a channel that never proved anything is refused')
  check(!tv.listRemotes().find((p) => p.deviceId === 'sneak'), 'and names nobody')

  const lab = channel()
  const greeted = await lab.ask('hello', { v: 1, proof: hex(remoteProof(SECRET, hh, hRole)) })
  check(greeted && greeted.ok === true && greeted.role === 'tv', 'a peer that DOES hold the account secret is accepted on a re-opened channel (the late-starting-device path)')
  check(!!greeted.proof, 'and the television proves itself back to it')
  check(greeted.deviceId === 'tv-1' && greeted.label === 'Living Room', 'and names itself — to a peer that has just proved, which is the whole precondition')
  check(!tv.listRemotes().find((p) => p.deviceId === 'lab-remote'), 'a proof alone does not put a peer on the list: it has not said who it is yet')
  const named = await lab.ask('whoami', { v: 1, role: 'controller', deviceId: 'lab-remote', label: 'Lab' })
  check(named && named.ok === true, 'the second round carries the identity')
  await waitFor(() => tv.listRemotes().find((p) => p.deviceId === 'lab-remote'), 5000, 'and only then does it join the list')
  const traversal = await lab.ask('play', { v: 1, streamId: '../../catalog/movies' })
  check(traversal && traversal.error === REMOTE_CONTROL_ERRORS.malformed, 'a malformed streamId is refused on SHAPE, before it can reach the entitlement map')
  const noVersion = await lab.ask('play', { streamId: 'news' })
  check(noVersion && noVersion.error === REMOTE_CONTROL_ERRORS.malformed, 'and so is a body with no wire version on it')
  const oversized = await lab.ask('play', { v: 1, streamId: 'news', pad: 'x'.repeat(4096) })
  check(oversized && oversized.error === REMOTE_CONTROL_ERRORS.malformed, 'and one over the size bound, which is checked BEFORE the JSON is parsed')
  check(!!tv.listRemotes().find((p) => p.deviceId === 'lab-remote'), '…and three bad bodies did NOT cost a PROVEN peer its channel — on a real account that is a version skew, not an attack')
  destroyQuietly(lab.rpc)
  destroyQuietly(hostileSocket)
  await waitFor(() => !tv.listRemotes().find((p) => p.deviceId === 'lab-remote'), 10000, 'a peer that goes away leaves the list behind it')

  // --- 2b. what this television SENDS, unprompted, to a peer that has proved nothing ---
  //
  // The opener direction, which the suite never covered. This television offers its channel
  // to every connection its swarm has, and protomux writes an opened channel's messages
  // straight to the stream — nothing waits to see whether the far mux will accept it. So a
  // peer that does no more than REGISTER A RESPONDER for this protocol reads the opening
  // hello, whatever it does or does not know. It must find a proof in it and nothing else.
  //
  // The responder is registered SYNCHRONOUSLY in the connection handler: the television's
  // channel open is already on its way, and one registered an await later misses it — which
  // is exactly why the old harness's hostile peer never saw this message.
  async function lurk ({ proofSecret, deviceId, label }) {
    const swarm = new Hyperswarm({ bootstrap })
    const seen = { hello: null, whoami: null }
    swarm.on('connection', (socket) => {
      socket.on('error', () => {})
      const rpc = new ProtomuxRPC(socket, { protocol: REMOTE_PROTOCOL })
      rpc.respond('hello', (buf) => {
        seen.hello = parse(buf)
        return body({ v: 1, ok: true, role: 'controller', deviceId, label, proof: hex(remoteProof(proofSecret, socket.handshakeHash, roleOf(socket))) })
      })
      rpc.respond('whoami', (buf) => { seen.whoami = parse(buf); return body({ v: 1, ok: true }) })
    })
    swarm.join(topicNow, { client: true, server: false })
    swarm.flush().catch(() => {})
    await waitFor(() => seen.hello, 40000, 'the television greets ' + deviceId)
    await sleep(2000) // whichever way it goes, the second round has had its chance by now
    await swarm.destroy()
    return seen
  }
  const namedFields = (m) => ['deviceId', 'label', 'platform', 'appVersion', 'role'].filter((k) => m[k] !== undefined)
  {
    const honest = await lurk({ proofSecret: SECRET, deviceId: 'lurk-ok', label: 'Lurker' })
    check(typeof honest.hello.proof === 'string' && honest.hello.proof.length === REMOTE_PROOF_BYTES * 2, "the opening hello a stranger is handed carries a proof")
    check(namedFields(honest.hello).length === 0, '…and NOTHING else: no deviceId — which is a truncation of the ACCOUNT public key when the host passes none — no label, no platform, no version, no role')
    check(honest.whoami && honest.whoami.deviceId === 'tv-1' && honest.whoami.label === 'Living Room' && honest.whoami.role === 'tv', 'identity arrives in the SECOND round, once the answer has proved the account secret')

    const liar = await lurk({ proofSecret: forgedSecret, deviceId: 'lurk-bad', label: 'Not Yours' })
    check(namedFields(liar.hello).length === 0, 'a peer that will answer with a FORGED proof is handed the same bare hello')
    check(liar.whoami === null, '…and is never told who this device is: identity follows verification in BOTH directions')
    check(!tv.listRemotes().find((p) => p.deviceId === 'lurk-bad'), 'and it never joins the list')
  }

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
    // entire reason the previous epoch is joined at all. Asserted against a REAL second
    // session running on a skewed clock; it used to be asserted against two literals, which
    // is a property of the two literals and not of the system.
    {
      const swarmB = new Hyperswarm({ bootstrap }); cleanups.push(() => swarmB.destroy())
      const ahead = startRemoteControl({
        secret: SECRET,
        role: 'controller',
        identity: { deviceId: 'epoch-phone' },
        swarm: swarmB,
        epochMs: EPOCH,
        tickMs: 25,
        now: () => clock + EPOCH // a whole period fast
      })
      check(JSON.stringify(ahead.epochs()) === '[10,11]', 'a device one whole period ahead lands on the next pair of epochs')
      const shared = ahead.epochs().filter((e) => session.epochs().includes(e))
      check(shared.length === 1 && shared[0] === 10, '…and the two still share exactly one topic, which is the skew budget the previous epoch buys')
      const sharedTopic = hex(remoteTopic(SECRET, shared[0]))
      check(session.topics().includes(sharedTopic) && ahead.topics().includes(sharedTopic), 'both are really on that shared topic')
      await ahead.destroy()
    }

    clock += EPOCH // roll
    await waitFor(() => session.epochs().join() === '10,11', 2000, 'a roll joins the new current epoch')
    await waitFor(() => swarmA.status(remoteTopic(SECRET, 9)) === null, 2000, '…and LEAVES the aged-out one, which is the half that makes the epoch worth anything')

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
    const anyJoined = DAY.some((n) => plain._swarm.status(remoteTopic(SECRET, n)) !== null)
    check(!anyJoined, 'and NO rendezvous topic was ever joined — the gate is not just a thrown error')
    check(plain.listRemotes().length === 0, 'listRemotes() is empty rather than throwing')
  }

  // --- what a REJECTED channel leaves on the socket ---
  //
  // The `pair` notify has to OUTLIVE its channel — that is the whole point of it: a device
  // whose remote session starts after ours must still find a responder on a connection our
  // own eager channel was already thrown off. Its teardown therefore cannot live in the
  // per-channel listener list, because dropPeer() empties that, and a channel closing before
  // its socket is the COMMON case here (every stranger's mux rejects the eager open). It did
  // live there, so the socket's later close removed nothing: one Protomux, one dead
  // NoiseSecretStream and one closure over this entire session retained per peer met, on a
  // television that runs for weeks against a churning 64-peer swarm.
  //
  // Measured on the socket's own 'close' listener count — public, and it moves by exactly
  // one. An UNRELATED secret, so this session's rendezvous cannot collide with the two live
  // engines above. The channel is closed FROM THE FAR SIDE while the socket stays up, which
  // is the shape the finding is about and the ordinary case on a borrowed swarm.
  {
    const topic = hcrypto.randomBytes(32)
    const mine = new Hyperswarm({ bootstrap }); cleanups.push(() => mine.destroy())
    const stranger = new Hyperswarm({ bootstrap }); cleanups.push(() => stranger.destroy())
    let found = null
    let strangerRpc = null
    let greeted = false
    mine.on('connection', (s) => { s.on('error', () => {}); found = s })
    stranger.on('connection', (s) => {
      s.on('error', () => {})
      // A peer that takes the channel and refuses: it never proves anything, so the session
      // holds an UNVERIFIED entry on it — the state every stranger on a borrowed swarm is in.
      const rpc = new ProtomuxRPC(s, { protocol: REMOTE_PROTOCOL })
      rpc.respond('hello', () => { greeted = true; return body({ v: 1, error: REMOTE_CONTROL_ERRORS.unauthorized }) })
      strangerRpc = rpc
    })
    // Announce FIRST and flush it, then look up: a client that queries before the announce
    // lands does not retry for ten minutes, which is longer than this lane lives.
    mine.join(topic, { server: true, client: false })
    await mine.flush()
    stranger.join(topic, { client: true, server: false })
    stranger.flush().catch(() => {})
    const sock = await waitFor(() => (found && [...mine.connections].includes(found) ? found : null), 30000, 'the two test swarms meet')
    // COUNTED BY OWNER, not against a baseline: hyperswarm attaches its own 'close'
    // listeners to a connection on its own schedule, so a number snapshotted before the
    // session starts is already stale when it is compared. Every listener this session puts
    // on a socket routes to dropPeer, and nothing else on the socket does.
    const ours = () => sock.listeners('close').filter((f) => /dropPeer/.test(String(f))).length
    const session = startRemoteControl({
      secret: hex(hcrypto.randomBytes(32)), role: 'tv', identity: { deviceId: 'leak-tv' }, swarm: mine
    })
    await waitFor(() => greeted, 15000, 'the session opens its channel on the borrowed connection and greets')
    check(ours() === 2, 'a live channel carries two socket listeners of this session: one for the channel, one for the mux notify')
    // THE CHANNEL DIES, THE SOCKET LIVES — the common case, and the one the bug was in.
    destroyQuietly(strangerRpc)
    await sleep(1500)
    check(ours() === 1, 'when the CHANNEL closes under a live socket the notify teardown SURVIVES it — it used to be swept away with the channel, leaving nothing to unpair the mux when the socket finally died')
    await session.destroy()
    check(ours() === 0, '…and destroy() takes that one back off, so nothing of the session outlives it')
    await stranger.destroy()
  }

  // Teardown: no topic, no listener, no peer.
  const swarmListeners = tv._swarm.listenerCount('connection')
  const peerSocket = [...tv._swarm.connections][0] || null
  const socketCloses = peerSocket ? peerSocket.listenerCount('close') : 0
  await tv.stopRemote()
  await phone.stopRemote()
  {
    const left = DAY.every((n) => tv._swarm.status(remoteTopic(SECRET, n)) === null && phone._swarm.status(remoteTopic(SECRET, n)) === null)
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
  await waitFor(() => phone.listRemotes().find((p) => p.deviceId === 'tv-1'), 40000, 'a fresh session on the same engines finds the same devices again (nothing was left wedged)')
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
