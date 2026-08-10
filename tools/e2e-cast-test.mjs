// End-to-end CAST-TO-TV test: the SDK's second, LAN-scoped media server (startCast).
//
// resolve() hands hosts a 127.0.0.1 URL, and that loopback bind is the entire security
// boundary for normal playback — the bytes behind it are decrypted entitled content. So
// casting does not widen it; it stands up a SEPARATE server on 0.0.0.0 that exists only
// while a cast session does, with every path behind a fresh 32-byte token. This lane is
// what keeps those two surfaces from quietly becoming one.
//
//   A  SERVE-CORE CONTRACT (pure, one local drive, no DHT) — the `cors` option is OFF by
//      default (the loopback server's responses must not change by one byte), ON it adds
//      Access-Control-Allow-Origin / -Headers / -Expose-Headers to GETs AND to 404s, and
//      OPTIONS is answered 204 BEFORE resolveTarget is ever consulted. Plus the per-target
//      `reclaim: false` opt-out (the same reclaim-enabled handler must free a normal
//      target's expired blocks and leave an opted-out, cast-pinned drive's alone) and the
//      method gate: GET/HEAD only, everything else 405 + Allow, before any drive read.
//   A2 THE ADDRESS PICK (pure, a synthetic `os`) — RFC1918 is REQUIRED, not preferred; a
//      public-only host is REFUSED by name and pointed at advertiseHost; every private
//      candidate is reported because os.networkInterfaces() cannot tell Wi-Fi from a
//      container bridge or from carrier CGNAT; APIPA/loopback/IPv6 are skipped.
//   B  LAN REACH — a headless player logs in over a local DHT testnet, startCast() returns
//      an http:// URL on the engine's exact private-IPv4 pick, the server is BOUND to that
//      one address (not 0.0.0.0), and fetching it off the loopback interface answers 200.
//   C  CORS ON THE WIRE — the real cast server's GET carries the headers a Cast receiver
//      needs (without ACAO the measured TCL Terraza fetched the playlist and then ZERO
//      segments), and OPTIONS answers 204 with Allow-Methods.
//   D  RELATIVE SEGMENTS INHERIT THE TOKEN — ⚠ THE LOAD-BEARING ONE. The playlist is
//      served verbatim, so its bare `segN.ts` URIs must resolve against
//      …/cast/<token>/index.m3u8 into …/cast/<token>/segN.ts and fetch. If this breaks,
//      the feature needs per-request playlist rewriting.
//   E  THE TOKEN SCOPES THE SESSION — a wrong token, a truncated token and a bare path all
//      404 on the LAN server; the LOOPBACK server refuses /cast/* even with the right
//      token, and its own responses still carry no CORS headers. (It is a SCOPE, not a
//      boundary: a receiver reads the whole URL back to any unauthenticated peer that joins
//      its session — measured on real hardware. G3 covers what narrows that.)
//   F  THE FEED IS PINNED — zapping the phone to another channel mid-cast must NOT move
//      the receiver's stream. The loopback route follows _feedDrive on every zap; the
//      cast route must not. F2: pinned to the CHANNEL though, not to a Hyperdrive — a
//      broadcaster restart rotates the channel onto a new feedKey and the session must
//      follow it on the unchanged URL, or the receiver sits on a feed that is dead.
//   G  STOP — stopCast() hangs up the socket, the listener is really UNBOUND afterwards,
//      and the URL stops answering; advertiseHost is bound when this device owns it and
//      validated as a bare authority always (it carries the token). G2: the per-session
//      readIdleMs/reclaim overrides, and castSession() never exposing a half-built session.
//      G3: the OPT-IN receiver pin — the pinned peer is served, every other one gets the
//      same 404 a wrong token gets, and an unpinned session is unchanged.
//   H  REDIRECT CHANNELS — an operator-set remote https URL casts with NO server at all.
//      H2: hybrid.mode 'cdn-only' the same way — no drive opened, no swarm topic joined.
//   I  A SESSION THAT DIES ON ITS OWN — an evicted pinned feed must END the session
//      (socket closed, state cleared) and emit 'cast', not leave a bound zombie.
//
// Local DHT testnet only (never the public DHT — required lane, must be deterministic).
// No ffmpeg. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import http from 'http'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import createTestnet from 'hyperdht/testnet.js'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT
} from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { createDriveHandler } from '../sdk/serve.js'
import { createPlayer, AliranPlayer } from '../sdk/index.js'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(200) }
  throw new Error('timeout: ' + label)
}

// One request, any host/port/method. Resolves { status, headers, body }; rejects on a
// transport failure (which is itself an assertion in section G).
function request (method, url, headers = {}) {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers,
      agent: false
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('request timeout: ' + url)))
    req.end()
  })
}
const GET = (url, headers) => request('GET', url, headers)

// The engine's pick (sdk/player.js _lanAddress), REPRODUCED here — not approximated — so the
// lane asserts against an independently derived address rather than against the engine's own
// answer. The previous version of this helper deliberately omitted the private-address filter
// and then asserted only `lan.includes(cast.host)`: membership, not equality. That would have
// passed with a PUBLIC address on any host that had one, which is precisely the case the
// filter exists to prevent, so the lane could not catch the bug it was written to guard.
function isPrivateIPv4 (ip) {
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true
  const m = /^172\.(\d{1,3})\./.exec(ip)
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31
}
// Every non-internal, non-APIPA IPv4 — the raw set, before the RFC1918 requirement.
function lanIPv4 () {
  const found = []
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const a of list || []) {
      if (!a || a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue
      if (!a.address || a.address.startsWith('169.254.')) continue
      found.push(a.address)
    }
  }
  return found
}
// …and the pick itself: RFC1918 is REQUIRED, first one wins.
function lanCandidates () { return lanIPv4().filter(isPrivateIPv4) }

// A fake `os` for the address-pick cases a real host cannot be made to produce on demand
// (a public-only box, a multi-homed box, a box with nothing but APIPA). networkInterfaces()
// is the ONLY thing _lanAddress touches.
function fakeOs (byIface) {
  return { networkInterfaces: () => byIface }
}
const ifc = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, ...extra })

const DIFFICULTY = 8 // low for a fast test
const PASSWORD = 'test123'
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const dirs = { pure: tmp('e2ecast-pure-'), panel: tmp('e2ecast-panel-'), origin: tmp('e2ecast-origin-'), cli: tmp('e2ecast-cli-') }
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

