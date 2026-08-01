// End-to-end RE-SOURCE test on a LOCAL DHT testnet (never the public DHT).
// The field defect (S22 release app, 2026-07-31): a viewer whose only feed sources
// were relay peers kept playing off its local window after the relays died, but never
// re-established a source — it held no connection to the still-announced ORIGIN
// broadcaster for 100+ s, and the origin's swarm counter showed the viewer had NEVER
// been connected to it even while healthy (the counter listed exactly the relays).
// The same device held a working panel-swarm connection throughout.
//
// Root cause chain (hyperswarm@4.17.0, file:line evidence in the comments below):
//   1. A dial that keeps failing is retried on M/L/L backoffs and then PARKED:
//      lib/retry-timer.js _selectRetryTimer — `attempts > 3` selects NO timer for a
//      non-explicit peer.
//   2. On that final failed close the PeerInfo is GARBAGE-COLLECTED:
//      index.js conn 'close' -> waiting=false -> _maybeDeletePeer() deletes it.
//      The swarm now knows NOTHING about the origin — there is no backoff to expire.
//   3. Only a topic LOOKUP re-teaches the swarm the origin exists
//      (index.js _handlePeer re-enqueues), and the periodic refresh is ~10-12 min
//      away (lib/peer-discovery.js REFRESH_INTERVAL + RANDOM_JITTER).
//   4. The SDK's tune watchdog stood down when the RELAYS tuned the channel fine, and
//      (pre-fix) nothing post-tune watched the peer set — so when the relays died the
//      viewer sat source-less: no relookup, no retune, no error.
//
// Cast: panel (login RPC + signed DB), synthetic origin broadcaster (encrypted live
// Hyperdrive, rolling playlist, announced server-only), key-holding relay peers
// (reseeding-viewer model: replicate + tail-download, join server+client), and real
// SDK viewers over swarm.bootstrap. The origin's accept gate (a hyperdht server
// firewall) models the field condition "the viewer's dials to the origin fail while
// the relays' connections stand" (full SWARM_MAX_PEERS budget / NAT failure).
//
// Experiments:
//   A  (clean room) origin + 2 relays up, no gate -> the viewer dials ALL of them.
//      The initial dial policy is NOT the defect: hyperswarm dials every announcer.
//   A2 (field state) origin gated against the viewer -> plays fine off the relays,
//      origin never connected; the origin PeerInfo is observed climbing attempts
//      1..3 and then VANISHING from swarm.peers (parked + GC'd).
//   B  (stock defect) gate lifted (origin reachable again), both relays killed ->
//      a viewer with the rescan DISABLED (tune.rescanMs 0 = pre-fix behavior) makes
//      ZERO connections to the origin for the whole 75 s window; playlist frozen.
//   C  (primitive works) reconnectActiveFeed() — the host-ladder escalation — on the
//      same stuck viewer forces discovery.refresh(): the lookup re-discovers the
//      origin and the viewer connects + plays within seconds. The dial/backoff
//      machinery is fine; the defect is that nothing TRIGGERED a lookup.
//   D  (the fix) same field flow with the default tune.rescanMs: the peers ticker
//      sees the active feed at ZERO peers, emits 'feed:rescan', forces the lookup
//      and re-arms the tune watchdog — the viewer re-sources itself unattended.
// Exits 0 on PASS.
import createTestnet from 'hyperdht/testnet.js'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT
} from '@aliran/core'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { createPlayer } from '../sdk/index.js'

const T0 = Date.now()
const t = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's'
const log = (...a) => console.log(t(), ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const hex = (buf) => b4a.toString(buf, 'hex')
async function waitFor (fn, ms, label) {
  const start = Date.now()
  while (Date.now() - start < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(250) }
  throw new Error('timeout: ' + label)
}

const PASSWORD = 'test123'
const DIFFICULTY = 8
const STOCK_WINDOW_MS = 75000 // field observation was 100+ s with no origin connection
const PARK_CAP_MS = 180000 // worst case: ~4 dial timeouts + M/L/L backoffs
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const rmrf = (d) => { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } }

