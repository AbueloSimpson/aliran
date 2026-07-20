// End-to-end v0.2 test: broadcaster auto-registers a feed with the panel, then a granted
// user logs in and recovers the registered key. S20a adds the blobsKey enrichment round
// trip: the panel opens the announced feed drive with its stored encryptionKey and
// publishes the blobs-core key in the catalog (async), clears + re-enriches it across a
// feedKey rotation, and preserves it across a same-key re-register. S29 adds the
// register-idempotence assertions: an unchanged re-register (the 5-min broadcaster
// heartbeat) must append ZERO blocks to the append-only bee while still storing the
// private secret, and a changed field must still write. It also proves the enrichment
// probes are DISPOSABLE — repeated rotations and a permanently unreachable feed must leave
// the panel's own on-disk core set unchanged — and, at the end, that a restart RECLAIMS the
// cores older (pre-purge) builds stranded, with accounts, catalog and assets intact.
// No ffmpeg needed. Exits 0 on PASS.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Hyperbee from 'hyperbee'
import hcrypto from 'hypercore-crypto'
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair, ARGON2_DEFAULT
} from '@aliran/core'
import { panelClient as clientRpc, login } from '../client/backend/login.mjs'
import { panelClient as pubRpc, registerWithPanel } from '../broadcaster/src/register.js'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, reclaimStrayCores, loadSecrets, saveSecrets } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { makeBlobsKeyEnricher } from '../panel/src/blobs-key.js'
import { addPublisher, setPublisherStatus, setPublisherScopes, loadPublishers } from '../panel/src/ops.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) } throw new Error('timeout: ' + label) }
const log = (...a) => console.log(...a)

// Corestore lays cores out at <dir>/cores/<id[0:2]>/<id[2:4]>/<id>/ (id = discovery key
// hex). Counting those leaves is how we assert the panel's control-plane disk stays
// BOUNDED across feedKey rotations: every blobsKey probe opens the feed drive on the
// panel's OWN corestore, and a probe that only close()s leaves its cores there forever
// (one metadata + one blobs core per DISTINCT feedKey ever seen — and S28's periodic
// feed rotation mints a fresh feedKey per rotation).
function panelCores (dir) {
  const out = []
  const walk = (d, depth) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      if (depth === 2) { if (/^[0-9a-f]{64}$/.test(e.name)) out.push(e.name) } else walk(path.join(d, e.name), depth + 1)
    }
  }
  walk(path.join(dir, 'cores'), 0)
  return out
}

