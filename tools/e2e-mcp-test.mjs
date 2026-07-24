// End-to-end test for the Aliran MCP server (S46). Deterministic, no DHT, no ffmpeg —
// belongs in the required core lane.
//
// Boots a REAL panel store + admin server in-process AND a broadcaster control server
// (with a lightweight fake ChannelManager, so no ffmpeg/DHT), writes an MCP config
// pointing at both over loopback, then launches mcp/src/index.js over a stdio pipe and
// drives it AS AN MCP CLIENT:
//   A  list_tools / list_resources shape (+ the tool groups are present)
//   B  a read tool (panel_status / panel_list_users)
//   C  a write chain: add streams -> create user -> package -> assign -> assert in the
//      signed DB (via the panel API)
//   D  destructive-annotation presence on purge/delete/revoke tools; readOnlyHint on GETs
//   E  a docs resource read + a docs_search hit + the mcp://aliran/guide resource
//   F  the re-login-on-401 path (bump the panel admin tokenVersion mid-test)
//   G  the SSH executor against a COMMAND-STUB SEAM (a fake ssh binary) — preflight,
//      status, and install (asserting the publisher SECRET never comes back to the model)
//   H  the broadcaster tools (health + channel add/list + incidents)
//   I  the onboarding doctor (--doctor)
//   J  TYPED channel input/transcode: the published schema is no longer empty, an
//      object-valued input round-trips to kind:"pull", a stringified object is rescued,
//      and a malformed one is a loud error — never a silent {kind:"file"} fallback
// Exits 0 on PASS.

import assert from 'assert'
import os from 'os'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeRing } from '../panel/src/activity.js'
import * as ops from '../panel/src/ops.js'
import { startAdminServer } from '../panel/src/admin-server.js'
import { addAdmin as bcAddAdmin } from '../broadcaster/src/control-auth.js'
import { startControlServer } from '../broadcaster/src/control-server.js'
import { normalizeInput, normalizeTranscode } from '../broadcaster/src/channel.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const log = (...a) => console.log(...a)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const MCP_ENTRY = path.join(REPO, 'mcp', 'src', 'index.js')

const PANEL_ADMIN = { user: 'panelop', pass: 'panel-op-password-1' }
const BC_ADMIN = { user: 'bcop', pass: 'bc-op-password-1' }
const FAKE_PUB = 'a'.repeat(64) // the panel PUBLIC key our fake `admin-cli init` prints
const FAKE_PUBLISHER_SECRET = 'b'.repeat(128) // the PUBLISHER secret — must never reach the model