// Names for swarm identities so the logs read like the field report.
const names = new Map()
const who = (pubHex) => names.get(pubHex) || pubHex.slice(0, 8) + '…'

// ---------- instrumentation ----------

// Poll a player's swarm connection set; log joins/leaves; keep an event history.
function watchConnections (player, tag) {
  const st = { current: new Set(), events: [], stopped: false }
  st.done = (async () => {
    while (!st.stopped) {
      const swarm = player._swarm
      if (swarm) {
        const now = new Set([...swarm.connections].map(c => hex(c.remotePublicKey)))
        for (const k of now) if (!st.current.has(k)) { st.events.push({ t: Date.now(), up: true, pub: k }); log(`[${tag}] connection UP   -> ${who(k)}`) }
        for (const k of st.current) if (!now.has(k)) { st.events.push({ t: Date.now(), up: false, pub: k }); log(`[${tag}] connection DOWN -> ${who(k)}`) }
        st.current = now
      }
      await sleep(250)
    }
  })()
  st.has = (pub) => st.current.has(pub)
  st.stop = () => { st.stopped = true }
  return st
}

// Hypercore download attribution: which peer served each block of the active feed
// (metadata + blobs cores; drives are re-attached across retunes).
function attachDownloads (player, tag) {
  const st = { events: [], stopped: false }
  const seen = new Set()
  const hook = (core) => {
    core.on('download', (_i, bytes, from) => {
      const pub = from && from.remotePublicKey ? hex(from.remotePublicKey) : 'unknown'
      st.events.push({ t: Date.now(), pub, bytes: bytes || 0 })
    })
  }
  st.done = (async () => {
    while (!st.stopped) {
      const drive = player._feedDrive
      if (drive && !seen.has(drive)) {
        seen.add(drive)
        try { hook(drive.core); const blobs = await drive.getBlobs(); hook(blobs.core) } catch {}
      }
      await sleep(400)
    }
  })()
  st.firstFromAfter = (pub, since) => { const e = st.events.find(e => e.pub === pub && e.t >= since); return e ? e.t : null }
  st.bytesFrom = (pub) => st.events.filter(e => e.pub === pub).reduce((a, e) => a + e.bytes, 0)
  st.stop = () => { st.stopped = true }
  return st
}

// Model a host player: poll the playlist, fetch the newest segment (this is what
// drives blob replication), track when the playlist last ADVANCED.
function startPlayback (port, tag) {
  const st = { text: '', lastAdvance: 0, stopped: false }
  st.done = (async () => {
    while (!st.stopped) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/index.m3u8`, { signal: AbortSignal.timeout(4000) })
        if (res.ok) {
          const text = await res.text()
          if (text !== st.text) { st.text = text; st.lastAdvance = Date.now() }
          const segs = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
          const newest = segs[segs.length - 1]
          if (newest) await fetch(`http://127.0.0.1:${port}/${newest}`, { signal: AbortSignal.timeout(4000) }).then(r => r.arrayBuffer()).catch(() => {})
        }
      } catch {}
      await sleep(700)
    }
  })()
  st.stop = () => { st.stopped = true }
  return st
}