const DIFFICULTY = 8; const PASSWORD = 'test123'
const dirs = { panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-panel-')), feed: fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-feed-')), cli: fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-cli-')) }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Panel =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db, assets, core: panelCore } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const throttle = makeThrottle(1000, 60)
  const topic = hcrypto.hash(keys.signing.publicKey)
  const panelSwarm = new Hyperswarm(); cleanups.push(() => panelSwarm.destroy())
  // S20a blobsKey enrichment: register nudges it; it opens the feed drive with the
  // panel-stored encryptionKey (client-mode join on the panel's own swarm) and writes
  // the blobs-core key into the public record.
  const enrich = makeBlobsKeyEnricher({ store: panelStore, swarm: panelSwarm, db, dataDir: dirs.panel })
  cleanups.push(() => enrich.close())
  // legacyOn is read at CONNECTION time — flipped to false later to prove the
  // LEGACY_PUBLISHER=0 cutover on a fresh connection (S26).
  let legacyOn = true
  panelSwarm.on('connection', (s) => { panelStore.replicate(s); attachLoginRpc(s, { keys, difficulty: DIFFICULTY, throttle, db, dataDir: dirs.panel, sessionTtlMs: 3600000, enrich, legacyPublisher: legacyOn }) })
  panelSwarm.join(topic, { server: true, client: false }); await panelSwarm.flush()

  // ===== Broadcaster feed + auto-register =====
  const encKey = hcrypto.randomBytes(32)
  const feedStore = new Corestore(dirs.feed); await feedStore.ready(); cleanups.push(() => feedStore.close())
  const feed = new Hyperdrive(feedStore.namespace('feed'), { encryptionKey: encKey }); await feed.ready()
  // The drive header (block 0, which carries the blobs-core key) only exists once
  // something is written — a live feed always has content, so mirror that here.
  await feed.put('/index.m3u8', b4a.from('#EXTM3U'))
  const feedKeyHex = b4a.toString(feed.key, 'hex'); const encKeyHex = b4a.toString(encKey, 'hex')

  // Announce the feed itself (what a running broadcaster channel does) so the panel's
  // enricher can replicate the drive header over the DHT.
  const feedSwarm = new Hyperswarm(); cleanups.push(() => feedSwarm.destroy())
  feedSwarm.on('connection', (s) => feedStore.replicate(s))
  feedSwarm.join(feed.discoveryKey, { server: true, client: false }); await feedSwarm.flush()

  const bSwarm = new Hyperswarm(); cleanups.push(() => bSwarm.destroy())
  let pcall = null
  bSwarm.on('connection', (s) => { if (!pcall) pcall = pubRpc(s).call })
  bSwarm.join(topic, { client: true, server: false })
  await waitFor(async () => pcall, 30000, 'broadcaster→panel connection')

  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'news', feedKey: feedKeyHex, encryptionKey: encKeyHex, title: 'News 24', category: ['news'], isLive: true
  })
  log('broadcaster: registered "news" with the panel')

  // catalog is public + has NO encryptionKey; the secret is stored privately
  const cat = (await db.get('catalog/news')).value
  assert.strictEqual(cat.feedKey, feedKeyHex, 'catalog feedKey')
  assert.strictEqual(cat.encryptionKey, undefined, 'catalog must NOT contain encryptionKey')
  assert.strictEqual(cat.isLive, true, 'catalog isLive')
  assert.strictEqual(loadSecrets(dirs.panel).news, encKeyHex, 'panel-private secret stored')
  // Enrichment is ASYNC — the register reply above must not have waited on the drive
  // open (the header replicates over the DHT, seconds away at best).
  assert.strictEqual(cat.blobsKey ?? null, null, 'register replies before enrichment (never blocks on the drive open)')
  log('panel: catalog written (no encKey); encryption key stored privately ✓')

  // ===== S20a: blobsKey catalog enrichment (Option B — the repeater enabler) =====
  // The panel must publish the feed's REAL blobs-core key (named core, key only inside
  // the encrypted bee header — not publicly derivable) shortly after registration.
  const realBlobsKey = b4a.toString((await feed.getBlobs()).core.key, 'hex')
  const enriched = await waitFor(async () => (await db.get('catalog/news'))?.value?.blobsKey, 90000, 'blobsKey enrichment')
  assert.strictEqual(enriched, realBlobsKey, "catalog blobsKey equals the drive's real blobs-core key")
  assert.notStrictEqual(enriched, feedKeyHex, 'blobsKey is a distinct core key, not the feedKey')
  log('panel: catalog enriched with the real blobsKey (async, zero broadcaster changes) ✓')

  // The probe is DISPOSABLE: it opened the feed's metadata + blobs cores on the panel's own
  // corestore to read one block, and must leave neither behind. (blobsKey lands in the
  // catalog only after the probe's teardown, so this is a quiescent point.)
  const disc = (hex) => b4a.toString(hcrypto.discoveryKey(b4a.from(hex, 'hex')), 'hex')
  const baseCores = panelCores(dirs.panel)
  assert.ok(!baseCores.includes(disc(feedKeyHex)), 'probe left no feed metadata core on the panel')
  assert.ok(!baseCores.includes(disc(realBlobsKey)), 'probe left no feed blobs core on the panel')
  log(`panel: probe purged its cores — panel store holds only its own ${baseCores.length} core(s) ✓`)

  // ===== S29: an unchanged re-register is IDEMPOTENT — it appends NOTHING =====
  // The broadcaster re-asserts every RUNNING stream on a 5-min heartbeat. The bee is
  // append-only and the panel never compacts, so re-putting an identical record would
  // grow the panel store forever (measured on the VPS: 1.9 GB at 43 channels).
  const beeLen = () => db.core.length
  const beforeNoop = beeLen()
  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'news', feedKey: feedKeyHex, encryptionKey: encKeyHex, isLive: true
  })
  await sleep(500) // the register also nudges the enricher — that must not write either
  assert.strictEqual(beeLen(), beforeNoop, 'unchanged re-register appends NOTHING to the bee')
  // …and a same-feedKey re-register still PRESERVES the blobsKey (record left untouched).
  assert.strictEqual((await db.get('catalog/news')).value.blobsKey, realBlobsKey, 'same-feedKey re-register preserves blobsKey')

  // The private secrets file is NOT the bee: a SKIPPED catalog write must still store the
  // encryptionKey. Drop the secret, re-register unchanged — it comes back, bee untouched.
  const dropped = loadSecrets(dirs.panel); delete dropped.news; saveSecrets(dirs.panel, dropped)
  const beforeSecret = beeLen()
  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'news', feedKey: feedKeyHex, encryptionKey: encKeyHex, isLive: true
  })
  assert.strictEqual(loadSecrets(dirs.panel).news, encKeyHex, 'skipped catalog write still restores the private secret')
  assert.strictEqual(beeLen(), beforeSecret, 'restoring the secret appended nothing to the bee')

  // A CHANGED field still writes. isLive:false flips status→idle and costs one append…
  const beforeChange = beeLen()
  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'news', feedKey: feedKeyHex, encryptionKey: encKeyHex, isLive: false
  })
  assert.ok(beeLen() > beforeChange, 'a CHANGED register still writes to the bee')
  const flipped = (await db.get('catalog/news')).value
  assert.strictEqual(flipped.isLive, false, 'the changed field landed')
  assert.strictEqual(flipped.status, 'idle', 'status follows isLive')
  // …and repeating THAT payload is itself a no-op (idempotence holds at the new state).
  const beforeRepeat = beeLen()
  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'news', feedKey: feedKeyHex, encryptionKey: encKeyHex, isLive: false
  })
  assert.strictEqual(beeLen(), beforeRepeat, 'repeating the changed payload appends nothing')
  // Restore live for the rest of the test (a real change again → one more append).
  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'news', feedKey: feedKeyHex, encryptionKey: encKeyHex, isLive: true
  })
  assert.strictEqual((await db.get('catalog/news')).value.isLive, true, 'restored isLive')
  log('panel: unchanged re-register = zero bee appends; changed fields still write ✓')

  // …and a feedKey ROTATION (broadcaster source change / RAM restart / S28's periodic feed
  // rotation) must clear it immediately and re-enrich against the NEW drive.
  // Mint the next generation the way a rotating broadcaster does, register it, and wait for
  // the panel to re-enrich. Returns the new drive's real blobs-core key.
  async function rotateFeed (drive) {
    await drive.put('/index.m3u8', b4a.from('#EXTM3U')) // header exists once content does
    const keyHex = b4a.toString(drive.key, 'hex')
    feedSwarm.join(drive.discoveryKey, { server: true, client: false }); await feedSwarm.flush()
    await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
      streamId: 'news', feedKey: keyHex, encryptionKey: encKeyHex, isLive: true
    })
    const rotated = (await db.get('catalog/news')).value
    assert.strictEqual(rotated.feedKey, keyHex, 'rotation: catalog follows the new feedKey')
    assert.strictEqual(rotated.blobsKey ?? null, null, 'rotation: stale blobsKey cleared with the register itself')
    const realKey = b4a.toString((await drive.getBlobs()).core.key, 'hex')
    const got = await waitFor(async () => (await db.get('catalog/news'))?.value?.blobsKey, 90000, 'blobsKey re-enrichment after rotation')
    assert.strictEqual(got, realKey, "re-enriched blobsKey equals the NEW drive's blobs-core key")
    return realKey
  }

  const feed2 = new Hyperdrive(feedStore.namespace('feed2'), { encryptionKey: encKey }); await feed2.ready()
  const feedKey2Hex = b4a.toString(feed2.key, 'hex')
  const realBlobsKey2 = await rotateFeed(feed2)
  assert.notStrictEqual(realBlobsKey2, realBlobsKey, 'rotation produced a different blobs core')
  log('panel: feedKey rotation cleared + re-enriched blobsKey ✓')

  // S28 rotates a live feed periodically (FEED_ROTATE_TREE_MB / FEED_ROTATE_HOURS), and each
  // rotation mints a feedKey the panel has never probed before. The enricher opens those
  // drives on the panel's OWN corestore, so its footprint must be a function of what the
  // panel OWNS — not of how many feedKeys have ever passed through it.
  for (let gen = 3; gen <= 5; gen++) {
    const next = new Hyperdrive(feedStore.namespace('feed' + gen), { encryptionKey: encKey }); await next.ready()
    await rotateFeed(next)
    const now = panelCores(dirs.panel)
    assert.deepStrictEqual(now.sort(), [...baseCores].sort(),
      `rotation ${gen}: panel core set must be unchanged (was ${baseCores.length}, now ${now.length}) — probe cores are leaking`)
  }
  log(`panel: 4 feedKey rotations left the panel store at ${baseCores.length} core(s) — enrichment disk is O(panel), not O(rotations × channels) ✓`)

  // An UNREACHABLE feed is the ordinary enrichment case — a broadcaster that is offline, or
  // a channel so freshly started that nothing has been written yet — and the one that used
  // to leak hardest: every timed-out attempt abandoned another core. Drive it with a
  // short-timeout enricher of its own: it must park cleanly and leave the store untouched.
  const ghostKey = b4a.toString(hcrypto.randomBytes(32), 'hex')
  await db.put('catalog/ghost', { id: 'ghost', title: 'Ghost', feedKey: ghostKey })
  saveSecrets(dirs.panel, { ...loadSecrets(dirs.panel), ghost: encKeyHex })
  const ghostEnrich = makeBlobsKeyEnricher(
    { store: panelStore, swarm: panelSwarm, db, dataDir: dirs.panel },
    { attemptTimeoutMs: 1500, backoffBaseMs: 200, backoffMaxMs: 200, maxAttempts: 3 }
  )
  ghostEnrich.enqueue('ghost')
  await waitFor(async () => ghostEnrich.pending() === 0, 60000, 'unreachable feed parks after its retries')
  assert.strictEqual((await db.get('catalog/ghost')).value.blobsKey ?? null, null, 'unreachable feed stays un-enriched')
  assert.deepStrictEqual(panelCores(dirs.panel).sort(), [...baseCores].sort(), 'a parked probe leaves no cores behind')
  await ghostEnrich.close()
  await db.del('catalog/ghost')
  const { ghost, ...keptSecrets } = loadSecrets(dirs.panel); saveSecrets(dirs.panel, keptSecrets)
  log('panel: an unreachable feed parks after its retries and leaves no probe cores ✓')

  // ===== Unauthorized publisher is rejected =====
  let unauth = false
  try {
    await registerWithPanel(pcall, b4a.toString(authKeyPair().secretKey, 'hex'), { streamId: 'evil', feedKey: feedKeyHex, encryptionKey: encKeyHex })
  } catch (e) { unauth = /unauthorized/.test(e.message) }
  assert.ok(unauth, 'wrong publisher key must be rejected')
  assert.ok(!(await db.get('catalog/evil')), 'unauthorized stream must not be written')
  log('panel: unauthorized publisher rejected ✓')

  // ===== S26: enrolled publishers — per-site keys + admin-assigned channel scopes =====
  const pctx = { dataDir: dirs.panel }
  const east = addPublisher(pctx, 'east', { scopes: 'scoped-*' })
  assert.match(east.secretKey, /^[0-9a-f]{128}$/, 'enrollment returns the site secret once')
  assert.ok(!JSON.stringify(loadPublishers(dirs.panel)).includes(east.secretKey), 'registry stores ONLY the public key')

  // In-scope named register: verified against the ENROLLED key, origin stamped.
  await registerWithPanel(pcall, east.secretKey, {
    publisher: 'east', streamId: 'scoped-1', feedKey: feedKey2Hex, encryptionKey: encKeyHex, title: 'Scoped', isLive: true
  })
  const scoped = (await db.get('catalog/scoped-1')).value
  assert.strictEqual(scoped.origin, 'east', 'catalog record carries origin:<name>')
  assert.strictEqual(loadSecrets(dirs.panel)['scoped-1'], encKeyHex, 'named register stores the private secret')
  log('panel: named publisher registered in-scope; origin stamped ✓')

  // Out-of-scope streamId: rejected BEFORE any write (catalog + secrets + isLive all
  // sit behind the same responder, so this one gate covers them all).
  const rejectCode = async (secret, payload) => {
    try { await registerWithPanel(pcall, secret, payload); return null } catch (e) { return e.message }
  }
  let code = await rejectCode(east.secretKey, { publisher: 'east', streamId: 'other-1', feedKey: feedKey2Hex, encryptionKey: encKeyHex, isLive: true })
  assert.match(code, /out-of-scope/, 'out-of-scope streamId rejected')
  assert.ok(!(await db.get('catalog/other-1')), 'out-of-scope wrote no catalog record')
  assert.strictEqual(loadSecrets(dirs.panel)['other-1'], undefined, 'out-of-scope wrote no secret')

  // A named entry still verifies the signature — the right name with the wrong key fails.
  code = await rejectCode(b4a.toString(authKeyPair().secretKey, 'hex'), { publisher: 'east', streamId: 'scoped-1', feedKey: feedKey2Hex, isLive: true })
  assert.match(code, /unauthorized/, 'named publisher with a wrong key rejected')

  // Unknown name.
  code = await rejectCode(east.secretKey, { publisher: 'nobody', streamId: 'scoped-1', feedKey: feedKey2Hex, isLive: true })
  assert.match(code, /unknown-publisher/, 'unknown publisher name rejected')

  // Revoke = status flip (no global re-key); re-activate re-accepts the SAME key.
  setPublisherStatus(pctx, 'east', 'revoked')
  code = await rejectCode(east.secretKey, { publisher: 'east', streamId: 'scoped-1', feedKey: feedKey2Hex, isLive: false })
  assert.match(code, /revoked/, 'revoked publisher rejected')
  assert.strictEqual((await db.get('catalog/scoped-1')).value.isLive, true, 'revoked register did not flip isLive')
  setPublisherStatus(pctx, 'east', 'active')
  await registerWithPanel(pcall, east.secretKey, { publisher: 'east', streamId: 'scoped-1', feedKey: feedKey2Hex, isLive: false })
  assert.strictEqual((await db.get('catalog/scoped-1')).value.isLive, false, 're-activated publisher registers again')
  log('panel: out-of-scope / wrong-key / unknown / revoked all rejected before any write ✓')

  // Scope edits are live: the registry is re-read on every register.
  setPublisherScopes(pctx, 'east', ['scoped-*', 'other-*'])
  await registerWithPanel(pcall, east.secretKey, { publisher: 'east', streamId: 'other-1', feedKey: feedKey2Hex, encryptionKey: encKeyHex, isLive: true })
  assert.strictEqual((await db.get('catalog/other-1')).value.origin, 'east', 'widened scope applies with no restart')

  // Legacy fallback: the unnamed registers earlier in this file all verified against
  // keys/publisher.json — assert they stay unattributed.
  assert.strictEqual((await db.get('catalog/news')).value.origin ?? null, null, 'legacy register leaves origin null')

  // LEGACY_PUBLISHER=0: a fresh connection (responder attached with legacy off)
  // rejects unnamed payloads but keeps accepting enrolled ones.
  legacyOn = false
  const b2Swarm = new Hyperswarm(); cleanups.push(() => b2Swarm.destroy())
  let pcall2 = null
  b2Swarm.on('connection', (s) => { if (!pcall2) pcall2 = pubRpc(s).call })
  b2Swarm.join(topic, { client: true, server: false })
  await waitFor(async () => pcall2, 30000, 'legacy-off broadcaster→panel connection')
  let legacyOffCode = null
  try {
    await registerWithPanel(pcall2, b4a.toString(keys.publisher.secretKey, 'hex'), { streamId: 'news', feedKey: feedKey2Hex, isLive: true })
  } catch (e) { legacyOffCode = e.message }
  assert.match(legacyOffCode, /unknown-publisher/, 'legacy disabled: unnamed payload rejected even with the right shared key')
  await registerWithPanel(pcall2, east.secretKey, { publisher: 'east', streamId: 'scoped-1', feedKey: feedKey2Hex, isLive: true })
  assert.strictEqual((await db.get('catalog/scoped-1')).value.isLive, true, 'named registration unaffected by the legacy cutover')
  log('panel: LEGACY_PUBLISHER=0 rejects unnamed payloads; enrolled sites unaffected ✓')

  // ===== Grant + login recovers the registered key =====
  const rwd = evaluateFull(keys.oprf, PASSWORD)
  const salt = randomSalt(); const kp = userKeyPair(); const auth = authKeyPair(); const wk = wrapKeyFrom(rwd)
  const secrets = loadSecrets(dirs.panel)
  await db.put('user/alice', {
    salt: b4a.toString(salt, 'hex'), verifier: b4a.toString(deriveVerifier(rwd, salt, ARGON2_DEFAULT), 'hex'), argon: ARGON2_DEFAULT,
    pub: b4a.toString(kp.publicKey, 'hex'), encPriv: wrap(wk, kp.secretKey),
    authPub: b4a.toString(auth.publicKey, 'hex'), authPrivEnc: wrap(wk, auth.secretKey),
    wrapped: { news: sealTo(kp.publicKey, b4a.from(secrets.news, 'hex')) },
    devices: [], tokenVersion: 1, maxDevices: 2, status: 'active'
  })

  const cliStore = new Corestore(dirs.cli); await cliStore.ready(); cleanups.push(() => cliStore.close())
  const cliBee = new Hyperbee(cliStore.get({ key: keys.signing.publicKey }), { keyEncoding: 'utf-8', valueEncoding: 'json' }); await cliBee.ready()
  let ccall = null
  const cliSwarm = new Hyperswarm(); cleanups.push(() => cliSwarm.destroy())
  cliSwarm.on('connection', (s) => { cliStore.replicate(s); if (!ccall) ccall = clientRpc(s).call })
  cliSwarm.join(topic, { client: true, server: false })
  await waitFor(async () => ccall, 30000, 'client→panel connection')
  await waitFor(async () => await cliBee.get('user/alice'), 30000, 'DB replication')

  const { streams } = await login(ccall, cliBee, 'alice', PASSWORD, { deviceId: 'd1' })
  assert.strictEqual(streams[0]?.encryptionKey, encKeyHex, 'logged-in user recovers the registered encryption key')
  log('client: login recovered the broadcaster-registered key ✓')

  // ===== Start-time reclaim of stray cores written by OLDER builds =====
  // Purging probes as they run bounds NEW growth; it does not touch what a pre-purge build
  // already stranded. openStore() sweeps those at start — the one delete in the panel that
  // could be unrecoverable, so what matters is as much what SURVIVES as what goes.
  await assets.put('/gc/keepme.txt', b4a.from('assets must survive the sweep'))
  const newsBefore = (await db.get('catalog/news')).value
  const aliceBefore = (await db.get('user/alice')).value
  const ownCores = panelCores(dirs.panel).sort()
  assert.strictEqual(ownCores.length, 3, "the panel owns exactly 3 cores (bee + assets metadata/blobs)")

  // Strand cores the way a pre-purge probe did: open the feed's metadata + blobs cores on the
  // panel's own store and close() without purging. They are KEYED, so they land under
  // cores/<disc>/ exactly as the enricher's did, namespace or not.
  for (const hex of [feedKey2Hex, realBlobsKey2]) {
    const c = panelStore.get({ key: b4a.from(hex, 'hex') }); await c.ready(); await c.close()
  }
  // …plus a core dir left by a build we can no longer open at all (an unclean exit can
  // truncate one): the sweep must not depend on a stray being a readable core.
  const junk = b4a.toString(hcrypto.randomBytes(32), 'hex')
  const junkDir = path.join(dirs.panel, 'cores', junk.slice(0, 2), junk.slice(2, 4), junk)
  fs.mkdirSync(junkDir, { recursive: true }); fs.writeFileSync(path.join(junkDir, 'oplog'), b4a.alloc(4096))

  const strayed = panelCores(dirs.panel)
  for (const id of [disc(feedKey2Hex), disc(realBlobsKey2), junk]) {
    assert.ok(strayed.includes(id), 'planted stray ' + id.slice(0, 8) + ' is on disk before the restart')
  }
  assert.strictEqual(strayed.length, 6, 'three strays planted alongside the panel\'s own three cores')

  // The guard that makes this safe to ship: unless all three of the panel's own cores are
  // positively resolved, the sweep must delete NOTHING — leaking is recoverable, deleting
  // the bee is not.
  assert.strictEqual(reclaimStrayCores(dirs.panel, { store: panelStore, core: null, assets }), null,
    'an unresolved bee core refuses the sweep')
  assert.strictEqual(reclaimStrayCores(dirs.panel, { store: panelStore, core: panelCore, assets: {} }), null,
    'an unresolved assets drive refuses the sweep')
  assert.strictEqual(panelCores(dirs.panel).length, 6, 'a refused sweep deleted nothing')
  log('panel: an incomplete keep set refuses the sweep (leak, never delete) ✓')

  // Restart the panel: close the store and reopen it exactly as startPanel() does.
  await panelStore.close()
  const restarted = await openStore(dirs.panel, keys); cleanups.push(() => restarted.store.close())
  assert.strictEqual(restarted.reclaimed?.removed, 3, 'restart reclaimed all three stray core dirs')
  assert.ok(restarted.reclaimed.bytesFreed > 0, 'reclaim reported the bytes it freed')
  assert.deepStrictEqual(panelCores(dirs.panel).sort(), ownCores, "the panel's own cores survived the sweep")

  // The bee is the single-writer origin of truth with no peer to re-replicate from: had the
  // sweep eaten its core, openStore would hand back an EMPTY bee under the same key.
  assert.deepStrictEqual((await restarted.db.get('user/alice'))?.value, aliceBefore, 'accounts survived the restart')
  assert.deepStrictEqual((await restarted.db.get('catalog/news'))?.value, newsBefore, 'catalog survived the restart')
  assert.strictEqual((await restarted.db.get('catalog/scoped-1'))?.value?.origin, 'east', 'per-publisher catalog records survived')
  assert.strictEqual(b4a.toString(await restarted.assets.get('/gc/keepme.txt'), 'utf8'), 'assets must survive the sweep',
    'the assets drive (metadata + blobs cores) survived the sweep')
  log(`panel: restart reclaimed ${restarted.reclaimed.removed} stray core dir(s) (${(restarted.reclaimed.bytesFreed / 1e3).toFixed(0)} kB); accounts, catalog + assets intact ✓`)

  // And it must be a no-op from then on — a sweep that ever ate its own cores would do it
  // on the NEXT boot, not this one.
  await restarted.store.close()
  const again = await openStore(dirs.panel, keys); cleanups.push(() => again.store.close())
  assert.strictEqual(again.reclaimed?.removed, 0, 'a second restart has nothing left to reclaim')
  assert.deepStrictEqual(panelCores(dirs.panel).sort(), ownCores, 'a clean store is left untouched')
  assert.deepStrictEqual((await again.db.get('user/alice'))?.value, aliceBefore, 'accounts still intact after a second restart')
  log('panel: the sweep is idempotent — a clean store is left untouched ✓')

  log('\nRESULT: PASS ✅  (auto-register → private secret → blobsKey enrichment + rotation → grant → login recovers key; enrichment probes purge their cores, so panel disk is flat across rotations; older builds\' strays reclaimed at start with accounts/catalog/assets intact; unauthorized rejected; S26 per-publisher keys: scope/revoke/unknown rejects, live scope edits, legacy fallback + cutover; S29 register idempotence: unchanged re-register appends nothing)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
