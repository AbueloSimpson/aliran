// Unit test for the config-snapshot layer: the envelope, the redaction engine, the on-disk
// snapshot store, and the backup-archive index. No network, no ffmpeg, no services.
//
// THE LOAD-BEARING ASSERTION
//
// Every service's template spec is exercised against a registry seeded with REAL-SHAPED
// secrets, and the export is then scanned for those exact byte sequences. That scan — not
// the spec — is the feature. A spec is a list of paths someone remembered to write down; a
// new secret field that nobody added to a spec would ship silently. The scan fails CI
// instead, and it reports the path where the value survived.
//
// The service-level round trips (does a restore actually put a channel back) live in
// tools/e2e-admin-api-test.mjs and tools/e2e-broadcaster-api-test.mjs, which have real
// stores and a real HTTP server. Exits 0 on PASS.
import assert from 'assert'
import os from 'os'; import fs from 'fs'; import path from 'path'
import {
  applyTemplateSpec, makeEnvelope, parseEnvelope, findSecrets, redactUrlCredentials,
  makeSnapshotStore, isDownloadable, KIND_CONFIG, KIND_TEMPLATE
} from '@aliran/core/config-snapshot.js'
import { indexBackups, parseArchiveName, renderCommands } from '@aliran/core/backup-index.js'
import { TEMPLATE_SPEC as BC_SPEC } from '../broadcaster/src/config-snapshot.js'
import { TEMPLATE_SPEC as PANEL_SPEC } from '../panel/src/config-snapshot.js'
import { TEMPLATE_SPEC as LIB_SPEC } from '../library/src/config-snapshot.js'
import { TEMPLATE_SPEC as RES_SPEC } from '../reseller/src/config-snapshot.js'

const log = (...a) => console.log(...a)
let dir