// Watch the viewer-side PeerInfo for the origin while its dials fail: attempts climb
// 1..3 on the retry-timer (lib/retry-timer.js), then the 4th failure parks the peer
// (attempts > 3 -> no timer) and index.js _maybeDeletePeer GCs it — 'forgotten'.
async function waitOriginParked (player, originPub, tag, capMs) {
  const start = Date.now()
  let maxAttempts = 0
  let last = null
  while (Date.now() - start < capMs) {
    const pi = player._swarm && player._swarm.peers.get(originPub)
    if (pi) {
      maxAttempts = Math.max(maxAttempts, pi.attempts)
      const snap = `attempts=${pi.attempts} priority=${pi.priority} queued=${pi.queued} waiting=${pi.waiting} banned=${pi.banned}`
      if (snap !== last) { last = snap; log(`[${tag}] origin PeerInfo: ${snap}`) }
      if (pi.attempts > 3 && !pi.waiting && !pi.queued) return { state: 'parked', maxAttempts }
    } else if (maxAttempts >= 1) {
      log(`[${tag}] origin PeerInfo GONE from swarm.peers after ${maxAttempts} observed attempts (parked + GC'd — the swarm forgot the origin exists)`)
      return { state: 'forgotten', maxAttempts }
    }
    await sleep(300)
  }
  return { state: 'timeout', maxAttempts }
}

