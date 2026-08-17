// Ephemeral event channels, the VIEWER half (S57). npm run test:events-client
//
// tools/e2e-events-test.mjs proves the server side: an `ephemeral` source's sync appends
// ZERO blocks and ZERO bytes to the panel's signed bee because its channels go into an
// epoch-rotated Hyperdrive instead. That feature is switched OFF in production for exactly
// one reason — viewers could not read the drive. This is the lane that says they can.
//
// WHAT IS UNDER TEST, and every leg is a real client: sdk/player.js, a real corestore
// replica, a real (private) DHT testnet, real ffmpeg bytes.
//
//   A  NO DRIVE = NO CHANGE. A panel with zero ephemeral sources gives the viewer exactly
//      today's lineup, no error, no empty emission — and MEASURABLY costs nothing: the
//      engine never reads meta/eventsKey, never opens a drive, never joins a topic. This
//      is the state the code ships into and the single most likely way to break everyone.
//   B  catalog ∪ events, with the CATALOG winning a colliding id (panel/src/packages.js
//      resolutionSnapshot's precedence, from the client side) — for an id the viewer is
//      GRANTED, which is the safe half.
//   B2 THE CROSSING, which is the other half: an id admitted ONLY by `eventSources`, whose
//      catalog record the viewer holds no grant for. Unguarded, resolve() re-read that
//      record and handed over an operator's premium url, its bearer token and playback past
//      a restricted:true parental gate. Refused now, in both playback doors, and the lineup
//      stops offering what it will refuse.
//   B3 …and the panel refuses to CREATE that collision — addStream and an ordinary source's
//      applyFeed now consult the events drive the way applyEphemeral consults the catalog.
//   C  a viewer not entitled to a source never receives — or even FETCHES — its shard.
//   D  EPOCH ROTATION. The pointer flips to a new drive, the old one is purged off the
//      panel, and the viewer follows the swap and keeps serving. This is the
//      _openEpg-vs-_doOpenAssets distinction and it is a real gate: an open that cannot
//      follow a swap passes the first half and fails the second.
//   E  a drive-sourced channel RESOLVES AND PLAYS — the playlist and a real .ts segment
//      fetched from the url resolve() returned, ffprobe'd, same standard as e2e-sdk-test.
//   F  NO TRUNCATED LINEUP, EVER. Every 'streams' emission of every player is instrumented
//      from before login; none may be empty and none may lose an id the run has
//      established — including while the drive is opening and while it is rotating.
//   G  a missing, malformed, truncated or count-mismatched shard does not take the lineup
//      down, and costs only its OWN source's freshness — plus the two properties that make
//      that safe rather than merely survivable: a PARKED events drive costs a catalog push
//      nothing (measured; awaiting the read "concurrently" measured 12,003 ms of a 30 s
//      ceiling), and abandoned reads do not accumulate.
//   H  entitlement is followed live, in both directions, off the signed user record.
//
// Local-only and deterministic: a private DHT testnet, loopback HTTP for the feed and the
// provider, temp dirs, full cleanup. Requires ffmpeg/ffprobe on PATH (leg E).
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import http from 'http'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { spawnSync } from 'child_process'
import createTestnet from 'hyperdht/testnet.js'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT
} from '@aliran/core'
import { startFfmpeg, mirrorDirToDrive } from '../broadcaster/src/hls.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeRing } from '../panel/src/activity.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import * as ops from '../panel/src/ops.js'
import * as sources from '../panel/src/sources.js'
import * as packages from '../panel/src/packages.js'
import { createPlayer } from '../sdk/index.js'

const log = (...a) => console.log(...a)
const MiB = 1024 * 1024
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms, label) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(250) }
  throw new Error('timeout: ' + label)
}
function httpGet (port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}
async function assertRejects (fn, re, label) {
  let msg = null
  try { await fn() } catch (e) { msg = String(e.message) }
  if (msg === null) throw new Error(label + ' must reject, but it resolved')
  if (!re.test(msg)) throw new Error(label + ' rejected with the wrong error: ' + msg)
}

let failures = 0
function ok (cond, msg) {
  if (cond) log('  ok  ' + msg)
  else { failures++; log('  FAIL ' + msg) }
}

const DIFFICULTY = 8
const PASSWORD = 'test123'
const EVENTS_READ_MS_DEFAULT = createPlayer({ panelPubKey: 'a'.repeat(64), storeDir: os.tmpdir() })._eventsReadMs // the shipped bound, so leg G can restore it
const dirs = []
const mkdir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d }
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

// --- the "no lineup may ever shrink" instrument -------------------------------------------
//
// Armed BEFORE login on every player, so it also covers the login emission and the window
// while the events drive is still opening. The floor is raised as the run establishes what a
// viewer must be able to see, and lowered ONLY where a leg deliberately removes entitlement —
// which is announced in the log, so a silent shrink can never be mistaken for an intended one.
function instrument (player, tag) {
  const st = { tag, floor: new Set(), label: 'pre-login', emissions: 0, empty: 0, bad: [], last: new Set(), sizes: [] }
  player.on('streams', (list) => {
    st.emissions++
    const ids = new Set(list.map((s) => s.id))
    st.sizes.push(list.length)
    st.last = ids
    if (!list.length) { st.empty++; st.bad.push(`${tag}: EMPTY 'streams' emission #${st.emissions}`) }
    for (const id of st.floor) {
      if (!ids.has(id)) st.bad.push(`${tag}: emission #${st.emissions} (${list.length} entries) LOST "${id}" — floor: ${st.label}`)
    }
  })
  player.on('error', (e) => st.bad.push(`${tag}: 'error' emitted — ${e && e.message}`))
  return st
}
const floorTo = (st, ids, label) => { st.floor = new Set(ids); st.label = label }

// --- the provider's playlist --------------------------------------------------------------
// Stable NAMES (the m3u mapper slugs the name into the id, so a stable name is a stable
// channel across generations) and a moving url — which is the real steady state: a provider
// rotates its token every half hour and the lineup itself barely moves.
function playlist (gen, cdnPort, { extra = 0, group = 'Live Events', tag = 'ev' } = {}) {
  const out = ['#EXTM3U']
  const n = 3 + extra
  for (let i = 0; i < n; i++) {
    out.push(`#EXTINF:-1 tvg-id="${tag}-${i}" tvg-logo="https://prov.example/${i}.png" group-title="${group}",${tag.toUpperCase()} Match ${i}`)
    out.push('#EXTVLCOPT:http-referrer=https://prov.example/')
    out.push(`http://127.0.0.1:${cdnPort}/index.m3u8?ch=${tag}${i}&gen=${gen}`)
  }
  return out.join('\n') + '\n'
}

const config = {
  argon2: { memKiB: 8192, time: 1 },
  maxDevicesDefault: 4,
  sources: { maxChannels: 200, fetchTimeoutMs: 5000, maxBytes: 4 * MiB }
}

// One panel, wired the way the real one is: the signed store replicated to whoever joins
// its topic, plus the login RPC on the same socket.
async function openPanel (prefix, bootstrap) {
  const dir = mkdir(prefix)
  initKeys(dir)
  const keys = openKeys(dir)
  const { store, db, core, assets, updates, events } = await openStore(dir, keys)
  cleanups.push(async () => { try { await events.close() } catch {}; try { await store.close() } catch {} })
  const ctx = { config, keys, db, assets, updates, events, dataDir: dir, activity: makeRing(200) }
  const throttle = makeThrottle(1000, 120)
  const swarm = new Hyperswarm({ bootstrap }); cleanups.push(() => swarm.destroy())
  swarm.on('connection', (socket) => {
    store.replicate(socket)
    attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle, db, dataDir: dir, sessionTtlMs: 3600000 })
  })
  swarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false })
  await swarm.flush()
  return { dir, keys, store, db, core, events, ctx, swarm, pubKey: b4a.toString(keys.signing.publicKey, 'hex') }
}