try {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgsnap-'))

  // ===== Test A: URL credential stripping =====
  assert.strictEqual(redactUrlCredentials('http://user:pass@h:81/A_1/mpegts'), 'http://h:81/A_1/mpegts')
  assert.strictEqual(redactUrlCredentials('https://p.com/feed.json?token=abc'), 'https://p.com/feed.json')
  assert.strictEqual(redactUrlCredentials('https://p.com/feed.json#t=x'), 'https://p.com/feed.json')
  // A URL with nothing sensitive comes back byte-identical, so a template diff does not
  // churn on every clean URL just because it passed through the redactor.
  assert.strictEqual(redactUrlCredentials('https://p.com/feed.json'), 'https://p.com/feed.json')
  // Unparseable input is dropped rather than guessed at: a half-formed URL is exactly where
  // a token hides, and there is no safe way to edit a string we cannot parse.
  assert.strictEqual(redactUrlCredentials('/mnt/media/movie.mkv'), '')
  log('A  url credential stripping')

  // ===== Test B: the broadcaster template leaks nothing =====
  const B = {
    streamKey: 'sk9aBcDeF1234567',
    passphrase: 'srt-passphrase-9911',
    cencKey: '0123456789abcdef0123456789abcdef',
    pullPass: 'pullpassword77',
    verifier: 'ab'.repeat(32),
    salt: 'cd'.repeat(16)
  }
  const bcRaw = {
    channels: {
      push1: { id: 'push1', title: 'Push One', input: { kind: 'rtmp', port: 1935, streamKey: B.streamKey }, feedKey: 'ff'.repeat(32), feedGen: 3, desiredRunning: true, createdAt: 1, hls: { time: 2, listSize: 8 } },
      srt1: { id: 'srt1', title: 'SRT', input: { kind: 'srt', port: 9000, latencyMs: 120, passphrase: B.passphrase } },
      pull1: { id: 'pull1', title: 'Pull', input: { kind: 'pull', url: `http://op:${B.pullPass}@src:81/X_9/mpegts`, cencKey: B.cencKey }, transcode: { encoder: 'hevc_nvenc' } }
    },
    admins: { root: { salt: B.salt, verifier: B.verifier, tokenVersion: 4, status: 'active' } }
  }
  const bc = applyTemplateSpec(bcRaw, BC_SPEC)
  assertNoLeak('broadcaster', bc.sections, B)
  assert.ok(!bc.sections.admins, 'admins section must be dropped whole')
  assert.strictEqual(bc.sections.channels.pull1.input.url, 'http://src:81/X_9/mpegts', 'a pull url keeps origin + path')
  assert.ok(!('feedKey' in bc.sections.channels.push1), 'feedKey is this site\'s identity')
  assert.ok(!('desiredRunning' in bc.sections.channels.push1), 'run state is not structure')
  // Structure has to SURVIVE, or the template is useless.
  assert.strictEqual(bc.sections.channels.push1.input.port, 1935)
  assert.strictEqual(bc.sections.channels.push1.title, 'Push One')
  assert.strictEqual(bc.sections.channels.srt1.input.latencyMs, 120)
  assert.strictEqual(bc.sections.channels.pull1.transcode.encoder, 'hevc_nvenc')
  // The caller still holds live config — redaction must work on a copy.
  assert.strictEqual(bcRaw.channels.push1.input.streamKey, B.streamKey, 'applyTemplateSpec must not mutate its input')
  assert.ok(bc.omitted.length >= 5, 'the artifact records its own omissions')
  assert.ok(bc.omitted.every((o) => o.path && typeof o.reason === 'string' && o.reason.trim() !== ''), 'every omission names a path and carries a reason')
  log(`B  broadcaster template: no secret survived, ${bc.omitted.length} omissions recorded`)

  // ===== Test C: the panel template leaks nothing =====
  const P = {
    streamKey: 'aa'.repeat(32),
    adminVerifier: 'bb'.repeat(32),
    publisherSecret: 'cc'.repeat(64),
    sourceToken: 'srctok-8891xyz',
    sourcePass: 'feedpassword42'
  }
  const pRaw = {
    streams: { news: { title: 'News', category: ['National'], feedKey: 'dd'.repeat(32), blobsKey: 'ee'.repeat(32), isLive: true, status: 'live', order: 3, featured: true, restricted: false } },
    categories: { National: { label: 'National', parent: null, order: 1, hidden: false } },
    packages: { basic: { label: 'Basic', members: ['news'], default: true } },
    sources: {
      feedA: { url: `https://prov.example/feed.json?token=${P.sourceToken}`, category: 'Anime', prefix: 'a-', enabled: true, etag: 'W/"x"', lastSync: 123 },
      feedB: { url: `https://op:${P.sourcePass}@prov2.example/list.json`, category: 'Sports', prefix: 'b-', enabled: true }
    },
    vod: { enabled: true, apiBase: 'https://cas1.example', service: 'megaplay', sources: { movies: 'movies_hd' }, params: {} },
    streamSecrets: { news: P.streamKey },
    admins: { root: { salt: 'ff', verifier: P.adminVerifier, tokenVersion: 2 } },
    publishers: { east1: { secretKey: P.publisherSecret, status: 'revoked', scopes: ['east-*'] } }
  }
  const pt = applyTemplateSpec(pRaw, PANEL_SPEC)
  assertNoLeak('panel', pt.sections, P)
  assert.ok(!pt.sections.streamSecrets, 'per-stream keys must be dropped whole')
  assert.ok(!pt.sections.admins && !pt.sections.publishers)
  assert.strictEqual(pt.sections.sources.feedA.url, 'https://prov.example/feed.json', 'query token stripped')
  assert.strictEqual(pt.sections.sources.feedB.url, 'https://prov2.example/list.json', 'userinfo stripped')
  assert.strictEqual(pt.sections.packages.basic.members[0], 'news', 'package structure survives')
  assert.strictEqual(pt.sections.categories.National.label, 'National')
  assert.strictEqual(pt.sections.vod.apiBase, 'https://cas1.example', 'the VOD record holds no secret and survives intact')
  assert.ok(!('feedKey' in pt.sections.streams.news) && !('isLive' in pt.sections.streams.news))
  assert.strictEqual(pt.sections.streams.news.title, 'News')
  log(`C  panel template: no secret survived, ${pt.omitted.length} omissions recorded`)

  // ===== Test D: library + reseller templates leak nothing =====
  const L = { titleKey: '11'.repeat(32), inputPass: 'nas-password-31', verifier: '22'.repeat(32) }
  const lt = applyTemplateSpec({
    titles: { m1: { id: 'm1', title: 'Movie', category: ['Films'], input: `https://u:${L.inputPass}@nas/m.mkv`, mode: 'auto', hlsTime: 4, feedKey: '33'.repeat(32), state: 'ready', durationSec: 5400, createdAt: 9 } },
    titleSecrets: { m1: L.titleKey },
    admins: { root: { verifier: L.verifier } }
  }, LIB_SPEC)
  assertNoLeak('library', lt.sections, L)
  assert.ok(!lt.sections.titleSecrets && !lt.sections.admins)
  assert.ok(!('input' in lt.sections.titles.m1), 'a title input is box-specific and can carry credentials')
  assert.strictEqual(lt.sections.titles.m1.title, 'Movie')
  assert.strictEqual(lt.sections.titles.m1.hlsTime, 4, 'ingest settings are structure and survive')

  const R = { verifier: '44'.repeat(32), salt: '55'.repeat(16) }
  const rt = applyTemplateSpec({
    principals: { root: { role: 'admin', root: true, parent: null, status: 'active', salt: R.salt, verifier: R.verifier, tokenVersion: 3, maxDevicesLimit: 5 } },
    accounts: { cust1: { owner: 'root', status: 'active', credits: 12 } }
  }, RES_SPEC)
  assertNoLeak('reseller', rt.sections, R)
  assert.ok(!rt.sections.accounts, 'customer records are not structure')
  assert.strictEqual(rt.sections.principals.root.role, 'admin', 'the hierarchy shape survives')
  assert.strictEqual(rt.sections.principals.root.maxDevicesLimit, 5)
  assert.ok(!('verifier' in rt.sections.principals.root))
  log('D  library + reseller templates: no secret survived')

  // ===== Test E: envelope validation =====
  const tpl = makeEnvelope({ service: 'broadcaster', kind: KIND_TEMPLATE, sections: bc.sections, omitted: bc.omitted })
  const snap = makeEnvelope({ service: 'broadcaster', kind: KIND_CONFIG, sections: bcRaw })
  assert.ok(isDownloadable(tpl), 'a clean template is downloadable')
  assert.ok(!isDownloadable(snap), 'a config snapshot must NEVER be downloadable')
  assert.strictEqual(snap.contains, 'secrets')
  assert.strictEqual(tpl.contains, 'no-secrets')
  // A mislabelled artifact must not sneak past the download gate.
  assert.ok(!isDownloadable({ ...snap, kind: KIND_TEMPLATE }), 'kind alone is not enough — contains must agree')
  assert.throws(() => parseEnvelope(JSON.stringify(tpl), { service: 'panel' }), /cannot be applied to the panel/)
  assert.throws(() => parseEnvelope('{"aliranSnapshot":99}'), /unsupported format/)
  assert.throws(() => parseEnvelope('not json'), /not valid JSON/)
  assert.throws(() => parseEnvelope(JSON.stringify({ aliranSnapshot: 1, service: 'panel', kind: 'config' })), /no sections/)
  log('E  envelope validation + the download gate')

  // ===== Test F: the on-disk snapshot store =====
  const store = makeSnapshotStore(path.join(dir, 'config-snapshots'), { service: 'broadcaster', keep: 3 })
  assert.deepStrictEqual(store.list(), [], 'an absent directory lists empty, it does not throw')
  for (let i = 0; i < 5; i++) store.write(makeEnvelope({ service: 'broadcaster', kind: KIND_CONFIG, sections: bcRaw }), { note: 'n' + i })
  const listed = store.list()
  assert.strictEqual(listed.length, 3, 'retention cap holds, got ' + listed.length)
  assert.strictEqual(listed[0].note, 'n4', 'newest first')
  assert.ok(listed[0].id.startsWith('broadcaster-config-'), 'snapshot names cannot be confused with a .tar.gz archive')
  // Traversal: ids come out of a URL, and only the exact pattern is accepted.
  assert.throws(() => store.read('../../etc/passwd'), /no such snapshot/)
  assert.throws(() => store.read('panel-config-20260101-000000.json'), /no such snapshot/, 'another service\'s snapshot is not readable here')
  assert.throws(() => store.write(tpl), /only a config snapshot is stored/, 'a template is a download, not on-box state')
  const back = store.read(listed[0].id)
  assert.strictEqual(back.sections.channels.push1.input.streamKey, B.streamKey, 'a snapshot KEEPS its secrets — that is the point of it')
  store.remove(listed[0].id)
  assert.strictEqual(store.list().length, 2)
  // A corrupt file is reported, never silently hidden: an operator must not believe they
  // hold a rollback point that cannot be read.
  fs.writeFileSync(path.join(dir, 'config-snapshots', 'broadcaster-config-20200101-000000.json'), '{ truncated')
  const withBad = store.list().find((e) => e.id === 'broadcaster-config-20200101-000000.json')
  assert.ok(withBad && withBad.unreadable, 'a corrupt snapshot is listed and flagged')
  log('F  snapshot store: retention, traversal guard, secrets preserved, corruption reported')

  // ===== Test G: the backup archive index =====
  assert.strictEqual(parseArchiveName('panel-20260729-070000.tar.gz').service, 'panel')
  assert.strictEqual(parseArchiveName('panel-pre-65bcd17-20260728-0302.tar.gz').legacyName, true, 'the older production naming is still parsed')
  assert.strictEqual(parseArchiveName('random.tar.gz'), null)
  assert.strictEqual(parseArchiveName('broadcaster-config-20260729-070000.json'), null, 'a config snapshot is not an archive')
  const bdir = path.join(dir, 'backups'); fs.mkdirSync(bdir)
  for (const n of ['panel-20260729-070000.tar.gz', 'panel-20260501-070000.tar.gz', 'broadcaster-20260729-070000.tar.gz']) fs.writeFileSync(path.join(bdir, n), 'x')
  const idx = indexBackups(bdir, { service: 'panel', now: new Date(2026, 6, 29, 9, 0, 0).getTime() })
  assert.strictEqual(idx.archives.length, 2, 'filtered to one service')
  assert.strictEqual(idx.archives[0].newest, true)
  assert.strictEqual(idx.archives[0].freshness, 'fresh')
  assert.strictEqual(idx.archives[1].freshness, 'stale', 'a 3-month-old archive must read as stale')
  assert.strictEqual(idx.archives[1].newest, false, 'only one archive is the newest')
  assert.ok(idx.note.includes('.env'), 'the listing always says .env is not in these archives')
  const missing = indexBackups(path.join(dir, 'nope'), { service: 'panel' })
  assert.strictEqual(missing.available, false, 'an unmounted dir is a normal answer, not an error')
  assert.ok(missing.reason.includes('not visible'))
  const cmds = renderCommands({ service: 'panel', archive: 'backups/panel-20260729-070000.tar.gz' })
  assert.ok(!cmds.restore.includes('--force'), 'the default restore command must NEVER pre-arm --force')
  assert.ok(cmds.restoreForce.includes('--force'), 'the forcing variant exists, separately and labelled')
  assert.ok(cmds.backup.startsWith('./deploy/backup.sh'))
  // The commands run on the HOST. The path this module reads is the path the SERVICE sees
  // (/backups under compose, a bind mount of the host's ./backups), so it must never be
  // pasted into one — the scripts' own default is correct and `assumes` states it.
  assert.ok(!cmds.backup.includes('-o'), 'no service-side path leaks into a host command')
  assert.ok(!cmds.cron.includes('-o'))
  assert.ok(cmds.assumes.includes('./backups'), 'the assumption is stated, not guessed at')
  log('G  backup index: freshness bands, newest flag, absent dir, no pre-armed --force')

  log('\nPASS  config snapshots, templates, redaction, store, backup index')
} catch (err) {
  console.error('\nFAIL', err && err.message)
  console.error(err)
  process.exitCode = 1
} finally {
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
}

// Scan an exported artifact for literal secret values. Reports WHERE, because a bare
// "a secret leaked" is a much slower thing to debug than a path.
function assertNoLeak (service, sections, secrets) {
  const needles = Object.entries(secrets).map(([label, value]) => ({ label, value }))
  const hits = findSecrets(sections, needles)
  if (hits.length) {
    const where = hits.map((h) => `  ${h.label} survived at ${h.path}${h.inKey ? ' (in a KEY)' : ''}`).join('\n')
    throw new Error(`${service} template LEAKED ${hits.length} secret value(s):\n${where}`)
  }
}
