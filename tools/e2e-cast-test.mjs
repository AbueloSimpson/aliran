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
//      `reclaim: false` opt-out: the same reclaim-enabled handler must free a normal
//      target's expired blocks and leave an opted-out (cast-pinned) drive's alone.
//   B  LAN REACH — a headless player logs in over a local DHT testnet, startCast() returns
//      an http:// URL on a NON-LOOPBACK IPv4, and fetching it from off the loopback
//      interface answers 200 with the channel's live playlist.
//   C  CORS ON THE WIRE — the real cast server's GET carries the headers a Cast receiver
//      needs (without ACAO the measured TCL Terraza fetched the playlist and then ZERO
//      segments), and OPTIONS answers 204 with Allow-Methods.
//   D  RELATIVE SEGMENTS INHERIT THE TOKEN — ⚠ THE LOAD-BEARING ONE. The playlist is
//      served verbatim, so its bare `segN.ts` URIs must resolve against
//      …/cast/<token>/index.m3u8 into …/cast/<token>/segN.ts and fetch. If this breaks,
//      the feature needs per-request playlist rewriting.
//   E  THE TOKEN IS THE BOUNDARY — a wrong token, a truncated token and a bare path all
//      404 on the LAN server; the LOOPBACK server refuses /cast/* even with the right
//      token, and its own responses still carry no CORS headers.
//   F  THE FEED IS PINNED — zapping the phone to another channel mid-cast must NOT move
//      the receiver's stream. The loopback route follows _feedDrive on every zap; the
//      cast route must not. F2: pinned to the CHANNEL though, not to a Hyperdrive — a
//      broadcaster restart rotates the channel onto a new feedKey and the session must
//      follow it on the unchanged URL, or the receiver sits on a feed that is dead.
//   G  STOP — stopCast() hangs up the socket and the URL stops answering entirely.
//   H  REDIRECT CHANNELS — an operator-set remote https URL casts with NO server at all.
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
import { createPlayer } from '../sdk/index.js'

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

// The same pick the engine makes (sdk/player.js _lanAddress), recomputed here so the test
// asserts against an independently derived address rather than against the engine's own answer.
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
    await drive.close()
    log('A: serve core — cors off by default, on adds the headers (GET + 404), OPTIONS 204 before any drive read, per-target reclaim opt-out honoured ✓')
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
  const lan = lanIPv4()
  assert.ok(lan.length > 0, 'this host must have a non-loopback IPv4 for the cast lane to mean anything (interfaces: ' + JSON.stringify(Object.keys(os.networkInterfaces())) + ')')
  const cast = await player.startCast('ch1')
  assert.strictEqual(cast.streamId, 'ch1')
  assert.strictEqual(cast.source, 'p2p')
  assert.ok(/^[0-9a-f]{64}$/.test(cast.token), 'the token is 32 random bytes, hex: ' + cast.token)
  assert.ok(lan.includes(cast.host), 'startCast advertises a real non-loopback IPv4 of this host, got ' + cast.host)
  assert.notStrictEqual(cast.host, '127.0.0.1', 'the whole point: the advertised host is NOT loopback')
  assert.strictEqual(cast.url, `http://${cast.host}:${cast.port}/cast/${cast.token}/index.m3u8`, 'URL shape')
  assert.notStrictEqual(cast.port, played.port, 'the cast server is a SECOND socket, not the loopback one re-bound')

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
  log(`D: '${segUri}' resolved to ${new URL(segUrl).pathname} and served ${segRes.body.length} bytes (206 slice OK) — no playlist rewriting needed ✓`)

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
  const stopped = await player.stopCast()
  assert.strictEqual(stopped, true, 'stopCast() reports it ended a session')
  assert.strictEqual(player.castSession(), null, 'castSession() is null after stop')
  await assert.rejects(() => GET(cast.url), /ECONNREFUSED|ECONNRESET|socket hang up|timeout/i, 'the cast URL stops answering entirely')
  assert.strictEqual(await player.stopCast(), false, 'stopCast() is idempotent')
  // A fresh session gets a fresh port AND a fresh token — the old URL can never come back.
  const cast2 = await player.startCast('ch1')
  assert.notStrictEqual(cast2.token, cast.token, 'a new session mints a new token')
  assert.strictEqual((await GET(`http://${cast2.host}:${cast2.port}/cast/${cast.token}/index.m3u8`)).status, 404, 'the PREVIOUS token is dead on the new server')
  // A double-tapped Cast button must not leave two servers behind: the calls serialize,
  // the LAST one wins, and every earlier session's socket is already gone.
  const [raceA, raceB] = await Promise.all([player.startCast('ch1'), player.startCast('ch1')])
  assert.notStrictEqual(raceA.port, raceB.port, 'two concurrent starts really did run as two sessions')
  const live = player.castSession()
  assert.ok(live && live.port === raceB.port, 'the LAST start owns the live session')
  assert.strictEqual((await GET(raceB.url)).status, 200, 'the surviving session serves')
  await assert.rejects(() => GET(raceA.url), /ECONNREFUSED|ECONNRESET|socket hang up|timeout/i, 'the superseded session left no listening socket')
  // advertiseHost overrides the auto-pick (multi-homed hosts / VPN interfaces).
  const cast3 = await player.startCast('ch1', { advertiseHost: '127.0.0.1' })
  assert.strictEqual(cast3.host, '127.0.0.1', 'advertiseHost overrides the LAN auto-pick')
  assert.strictEqual((await GET(cast3.url)).status, 200, '…and the 0.0.0.0 bind still answers on it')
  await player.stopCast()
  log('G: stopCast hangs up + closes; a new session = new port + new token; concurrent starts serialize; advertiseHost honoured ✓')

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

  // Teardown must not leave the LAN socket behind.
  await player.startCast('ch1')
  await player.stop()
  assert.strictEqual(player._castServer, null, 'stop() tears the cast server down too')

  log('\nRESULT: PASS ✅  (cors opt-in + OPTIONS + per-target reclaim opt-out; LAN-reachable token-scoped cast server; relative segments inherit the token prefix; wrong token 404s; loopback untouched and still refuses /cast/*; pinned feed survives a zap; stopCast closes; redirect channels need no server)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