const config = { argon2: { memKiB: 8192, time: 1 }, maxDevicesDefault: 2 }
const dirs = {
  panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2emcp-panel-')),
  bc: fs.mkdtempSync(path.join(os.tmpdir(), 'e2emcp-bc-')),
  mcp: fs.mkdtempSync(path.join(os.tmpdir(), 'e2emcp-cfg-'))
}
const cleanups = []
async function cleanup () { for (const fn of cleanups.reverse()) { try { await fn() } catch {} } for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

// A fake ChannelManager: enough of the ChannelManager surface for the control server
// to answer the tools this test drives, with NO ffmpeg and NO panel/DHT connection.
// add/update run the REAL normalizeInput/normalizeTranscode (the production
// ChannelManager does the same via normalizeMeta), so section J drives the MCP tool
// schemas against the exact validation a live broadcaster applies — that is what keeps
// the mirrored schemas in mcp/src/tools/broadcaster.js from drifting.
const NORM_CFG = { rtmpPort: 1935, ingest: { portBase: 5000, portMax: 5009 } }
function makeFakeManager () {
  const channels = new Map()
  const normalize = (fields, existing) => {
    const out = {}
    if (fields.input != null) out.input = normalizeInput(fields.input, { config: NORM_CFG, existing: existing ? existing.input : null })
    if (fields.transcode !== undefined) out.transcode = normalizeTranscode(fields.transcode)
    if (fields.title != null) out.title = String(fields.title)
    return out
  }
  return {
    channels,
    health: () => ({ up: true, uptimeSec: 1, resuming: false, resumed: 0, failed: 0, total: channels.size }),
    incidents: { list: () => [] },
    statusSummary: async () => ({ channels: channels.size, running: 0, ffmpeg: 0 }),
    capabilities: async () => ({ ffmpeg: true, protocols: { udp: true, rtmp: true, srt: false }, encoders: { libx264: { listed: true, verified: true } } }),
    list: async () => Array.from(channels.values()),
    get: async (id) => { const c = channels.get(id); if (!c) { const e = new Error('no such channel: ' + id); e.httpStatus = 404; throw e } return c },
    add: async (id, b) => {
      const c = { id, title: b.title || id, transcode: null, running: false, state: 'idle', ...normalize({ ...b, input: b.input ?? 'test' }, null) }
      channels.set(id, c)
      return c
    },
    update: async (id, b) => {
      const c = channels.get(id)
      if (!c) { const e = new Error('no such channel: ' + id); e.httpStatus = 404; throw e }
      // Validate FIRST, assign second — a rejected patch must leave the channel alone.
      const patch = normalize(b, c)
      return Object.assign(c, patch)
    },
    remove: async (id) => { channels.delete(id); return { id, removed: true } },
    start: async (id) => ({ id, running: true }),
    stop: async (id) => ({ id, running: false }),
    rotate: async (id) => ({ id, feedGen: 1 }),
    logs: () => []
  }
}

// A fake `ssh` binary: reads the remote command (the last argv element ssh builds) and
// prints canned output. This is the command-stub seam — server_* tools exercise their
// real argv-building + parsing code against it, without a live sshd.
const FAKE_SSH = path.join(dirs.mcp, 'fake-ssh.mjs')
fs.writeFileSync(FAKE_SSH, `
const remote = process.argv[process.argv.length - 1]
let out = ''
if (/admin-cli\\.js init/.test(remote)) {
  out = 'Panel initialized.\\nPanel public key (give to clients):\\n  ${FAKE_PUB}\\nPublisher key (put in the broadcaster .env as PUBLISHER_KEY):\\n  ${FAKE_PUBLISHER_SECRET}\\nKeys are in /data/keys (gitignored - BACK UP).'
} else if (/command -v docker|docker --version|== docker ==/.test(remote)) {
  out = '== docker ==\\nDocker version 27.0.0\\n== docker compose ==\\nDocker Compose version v2.29.0\\n== ffmpeg ==\\nffmpeg version 7.0\\n== git ==\\ngit version 2.43.0\\n== repo ==\\nabsent (/opt/aliran)'
} else if (/docker compose .*\\bps\\b/.test(remote)) {
  out = 'NAME                  STATUS\\naliran-panel-1        Up 2 hours\\naliran-broadcaster-1  Up 2 hours\\n== commit ==\\nb136457 docs(packages)'
} else {
  out = 'stub-ok'
}
process.stdout.write(out + '\\n')
process.exit(0)
`)

async function callRaw (client, name, args) {
  return client.callTool({ name, arguments: args || {} })
}
// Async CLI runner for the doctor subprocess. MUST be async (never spawnSync): the
// panel/broadcaster servers live IN THIS test process, so a blocked event loop
// would leave the doctor's healthz probes hanging until their abort timers fire.
function runCli (args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }) })
  })
}
async function callJson (client, name, args) {
  const r = await client.callTool({ name, arguments: args || {} })
  const text = (r.content && r.content[0] && r.content[0].text) || ''
  assert.ok(!r.isError, `${name} returned an error: ${text}`)
  try { return JSON.parse(text) } catch { return text }
}

