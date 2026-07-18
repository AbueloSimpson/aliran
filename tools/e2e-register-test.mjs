// End-to-end v0.2 test: broadcaster auto-registers a feed with the panel, then a granted
// user logs in and recovers the registered key. S20a adds the blobsKey enrichment round
// trip: the panel opens the announced feed drive with its stored encryptionKey and
// publishes the blobs-core key in the catalog (async), clears + re-enriches it across a
// feedKey rotation, and preserves it across a same-key re-register. No ffmpeg needed.
// Exits 0 on PASS.
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
import { openStore, loadSecrets } from '../panel/src/store.js'
import { makeThrottle, attachLoginRpc } from '../panel/src/rpc.js'
import { makeBlobsKeyEnricher } from '../panel/src/blobs-key.js'
import { addPublisher, setPublisherStatus, setPublisherScopes, loadPublishers } from '../panel/src/ops.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(300) } throw new Error('timeout: ' + label) }
const log = (...a) => console.log(...a)

const DIFFICULTY = 8; const PASSWORD = 'test123'
const dirs = { panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-panel-')), feed: fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-feed-')), cli: fs.mkdtempSync(path.join(os.tmpdir(), 'e2er-cli-')) }
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

try {
  // ===== Panel =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
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

  // A same-feedKey re-register (the broadcaster heartbeat) must PRESERVE the blobsKey…
  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'news', feedKey: feedKeyHex, encryptionKey: encKeyHex, isLive: true
  })
  assert.strictEqual((await db.get('catalog/news')).value.blobsKey, realBlobsKey, 'same-feedKey re-register preserves blobsKey')

  // …and a feedKey ROTATION (broadcaster source change / RAM restart) must clear it
  // immediately and re-enrich against the NEW drive.
  const feed2 = new Hyperdrive(feedStore.namespace('feed2'), { encryptionKey: encKey }); await feed2.ready()
  await feed2.put('/index.m3u8', b4a.from('#EXTM3U')) // header exists once content does
  const feedKey2Hex = b4a.toString(feed2.key, 'hex')
  feedSwarm.join(feed2.discoveryKey, { server: true, client: false }); await feedSwarm.flush()
  await registerWithPanel(pcall, b4a.toString(keys.publisher.secretKey, 'hex'), {
    streamId: 'news', feedKey: feedKey2Hex, encryptionKey: encKeyHex, isLive: true
  })
  const rotated = (await db.get('catalog/news')).value
  assert.strictEqual(rotated.feedKey, feedKey2Hex, 'rotation: catalog follows the new feedKey')
  assert.strictEqual(rotated.blobsKey ?? null, null, 'rotation: stale blobsKey cleared with the register itself')
  const realBlobsKey2 = b4a.toString((await feed2.getBlobs()).core.key, 'hex')
  const enriched2 = await waitFor(async () => (await db.get('catalog/news'))?.value?.blobsKey, 90000, 'blobsKey re-enrichment after rotation')
  assert.strictEqual(enriched2, realBlobsKey2, "re-enriched blobsKey equals the NEW drive's blobs-core key")
  assert.notStrictEqual(enriched2, realBlobsKey, 'rotation produced a different blobs core')
  log('panel: feedKey rotation cleared + re-enriched blobsKey ✓')

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

  log('\nRESULT: PASS ✅  (auto-register → private secret → blobsKey enrichment + rotation → grant → login recovers key; unauthorized rejected; S26 per-publisher keys: scope/revoke/unknown rejects, live scope edits, legacy fallback + cutover)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