// A viewer record, hand-built exactly as the other SDK lanes build one, so the test owns
// `wrapped` (a real feed's encryption key) and the panel owns `eventSources`.
async function enrol (panel, username, { wrapped = {}, manualGrants = [] } = {}) {
  const rwd = evaluateFull(panel.keys.oprf, PASSWORD)
  const salt = randomSalt()
  const kp = userKeyPair()
  const auth = authKeyPair()
  const wk = wrapKeyFrom(rwd)
  await panel.db.put('user/' + username, {
    salt: b4a.toString(salt, 'hex'),
    verifier: b4a.toString(deriveVerifier(rwd, salt, ARGON2_DEFAULT), 'hex'),
    argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'),
    encPriv: wrap(wk, kp.secretKey),
    authPub: b4a.toString(auth.publicKey, 'hex'),
    authPrivEnc: wrap(wk, auth.secretKey),
    wrapped: Object.fromEntries(Object.entries(wrapped).map(([id, key]) => [id, sealTo(kp.publicKey, key)])),
    manualGrants,
    packages: [],
    devices: [], tokenVersion: 1, maxDevices: 4, status: 'active'
  })
  return kp
}

async function signIn (player, username, minStreams, label) {
  const deadline = Date.now() + 90000
  for (;;) {
    if (Date.now() > deadline) throw new Error('timeout: login ' + label)
    try {
      const s = await player.login(username, PASSWORD)
      if (s.length >= minStreams) return s
    } catch (e) {
      if (!/not connected|unknown user/i.test(String(e.message))) throw e
    }
    await sleep(1200)
  }
}

const idsOf = (list) => new Set(list.map((s) => s.id))
const evIds = (panel, source) => panel.events.entries(source).map((e) => e.id)