try {
  // =========================================================================================
  // A. The serving core's cast contract — pure, one local drive, no swarm.
  // =========================================================================================
  {
    const store = new Corestore(dirs.pure); await store.ready(); cleanups.push(() => store.close())
    const drive = new Hyperdrive(store.namespace('pure')); await drive.ready()
    const seg = (v) => Buffer.alloc(160 * 1024, v) // 160 KB = 3 blobs blocks, like the reclaim lane
    for (let i = 1; i <= 4; i++) await drive.put(`/p${i}.ts`, seg(i))
    const blobRef = {}
    for (let i = 1; i <= 4; i++) blobRef[i] = (await drive.entry(`/p${i}.ts`)).value.blob
    const blobs = await drive.getBlobs()
    const stored = async (b) => {
      for (let i = b.blockOffset; i < b.blockOffset + b.blockLength; i++) if (!(await blobs.core.has(i))) return false
      return true
    }
    const clearedAll = async (b) => {
      for (let i = b.blockOffset; i < b.blockOffset + b.blockLength; i++) if (await blobs.core.has(i)) return false
      return true
    }
    // A live window naming only the NEWEST two segments: p1/p2 are below the floor.
    const window2 = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\np3.ts\n#EXTINF:1,\np4.ts\n'
    await drive.put('/win.m3u8', Buffer.from(window2))

    async function serveWith (opts, targetExtra = {}) {
      const seen = []
      const handler = createDriveHandler((p) => {
        seen.push(p)
        return { drive, path: p, media: true, ...targetExtra }
      }, opts)
      const server = http.createServer(handler)
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      const base = `http://127.0.0.1:${server.address().port}`
      return { base, seen, close: () => new Promise((r) => server.close(r)) }
    }

    // A1 — cors OFF by default: the loopback server's responses are unchanged.
    {
      const s = await serveWith({})
      const r = await GET(`${s.base}/win.m3u8`)
      assert.strictEqual(r.status, 200, 'default handler serves the playlist')
      assert.strictEqual(r.headers['access-control-allow-origin'], undefined, 'cors is OFF by default — no ACAO')
      assert.strictEqual(r.headers['access-control-expose-headers'], undefined, 'cors is OFF by default — no Expose-Headers')
      await s.close()
    }
    // A2/A3/A4 — cors ON.
    {
      const s = await serveWith({ cors: true })
      const r = await GET(`${s.base}/win.m3u8`)
      assert.strictEqual(r.headers['access-control-allow-origin'], '*', 'cors: ACAO on a GET (the measured must-have)')
      assert.strictEqual(r.headers['access-control-allow-headers'], 'Range', 'cors: Allow-Headers names Range (not CORS-safelisted)')
      assert.ok(/Content-Range/.test(r.headers['access-control-expose-headers'] || ''), 'cors: Expose-Headers lets a receiver read Content-Range off a 206')
      const before = s.seen.length
      const opt = await request('OPTIONS', `${s.base}/win.m3u8`, { Origin: 'https://www.gstatic.com', 'Access-Control-Request-Headers': 'range' })
      assert.strictEqual(opt.status, 204, 'OPTIONS is answered 204')
      assert.strictEqual(opt.headers['access-control-allow-origin'], '*', 'preflight carries ACAO')
      assert.ok(/GET/.test(opt.headers['access-control-allow-methods'] || ''), 'preflight carries Allow-Methods (without it a preflight FAILS closed)')
      assert.strictEqual(s.seen.length, before, 'OPTIONS is answered BEFORE resolveTarget — no drive read at all')
      const miss = await GET(`${s.base}/nope.ts`)
      assert.strictEqual(miss.status, 404, 'a miss still 404s')
      assert.strictEqual(miss.headers['access-control-allow-origin'], '*', 'a 404 carries ACAO too, so the receiver can SEE the error')
      await s.close()
    }
    // A5 — the per-target reclaim opt-out (a cast-pinned drive), and the control case.
    {
      const optOut = await serveWith({ reclaim: true, reclaimIntervalMs: 0 }, { reclaim: false })
      const r = await GET(`${optOut.base}/win.m3u8`)
      assert.strictEqual(r.body.toString(), window2, 'opted-out target still serves normally')
      await sleep(600)
      assert.ok(await stored(blobRef[1]), 'target reclaim:false — blocks below the window are NOT freed')
      await optOut.close()

      const plain = await serveWith({ reclaim: true, reclaimIntervalMs: 0 })
      await GET(`${plain.base}/win.m3u8`)
      await waitFor(() => clearedAll(blobRef[1]), 10000, 'reclaim of the below-window blocks on a normal target')
      assert.ok(await clearedAll(blobRef[2]), 'control: the SAME handler does reclaim a target that did not opt out')
      assert.ok(await stored(blobRef[3]), 'the live window itself is untouched')
      await plain.close()
    }
    // A6 — the handler serves GET/HEAD and NOTHING else. Before this, POST/DELETE/TRACE
    // with a valid path all returned 200 with the full body while the preflight advertised
    // 'GET, HEAD, OPTIONS'. Nothing mutated (a drive handler has no write path), but a
    // media server must not answer verbs it tells the world it refuses.
    {
      const s = await serveWith({ cors: true })
      for (const method of ['POST', 'DELETE', 'PUT', 'TRACE', 'PATCH']) {
        const before = s.seen.length
        const r = await request(method, `${s.base}/win.m3u8`)
        assert.strictEqual(r.status, 405, `${method} is refused, not served`)
        assert.strictEqual(r.headers.allow, 'GET, HEAD, OPTIONS', `${method} 405 names what IS allowed (RFC 9110)`)
        assert.strictEqual(r.headers['access-control-allow-origin'], '*', `${method} 405 still carries ACAO so a receiver can see it`)
        assert.strictEqual(r.body.length, 'method not allowed'.length, `${method} returns no drive bytes`)
        assert.strictEqual(s.seen.length, before, `${method} never reaches resolveTarget — no drive read at all`)
      }
      assert.strictEqual((await request('HEAD', `${s.base}/win.m3u8`)).status, 200, 'HEAD is still served')
      await s.close()
      // cors OFF: the Allow list drops OPTIONS, because nothing answers it there.
      const plain = await serveWith({})
      const r = await request('POST', `${plain.base}/win.m3u8`)
      assert.strictEqual(r.status, 405, 'the loopback-shaped handler refuses POST too')
      assert.strictEqual(r.headers.allow, 'GET, HEAD', '…and advertises only what it serves')
      assert.strictEqual(r.headers['access-control-allow-origin'], undefined, '…still CORS-free')
      await plain.close()
    }
    await drive.close()
    log('A: serve core — cors off by default, on adds the headers (GET + 404), OPTIONS 204 before any drive read, per-target reclaim opt-out honoured, GET/HEAD only (405 + Allow) ✓')
  }

  // =========================================================================================
  // A2. THE LAN ADDRESS PICK — pure, a synthetic `os`, no drive and no swarm.
  //
  // This is the case a real host cannot be made to produce on demand, and it is the one that
  // matters most: the pick decides what the cast server BINDS to, so a wrong answer is not a
  // failed connection, it is an exposed one. RFC1918 is REQUIRED (it used to be merely
  // preferred, with `found[0]` as the fallback — so a box whose only non-internal IPv4 is
  // public advertised, and bound, an internet-reachable server for decrypted entitled content).
  // =========================================================================================
  {
    const withOs = (os) => new AliranPlayer({ panelPubKey: 'ab'.repeat(32), storeDir: dirs.pure, http, fs, os })

    // Multi-homed, public first: the private address must win, not the enumeration order.
    const multi = withOs(fakeOs({ eth0: [ifc('203.0.113.7')], wlan0: [ifc('192.168.1.104')], 'vEthernet': [ifc('172.25.64.1')] }))
    const pick = multi._lanAddress()
    assert.strictEqual(pick.address, '192.168.1.104', 'a public address never wins over a private one')
    assert.deepStrictEqual(pick.candidates, ['192.168.1.104', '172.25.64.1'], 'every private candidate is reported, in pick order, and the public one is not among them')

    // Two privates, no public: first wins, and BOTH are offered. os.networkInterfaces()
    // cannot tell Wi-Fi from a Hyper-V/Docker bridge or from carrier CGNAT, so the pick is
    // a guess — the candidate list is what lets a host recover from a wrong guess.
    const two = withOs(fakeOs({ wlan0: [ifc('192.168.1.104')], rmnet_data0: [ifc('10.108.7.2')] }))
    assert.deepStrictEqual(two._lanAddress(), { address: '192.168.1.104', candidates: ['192.168.1.104', '10.108.7.2'] },
      'a phone on Wi-Fi AND mobile data offers both — the pick is documented as a guess')

    // Public only: REFUSE. This is the blocker — the old code returned it.
    const publicOnly = withOs(fakeOs({ eth0: [ifc('203.0.113.7')] }))
    assert.throws(() => publicOnly._lanAddress(), /no private \(RFC1918\)/, 'a public-only host is refused, not advertised')
    assert.throws(() => publicOnly._lanAddress(), /advertiseHost/, '…and the refusal names the escape hatch')
    assert.throws(() => publicOnly._lanAddress(), /203\.0\.113\.7/, '…and names the address it refused, so the operator can judge')

    // APIPA (DHCP never answered) is not routable; loopback and IPv6 are not candidates.
    const apipa = withOs(fakeOs({
      eth0: [ifc('169.254.11.9')],
      lo: [ifc('127.0.0.1', { internal: true })],
      wlan0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, ifc('10.0.0.5')]
    }))
    assert.strictEqual(apipa._lanAddress().address, '10.0.0.5', 'APIPA, loopback and IPv6 are all skipped')
    const nothing = withOs(fakeOs({ eth0: [ifc('169.254.11.9')] }))
    assert.throws(() => nothing._lanAddress(), /no usable LAN IPv4/, 'nothing but APIPA is an actionable failure')
    assert.throws(() => withOs(fakeOs({}))._lanAddress(), /no usable LAN IPv4/, 'no interfaces at all is too')

    // `os` is OPTIONAL on the constructor — startCast() is the only caller, and it must say so.
    const noOs = new AliranPlayer({ panelPubKey: 'ab'.repeat(32), storeDir: dirs.pure, http, fs })
    assert.throws(() => noOs._lanAddress(), /injected `os` module/, 'a player built without os says what is missing')
    assert.throws(() => noOs._lanAddress(), /advertiseHost/, '…and how to cast anyway')
    log('A2: address pick — RFC1918 REQUIRED (public-only refused by name), private beats public, every candidate reported, APIPA/loopback/IPv6 skipped, missing os named ✓')
  }

  // =========================================================================================
  // Local DHT testnet + panel + a synthetic origin broadcaster.
  // =========================================================================================
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap
  log('testnet up:', JSON.stringify(bootstrap))

  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())

  // Origin broadcaster: two encrypted live feeds + a rolling HLS window each. Distinct
  // segment prefixes per channel ('a' / 'b') so section F can prove WHICH feed answered.
  const encKey = hcrypto.randomBytes(32)
  const encKeyHex = b4a.toString(encKey, 'hex')
  const originStore = new Corestore(dirs.origin); await originStore.ready(); cleanups.push(() => originStore.close())
  const originSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => originSwarm.destroy())
  originSwarm.on('connection', (s) => originStore.replicate(s))
  async function makeFeed (ns) {
    const drive = new Hyperdrive(originStore.namespace(ns), { encryptionKey: encKey })
    await drive.ready()
    originSwarm.join(drive.discoveryKey, { server: true, client: false })
    return drive
  }
  const feedA = await makeFeed('feedA')
  const feedB = await makeFeed('feedB')
  const feedC = await makeFeed('feedC') // ch1's post-restart feed — see section F2
  const seqs = new Map([[feedA, 0], [feedB, 0], [feedC, 0]])
  const SEG_BYTES = 24000
  async function appendSegment (drive, prefix) {
    const i = seqs.get(drive)
    seqs.set(drive, i + 1)
    const body = Buffer.alloc(SEG_BYTES); body.fill(`${prefix}#${i}|`)
    await drive.put(`/${prefix}${i}.ts`, body)
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${Math.max(0, i - 4)}`]
    for (let k = Math.max(0, i - 4); k <= i; k++) lines.push('#EXTINF:0.5,', `${prefix}${k}.ts`) // ← BARE RELATIVE NAMES, exactly as ffmpeg writes them
    await drive.put('/index.m3u8', b4a.from(lines.join('\n') + '\n'))
  }
  for (let i = 0; i < 3; i++) { await appendSegment(feedA, 'a'); await appendSegment(feedB, 'b'); await appendSegment(feedC, 'c') }
  let ticking = false
  const ticker = setInterval(() => {
    if (ticking) return
    ticking = true
    Promise.all([appendSegment(feedA, 'a'), appendSegment(feedB, 'b'), appendSegment(feedC, 'c')]).catch(() => {}).then(() => { ticking = false })
  }, 500)
  cleanups.push(() => clearInterval(ticker))

  // Panel records: two P2P live channels, one redirect channel, one the viewer is NOT
  // entitled to. REDIR_URL is never fetched — it only has to come back verbatim.
  const REDIR_URL = 'https://cdn.example.invalid/live/redir1/index.m3u8'
  await db.put('catalog/ch1', { title: 'Channel A', category: ['news'], type: 'live', feedKey: b4a.toString(feedA.key, 'hex'), isLive: true, poster: null, status: 'live' })
  await db.put('catalog/ch2', { title: 'Channel B', category: ['news'], type: 'live', feedKey: b4a.toString(feedB.key, 'hex'), isLive: true, poster: null, status: 'live' })
  await db.put('catalog/redir1', { title: 'Redirected', category: ['news'], type: 'live', redirect: true, url: REDIR_URL, headers: { referer: 'https://portal.example.invalid/' }, isLive: true, poster: null, status: 'live' })
  await db.put('catalog/locked', { title: 'Not Granted', category: ['news'], type: 'live', feedKey: b4a.toString(feedB.key, 'hex'), isLive: true, poster: null, status: 'live' })

  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt()
  const kp = userKeyPair()
  const auth = authKeyPair()
  const wk = wrapKeyFrom(rwd)
  await db.put('user/alice', {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(rwd, salt, ARGON2_DEFAULT), 'hex'),
    argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'),
    encPriv: wrap(wk, kp.secretKey),
    authPub: b4a.toString(auth.publicKey, 'hex'),
    authPrivEnc: wrap(wk, auth.secretKey),
    // 'locked' deliberately absent.
    wrapped: { ch1: sealTo(kp.publicKey, encKey), ch2: sealTo(kp.publicKey, encKey), redir1: sealTo(kp.publicKey, encKey) },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })
  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  const throttle = makeThrottle(1000, 60)
  const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000 }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()
  log('panel + origin up: ch1/ch2 live P2P, redir1 remote, `locked` ungranted')

  // ===== Headless viewer =====
  const player = createPlayer({ panelPubKey, storeDir: dirs.cli, swarm: { bootstrap } })
  cleanups.push(() => player.stop())
  await player.connect()
  let streams = null
  const deadline = Date.now() + 60000
  while (!streams) {
    if (Date.now() > deadline) throw new Error('timeout: SDK login')
    try {
      const s = await player.login('alice', PASSWORD)
      if (s.length >= 3) streams = s
    } catch (e) { if (!/not connected|unknown user/i.test(String(e.message))) throw e }
    if (!streams) await sleep(1000)
  }
  assert.ok(!streams.find((s) => s.id === 'locked'), 'the ungranted channel is not in the display list')
  log('sdk: login OK; entitled to', JSON.stringify(streams.map((s) => s.id)))

  // Play ch1 on the phone first — the realistic order, and it gives section E a live
  // loopback server and section F a _feedDrive to move.
  const played = await player.resolve('ch1')
  assert.strictEqual(played.source, 'p2p', 'ch1 plays P2P')
  const loopbackBase = `http://127.0.0.1:${played.port}`
  await waitFor(async () => (await GET(`${loopbackBase}/index.m3u8`)).status === 200, 60000, 'ch1 playlist replicated to the viewer')

  // =========================================================================================
  // B. LAN reach.
  // =========================================================================================
  const candidates = lanCandidates()
  assert.ok(candidates.length > 0, 'this host must have a private (RFC1918) IPv4 for the cast lane to mean anything (non-internal IPv4s: ' + JSON.stringify(lanIPv4()) + ')')
  const expectedHost = candidates[0] // exactly what _lanAddress() must return
  const cast = await player.startCast('ch1')
  assert.strictEqual(cast.streamId, 'ch1')
  assert.strictEqual(cast.source, 'p2p')
  assert.ok(/^[0-9a-f]{64}$/.test(cast.token), 'the token is 32 random bytes, hex')
  // EQUALITY, not membership — see the lanCandidates note above.
  assert.strictEqual(cast.host, expectedHost, 'startCast advertises exactly the engine pick (first private IPv4), got ' + cast.host + ' from ' + JSON.stringify(candidates))
  assert.ok(isPrivateIPv4(cast.host), 'the advertised address is RFC1918')
  assert.deepStrictEqual(cast.candidates, candidates, 'the session reports every private candidate, in pick order')
  assert.notStrictEqual(cast.host, '127.0.0.1', 'the whole point: the advertised host is NOT loopback')
  assert.strictEqual(cast.url, `http://${cast.host}:${cast.port}/cast/${cast.token}/index.m3u8`, 'URL shape')
  assert.notStrictEqual(cast.port, played.port, 'the cast server is a SECOND socket, not the loopback one re-bound')
  // ⚠ THE BIND, not just the advertisement. This server used to bind 0.0.0.0 with the token
  // as its only access control, so it also answered on the VPN tunnel, every container
  // bridge, the mobile-data interface — and on the public internet wherever one of those
  // was routable. It must be bound to the ONE address it advertises.
  const bound = player._castServer.address()
  assert.strictEqual(bound.address, cast.host, 'the cast server is BOUND to the advertised address, not 0.0.0.0')
  assert.strictEqual(bound.port, cast.port, '…on the advertised port')

  const pl = await waitFor(async () => {
    const r = await GET(cast.url)
    return r.status === 200 ? r : null
  }, 60000, 'the cast URL serves the playlist over the LAN interface')
  const playlistText = pl.body.toString()
  assert.ok(playlistText.startsWith('#EXTM3U'), 'the cast URL returns an HLS playlist')
  assert.ok(/^a\d+\.ts$/m.test(playlistText), 'it is CHANNEL A\'s playlist')
  assert.strictEqual(pl.headers['content-type'], 'application/vnd.apple.mpegurl', 'correct MIME for a playlist')
  log(`B: startCast -> ${cast.url.replace(cast.token, cast.token.slice(0, 8) + '…')} — 200 over ${cast.host} (non-loopback) ✓`)

  // The loopback server is still bound to loopback ONLY: the cast host must refuse it.
  await assert.rejects(() => GET(`http://${cast.host}:${played.port}/index.m3u8`), /ECONNREFUSED|ETIMEDOUT|timeout/i,
    'the loopback server must still be unreachable off 127.0.0.1 (its bind is unchanged)')
  log('B: the ORIGINAL loopback server is still unreachable on the LAN address ✓')

  // =========================================================================================
  // C. CORS on the wire.
  // =========================================================================================
  assert.strictEqual(pl.headers['access-control-allow-origin'], '*', 'cast GET carries ACAO — without it the measured receiver fetched ZERO segments')
  assert.strictEqual(pl.headers['access-control-allow-headers'], 'Range', 'cast GET carries Allow-Headers: Range')
  assert.ok(/Content-Range/.test(pl.headers['access-control-expose-headers'] || ''), 'cast GET exposes Content-Range')
  const pre = await request('OPTIONS', cast.url, { Origin: 'https://www.gstatic.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' })
  assert.strictEqual(pre.status, 204, 'the cast server answers a preflight 204')
  assert.ok(/GET/.test(pre.headers['access-control-allow-methods'] || ''), 'preflight carries Allow-Methods')
  log('C: cast responses carry ACAO / Allow-Headers / Expose-Headers; OPTIONS -> 204 ✓')

  // =========================================================================================
  // D. Relative segment URIs inherit the token prefix (no playlist rewriting).
  // =========================================================================================
  const segUri = playlistText.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  assert.ok(segUri && !segUri.includes('/'), 'the served playlist carries a BARE relative segment name, got ' + JSON.stringify(segUri))
  const segUrl = new URL(segUri, cast.url).toString() // exactly what a receiver does (RFC 3986)
  assert.ok(new URL(segUrl).pathname.startsWith(`/cast/${cast.token}/`), 'relative resolution lands INSIDE the token prefix: ' + new URL(segUrl).pathname)
  const segRes = await waitFor(async () => {
    const r = await GET(segUrl)
    return r.status === 200 ? r : null
  }, 30000, 'the relatively-resolved segment fetches')
  assert.strictEqual(segRes.body.length, SEG_BYTES, 'the whole segment came back')
  assert.strictEqual(segRes.headers['content-type'], 'video/mp2t', 'segment MIME')
  assert.strictEqual(segRes.headers['accept-ranges'], 'bytes', 'Range support advertised')
  assert.strictEqual(segRes.headers['access-control-allow-origin'], '*', 'segments are CORS-enabled too (this is what actually plays)')
  // Range still works on the cast server (that firmware did not use it; others will).
  const ranged = await GET(segUrl, { Range: 'bytes=0-99' })
  assert.strictEqual(ranged.status, 206, 'Range -> 206 on the cast server')
  assert.strictEqual(ranged.body.length, 100, '206 body is exactly the requested slice')
  assert.strictEqual(ranged.headers['content-range'], `bytes 0-99/${SEG_BYTES}`, 'Content-Range math')
  // ⚠ the resolved pathname carries the LIVE token — mask it. A throwaway testnet makes this
  // harmless here, but WP5 and every lane after it will copy whatever shape this one sets.
  const maskedSegPath = new URL(segUrl).pathname.replace(cast.token, cast.token.slice(0, 8) + '…')
  log(`D: '${segUri}' resolved to ${maskedSegPath} and served ${segRes.body.length} bytes (206 slice OK) — no playlist rewriting needed ✓`)

  // =========================================================================================
  // E. The token IS the boundary.
  // =========================================================================================
  const wrongToken = b4a.toString(hcrypto.randomBytes(32), 'hex')
  assert.strictEqual((await GET(`http://${cast.host}:${cast.port}/cast/${wrongToken}/index.m3u8`)).status, 404, 'a WRONG token 404s')
  assert.strictEqual((await GET(`http://${cast.host}:${cast.port}/cast/${cast.token.slice(0, 32)}/index.m3u8`)).status, 404, 'a TRUNCATED token 404s')
  assert.strictEqual((await GET(`http://${cast.host}:${cast.port}/cast//index.m3u8`)).status, 404, 'an EMPTY token 404s')
  assert.strictEqual((await GET(`http://${cast.host}:${cast.port}/index.m3u8`)).status, 404, 'the cast server serves NOTHING outside /cast/<token>/')
  assert.strictEqual((await GET(`http://${cast.host}:${cast.port}/feedthumb/ch1`)).status, 404, '…not the thumbnail route either')
  assert.strictEqual((await GET(`http://${cast.host}:${cast.port}/assets/x.png`)).status, 404, '…nor the asset route')
  // And the loopback server refuses /cast/* even with the RIGHT token.
  assert.strictEqual((await GET(`${loopbackBase}/cast/${cast.token}/index.m3u8`)).status, 404, 'the LOOPBACK server refuses /cast/* (the two surfaces stay separate)')
  const loop = await GET(`${loopbackBase}/index.m3u8`)
  assert.strictEqual(loop.status, 200, 'the loopback server still serves normal playback')
  assert.strictEqual(loop.headers['access-control-allow-origin'], undefined, 'the loopback server gained NO CORS headers (cors is off by default)')
  log('E: wrong/truncated/empty token 404; the cast server serves nothing else; loopback refuses /cast/* and stays CORS-free ✓')

  // =========================================================================================
  // F. The feed is pinned — zapping the phone must not move the receiver.
  // =========================================================================================
  const zapped = await player.resolve('ch2')
  assert.strictEqual(zapped.source, 'p2p', 'the phone zapped to ch2')
  await waitFor(async () => /^b\d+\.ts$/m.test((await GET(`${loopbackBase}/index.m3u8`)).body.toString()), 60000, 'loopback follows the zap to channel B')
  const stillA = await GET(cast.url)
  assert.strictEqual(stillA.status, 200, 'the cast URL still answers after the phone zapped away')
  const castBody = stillA.body.toString()
  assert.ok(/^a\d+\.ts$/m.test(castBody), 'the cast URL still serves CHANNEL A')
  assert.ok(!/^b\d+\.ts$/m.test(castBody), 'the cast URL did NOT follow the phone to channel B')
  assert.strictEqual(player.castSession().streamId, 'ch1', 'castSession() still names the pinned channel')
  log('F: phone on ch2, receiver still on ch1 — the cast drive is pinned, not _feedDrive ✓')

  // =========================================================================================
  // F2. Pinned to the CHANNEL, not to a Hyperdrive: a broadcaster restart rotates ch1 onto
  // a new feedKey, and the cast must follow it. The old feed is dead — a pin left behind
  // would serve a playlist that never advances again, which looks exactly like a stall.
  // =========================================================================================
  await player.resolve('ch1') // the rotation follow only tracks the ACTIVE stream
  await waitFor(async () => /^a\d+\.ts$/m.test((await GET(`${loopbackBase}/index.m3u8`)).body.toString()), 60000, 'phone back on ch1')
  await db.put('catalog/ch1', { title: 'Channel A', category: ['news'], type: 'live', feedKey: b4a.toString(feedC.key, 'hex'), isLive: true, poster: null, status: 'live' })
  await waitFor(async () => /^c\d+\.ts$/m.test((await GET(`${loopbackBase}/index.m3u8`)).body.toString()), 90000, 'the engine followed ch1 onto its rotated feed')
  const afterRotate = await waitFor(async () => {
    const r = await GET(cast.url)
    return r.status === 200 && /^c\d+\.ts$/m.test(r.body.toString()) ? r : null
  }, 60000, 'the cast session followed the rotation onto the live feed')
  assert.ok(!/^a\d+\.ts$/m.test(afterRotate.body.toString()), 'the cast is no longer serving the DEAD pre-restart feed')
  assert.strictEqual(player.castSession().streamId, 'ch1', 'the session still names the same channel')
  assert.strictEqual(player.castSession().feedKey, b4a.toString(feedC.key, 'hex'), 'castSession() reports the rotated feedKey')
  assert.strictEqual(player.castSession().url, cast.url, 'the receiver keeps the SAME URL across the rotation')
  log('F2: ch1 rotated to a new feedKey mid-cast — the session followed it on the unchanged URL ✓')

  // =========================================================================================
  // G. stopCast().
  // =========================================================================================
  const castServer = player._castServer // held so the post-close bind state can be inspected
  const stopped = await player.stopCast()
  assert.strictEqual(stopped, true, 'stopCast() reports it ended a session')
  assert.strictEqual(player.castSession(), null, 'castSession() is null after stop')
  // ⚠ THE PORT IS ACTUALLY RELEASED. node:http unbinds synchronously inside close(); Bare's
  // does NOT (bare-tcp's Server.close only calls binding.close on the listener once its
  // connection set drains — see _closeCastServer), which is why stopCast() hangs the sockets
  // up first and bounds the wait. This lane runs on Node, where `listening` is honest.
  assert.strictEqual(castServer.listening, false, 'the listener is UNBOUND after stopCast(), not merely forgotten')
  assert.strictEqual(player._castServer, null, 'and the engine dropped its reference')
  await assert.rejects(() => GET(cast.url), /ECONNREFUSED|ECONNRESET|socket hang up|timeout/i, 'the cast URL stops answering entirely')
  assert.strictEqual(await player.stopCast(), false, 'stopCast() is idempotent')
  // A fresh session gets a fresh port AND a fresh token — the old URL can never come back.
  const cast2 = await player.startCast('ch1')
  assert.notStrictEqual(cast2.token, cast.token, 'a new session mints a new token')
  assert.strictEqual((await GET(`http://${cast2.host}:${cast2.port}/cast/${cast.token}/index.m3u8`)).status, 404, 'the PREVIOUS token is dead on the new server')
  // A double-tapped Cast button must not leave two servers behind: the calls serialize,
  // the LAST one wins, and every earlier session's socket is already gone. (Ports are
  // ephemeral, so raceA/raceB CAN legitimately land on the same number — the kernel is free
  // to hand back a port stopCast() just released. What must hold is that only one listener
  // exists and it is the last one; asserting the ports differ would be asserting an OS
  // allocation policy.)
  const [raceA, raceB] = await Promise.all([player.startCast('ch1'), player.startCast('ch1')])
  assert.notStrictEqual(raceA.token, raceB.token, 'two concurrent starts really did run as two sessions')
  const live = player.castSession()
  assert.ok(live && live.token === raceB.token, 'the LAST start owns the live session')
  assert.strictEqual((await GET(raceB.url)).status, 200, 'the surviving session serves')
  // The superseded session is dead whether or not its port was recycled: on a fresh port the
  // socket is gone; on a recycled one the token no longer resolves.
  const supersededA = await GET(raceA.url).catch((err) => ({ status: 'refused: ' + err.code }))
  assert.ok(supersededA.status === 404 || String(supersededA.status).startsWith('refused'),
    'the superseded session serves nothing (got ' + supersededA.status + ')')

  // advertiseHost: the escape hatch, and the ONE case where a bind can widen back to
  // 0.0.0.0 — but only when the host names something this device does not own.
  const cast3 = await player.startCast('ch1', { advertiseHost: '127.0.0.1' })
  assert.strictEqual(cast3.host, '127.0.0.1', 'advertiseHost overrides the LAN auto-pick')
  assert.strictEqual(player._castServer.address().address, '127.0.0.1', 'a literal this device OWNS is bound directly — not 0.0.0.0')
  assert.strictEqual(cast3.candidates, undefined, 'an explicit advertiseHost reports no candidate list — the host already chose')
  assert.strictEqual((await GET(cast3.url)).status, 200, '…and it answers there')
  const cast4 = await player.startCast('ch1', { advertiseHost: 'cast.example.invalid' })
  assert.strictEqual(player._castServer.address().address, '0.0.0.0', 'a hostname this device cannot bind falls back to 0.0.0.0 — the caller asked for it')
  assert.ok(cast4.url.startsWith('http://cast.example.invalid:'), '…and the URL advertises the name')
  // advertiseHost is unvalidated no more: it becomes the AUTHORITY of a token-bearing URL.
  // `evil.example/x?` yielded http://evil.example/x?:PORT/cast/<token>/… — a valid URL that
  // hands the session token to a third party as a query string.
  for (const bad of ['evil.example/x?', 'evil.example/', 'a b', 'user@evil.example', 'http://evil.example', '192.168.1.5:9', '']) {
    await assert.rejects(() => player.startCast('ch1', { advertiseHost: bad }), /advertiseHost must be/,
      'advertiseHost ' + JSON.stringify(bad) + ' is refused before any URL is built')
  }
  assert.ok(player.castSession(), 'a refused advertiseHost leaves the live session alone')
  await player.stopCast()
  log('G: stopCast hangs up, closes AND unbinds; new session = new token; concurrent starts serialize; advertiseHost bound when owned, validated always ✓')

  // =========================================================================================
  // G2. Per-session knobs, and the session shape while it is being built.
  // =========================================================================================
  {
    // startCast({ readIdleMs }) / ({ reclaim: true }) reach the handler that serves the
    // session — they are the two documented per-session overrides and nothing asserted them.
    const idle = await player.startCast('ch1', { readIdleMs: 0, reclaim: true })
    assert.strictEqual((await GET(idle.url)).status, 200, 'a session with the stalled-read abort OFF and reclaim ON still serves')
    await player.stopCast()
    const dflt = await player.startCast('ch1', { readIdleMs: -5 })
    assert.strictEqual((await GET(dflt.url)).status, 200, 'a nonsense readIdleMs falls back to the default rather than failing the cast')
    await player.stopCast()

    // castSession() must never expose a half-built session. this._cast used to be published
    // BEFORE the bind, so a caller reading it mid-start saw { url: null, port: null } — a
    // shape sdk/index.d.ts declares impossible (url: string). Polling from outside cannot
    // observe that window reliably (it closes in the same tick the promise resolves), so
    // look from INSIDE it: _startCastServer runs after the pin and before the bind.
    const realStartServer = player._startCastServer
    let midBuild = 'never ran'
    player._startCastServer = function (...args) {
      midBuild = player.castSession()
      return realStartServer.apply(this, args)
    }
    const built = await player.startCast('ch1')
    player._startCastServer = realStartServer
    assert.strictEqual(midBuild, null, 'castSession() exposes NOTHING until the bind succeeds — it used to expose { url: null, port: null }')
    assert.strictEqual(typeof built.url, 'string', 'the resolved session has a url')
    assert.strictEqual(typeof player.castSession().url, 'string', '…and so does the published one')
    await player.stopCast()

    // The listen() failure path — the one error path the teardown did not cover. _castServer
    // was assigned only AFTER a successful bind, so a rejected listen left a fully
    // constructed server that _doStopCast could never find, let alone close.
    const realBind = player._bindAddress
    player._bindAddress = () => '203.0.113.7' // TEST-NET-3: never an address of this device
    await assert.rejects(() => player.startCast('ch1'), /EADDRNOTAVAIL|EACCES|EINVAL|EADDRINUSE/i, 'a bind that cannot succeed rejects')
    player._bindAddress = realBind
    assert.strictEqual(player._castServer, null, 'a failed bind leaves NO server object behind')
    assert.strictEqual(player._castSockets, null, '…and no socket set')
    assert.strictEqual(player.castSession(), null, '…and no session')
    assert.strictEqual(player._castFeedKey, null, '…and no pinned feed')
    log('G2: readIdleMs/reclaim overrides serve; castSession() is never half-built; a failed bind leaves nothing behind ✓')
  }

  // =========================================================================================
  // G3. THE RECEIVER PIN (opt-in). The token is a session SCOPE, not a secret the network
  // keeps: measured on a TCL Google TV (CrKey/1.56.500000) running the stock Default Media
  // Receiver, a separate process that had never seen the cast URL and presented NO
  // credential connected on port 8009, joined the running session and read contentId — the
  // full media URL, token and all. So on a shared network the effective boundary was
  // "anyone who can reach the TV". Pinning adds the receiver's ADDRESS to it: recovering the
  // URL is then not enough, an attacker also has to answer as the TV.
  //
  // Both directions are testable here without two NICs: the server is bound to the LAN
  // address, so a local request to it arrives FROM that address.
  // =========================================================================================
  {
    const unpinned = await player.startCast('ch1')
    assert.strictEqual(unpinned.receiverHost, undefined, 'unset by default — no pin')
    assert.strictEqual(player.castSession().receiverHost, undefined, '…and castSession() says so')
    assert.strictEqual((await GET(unpinned.url)).status, 200, 'an unpinned session serves any peer, exactly as before')
    await player.stopCast()

    // Pinned to THIS host's own LAN address: the requests below originate there.
    const pinned = await player.startCast('ch1', { receiverHost: expectedHost })
    assert.deepStrictEqual(pinned.receiverHost, [expectedHost], 'the session reports its pin, normalised')
    assert.deepStrictEqual(player.castSession().receiverHost, [expectedHost], '…and so does castSession()')
    assert.strictEqual((await GET(pinned.url)).status, 200, 'the PINNED peer is served')
    await player.stopCast()

    // Pinned elsewhere: same URL, same valid token, refused.
    const elsewhere = await player.startCast('ch1', { receiverHost: '10.99.99.99' })
    const refused = await GET(elsewhere.url)
    assert.strictEqual(refused.status, 404, 'a peer that is not the pinned receiver gets 404')
    assert.notStrictEqual(refused.status, 403, '…never a 403 — a refusal must not confirm the path exists')
    // Byte-identical to a wrong-token refusal: the two must not be distinguishable.
    const wrongTok = await GET(`http://${elsewhere.host}:${elsewhere.port}/cast/${'0'.repeat(64)}/index.m3u8`)
    assert.strictEqual(refused.status, wrongTok.status, 'a wrong ADDRESS and a wrong TOKEN answer with the same status')
    assert.strictEqual(refused.body.toString(), wrongTok.body.toString(), '…and the same body')
    assert.strictEqual(refused.headers['access-control-allow-origin'], wrongTok.headers['access-control-allow-origin'], '…and the same headers')
    // The preflight is deliberately NOT gated (same call as the token: it reveals nothing,
    // and gating it would turn a plain 404 into an opaque CORS error on a TV console).
    assert.strictEqual((await request('OPTIONS', elsewhere.url, { Origin: 'https://www.gstatic.com' })).status, 204, 'OPTIONS is still answered on a pinned session')
    await player.stopCast()

    // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is the form a dual-stack listener reports for an
    // IPv4 peer — it must normalise to the same address, or the pin silently never matches.
    const mapped = await player.startCast('ch1', { receiverHost: `::ffff:${expectedHost}` })
    assert.deepStrictEqual(mapped.receiverHost, [expectedHost], 'an IPv4-mapped pin normalises to the plain IPv4')
    assert.strictEqual((await GET(mapped.url)).status, 200, '…and still matches the peer')
    await player.stopCast()

    // An array — a multi-room GROUP fetches from every member, so one address is not enough.
    const group = await player.startCast('ch1', { receiverHost: ['10.99.99.99', expectedHost, '10.99.99.99'] })
    assert.deepStrictEqual(group.receiverHost, ['10.99.99.99', expectedHost], 'an array pins every member, de-duplicated')
    assert.strictEqual((await GET(group.url)).status, 200, 'any listed member is served')
    await player.stopCast()

    // A hostname would need a DNS round trip per request; a pin that never matches is
    // indistinguishable from a cast that simply does not work. Refuse it on the call.
    for (const bad of ['tv.local', 'not-an-ip', '999.1.1.1', '1234', 'abcd', '192.168.1.5:8009', '', 7]) {
      await assert.rejects(() => player.startCast('ch1', { receiverHost: bad }), /receiverHost must be an IP address/,
        'receiverHost ' + JSON.stringify(bad) + ' is refused on the call')
    }
    assert.strictEqual(player.castSession(), null, 'a refused receiverHost stood up no session')
    log('G3: receiver pin — pinned peer served, any other peer 404s identically to a wrong token, IPv4-mapped normalised, groups take an array, unpinned unchanged ✓')
  }

  // =========================================================================================
  // H. Redirect channels — no server at all.
  // =========================================================================================
  const redir = await player.startCast('redir1')
  assert.strictEqual(redir.url, REDIR_URL, 'a redirect channel casts the operator-set remote URL verbatim')
  assert.strictEqual(redir.source, 'cdn', "…flagged 'cdn'")
  assert.strictEqual(redir.port, undefined, '…with no port')
  assert.strictEqual(redir.token, undefined, '…and no token')
  assert.strictEqual(redir.feedKey, null, '…and no feed')
  assert.deepStrictEqual(redir.headers, { referer: 'https://portal.example.invalid/' }, '…carrying the provider hotlink headers, like resolve() does')
  assert.strictEqual(player._castServer, null, 'no LAN server was stood up for a redirect channel')
  await player.stopCast()

  await assert.rejects(() => player.startCast('locked'), /not entitled/, 'an ungranted channel cannot be cast')
  await assert.rejects(() => player.startCast('nope'), /not entitled/, 'an unknown channel cannot be cast')
  log('H: redirect channel casts its remote URL with no server; ungranted/unknown ids refused ✓')

  // =========================================================================================
  // H2. hybrid.mode 'cdn-only' means NEVER OPEN P2P — and startCast() used to ignore it
  // outright: it opened a Hyperdrive, joined a swarm topic and replicated on a host that had
  // configured the exact opposite. resolve() honours the mode and so does _thumbTarget; this
  // is the mirror. White-box on purpose: the mode is a constructor option, and a second
  // logged-in player would cost a second device slot and a second OPRF login to assert one
  // early return. The engine is restored immediately after.
  // =========================================================================================
  {
    const saved = player._hybrid
    player._hybrid = { ...saved, mode: 'cdn-only', cdnUrl: (id) => `https://cdn.example.invalid/cdnonly/${id}.m3u8` }
    const feedsBefore = player._feeds.size
    try {
      const cdn = await player.startCast('ch1')
      assert.strictEqual(cdn.url, 'https://cdn.example.invalid/cdnonly/ch1.m3u8', "cdn-only casts the operator's own cdnUrl, exactly as resolve() does")
      assert.strictEqual(cdn.source, 'cdn', "…flagged 'cdn'")
      assert.strictEqual(cdn.port, undefined, '…with no port')
      assert.strictEqual(cdn.token, undefined, '…and no token')
      assert.strictEqual(player._castServer, null, 'NO LAN server is stood up on a cdn-only host')
      assert.strictEqual(player._feeds.size, feedsBefore, '…and NO new feed was opened — that is what "never open P2P" means')
      assert.strictEqual(player.castSession().source, 'cdn', 'castSession() reports the cdn session')
      await player.stopCast()
      // A redirect channel still wins over the template — same order resolve() uses.
      const both = await player.startCast('redir1')
      assert.strictEqual(both.url, REDIR_URL, "a redirect channel's own URL beats the cdn-only template")
      await player.stopCast()
    } finally { player._hybrid = saved }
    log('H2: cdn-only casts the CDN URL, opens no drive and stands up no server; redirect still wins ✓')
  }

  // =========================================================================================
  // I. A SESSION THAT DIES ON ITS OWN. Two engine paths null the pinned drive without the
  // host asking: the tune ladder's final rung purges the replica (_evictFeed — and it fires
  // while the phone is ON the cast channel, so it is not the documented "zapped away" limit),
  // and a zap that lands mid-retune abandons the reopen. Both used to leave a ZOMBIE:
  // everything 404ing forever, castSession() still handing out a live-looking url + token,
  // and the LAN listener still bound for the life of the process — with no event to tell the
  // host any of it. Last, because it purges ch1's replica.
  // =========================================================================================
  {
    const zombie = await player.startCast('ch1')
    assert.strictEqual((await GET(zombie.url)).status, 200, 'the session serves before we kill its feed')
    const server = player._castServer
    const ended = new Promise((resolve) => player.once('cast', resolve))
    // Exactly what the tune ladder's last rung does when it gives up (see _startTuneWatchdog).
    player._evictFeed(player.castSession().feedKey + ':' + encKeyHex)
    const ev = await Promise.race([ended, sleep(15000).then(() => null)])
    assert.ok(ev, "the engine EMITS 'cast' when the session dies on its own (it used to emit nothing at all)")
    assert.strictEqual(ev.state, 'ended', "…state 'ended'")
    assert.strictEqual(ev.reason, 'feed-evicted', '…naming the cause')
    assert.strictEqual(ev.streamId, 'ch1', '…and the channel')
    assert.strictEqual(player.castSession(), null, 'castSession() stops handing out a dead url + token')
    assert.strictEqual(player._castServer, null, 'the engine dropped the server')
    assert.strictEqual(server.listening, false, 'and the LAN listener is UNBOUND — it used to stay bound for the process lifetime')
    await assert.rejects(() => GET(zombie.url), /ECONNREFUSED|ECONNRESET|socket hang up|timeout/i, 'the zombie URL answers nothing at all now')
    log('I: an evicted feed ENDS the cast — socket closed, state cleared, host told ✓')
  }

  // Teardown must not leave the LAN socket behind.
  await player.startCast('ch2') // ch1's replica was purged above; ch2 is warm
  await player.stop()
  assert.strictEqual(player._castServer, null, 'stop() tears the cast server down too')

  log('\nRESULT: PASS ✅  (cors opt-in + OPTIONS + GET/HEAD-only + per-target reclaim opt-out; RFC1918-required address pick BOUND to the advertised address; relative segments inherit the token prefix; wrong token 404s; the opt-in receiver pin refuses every other peer the same way; loopback untouched and still refuses /cast/*; pinned feed survives a zap; stopCast closes AND unbinds; a self-terminating session emits and tears down; redirect + cdn-only need no server)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
