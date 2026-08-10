// End-to-end test for the config-snapshot / template / backup-listing HTTP API, on the
// PANEL and the BROADCASTER, over real HTTP against real stores.
//
// Deliberately NETWORK-FREE (bootstrap: [] — no DHT, no ffmpeg). The config API touches
// files the service already owns and never needs the swarm, so gating it behind the
// DHT-dependent steps in e2e-admin-api-test / e2e-broadcaster-api-test would make it
// unverifiable on any box without outbound UDP. Those two files cover the same ground in
// their own context; this one is the part that must always be runnable.
//
// THE LOAD-BEARING ASSERTION, again
//
// Real secrets are seeded through the real APIs — a minted per-stream key, a push stream
// key, an SRT passphrase, a CENC key, an Argon2id admin verifier, a publisher secret, and
// two credential-bearing source URLs — and then the downloadable template is scanned for
// those exact byte sequences. The redaction specs are a list somebody wrote down; this scan
// is what catches the field nobody added to one.
//
// All four services are covered: panel and broadcaster in full (snapshot, template,
// plan/restore, refusals), library and reseller for the surface they actually offer.
//
// Exits 0 on PASS.
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore, loadSecrets } from '../panel/src/store.js'
import * as ops from '../panel/src/ops.js'
import { startAdminServer } from '../panel/src/admin-server.js'
import { ChannelManager } from '../broadcaster/src/channel.js'
import { addAdmin as addBcAdmin } from '../broadcaster/src/control-auth.js'
import { startControlServer } from '../broadcaster/src/control-server.js'
import { TitleManager } from '../library/src/titles.js'
import { addAdmin as addLibAdmin } from '../library/src/control-auth.js'
import { startControlServer as startLibServer } from '../library/src/control-server.js'
import { addPrincipal } from '../reseller/src/control-auth.js'
import { makeMutex } from '../reseller/src/store.js'
import { startControlServer as startResServer } from '../reseller/src/control-server.js'

const log = (...a) => console.log(...a)
const ADMIN_PASSWORD = 'correct-horse-battery'
const argon2 = { memKiB: 8192, time: 1 }