try {
  // ===== Local DHT testnet =====
  const testnet = await createTestnet(3); cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap
  log('testnet up:', JSON.stringify(bootstrap))

  // ===== Panel: keys, user alice + one channel, login RPC =====
  const dirPanel = tmp('e2ers-panel-'); cleanups.push(() => rmrf(dirPanel))
  initKeys(dirPanel)
  const keys = openKeys(dirPanel)
  const { store: panelStore, db } = await openStore(dirPanel, keys); cleanups.push(() => panelStore.close())
  const encKey = hcrypto.randomBytes(32)

  // ===== Origin broadcaster: encrypted live drive, server-only announce, ACCEPT GATE =====
  const dirOrigin = tmp('e2ers-origin-'); cleanups.push(() => rmrf(dirOrigin))
  const originStore = new Corestore(dirOrigin); await originStore.ready(); cleanups.push(() => originStore.close())
  const feed = new Hyperdrive(originStore.namespace('feed'), { encryptionKey: encKey }); await feed.ready()
  // gate = null: accept all. gate = Set<hexPub>: accept ONLY those swarm identities —
  // everyone else is firewalled at the hyperdht server (models a full accept
  // budget / the origin unreachable for THIS viewer while the relays stand).
  let gate = null
  const originSwarm = new Hyperswarm({ bootstrap, firewall: (remotePub) => (gate ? !gate.has(hex(remotePub)) : false) })
  cleanups.push(() => originSwarm.destroy())
  const originLog = [] // every server connection the origin accepts: { t, pub }
  originSwarm.on('connection', (s) => {
    originLog.push({ t: Date.now(), pub: hex(s.remotePublicKey) })
    log(`[origin] accepted connection from ${who(hex(s.remotePublicKey))}`)
    originStore.replicate(s)
  })
  originSwarm.join(feed.discoveryKey, { server: true, client: false }); await originSwarm.flush()
  const originPub = hex(originSwarm.keyPair.publicKey)
  names.set(originPub, 'origin')
  // Lift the gate AND clear the bans _handleFirewall recorded while it was closed
  // (banned PeerInfos are exempt from GC and would keep rejecting the viewer).
  const liftGate = () => {
    gate = null
    for (const pi of originSwarm.peers.values()) if (pi.banned) pi.ban(false)
    log('[origin] accept gate LIFTED (bans cleared) — the origin is reachable again')
  }

  // Synthetic live feed: one ~24 KB segment (= one blobs block) per 700 ms tick,
  // playlist lists the newest 6, window pruned at 12 back.
  let seq = 0
  async function appendSegment () {
    const i = seq++
    const seg = Buffer.alloc(24000); seg.fill(`ALIRAN-RESOURCE-TEST#${i}|`)
    await feed.put(`/seg${i}.ts`, seg)
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${Math.max(0, i - 5)}`]
    for (let k = Math.max(0, i - 5); k <= i; k++) lines.push('#EXTINF:0.7,', `seg${k}.ts`)
    await feed.put('/index.m3u8', b4a.from(lines.join('\n') + '\n'))
    if (i - 12 >= 0) { try { await feed.del(`/seg${i - 12}.ts`) } catch {} }
  }
  await appendSegment(); await appendSegment(); await appendSegment()
  let tickBusy = false
  const ticker = setInterval(() => { if (tickBusy) return; tickBusy = true; appendSegment().catch(() => {}).then(() => { tickBusy = false }) }, 700)
  cleanups.push(() => clearInterval(ticker))
  const feedKeyHex = hex(feed.key)
  const encKeyHex = hex(encKey)
  log('origin: live encrypted feed, announced server-only; feedKey', feedKeyHex.slice(0, 16) + '…')

  // ===== Panel records: alice entitled to ch1, catalog names the origin's feed =====
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
    wrapped: { ch1: sealTo(kp.publicKey, encKey) },
    devices: [], tokenVersion: 1, maxDevices: 8, status: 'active'
  })
  await db.put('catalog/ch1', { title: 'Channel One', category: ['news'], type: 'live', protection: 'self', feedKey: feedKeyHex, isLive: true, poster: null, status: 'live' })
  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  const throttle = makeThrottle(1000, 120)
  const panelSwarm = new Hyperswarm({ bootstrap }); cleanups.push(() => panelSwarm.destroy())
  panelSwarm.on('connection', (socket) => { panelStore.replicate(socket); attachLoginRpc(socket, { keys, difficulty: DIFFICULTY, throttle, db, sessionTtlMs: 3600000 }) })
  panelSwarm.join(hcrypto.hash(keys.signing.publicKey), { server: true, client: false }); await panelSwarm.flush()
  names.set(hex(panelSwarm.keyPair.publicKey), 'panel')
  log('panel: serving login RPC')

  // ===== Relays: key-holding reseeders (the swarm-sim pattern), server+client =====
  async function startRelay (name) {
    const dir = tmp(`e2ers-${name}-`)
    const store = new Corestore(dir); await store.ready()
    const drive = new Hyperdrive(store.namespace('relay'), b4a.from(feedKeyHex, 'hex'), { encryptionKey: b4a.from(encKeyHex, 'hex') })
    await drive.ready()
    const swarm = new Hyperswarm({ bootstrap })
    swarm.on('connection', (s) => store.replicate(s))
    swarm.join(drive.discoveryKey, { server: true, client: true }); await swarm.flush()
    const st = { name, pubHex: hex(swarm.keyPair.publicKey), segs: 0, stopped: false }
    names.set(st.pubHex, name)
    st.loop = (async () => {
      while (!st.stopped) {
        try {
          const buf = await Promise.race([drive.get('/index.m3u8'), sleep(2500)])
          if (buf) {
            const uris = b4a.toString(buf).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
            for (const u of uris.slice(-4)) {
              if (st.stopped) break
              try { const b = await Promise.race([drive.get('/' + u), sleep(2500)]); if (b) st.segs++ } catch {}
            }
          }
        } catch {}
        await sleep(600)
      }
    })()
    st.stop = async () => {
      st.stopped = true
      await st.loop.catch(() => {})
      try { await swarm.destroy() } catch {}
      try { await store.close() } catch {}
      rmrf(dir)
      log(`[${name}] KILLED (swarm destroyed, store closed)`)
    }
    return st
  }
  const relay1 = await startRelay('relay1'); cleanups.push(() => relay1.stop())
  const relay2 = await startRelay('relay2'); cleanups.push(() => relay2.stop())
  await waitFor(() => relay1.segs >= 3 && relay2.segs >= 3, 60000, 'relays warm (each replicated >= 3 segments)')
  log('relays: warm — both hold the live window and announce on the feed topic')

  // ===== SDK viewer factory =====
  async function makeViewer (tag, tune) {
    const dir = tmp(`e2ers-${tag}-`)
    const player = createPlayer({ panelPubKey, storeDir: dir, swarm: { bootstrap }, ...(tune ? { tune } : {}) })
    const st = { player, dir, events: [] }
    player.on('status', (s) => { st.events.push({ t: Date.now(), type: 'status', state: s.state }); log(`[${tag}] status: ${s.state}`) })
    player.on('error', (e) => { st.events.push({ t: Date.now(), type: 'error', message: String(e.message) }); log(`[${tag}] error: ${e.message}`) })
    player.on('peers', (n) => { st.events.push({ t: Date.now(), type: 'peers', n }) })
    cleanups.push(async () => { try { await player.stop() } catch {}; rmrf(dir) })
    await player.connect()
    st.pubHex = hex(player._swarm.keyPair.publicKey)
    names.set(st.pubHex, tag)
    const deadline = Date.now() + 60000
    let streams = null
    while (!streams) {
      if (Date.now() > deadline) throw new Error(`timeout: ${tag} login`)
      try {
        const s = await player.login('alice', PASSWORD)
        if (s.length >= 1) streams = s
      } catch (e) {
        if (!/not connected|unknown user/i.test(String(e.message))) throw e
      }
      if (!streams) await sleep(1500)
    }
    log(`[${tag}] logged in; entitled to`, JSON.stringify(streams.map(x => x.id)))
    st.hadEvent = (type, state, since = 0) => st.events.some(e => e.type === type && (state == null || e.state === state) && e.t >= since)
    return st
  }
  const firstOriginConnAfter = (pub, since) => { const e = originLog.find(e => e.pub === pub && e.t >= since); return e ? e.t : null }

  // ============================================================================
  // EXPERIMENT A — clean room: origin + both relays up, no gate. Does the viewer
  // dial the origin when fast relays exist?
  // ============================================================================
  log('===== EXPERIMENT A: clean-room dial policy =====')
  const v1 = await makeViewer('viewer1', null)
  const conn1 = watchConnections(v1.player, 'viewer1')
  const dl1 = attachDownloads(v1.player, 'viewer1')
  const res1 = await v1.player.resolve('ch1')
  const pb1 = startPlayback(res1.port, 'viewer1')
  await waitFor(() => pb1.lastAdvance > 0, 30000, 'viewer1 playlist lands')
  await waitFor(() => conn1.has(originPub) && conn1.has(relay1.pubHex) && conn1.has(relay2.pubHex), 25000,
    'viewer1 connects to origin AND both relays')
  assert.ok(firstOriginConnAfter(v1.pubHex, 0), 'origin swarm counter shows viewer1')
  await sleep(4000) // let some blocks flow for attribution
  const a1 = pb1.lastAdvance
  await waitFor(() => pb1.lastAdvance > a1, 15000, 'viewer1 playlist ADVANCES')
  log(`RESULT A: a clean-room viewer dials EVERY announcer — origin + relay1 + relay2 all connected`)
  log(`RESULT A: block attribution (bytes): origin=${dl1.bytesFrom(originPub)} relay1=${dl1.bytesFrom(relay1.pubHex)} relay2=${dl1.bytesFrom(relay2.pubHex)}`)
  log('RESULT A: the initial dial policy is NOT the defect — the field state needs the origin dials to FAIL')
  pb1.stop(); conn1.stop(); dl1.stop()
  await v1.player.stop()

  // ============================================================================
  // EXPERIMENT A2 — the field state: the origin's accept gate rejects the viewer
  // (relays only). The viewer must play fine off the relays with the origin
  // never connected, and hyperswarm must park + forget the origin.
  // ============================================================================
  log('===== EXPERIMENT A2: field state (origin gated, relays serve) =====')
  gate = new Set([relay1.pubHex, relay2.pubHex])
  log('[origin] accept gate ON: only relay1/relay2 may connect')
  // rescanMs 0 = the PRE-FIX engine (experiments B/C need stock behavior).
  const v2 = await makeViewer('viewer2', { rescanMs: 0 })
  const conn2 = watchConnections(v2.player, 'viewer2')
  const dl2 = attachDownloads(v2.player, 'viewer2')
  const res2 = await v2.player.resolve('ch1')
  const pb2 = startPlayback(res2.port, 'viewer2')
  await waitFor(() => pb2.lastAdvance > 0, 30000, 'viewer2 playlist lands (via the relays)')
  const parked = await waitOriginParked(v2.player, originPub, 'viewer2', PARK_CAP_MS)
  assert.ok(parked.state !== 'timeout', `origin dials observed + parked within ${PARK_CAP_MS / 1000}s (got: ${JSON.stringify(parked)})`)
  assert.ok(parked.maxAttempts >= 1, 'viewer2 DID try to dial the origin (dials observed, all failed)')
  assert.ok(!firstOriginConnAfter(v2.pubHex, 0), 'origin swarm counter NEVER shows viewer2 (matches the field report)')
  assert.ok(Date.now() - pb2.lastAdvance < 8000, 'viewer2 still plays fine off the relays')
  assert.ok(conn2.has(relay1.pubHex) || conn2.has(relay2.pubHex), 'viewer2 is connected to the relays')
  log(`RESULT A2: field state REPRODUCED — viewer2 plays off the relays, its ${parked.maxAttempts}+ origin dials all failed, and hyperswarm ${parked.state === 'forgotten' ? 'parked then FORGOT the origin (PeerInfo GC)' : 'parked the origin'} — no retry timer remains (retry-timer.js: attempts > 3 -> none)`)

  // ============================================================================
  // EXPERIMENT B — stock behavior at relay death: gate lifted (origin reachable
  // again — e.g. slots freed by the dying relays), both relays killed. The
  // pre-fix viewer must sit source-less: no origin connection, playlist frozen.
  // ============================================================================
  log('===== EXPERIMENT B: relays die; STOCK viewer (rescan disabled) =====')
  liftGate()
  await relay1.stop(); await relay2.stop()
  const tKill = Date.now()
  log(`[viewer2] both relays killed at t=${t()}; observing ${STOCK_WINDOW_MS / 1000}s of stock behavior…`)
  await sleep(STOCK_WINDOW_MS)
  const stockConn = firstOriginConnAfter(v2.pubHex, tKill)
  const frozenForMs = Date.now() - pb2.lastAdvance
  const lastPeers = [...v2.events].reverse().find(e => e.type === 'peers')
  log(`RESULT B: after ${STOCK_WINDOW_MS / 1000}s — origin connection: ${stockConn ? 'YES at +' + ((stockConn - tKill) / 1000).toFixed(1) + 's' : 'NONE'}; playlist frozen for ${(frozenForMs / 1000).toFixed(1)}s; last peers ticker: ${lastPeers && lastPeers.n}`)
  assert.ok(!stockConn, `DEFECT REPRODUCED: stock viewer must NOT reach the origin unaided within ${STOCK_WINDOW_MS / 1000}s (hyperswarm forgot the origin; next topic lookup is ~10-12 min away; nothing in the pre-fix SDK forces one) — if this fails, stock code recovered by itself`)
  assert.ok(frozenForMs > STOCK_WINDOW_MS - 15000, 'viewer2 playlist is frozen (no source since the kill)')

  // ============================================================================
  // EXPERIMENT C — the recovery PRIMITIVE works, it just never ran: one
  // reconnectActiveFeed() (what the host stall ladder calls) forces
  // discovery.refresh() -> the lookup re-discovers the origin -> dial -> play.
  // ============================================================================
  log('===== EXPERIMENT C: reconnectActiveFeed() on the stuck viewer =====')
  const tRedial = Date.now()
  v2.player.reconnectActiveFeed()
  const cConnAt = await waitFor(() => firstOriginConnAfter(v2.pubHex, tRedial), 30000, 'origin sees viewer2 after the forced refresh')
  const cBlockAt = await waitFor(() => dl2.firstFromAfter(originPub, tRedial), 30000, 'first block from the origin')
  await waitFor(() => pb2.lastAdvance >= tRedial, 30000, 'viewer2 playlist advances again')
  log(`RESULT C: forced refresh -> origin connected in ${((cConnAt - tRedial) / 1000).toFixed(1)}s, first origin block in ${((cBlockAt - tRedial) / 1000).toFixed(1)}s, playback resumed — the lookup/dial machinery is healthy; the defect is purely the missing trigger`)
  pb2.stop(); conn2.stop(); dl2.stop()
  await v2.player.stop()

  // ============================================================================
  // EXPERIMENT D — the fix: default tune.rescanMs. Same field flow; after the
  // relays die the engine must emit 'feed:rescan', force the lookup itself and
  // re-source from the origin UNATTENDED.
  // ============================================================================
  log('===== EXPERIMENT D: relays die; FIXED viewer (default rescan) =====')
  const relay3 = await startRelay('relay3'); cleanups.push(() => relay3.stop())
  const relay4 = await startRelay('relay4'); cleanups.push(() => relay4.stop())
  await waitFor(() => relay3.segs >= 3 && relay4.segs >= 3, 60000, 'fresh relays warm')
  gate = new Set([relay3.pubHex, relay4.pubHex])
  log('[origin] accept gate ON: only relay3/relay4 may connect')
  const v3 = await makeViewer('viewer3', null) // DEFAULT tune -> rescanMs 10000 (the fix)
  const conn3 = watchConnections(v3.player, 'viewer3')
  const dl3 = attachDownloads(v3.player, 'viewer3')
  const res3 = await v3.player.resolve('ch1')
  const pb3 = startPlayback(res3.port, 'viewer3')
  await waitFor(() => pb3.lastAdvance > 0, 30000, 'viewer3 playlist lands (via the relays)')
  const parked3 = await waitOriginParked(v3.player, originPub, 'viewer3', PARK_CAP_MS)
  assert.ok(parked3.state !== 'timeout' && parked3.maxAttempts >= 1, `viewer3 reaches the same field state (got: ${JSON.stringify(parked3)})`)
  assert.ok(!firstOriginConnAfter(v3.pubHex, 0), 'origin never saw viewer3 while gated')
  liftGate()
  await relay3.stop(); await relay4.stop()
  const tKill3 = Date.now()
  log(`[viewer3] both relays killed at t=${t()}; the engine is on its own (no host ladder, no manual call)…`)
  await waitFor(() => v3.hadEvent('status', 'feed:rescan', tKill3), 60000, "the engine emits 'feed:rescan' (zero-peer watch fired)")
  const dConnAt = await waitFor(() => firstOriginConnAfter(v3.pubHex, tKill3), 60000, 'origin sees viewer3 unattended')
  const dBlockAt = await waitFor(() => dl3.firstFromAfter(originPub, tKill3), 60000, 'first origin block for viewer3')
  await waitFor(() => pb3.lastAdvance >= tKill3, 60000, 'viewer3 playlist advances again')
  const dConnSec = (dConnAt - tKill3) / 1000
  const dBlockSec = (dBlockAt - tKill3) / 1000
  assert.ok(dConnSec < 45, `unattended re-source within 45s (took ${dConnSec.toFixed(1)}s)`)
  log(`RESULT D: FIXED viewer re-sourced UNATTENDED — 'feed:rescan' fired, origin connected in ${dConnSec.toFixed(1)}s, first origin block in ${dBlockSec.toFixed(1)}s (stock: NONE in ${STOCK_WINDOW_MS / 1000}s)`)
  pb3.stop(); conn3.stop(); dl3.stop()
  await v3.player.stop()

  log('\nRESULT: PASS ✅  (clean-room dials all announcers -> field state reproduced [origin parked+forgotten] -> stock viewer stuck source-less -> refresh primitive recovers in seconds -> tune.rescanMs re-sources unattended)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
