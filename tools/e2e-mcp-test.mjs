// End-to-end test for the Aliran MCP server (S46). Deterministic, no DHT, no ffmpeg —
// belongs in the required core lane.
//
// Boots a REAL panel store + admin server in-process, a broadcaster control server
// (with a lightweight fake ChannelManager, so no ffmpeg/DHT), a REAL reseller service
// pointed at that panel (the e2e-reseller-test harness pattern), and a library
// control server (fake TitleManager — the call shapes, not a real transcode), writes
// an MCP config pointing at all four over loopback, then launches mcp/src/index.js
// over a stdio pipe and drives it AS AN MCP CLIENT (the handshake itself pins the
// version the server reports — on the wire and via `--version` — to mcp/package.json):
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
//   Q  categories (S49b/G5): presentation upsert, rename rewrites the catalog (and a
//      category: package selector honestly loses/regains its holders), merge retags,
//      delete drops the registry entry but KEEPS membership
//   R  source curation (S49b/G6): exclude round-trip through panel_set_source (the
//      ETag reset on an exclusion change, not on a no-op) + panel_source_channels
//   S  stream art (S49b/G7): a real PNG from the operator's disk lands in the assets
//      drive + the catalog record — bytes never appear in a tool result; cap /
//      extension / missing-file refusals are client-side
//   T  reseller oversight (S49b/G8): status/system, principal enroll (generated
//      password live-verified) / limits / suspend, credit mint echoing the ledger
//      line, ledger query, accounts + trials views, ops status
//   U  library (S49b/G9): titles add/get/list, the mid-ingest delete refusal,
//      operational patch, reingest, logs, delete echoing the panel-record disposition
//   V  diagnose_healthz sweeps all four configured services
//   W  multi-host SSH (S49c/G10): a second fake box through the EXTENDED stub seam
//      (--state/--log argv) — server_* {host}, per-host repoDir, unknown-host error,
//      panel_add_publisher {host} writing the named box's broadcaster/.env (secret
//      still never in the result), default-host behavior untouched
//   X  repeater_status (S49c/G10): compose ps + logs over SSH; the opt-in status
//      server honestly reported when absent, probed when STATUS_PORT is set
//      (metrics on 9600, configured-but-dead on 9700)
//   Y  list ergonomics (S49c/G11): panel_list_streams category/prefix/idsOnly/limit
//      (no-arg call stays the raw array), user-summary compaction ({count, sample})
//      with full:true restoring every id, small users untouched
//   Z  schema gaps (S49c/G12): hlsTime/hlsListSize round-trip + bounds rejection
//      (the mirrored bounds text-matched against channel.js), panel feedKey/key —
//      a SUPPLIED key lands panel-side and is REDACTED from the result, a
//      generated one still returns once
//   AA MCP prompts (S49c/G13): list/get shapes, argument interpolation, and the
//      drift guard — every tool name a prompt mentions must exist
//   AB server_update dryRun (S49c/G16): fetch+log+diff only, no build/up in the log
//   AC npm-publish prep (S49c/G14): bundle-docs, npm pack --dry-run file list, and
//      the unpacked-tarball doctor run resolving docs from docs-bundle/
//   AD viewer problem reports (S50d): the five panel_* report tools against a REAL
//      reports store + a webhook stub — the honest "disabled" shape without one,
//      filters + sinceHours, event-ring compaction with full:true, ack/resolve with
//      a note, alerts (read-only by design), test_notify reaching the stub, a
//      mini negative-identity scan over every tool result, the REPORTS_* allowlist
//      vs the refused notification credentials, and a category-enum drift guard
//      against panel/src/reports.js
//   AE external VOD provider (S53a): panel_vod_config / panel_set_vod_config — the
//      honest null before anything is configured, a CRUD round-trip through the two
//      tools, and the validation refusals arriving IN BAND as isError results
//      (cleartext apiBase, an apiBase carrying a query string, enabling an empty
//      config, an unknown source kind) with the stored record untouched
// Exits 0 on PASS.

import assert from 'assert'
import os from 'os'
import fs from 'fs'
import net from 'net'
import http from 'http'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { initKeys, openKeys } from '../panel/src/keys.js'
import { openStore } from '../panel/src/store.js'
import { makeRing } from '../panel/src/activity.js'
import * as ops from '../panel/src/ops.js'
import { startAdminServer } from '../panel/src/admin-server.js'
import { makeReports, REPORT_CATEGORIES } from '../panel/src/reports.js'
import { makeNotifier } from '../panel/src/notify.js'
import { addAdmin as bcAddAdmin } from '../broadcaster/src/control-auth.js'
import { startControlServer } from '../broadcaster/src/control-server.js'
import { normalizeInput, normalizeTranscode } from '../broadcaster/src/channel.js'
import { startReseller } from '../reseller/src/index.js'
import { addPrincipal } from '../reseller/src/control-auth.js'
import { makeSsh } from '../mcp/src/ssh.js'
import { makeHttpClient } from '../mcp/src/http-client.js'
import { addAdmin as libAddAdmin } from '../library/src/control-auth.js'
import { startControlServer as startLibraryControlServer } from '../library/src/control-server.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const log = (...a) => console.log(...a)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const MCP_ENTRY = path.join(REPO, 'mcp', 'src', 'index.js')

const PANEL_ADMIN = { user: 'panelop', pass: 'panel-op-password-1' }
const BC_ADMIN = { user: 'bcop', pass: 'bc-op-password-1' }
const RSL_ROOT = { user: 'boss', pass: 'boss-pass-123' } // the reseller ROOT admin the MCP logs in as
const RSL_SVC = { user: 'rsl-svc', pass: 'rsl-svc-secret-1' } // the reseller service's own panel admin
const LIB_ADMIN = { user: 'libop', pass: 'lib-op-password-1' }
const FAKE_PUB = 'a'.repeat(64) // the panel PUBLIC key our fake `admin-cli init` prints
const FAKE_PUBLISHER_SECRET = 'b'.repeat(128) // the PUBLISHER secret — must never reach the model