const dirs = {
  panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ecfg-panel-')),
  bc: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ecfg-bc-')),
  backups: fs.mkdtempSync(path.join(os.tmpdir(), 'e2ecfg-backups-'))
}
const cleanups = []
async function cleanup () {
  for (const fn of cleanups.reverse()) { try { await fn() } catch {} }
  for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

// Assert a downloadable artifact contains none of the seeded secret values.
function assertNoLeak (what, artifact, secrets) {
  const text = JSON.stringify(artifact)
  const leaked = Object.entries(secrets).filter(([, v]) => v && text.includes(v)).map(([k]) => k)
  assert.deepStrictEqual(leaked, [], `${what} LEAKED: ${leaked.join(', ')}`)
}

try {
  // Two archives on the "box", one fresh and one three months old, so the freshness and
  // newest flags are exercised against real files rather than a stub.
  fs.writeFileSync(path.join(dirs.backups, 'panel-20260729-070000.tar.gz'), 'x')
  fs.writeFileSync(path.join(dirs.backups, 'panel-20260401-070000.tar.gz'), 'x')

  // ==================================================================== PANEL
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store, db, assets } = await openStore(dirs.panel, keys); cleanups.push(() => store.close())
  const panelConfig = { argon2, maxDevicesDefault: 2, backupDir: dirs.backups, snapshotKeep: 5 }
  const pctx = { config: panelConfig, keys, db, assets, dataDir: dirs.panel }
  ops.addAdmin(pctx, 'root', ADMIN_PASSWORD)
  const p = await startAdminServer(pctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 20, seconds: 60 } })
  cleanups.push(p.close)
  const pbase = `http://127.0.0.1:${p.port}`
  let token
  const papi = async (method, url, body) => {
    const headers = { authorization: 'Bearer ' + token }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(pbase + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  {
    const res = await fetch(pbase + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password: ADMIN_PASSWORD }) })
    token = (await res.json()).token
    assert.ok(token, 'panel admin login')
  }

  const PS = {
    sourceToken: 'srctok-e2e-8891xyz',
    sourcePass: 'feedpassword42e2e'
  }
  await papi('POST', '/api/sources', { name: 'e2efeed', url: `https://prov.example/feed.json?token=${PS.sourceToken}`, category: 'E2E' })
  await papi('POST', '/api/sources', { name: 'e2efeed2', url: `https://op:${PS.sourcePass}@prov2.example/list.json`, category: 'E2E2' })
  await papi('POST', '/api/categories', { slug: 'E2E', label: 'End to end', order: 1 })
  let r = await papi('POST', '/api/streams', { id: 'snapch', title: 'Snapshot Channel', category: 'E2E', order: 7 })
  assert.strictEqual(r.status, 201)
  PS.streamKey = r.body.encryptionKey
  assert.ok(/^[0-9a-f]{64}$/.test(PS.streamKey), 'stream minted a real 32-byte key')
  await papi('POST', '/api/packages', { name: 'basic', label: 'Basic', members: ['snapch'], default: true })
  r = await papi('POST', '/api/publishers', { name: 'e2epub', scopes: ['snap-*'] })
  PS.publisherSecret = r.body.secretKey
  assert.ok(PS.publisherSecret, 'publisher secret minted')
  PS.adminVerifier = JSON.parse(fs.readFileSync(path.join(dirs.panel, 'secrets', 'admins.json'), 'utf8')).root.verifier

  // ---- A: capability probe ----
  r = await papi('GET', '/api/config')
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.sections.admins.restorable, false, 'admins captured, never restored')
  assert.strictEqual(r.body.sections.publishers.restorable, false, 'publishers captured, never restored')
  assert.strictEqual(r.body.sections.streamSecrets.addOnly, true)
  assert.ok(r.body.notes.some((n) => n.includes('.env')), 'the API states .env is in no artifact')
  log('A  panel /api/config: section map says which sections a restore refuses, and why')

  // ---- B: the template leaks nothing ----
  r = await papi('GET', '/api/config/template')
  assert.strictEqual(r.status, 200)
  const ptpl = r.body
  assert.strictEqual(ptpl.contains, 'no-secrets')
  assertNoLeak('panel template', ptpl, PS)
  assert.ok(!ptpl.sections.streamSecrets && !ptpl.sections.admins && !ptpl.sections.publishers, 'secret sections dropped whole')
  assert.strictEqual(ptpl.sections.sources.e2efeed.url, 'https://prov.example/feed.json', 'query token stripped, origin+path kept')
  assert.strictEqual(ptpl.sections.sources.e2efeed2.url, 'https://prov2.example/list.json', 'user:pass stripped')
  assert.strictEqual(ptpl.sections.streams.snapch.title, 'Snapshot Channel', 'structure survives')
  assert.strictEqual(ptpl.sections.streams.snapch.order, 7)
  assert.strictEqual(ptpl.sections.packages.basic.members[0], 'snapch')
  assert.strictEqual(ptpl.sections.categories.E2E.label, 'End to end')
  assert.ok(ptpl.omitted.length, 'the artifact records what it left out')
  assert.ok(ptpl.omitted.every((o) => o.path && typeof o.reason === 'string' && o.reason.trim() !== ''), 'every omission names a path and carries a reason')
  log(`B  panel template: none of ${Object.keys(PS).length} seeded secrets survived; 2 credential URLs reduced to origin+path`)

  // ---- C: a snapshot keeps its secrets and is never served ----
  r = await papi('POST', '/api/config/snapshots', { note: 'e2e' })
  assert.strictEqual(r.status, 201)
  const snapId = r.body.id
  assert.ok(snapId.startsWith('panel-config-') && snapId.endsWith('.json'), 'snapshot naming cannot be mistaken for a .tar.gz archive')
  const onDisk = JSON.parse(fs.readFileSync(path.join(dirs.panel, 'config-snapshots', snapId), 'utf8'))
  assert.strictEqual(onDisk.contains, 'secrets')
  assert.strictEqual(onDisk.sections.streamSecrets.snapch, PS.streamKey, 'the on-box snapshot DOES keep the per-stream key')
  assert.strictEqual(onDisk.sections.admins.root.verifier, PS.adminVerifier, 'and the admin verifier')
  r = await papi('GET', `/api/config/snapshots/${snapId}`)
  assert.strictEqual(r.status, 200)
  assertNoLeak('GET /snapshots/:id', r.body, PS)
  assert.ok(r.body.contentsWithheld, 'and it says why the contents are withheld')
  assert.strictEqual(r.body.sections.streams.entries, 1, 'it reports section sizes instead')
  log('C  panel snapshot: keeps every secret on disk, serves NONE of them over HTTP')

  // ---- D: restore brings a purged channel back with its ORIGINAL key ----
  r = await papi('DELETE', '/api/streams/snapch')
  assert.strictEqual(r.status, 200)
  assert.ok(r.body.rollbackSnapshot && r.body.rollbackSnapshot.id, 'a channel delete takes an automatic rollback snapshot')
  assert.ok(!loadSecrets(dirs.panel).snapch, 'the purge really removed the key')

  r = await papi('POST', `/api/config/snapshots/${snapId}/plan`, {})
  assert.ok(r.body.streams.add.some((a) => a.id === 'snapch'), 'the plan sees the missing channel')
  assert.ok(r.body.secrets.install.includes('snapch'), 'and that its key would be reinstalled')

  assert.strictEqual((await papi('POST', `/api/config/snapshots/${snapId}/restore`, {})).status, 400, 'restore without confirm:true is refused')
  r = await papi('POST', `/api/config/snapshots/${snapId}/restore`, { confirm: true })
  assert.strictEqual(r.status, 200)
  assert.ok(r.body.result.streams.added.includes('snapch'), 'the channel is back')
  assert.strictEqual(loadSecrets(dirs.panel).snapch, PS.streamKey, 'WITH its original key, so existing grants still unseal')
  assert.ok(r.body.rollbackSnapshot && r.body.rollbackSnapshot.id, 'the restore itself took a rollback point')
  r = await papi('GET', '/api/streams')
  const restored = r.body.find((s) => s.id === 'snapch')
  assert.strictEqual(restored.title, 'Snapshot Channel', 'metadata came back too')
  assert.strictEqual(restored.order, 7)
  log('D  panel restore: a purged channel came back with its ORIGINAL key and metadata')

  // ---- D2: plan and apply must agree ----
  //
  // A restore that changes nothing must REPORT nothing. apply() once rewrote every package
  // and source unconditionally while plan() diffed them, so the result claimed changes the
  // plan had correctly called none — and each needless setPackage dragged a full holder
  // reconcile behind it. Restoring twice in a row is the cheap way to catch that.
  r = await papi('POST', `/api/config/snapshots/${snapId}/plan`, {})
  assert.strictEqual(r.body.streams.add.length, 0, 'the second plan has nothing to add')
  assert.strictEqual(r.body.streams.update.length, 0)
  assert.strictEqual(r.body.categories.add.length + r.body.categories.update.length, 0, 'categories already match')
  assert.strictEqual(r.body.packages.add.length + r.body.packages.update.length, 0, 'packages already match')
  assert.strictEqual(r.body.sources.add.length + r.body.sources.update.length, 0, 'sources already match')
  r = await papi('POST', `/api/config/snapshots/${snapId}/restore`, { confirm: true })
  const res = r.body.result
  assert.deepStrictEqual(
    [res.streams.added.length, res.streams.updated.length, res.categories.length, res.packages.length, res.sources.length],
    [0, 0, 0, 0, 0],
    'a no-op restore must report NO changes: ' + r.body.summary
  )
  assert.ok(/No change/i.test(r.body.summary), 'and say so plainly, got: ' + r.body.summary)
  log('D2 a restore that changes nothing reports nothing — plan and apply agree')

  // ---- E: a live, DIFFERENT key is never clobbered ----
  await papi('DELETE', '/api/streams/snapch')
  r = await papi('POST', '/api/streams', { id: 'snapch', title: 'Recreated' })
  const freshKey = r.body.encryptionKey
  assert.notStrictEqual(freshKey, PS.streamKey, 're-adding an id mints a fresh key')
  r = await papi('POST', `/api/config/snapshots/${snapId}/restore`, { confirm: true })
  assert.strictEqual(loadSecrets(dirs.panel).snapch, freshKey, 'the LIVE key survives — a restore never overwrites one')
  assert.ok(r.body.result.secretsDeclined.includes('snapch'), 'and the refusal is REPORTED, not silent')
  log('E  panel restore: refuses to overwrite a live per-stream key, and says so')

  // ---- E2: playback headers and the M3U source fields round-trip ----
  //
  // Both are fields the snapshot learned about late, and both fail SILENTLY when an
  // artifact drops them: a restored redirect channel would play without the Referer its
  // provider demands (403 for every viewer), and a restored m3u source would come back
  // as `json` and fail its next sync on a body it can no longer parse. The comparators
  // (STREAM_FIELDS / srcShape) are what decide whether a restore even notices, so drift
  // each one and check the plan SEES it before checking the restore fixes it.
  r = await papi('POST', '/api/streams', { id: 'hdrch', title: 'Header Channel', url: 'https://cdn.example/promo.m3u8', headers: { Referer: 'https://provider.example/', 'User-Agent': 'Mozilla/5.0 (Aliran)' } })
  assert.strictEqual(r.status, 201, 'redirect channel with headers: ' + JSON.stringify(r.body))
  const HDRS = { referer: 'https://provider.example/', 'user-agent': 'Mozilla/5.0 (Aliran)' }
  r = await papi('POST', '/api/sources', { name: 'e2em3u', url: 'https://prov.example/events.m3u', format: 'm3u', groups: ['Live Events'], category: 'Events' })
  assert.strictEqual(r.status, 201, 'm3u source: ' + JSON.stringify(r.body))

  r = await papi('POST', '/api/config/snapshots', { note: 'headers + m3u' })
  const snapHdr = r.body.id

  await papi('PATCH', '/api/streams/hdrch', { headers: { referer: 'https://wrong.example/' } })
  await papi('PATCH', '/api/sources/e2em3u', { format: 'json', groups: [] })
  r = await papi('POST', `/api/config/snapshots/${snapHdr}/plan`, {})
  assert.deepStrictEqual(r.body.streams.update.find((u) => u.id === 'hdrch')?.fields, ['headers'], 'the plan sees the drifted headers, and ONLY them')
  assert.deepStrictEqual(r.body.sources.update, ['e2em3u'], 'the plan sees the drifted format/groups — and no phantom on the json sources')

  r = await papi('POST', `/api/config/snapshots/${snapHdr}/restore`, { confirm: true })
  assert.strictEqual(r.status, 200)
  r = await papi('GET', '/api/streams')
  assert.deepStrictEqual(r.body.find((s) => s.id === 'hdrch').headers, HDRS, 'headers round-tripped verbatim, lowercase keys intact')
  r = await papi('GET', '/api/sources')
  const m3uSrc = r.body.find((s) => s.name === 'e2em3u')
  assert.strictEqual(m3uSrc.format, 'm3u', 'the source format round-tripped')
  assert.deepStrictEqual(m3uSrc.groups, ['Live Events'], 'and its group filter')

  // A PRE-M3U ARTIFACT mentions neither key, and "not mentioned" has to mean "leave it
  // alone". A comparator that read an absent `format` as `json` would report — and then
  // really apply — a downgrade of the m3u source the artifact never knew about, leaving a
  // playlist source its next sync cannot parse. Sources therefore diff PER FIELD, like
  // streams. Model the artifact by stripping the two keys off a real snapshot on disk (the
  // id has to match the store's naming pattern, which is also its traversal guard).
  const legacyId = 'panel-config-20250101-000000.json'
  const legacyPath = path.join(dirs.panel, 'config-snapshots', legacyId)
  const legacyEnv = JSON.parse(fs.readFileSync(path.join(dirs.panel, 'config-snapshots', snapHdr), 'utf8'))
  for (const s of Object.values(legacyEnv.sections.sources)) { delete s.format; delete s.groups }
  fs.writeFileSync(legacyPath, JSON.stringify(legacyEnv))
  r = await papi('POST', `/api/config/snapshots/${legacyId}/plan`, {})
  assert.strictEqual(r.status, 200)
  assert.deepStrictEqual(r.body.sources.update, [], 'a pre-M3U artifact touches NO source — not the json ones, and not the m3u one: ' + JSON.stringify(r.body.sources))
  assert.strictEqual(r.body.streams.update.length, 0, 'and it changes nothing about the streams')

  // …and skipping absent fields must not blind the comparison: a field the artifact DOES
  // carry, and that really differs, is still an update.
  legacyEnv.sections.sources.e2em3u.url = 'https://prov.example/other-events.m3u'
  fs.writeFileSync(legacyPath, JSON.stringify(legacyEnv))
  r = await papi('POST', `/api/config/snapshots/${legacyId}/plan`, {})
  assert.deepStrictEqual(r.body.sources.update, ['e2em3u'], 'a genuinely different url is still caught: ' + JSON.stringify(r.body.sources))
  log('E2 panel restore: redirect headers and m3u format/groups round-trip; a pre-M3U artifact raises no phantom diff, a real difference still does')

  // ---- F: cross-service and malformed artifacts are refused ----
  assert.strictEqual((await papi('POST', '/api/config/template/plan', { template: { ...ptpl, service: 'broadcaster' } })).status, 409, 'a broadcaster artifact cannot be applied to the panel')
  assert.strictEqual((await papi('POST', '/api/config/template/plan', { template: { aliranSnapshot: 99 } })).status, 400, 'an unknown format version is refused')
  assert.strictEqual((await papi('POST', '/api/config/template/import', { template: ptpl })).status, 400, 'import without confirm:true is refused')
  assert.strictEqual((await papi('GET', '/api/config/snapshots/../../etc/passwd')).status, 404, 'traversal in a snapshot id')
  log('F  panel: cross-service, bad-version, unconfirmed and traversal all refused')

  // ---- G: the backup listing ----
  r = await papi('GET', '/api/backups')
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.available, true, 'the mounted dir is visible')
  assert.strictEqual(r.body.archives.length, 2, 'both panel archives listed')
  assert.strictEqual(r.body.archives[0].newest, true)
  assert.strictEqual(r.body.archives[1].newest, false)
  assert.strictEqual(r.body.archives[1].freshness, 'stale', 'a months-old archive reads as stale')
  assert.strictEqual(r.body.canRunHere, false, 'the dashboard cannot make a cold archive')
  assert.ok(r.body.why.includes('stop'), 'and explains that it would have to stop the service')
  assert.ok(r.body.commands.backup.includes('deploy/backup.sh'))
  assert.ok(!r.body.commands.restore.includes('--force'), 'the default restore command must NEVER pre-arm --force')
  assert.ok(r.body.commands.restoreForce.includes('--force'), 'the forcing variant is separate and labelled')
  assert.ok(r.body.note.includes('.env'), 'and the listing says .env is in no archive')
  log('G  panel /api/backups: 2 archives, newest+staleness flagged, read-only, no pre-armed --force')

  // ================================================================ BROADCASTER
  const bcConfig = {
    dataDir: dirs.bc,
    panelPubKey: b4a.toString(keys.signing.publicKey, 'hex'),
    publisherKey: b4a.toString(keys.publisher.secretKey, 'hex'),
    bootstrap: [], // no DHT: this test must run without outbound UDP
    hls: { time: 2, listSize: 6 },
    feedBuffer: 'ram',
    feedRotate: { hours: 0, treeMb: 0, graceMs: 2000 },
    ingest: { portBase: 5400, portMax: 5499 },
    argon2,
    backupDir: dirs.backups,
    snapshotKeep: 5
  }
  const manager = new ChannelManager(bcConfig); await manager.init({ resume: false }); cleanups.push(() => manager.close())
  const bctx = { config: bcConfig, manager, dataDir: dirs.bc }
  addBcAdmin(bctx, 'op', ADMIN_PASSWORD)
  const bsrv = await startControlServer(bctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 20, seconds: 60 } })
  cleanups.push(bsrv.close)
  const bbase = `http://127.0.0.1:${bsrv.port}`
  let btoken
  const bapi = async (method, url, body) => {
    const headers = { authorization: 'Bearer ' + btoken }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(bbase + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  {
    const res = await fetch(bbase + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'op', password: ADMIN_PASSWORD }) })
    btoken = (await res.json()).token
    assert.ok(btoken, 'broadcaster admin login')
  }

  const BS = {
    passphrase: 'srt-passphrase-9911',
    cencKey: '0123456789abcdef0123456789abcdef',
    pullPass: 'pullpassword77e2e'
  }
  r = await bapi('POST', '/api/channels', { id: 'push1', title: 'Push One', input: { kind: 'rtmp', port: 5401 } })
  assert.strictEqual(r.status, 201)
  BS.streamKey = r.body.input.streamKey
  assert.ok(BS.streamKey && BS.streamKey.length >= 8, 'rtmp channel minted a stream key')
  r = await bapi('POST', '/api/channels', { id: 'srt1', title: 'SRT One', input: { kind: 'srt', port: 5402, passphrase: BS.passphrase } })
  assert.strictEqual(r.status, 201)
  r = await bapi('POST', '/api/channels', { id: 'pull1', title: 'Pull One', input: { kind: 'pull', url: `http://op:${BS.pullPass}@src.example:81/X_9/mpegts`, cencKey: BS.cencKey } })
  assert.strictEqual(r.status, 201)
  BS.adminVerifier = JSON.parse(fs.readFileSync(path.join(dirs.bc, 'secrets', 'admins.json'), 'utf8')).op.verifier

  // ---- H: the broadcaster template leaks nothing ----
  r = await bapi('GET', '/api/config/template')
  assert.strictEqual(r.status, 200)
  const btpl = r.body
  assertNoLeak('broadcaster template', btpl, BS)
  assert.ok(!btpl.sections.admins, 'admins dropped whole')
  assert.strictEqual(btpl.sections.channels.pull1.input.url, 'http://src.example:81/X_9/mpegts', 'pull url keeps origin+path')
  assert.strictEqual(btpl.sections.channels.push1.input.port, 5401, 'ports are structure and survive')
  assert.strictEqual(btpl.sections.channels.srt1.title, 'SRT One')
  assert.ok(!('feedKey' in btpl.sections.channels.push1), 'feedKey is site identity')
  assert.ok(!('desiredRunning' in btpl.sections.channels.push1), 'run state is not structure')
  log(`H  broadcaster template: none of ${Object.keys(BS).length} seeded secrets survived (stream key, SRT passphrase, CENC key, pull password, admin verifier)`)

  // ---- I: snapshot + restore a deleted channel WITH its stream key ----
  r = await bapi('POST', '/api/config/snapshots', { note: 'before delete' })
  const bsnap = r.body.id
  const bOnDisk = JSON.parse(fs.readFileSync(path.join(dirs.bc, 'config-snapshots', bsnap), 'utf8'))
  assert.strictEqual(bOnDisk.sections.channels.push1.input.streamKey, BS.streamKey, 'the snapshot keeps the push stream key')
  assert.strictEqual(bOnDisk.sections.channels.srt1.input.passphrase, BS.passphrase, 'and the SRT passphrase')

  r = await bapi('DELETE', '/api/channels/push1')
  assert.strictEqual(r.status, 200)
  assert.ok(r.body.rollbackSnapshot && r.body.rollbackSnapshot.id, 'a channel delete takes an automatic rollback snapshot')
  assert.strictEqual((await bapi('GET', '/api/channels/push1')).status, 404, 'it is really gone')

  r = await bapi('POST', `/api/config/snapshots/${bsnap}/plan`, {})
  assert.ok(r.body.add.some((a) => a.id === 'push1'), 'the plan sees the missing channel')
  assert.strictEqual(r.body.extra.length, 0, 'nothing on the box is outside the snapshot yet')
  assert.strictEqual(r.body.update.length, 0, 'the two surviving channels are unchanged, so nothing is rewritten')

  r = await bapi('POST', `/api/config/snapshots/${bsnap}/restore`, { confirm: true })
  assert.strictEqual(r.status, 200)
  assert.ok(r.body.result.added.includes('push1'))
  r = await bapi('GET', '/api/channels/push1')
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.input.streamKey, BS.streamKey, 'the SAME stream key came back — encoders in the field keep working')
  log('I  broadcaster restore: a deleted push channel came back with its ORIGINAL stream key')

  // ---- J: the additive default, and opt-in removal ----
  await bapi('POST', '/api/channels', { id: 'newer', title: 'Added after the snapshot', input: { kind: 'test' } })
  r = await bapi('POST', `/api/config/snapshots/${bsnap}/plan`, {})
  assert.ok(r.body.extra.some((e) => e.id === 'newer' && e.willRemove === false), 'a newer channel is reported as extra, NOT removed')
  await bapi('POST', `/api/config/snapshots/${bsnap}/restore`, { confirm: true })
  assert.strictEqual((await bapi('GET', '/api/channels/newer')).status, 200, 'a restore left the newer channel alone')
  r = await bapi('POST', `/api/config/snapshots/${bsnap}/restore`, { confirm: true, removeExtra: true })
  assert.ok(r.body.result.removed.includes('newer'), 'removal happens only when asked for')
  assert.strictEqual((await bapi('GET', '/api/channels/newer')).status, 404)
  log('J  broadcaster restore is additive by default; removal is opt-in')

  // ---- K: template import mints a NEW stream key, and says so ----
  await bapi('DELETE', '/api/channels/push1')
  r = await bapi('POST', '/api/config/template/plan', { template: btpl })
  assert.ok(r.body.warnings.some((w) => w.includes('NEW stream key')), 'the plan warns that a template import re-keys push channels')
  assert.ok(r.body.warnings.some((w) => w.includes('arrive stopped')))
  r = await bapi('POST', '/api/config/template/import', { template: btpl, confirm: true })
  assert.strictEqual(r.status, 200)
  r = await bapi('GET', '/api/channels/push1')
  assert.strictEqual(r.status, 200, 'the channel was recreated from the template')
  assert.notStrictEqual(r.body.input.streamKey, BS.streamKey, 'with a DIFFERENT key — a template carries none')
  assert.strictEqual(r.body.running, false, 'and it arrives stopped')
  log('K  broadcaster template import: recreates structure, mints a new key, warns about both')

  // ---- L: retention cap ----
  for (let i = 0; i < 8; i++) await bapi('POST', '/api/config/snapshots', { note: 'fill ' + i })
  r = await bapi('GET', '/api/config/snapshots')
  assert.strictEqual(r.body.snapshots.length, 5, 'retention cap (snapshotKeep: 5) holds, got ' + r.body.snapshots.length)
  assert.ok(r.body.snapshots[0].note.includes('fill 7'), 'newest first')
  log('L  snapshot retention cap holds under repeated writes')

  // ================================================================ LIBRARY
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2ecfg-lib-'))
    dirs.lib = dir
    const config = { dataDir: dir, bootstrap: [], hls: { time: 4 }, ingestConcurrency: 1, swarmMaxPeers: 32, argon2, backupDir: dirs.backups, snapshotKeep: 5 }
    const manager = new TitleManager(config)
    await manager.init(); cleanups.push(() => manager.close && manager.close())
    const lctx = { config, manager, dataDir: dir }
    addLibAdmin(lctx, 'op', ADMIN_PASSWORD)
    const srv = await startLibServer(lctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 20, seconds: 60 } })
    cleanups.push(srv.close)
    const base = `http://127.0.0.1:${srv.port}`
    const tk = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'op', password: ADMIN_PASSWORD }) })).json()).token
    const lapi = async (m, u, b) => {
      const h = { authorization: 'Bearer ' + tk }
      if (b !== undefined) h['content-type'] = 'application/json'
      const res = await fetch(base + u, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) })
      return { status: res.status, body: await res.json().catch(() => ({})) }
    }
    let x = await lapi('GET', '/api/config')
    assert.strictEqual(x.status, 200)
    assert.strictEqual(x.body.sections.admins.restorable, false, 'library admins captured, never restored')
    x = await lapi('POST', '/api/config/snapshots', { note: 'e2e' })
    assert.strictEqual(x.status, 201, JSON.stringify(x.body))
    assert.ok(x.body.id.startsWith('library-config-'))
    x = await lapi('GET', '/api/config/template')
    assert.strictEqual(x.body.contains, 'no-secrets')
    assert.ok(!x.body.sections.titleSecrets && !x.body.sections.admins, 'library template drops the secret sections')
    x = await lapi('GET', '/api/backups')
    assert.strictEqual(x.body.archives.length, 0, 'no library archive was seeded, and none is invented')
    assert.strictEqual(x.body.canRunHere, false)
    log('M  library: config map, snapshot, secret-free template, read-only archive listing')
  }

  // ================================================================ RESELLER
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2ecfg-res-'))
    dirs.res = dir
    const config = {
      dataDir: dir, argon2, backupDir: dirs.backups, snapshotKeep: 5,
      daysPerMonth: 30, trialHours: 24, trialDailyCapDefault: 5, maxDevicesLimitDefault: 2,
      controlSessionTtlHours: 12, lockout: { threshold: 20, seconds: 60 }, brand: {}
    }
    const rctx = { config, dataDir: dir, mutex: makeMutex() }
    addPrincipal(rctx, { username: 'root', password: ADMIN_PASSWORD, role: 'admin', root: true })
    addPrincipal(rctx, { username: 'shop', password: ADMIN_PASSWORD, role: 'reseller', parent: 'root' })
    const srv = await startResServer(rctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 20, seconds: 60 } })
    cleanups.push(srv.close)
    const base = `http://127.0.0.1:${srv.port}`
    const tok = async (u) => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: ADMIN_PASSWORD }) })).json()).token
    const adminTok = await tok('root')
    const shopTok = await tok('shop')
    const rapi = async (m, u, b, t) => {
      const h = { authorization: 'Bearer ' + t }
      if (b !== undefined) h['content-type'] = 'application/json'
      const res = await fetch(base + u, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) })
      return { status: res.status, body: await res.json().catch(() => ({})) }
    }
    // These artifacts show the WHOLE hierarchy, including branches a reseller can never
    // otherwise see, so the capability gate is part of the feature.
    assert.strictEqual((await rapi('GET', '/api/config', undefined, shopTok)).status, 403, 'a reseller-tier principal must be refused')

    let x = await rapi('GET', '/api/config', undefined, adminTok)
    assert.strictEqual(x.status, 200)
    assert.strictEqual(x.body.restoreSupported, false, 'the reseller is export-only')
    assert.ok(x.body.restoreNote.includes('volume'), 'and says a rebuild is a volume restore')
    x = await rapi('POST', '/api/config/snapshots', { note: 'e2e' }, adminTok)
    assert.strictEqual(x.status, 201, JSON.stringify(x.body))
    const rSnap = x.body.id
    const verifier = JSON.parse(fs.readFileSync(path.join(dir, 'config-snapshots', rSnap), 'utf8')).sections.principals.root.verifier
    assert.ok(verifier, 'the snapshot captures the credential material')
    x = await rapi('GET', '/api/config/template', undefined, adminTok)
    assert.strictEqual(x.body.contains, 'no-secrets')
    assert.ok(!JSON.stringify(x.body).includes(verifier), 'the reseller template leaked a password verifier')
    assert.strictEqual(x.body.sections.principals.root.role, 'admin', 'the hierarchy shape survives')
    assert.ok(!('verifier' in x.body.sections.principals.root))
    assert.ok(!x.body.sections.accounts, 'customer records are not structure')
    assert.strictEqual(x.body.meta.importable, false)
    x = await rapi('POST', `/api/config/snapshots/${rSnap}/restore`, { confirm: true }, adminTok)
    assert.strictEqual(x.status, 400, 'a reseller restore must be refused')
    assert.ok(x.body.error.includes('volume'), 'with the honest reason, got: ' + x.body.error)
    log('N  reseller: admin tier only, export-only with a stated reason, template carries the hierarchy and no verifier')
  }

  log('\nRESULT: PASS ✅  config snapshots keep every secret ON THE BOX and never serve one; templates carry structure and provably no secret; restore returns a purged channel with its ORIGINAL key, is additive by default, and never clobbers a live key; the backup listing is read-only and honest about why; all four services covered')
  await cleanup(); process.exit(0)
} catch (err) {
  log('\nERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