try {
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap

  // ===== the provider: a real HLS origin, and the m3u that points at it ====================
  const hlsDir = mkdir('e2evc-hls-')
  const ff = startFfmpeg({ input: 'test', hls: { time: 2, listSize: 6 } }, hlsDir); cleanups.push(() => ff.kill())
  const cdn = http.createServer((req, res) => {
    try {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\//, '') || 'index.m3u8'
      res.writeHead(200); res.end(fs.readFileSync(path.join(hlsDir, rel)))
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise((r) => cdn.listen(0, '127.0.0.1', r)); cleanups.push(() => cdn.close())
  const cdnPort = cdn.address().port

  const feeds = { '/events.m3u': playlist(1, cdnPort), '/ppv.m3u': playlist(1, cdnPort, { group: 'PPV', tag: 'pay' }), '/vip.m3u': playlist(1, cdnPort, { group: 'VIP', tag: 'vip' }) }
  const feedSrv = http.createServer((req, res) => {
    const body = feeds[req.url.split('?')[0]]
    if (body == null) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  await new Promise((r) => feedSrv.listen(0, '127.0.0.1', r)); cleanups.push(() => new Promise((r) => feedSrv.close(r)))
  const feedBase = `http://127.0.0.1:${feedSrv.address().port}`

  // ===== A. NO EVENTS DRIVE: the viewer behaves exactly as today ===========================
  log('\nA. a panel with no ephemeral source — today\'s behaviour, and provably no new cost')
  {
    const p = await openPanel('e2evc-off-', bootstrap)
    const encKey = hcrypto.randomBytes(32)
    await enrol(p, 'olivia', { wrapped: { news: encKey, promo: hcrypto.randomBytes(32) }, manualGrants: ['news', 'promo'] })
    await p.db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', protection: 'self', feedKey: 'ab'.repeat(32), isLive: true, status: 'live' })
    await p.db.put('catalog/promo', { title: 'Promo', category: ['promo'], type: 'live', protection: 'self', feedKey: null, redirect: true, url: `http://127.0.0.1:${cdnPort}/index.m3u8?ch=promo`, isLive: true, status: 'live' })
    // An ORDINARY source, synced in full — the deployment production is in today.
    sources.addSource(p.ctx, 'plain', { url: feedBase + '/events.m3u', format: 'm3u', category: 'Live Events', prefix: 'pl.', allowCleartext: true })
    const r = await sources.syncSource(p.ctx, 'plain')
    ok(r.added === 3, `an ordinary source still imports into the CATALOG (${r.added} added)`)
    ok((await p.db.get('meta/eventsKey')) === null, 'the panel wrote NO meta/eventsKey record')
    ok((await p.db.get('user/olivia')).value.eventSources === undefined, 'and no user record grew eventSources')

    const player = createPlayer({ panelPubKey: p.pubKey, storeDir: mkdir('e2evc-cliOff-'), swarm: { bootstrap } })
    player._eventsRefreshMs = 800 // the periodic tick, hammered on purpose for this leg
    const st = instrument(player, 'olivia')
    cleanups.push(() => player.stop())
    await player.connect()
    // COUNT what the engine asks the bee for. This is the measurement the leg exists for:
    // "no cost" has to mean no read, not merely no crash.
    const reads = new Map()
    const rawGet = player._panelBee.get.bind(player._panelBee)
    player._panelBee.get = (k, ...rest) => { reads.set(k, (reads.get(k) || 0) + 1); return rawGet(k, ...rest) }

    const streams = await signIn(player, 'olivia', 5, 'olivia (no events drive)')
    const want = new Set(['news', 'promo', ...(await (async () => { const out = []; for await (const { key } of p.db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) out.push(key.slice(8)); return out })())])
    floorTo(st, want, 'the whole catalog lineup')
    ok(streams.length === want.size && [...idsOf(streams)].every((id) => want.has(id)), `the login lineup is the catalog and nothing else (${streams.length} of ${want.size})`)

    // Now provoke every events trigger there is: pushes, zaps and the periodic tick.
    await player._pushCatalog()
    await player.resolve('promo')
    await player._kickEvents()
    await sleep(2600) // ≥3 periodic ticks at 800 ms
    ok(reads.get('meta/eventsKey') === undefined, 'meta/eventsKey was NEVER read — the ACL short-circuits one level ABOVE the pointer')
    ok(player._eventsDrive === null && player._eventsOpen === null, 'no events drive was opened and no open is pending')
    ok(player._eventSources.length === 0 && player._eventShards.size === 0, 'the engine holds no event sources and no cached shards')
    ok(await player._refreshEvents() === false, 'a forced refresh reports "nothing changed" without touching the bee')
    ok(st.empty === 0 && st.bad.length === 0, `no error, no empty emission, no truncation across ${st.emissions} emission(s)`)
    ok(st.last.size === want.size, `and the last lineup is still the whole catalog (${st.last.size})`)
    if (st.bad.length) for (const b of st.bad) log('       ' + b)
    await player.stop()
    log(`  …  ${st.emissions} emission(s), sizes ${JSON.stringify(st.sizes)}; bee reads by key: ${JSON.stringify([...reads.entries()].filter(([k]) => k.startsWith('meta/')))}`)
  }

  // ===== the main panel: two ephemeral sources, one catalog P2P channel ====================
  log('\n   main panel: a real feed, a redirect channel, and two ephemeral sources')
  const panel = await openPanel('e2evc-panel-', bootstrap)
  const encKey = hcrypto.randomBytes(32)
  const feedStore = new Corestore(mkdir('e2evc-feed-')); await feedStore.ready(); cleanups.push(() => feedStore.close())
  const feed = new Hyperdrive(feedStore.namespace('feed'), { encryptionKey: encKey }); await feed.ready()
  const feedSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => feedSwarm.destroy())
  feedSwarm.on('connection', (s) => feed.replicate(s))
  feedSwarm.join(feed.discoveryKey, { server: true, client: false }); await feedSwarm.flush()
  const stopMirror = mirrorDirToDrive(hlsDir, feed, { interval: 400 }); cleanups.push(() => stopMirror())

  const catalogUrl = `http://127.0.0.1:${cdnPort}/index.m3u8?ch=catalog`
  await panel.db.put('catalog/news', { title: 'News 24', category: ['news'], type: 'live', protection: 'self', feedKey: b4a.toString(feed.key, 'hex'), isLive: true, status: 'live' })
  await panel.db.put('catalog/promo', { title: 'Promo', category: ['promo'], type: 'live', protection: 'self', feedKey: null, redirect: true, url: catalogUrl, isLive: true, status: 'live' })
  const kpAlice = await enrol(panel, 'alice', { wrapped: { news: encKey, promo: hcrypto.randomBytes(32) }, manualGrants: ['news', 'promo'] })
  await enrol(panel, 'bob', { wrapped: { news: encKey, promo: hcrypto.randomBytes(32) }, manualGrants: ['news', 'promo'] })

  sources.addSource(panel.ctx, 'live-events', { url: feedBase + '/events.m3u', format: 'm3u', category: 'Live Events', prefix: 'ev.', ephemeral: true, allowCleartext: true })
  sources.addSource(panel.ctx, 'pay-events', { url: feedBase + '/ppv.m3u', format: 'm3u', category: 'PPV', prefix: 'pay.', ephemeral: true, autoGrant: false, allowCleartext: true })
  // A third ephemeral source NOBODY is entitled to. Leg H grants it mid-session, which is
  // the only way to test that a grant really FETCHES: a source the viewer once held is still
  // in `_eventShards` (deliberately — the merge filters by the live ACL, so a re-grant needs
  // no read at all), and that cache masks a missing fetch completely.
  sources.addSource(panel.ctx, 'vip-events', { url: feedBase + '/vip.m3u', format: 'm3u', category: 'VIP', prefix: 'vip.', ephemeral: true, autoGrant: false, allowCleartext: true })
  await sources.syncSource(panel.ctx, 'live-events')
  await sources.syncSource(panel.ctx, 'pay-events')
  await sources.syncSource(panel.ctx, 'vip-events')
  await packages.addPackage(panel.ctx, 'ppv', { label: 'PPV', members: 'source:pay-events' })
  await packages.setUserPackages(panel.ctx, 'alice', ['ppv'])

  const beeAfterSetup = { length: panel.core.length, byteLength: panel.core.byteLength }
  const liveIds = evIds(panel, 'live-events')
  const payIds = evIds(panel, 'pay-events')
  ok(liveIds.length === 3 && payIds.length === 3, `the drive carries both shards (${liveIds.length} + ${payIds.length} entries)`)
  ok((await panel.db.get('user/alice')).value.eventSources.join(',') === 'live-events,pay-events', 'alice is entitled to both sources')
  ok((await panel.db.get('user/bob')).value.eventSources.join(',') === 'live-events', 'bob only to the autoGrant one')

  // ===== B. catalog ∪ events, catalog wins a collision =====================================
  log('\nB. the merged lineup: catalog ∪ events, with the CATALOG winning a colliding id')
  const alice = createPlayer({ panelPubKey: panel.pubKey, storeDir: mkdir('e2evc-cliA-'), swarm: { bootstrap } })
  alice._eventsRefreshMs = 2000
  const stA = instrument(alice, 'alice')
  cleanups.push(() => alice.stop())
  await alice.connect()
  await signIn(alice, 'alice', 2, 'alice')
  const wantAlice = new Set(['news', 'promo', ...liveIds, ...payIds])
  await waitFor(async () => [...wantAlice].every((id) => stA.last.has(id)) || null, 60000, "alice's merged lineup")
  floorTo(stA, wantAlice, 'catalog ∪ live-events ∪ pay-events')
  ok(alice.listStreams().length === wantAlice.size, `alice sees catalog ∪ both shards, exactly once each (${alice.listStreams().length} of ${wantAlice.size})`)
  {
    const one = alice.listStreams().find((s) => s.id === liveIds[0])
    ok(!!one && one.title.startsWith('EV Match'), `a drive-sourced channel arrives in the catalog record's own shape (${JSON.stringify(one && one.title)})`)
    ok(one.url === undefined && one.headers === undefined && one.feedKey === undefined && one.encryptionKey === undefined,
      'and stays metadata-only — no url, no headers, no keys in the display list')
    ok(one.restricted === false && typeof one.guideBase === 'string' && typeof one.thumbBase === 'string',
      'with the same access-control flag and the same guide/thumb bases a catalog channel gets')
    ok(Object.prototype.hasOwnProperty.call(one, 'startsAt'), 'the event WINDOW rides the display entry (null here: an m3u declares none)')
    const chan = alice.listStreams().find((s) => s.id === 'news')
    ok(chan.startsAt === undefined, 'and a catalog channel grows no window')
  }
  // The collision. The panel refuses to PUBLISH an id a foreign catalog record holds
  // (sources.js applyEphemeral), so the only way to make one is to catalog an id the drive
  // is already publishing — which is exactly the disagreement the precedence rule is for.
  const clash = liveIds[1]
  await panel.db.put('catalog/' + clash, { title: 'CATALOG WINS', category: ['news'], type: 'live', protection: 'self', feedKey: null, redirect: true, url: catalogUrl, isLive: true, status: 'live' })
  {
    const rec = (await panel.db.get('user/alice')).value
    rec.wrapped[clash] = sealTo(kpAlice.publicKey, hcrypto.randomBytes(32))
    rec.manualGrants = [...rec.manualGrants, clash]
    await panel.db.put('user/alice', rec)
  }
  await waitFor(async () => (alice.listStreams().find((s) => s.id === clash) || {}).title === 'CATALOG WINS', 60000, 'the catalog record wins the collision')
  ok(alice.listStreams().filter((s) => s.id === clash).length === 1, 'the colliding id appears EXACTLY ONCE, and it is the catalog record')
  ok(alice.listStreams().length === wantAlice.size, 'and the lineup did not grow — a collision merges, it does not duplicate')
  // …and back. Remove the catalog record and the grant; the drive resumes governing the id.
  {
    const rec = (await panel.db.get('user/alice')).value
    delete rec.wrapped[clash]
    rec.manualGrants = rec.manualGrants.filter((x) => x !== clash)
    await panel.db.put('user/alice', rec)
    await panel.db.del('catalog/' + clash)
  }
  await waitFor(async () => (alice.listStreams().find((s) => s.id === clash) || {}).title !== 'CATALOG WINS', 60000, 'the drive resumes governing the id')
  ok(alice.listStreams().length === wantAlice.size, 'the id never left the lineup while governance changed hands')

  // ===== B2. THE CROSSING: a collision the viewer holds NO grant for ======================
  //
  // The half above is the SAFE one — alice was granted the colliding id, so letting the live
  // catalog record win is the ordinary "an admin url edit reaches the next tune". This is the
  // other half, and it is an entitlement crossing rather than a precedence question: the
  // viewer is admitted by `eventSources` alone, which says nothing whatever about
  // `catalog/<id>`. Left unguarded, resolve() re-read the catalog record and handed over an
  // operator's premium url, its provider headers — a bearer token, in the shape a real
  // premium feed uses — and playback past a `restricted:true` parental gate that the drive
  // entry does not carry and the display list therefore never showed.
  log('\nB2. an events-only entitlement must NOT reach a catalog record it holds no grant for')
  {
    const secretUrl = 'https://premium.example/secret.m3u8'
    const secretHeaders = { authorization: 'Bearer OPERATOR-SECRET' }
    const cross = liveIds[2]
    ok(!alice._entitled.has(cross), 'precondition: alice holds NO grant for the colliding id')
    // The floor drops ON PURPOSE for exactly this id: suppressing it is the fix under test.
    log(`  …  floor lowered ON PURPOSE: ${cross} is about to be governed by a catalog record alice cannot play`)
    floorTo(stA, new Set([...wantAlice].filter((id) => id !== cross)), 'catalog ∪ events, minus the shadowed id')
    await panel.db.put('catalog/' + cross, {
      title: 'PREMIUM', category: ['premium'], type: 'live', protection: 'self', feedKey: null,
      redirect: true, url: secretUrl, headers: secretHeaders, isLive: true, status: 'live', restricted: true
    })
    // Give the record time to replicate; the display entry is still the DRIVE's, because the
    // merge only de-dupes against grants this viewer holds.
    await waitFor(async () => (await alice._panelBee.get('catalog/' + cross))?.value?.url === secretUrl || null, 60000, 'the catalog record replicated to the viewer')
    ok(!alice._entitled.has(cross), 'and it is still not a grant — the record alone entitles nobody')

    let leaked = null
    try { leaked = await alice.resolve(cross) } catch (e) { leaked = { error: String(e.message) } }
    ok(leaked.error && /not entitled/.test(leaked.error), `resolve() REFUSES the crossing (${JSON.stringify(leaked.error || leaked)})`)
    ok(leaked.url === undefined, 'no url was handed back')
    ok(leaked.headers === undefined, 'and no provider headers — the bearer token never left the engine')
    // The cast door is the same crossing one hop further out (a LAN receiver, not this app).
    await assertRejects(() => alice.startCast(cross), /not entitled/, 'startCast() refuses it too')
    // …and the lineup stops offering what it will refuse to tune, so the display can no
    // longer claim restricted:false for an id the catalog restricts.
    await waitFor(async () => !alice.listStreams().some((s) => s.id === cross) || null, 30000, 'the refused id leaves the lineup')
    ok(!alice.listStreams().some((s) => s.id === cross), 'the shadowed id is suppressed from the merged lineup')
    ok(alice._eventShadowed.has(cross), 'and the engine remembers why, without a per-channel catalog sweep')

    // GRANT it, and the ordinary precedence returns: the catalog record wins, legitimately.
    const rec = (await panel.db.get('user/alice')).value
    rec.wrapped[cross] = sealTo(kpAlice.publicKey, hcrypto.randomBytes(32))
    rec.manualGrants = [...rec.manualGrants, cross]
    await panel.db.put('user/alice', rec)
    await waitFor(async () => (alice.listStreams().find((s) => s.id === cross) || {}).title === 'PREMIUM', 60000, 'a real grant restores the catalog record')
    const granted = await alice.resolve(cross)
    ok(granted.url === secretUrl && granted.headers.authorization === 'Bearer OPERATOR-SECRET',
      'and NOW the operator url and headers are handed over — because the viewer is entitled to them')
    ok(alice.listStreams().find((s) => s.id === cross).restricted === true, 'with the catalog record\'s parental flag intact')

    // Clean up so later legs see the drive governing the id again.
    const rec2 = (await panel.db.get('user/alice')).value
    delete rec2.wrapped[cross]
    rec2.manualGrants = rec2.manualGrants.filter((x) => x !== cross)
    await panel.db.put('user/alice', rec2)
    await panel.db.del('catalog/' + cross)
    await waitFor(async () => (alice.listStreams().find((s) => s.id === cross) || {}).title !== 'PREMIUM' && alice.listStreams().some((s) => s.id === cross) ? true : null, 60000, 'the drive governs it again once the record is gone')
    ok(alice.listStreams().length === wantAlice.size, 'and the lineup is whole again')
    ok(alice._eventShadowed.size === 0, 'and the shadow was invalidated by the catalog change that removed the record')
    floorTo(stA, wantAlice, 'catalog ∪ live-events ∪ pay-events')
  }

  // ===== B3. the SERVER refuses to create the collision in the first place ================
  log('\nB3. the panel now refuses to create that collision at all')
  {
    const published = liveIds[0]
    let refused = null
    try { await ops.addStream(panel.ctx, published, { url: catalogUrl }) } catch (e) { refused = String(e.message) }
    ok(refused && /already published by the ephemeral source/.test(refused), `addStream refuses an id the events drive publishes (${JSON.stringify(refused)})`)
    ok((await panel.db.get('catalog/' + published)) === null, 'and wrote no catalog record')

    // …and the same from the other direction: an ORDINARY source importing an id an
    // ephemeral source already publishes. applyEphemeral has always refused the mirror.
    feeds['/plain.m3u'] = playlist(1, cdnPort) // the SAME names -> the same slugs -> the same ids
    sources.addSource(panel.ctx, 'plain-clash', { url: feedBase + '/plain.m3u', format: 'm3u', category: 'Live Events', prefix: 'ev.', allowCleartext: true })
    const r = await sources.syncSource(panel.ctx, 'plain-clash')
    ok(r.added === 0 && r.conflicts.length === liveIds.length,
      `an ordinary source importing published ids adds nothing and reports every one as a conflict (${r.added} added, ${r.conflicts.length} conflicts)`)
    let stillDrive = 0
    for (const id of liveIds) if ((await panel.db.get('catalog/' + id)) === null) stillDrive++
    ok(stillDrive === liveIds.length, 'no catalog record was written on top of a published shard entry')
    await sources.removeSource(panel.ctx, 'plain-clash')
  }

  // ===== C. a viewer NOT entitled to a source never receives (or fetches) its shard ========
  log('\nC. entitlement is per SOURCE, applied before the shard is even fetched')
  const bob = createPlayer({ panelPubKey: panel.pubKey, storeDir: mkdir('e2evc-cliB-'), swarm: { bootstrap } })
  bob._eventsRefreshMs = 2000
  const stB = instrument(bob, 'bob')
  cleanups.push(() => bob.stop())
  await bob.connect()
  await signIn(bob, 'bob', 2, 'bob')
  // Count what bob's engine actually ASKS THE DRIVE FOR, by path. "Never fetched" has to be
  // a statement about reads issued, not about which key survived in a Map — the latter
  // cannot tell "not fetched" from "fetched and discarded".
  const bobGets = []
  await waitFor(async () => bob._eventsDrive || null, 60000, "bob's events replica opens")
  {
    const raw = bob._eventsDrive.get.bind(bob._eventsDrive)
    bob._eventsDrive.get = (p, ...rest) => { bobGets.push(String(p)); return raw(p, ...rest) }
  }
  const wantBob = new Set(['news', 'promo', ...liveIds])
  await waitFor(async () => [...wantBob].every((id) => stB.last.has(id)) || null, 60000, "bob's merged lineup")
  floorTo(stB, wantBob, 'catalog ∪ live-events')
  ok(bob.listStreams().length === wantBob.size, `bob sees catalog ∪ live-events only (${bob.listStreams().length} of ${wantBob.size})`)
  ok(!bob.listStreams().some((s) => payIds.includes(s.id)), 'and none of the pay-events channels')
  // Force several more reads so the counter has something to be wrong about.
  for (let i = 0; i < 3; i++) { await bob._refreshEvents(); await bob._pushCatalog() }
  const payShardNow = panel.events._shards.get('pay-events').shard
  ok(bobGets.length > 0, `bob's engine really did read the drive (${bobGets.length} get(s): ${JSON.stringify([...new Set(bobGets)])})`)
  ok(!bobGets.includes(payShardNow), `and NEVER issued a read for the un-entitled shard ${payShardNow} — not fetched, not merely filtered`)
  ok(!bob._eventShards.has('pay-events'), 'so it holds no entries for it either')
  await assertRejects(() => bob.resolve(payIds[0]), /not entitled/, 'resolve() of a source bob does not hold')

  // ===== E. a drive-sourced channel resolves and PLAYS =====================================
  log('\nE. a drive-sourced channel resolves to its provider url and serves real bytes')
  // The zero-write window opens HERE, not at setup: a login legitimately appends to the bee
  // (the panel stamps `seen/<user>` for device recency), so measuring across one would blame
  // the events feature for a write it did not make. From this point on both viewers are
  // logged in and everything below is SERVING — pushes, zaps, refreshes, resolves.
  const beeBeforeServing = { length: panel.core.length, byteLength: panel.core.byteLength }
  {
    const target = liveIds[0]
    const r = await alice.resolve(target)
    ok(r.source === 'cdn' && r.port === undefined && r.localUrl === undefined && r.feedKey === null,
      `it takes the redirect return unchanged (${JSON.stringify({ source: r.source, port: r.port })})`)
    ok(typeof r.url === 'string' && r.url.startsWith(`http://127.0.0.1:${cdnPort}/`), `and hands back the provider url verbatim (${r.url})`)
    ok(r.headers && r.headers.referer === 'https://prov.example/', 'with the provider headers the m3u carried')
    const pl = await httpGet(cdnPort, r.url.slice(r.url.indexOf('/index.m3u8')))
    ok(pl.status === 200 && pl.body.includes('#EXTM3U'), 'the url really serves an HLS playlist')
    const seg = (pl.body.toString().match(/[^\s]+\.ts/) || [])[0]
    const bytes = await httpGet(cdnPort, '/' + seg)
    const segPath = path.join(hlsDir, 'e2evc-probe.ts'); fs.writeFileSync(segPath, bytes.body)
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', segPath], { encoding: 'utf8' })
    const kinds = (probe.stdout || '').trim()
    ok(bytes.body.length > 1000 && /video/.test(kinds), `and a real segment off it: ${bytes.body.length} bytes, ffprobe ${JSON.stringify(kinds)}`)
    // The catalog half is untouched — the P2P channel still plays over the feed beside it.
    const rn = await alice.resolve('news')
    ok(rn.source === 'p2p' && !!rn.port, 'and the catalog P2P channel beside it still tunes over P2P')
    const local = await waitFor(async () => { const x = await httpGet(rn.port, '/index.m3u8'); return x.status === 200 && x.body.includes('.ts') ? x : null }, 60000, 'P2P playback beside the events lineup')
    ok(local.body.includes('#EXTM3U'), 'serving a real HLS playlist off the loopback server')

    // Serving the events lineup — pushes, zaps, refreshes, on TWO logged-in viewers — must
    // cost the append-only signed bee exactly nothing. That is the whole feature, measured
    // from the client side this time.
    for (let i = 0; i < 4; i++) {
      await alice._pushCatalog(); await bob._pushCatalog()
      await alice._refreshEvents(); await bob._refreshEvents()
      await alice.resolve(liveIds[i % liveIds.length])
    }
    ok(panel.core.length === beeBeforeServing.length && panel.core.byteLength === beeBeforeServing.byteLength,
      `serving the events lineup to two viewers appended NOTHING to the signed bee (length ${beeBeforeServing.length} -> ${panel.core.length}, byteLength ${beeBeforeServing.byteLength} -> ${panel.core.byteLength})`)
  }

  // ===== D. EPOCH ROTATION: the pointer flips, the viewer follows, the lineup keeps moving =
  log('\nD. epoch rotation — the _openEpg-vs-_doOpenAssets gate')
  {
    // ⚠ THE PERIODIC TICK IS STOOD DOWN FOR THIS WHOLE LEG. With it running, the swap gets
    // carried within two seconds whether or not the meta/ watcher works at all — which made
    // the previous version of this lane pass with the watcher edge removed entirely. The
    // ONLY thing that may carry the rotation below is _watchMetaPointers.
    clearInterval(alice._eventsTimer); alice._eventsTimer = null
    const before = alice._eventsKeyHex
    const e1 = panel.events.driveInfo().key
    ok(before === e1, 'the viewer is reading the epoch the pointer names')
    // …and a refresh is deliberately left IN FLIGHT across the flip, which is the state that
    // used to swallow it: the in-flight read has already been through _openEvents holding the
    // previous epoch, so answering the pointer tick with its verdict reports "nothing
    // changed" and nothing ever re-reads the pointer.
    const inflight = alice._refreshEvents()
    const forced = alice._refreshEvents({ force: true })
    ok(forced !== inflight, 'a FORCED refresh does not accept an in-flight read as its answer')
    ok(alice._refreshEvents() === inflight, '…while an ordinary one still shares it (single-flight intact)')
    await panel.events.rotate()
    const e2 = panel.events.driveInfo().key
    ok(e2 !== e1 && (await panel.db.get('meta/eventsKey')).value.key === e2, `the panel minted epoch 2 and flipped the pointer (${e2.slice(0, 8)}…)`)
    // …and the retired epoch is PURGED off the panel, so nothing can serve it any more. A
    // client that could not follow the swap has nothing left to read.
    for (const p of panel.events._state.pending) p.purgeAt = Date.now() - 1000
    await panel.events.maintain()
    ok(panel.events._state.pending.length === 0, 'and purged the retired epoch after its grace window')
    await waitFor(async () => alice._eventsKeyHex === e2 || null, 60000, 'the viewer follows the pointer swap')
    ok(alice._eventsKeyHex === e2, 'the viewer swapped to the new epoch drive')
    ok(alice.listStreams().length === wantAlice.size, 'and never dropped a channel doing it')

    // THE REAL GATE: publish a NEW generation into the rotated epoch. Only a viewer that
    // really moved can see it — the old drive is gone from the panel entirely.
    //
    // ⚠ And note what does NOT happen here: an ephemeral sync appends nothing to the signed
    // bee, so neither the catalog watcher nor the meta/ watcher fires for it. With the
    // periodic tick still down, the ONLY thing left that can carry this is a CHANNEL CHANGE
    // — so this half is the zap trigger's gate as much as the swap's.
    feeds['/events.m3u'] = playlist(2, cdnPort, { extra: 1 })
    const beeBeforeSync = panel.core.length
    const r = await sources.syncSource(panel.ctx, 'live-events')
    ok(r.driveChanged === true && r.added === 1, `a sync into the rotated epoch publishes normally (${r.added} added, ${r.published} published)`)
    ok(panel.core.length === beeBeforeSync, 'and appended nothing to the bee — which is why no watcher can carry it')
    const live2 = evIds(panel, 'live-events')
    const fresh = live2.find((id) => !liveIds.includes(id))
    // ZAP until it lands, which is what a viewer with a remote does. One zap is not enough
    // on purpose: the kick is fire-and-forget and a refresh that fires in the same
    // millisecond as the publish can still read the previous index (the peer's length
    // announcement has not arrived), report "nothing changed" and stop. In production the
    // five-minute tick is the backstop for exactly that; here the tick is off, so the zaps
    // are. The floor is wall-clock (EVENTS_ZAP_MIN_MS), cleared rather than sat out.
    await waitFor(async () => {
      alice._eventsAt = 0
      await alice.resolve('news') // an ordinary channel change, nothing events-specific about it
      await sleep(400)
      return alice.listStreams().some((s) => s.id === fresh) || null
    }, 60000, 'the new channel reaches the viewer THROUGH the rotated drive, carried by a zap')
    ok(!!fresh && alice.listStreams().some((s) => s.id === fresh), `a channel published AFTER the rotation reached the viewer (${fresh})`)
    const moved = await alice.resolve(live2[0])
    ok(/gen=2/.test(moved.url), `and the rotated url reached it too (${moved.url})`)
    ok(alice._eventsTimer === null, 'and the periodic tick was OFF for this whole leg — the meta/ watcher carried the swap, a zap carried the publish')
    alice._startEventsRefresh()
    for (const id of live2) wantAlice.add(id)
    floorTo(stA, wantAlice, 'catalog ∪ the ROTATED live-events ∪ pay-events')
  }

  // ===== G. a bad shard does not take the lineup down ======================================
  log('\nG. a missing, malformed or truncated shard costs its own source freshness — nothing else')
  {
    // Deterministic: the periodic tick is what every other leg relies on, and here it would
    // race the hand-written index revisions this leg installs one at a time. Every refresh
    // below is issued explicitly instead.
    clearInterval(alice._eventsTimer); alice._eventsTimer = null
    // ⚠ BOB IS READING THE SAME DRIVE, on his own two-second tick, and this leg is about to
    // hand-break the shard he is entitled to. His floor drops with alice's — announced, so a
    // real truncation on his side still cannot hide behind an intended one.
    log('  …  floor lowered ON PURPOSE for BOTH viewers: the live-events shard is hand-broken below')
    floorTo(stB, new Set(['news', 'promo']), 'catalog only (live-events shard hand-broken)')
    // …and shorten the read bound. One of the cases below names a path the drive has never
    // held, and a bee lookup for a key that does not exist on a sparse replica PARKS rather
    // than answering null — which is the bound doing its job, but at 12 s a piece.
    alice._eventsReadMs = 3000
    const drive = panel.events._drive
    const liveNow = evIds(panel, 'live-events')
    const payNow = evIds(panel, 'pay-events')
    const payShard = panel.events._shards.get('pay-events').shard
    // Hand-write an index naming, for live-events, a shard that is one of: absent, not JSON,
    // JSON but not an array, an array of junk. pay-events keeps its real (good) shard, so a
    // healthy source must keep updating right through it.
    const badCases = [
      ['a shard the drive does not have at all', null, null],
      ['a shard that is not JSON', '/v1/live-events-9001.json', b4a.from('{ this is not json')],
      ['a shard that is JSON but not an array', '/v1/live-events-9002.json', b4a.from('{"oops":true}')],
      ['a shard TRUNCATED mid-array', '/v1/live-events-9003.json', b4a.from('[{"id":"ev.half","title":"Hal')]
    ]
    let rev = 9000
    for (const [label, shard, bytes] of badCases) {
      const p = shard || '/v1/live-events-9999.json'
      if (bytes) await drive.put(p, bytes)
      await drive.put('/v1/index.json', b4a.from(JSON.stringify({
        rev: ++rev,
        updatedAt: Date.now(),
        sources: [{ name: 'live-events', shard: p, count: 1 }, { name: 'pay-events', shard: payShard, count: payNow.length }]
      })))
      await alice._refreshEvents() // drain whatever was already in flight (single-flight shares it)
      const changed = await alice._refreshEvents() // …then a read that really sees this index
      const ids = new Set(alice._eventShards.get('live-events').entries.map((e) => e.id))
      ok(liveNow.every((id) => ids.has(id)), `${label}: the last GOOD lineup stands (${ids.size} entries kept)`)
      ok(alice._eventShards.get('pay-events') && payNow.every((id) => alice._eventShards.get('pay-events').entries.some((e) => e.id === id)),
        `${label}: and the healthy source beside it is untouched`)
      // THE invariant, and it covers both ways a bad shard can end: the loop reaching its
      // `complete = false` (rev -> -1) and the whole read missing its bound (rev left at the
      // last COMPLETE index). Either way the client never anchors on an index whose shards it
      // did not get, so the next refresh re-reads instead of short-circuiting on it.
      ok(alice._eventsRev !== rev, `${label}: the client did not anchor on an index it could not fully read (rev ${alice._eventsRev} vs index ${rev})`)
      await alice._pushCatalog()
      ok(alice.listStreams().length === wantAlice.size, `${label}: the emitted lineup is whole (${alice.listStreams().length})`)
      if (changed) log('       (the refresh reported a change, which is honest: the fingerprint moved)')
    }

    // A shard whose bytes and the index's `count` DISAGREE — the one thing that tells a torn
    // read from a genuinely small lineup. Treated like any other unusable shard.
    {
      await drive.put('/v1/live-events-9050.json', b4a.from(JSON.stringify([{ id: 'ev.only', title: 'Only' }])))
      await drive.put('/v1/index.json', b4a.from(JSON.stringify({
        rev: 9050, updatedAt: Date.now(), sources: [{ name: 'live-events', shard: '/v1/live-events-9050.json', count: 99 }, { name: 'pay-events', shard: payShard, count: payNow.length }]
      })))
      await alice._refreshEvents(); await alice._refreshEvents()
      const ids = new Set(alice._eventShards.get('live-events').entries.map((e) => e.id))
      ok(!ids.has('ev.only') && liveNow.every((id) => ids.has(id)), 'an index whose count disagrees with its shard is refused, and the last good lineup stands')
      ok(alice._eventsRev !== 9050, 'and the rev is not anchored on it')
    }

    // ===== THE PUSH BUDGET AND THE PARKED-READ BOUND, on a drive that REALLY parks =========
    //
    // Both properties need a read that never settles, and "name a path the drive has not
    // got" stops delivering one: once the client has read enough index revisions its
    // metadata blocks are local, so the missing entry resolves to null immediately. So the
    // park is made explicit — a get for /v1/park-* returns a promise this test holds the
    // resolver for — which models "a block that never arrives" exactly and without depending
    // on replication timing. Every parked promise is released at the end, which also proves
    // the counter is a bound and not a leak.
    {
      const realGet = alice._eventsDrive.get.bind(alice._eventsDrive)
      const held = []
      let parkRev = 30000
      let getCount = 0
      alice._eventsDrive.get = (p, ...rest) => {
        getCount++
        // A fresh rev and a fresh park path on every read, so nothing short-circuits.
        if (p === '/v1/index.json') {
          // pay-events keeps its REAL shard path so nothing is dropped from the snapshot:
          // a source that vanished from the index would be re-fetched afterwards, and that
          // re-fetch is a genuinely unservable block in this test — collateral that has
          // nothing to do with the property under test.
          return Promise.resolve(b4a.from(JSON.stringify({
            rev: ++parkRev,
            updatedAt: Date.now(),
            sources: [{ name: 'live-events', shard: `/v1/park-${parkRev}.json`, count: 1 }, { name: 'pay-events', shard: payShard, count: payNow.length }]
          })))
        }
        if (String(p).startsWith('/v1/park-')) return new Promise((resolve) => held.push(resolve))
        return realGet(p, ...rest)
      }

      // (a) THE PUSH BUDGET. Promise.all is a BARRIER, which is why "awaited concurrently"
      // looked safe and measured 12,003 ms of a 30 s ceiling. A push must not await the
      // events drive — and must not touch it at all, since a push -> refresh edge of any
      // kind closes the feedback loop leg I proves is absent.
      alice._eventsReadMs = 5000
      const emissionsBefore = stA.emissions
      const parkedBefore = alice._eventsParked
      const getsBefore = getCount
      const t0 = Date.now()
      await alice._pushCatalog()
      const dt = Date.now() - t0
      ok(dt < 1500, `a catalog push with the events drive PARKED took ${dt} ms against a ${alice._eventsReadMs} ms read bound (awaiting it measured 12,003 ms)`)
      ok(getCount === getsBefore, `and issued ${getCount - getsBefore} events-drive read(s) — a push does not refresh, it merges what is already there`)
      ok(alice._eventsParked === parkedBefore, 'so it started no new read either')
      ok(stA.emissions > emissionsBefore, 'and it still emitted a lineup — a quiet events drive never costs the host a revocation')

      // (b) THE UNFORCED BOUND. ⚠ The attempts must be spaced past the READ BOUND, or the
      // single-flight latch alone limits them and the cap is never exercised at all — which
      // is exactly how an earlier version of this assertion passed while proving nothing.
      alice._eventsReadMs = 150
      for (let i = 0; i < 24; i++) { alice._refreshEvents(); await sleep(200) }
      ok(alice._eventsParked > 1, `the reads really are parking (${alice._eventsParked} outstanding) — the bound below is not measuring an empty set`)
      ok(alice._eventsParked <= 8, `24 spaced refreshes against a parked drive left ${alice._eventsParked} outstanding read(s), bounded at 8 — unbounded measured 25/25`)

      // (c) THE FORCED BOUND. It used to be exempt outright, on the argument that a pointer
      // flip makes parked reads irrelevant — true only when the pointer really moved, and
      // _watchMetaPointers forces on EVERY meta/ write (meta/epgKey shares the range). 12
      // such ticks over an UNCHANGED pointer measured 12 outstanding against a bound of 2.
      // It keeps headroom over the unforced cap because a force is what opens a new epoch,
      // and opening it is what settles the reads parked on the retired one.
      const beforeForce = alice._eventsParked
      for (let i = 0; i < 24; i++) { alice._refreshEvents({ force: true }); await sleep(200) }
      ok(alice._eventsParked <= 12, `24 forced refreshes over an unchanged pointer left ${alice._eventsParked} outstanding read(s), bounded at 12 — unbounded measured 12/12`)
      ok(alice._eventsParked > beforeForce, `and a force does get headroom past the unforced cap (${beforeForce} -> ${alice._eventsParked}) — it is the call that unsticks a swapped epoch`)

      // Release every parked read and put the drive back. The counter must return to zero:
      // a bound that never decrements would be a leak wearing a cap.
      alice._eventsDrive.get = realGet
      const beforeRelease = alice._eventsParked
      for (const resolve of held) resolve(null)
      await sleep(1500)
      // A DROP, not a return to zero: an unrelated read can be genuinely parked on this
      // drive at the same moment, and the property under test is that the counter tracks
      // reality — that a settled read is really given back.
      ok(alice._eventsParked < beforeRelease && alice._eventsParked <= 2,
        `releasing ${held.length} held read(s) took the counter ${beforeRelease} -> ${alice._eventsParked} — a bound that decrements, not a leak wearing a cap`)
      alice._eventsReadMs = 3000
    }

    // An array whose ELEMENTS are junk: the good ones survive, the junk is dropped, and a
    // `restricted` entry proves the client carries that flag rather than defaulting it open.
    const mixed = [
      null, 42, { title: 'no id' }, { id: '' },
      { id: 'ev.gated', title: 'Gated Event', category: ['Live Events'], type: 'live', protection: 'none', feedKey: null, blobsKey: null, redirect: true, url: catalogUrl, headers: null, isLive: true, poster: null, backdrop: null, logo: null, order: 0, featured: false, restricted: true, status: 'live', source: 'live-events', epgUrl: null, epgId: null, startsAt: '2026-08-17T19:00:00.000Z', endsAt: null }
    ]
    // The floor drops BEFORE the write, not after: replacing a source's whole shard with a
    // hand-made one legitimately replaces its channels, and a floor that still promised the
    // old ones would report the intended change as a truncation.
    log('  …  floor lowered ON PURPOSE: the live-events shard is about to be REPLACED by a hand-made one')
    floorTo(stA, new Set(['news', 'promo', ...payNow]), 'catalog ∪ pay-events (live-events shard hand-replaced)')
    await drive.put('/v1/live-events-9100.json', b4a.from(JSON.stringify(mixed)))
    await drive.put('/v1/index.json', b4a.from(JSON.stringify({
      rev: 9100, updatedAt: Date.now(), sources: [{ name: 'live-events', shard: '/v1/live-events-9100.json', count: mixed.length }, { name: 'pay-events', shard: payShard, count: payNow.length }]
    })))
    // Retried rather than read once: one read from the push-budget block above is parked for
    // good, so the cap lets exactly one refresh run at a time and a single call can be
    // answered by the one already in flight.
    await waitFor(async () => {
      await alice._refreshEvents()
      const cur = alice._eventShards.get('live-events')
      return (cur && cur.entries.length === 1) || null
    }, 30000, 'the mixed shard is read')
    await alice._pushCatalog()
    const gated = alice.listStreams().find((s) => s.id === 'ev.gated')
    ok(alice._eventShards.get('live-events').entries.length === 1, 'junk elements are dropped and the usable one survives')
    ok(!!gated && gated.restricted === true, '⚠ a `restricted` event reaches the host as restricted:true — the PIN gate is NOT bypassed on this path')
    ok(gated.startsAt === '2026-08-17T19:00:00.000Z' && gated.endsAt === undefined,
      'and its event window rides the display entry (an absent half reads undefined, like epgUrl)')
    feeds['/events.m3u'] = playlist(3, cdnPort, { extra: 1 })
    await sources.syncSource(panel.ctx, 'live-events')
    // ⚠ AND NOTHING IN THE BEE MOVED. That is the feature: an ephemeral sync appends zero
    // blocks, so the catalog watcher stays silent and the ONLY things that can wake a viewer
    // are the three triggers this engine grows — the periodic tick, a channel change, and a
    // meta/ pointer flip. This leg stood the tick down for determinism; put it back, because
    // it is the one that carries a viewer who is neither zapping nor rotating.
    alice._eventsReadMs = EVENTS_READ_MS_DEFAULT
    alice._startEventsRefresh()
    const restored = evIds(panel, 'live-events')
    await waitFor(async () => restored.every((id) => alice.listStreams().some((s) => s.id === id)) || null, 60000, 'the next real sync restores the lineup')
    ok(restored.every((id) => alice.listStreams().some((s) => s.id === id)), `one real sync restored the whole source (${restored.length} channels)`)
    await waitFor(async () => restored.every((id) => bob.listStreams().some((s) => s.id === id)) || null, 60000, 'and bob got it back too')
    floorTo(stB, new Set(['news', 'promo', ...restored]), 'catalog ∪ the restored live-events')
    for (const id of restored) wantAlice.add(id)
    wantAlice.delete('ev.gated')
    floorTo(stA, new Set(['news', 'promo', ...restored, ...payNow]), 'catalog ∪ the restored live-events ∪ pay-events')
  }

  // ===== H. entitlement followed live, in both directions ==================================
  log('\nH. a bouquet change reaches a logged-in viewer with no re-login')
  {
    alice._startEventsRefresh() // leg G stood the periodic tick down; this leg is back to live behaviour
    const payNow = evIds(panel, 'pay-events')
    log(`  …  floor lowered ON PURPOSE: alice is about to LOSE the pay-events bouquet (${payNow.length} channels)`)
    floorTo(stA, new Set(['news', 'promo', ...evIds(panel, 'live-events')]), 'catalog ∪ live-events (pay bouquet revoked)')
    await packages.setUserPackages(panel.ctx, 'alice', [])
    await waitFor(async () => !alice.listStreams().some((s) => payIds.concat(payNow).includes(s.id)) || null, 60000, 'the revoked bouquet leaves the lineup')
    ok(alice._eventSources.join(',') === 'live-events', 'the engine followed the ACL off the signed record')
    ok(!alice.listStreams().some((s) => payNow.includes(s.id)), 'and the pay-events channels left the lineup')
    await assertRejects(() => alice.resolve(payNow[0]), /not entitled/, 'resolve() of a revoked events source')

    // ===== THE RE-GRANT, AGAINST A REFRESH THAT IS ALREADY IN FLIGHT =====================
    //
    // ⚠ THE TICK IS OFF FOR THIS. In production it is FIVE MINUTES; a lane that lets a
    // two-second tick recover proves only that the engine eventually catches up, which it
    // always did. What has to be true is that the GRANT ITSELF carries the bouquet.
    //
    // And the in-flight refresh is the whole point. `_refreshEntitlements` kicks when the
    // ACL moves; an UNFORCED kick is answered by whatever read is already running, and that
    // read captured its `want` before the bouquet existed — so it never fetches the new
    // source's shard, installs an acl key for the OLD list, and reports no change. Measured
    // 30/30 that way: eventSources became A,B while the lineup stayed A's channels only.
    // Held open deterministically here rather than raced, so this lane fails without the fix
    // instead of failing one run in twenty.
    // Re-granting a source the viewer ONCE held needs no read at all: the shard is still
    // cached and the merge filters by the live ACL, so the channels are back on the very
    // next push. That is the cheap half, and it is also what makes it useless as a test of
    // fetching — hence the vip lane below.
    clearInterval(alice._eventsTimer); alice._eventsTimer = null
    await packages.setUserPackages(panel.ctx, 'alice', ['ppv'])
    await waitFor(async () => payNow.every((id) => alice.listStreams().some((s) => s.id === id)) || null, 60000, 'the re-granted bouquet comes back')
    ok(payNow.every((id) => alice.listStreams().some((s) => s.id === id)), 'and re-granting it brings them back — symmetric, because there is no sealed key to lose')
    ok(alice._eventsTimer === null, 'with the periodic tick already off — a re-grant is served from the cache, not from a retry')
    floorTo(stA, new Set(['news', 'promo', ...evIds(panel, 'live-events'), ...payNow]), 'catalog ∪ live-events ∪ pay-events (restored)')

    // ===== A BRAND-NEW BOUQUET, AGAINST A REFRESH THAT IS ALREADY IN FLIGHT ===============
    //
    // `vip-events` has never been in this viewer's ACL, so its shard is not cached and the
    // grant can only land by FETCHING it. Two things are held fixed to make that the only
    // possible explanation:
    //
    //   the tick is OFF — in production it is FIVE MINUTES, and a lane that lets a
    //                     two-second tick recover proves only that the engine eventually
    //                     catches up, which it always did;
    //   a read is IN FLIGHT and held open — because `_refreshEntitlements` kicks when the
    //                     ACL moves, and an UNFORCED kick is answered by whatever read is
    //                     already running. That read captured its `want` before the bouquet
    //                     existed: it never fetches the new shard, installs an acl key for
    //                     the OLD list, and reports no change. Measured 30/30 that way.
    //
    // Held deterministically rather than raced, so this fails without the fix every time
    // instead of one run in twenty.
    // Re-publish it first, so its shard is a FRESH append rather than a block copied into
    // this epoch by leg D's rotation. A copied block sits at the start of the new blob core
    // with the writer's cleared holes around it, and a viewer that never fetched it at the
    // time cannot get it afterwards — real, but a property of the rotation, not of grants,
    // and it would make this lane fail for the wrong reason.
    feeds['/vip.m3u'] = playlist(2, cdnPort, { group: 'VIP', tag: 'vip' })
    await sources.syncSource(panel.ctx, 'vip-events')
    const vipIds = evIds(panel, 'vip-events')
    ok(vipIds.length > 0 && !alice._eventShards.has('vip-events'), `precondition: ${vipIds.length} vip channels published, and this viewer has never fetched their shard`)
    const realGet = alice._eventsDrive.get.bind(alice._eventsDrive)
    let releaseIndex = null
    const gate = new Promise((resolve) => { releaseIndex = resolve })
    let gated = false
    alice._eventsDrive.get = async (p, ...rest) => {
      if (p === '/v1/index.json' && !gated) { gated = true; await gate } // hold the FIRST index read only
      return realGet(p, ...rest)
    }
    const inflight = alice._refreshEvents()
    await waitFor(async () => gated || null, 10000, 'a refresh is parked mid-read')
    ok(alice._eventsRefresh !== null, 'a refresh is in flight, holding the single-flight latch')

    await packages.addPackage(panel.ctx, 'vip', { label: 'VIP', members: 'source:vip-events' })
    await packages.setUserPackages(panel.ctx, 'alice', ['ppv', 'vip'])
    await waitFor(async () => alice._eventSources.includes('vip-events') || null, 60000, 'the grant reached the engine ACL')
    ok(!alice.listStreams().some((id) => vipIds.includes(id.id)), 'and its channels are NOT in the lineup yet — nothing has read that shard')

    // Release. Under the old code the chain predicate asked only about the POINTER, which a
    // bouquet change does not move, so the in-flight verdict was accepted and nothing re-read.
    releaseIndex()
    await inflight
    alice._eventsDrive.get = realGet
    await waitFor(async () => vipIds.every((id) => alice.listStreams().some((s) => s.id === id)) || null, 30000,
      'the brand-new bouquet lands from the GRANT itself, with the periodic tick off')
    ok(vipIds.every((id) => alice.listStreams().some((s) => s.id === id)), `a bouquet granted mid-session FETCHED its shard and appeared (${vipIds.length} channels)`)
    ok(alice._eventsTimer === null, 'and the periodic tick was off throughout — the grant carried it, not a five-minute retry')
    ok(alice._eventsAclAttempted === 'live-events,pay-events,vip-events', `the engine recorded an attempt for the LIVE acl (${alice._eventsAclAttempted})`)
    ok(alice._eventShards.has('vip-events'), 'and really holds the shard now')
    alice._startEventsRefresh()
    floorTo(stA, new Set(['news', 'promo', ...evIds(panel, 'live-events'), ...payNow, ...vipIds]), 'catalog ∪ live-events ∪ pay-events ∪ vip-events')
  }

  // ===== I. NO PUSH -> REFRESH -> PUSH FEEDBACK LOOP ======================================
  log('\nI. a flapping events feed cannot storm the host with emissions')
  {
    // An index whose rev AND shard path move on EVERY read — what a rotation racing a
    // publish, or any panel-side flap, looks like from here. With a push -> refresh edge
    // anywhere in the cycle this is undamped, because a fire-and-forget kick re-enters
    // _pushCatalog AFTER `_pushPending` has cleared and the do/while coalescer cannot absorb
    // it. Measured with that edge present: 41,450 'streams' emissions and 41,449 index reads
    // in three seconds. The trigger is reachable from the events drive, which is explicitly
    // an ACL and not a capability, so an undamped cycle behind it is not acceptable in a
    // build that cannot be recalled.
    log('  …  floor lowered ON PURPOSE: the events half is replaced by a synthetic flapping shard')
    floorTo(stA, new Set(['news', 'promo']), 'catalog only (synthetic flapping shard)')
    const realGet = alice._eventsDrive.get.bind(alice._eventsDrive)
    let flapRev = 20000
    let flapReads = 0
    const flapEntry = (rev) => ([{
      id: 'ev.flap', title: 'Flapping ' + rev, description: '', category: ['Live Events'], type: 'live', protection: 'none',
      feedKey: null, blobsKey: null, redirect: true, url: catalogUrl, headers: null, isLive: true,
      poster: null, backdrop: null, logo: null, order: 0, featured: false, restricted: false,
      status: 'live', source: 'live-events', epgUrl: null, epgId: null, startsAt: null, endsAt: null
    }])
    alice._eventsDrive.get = async (p, ...rest) => {
      if (p === '/v1/index.json') {
        flapReads++
        // pay-events keeps its real shard for the same reason the parked lane does: a source
        // dropped from the index gets re-fetched afterwards, and that is collateral, not the
        // property under test. Only live-events flaps.
        return b4a.from(JSON.stringify({
          rev: ++flapRev,
          updatedAt: Date.now(),
          sources: [{ name: 'live-events', shard: `/v1/flap-${flapRev}.json`, count: 1 }, { name: 'pay-events', shard: panel.events._shards.get('pay-events').shard, count: evIds(panel, 'pay-events').length }]
        }))
      }
      if (String(p).startsWith('/v1/flap-')) return b4a.from(JSON.stringify(flapEntry(p)))
      return realGet(p, ...rest)
    }
    const emissionsBefore = stA.emissions
    const readsBefore = flapReads
    // ⚠ A TRIPWIRE THAT DEFUSES, because a storm STARVES THE TIMER QUEUE: with the loop
    // present, `await sleep(3000)` below never returns and this lane hangs until CI kills
    // the job — a job timeout is a far worse signal than a named failure for whoever picks
    // it up. The listener runs synchronously inside emit(), so it is reached even while
    // timers are starved; restoring the real `get` from inside it stops the flapping, the
    // loop settles, the sleep completes and the assertion below can REPORT the count.
    const STORM_LIMIT = 500
    let stormed = null
    const tripwire = () => {
      const n = stA.emissions - emissionsBefore
      if (n > STORM_LIMIT && stormed === null) {
        stormed = n
        alice._eventsDrive.get = realGet
      }
    }
    alice.on('streams', tripwire)
    await alice._pushCatalog()
    await sleep(3000)
    alice.off('streams', tripwire)
    const emitted = stA.emissions - emissionsBefore
    const read = flapReads - readsBefore
    ok(stormed === null, stormed === null
      ? 'no emission storm — the tripwire never fired'
      : `EMISSION STORM: passed ${STORM_LIMIT} emissions in this lane (${stormed} when the tripwire defused it, ${emitted} total, ${read} index reads) — a push -> refresh edge is back`)
    // The periodic tick is 2 s in this test, so a correct engine refreshes once or twice in
    // three seconds and pushes once per change. The ceiling is deliberately far above that
    // and far below a storm: the property is "bounded by the trigger rate", not a fixed count.
    ok(emitted < 50, `three seconds of a feed that changes on EVERY read produced ${emitted} emission(s) and ${read} index read(s) — bounded by the trigger rate, not by the feed (the push -> refresh edge measured 41,450)`)
    ok(alice._eventsParked <= 4, `and left ${alice._eventsParked} parked read(s)`)

    alice._eventsDrive.get = realGet
    // Refresh AND push explicitly — a push no longer refreshes, which is the whole point of
    // this leg, so a poll that only refreshed would never see the lineup change.
    await waitFor(async () => {
      await alice._refreshEvents()
      await alice._pushCatalog()
      return !alice.listStreams().some((s) => s.id === 'ev.flap') || null
    }, 30000, 'the real lineup comes back once the feed stops flapping')
    ok(!alice.listStreams().some((s) => s.id === 'ev.flap'), 'and the synthetic channel is gone')
    floorTo(stA, new Set(['news', 'promo', ...evIds(panel, 'live-events'), ...evIds(panel, 'pay-events')]), 'catalog ∪ live-events ∪ pay-events (restored)')
  }

  // ===== F. the verdict on every emission of the whole run =================================
  log('\nF. no truncated lineup, across every emission of the run')
  for (const st of [stA, stB]) {
    ok(st.bad.length === 0, `${st.tag}: ${st.emissions} emission(s), none empty and none lost a floor channel`)
    if (st.bad.length) for (const b of st.bad.slice(0, 12)) log('       ' + b)
    ok(Math.min(...st.sizes) >= 2, `${st.tag}: smallest emission was ${Math.min(...st.sizes)} entries (sizes ${JSON.stringify(st.sizes)})`)
  }
  // (No assertion on the bee's total growth here — an append-only core's length can only
  // rise, so `>=` cannot fail. The zero-write claim is asserted where it means something:
  // across the SERVING window in leg E.)
  log(`  …  signed bee after the whole run: ${panel.core.length} blocks / ${panel.core.byteLength} bytes (setup left it at ${beeAfterSetup.length} / ${beeAfterSetup.byteLength})`)

  if (failures) { log(`\nRESULT: FAIL ❌  (${failures} assertion(s))`); await cleanup(); process.exit(1) }
  log('\nRESULT: PASS ✅  (no-drive costs nothing → catalog ∪ events with catalog precedence → an events-only entitlement REFUSED at a catalog record it holds no grant for, and the panel refusing to create that collision at all → per-source ACL proven on reads issued → epoch swap carried by the meta/ watcher alone → drive channel plays real bytes → a parked drive costs a catalog push 0 ms and leaks no reads → bad/mismatched shards survived → live entitlement, and not one truncated lineup)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