const config = { argon2: { memKiB: 8192, time: 1 }, maxDevicesDefault: 2 }
const dirs = {
  panel: fs.mkdtempSync(path.join(os.tmpdir(), 'e2emcp-panel-')),
  bc: fs.mkdtempSync(path.join(os.tmpdir(), 'e2emcp-bc-')),
  rsl: fs.mkdtempSync(path.join(os.tmpdir(), 'e2emcp-rsl-')),
  lib: fs.mkdtempSync(path.join(os.tmpdir(), 'e2emcp-lib-')),
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
    // Mirrors channel.js normalizeMeta's hls block (incl. the quirk that patching
    // one field re-derives the OTHER from the config default, not the stored
    // value). Section Z text-matches the real source so this cannot drift silently.
    if (fields.hlsTime != null || fields.hlsListSize != null) {
      const time = parseInt(fields.hlsTime ?? 2, 10)
      const listSize = parseInt(fields.hlsListSize ?? 8, 10)
      const bad = (msg) => { const e = new Error(msg); e.httpStatus = 400; throw e }
      if (!Number.isInteger(time) || time < 1 || time > 30) bad('hlsTime must be 1-30')
      if (!Number.isInteger(listSize) || listSize < 2 || listSize > 60) bad('hlsListSize must be 2-60')
      out.hls = { time, listSize }
    }
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

// A fake TitleManager: the library control-server surface with the REAL routes'
// validation semantics mirrored (mid-ingest refusals, the panel-owned-metadata
// patch gate) but no ffmpeg/DHT — test:mcp asserts the control-API call shapes,
// not a real transcode. `setState` is the test's hook for walking a title through
// queued → ready without an ingest actually running.
function makeFakeLibrary () {
  const titles = new Map()
  const rings = new Map()
  const bad = (msg) => { const e = new Error(msg); e.httpStatus = 400; throw e }
  const notFound = (id) => { const e = new Error('no such title: ' + id); e.httpStatus = 404; throw e }
  const view = (m) => ({ ...m, ingest: m.state === 'ingesting' ? { phase: 'transcode', pct: 42 } : null, peers: 0, registered: m.state === 'ready', registerError: null })
  const counts = () => {
    const all = [...titles.values()]
    const by = (s) => all.filter((t) => t.state === s).length
    return { titles: all.length, ready: by('ready'), ingesting: by('ingesting'), queued: by('queued'), error: by('error') }
  }
  return {
    setState: (id, state) => { titles.get(id).state = state },
    health: () => ({ up: true, uptimeSec: 1, ...counts(), panelLink: { connected: false, pendingOps: 0 } }),
    statusSummary: async () => counts(),
    list: () => [...titles.values()].map(view),
    get: (id) => { const m = titles.get(id); if (!m) notFound(id); return view(m) },
    logs: (id, lines = 400) => {
      if (!titles.has(id)) notFound(id)
      const ring = rings.get(id) || []
      return lines >= ring.length ? ring.slice() : ring.slice(-lines)
    },
    add: async (id, b) => {
      if (titles.has(id)) { const e = new Error(`title "${id}" already exists`); e.httpStatus = 409; throw e }
      if (typeof b.input !== 'string' || !b.input.trim()) bad('input is required (a file path on the library box, or a URL ffmpeg can read)')
      const mode = b.mode ?? 'auto'
      if (!['auto', 'copy', 'transcode'].includes(mode)) bad("mode must be 'auto', 'copy' or 'transcode'")
      const m = {
        id,
        title: b.title || id,
        description: b.description || '',
        category: Array.isArray(b.category) ? b.category : (b.category ? [b.category] : []),
        input: b.input.trim(),
        mode,
        hlsTime: b.hlsTime ?? 4,
        state: 'queued',
        error: null,
        gen: 0,
        feedKey: null
      }
      titles.set(id, m)
      rings.set(id, ['queued ingest from ' + m.input])
      return view(m)
    },
    update: async (id, patch) => {
      const m = titles.get(id)
      if (!m) notFound(id)
      const allowed = ['input', 'mode', 'hlsTime']
      const unknown = Object.keys(patch).filter((k) => !allowed.includes(k))
      if (unknown.length) bad(`only ${allowed.join('/')} can be changed here (${unknown.join(', ')} — descriptive metadata is edited in the panel; it is admin-owned after creation)`)
      if (patch.mode !== undefined && !['auto', 'copy', 'transcode'].includes(patch.mode)) bad("mode must be 'auto', 'copy' or 'transcode'")
      Object.assign(m, patch)
      return view(m)
    },
    reingest: async (id, opts = {}) => {
      const m = titles.get(id)
      if (!m) notFound(id)
      if (m.state === 'ingesting' || m.state === 'queued') bad(`title "${id}" is already ${m.state}`)
      if (opts.input !== undefined) m.input = String(opts.input).trim()
      m.state = 'queued'
      m.gen++
      rings.get(id).push('reingest gen ' + m.gen)
      return view(m)
    },
    remove: async (id) => {
      const m = titles.get(id)
      if (!m) notFound(id)
      if (m.state === 'ingesting' || m.state === 'queued') bad(`title "${id}" is ${m.state} — wait for the ingest to finish before deleting`)
      titles.delete(id)
      rings.delete(id)
      return { id, removed: true }
    }
  }
}

// A fake `ssh` binary — the command-stub seam. It emulates just enough of the box
// for server_* tools to exercise their REAL argv-building/sequencing/parsing code
// without a live sshd: canned outputs for the probes, a persisted fake .env store
// (fakebox-env.json) for the server_set_env snapshot/upsert/revert flow, and — the
// part that matters — `docker compose run … node src/config.js --check` spawns the
// REAL service config.js locally with the fake .env as its environment, so the
// validate-then-revert path is driven by the true fail-fast validation text, not a
// mock of it. Every remote command is appended to a log the test asserts on.
const FAKE_SSH = path.join(dirs.mcp, 'fake-ssh.mjs')
const FAKE_STATE = path.join(dirs.mcp, 'fakebox-env.json')
const FAKE_CMDLOG = path.join(dirs.mcp, 'fake-ssh-commands.log')
// The second fake box (multi-host, section W): SAME stub script, its own state +
// command log — selected per host through the sshBin argv (--state/--log prefix
// args), so the seam is extended, not forked.
const FAKE_STATE2 = path.join(dirs.mcp, 'fakebox2-env.json')
const FAKE_CMDLOG2 = path.join(dirs.mcp, 'fake-ssh2-commands.log')
fs.writeFileSync(FAKE_SSH, String.raw`
import fs from 'fs'
import { spawnSync } from 'child_process'
const REPO = ${JSON.stringify(REPO)}
let STATE = ${JSON.stringify(FAKE_STATE)}
let LOGF = ${JSON.stringify(FAKE_CMDLOG)}
// --state/--log prefix args (from the config's sshBin array) point this instance
// at a different fake box; everything after them is the normal ssh argv.
let av = process.argv.slice(2)
while (av[0] === '--state' || av[0] === '--log') {
  if (av[0] === '--state') STATE = av[1]
  else LOGF = av[1]
  av = av.slice(2)
}
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1))
const out = (s) => { process.stdout.write(s + '\n'); process.exit(0) }

let remote = av[av.length - 1]
fs.appendFileSync(LOGF, remote.split('\n').join(' <NL> ') + '\n')
// The repo dir the MCP cd'd into — repoDir differs per host (repoDirFor), so the
// state keys derive from it rather than a hardcoded /opt/aliran.
let cwd = '/opt/aliran'
remote = remote.replace(/^cd '([^']*)' && /, (mm, d) => { cwd = d; return '' })
let m

// ---- canned probes (S46) ----
if (/admin-cli\.js init/.test(remote)) {
  out('Panel initialized.\nPanel public key (give to clients):\n  ${FAKE_PUB}\nPublisher key (put in the broadcaster .env as PUBLISHER_KEY):\n  ${FAKE_PUBLISHER_SECRET}\nKeys are in /data/keys (gitignored - BACK UP).')
}
if (/command -v docker|docker --version|== docker ==/.test(remote)) {
  out('== docker ==\nDocker version 27.0.0\n== docker compose ==\nDocker Compose version v2.29.0\n== ffmpeg ==\nffmpeg version 7.0\n== git ==\ngit version 2.43.0\n== repo ==\nabsent (/opt/aliran)')
}

// ---- fake box .env state (upsertEnv / the server_set_env snapshot-revert flow) ----
if ((m = remote.match(/^\[ -f '([^']+)' \] && echo exists/))) {
  out(state[m[1]] !== undefined ? 'exists' : 'absent')
}
if ((m = remote.match(/^cp -p '([^']+)' '([^']+)'$/))) {
  if (state[m[1]] === undefined) { process.stderr.write('cp: no such file\n'); process.exit(1) }
  state[m[2]] = state[m[1]]; save(); out('')
}
if ((m = remote.match(/^mv '([^']+)' '([^']+)'$/))) {
  if (state[m[1]] === undefined) { process.stderr.write('mv: no such file\n'); process.exit(1) }
  state[m[2]] = state[m[1]]; delete state[m[1]]; save(); out('')
}
if ((m = remote.match(/^rm -f '([^']+)'$/))) { delete state[m[1]]; save(); out('') }
if (remote.indexOf("printf '%s") !== -1 && remote.indexOf(" >> '") !== -1) {
  let mm
  const touchRe = /touch '([^']+)'/g
  while ((mm = touchRe.exec(remote))) { if (state[mm[1]] === undefined) state[mm[1]] = '' }
  const dropRe = /grep -v '\^([A-Z0-9_]+)=' '([^']+)'/g
  while ((mm = dropRe.exec(remote))) {
    const keep = (state[mm[2]] || '').split('\n').filter((l) => l !== '' && l.indexOf(mm[1] + '=') !== 0)
    state[mm[2]] = keep.length ? keep.join('\n') + '\n' : ''
  }
  const addRe = /printf '%s\\n' '([^']*)' >> '([^']+)'/g
  while ((mm = addRe.exec(remote))) {
    const keep = (state[mm[2]] || '').split('\n').filter((l) => l !== '')
    keep.push(mm[1])
    state[mm[2]] = keep.join('\n') + '\n'
  }
  save(); out('')
}

// ---- in-image check-config: run the REAL service config.js locally ----
if ((m = remote.match(/docker compose(?: --profile '[^']*')* run --rm '(panel|broadcaster|library|reseller)' node src\/config\.js --check/))) {
  const vars = {}
  for (const line of (state[cwd + '/' + m[1] + '/.env'] || '').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) vars[line.slice(0, i)] = line.slice(i + 1)
  }
  const r = spawnSync(process.execPath, [REPO + '/' + m[1] + '/src/config.js', '--check'], { env: Object.assign({}, process.env, vars), encoding: 'utf8', timeout: 30000 })
  process.stdout.write(r.stdout || '')
  process.stderr.write(r.stderr || '')
  process.exit(r.status === null ? 1 : r.status)
}
if ((m = remote.match(/docker compose(?: --profile '[^']*')* up -d '(panel|broadcaster|library|reseller)'$/))) {
  out('Container aliran-' + m[1] + '-1  Started')
}
if (/docker compose(?: --profile '[^']*')* restart/.test(remote)) {
  out('Container aliran-panel-1  Started\nContainer aliran-broadcaster-1  Started')
}
// ---- repeater (section X) — BEFORE the generic ps branch: its compose calls
// carry -f deploy/docker-compose.repeater.yml and must not get the panel answer.
if (/docker compose -f deploy\/docker-compose\.repeater\.yml ps/.test(remote)) {
  out('NAME                   STATUS\nrepeater-repeater-1    Up 3 hours')
}
if (/docker compose -f deploy\/docker-compose\.repeater\.yml logs/.test(remote)) {
  out('repeater-1  | [repeater] mirroring 12 channels (category:news)\nrepeater-1  | [net] swarm sockets tuned: recv 4 MiB, send 4 MiB')
}
if (remote.indexOf("grep '^STATUS_PORT='") === 0) {
  const pm = remote.match(/grep '\^STATUS_PORT=' ([^ ]+)/)
  const envText = state[cwd + '/' + String(pm[1]).replace(/^\.\//, '')] || ''
  const line = envText.split('\n').filter((l) => l.indexOf('STATUS_PORT=') === 0).pop()
  if (line) out(line)
  process.exit(1)
}
if ((m = remote.match(/^curl -sf --max-time \d+ http:\/\/127\.0\.0\.1:(\d+)\/metrics$/))) {
  if (m[1] === '9600') out('# repeater status\nrepeater_held_blocks{stream_id="news-24"} 1234\nrepeater_peers{stream_id="news-24"} 7\nrepeater_served_bytes_total{stream_id="news-24"} 987654321')
  process.exit(22)
}
// ---- server_update dryRun (section AB) ----
if (/^git fetch --quiet$/.test(remote)) out('')
if (/^git log --oneline HEAD\.\.'@\{u\}'$/.test(remote)) {
  out('abc1234 feat(panel): next thing\ndef5678 fix(broadcaster): other thing')
}
if (/^git diff --stat HEAD '@\{u\}'$/.test(remote)) {
  out(' panel/src/ops.js       | 12 ++++--\n broadcaster/src/hls.js |  4 +-\n 2 files changed, 12 insertions(+), 4 deletions(-)')
}
if (/docker compose .*\bps\b/.test(remote)) {
  out('NAME                  STATUS\naliran-panel-1        Up 2 hours\naliran-broadcaster-1  Up 2 hours\n== commit ==\nb136457 docs(packages)')
}

// ---- backups ----
if (/^ls -lh '/.test(remote)) {
  out('-rw-r--r-- 1 root root 8.9M Jul 24 07:00 ./backups/panel-20260724-070000.tar.gz\n-rw-r--r-- 1 root root  61M Jul 24 07:01 ./backups/broadcaster-20260724-070100.tar.gz')
}
if (/deploy\/restore\.sh/.test(remote)) {
  const force = remote.indexOf('--force') !== -1
  const am = remote.match(/'([^']*\.tar\.gz)'/)
  const arch = am ? am[1].split('/').pop() : 'unknown.tar.gz'
  const sm = remote.match(/restore\.sh (?:--force )?'([a-z]+)'/)
  const svc = sm ? sm[1] : 'panel'
  if (arch.indexOf('nonempty') !== -1 && !force) {
    process.stderr.write('refusing: volume aliran_' + svc + '-data is NOT empty (1234 files, 8.9M) — restoring would overwrite it. Re-run with --force to replace its contents.\n')
    process.exit(3)
  }
  out('== ' + svc + ': verifying archive ' + arch + '\n== ' + svc + ': stopping\n== ' + svc + ': clearing aliran_' + svc + '-data (1234 files, 8.9M)\n== ' + svc + ': restoring ' + arch + ' -> aliran_' + svc + '-data\n== ' + svc + ': starting\n== done: restored aliran_' + svc + '-data from ' + arch + ' (1201 files; replaced 1234 previous files, 8.9M)')
}

out('stub-ok')
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
  // The reseller service gets its OWN panel admin — section F bumps PANEL_ADMIN's
  // tokenVersion and must not race the reseller's cached login.
  ops.addAdmin(ctx, RSL_SVC.user, RSL_SVC.pass)
  const panelSrv = await startAdminServer(ctx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 50, seconds: 60 } })
  cleanups.push(panelSrv.close)
  const panelPort = panelSrv.port
  log('panel admin API on 127.0.0.1:' + panelPort)

  // ===== Broadcaster: fake manager + control server =====
  const bcConfig = { dataDir: dirs.bc, argon2: { memKiB: 8192, time: 1 } }
  bcAddAdmin({ config: bcConfig, dataDir: dirs.bc }, BC_ADMIN.user, BC_ADMIN.pass)
  const manager = makeFakeManager()
  // Kept as a named ref so section K can attach a fake `analytics` later — the
  // control server reads ctx.analytics per request.
  const bcCtx = { config: bcConfig, manager, dataDir: dirs.bc }
  const bcSrv = await startControlServer(bcCtx, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 50, seconds: 60 } })
  cleanups.push(bcSrv.close)
  const bcPort = bcSrv.port
  log('broadcaster control API on 127.0.0.1:' + bcPort)

  // ===== Reseller: the REAL service pointed at the in-process panel (S49b) =====
  addPrincipal({ dataDir: dirs.rsl, config: { argon2: config.argon2 } }, { username: RSL_ROOT.user, password: RSL_ROOT.pass, role: 'admin', root: true, createdBy: 'cli' })
  const rslSvc = await startReseller({
    dataDir: dirs.rsl,
    argon2: config.argon2,
    daysPerMonth: 31,
    trialHours: 24,
    noSweeps: true, // ops driven through the routes, not wall-clock timers
    control: { host: '127.0.0.1', port: 0 },
    lockout: { threshold: 50, seconds: 60 },
    panel: { url: `http://127.0.0.1:${panelPort}`, username: RSL_SVC.user, password: RSL_SVC.pass, timeoutMs: 4000 }
  })
  cleanups.push(() => rslSvc.close())
  const rslPort = rslSvc.control.port
  log('reseller control API on 127.0.0.1:' + rslPort)

  // ===== Library: control server over the fake TitleManager (S49b) =====
  const libConfig = { argon2: config.argon2 }
  libAddAdmin({ config: libConfig, dataDir: dirs.lib }, LIB_ADMIN.user, LIB_ADMIN.pass)
  const fakeLib = makeFakeLibrary()
  const libSrv = await startLibraryControlServer({ config: libConfig, manager: fakeLib, dataDir: dirs.lib }, { host: '127.0.0.1', port: 0, sessionTtlMs: 3600000, lockout: { threshold: 50, seconds: 60 } })
  cleanups.push(libSrv.close)
  const libPort = libSrv.port
  log('library control API on 127.0.0.1:' + libPort)

  // ===== MCP config (points at all four loopback APIs; ssh via the fake binary) =====
  const cfgPath = path.join(dirs.mcp, 'config.json')
  fs.writeFileSync(cfgPath, JSON.stringify({
    dataDir: path.join(dirs.mcp, 'state'),
    docsDir: path.join(REPO, 'docs'),
    panel: { url: `http://127.0.0.1:${panelPort}`, user: PANEL_ADMIN.user, pass: PANEL_ADMIN.pass },
    broadcaster: { url: `http://127.0.0.1:${bcPort}`, user: BC_ADMIN.user, pass: BC_ADMIN.pass },
    reseller: { url: `http://127.0.0.1:${rslPort}`, user: RSL_ROOT.user, pass: RSL_ROOT.pass },
    library: { url: `http://127.0.0.1:${libPort}`, user: LIB_ADMIN.user, pass: LIB_ADMIN.pass },
    ssh: {
      host: 'box.example',
      user: 'root',
      keyPath: FAKE_SSH,
      sshBin: [process.execPath, FAKE_SSH],
      // The second fake box (section W): same stub, own state/log via argv — the
      // extended seam. repoDir differs deliberately so repoDirFor is exercised.
      hosts: {
        edge: { host: 'edge.example', user: 'root', repoDir: '/opt/edge', sshBin: [process.execPath, FAKE_SSH, '--state', FAKE_STATE2, '--log', FAKE_CMDLOG2] }
      }
    },
    install: { repoDir: '/opt/aliran', composeProfiles: [] }
  }, null, 2), { mode: 0o600 })

  // ===== Launch the MCP server over stdio and connect as an MCP client =====
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_ENTRY, '--config', cfgPath], cwd: REPO, env: process.env, stderr: 'inherit' })
  const client = new Client({ name: 'e2e-mcp-test', version: '0.0.1' })
  cleanups.push(() => client.close())
  await client.connect(transport)
  log('MCP client connected to the server over stdio')

  // The two version surfaces an operator ever sees — the handshake a client shows and
  // the `--version` flag — must both report what npm published this package as. They
  // drifted once (a hardcoded 0.0.1 against a shipped 0.1.0), which quietly misled
  // every "what version are you running?" support question.
  const mcpPkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'mcp', 'package.json'), 'utf8')).version
  const serverInfo = client.getServerVersion() || {}
  assert.strictEqual(serverInfo.name, 'aliran-mcp', 'handshake reports the server name')
  assert.strictEqual(serverInfo.version, mcpPkgVersion, `handshake version ${serverInfo.version} != mcp/package.json ${mcpPkgVersion}`)
  const verCli = await runCli([MCP_ENTRY, '--version'])
  assert.strictEqual(verCli.status, 0, '--version exits 0')
  assert.strictEqual(verCli.stderr.trim(), mcpPkgVersion, `--version printed ${verCli.stderr.trim()}, expected ${mcpPkgVersion}`)
  log(`handshake + --version both report mcp/package.json's ${mcpPkgVersion} ✓`)

  // ===== A: list_tools / list_resources shape + the tool groups are present =====
  const toolsList = await client.listTools()
  const toolNames = new Set(toolsList.tools.map((t) => t.name))
  for (const must of ['panel_status', 'panel_create_user', 'panel_delete_stream', 'panel_add_package', 'panel_set_user_packages',
    'panel_analytics', 'panel_list_admins', 'panel_add_admin', 'panel_remove_admin', 'panel_set_admin_password',
    'panel_set_category', 'panel_rename_category', 'panel_merge_categories', 'panel_delete_category',
    'panel_source_channels', 'panel_set_stream_art',
    'panel_vod_config', 'panel_set_vod_config',
    'panel_list_reports', 'panel_list_alerts', 'panel_ack_report', 'panel_resolve_report', 'panel_test_notify',
    'broadcaster_list_channels', 'broadcaster_add_channel', 'broadcaster_incidents',
    'broadcaster_analytics', 'broadcaster_list_admins', 'broadcaster_add_admin', 'broadcaster_remove_admin', 'broadcaster_set_admin_password',
    'reseller_status', 'reseller_system', 'reseller_list_principals', 'reseller_get_principal', 'reseller_add_principal',
    'reseller_set_principal_password', 'reseller_set_principal_status', 'reseller_set_principal_limits',
    'reseller_grant_credits', 'reseller_ledger', 'reseller_list_accounts', 'reseller_get_account', 'reseller_trials', 'reseller_ops_status',
    'library_status', 'library_list_titles', 'library_get_title', 'library_add_title', 'library_set_title',
    'library_reingest_title', 'library_title_logs', 'library_delete_title',
    'server_preflight', 'server_install', 'server_update', 'server_set_env', 'server_restart', 'server_list_backups', 'server_restore',
    'repeater_status',
    'diagnose_healthz', 'diagnose_symptom', 'docs_search']) {
    assert.ok(toolNames.has(must), 'tools/list missing ' + must)
  }
  assert.ok(toolsList.tools.length >= 107, 'expected a broad tool catalog (S53a: 109), got ' + toolsList.tools.length)
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
  for (const name of ['panel_delete_stream', 'panel_delete_user', 'panel_revoke_grant', 'panel_delete_package', 'broadcaster_remove_channel', 'broadcaster_stop_channel', 'server_update',
    'server_set_env', 'server_restart', 'server_restore', 'panel_remove_admin', 'broadcaster_remove_admin',
    'panel_merge_categories', 'panel_delete_category', 'reseller_set_principal_status', 'library_reingest_title', 'library_delete_title']) {
    assert.strictEqual(byName[name].annotations && byName[name].annotations.destructiveHint, true, name + ' must carry destructiveHint')
  }
  for (const name of ['panel_status', 'panel_list_users', 'panel_list_streams', 'broadcaster_list_channels', 'docs_search', 'diagnose_healthz', 'server_preflight',
    'panel_analytics', 'broadcaster_analytics', 'panel_list_admins', 'broadcaster_list_admins', 'server_list_backups', 'repeater_status',
    'panel_source_channels', 'panel_list_reports', 'panel_list_alerts',
    'reseller_status', 'reseller_system', 'reseller_list_principals', 'reseller_get_principal', 'reseller_ledger',
    'reseller_list_accounts', 'reseller_get_account', 'reseller_trials', 'reseller_ops_status',
    'library_status', 'library_list_titles', 'library_get_title', 'library_title_logs']) {
    assert.strictEqual(byName[name].annotations && byName[name].annotations.readOnlyHint, true, name + ' must carry readOnlyHint')
  }
  // create/mutate tools must NOT be flagged destructive (clients would over-confirm)
  assert.ok(!(byName.panel_create_user.annotations && byName.panel_create_user.annotations.destructiveHint), 'create_user is not destructive')
  assert.ok(!(byName.panel_add_admin.annotations && byName.panel_add_admin.annotations.destructiveHint), 'add_admin is not destructive')
  for (const name of ['panel_set_category', 'panel_rename_category', 'panel_set_stream_art', 'reseller_add_principal', 'reseller_grant_credits', 'library_add_title', 'library_set_title',
    'panel_ack_report', 'panel_resolve_report', 'panel_test_notify']) {
    assert.ok(!(byName[name].annotations && byName[name].annotations.destructiveHint), name + ' is not destructive')
  }
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
    'ssh host "edge": connected to root@edge.example',
    'panel: /healthz answered',
    'panel: credentials accepted',
    'broadcaster: /healthz answered',
    'broadcaster: credentials accepted',
    'reseller: /healthz answered',
    'reseller: credentials accepted',
    'library: /healthz answered',
    'library: credentials accepted',
    'documents indexed',
    'Enabled tool groups: panel_*  broadcaster_*  reseller_*  library_*  server_*  repeater_*  diagnose_*  docs_search',
    'guided runbooks (new-site-install, onboard-a-reseller, migrate-a-channel-source, monthly-maintenance, incident-triage, expose-dashboards)',
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
  assert.ok(!dr.stdout.includes(PANEL_ADMIN.pass) && !dr.stdout.includes(BC_ADMIN.pass) && !dr.stdout.includes(RSL_ROOT.pass) && !dr.stdout.includes(LIB_ADMIN.pass), 'doctor never prints a password')

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

  // ===== K: analytics passthroughs (S49a / G3) =====
  // Without an analytics module both services answer the honest empty shape; with
  // one attached the tools must pass `days` through untouched. The fakes only echo
  // — the rollup math itself is test:analytics's job.
  const emptyShape = await callJson(client, 'panel_analytics')
  assert.strictEqual(emptyShape.enabled, false, 'no analytics module -> honest empty shape (enabled:false)')
  assert.deepStrictEqual(emptyShape.days, [], 'empty shape has days:[]')
  ctx.analytics = { api: (days) => ({ enabled: true, retentionDays: 90, requestedDays: days, days: [], current: null }) }
  bcCtx.analytics = { api: (days) => ({ enabled: true, retentionDays: 90, requestedDays: days, days: [], current: null }) }
  assert.strictEqual((await callJson(client, 'panel_analytics', { days: 3 })).requestedDays, 3, 'panel_analytics forwards days=3')
  assert.strictEqual((await callJson(client, 'panel_analytics')).requestedDays, 7, 'panel_analytics default lands on the route default (7)')
  assert.strictEqual((await callJson(client, 'broadcaster_analytics', { days: 2 })).requestedDays, 2, 'broadcaster_analytics forwards days=2')
  // Schema-level rejection may surface as a protocol error (SDK InvalidParams) or
  // an isError result depending on the SDK — either way it must not go through.
  let daysRejected = false
  try { const r = await callRaw(client, 'panel_analytics', { days: 0 }); daysRejected = !!r.isError } catch { daysRejected = true }
  assert.ok(daysRejected, 'days:0 is rejected by the schema (min 1)')
  log('K: analytics passthroughs — empty shape without a module, days forwarded with one ✓')

  // ===== L: dashboard-admin CRUD on both services (S49a / G4) =====
  // Proves the generated password actually WORKS (a real /api/login with it), the
  // rotation kills the old password, and remove revokes login entirely.
  const apiLogin = async (port, username, password) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
    try { await r.json() } catch {}
    return r.status
  }
  for (const [label, listTool, addTool, pwTool, rmTool, port, seedAdmin] of [
    ['panel', 'panel_list_admins', 'panel_add_admin', 'panel_set_admin_password', 'panel_remove_admin', panelPort, PANEL_ADMIN.user],
    ['broadcaster', 'broadcaster_list_admins', 'broadcaster_add_admin', 'broadcaster_set_admin_password', 'broadcaster_remove_admin', bcPort, BC_ADMIN.user]
  ]) {
    const seedList = await callJson(client, listTool)
    assert.ok(seedList.some((a) => a.name === seedAdmin), `${listTool} shows the seed admin`)
    assert.ok(!JSON.stringify(seedList).includes('verifier') && !JSON.stringify(seedList).includes('salt'), `${listTool} never leaks password material`)
    const added = await callJson(client, addTool, { username: 'mcpadmin2' })
    assert.ok(added.generatedPassword && added.generatedPassword.length >= 16, `${addTool} generates + returns a password when omitted`)
    assert.ok((await callJson(client, listTool)).some((a) => a.name === 'mcpadmin2'), `${addTool} shows up in the list`)
    assert.strictEqual(await apiLogin(port, 'mcpadmin2', added.generatedPassword), 200, `${label}: the generated password actually logs in`)
    const rotated = await callJson(client, pwTool, { username: 'mcpadmin2' })
    assert.ok(rotated.generatedPassword && rotated.tokenVersion >= 2, `${pwTool} rotates + bumps tokenVersion`)
    assert.strictEqual(await apiLogin(port, 'mcpadmin2', added.generatedPassword), 401, `${label}: the OLD password is dead after rotation`)
    assert.strictEqual(await apiLogin(port, 'mcpadmin2', rotated.generatedPassword), 200, `${label}: the NEW password logs in`)
    const removed = await callJson(client, rmTool, { username: 'mcpadmin2' })
    assert.strictEqual(removed.removed, true, `${rmTool} reports removal`)
    assert.ok(!(await callJson(client, listTool)).some((a) => a.name === 'mcpadmin2'), `${rmTool} really removed it`)
    assert.strictEqual(await apiLogin(port, 'mcpadmin2', rotated.generatedPassword), 401, `${label}: a removed admin cannot log in`)
  }
  // The self-lockout caveat must be spelled out where the client reads it.
  for (const name of ['panel_set_admin_password', 'broadcaster_set_admin_password', 'panel_remove_admin', 'broadcaster_remove_admin']) {
    assert.ok(byName[name].description.includes('mcp') || byName[name].description.includes('MCP'), name + ' description warns about the MCP\'s own login')
  }
  assert.ok(byName.panel_set_admin_password.description.includes('mcp/config.json'), 'rotation caveat names the operator\'s local mcp config')
  log('L: admins CRUD ×2 services — generated passwords live-verified, rotation kills the old one, remove revokes login ✓')

  // ===== M: server_set_env happy paths (S49a / G1) =====
  // Through the ssh stub: snapshot -> upsert -> REAL config.js --check in the
  // "image" -> apply via plain `docker compose up -d <svc>` (compose restart does
  // NOT re-read env files — asserted below on the command log).
  const readState = () => JSON.parse(fs.readFileSync(FAKE_STATE, 'utf8'))
  const readCmdLog = () => fs.readFileSync(FAKE_CMDLOG, 'utf8')
  const setOk = await callJson(client, 'server_set_env', { service: 'panel', pairs: { MAX_DEVICES_DEFAULT: 5, SESSION_TTL_DAYS: 45 } })
  assert.deepStrictEqual(setOk.set, { MAX_DEVICES_DEFAULT: '5', SESSION_TTL_DAYS: '45' }, 'set_env echoes the written knobs')
  assert.match(setOk.validation, /passed/, 'set_env reports the in-image validation')
  assert.match(setOk.applied, /up -d panel/, 'set_env applies via docker compose up -d (the recreate that re-reads env)')
  let panelEnv = readState()['/opt/aliran/panel/.env']
  assert.ok(panelEnv.includes('MAX_DEVICES_DEFAULT=5') && panelEnv.includes('SESSION_TTL_DAYS=45'), 'the fake box .env holds the new knobs')
  assert.ok(readCmdLog().includes("run --rm 'panel' node src/config.js --check"), 'check-config ran in the built image BEFORE the restart')
  // Upsert semantics: setting the same key again replaces the line, not appends.
  await callJson(client, 'server_set_env', { service: 'panel', pairs: { MAX_DEVICES_DEFAULT: 6 } })
  panelEnv = readState()['/opt/aliran/panel/.env']
  assert.strictEqual(panelEnv.split('\n').filter((l) => l.startsWith('MAX_DEVICES_DEFAULT=')).length, 1, 'upsert replaces the existing line')
  assert.ok(panelEnv.includes('MAX_DEVICES_DEFAULT=6') && panelEnv.includes('SESSION_TTL_DAYS=45'), 'other keys survive an upsert')
  // apply:false stages without the recreate.
  const staged = await callJson(client, 'server_set_env', { service: 'broadcaster', pairs: { HLS_LIST_SIZE: 12 }, apply: false })
  assert.match(staged.applied, /NOT applied/, 'apply:false stages the change')
  assert.ok(!readCmdLog().includes("up -d 'broadcaster'"), 'apply:false never recreated the broadcaster')
  // First-ever .env (absent file): no snapshot, still validated, still applied.
  const fresh = await callJson(client, 'server_set_env', { service: 'reseller', pairs: { DAYS_PER_MONTH: 30 } })
  assert.match(fresh.validation, /passed/, 'set_env works when the .env does not exist yet')
  assert.ok(readState()['/opt/aliran/reseller/.env'].includes('DAYS_PER_MONTH=30'), 'the fresh .env was created')
  log('M: server_set_env — validated in-image, applied via up -d, upsert replaces, apply:false stages, absent .env created ✓')

  // ===== N: server_set_env refusals + the check-config-failure REVERT path =====
  const secretTry = await callRaw(client, 'server_set_env', { service: 'panel', pairs: { PUBLISHER_KEY: 'feed'.repeat(32) } })
  assert.ok(secretTry.isError, 'PUBLISHER_KEY must be refused')
  assert.match(secretTry.content[0].text, /refusing to set PUBLISHER_KEY/, 'refusal names the key')
  assert.match(secretTry.content[0].text, /panel_add_publisher/, 'refusal points at the dedicated flow')
  const unknownTry = await callRaw(client, 'server_set_env', { service: 'panel', pairs: { TYPO_KNOB: '1' } })
  assert.ok(unknownTry.isError && /not a documented panel knob/.test(unknownTry.content[0].text), 'unknown keys are refused with the allowlist')
  assert.ok(unknownTry.content[0].text.includes('MAX_DEVICES_DEFAULT'), 'the refusal lists the settable keys')
  // The flagship failure: a typo'd VALUE. The stub runs the REAL panel config.js
  // --check, so this asserts the true problem text surfaces and the .env reverts.
  const beforeBad = readState()['/opt/aliran/panel/.env']
  const upCountBefore = readCmdLog().split("up -d 'panel'").length
  const badVal = await callRaw(client, 'server_set_env', { service: 'panel', pairs: { POW_DIFFICULTY: 'notanumber' } })
  assert.ok(badVal.isError, 'a value the service would refuse at boot must be rejected')
  assert.match(badVal.content[0].text, /REVERTED/, 'the tool says the .env was reverted')
  assert.match(badVal.content[0].text, /POW_DIFFICULTY must be an integer \(got "notanumber"\)/, 'the EXACT config.js problem text surfaces')
  assert.strictEqual(readState()['/opt/aliran/panel/.env'], beforeBad, 'the .env is byte-identical after the revert')
  assert.ok(readCmdLog().includes("mv '/opt/aliran/panel/.env.mcp-prev' '/opt/aliran/panel/.env'"), 'the snapshot was moved back')
  assert.strictEqual(readCmdLog().split("up -d 'panel'").length, upCountBefore, 'nothing was applied on the failed set')
  // Absent-file failure: the revert removes the file it created.
  const badFresh = await callRaw(client, 'server_set_env', { service: 'library', pairs: { INGEST_CONCURRENCY: 0 } })
  assert.ok(badFresh.isError && /INGEST_CONCURRENCY must be >= 1/.test(badFresh.content[0].text), 'library bad value rejected with the real problem text')
  assert.strictEqual(readState()['/opt/aliran/library/.env'], undefined, 'the created .env was removed on revert (file was absent before)')
  // Injection guard: a newline in a value could smuggle a secret line past the allowlist.
  const inject = await callRaw(client, 'server_set_env', { service: 'panel', pairs: { SESSION_TTL_DAYS: '30\nPUBLISHER_KEY=evil' } })
  assert.ok(inject.isError && /single line/.test(inject.content[0].text), 'multi-line values are rejected')
  assert.ok(!JSON.stringify(readState()).includes('PUBLISHER_KEY=evil'), 'the smuggled line never reached any .env')
  log('N: server_set_env refusals — secrets/unknown keys client-side, bad values REVERTED with the real check-config text, newline injection blocked ✓')

  // ===== O: server_restart (S49a / G1) =====
  const restarted = await callJson(client, 'server_restart', { services: ['broadcaster'] })
  assert.deepStrictEqual(restarted.restarted, ['broadcaster'], 'restart echoes the service list')
  assert.ok(readCmdLog().includes("docker compose restart 'broadcaster'"), 'compose restart with the named service')
  const restartAll = await callJson(client, 'server_restart')
  assert.strictEqual(restartAll.restarted, 'all services', 'no-arg restart = all services')
  assert.ok(byName.server_restart.description.includes('does NOT apply .env'), 'server_restart is honest that restart does not re-read env files')
  log('O: server_restart — named + all-services restarts through compose restart ✓')

  // ===== P: backups — list + restore + the refusal path (S49a / G2) =====
  const backups = await callJson(client, 'server_list_backups')
  assert.match(backups.backups, /panel-20260724-070000\.tar\.gz/, 'server_list_backups lists the archives')
  const restored = await callJson(client, 'server_restore', { service: 'panel', archive: 'backups/panel-20260724-070000.tar.gz' })
  assert.match(restored.result, /== done: restored aliran_panel-data from panel-20260724-070000\.tar\.gz/, 'restore states exactly what was overwritten and from which archive')
  const refused = await callRaw(client, 'server_restore', { service: 'panel', archive: 'backups/panel-nonempty-20260101-000000.tar.gz' })
  assert.ok(refused.isError, 'restore onto a non-empty volume without force must fail')
  assert.match(refused.content[0].text, /NOT empty/, 'the refusal explains the volume is not empty')
  assert.match(refused.content[0].text, /--force/, 'the refusal names the way through')
  const forced = await callJson(client, 'server_restore', { service: 'panel', archive: 'backups/panel-nonempty-20260101-000000.tar.gz', force: true })
  assert.match(forced.result, /== done: restored/, 'force:true goes through')
  assert.ok(readCmdLog().includes("restore.sh --force 'panel'"), 'force maps to the script\'s --force flag')
  // The standing §3B rule, asserted over EVERYTHING this test ran on the box:
  assert.ok(!readCmdLog().includes('--force-recreate'), 'NO tool ever used docker compose --force-recreate')
  log('P: backups — list, restore with exact overwrite echo, refusal without force, no --force-recreate anywhere ✓')

  // ===== Q: categories (S49b / G5) =====
  // The registry owns PRESENTATION; membership lives on the catalog records — and
  // rename/merge are the tools that move membership. The package-selector coupling
  // is asserted honestly: a category: member is a STRING, so a rename strips the
  // bouquet's holders until the member is updated to the new slug.
  const upserted = await callJson(client, 'panel_set_category', { slug: 'MCPBundle', label: 'MCP Bundle', order: 5 })
  assert.strictEqual(upserted.label, 'MCP Bundle', 'upsert sets the label')
  assert.strictEqual(upserted.order, 5, 'upsert sets the order')
  let cats = await callJson(client, 'panel_list_categories')
  let entry = cats.find((c) => c.slug === 'MCPBundle')
  assert.ok(entry && entry.registered && entry.channels === 2 && entry.label === 'MCP Bundle', 'registered entry carries label/order and counts the 2 channels')
  const hid = await callJson(client, 'panel_set_category', { slug: 'MCPBundle', hidden: true })
  assert.strictEqual(hid.hidden, true, 'hidden flag set')
  assert.strictEqual(hid.label, 'MCP Bundle', 'upsert keeps the untouched fields')

  const renamed = await callJson(client, 'panel_rename_category', { from: 'MCPBundle', to: 'MCPRail' })
  assert.strictEqual(renamed.channels, 2, 'rename rewrote both channel records')
  assert.strictEqual(renamed.registry, 1, 'rename carried the registry entry')
  cats = await callJson(client, 'panel_list_categories')
  assert.ok(!cats.find((c) => c.slug === 'MCPBundle'), 'the old slug is gone')
  entry = cats.find((c) => c.slug === 'MCPRail')
  assert.ok(entry && entry.registered && entry.channels === 2, 'the new slug owns the channels')
  assert.strictEqual(entry.label, 'MCP Bundle', 'a hand-written label survives the rename')
  const streamsAfterRename = await callJson(client, 'panel_list_streams')
  assert.deepStrictEqual(streamsAfterRename.find((s) => s.id === 'mcp-a').category, ['MCPRail'], 'the channel record itself was retagged')
  // The honest selector consequence: mcp-pack's member is still the STRING
  // 'category:MCPBundle', which now matches nothing — the holder lost the grants.
  let viewer = await callJson(client, 'panel_get_user', { username: 'mcpviewer' })
  assert.ok(!viewer.grants.includes('mcp-a') && !viewer.grants.includes('mcp-b'), 'a category: selector naming the OLD slug loses its channels (documented in the tool description)')
  await callJson(client, 'panel_set_package', { name: 'mcp-pack', members: ['category:MCPRail'] })
  viewer = await callJson(client, 'panel_get_user', { username: 'mcpviewer' })
  assert.ok(viewer.grants.includes('mcp-a') && viewer.grants.includes('mcp-b'), 'updating the member to the new slug re-materializes the grants')

  await callJson(client, 'panel_add_stream', { id: 'mcp-c', category: 'MCPExtra' })
  const merged = await callJson(client, 'panel_merge_categories', { from: ['MCPExtra'], to: 'MCPRail' })
  assert.strictEqual(merged.channels, 1, 'merge retagged the MCPExtra channel')
  cats = await callJson(client, 'panel_list_categories')
  assert.ok(!cats.find((c) => c.slug === 'MCPExtra'), 'merged-away slug is gone from the vocabulary')
  assert.strictEqual(cats.find((c) => c.slug === 'MCPRail').channels, 3, 'target category owns all three channels')
  viewer = await callJson(client, 'panel_get_user', { username: 'mcpviewer' })
  assert.ok(viewer.grants.includes('mcp-c'), 'the merge reconcile entitled the package holder to the retagged channel')

  const catDeleted = await callJson(client, 'panel_delete_category', { slug: 'MCPRail' })
  assert.strictEqual(catDeleted.deleted, true, 'registry entry deleted')
  cats = await callJson(client, 'panel_list_categories')
  entry = cats.find((c) => c.slug === 'MCPRail')
  assert.ok(entry && entry.registered === false && entry.channels === 3, 'delete drops ONLY the registry entry — membership (3 channels) is kept and the slug still lists as unregistered')
  log('Q: categories — upsert/list, rename rewrites catalog + honest selector coupling, merge retags + entitles, delete keeps membership ✓')

  // ===== R: source curation (S49b / G6) =====
  const src = await callJson(client, 'panel_add_source', { name: 'mcpsrc', url: 'https://feeds.example/mcp.json', category: 'MCP Imports' })
  assert.deepStrictEqual(src.exclude, [], 'a new source starts with no exclusions')
  // Seed a fake ETag directly in the registry file (the panel's own dataDir) so the
  // exclusion-change reset is observable without running a real feed sync.
  const sourcesFile = path.join(dirs.panel, 'sources.json')
  let reg = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'))
  reg.mcpsrc.etag = 'W/"seeded"'
  fs.writeFileSync(sourcesFile, JSON.stringify(reg))
  const excluded = await callJson(client, 'panel_set_source', { name: 'mcpsrc', exclude: [{ id: '42', title: 'Chan 42' }, '43'] })
  assert.deepStrictEqual(excluded.exclude, [{ id: '42', title: 'Chan 42' }, { id: '43', title: '' }], 'exclude accepts {id,title} objects and bare id strings')
  assert.strictEqual(excluded.etag, null, 'an exclusion CHANGE resets the ETag so the next sync re-pulls the full body (S27b)')
  // Same ids again → no exclusion change → a live ETag must survive (no gratuitous refetch).
  reg = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'))
  reg.mcpsrc.etag = 'W/"seeded2"'
  fs.writeFileSync(sourcesFile, JSON.stringify(reg))
  const sameIds = await callJson(client, 'panel_set_source', { name: 'mcpsrc', exclude: ['42', '43'] })
  assert.strictEqual(sameIds.etag, 'W/"seeded2"', 'an exclude write with the SAME ids keeps the ETag')
  const dialog = await callJson(client, 'panel_source_channels', { name: 'mcpsrc' })
  assert.strictEqual(dialog.name, 'mcpsrc', 'source_channels names the source')
  const exRows = dialog.channels.filter((c) => c.excluded)
  assert.strictEqual(exRows.length, 2, 'both exclusions appear in the channels view')
  assert.ok(exRows.some((c) => c.feedId === '42' && c.id === 'mcpsrc.42'), 'excluded rows carry the feed id and the prefixed catalog id')
  assert.ok(byName.panel_set_source.description.includes('ETag'), 'the ETag-reset behavior is documented on the tool')
  await callJson(client, 'panel_delete_source', { name: 'mcpsrc' })
  log('R: source curation — exclude round-trip (ETag reset on change, kept on no-op), channels view, cleanup ✓')

  // ===== S: stream art (S49b / G7) =====
  // A real (1x1) PNG written to the operator's disk; the MCP reads + posts the raw
  // bytes. The tool RESULT must stay small and byte-free — never base64.
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg=='
  const pngBuf = Buffer.from(PNG_B64, 'base64')
  const pngPath = path.join(dirs.mcp, 'mcp-logo.png')
  fs.writeFileSync(pngPath, pngBuf)
  const art = await callJson(client, 'panel_set_stream_art', { id: 'mcp-a', kind: 'logo', path: pngPath })
  assert.strictEqual(art.logo, 'assets/mcp-a/logo.png', 'the panel stored the asset ref under the stream')
  assert.strictEqual(art.bytes, pngBuf.length, 'the panel received exactly the file bytes')
  assert.strictEqual((await db.get('catalog/mcp-a')).value.logo, 'assets/mcp-a/logo.png', 'the catalog record gained the asset ref')
  const stored = await assets.get('/mcp-a/logo.png')
  assert.ok(stored && Buffer.compare(stored, pngBuf) === 0, 'the assets drive holds the byte-identical image')
  // Content-type comes from the extension: the same bytes as .jpg store as .jpg.
  const jpgPath = path.join(dirs.mcp, 'mcp-poster.jpg')
  fs.writeFileSync(jpgPath, pngBuf)
  const rawArt = await callRaw(client, 'panel_set_stream_art', { id: 'mcp-a', kind: 'poster', path: jpgPath })
  const rawArtText = (rawArt.content && rawArt.content[0] && rawArt.content[0].text) || ''
  assert.ok(!rawArt.isError, 'poster upload succeeds: ' + rawArtText)
  assert.match(rawArtText, /assets\/mcp-a\/poster\.jpg/, 'extension → content-type → stored extension')
  assert.ok(!rawArtText.includes(PNG_B64.slice(0, 24)), 'image bytes never appear in a tool result (no base64)')
  assert.ok(rawArtText.length < 600, 'the art tool result is a small ref echo, not a payload')
  // Client-side refusals: wrong extension, missing file, oversize — none reach the panel.
  const txtPath = path.join(dirs.mcp, 'not-art.txt')
  fs.writeFileSync(txtPath, 'hello')
  const badExt = await callRaw(client, 'panel_set_stream_art', { id: 'mcp-a', kind: 'logo', path: txtPath })
  assert.ok(badExt.isError && /unsupported art file extension/.test(badExt.content[0].text), 'non-image extension refused client-side')
  const missing = await callRaw(client, 'panel_set_stream_art', { id: 'mcp-a', kind: 'logo', path: path.join(dirs.mcp, 'nope.png') })
  assert.ok(missing.isError && /cannot read/.test(missing.content[0].text), 'missing file is a clean error naming the operator machine')
  const bigPath = path.join(dirs.mcp, 'too-big.png')
  fs.writeFileSync(bigPath, Buffer.alloc(10 * 1024 * 1024 + 1))
  const tooBig = await callRaw(client, 'panel_set_stream_art', { id: 'mcp-a', kind: 'logo', path: bigPath })
  assert.ok(tooBig.isError && /10 MiB/.test(tooBig.content[0].text), 'the 10 MiB cap is enforced before any bytes move')
  let kindRejected = false
  try { const r = await callRaw(client, 'panel_set_stream_art', { id: 'mcp-a', kind: 'banner', path: pngPath }); kindRejected = !!r.isError } catch { kindRejected = true }
  assert.ok(kindRejected, 'kind is a strict enum (logo|poster|backdrop)')
  log('S: stream art — PNG from the operator disk to the assets drive byte-identical, refs echoed, cap/extension/missing refusals, no base64 anywhere ✓')

  // ===== T: reseller oversight (S49b / G8) =====
  const rslBase = `http://127.0.0.1:${rslPort}`
  const rApi = async (method, p, body, token) => {
    const res = await fetch(rslBase + p, {
      method,
      headers: { ...(body != null ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body != null ? JSON.stringify(body) : undefined
    })
    let json = null
    try { json = await res.json() } catch {}
    return { status: res.status, body: json }
  }
  const rslStatus = await callJson(client, 'reseller_status')
  assert.strictEqual(rslStatus.name, RSL_ROOT.user, 'status reports the configured principal')
  assert.strictEqual(rslStatus.role, 'admin', 'the MCP login is the root admin')
  assert.ok(Number.isInteger(rslStatus.principals), 'admin view includes the principal count')
  const rslSystem = await callJson(client, 'reseller_system')
  assert.strictEqual(rslSystem.service.node, process.version, 'system view reports the service process')
  assert.ok(rslSystem.panel && rslSystem.panel.stats && rslSystem.panel.stats.streams >= 3, 'system view live-probes the downstream panel')

  const sup = await callJson(client, 'reseller_add_principal', { username: 'mcp-sup', role: 'super' })
  assert.ok(sup.generatedPassword && sup.generatedPassword.length >= 16, 'add_principal generates + returns a password when omitted')
  assert.strictEqual(sup.role, 'super', 'role landed')
  assert.strictEqual(sup.parent, RSL_ROOT.user, 'created under the configured login')
  assert.strictEqual((await rApi('POST', '/api/login', { username: 'mcp-sup', password: sup.generatedPassword })).status, 200, 'the generated principal password actually logs in')
  assert.ok((await callJson(client, 'reseller_list_principals')).some((p) => p.name === 'mcp-sup'), 'new principal shows in the list')
  const supView = await callJson(client, 'reseller_get_principal', { name: 'mcp-sup' })
  assert.strictEqual(supView.balance, 0, 'fresh principal holds no credits')

  const mintOut = await callJson(client, 'reseller_grant_credits', { to: 'mcp-sup', amount: 25, note: 'mcp top-up' })
  assert.strictEqual(mintOut.minted.type, 'MINT', 'mint echoes the ledger line type')
  assert.strictEqual(mintOut.minted.actor, RSL_ROOT.user, 'mint echoes the actor')
  assert.strictEqual(mintOut.minted.principal, 'mcp-sup', 'mint echoes the funded principal')
  assert.strictEqual(mintOut.minted.amount, 25, 'mint echoes the amount')
  assert.strictEqual(mintOut.newBalance, 25, 'mint echoes the new balance')
  assert.ok(Number.isInteger(mintOut.minted.seq), 'mint echoes the ledger seq')
  const ledger = await callJson(client, 'reseller_ledger', { principal: 'mcp-sup' })
  assert.ok(Array.isArray(ledger), 'ledger query returns the line list')
  const mintLine = ledger.find((l) => l.seq === mintOut.minted.seq)
  assert.ok(mintLine && mintLine.type === 'MINT' && mintLine.actor === RSL_ROOT.user, 'the echoed ledger line exists in the ledger itself')
  assert.ok(mintLine.entries.some((e) => e.principal === 'mcp-sup' && e.delta === 25), 'the ledger line carries the credit entry')

  const limited = await callJson(client, 'reseller_set_principal_limits', { name: 'mcp-sup', trialDailyCap: 2 })
  assert.strictEqual(limited.trialDailyCap, 2, 'limits applied')
  const suspended = await callJson(client, 'reseller_set_principal_status', { name: 'mcp-sup', status: 'suspended' })
  assert.strictEqual(suspended.status, 'suspended', 'principal suspended')
  await callJson(client, 'reseller_set_principal_status', { name: 'mcp-sup', status: 'active' })
  const rotatedSup = await callJson(client, 'reseller_set_principal_password', { name: 'mcp-sup' })
  assert.ok(rotatedSup.generatedPassword, 'password rotation returns the new one')
  assert.strictEqual((await rApi('POST', '/api/login', { username: 'mcp-sup', password: sup.generatedPassword })).status, 401, 'the OLD principal password is dead')
  assert.strictEqual((await rApi('POST', '/api/login', { username: 'mcp-sup', password: rotatedSup.generatedPassword })).status, 200, 'the NEW principal password logs in')

  // Accounts + trials are DAILY DRIVING — created here through the reseller's own
  // API (as the operator could in the reseller UI), then OBSERVED through the MCP.
  assert.ok(!toolNames.has('reseller_activate_account') && !toolNames.has('reseller_renew_account'), 'daily-driver actions are deliberately NOT wrapped')
  const boosted = await callJson(client, 'reseller_grant_credits', { amount: 10, note: 'self top-up' })
  assert.strictEqual(boosted.minted.principal, RSL_ROOT.user, 'omitting `to` tops up the configured login')
  const bossTok = (await rApi('POST', '/api/login', { username: RSL_ROOT.user, password: RSL_ROOT.pass })).body.token
  const activated = await rApi('POST', '/api/accounts', { name: 'mcp-acct', password: 'acct-pass-999', months: 1 }, bossTok)
  assert.strictEqual(activated.status, 201, 'account activated via the reseller API: ' + JSON.stringify(activated.body))
  const trialMade = await rApi('POST', '/api/trials', { name: 'mcp-trial', password: 'trial-pass-999' }, bossTok)
  assert.strictEqual(trialMade.status, 201, 'trial created via the reseller API: ' + JSON.stringify(trialMade.body))
  const acctList = await callJson(client, 'reseller_list_accounts', {})
  assert.ok(acctList.items.some((a) => a.account === 'mcp-acct'), 'accounts view lists the activation')
  assert.ok(acctList.total >= 2, 'total counts both records')
  const acct = await callJson(client, 'reseller_get_account', { account: 'mcp-acct' })
  assert.strictEqual(acct.owner, RSL_ROOT.user, 'account view names the owner')
  assert.ok(acct.live && acct.live.status === 'active', 'account view carries the LIVE panel state')
  const trials = await callJson(client, 'reseller_trials', {})
  assert.ok(trials.items.some((a) => a.account === 'mcp-trial' && a.kind === 'trial'), 'trials view shows the trial')
  assert.ok(!trials.items.some((a) => a.account === 'mcp-acct'), 'trials view filters out paid accounts')

  const opsNever = await callJson(client, 'reseller_ops_status')
  assert.strictEqual(opsNever.never, true, 'no sweep ran yet (noSweeps harness) — the honest {never:true}')
  assert.strictEqual((await rApi('POST', '/api/ops/reconcile', {}, bossTok)).status, 200, 'reconcile runs on demand')
  const opsAfter = await callJson(client, 'reseller_ops_status')
  assert.ok(opsAfter.never !== true, 'ops status reports the reconcile that just ran')
  for (const [name, needle] of [['reseller_set_principal_password', 'mcp/config.json'], ['reseller_trials', 'reseller panel'], ['reseller_grant_credits', 'ledger']]) {
    assert.ok(byName[name].description.includes(needle), `${name} description must mention "${needle}"`)
  }
  log('T: reseller oversight — status/system, principal lifecycle w/ live-verified passwords, mint echoing the real ledger line, accounts/trials views, ops status; daily driving stays unwrapped ✓')

  // ===== U: library (S49b / G9) =====
  const libStatus0 = await callJson(client, 'library_status')
  assert.strictEqual(libStatus0.titles, 0, 'empty library')
  const added = await callJson(client, 'library_add_title', { id: 'mcp-movie', input: '/media/mcp-movie.mkv', title: 'MCP Movie', category: 'Cine' })
  assert.strictEqual(added.state, 'queued', 'add queues the one-shot ingest')
  assert.strictEqual(added.input, '/media/mcp-movie.mkv', 'the box-side input path is stored as sent')
  const delWhileQueued = await callRaw(client, 'library_delete_title', { id: 'mcp-movie' })
  assert.ok(delWhileQueued.isError && /wait for the ingest to finish/.test(delWhileQueued.content[0].text), 'delete is refused mid-ingest')
  fakeLib.setState('mcp-movie', 'ready')
  const got = await callJson(client, 'library_get_title', { id: 'mcp-movie' })
  assert.strictEqual(got.state, 'ready', 'get reflects the ingest completing')
  assert.strictEqual((await callJson(client, 'library_list_titles')).length, 1, 'list shows the title')
  const patched2 = await callJson(client, 'library_set_title', { id: 'mcp-movie', mode: 'copy', hlsTime: 6 })
  assert.strictEqual(patched2.mode, 'copy', 'operational patch applied (mode)')
  assert.strictEqual(patched2.hlsTime, 6, 'operational patch applied (hlsTime)')
  const reing = await callJson(client, 'library_reingest_title', { id: 'mcp-movie', input: '/media/mcp-movie-v2.mkv' })
  assert.strictEqual(reing.state, 'queued', 'reingest queues the next generation')
  assert.strictEqual(reing.gen, 1, 'the feed generation advanced')
  assert.strictEqual(reing.input, '/media/mcp-movie-v2.mkv', 'reingest can repoint the input')
  const reingBusy = await callRaw(client, 'library_reingest_title', { id: 'mcp-movie' })
  assert.ok(reingBusy.isError && /already queued/.test(reingBusy.content[0].text), 'a second reingest while queued is refused')
  fakeLib.setState('mcp-movie', 'ready')
  const libLogs = await callJson(client, 'library_title_logs', { id: 'mcp-movie', lines: 10 })
  assert.ok(Array.isArray(libLogs.lines) && libLogs.lines.some((l) => /reingest gen 1/.test(l)), 'the ingest log ring is readable')
  assert.strictEqual(libLogs.state, 'ready', 'logs carry the current state')
  const gone = await callJson(client, 'library_delete_title', { id: 'mcp-movie' })
  assert.strictEqual(gone.removed, true, 'delete removed the library-side title')
  assert.ok(/unavailable/.test(gone.panelRecord) && /panel_delete_stream/.test(gone.panelRecord), 'delete echoes the panel-record disposition: marked unavailable, purge is a panel job')
  assert.deepStrictEqual(await callJson(client, 'library_list_titles'), [], 'library empty again')
  assert.ok(byName.library_set_title.description.includes('panel_set_stream_meta'), 'the panel-owned-metadata boundary is documented on the tool')
  assert.ok(/LIBRARY box/i.test(byName.library_add_title.description), 'add_title says the input path lives on the library box')
  log('U: library — add/refuse-delete-mid-ingest/get/list, operational patch, reingest + generation bump, logs, delete with the panel-record echo ✓')

  // ===== V: the diagnose sweep covers all four services =====
  const sweep = (await callJson(client, 'diagnose_healthz')).sweep
  assert.strictEqual(sweep.panel.reachable, true, 'sweep: panel up')
  assert.strictEqual(sweep.broadcaster.reachable, true, 'sweep: broadcaster up')
  assert.ok(sweep.reseller.reachable === true && sweep.reseller.health.ok === true, 'sweep: reseller up with vitals')
  assert.ok(sweep.library.reachable === true && sweep.library.health.up === true, 'sweep: library up with vitals')
  log('V: diagnose_healthz sweeps panel + broadcaster + reseller + library ✓')

  // ===== W: multi-host SSH (S49c / G10) =====
  // The second fake box rides the SAME stub script with its own state + command
  // log, selected by the sshBin argv (--state/--log) — the seam extended, not
  // forked. `host:"edge"` must route commands (and repoDir) to that box while the
  // default-host behavior stays byte-identical.
  const readCmdLog2 = () => fs.existsSync(FAKE_CMDLOG2) ? fs.readFileSync(FAKE_CMDLOG2, 'utf8') : ''
  const readState2 = () => fs.existsSync(FAKE_STATE2) ? JSON.parse(fs.readFileSync(FAKE_STATE2, 'utf8')) : {}
  const log1Before = readCmdLog().split('\n').length
  const edgeStatus = await callJson(client, 'server_status', { host: 'edge' })
  assert.strictEqual(edgeStatus.host, 'edge.example', 'a named host reports ITS address, not the default box')
  assert.ok(readCmdLog2().includes("cd '/opt/edge' &&"), 'edge commands run in the edge box\'s own repoDir (per-host repoDir override)')
  assert.strictEqual(readCmdLog().split('\n').length, log1Before, 'the edge call left the default box\'s command log untouched')
  const unknownHost = await callRaw(client, 'server_status', { host: 'nope' })
  assert.ok(unknownHost.isError, 'an unknown host name is a loud error')
  assert.match(unknownHost.content[0].text, /unknown ssh host "nope"/, 'the error names the bad host')
  assert.match(unknownHost.content[0].text, /edge/, 'the error lists the configured names')
  // set_env against the named box: full snapshot→check→apply flow on ITS state.
  const edgeSet = await callJson(client, 'server_set_env', { service: 'panel', host: 'edge', pairs: { MAX_DEVICES_DEFAULT: 9 } })
  assert.strictEqual(edgeSet.host, 'edge.example', 'set_env reports the edge box')
  assert.ok(readState2()['/opt/edge/panel/.env'].includes('MAX_DEVICES_DEFAULT=9'), 'the edge box .env got the knob (its own state file)')
  assert.ok(!readState()['/opt/aliran/panel/.env'].includes('MAX_DEVICES_DEFAULT=9'), 'the DEFAULT box .env did not change')
  assert.ok(readCmdLog2().includes("run --rm 'panel' node src/config.js --check"), 'the in-image check ran on the edge box')
  // The G10 headline: enrolling a publisher for a NAMED box writes THAT box's
  // broadcaster/.env — and the secret still never reaches the model.
  const edgePub = await callJson(client, 'panel_add_publisher', { name: 'edge-pub', scopes: ['edge-*'], host: 'edge' })
  const edgeBcEnv = readState2()['/opt/edge/broadcaster/.env'] || ''
  assert.ok(edgeBcEnv.includes('PUBLISHER_NAME=edge-pub'), 'the edge box broadcaster/.env names the publisher')
  const edgeKeyM = edgeBcEnv.match(/PUBLISHER_KEY=([0-9a-f]{128})/)
  assert.ok(edgeKeyM, 'the publisher SECRET landed in the edge box .env')
  assert.ok(!JSON.stringify(edgePub).includes(edgeKeyM[1]), 'the publisher SECRET is absent from the tool result')
  assert.match(edgePub.secretDisposition, /\/opt\/edge\/broadcaster\/\.env on edge\.example/, 'the disposition names the edge box + path')
  assert.ok(!(readState()['/opt/aliran/broadcaster/.env'] || '').includes('edge-pub'), 'the default box .env was not touched by the edge enrollment')
  const badHostPub = await callRaw(client, 'panel_add_publisher', { name: 'stray-pub', host: 'nope' })
  assert.ok(badHostPub.isError && /unknown ssh host/.test(badHostPub.content[0].text), 'an unknown host fails the enrollment BEFORE a secret is minted')
  assert.ok(!(await callJson(client, 'panel_list_publishers')).some((p) => p.name === 'stray-pub'), 'nothing was enrolled on the failed-host call')
  log('W: multi-host — edge box commands/env/repoDir isolated, unknown host loud, add_publisher {host} lands the key on the RIGHT box (secret still server-side) ✓')

  // ===== X: repeater_status (S49c / G10) =====
  // The repeater has NO admin API by design — status is SSH-shaped, and the
  // opt-in status server is reported honestly in all three states.
  const writeStateFile = (file, mut) => { const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; mut(s); fs.writeFileSync(file, JSON.stringify(s, null, 1)) }
  const repOff = await callJson(client, 'repeater_status')
  assert.strictEqual(repOff.host, 'box.example', 'default host answers')
  assert.match(repOff.compose, /repeater-repeater-1/, 'compose ps rode the repeater compose file')
  assert.match(repOff.statusServer, /not enabled/, 'no STATUS_PORT -> the honest disabled note, not an error')
  assert.match(repOff.statusServer, /ZERO listening sockets/, 'the note explains the zero-sockets default')
  assert.ok(!repOff.metrics, 'no metrics block when the status server is off')
  assert.match(repOff.logs, /mirroring 12 channels/, 'the logs tail came back')
  // Configured but dead: STATUS_PORT set, nothing answering (the stub 22s non-9600).
  writeStateFile(FAKE_STATE, (s) => { s['/opt/aliran/repeater/.env'] = 'PANEL_PUBKEY=' + 'a'.repeat(64) + '\nSTATUS_PORT=9700\n' })
  const repDead = await callJson(client, 'repeater_status')
  assert.match(repDead.statusServer, /configured \(STATUS_PORT=9700\) but \/metrics did not answer/, 'a dead status server is reported as configured-but-unanswering')
  // Enabled and answering on the edge box (9600 in ITS state file).
  writeStateFile(FAKE_STATE2, (s) => { s['/opt/edge/repeater/.env'] = 'PANEL_PUBKEY=' + 'a'.repeat(64) + '\nSTATUS_PORT=9600\n' })
  const repUp = await callJson(client, 'repeater_status', { host: 'edge', lines: 40 })
  assert.strictEqual(repUp.host, 'edge.example', 'repeater_status routes to the named box')
  assert.match(repUp.statusServer, /enabled \(STATUS_PORT=9600\)/, 'an enabled status server is detected from the box .env')
  assert.match(repUp.metrics, /repeater_served_bytes_total\{stream_id="news-24"\}/, 'the /metrics text is surfaced (S48 served-bytes counter)')
  assert.ok(byName.repeater_status.description.includes('NO admin API'), 'the tool description states the no-admin-API design')
  assert.ok(byName.repeater_status.description.includes('docker-compose.repeater.yml'), 'the tool description points at the repeater compose file for installs')
  log('X: repeater_status — honest disabled note, configured-but-dead, enabled metrics via the box loopback, per-host routing ✓')

  // ===== Y: list-result ergonomics (S49c / G11) =====
  // 350-channel catalogs flood the client context. Filters are client-side only
  // (the panel API is untouched); the no-arg call must stay the raw array.
  for (let i = 1; i <= 14; i++) {
    await callJson(client, 'panel_add_stream', { id: `bulk-${String(i).padStart(2, '0')}`, category: 'BulkCat' })
  }
  await callJson(client, 'panel_add_stream', { id: 'kids-1', category: 'Kids/Cartoons' })
  const rawList = await callJson(client, 'panel_list_streams')
  assert.ok(Array.isArray(rawList), 'no-arg panel_list_streams still returns the raw catalog array (back-compat)')
  const catList = await callJson(client, 'panel_list_streams', { category: 'BulkCat' })
  assert.strictEqual(catList.matched, 14, 'category filter matched the 14 bulk channels')
  assert.strictEqual(catList.total, rawList.length, 'total reports the full catalog size so nothing hides')
  assert.ok(Array.isArray(catList.streams) && catList.streams.length === 14, 'filtered records returned')
  const idList = await callJson(client, 'panel_list_streams', { category: 'BulkCat', idsOnly: true, limit: 5 })
  assert.deepStrictEqual(idList.ids.length, 5, 'limit caps the returned rows')
  assert.strictEqual(idList.matched, 14, 'matched still reports the pre-limit count (nothing silently dropped)')
  assert.ok(idList.ids.every((id) => typeof id === 'string'), 'idsOnly returns bare ids')
  const prefList = await callJson(client, 'panel_list_streams', { prefix: 'bulk-0', idsOnly: true })
  assert.strictEqual(prefList.matched, 9, 'prefix filter (bulk-01..09)')
  const parentCat = await callJson(client, 'panel_list_streams', { category: 'Kids', idsOnly: true })
  assert.deepStrictEqual(parentCat.ids, ['kids-1'], "a parent category matches its 'Parent/Child' children")
  // The user-summary compaction: ONE mechanism on every user-shaped result.
  await callJson(client, 'panel_add_package', { name: 'bulk-pack', members: 'bulk-*' })
  await callJson(client, 'panel_create_user', { username: 'bulkviewer' })
  const bigAssign = await callJson(client, 'panel_set_user_packages', { username: 'bulkviewer', packages: ['bulk-pack'] })
  assert.strictEqual(bigAssign.grants.count, 14, 'a >12-id grant list compacts to {count, sample}')
  assert.strictEqual(bigAssign.grants.sample.length, 8, 'the sample is a short head')
  assert.match(bigAssign.note, /full:true/, 'the result says how to get the full lists')
  const bigFull = await callJson(client, 'panel_get_user', { username: 'bulkviewer', full: true })
  assert.ok(Array.isArray(bigFull.grants) && bigFull.grants.length === 14, 'full:true restores the complete id list')
  const bigDefault = await callJson(client, 'panel_get_user', { username: 'bulkviewer' })
  assert.strictEqual(bigDefault.grants.count, 14, 'panel_get_user compacts by default')
  const granted15 = await callJson(client, 'panel_grant', { username: 'bulkviewer', streamId: 'kids-1' })
  assert.strictEqual(granted15.grants.count, 15, 'panel_grant returns the compact summary too')
  const inList = (await callJson(client, 'panel_list_users', { prefix: 'bulkviewer' })).users[0]
  assert.strictEqual(inList.grants.count, 15, 'panel_list_users items compact the same way')
  const inListFull = (await callJson(client, 'panel_list_users', { prefix: 'bulkviewer', full: true })).users[0]
  assert.ok(Array.isArray(inListFull.grants), 'panel_list_users full:true restores arrays')
  // Small users never see the summary shape — a 3-grant record stays raw.
  const smallUser = await callJson(client, 'panel_get_user', { username: 'mcpviewer' })
  assert.ok(Array.isArray(smallUser.grants), 'a small grant list stays a plain array (small deployments unchanged)')
  assert.ok(!smallUser.note, 'no summary note on an uncompacted result')
  for (const name of ['panel_get_user', 'panel_set_user_packages', 'panel_grant', 'panel_create_user', 'panel_set_max_devices']) {
    assert.ok(/full:true/.test(byName[name].description) || /full/.test(JSON.stringify(byName[name].inputSchema.properties.full || {})), name + ' documents the summary mechanism')
  }
  log('Y: list ergonomics — category/prefix/idsOnly/limit client-side, raw no-arg call intact, {count,sample} compaction with full:true recovery, small users untouched ✓')

  // ===== Z: schema gaps (S49c / G12) =====
  // hlsTime/hlsListSize: bounds mirror channel.js normalizeMeta. The mirrored
  // bounds are text-matched against the real source so they cannot drift silently.
  const channelJs = fs.readFileSync(path.join(REPO, 'broadcaster', 'src', 'channel.js'), 'utf8')
  assert.ok(channelJs.includes("bad('hlsTime must be 1-30')"), 'channel.js still enforces hlsTime 1-30 (update the MCP schema if this moved)')
  assert.ok(channelJs.includes("bad('hlsListSize must be 2-60')"), 'channel.js still enforces hlsListSize 2-60 (update the MCP schema if this moved)')
  const hlsAdd = await callJson(client, 'broadcaster_add_channel', { id: 'mcp-hls', input: 'test', hlsTime: 4, hlsListSize: 12 })
  assert.deepStrictEqual(hlsAdd.hls, { time: 4, listSize: 12 }, 'hlsTime/hlsListSize round-trip on add')
  const hlsPatch = await callJson(client, 'broadcaster_update_channel', { id: 'mcp-hls', hlsListSize: 20 })
  assert.deepStrictEqual(hlsPatch.hls, { time: 2, listSize: 20 }, 'patching one hls field re-derives the pair from the env default (the real normalizeMeta semantics)')
  for (const bad of [{ hlsTime: 31 }, { hlsTime: 0 }, { hlsListSize: 1 }, { hlsListSize: 61 }]) {
    let rejected = false
    try { const r = await callRaw(client, 'broadcaster_update_channel', { id: 'mcp-hls', ...bad }); rejected = !!r.isError } catch { rejected = true }
    assert.ok(rejected, `out-of-bounds ${JSON.stringify(bad)} must be rejected`)
  }
  // feedKey/key on the panel: the pre-seeded feed flow. `key` is a SECRET INPUT —
  // it flows TO the panel and never back.
  const SEED_KEY = 'c'.repeat(64)
  const SEED_FEED = 'd'.repeat(64)
  const preseed = await callJson(client, 'panel_add_stream', { id: 'preseed', feedKey: SEED_FEED, key: SEED_KEY })
  assert.strictEqual(preseed.catalog.feedKey, SEED_FEED, 'the supplied feedKey landed on the catalog record')
  assert.strictEqual(preseed.catalog.status, 'live', 'a feedKey-bearing stream starts live (the panel semantics)')
  assert.strictEqual(preseed.encryptionKey, undefined, 'a SUPPLIED key is not echoed back')
  assert.match(preseed.encryptionKeyNote, /redacted/, 'the result says the key was redacted and why')
  assert.ok(!JSON.stringify(preseed).includes(SEED_KEY), 'the supplied secret appears nowhere in the result')
  const secretsFile = JSON.parse(fs.readFileSync(path.join(dirs.panel, 'secrets', 'streams.json'), 'utf8'))
  assert.strictEqual(secretsFile.preseed, SEED_KEY, 'the supplied key IS stored panel-side (it flowed TO the panel)')
  const genkey = await callJson(client, 'panel_add_stream', { id: 'genkey' })
  assert.match(genkey.encryptionKey, /^[0-9a-f]{64}$/, 'an omitted key still mints + returns one ONCE (the generated-password pattern — there is no read-back API)')
  const repointed = await callJson(client, 'panel_set_stream_meta', { id: 'preseed', feedKey: 'e'.repeat(64) })
  assert.strictEqual(repointed.catalog.feedKey, 'e'.repeat(64), 'set_stream_meta re-points the feedKey')
  assert.strictEqual(repointed.catalog.blobsKey, null, 'a feedKey edit resets the paired blobsKey (re-filled by the next real registration)')
  let badHexRejected = false
  try { const r = await callRaw(client, 'panel_add_stream', { id: 'badhex', key: 'nothex' }); badHexRejected = !!r.isError } catch { badHexRejected = true }
  assert.ok(badHexRejected, 'a non-64-hex key is rejected by the schema before it ships')
  const conflict = await callRaw(client, 'panel_add_stream', { id: 'conflicted', url: 'https://cdn.example/x.m3u8', feedKey: SEED_FEED })
  assert.ok(conflict.isError && /redirect channel cannot have a feedKey/.test(conflict.content[0].text), 'the redirect+feedKey conflict surfaces the panel\'s own clean error')
  log('Z: schema gaps — hls bounds round-trip + drift text-match, feedKey/key pre-seed flow with the supplied secret REDACTED, generated key returned once ✓')

  // ===== AA: MCP prompts — runbooks (S49c / G13) =====
  const promptsList = await client.listPrompts()
  const promptNames = new Set(promptsList.prompts.map((p) => p.name))
  for (const must of ['new-site-install', 'onboard-a-reseller', 'migrate-a-channel-source', 'monthly-maintenance', 'incident-triage', 'expose-dashboards']) {
    assert.ok(promptNames.has(must), 'prompts/list missing ' + must)
  }
  assert.ok(promptsList.prompts.every((p) => p.description && p.description.length > 20), 'every prompt carries a description')
  // The drift guard: every tool name a prompt mentions must exist. A renamed tool
  // may not silently strand a runbook.
  const TOOL_TOKEN = /\b(?:panel|broadcaster|reseller|library|server|repeater|diagnose|docs)_[a-z0-9_]+/g
  for (const p of promptsList.prompts) {
    const got = await client.getPrompt({ name: p.name, arguments: {} })
    const body = got.messages.map((m) => m.content.text).join('\n')
    assert.ok(got.messages.length >= 1 && body.length > 300, `prompt ${p.name} has substantive guidance`)
    for (const tok of body.match(TOOL_TOKEN) || []) {
      assert.ok(toolNames.has(tok), `prompt ${p.name} names "${tok}" which is NOT a registered tool (the drift guard)`)
    }
  }
  const triage = await client.getPrompt({ name: 'incident-triage', arguments: { symptom: 'disk keeps filling' } })
  assert.ok(triage.messages[0].content.text.includes('disk keeps filling'), 'incident-triage interpolates the symptom argument')
  const expose = await client.getPrompt({ name: 'expose-dashboards', arguments: {} })
  assert.ok(expose.messages[0].content.text.includes('kb/public-dashboards.md'), 'expose-dashboards routes through the shipped KB (the G15 docs-first decision)')
  const migrate = await client.getPrompt({ name: 'migrate-a-channel-source', arguments: {} })
  assert.ok(/broadcaster_stop_channel.*broadcaster_start_channel/s.test(migrate.messages[0].content.text), 'the migrate runbook carries the stop→start honesty (a running channel does not apply a source change in place)')
  log(`AA: prompts — ${promptsList.prompts.length} runbooks, shapes + argument interpolation + the tool-name drift guard ✓`)

  // ===== AB: server_update dryRun (S49c / G16) =====
  const buildCountBefore = readCmdLog().split('compose build').length
  const upCountBefore2 = readCmdLog().split('up -d').length
  const dry = await callJson(client, 'server_update', { dryRun: true })
  assert.strictEqual(dry.dryRun, true, 'the result is marked as a dry run')
  assert.match(dry.wouldDeploy, /abc1234 feat\(panel\): next thing/, 'dryRun lists the commits that WOULD deploy')
  assert.match(dry.changedFiles, /panel\/src\/ops\.js/, 'dryRun summarizes the changed files')
  assert.match(dry.note, /nothing was pulled, built, or restarted/, 'the note states what did NOT happen')
  assert.ok(readCmdLog().includes('git fetch --quiet'), 'dryRun fetched')
  assert.ok(readCmdLog().includes("git log --oneline HEAD..'@{u}'"), 'dryRun compared against the branch upstream (what pull --ff-only would merge)')
  assert.strictEqual(readCmdLog().split('compose build').length, buildCountBefore, 'dryRun never built')
  assert.strictEqual(readCmdLog().split('up -d').length, upCountBefore2, 'dryRun never recreated anything')
  log('AB: server_update dryRun — commits + changed files reported, zero build/up commands ✓')

  // ===== AC: npm-publish prep (S49c / G14) =====
  // A published @aliran/mcp must still serve the docs resources: prepack bundles
  // docs/ into docs-bundle/, and config.js falls back to it exactly when the live
  // repo docs/ sibling is absent (an unpacked tarball). Deterministic: local pack,
  // no network; the unpacked entry resolves node_modules via a link to the repo's.
  const mcpDir = path.join(REPO, 'mcp')
  const packDest = fs.mkdtempSync(path.join(os.tmpdir(), 'e2emcp-pack-'))
  cleanups.push(() => { try { fs.rmSync(packDest, { recursive: true, force: true }) } catch {} })
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  // Windows: .cmd shims need a shell, and DEP0190 wants the command as ONE string
  // there (args quoted by hand — they are all our own paths/flags).
  const runCmd = (cmd, args, { cwd, timeoutMs = 120000 } = {}) => new Promise((resolve) => {
    const child = process.platform === 'win32'
      ? spawn([cmd, ...args.map((a) => /\s/.test(a) ? '"' + a + '"' : a)].join(' '), [], { cwd: cwd || REPO, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
      : spawn(cmd, args, { cwd: cwd || REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }) })
  })
  // 1. The bundler itself (also what prepack runs).
  const bundle = await runCli([path.join(mcpDir, 'scripts', 'bundle-docs.mjs')])
  assert.strictEqual(bundle.status, 0, 'bundle-docs exits 0: ' + bundle.stderr)
  assert.ok(fs.existsSync(path.join(mcpDir, 'docs-bundle', 'operator-guide.md')), 'the bundle holds the docs corpus')
  assert.ok(fs.existsSync(path.join(mcpDir, 'docs-bundle', 'kb', 'backup-and-rotation.md')), 'the bundle keeps the kb/ subtree')
  // 2. npm pack --dry-run: the published file list.
  const dryPack = await runCmd(npmBin, ['pack', '--dry-run', '--json', '--pack-destination', packDest], { cwd: mcpDir })
  assert.strictEqual(dryPack.status, 0, 'npm pack --dry-run exits 0: ' + dryPack.stderr.slice(-500))
  const jsonText = dryPack.stdout.slice(dryPack.stdout.indexOf('['), dryPack.stdout.lastIndexOf(']') + 1)
  const packMeta = JSON.parse(jsonText)[0]
  const packFiles = new Set(packMeta.files.map((f) => f.path))
  for (const need of ['src/index.js', 'src/prompts.js', 'src/tools/server.js', 'docs-bundle/operator-guide.md', 'docs-bundle/kb/backup-and-rotation.md', 'docs-bundle/mcp.md', 'config.example.json', 'README.md', 'package.json']) {
    assert.ok(packFiles.has(need), `the tarball must ship ${need}`)
  }
  assert.ok(!packFiles.has('config.json'), 'a real config (credentials) can never ship')
  assert.ok(![...packFiles].some((f) => f.startsWith('scripts/')), 'the build-time bundler script stays out of the tarball')
  assert.strictEqual(packMeta.name, '@aliran/mcp', 'package name')
  // 3. Real pack → unpack → run the doctor FROM the tarball: docs must resolve
  // from docs-bundle/ (the repo checkout chain misses on purpose out there).
  const realPack = await runCmd(npmBin, ['pack', '--pack-destination', packDest], { cwd: mcpDir })
  assert.strictEqual(realPack.status, 0, 'npm pack exits 0: ' + realPack.stderr.slice(-500))
  const tarName = realPack.stdout.trim().split('\n').pop().trim()
  assert.ok(tarName.endsWith('.tgz'), 'npm pack printed the tarball name, got: ' + tarName)
  // Relative paths on purpose: a GNU tar (git-bash) on PATH reads a Windows
  // drive colon as a remote-host separator; cwd + bare names sidestep it.
  const untar = await runCmd('tar', ['-xzf', tarName, '-C', '.'], { cwd: packDest })
  assert.strictEqual(untar.status, 0, 'tar extract exits 0: ' + untar.stderr)
  const unpacked = path.join(packDest, 'package')
  // The tarball ships no node_modules (deps install on npm i); link the repo's so
  // the entry can import the MCP SDK — ESM ignores NODE_PATH, so a link it is.
  // Walk up from REPO exactly like node's resolver does: a git worktree has no
  // node_modules of its own (the main checkout's, an ancestor, serves it).
  let nmRoot = null
  for (let d = REPO; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'node_modules', '@modelcontextprotocol', 'sdk'))) { nmRoot = path.join(d, 'node_modules'); break }
    if (path.dirname(d) === d) break
  }
  assert.ok(nmRoot, 'found a node_modules holding the MCP SDK')
  const nmLink = path.join(unpacked, 'node_modules')
  fs.symlinkSync(nmRoot, nmLink, 'junction')
  cleanups.push(() => { try { process.platform === 'win32' ? fs.rmdirSync(nmLink) : fs.unlinkSync(nmLink) } catch {} })
  const packedCfg = path.join(packDest, 'packed-config.json')
  fs.writeFileSync(packedCfg, JSON.stringify({ panel: { url: `http://127.0.0.1:${panelPort}`, user: PANEL_ADMIN.user, pass: PANEL_ADMIN.pass } }), { mode: 0o600 })
  const packedDoctor = await runCli([path.join(unpacked, 'src', 'index.js'), '--doctor', '--config', packedCfg])
  assert.strictEqual(packedDoctor.status, 0, 'the unpacked-tarball doctor exits 0:\n' + packedDoctor.stdout + packedDoctor.stderr)
  const docsLine = packedDoctor.stdout.split('\n').find((l) => l.includes('documents indexed'))
  assert.ok(docsLine, 'the unpacked doctor indexed docs (resources non-empty out of a tarball)')
  assert.ok(/docs-bundle/.test(docsLine), 'the docs resolved from the BUNDLED copy: ' + docsLine)
  assert.ok(/documents indexed at/.test(docsLine) && parseInt(docsLine.match(/(\d+) documents/)[1], 10) >= 20, 'a real corpus, not a stray file: ' + docsLine)
  log('AC: npm-publish prep — bundle built, tarball file list correct (no secrets, no build scripts), unpacked entry serves docs from docs-bundle ✓')

  // ===== AD: viewer problem reports (S50d) =====
  // The tools ride the S50a/b store + notifier. Without them attached the routes
  // answer the honest "disabled" shape rather than 404 — assert that FIRST, then
  // attach a real store (the admin server reads ctx.reports per request, the same
  // seam section K uses for analytics) and drive the whole triage loop.
  const reportsOff = await callJson(client, 'panel_list_reports')
  assert.strictEqual(reportsOff.enabled, false, 'no reports store -> honest {enabled:false}, not a 404')
  assert.deepStrictEqual(reportsOff.reports, [], 'the disabled shape carries an empty list')
  assert.strictEqual((await callJson(client, 'panel_list_alerts')).enabled, false, 'alerts answer the disabled shape too')
  const notifyOff = await callJson(client, 'panel_test_notify')
  assert.strictEqual(notifyOff.enabled, false, 'test_notify with nothing configured is enabled:false, not an error')
  assert.deepStrictEqual(notifyOff.targets, [], 'no targets when unconfigured')
  const ackOff = await callRaw(client, 'panel_ack_report', { id: 'nope' })
  assert.ok(ackOff.isError && /not available/.test(ackOff.content[0].text), 'a mutation without a store is a loud error, not a silent no-op')

  // A webhook stub so the alert push + test_notify have somewhere real to land.
  const hookSeen = []
  const hookSrv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { try { hookSeen.push({ headers: req.headers, body: JSON.parse(body) }) } catch { hookSeen.push({ headers: req.headers, body: null }) }; res.writeHead(200); res.end('ok') })
  })
  await new Promise((r) => hookSrv.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => hookSrv.close(r)))
  const hookBase = `http://127.0.0.1:${hookSrv.address().port}`
  const notifier = makeNotifier({ webhookUrl: hookBase + '/hook', timeoutMs: 2000, backoffMs: [10, 10], log: () => {} })
  cleanups.push(() => notifier.close())
  // alertCount 2 so two seeded reporters open an alert; a generous storm sample so
  // this lane exercises records, not the collapse path (test:reports owns that).
  const reports = makeReports({ dataDir: dirs.panel, retentionDays: 30, alertCount: 2, stormSampleSize: 100, flushMs: 10, onAlert: (a) => notifier.notify(a) })
  cleanups.push(() => reports.close())
  ctx.reports = reports
  ctx.notifier = notifier

  // Seed through the module, exactly as the RPC responder would: identities are
  // reduced to pseudonyms BEFORE anything is stored.
  const NEEDLE_USER = 'mcp-report-viewer'
  const NEEDLE_DEVICE = 'mcpdevice00112233'
  const repA = reports.pseudonym(NEEDLE_USER, NEEDLE_DEVICE)
  const repB = reports.pseudonym(NEEDLE_USER + '-2', NEEDLE_DEVICE + 'ff')
  assert.match(repA, /^[0-9a-f]{16}$/, 'the pseudonym is 16 hex chars')
  const longEvents = Array.from({ length: 12 }, (_, i) => ({ t: i, type: 'error', detail: 'breadcrumb-' + i }))
  const r1 = reports.ingest({ reporter: repA, category: 'no-audio', channel: 'mcp-rep-ch', text: 'sound cuts out every minute', appVersion: '0.2.0', platform: 'android-tv', peers: 4, events: longEvents })
  const r2 = reports.ingest({ reporter: repB, category: 'no-audio', channel: 'mcp-rep-ch' })
  const r3 = reports.ingest({ reporter: repA, category: 'buffering', channel: 'mcp-other-ch' })
  assert.ok(r1.ok && r2.ok && r3.ok, 'three seeded reports stored')
  assert.ok(r2.alertId, 'two distinct reporters on one channel opened an alert')

  const all = await callJson(client, 'panel_list_reports')
  assert.strictEqual(all.enabled, true, 'the attached store reports enabled:true')
  assert.strictEqual(all.reports.length, 3, 'all three seeded reports come back')
  assert.strictEqual(all.returned, 3, 'the envelope states how many were returned')
  assert.ok(all.reports.every((r) => /^[0-9a-f]{16}$/.test(r.reporter)), 'every listed reporter is a pseudonym')
  assert.strictEqual((await callJson(client, 'panel_list_reports', { channel: 'mcp-rep-ch' })).reports.length, 2, 'channel filter')
  assert.strictEqual((await callJson(client, 'panel_list_reports', { category: 'buffering' })).reports.length, 1, 'category filter')
  assert.strictEqual((await callJson(client, 'panel_list_reports', { status: 'new' })).reports.length, 3, 'status filter')
  assert.strictEqual((await callJson(client, 'panel_list_reports', { limit: 1 })).reports.length, 1, 'limit')
  assert.strictEqual((await callJson(client, 'panel_list_reports', { since: Date.now() + 60000 })).reports.length, 0, 'raw epoch-ms since filters everything out')
  assert.strictEqual((await callJson(client, 'panel_list_reports', { sinceHours: 24 })).reports.length, 3, 'sinceHours 24 covers everything just seeded')
  // sinceHours WINS over since — the convenience must not be silently ignored.
  assert.strictEqual((await callJson(client, 'panel_list_reports', { since: Date.now() + 60000, sinceHours: 24 })).reports.length, 3, 'sinceHours overrides a conflicting since')
  let catRejected = false
  try { const r = await callRaw(client, 'panel_list_reports', { category: 'not-a-category' }); catRejected = !!r.isError } catch { catRejected = true }
  assert.ok(catRejected, 'an unknown category is rejected by the schema before it reaches the panel')

  // Event-ring compaction (the compactUser mechanism on a second shape).
  const compacted = (await callJson(client, 'panel_list_reports', { channel: 'mcp-rep-ch' })).reports.find((r) => r.id === r1.id)
  assert.ok(!Array.isArray(compacted.events), 'a 12-event ring is summarized, not inlined')
  assert.strictEqual(compacted.events.count, 12, 'the summary states the true event count')
  assert.strictEqual(compacted.events.sample.length, 3, 'the sample is bounded')
  assert.strictEqual(compacted.events.sample[2].detail, 'breadcrumb-11', 'the sample is the TAIL — where the failure is')
  assert.match((await callJson(client, 'panel_list_reports', { channel: 'mcp-rep-ch' })).note, /full:true/, 'the envelope says how to get every event')
  const fullRing = (await callJson(client, 'panel_list_reports', { channel: 'mcp-rep-ch', full: true })).reports.find((r) => r.id === r1.id)
  assert.strictEqual(fullRing.events.length, 12, 'full:true restores the whole ring')
  assert.strictEqual((await callJson(client, 'panel_list_reports', { channel: 'mcp-other-ch' })).note, undefined, 'a short ring is passed through with no note')

  // Lifecycle: ack -> resolve with a note, through the tools onto the same store.
  assert.strictEqual((await callJson(client, 'panel_ack_report', { id: r3.id })).status, 'ack', 'ack round-trips')
  const resolved = await callJson(client, 'panel_resolve_report', { id: r3.id, note: 'upstream transcoder restarted' })
  assert.strictEqual(resolved.status, 'resolved', 'resolve round-trips')
  assert.strictEqual(resolved.note, 'upstream transcoder restarted', 'the operator note is stored')
  assert.strictEqual(reports.get(r3.id).status, 'resolved', 'the mutation hit the same store the module reads')
  assert.strictEqual((await callJson(client, 'panel_list_reports', { status: 'resolved' })).reports.length, 1, 'the resolved report is filterable')
  const ack404 = await callRaw(client, 'panel_ack_report', { id: 'no-such-report' })
  assert.ok(ack404.isError, 'acking an unknown report is a loud error')

  // Alerts are READ-ONLY here by design (a live panel holds them in memory).
  const alertsOut = await callJson(client, 'panel_list_alerts')
  assert.strictEqual(alertsOut.alerts.length, 1, 'exactly one alert for the storm')
  assert.strictEqual(alertsOut.alerts[0].kind, 'channel')
  assert.strictEqual(alertsOut.alerts[0].channel, 'mcp-rep-ch')
  assert.ok(!('reporter' in alertsOut.alerts[0]), 'an alert carries counts, never a reporter id')
  assert.strictEqual((await callJson(client, 'panel_list_alerts', { status: 'resolved' })).alerts.length, 0, 'alert status filter')
  assert.match(byName.panel_list_alerts.description, /not wrapped here/, 'the tool states that alert ack/resolve is deliberately unwrapped')
  assert.ok(!toolNames.has('panel_ack_alert') && !toolNames.has('panel_resolve_alert'), 'no alert-mutation tools exist')

  // Notifications: the opened alert pushed once, and test_notify uses the SAME path.
  await notifier.idle()
  assert.strictEqual(hookSeen.length, 1, 'the opened alert produced exactly one webhook POST')
  assert.match(hookSeen[0].body.title, /mcp-rep-ch/, 'the push names the channel')
  const tn = await callJson(client, 'panel_test_notify')
  assert.deepStrictEqual(tn.targets, ['webhook'], 'test_notify reports the configured targets')
  assert.strictEqual(tn.results[0].ok, true, 'test_notify reached the stub: ' + JSON.stringify(tn))
  assert.strictEqual(hookSeen.length, 2, 'test_notify sent exactly one more POST')
  assert.match(hookSeen[1].body.title, /test notification/i, 'the test push is obviously synthetic')

  // Mini negative-identity scan: nothing the tools returned may carry the seeded
  // username or device id (test:reports owns the full 9-surface sweep).
  const reportSurfaces = [
    ['panel_list_reports', JSON.stringify(await callJson(client, 'panel_list_reports', { full: true }))],
    ['panel_list_alerts', JSON.stringify(alertsOut)],
    ['panel_resolve_report', JSON.stringify(resolved)],
    ['webhook payloads', JSON.stringify(hookSeen)]
  ]
  for (const [label, body] of reportSurfaces) {
    for (const needle of [NEEDLE_USER, NEEDLE_DEVICE]) {
      assert.ok(!body.includes(needle), `IDENTITY LEAK: ${needle} appeared in ${label}`)
    }
  }

  // REPORTS_* env split: the tunables are settable (validated by the REAL panel
  // config.js --check in the stub image), the notification credentials are not.
  const setReports = await callJson(client, 'server_set_env', { service: 'panel', pairs: { REPORTS_ALERT_COUNT: 5, REPORTS_RETENTION_DAYS: 45 } })
  assert.match(setReports.validation, /passed/, 'the REPORTS_* tunables survive the real in-image config check')
  assert.ok(readState()['/opt/aliran/panel/.env'].includes('REPORTS_ALERT_COUNT=5'), 'the tunable landed in the box .env')
  for (const [key, why] of [['REPORTS_TELEGRAM_BOT_TOKEN', /bot secret/], ['REPORTS_WEBHOOK_URL', /credential in the path/]]) {
    const refused = await callRaw(client, 'server_set_env', { service: 'panel', pairs: { [key]: 'https://example.invalid/secret-topic' } })
    assert.ok(refused.isError, `${key} must be refused`)
    assert.match(refused.content[0].text, new RegExp('refusing to set ' + key), 'the refusal names the key')
    assert.match(refused.content[0].text, why, `${key}'s refusal explains why it is a secret`)
    assert.ok(!JSON.stringify(readState()).includes('secret-topic'), 'the refused value never reached any .env')
  }

  // Drift guard: the MCP cannot import panel/src/reports.js (it ships as a
  // standalone npm package), so its category enum is a copy — and a copy that
  // drifts would reject categories the panel accepts. Check the PUBLISHED schema.
  const catProp = byName.panel_list_reports.inputSchema.properties.category
  const catEnum = catProp.enum || (catProp.anyOf || []).flatMap((x) => x.enum || [])
  assert.deepStrictEqual(catEnum, REPORT_CATEGORIES, 'the published panel_list_reports category enum must deep-equal panel/src/reports.js')
  log(`AD: viewer reports — disabled shape, filters + sinceHours, ${catEnum.length}-category drift guard, event-ring compaction with full:true, ack/resolve+note, read-only alerts, one push per alert + test_notify, zero identity leaks, REPORTS_* allowlist vs refused credentials ✓`)

  // ===== AE: external VOD provider config (S53a) =====
  // The panel owns the switch; the APPS call the provider. Nothing here is a secret,
  // so the whole record round-trips through the tool result — what must not happen is
  // a bad config landing quietly, so every refusal is asserted in band with the stored
  // record re-read afterwards.
  assert.strictEqual(await callJson(client, 'panel_vod_config'), null, 'no VOD provider configured -> honest null')
  const vodSet = await callJson(client, 'panel_set_vod_config', {
    apiBase: 'https://provider.example/like/api/',
    service: 'demoservice',
    sources: { movies: 'movies_hd' },
    params: { hm: '1', hs: '2' }
  })
  assert.strictEqual(vodSet.enabled, false, 'a fresh config is DISABLED until the operator flips the switch')
  assert.strictEqual(vodSet.apiBase, 'https://provider.example/like/api', 'the trailing slash is normalized away')
  assert.strictEqual(vodSet.sources.movies, 'movies_hd', 'movies source stored')
  assert.deepStrictEqual(vodSet.params, { hm: '1', hs: '2' }, 'extra params stored verbatim')
  const vodOn = await callJson(client, 'panel_set_vod_config', { enabled: true })
  assert.strictEqual(vodOn.enabled, true, 'the switch flips on its own once the coordinates are stored')
  assert.strictEqual(vodOn.service, 'demoservice', 'a partial patch MERGES — the untouched fields survive')
  assert.deepStrictEqual(await callJson(client, 'panel_vod_config'), vodOn, 'the read tool answers exactly what was written')
  for (const [patch, why] of [
    [{ apiBase: 'http://provider.example/api' }, 'cleartext apiBase'],
    [{ apiBase: 'https://provider.example/api?token=x' }, 'apiBase with a query string'],
    // `movies` and `series` are the two kinds the apps understand (S54a); anything
    // else is still refused rather than stored.
    [{ sources: { cartoons: 'toons_hd' } }, 'unknown source kind'],
    [{ params: { 'bad key': '1' } }, 'invalid param name']
  ]) {
    const r = await callRaw(client, 'panel_set_vod_config', patch)
    assert.ok(r.isError, `${why} must be refused in band, got: ${JSON.stringify(r.content)}`)
  }
  assert.deepStrictEqual(await callJson(client, 'panel_vod_config'), vodOn, 'every refused patch left the stored record untouched')
  // Enabling an EMPTY config is the refusal that protects viewers from a VOD section
  // pointing nowhere — proven on a second panel-less field set rather than by wrecking
  // the good record: clear the coordinates and enable in the same breath.
  const emptyEnable = await callRaw(client, 'panel_set_vod_config', { enabled: true, apiBase: '', service: '' })
  assert.ok(emptyEnable.isError, 'enabling an empty config must be refused')
  assert.match(emptyEnable.content[0].text, /apiBase and a service/, 'the refusal says what is missing')
  assert.deepStrictEqual(await callJson(client, 'panel_vod_config'), vodOn, 'the refused enable changed nothing')
  // Both source kinds at once (S54a). `sources` REPLACES the whole map, so the series
  // value has to be sent WITH the movies one — an operator who omits it keeps a
  // movies-only record, which the apps read as "no Series menu".
  const vodBoth = await callJson(client, 'panel_set_vod_config', { sources: { movies: 'movies_hd', series: 'series_hd' } })
  assert.deepStrictEqual(vodBoth.sources, { movies: 'movies_hd', series: 'series_hd' }, 'movies AND series sources store together')
  assert.deepStrictEqual((await callJson(client, 'panel_vod_config')).sources, { movies: 'movies_hd', series: 'series_hd' }, 'the read tool answers both kinds back')
  await callJson(client, 'panel_set_vod_config', { enabled: false })
  log('AE: VOD provider config — honest null, CRUD round-trip through both tools, both movies+series sources stored, https/query-string/unknown-kind/empty-enable refusals in band with the record untouched ✓')

  // ---- AF: SSH tunnel lifecycle — keepalives, death, revive-on-demand ----
  //
  // Found live: `server_update` restarts the panel container, the ssh forward's
  // process went away, and every panel_* tool then failed with "unreachable at
  // http://127.0.0.1:<random port>" until the whole AI client was restarted. The
  // tunnel is driven here through the spawnTunnel seam against a fake ssh that
  // holds a real listener, so open → die → revive is exercised without an sshd.
  {
    const kids = []
    // A fake ssh child: listens on the forward's local port like the real one, and
    // `kill()` (or die()) drops it exactly as a dropped SSH connection would.
    const fakeSpawn = (argv) => {
      const forward = argv.find((a) => /^\d+:/.test(String(a))) || ''
      const localPort = Number(String(forward).split(':')[0])
      const handlers = {}
      const server = net.createServer((s) => s.destroy())
      server.listen(localPort, '127.0.0.1')
      const child = {
        argv,
        stderr: null,
        on (ev, fn) { handlers[ev] = fn },
        kill () { try { server.close() } catch {} ; if (handlers.exit) handlers.exit(0) },
        die () { try { server.close() } catch {} ; if (handlers.exit) handlers.exit(255) }
      }
      kids.push(child)
      return child
    }
    const aFreePort = () => new Promise((resolve, reject) => {
      const srv = net.createServer(); srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
    })
    const ssh = makeSsh({ host: 'box.example', user: 'root', keyPath: '/dev/null' }, { spawnTunnel: fakeSpawn })
    const lp = await aFreePort()
    const tun = await ssh.openTunnel({ localPort: lp, remotePort: 3210, timeoutMs: 8000 })
    assert.strictEqual(tun.alive, true, 'a freshly opened tunnel reports alive')
    assert.strictEqual(tun.localPort, lp, 'the handle keeps the local port the caller was given')

    // Keepalives are the whole reason a dead forward becomes observable at all.
    const argv = kids[0].argv.join(' ')
    for (const opt of ['ServerAliveInterval=30', 'ServerAliveCountMax=6', 'ExitOnForwardFailure=yes']) {
      assert.ok(argv.includes(opt), `the tunnel argv carries ${opt}`)
    }
    assert.ok(argv.includes(`-L ${lp}:127.0.0.1:3210`.replace(/ /g, ' ')) || argv.includes(`${lp}:127.0.0.1:3210`), 'the forward is built from the requested ports')

    kids[0].die() // the ssh connection drops, exactly as it did on the live box
    await new Promise((r) => setTimeout(r, 50))
    assert.strictEqual(tun.alive, false, 'the handle notices its ssh process died')

    const revived = await tun.ensure()
    assert.strictEqual(revived, true, 'ensure() reopens a dead forward')
    assert.strictEqual(tun.alive, true, 'and the handle is alive again')
    assert.strictEqual(kids.length, 2, 'exactly one new ssh child was spawned')
    assert.strictEqual(await tun.ensure(), false, 'ensure() on a live tunnel is a no-op')

    // Concurrent tool calls must share one reconnect, not race a second ssh.
    kids[1].die()
    await new Promise((r) => setTimeout(r, 50))
    await Promise.all([tun.ensure(), tun.ensure(), tun.ensure()])
    assert.strictEqual(kids.length, 3, 'three concurrent ensure() calls share a single reconnect')

    // The http client replays the request through the revived forward, so a dead
    // tunnel costs one retry instead of disabling the service until a restart.
    let hits = 0
    const svcPort = await aFreePort()
    const svcSrv = http.createServer((req, res) => { hits++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })) })
    const listen = () => new Promise((r) => svcSrv.listen(svcPort, '127.0.0.1', r))
    let ensured = 0
    let reviveTo = null // what ensure() should do to the "forward" before the replay
    const client = makeHttpClient({ name: 'panel', timeoutMs: 3000 }, {
      baseUrl: `http://127.0.0.1:${svcPort}`,
      dataDir: dirs.mcp,
      reachability: {
        describe: 'through the SSH tunnel to box.example:3210',
        ensure: async () => { ensured++; if (reviveTo) await reviveTo() }
      }
    })

    // 1. Nothing is listening (the forward is dead): ensure() brings it back and the
    //    SAME call succeeds on the replay — the operator never sees a failure.
    reviveTo = listen
    const revivedOk = await client.healthz()
    assert.deepStrictEqual(revivedOk, { ok: true }, 'a dead forward is revived and the request replayed')
    assert.strictEqual(ensured, 1, 'the client asked for the tunnel once')
    assert.strictEqual(hits, 1, 'the service saw the request exactly once')

    // 2. A live forward costs no extra work.
    await client.healthz()
    assert.strictEqual(ensured, 1, 'a healthy call never touches the tunnel')

    // 3. The service is genuinely down: reviving cannot save it, and the message must
    //    blame the service — with the box named, not a bare loopback port.
    await new Promise((r) => svcSrv.close(r))
    reviveTo = null
    await assert.rejects(() => client.healthz(), (err) => {
      assert.match(err.message, /unreachable through the SSH tunnel to box\.example:3210/, 'the error names the route, not a bare loopback port')
      assert.match(err.message, /server_status/, 'and it tells the operator what to run next')
      return true
    }, 'a service that stays down still errors after the retry')
    assert.strictEqual(ensured, 2, 'exactly one revive attempt per failed call')
    for (const k of kids) { try { k.kill() } catch {} }
    tun.close()
    assert.strictEqual(tun.alive, false, 'close() leaves the handle dead')
  }
  log('AF: SSH tunnel lifecycle — keepalive/ExitOnForwardFailure argv, death detected, ensure() revives the same local port, concurrent revives share one attempt, the http client retries through it and names the box when the service is genuinely down ✓')

  log('\nRESULT: PASS ✅  (MCP tools + resources; write chain materialized sealed grants; destructive/readOnly annotations; docs resources + search; re-login-on-401; SSH executor via command stub with the publisher secret staying server-side; broadcaster control tools; onboarding doctor incl. reseller/library probes + named hosts; typed channel input/transcode; S49a: analytics passthroughs, admins CRUD live-verified, set_env validate-then-apply with the revert path on the REAL check-config, restart, list/restore backups; S49b: categories with honest selector coupling, source exclude curation with the ETag reset, stream art from the operator disk with zero base64, reseller oversight with the mint echoed against the real ledger, library titles over the control-API shapes, 4-service diagnose sweep; S49c: multi-host SSH through the extended stub seam with add_publisher targeting the named box, repeater_status in all three status-server states, list filters + user-summary compaction with full recovery, hls bounds + feedKey/key with the supplied secret redacted, 6 prompt runbooks with the tool-name drift guard, update dryRun with zero build/up, npm-pack prep with the unpacked-tarball docs probe; S50d: viewer problem reports — the honest disabled shape, filters + sinceHours, event-ring compaction with full:true, ack/resolve with a note, read-only alerts, one webhook push per opened alert plus test_notify, a negative-identity scan over every report surface, the REPORTS_* tunables settable while the notification credentials are refused, and a category-enum drift guard against the panel; S53a: the external VOD provider config — honest null, CRUD through both tools, and https/query-string/unknown-kind/empty-enable refusals in band with the stored record untouched)')
  await cleanup(); process.exit(0)
} catch (err) {
  log('ERROR:', err.stack || err.message)
  await cleanup(); process.exit(1)
}