try {
  // ===== Panel: signed store + admin server (the reference in-process boot) =====
  initKeys(dirs.panel)
  const keys = openKeys(dirs.panel)
  const { store: panelStore, db, assets } = await openStore(dirs.panel, keys); cleanups.push(() => panelStore.close())
  const ring = makeRing(200)
  const ctx = { config, keys, db, assets, dataDir: dirs.panel, activity: ring }
  ops.addAdmin(ctx, PANEL_ADMIN.user, PANEL_ADMIN.pass)
  const panelSrv = await startAdminServer(ctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 50, seconds: 60 } })
  cleanups.push(panelSrv.close)
  const panelPort = panelSrv.port
  log('panel admin API on 127.0.0.1:' + panelPort)

  // ===== Broadcaster: fake manager + control server =====
  const bcConfig = { dataDir: dirs.bc, argon2: { memKiB: 8192, time: 1 } }
  bcAddAdmin({ config: bcConfig, dataDir: dirs.bc }, BC_ADMIN.user, BC_ADMIN.pass)
  const manager = makeFakeManager()
  const bcSrv = await startControlServer({ config: bcConfig, manager, dataDir: dirs.bc }, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 50, seconds: 60 } })
  cleanups.push(bcSrv.close)
  const bcPort = bcSrv.port
  log('broadcaster control API on 127.0.0.1:' + bcPort)

  // ===== MCP config (points at both loopback APIs; ssh via the fake binary) =====
  const cfgPath = path.join(dirs.mcp, 'config.json')
  fs.writeFileSync(cfgPath, JSON.stringify({
    dataDir: path.join(dirs.mcp, 'state'),
    docsDir: path.join(REPO, 'docs'),
    panel: { url: `http://127.0.0.1:${panelPort}`, user: PANEL_ADMIN.user, pass: PANEL_ADMIN.pass },
    broadcaster: { url: `http://127.0.0.1:${bcPort}`, user: BC_ADMIN.user, pass: BC_ADMIN.pass },
    ssh: { host: 'box.example', user: 'root', keyPath: FAKE_SSH, sshBin: [process.execPath, FAKE_SSH] },
    install: { repoDir: '/opt/aliran', composeProfiles: [] }
  }, null, 2), { mode: 0o600 })

  // ===== Launch the MCP server over stdio and connect as an MCP client =====
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_ENTRY, '--config', cfgPath], cwd: REPO, env: process.env, stderr: 'inherit' })
  const client = new Client({ name: 'e2e-mcp-test', version: '0.0.1' })
  cleanups.push(() => client.close())
  await client.connect(transport)
  log('MCP client connected to the server over stdio')

  // ===== A: list_tools / list_resources shape + the tool groups are present =====
  const toolsList = await client.listTools()
  const toolNames = new Set(toolsList.tools.map((t) => t.name))
  for (const must of ['panel_status', 'panel_create_user', 'panel_delete_stream', 'panel_add_package', 'panel_set_user_packages',
    'broadcaster_list_channels', 'broadcaster_add_channel', 'broadcaster_incidents',
    'server_preflight', 'server_install', 'server_update', 'diagnose_healthz', 'diagnose_symptom', 'docs_search']) {
    assert.ok(toolNames.has(must), 'tools/list missing ' + must)
  }
  assert.ok(toolsList.tools.length >= 30, 'expected a broad tool catalog, got ' + toolsList.tools.length)
  const resList = await client.listResources()
  const resUris = new Set(resList.resources.map((r) => r.uri))
  assert.ok(resUris.has('mcp://aliran/guide'), 'guide resource missing')
  assert.ok(resUris.has('mcp://aliran/docs/operator-guide.md'), 'operator-guide doc resource missing')
  assert.ok(resList.resources.length >= 20, 'expected the docs corpus as resources, got ' + resList.resources.length)
  log(`A: ${toolsList.tools.length} tools, ${resList.resources.length} resources; all groups present ✓`)

  // ===== B: a read tool =====
  const status = await callJson(client, 'panel_status')
  assert.ok(status.admins >= 1, 'panel_status reports the admin')
  const users0 = await callJson(client, 'panel_list_users')
  assert.ok(Array.isArray(users0.users) && users0.next === null, 'panel_list_users shape {users,next}')
  log('B: read tools (panel_status, panel_list_users) ✓')

  // ===== C: the write chain — add streams -> create user -> package -> assign -> assert =====
  for (const id of ['mcp-a', 'mcp-b']) {
    const s = await callJson(client, 'panel_add_stream', { id, category: 'MCPBundle' })
    assert.strictEqual(s.catalog ? s.catalog.category[0] : undefined, 'MCPBundle', 'add stream ' + id)
  }
  const created = await callJson(client, 'panel_create_user', { username: 'mcpviewer' })
  assert.ok(created.generatedPassword && created.generatedPassword.length >= 16, 'create_user generates + returns a password when omitted')
  const pkg = await callJson(client, 'panel_add_package', { name: 'mcp-pack', label: 'MCP Pack', members: 'category:MCPBundle' })
  assert.ok(pkg.members.includes('category:MCPBundle'), 'package created with the category selector')
  const assigned = await callJson(client, 'panel_set_user_packages', { username: 'mcpviewer', packages: ['mcp-pack'] })
  assert.ok(assigned.grants.includes('mcp-a') && assigned.grants.includes('mcp-b'), 'package assignment materialized both grants')
  assert.deepStrictEqual(assigned.manualGrants, [], 'package grants are not manual')
  // Assert via the panel API (authoritative signed DB) that the seal really landed.
  const rec = (await db.get('user/mcpviewer')).value
  assert.ok(rec.wrapped['mcp-a'] && rec.wrapped['mcp-b'], 'sealed grants in the signed DB')
  assert.deepStrictEqual(rec.packages, ['mcp-pack'], 'package provenance on the user record')
  log('C: write chain (streams -> user -> package -> assign) materialized sealed grants ✓')

  // ===== D: annotations — destructiveHint on purges/revokes, readOnlyHint on GETs =====
  const byName = Object.fromEntries(toolsList.tools.map((t) => [t.name, t]))
  for (const name of ['panel_delete_stream', 'panel_delete_user', 'panel_revoke_grant', 'panel_delete_package', 'broadcaster_remove_channel', 'broadcaster_stop_channel', 'server_update']) {
    assert.strictEqual(byName[name].annotations && byName[name].annotations.destructiveHint, true, name + ' must carry destructiveHint')
  }
  for (const name of ['panel_status', 'panel_list_users', 'panel_list_streams', 'broadcaster_list_channels', 'docs_search', 'diagnose_healthz', 'server_preflight']) {
    assert.strictEqual(byName[name].annotations && byName[name].annotations.readOnlyHint, true, name + ' must carry readOnlyHint')
  }
  // create/mutate tools must NOT be flagged destructive (clients would over-confirm)
  assert.ok(!(byName.panel_create_user.annotations && byName.panel_create_user.annotations.destructiveHint), 'create_user is not destructive')
  log('D: destructiveHint on purges/revokes; readOnlyHint on GETs; creates unflagged ✓')

  // ===== E: docs resource read + docs_search + the guide =====
  const doc = await client.readResource({ uri: 'mcp://aliran/docs/operator-guide.md' })
  assert.match(doc.contents[0].text, /Operator Guide/, 'operator-guide resource text')
  assert.match(doc.contents[0].mimeType, /markdown/, 'doc mimeType is markdown')
  const guide = await client.readResource({ uri: 'mcp://aliran/guide' })
  assert.match(guide.contents[0].text, /Tool catalog/, 'guide summarizes the tool catalog')
  const search = await callJson(client, 'docs_search', { query: 'publish the dashboards caddy' })
  assert.ok(search.matches.length > 0, 'docs_search returned matches')
  assert.ok(search.matches.some((m) => m.uri.includes('public-dashboards')), 'docs_search found the dashboards KB')
  log('E: docs resource read + docs_search hit + guide ✓')

  // ===== F: the re-login-on-401 path (bump the panel admin tokenVersion mid-test) =====
  // The MCP has a cached token from the calls above. Bumping tokenVersion (same
  // password) invalidates it; the next call must 401 -> re-login once -> succeed.
  const before = ops.setAdminPassword(ctx, PANEL_ADMIN.user, PANEL_ADMIN.pass)
  assert.ok(before.tokenVersion >= 2, 'tokenVersion bumped')
  const afterBump = await callJson(client, 'panel_status')
  assert.ok(afterBump.admins >= 1, 'panel_status succeeds after the tokenVersion bump (re-login-on-401 worked)')
  log('F: re-login-on-401 — a stale token transparently re-authenticated ✓')

  // ===== G: the SSH executor against the command stub =====
  const pre = await callJson(client, 'server_preflight')
  assert.match(pre.report, /Docker version/, 'server_preflight ran the probe over ssh (stubbed)')
  assert.strictEqual(pre.host, 'box.example', 'preflight reports the configured host')
  const svrStatus = await callJson(client, 'server_status')
  assert.match(svrStatus.status, /aliran-panel-1/, 'server_status ran docker compose ps (stubbed)')
  const install = await callJson(client, 'server_install')
  assert.strictEqual(install.panelPublicKey, FAKE_PUB, 'server_install returns the panel PUBLIC key parsed from init')
  assert.match(install.publisherKeyWrittenTo, /broadcaster\/\.env/, 'the publisher key was written server-side')
  // The critical guarantee: the PUBLISHER SECRET never comes back to the model.
  const installText = JSON.stringify(install)
  assert.ok(!installText.includes(FAKE_PUBLISHER_SECRET), 'the publisher SECRET must NOT appear in the tool result')
  log('G: SSH executor (preflight/status/install) via the command stub; publisher secret stayed server-side ✓')

  // ===== H: broadcaster tools =====
  const bh = await callJson(client, 'broadcaster_health')
  assert.strictEqual(bh.up, true, 'broadcaster_health up')
  await callJson(client, 'broadcaster_add_channel', { id: 'mcp-chan', input: 'test' })
  const chans = await callJson(client, 'broadcaster_list_channels')
  assert.ok(chans.find((c) => c.id === 'mcp-chan'), 'added channel shows in the list')
  const incidents = await callJson(client, 'broadcaster_incidents')
  assert.ok(Array.isArray(incidents), 'incidents route (missing from the control-server header comment) works')
  log('H: broadcaster tools (health, channel add/list, incidents) ✓')

  // ===== I: the onboarding doctor (`--doctor`) =====
  // Happy path: same config (live loopback servers + the fake ssh), WITH --login so
  // the credential check runs too. A human-run subprocess — stdout is the report.
  const dr = await runCli([MCP_ENTRY, '--doctor', '--login', '--config', cfgPath])
  assert.strictEqual(dr.status, 0, 'doctor exits 0 when everything checks out:\n' + dr.stdout + dr.stderr)
  for (const marker of [
    'Aliran MCP doctor',
    'config readable + valid JSON',
    'ssh: connected to root@box.example',
    'panel: /healthz answered',
    'panel: credentials accepted',
    'broadcaster: /healthz answered',
    'broadcaster: credentials accepted',
    'documents indexed',
    'Enabled tool groups: panel_*  broadcaster_*  server_*  diagnose_*  docs_search',
    'claude_desktop_config.json',
    '"mcpServers"',
    'client-agnostic',
    '[mcp_servers.aliran]',
    '~/.codex/config.toml',
    '.vscode/mcp.json',
    'codex mcp add aliran',
    'claude mcp add aliran',
    'destructiveHint) are ADVISORY',
    'RESULT: all checks passed'
  ]) assert.ok(dr.stdout.includes(marker), `doctor output missing: ${marker}\n---\n${dr.stdout}`)
  assert.ok(!dr.stdout.includes(PANEL_ADMIN.pass) && !dr.stdout.includes(BC_ADMIN.pass), 'doctor never prints a password')

  // Failure path: a panel url nothing listens on → [FAIL] + exit 1.
  const deadPort = await new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
  const badCfgPath = path.join(dirs.mcp, 'config-bad.json')
  fs.writeFileSync(badCfgPath, JSON.stringify({
    dataDir: path.join(dirs.mcp, 'state-bad'),
    docsDir: path.join(REPO, 'docs'),
    panel: { url: `http://127.0.0.1:${deadPort}`, user: 'x', pass: 'xxxxxxxx', timeoutMs: 3000 }
  }), { mode: 0o600 })
  const drBad = await runCli([MCP_ENTRY, '--doctor', '--config', badCfgPath])
  assert.strictEqual(drBad.status, 1, 'doctor exits 1 on a failed probe:\n' + drBad.stdout + drBad.stderr)
  assert.ok(/\[FAIL\] panel: .*unreachable/.test(drBad.stdout), 'doctor reports the unreachable panel')
  assert.ok(/RESULT: 1 check\(s\) FAILED/.test(drBad.stdout), 'doctor summarizes the failure')

  // Unusable config → exit 2.
  const drNone = await runCli([MCP_ENTRY, '--doctor', '--config', path.join(dirs.mcp, 'nope.json')], { timeoutMs: 30000 })
  assert.strictEqual(drNone.status, 2, 'doctor exits 2 on an unreadable config')
  assert.ok(drNone.stdout.includes('[FAIL] config error'), 'config error reported on stdout in doctor mode')
  log('I: doctor — full pass w/ --login exit 0, dead panel [FAIL] exit 1, bad config exit 2, no passwords printed ✓')

  // ===== J: typed channel input/transcode (the 2026-07-24 silent-corruption fix) =====
  // Root cause: `input`/`transcode` were declared z.any(), which publishes an EMPTY
  // JSON Schema — a client with no type information for the field passes objects as
  // JSON STRINGS, and the broadcaster's normalizeInput stored the blob as a file path.
  // HTTP 200, sourceCount 0, four dead production channels.
  const upd = byName.broadcaster_update_channel.inputSchema.properties.input
  assert.ok(upd && Object.keys(upd).length > 0, 'input must publish a real schema, not {} (the z.any() footgun)')
  const inputBranches = JSON.stringify(upd)
  assert.match(inputBranches, /"kind"/, 'the published input schema names the discriminator')
  for (const kind of ['test', 'file', 'pull', 'rtmp', 'srt', 'udp']) {
    assert.ok(inputBranches.includes(`"const":"${kind}"`), `published input schema is missing the ${kind} branch`)
  }
  assert.ok(Object.keys(byName.broadcaster_update_channel.inputSchema.properties.transcode || {}).length > 0, 'transcode must publish a real schema too')

  const PULL = 'http://origin.example:8081/CH/1/playlist.m3u8'
  const PULL2 = 'https://backup.example/CH/2/playlist.m3u8'
  // Object-valued input on add AND on update — the shape the model naturally sends.
  const addedObj = await callJson(client, 'broadcaster_add_channel', { id: 'mcp-typed', input: { kind: 'pull', url: PULL, fallbacks: [PULL2] } })
  assert.strictEqual(addedObj.input.kind, 'pull', 'object input round-trips as kind:"pull" (not a file path)')
  assert.strictEqual(addedObj.input.url, PULL, 'the pull url survived intact')
  assert.deepStrictEqual(addedObj.input.fallbacks, [PULL2], 'fallbacks survived — there is no string shorthand for them')
  const patched = await callJson(client, 'broadcaster_update_channel', { id: 'mcp-typed', input: { kind: 'pull', url: PULL2 } })
  assert.strictEqual(patched.input.kind, 'pull', 'object input round-trips through update too')
  assert.strictEqual(patched.input.url, PULL2, 'update repointed the source')

  // Defense in depth: the EXACT failing call from 2026-07-24 — the object arriving as
  // a JSON string. It must be parsed back into an object, never stored as a path.
  const rescued = await callJson(client, 'broadcaster_update_channel', { id: 'mcp-typed', input: JSON.stringify({ kind: 'pull', url: PULL }) })
  assert.strictEqual(rescued.input.kind, 'pull', 'a STRINGIFIED input object is parsed, not taken for a file path')
  assert.strictEqual(rescued.input.url, PULL, 'the rescued url is the one that was sent')

  // Malformed input is a LOUD error — and leaves the stored source untouched.
  for (const [label, badInput] of [
    ['stringified object with no url', '{"kind":"pull"}'],
    ['truncated JSON', '{"kind":"pull","url":"http://h/x.m3u8"'],
    ['unknown kind', { kind: 'stream' }],
    ['object with no url', { kind: 'pull' }],
    ['misspelled field', { kind: 'pull', url: PULL, fallback: PULL2 }],
    ['unsupported scheme', { kind: 'pull', url: 'ftp://h/x' }]
  ]) {
    const r = await callRaw(client, 'broadcaster_update_channel', { id: 'mcp-typed', input: badInput })
    const text = (r.content && r.content[0] && r.content[0].text) || ''
    assert.ok(r.isError, `a malformed input (${label}) must be rejected, got: ${text}`)
    assert.ok(!/"kind"\s*:\s*"file"/.test(text), `a malformed input (${label}) must never fall back to kind:"file": ${text}`)
  }
  const afterBad = await callJson(client, 'broadcaster_get_channel', { id: 'mcp-typed' })
  assert.strictEqual(afterBad.input.kind, 'pull', 'the rejected patches left the channel on its pull source')
  assert.strictEqual(afterBad.input.url, PULL, 'the rejected patches did not touch the url')

  // transcode: same two paths (object + stringified object), same loud rejection.
  const tc = await callJson(client, 'broadcaster_update_channel', { id: 'mcp-typed', transcode: { encoder: 'libx264', resolution: '720p', fps: 30 } })
  assert.strictEqual(tc.transcode.encoder, 'libx264', 'object transcode round-trips')
  assert.strictEqual(tc.transcode.resolution, '720p', 'transcode resolution applied')
  const tcStr = await callJson(client, 'broadcaster_update_channel', { id: 'mcp-typed', transcode: JSON.stringify({ encoder: 'copy' }) })
  assert.strictEqual(tcStr.transcode.encoder, 'copy', 'a STRINGIFIED transcode object is parsed too')
  for (const badTc of [{ encoder: 'h265_nvenc' }, '{"encoder":"copy","resolution":"720p"}', 'libx264', '{"encoder":']) {
    const r = await callRaw(client, 'broadcaster_update_channel', { id: 'mcp-typed', transcode: badTc })
    assert.ok(r.isError, `a malformed transcode (${JSON.stringify(badTc)}) must be rejected`)
  }
  const stillCopy = await callJson(client, 'broadcaster_get_channel', { id: 'mcp-typed' })
  assert.strictEqual(stillCopy.transcode.encoder, 'copy', 'the rejected transcode patches changed nothing')
  log('J: typed input/transcode — real published schema, objects round-trip, stringified objects rescued, malformed ones rejected with the stored source intact ✓')

  log('\nRESULT: PASS ✅  (MCP tools + resources; write chain materialized sealed grants; destructive/readOnly annotations; docs resources + search; re-login-on-401; SSH executor via command stub with the publisher secret staying server-side; broadcaster control tools; onboarding doctor; typed channel input/transcode)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
