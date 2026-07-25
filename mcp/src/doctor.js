// `aliran-mcp --doctor` — the onboarding self-check. Run BY A HUMAN in a terminal
// (never by the MCP client), so unlike server mode it prints to STDOUT. It answers
// the four questions every first-time operator hits, in order:
//
//   1. Is my config file valid (and private)?
//   2. Can this machine actually reach the panel / broadcaster / box?
//   3. Which tool groups will the AI client get?
//   4. What exactly do I paste into claude_desktop_config.json?
//
// Reachability probes use the UNAUTHENTICATED /healthz endpoints, so a doctor run
// never spends a login attempt (both services throttle /api/login at 10 / 900 s —
// a debugging loop with a typo'd password would lock the account). Pass `--login`
// to additionally verify the credentials with ONE real login per service.
//
// Exit codes: 0 = everything configured checks out · 1 = a configured backend
// failed a probe · 2 = the config itself is unusable.

import fs from 'fs'
import net from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { makeHttpClient } from './http-client.js'
import { makeSsh } from './ssh.js'
import { buildDocsIndex } from './resources/docs.js'
import { PROMPTS } from './prompts.js'

const TAG = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]', skip: '[--]  ' }

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
}

// config = the normalized object from loadConfig(). Returns { failures, checks }.
export async function runDoctor (config, { checkLogin = false, out = (l) => process.stdout.write(l + '\n') } = {}) {
  const checks = []
  const add = (level, msg) => { checks.push({ level, msg }); out(TAG[level] + ' ' + msg) }

  out('Aliran MCP doctor')
  out('=================')
  out('config: ' + config.configPath)
  out('')

  // --- 1. the config file itself ---
  add('ok', 'config readable + valid JSON')
  if (process.platform === 'win32') {
    add('warn', 'file-mode check not applicable on Windows — keep the file in a private directory (it holds credentials)')
  } else {
    try {
      const mode = fs.statSync(config.configPath).mode & 0o777
      if (mode & 0o077) add('warn', `config is group/other-readable (mode ${mode.toString(8)}) — fix: chmod 600 ${config.configPath}`)
      else add('ok', `config file mode ${mode.toString(8)} (owner-only)`)
    } catch {}
  }

  // --- 2. SSH first (panel/broadcaster tunnels depend on it) ---
  let sshOk = false
  if (!config.ssh) {
    add('skip', 'ssh: not configured — server_* tools disabled; panel/broadcaster need explicit urls')
  } else {
    const ssh = makeSsh(config.ssh)
    try {
      const r = await ssh.run('echo aliran-doctor-ok', { allowFail: true, timeoutMs: 20000 })
      if (r.code === 0) { sshOk = true; add('ok', `ssh: connected to ${config.ssh.user}@${config.ssh.host}${config.ssh.port ? ':' + config.ssh.port : ''}`) } else {
        add('fail', `ssh: command exited ${r.code} — ${(r.stderr || r.stdout || '').trim().split('\n').pop() || 'no output'}`)
      }
    } catch (err) {
      add('fail', `ssh: ${err.message}`)
    }
    if (config.ssh.keyPath && !fs.existsSync(config.ssh.keyPath)) {
      add('fail', `ssh: keyPath does not exist: ${config.ssh.keyPath}`)
    }
    // Named hosts (multi-host, S49c): one cheap echo each — a dead repeater box
    // should show up here, not mid-runbook. The default host was probed above.
    if (config.ssh.hosts) {
      for (const [name, entry] of Object.entries(config.ssh.hosts)) {
        if (name === config.ssh.defaultName) continue
        try {
          const r = await makeSsh(entry).run('echo aliran-doctor-ok', { allowFail: true, timeoutMs: 20000 })
          if (r.code === 0) add('ok', `ssh host "${name}": connected to ${entry.user}@${entry.host}${entry.port ? ':' + entry.port : ''}`)
          else add('fail', `ssh host "${name}": command exited ${r.code} — ${(r.stderr || r.stdout || '').trim().split('\n').pop() || 'no output'}`)
        } catch (err) {
          add('fail', `ssh host "${name}": ${err.message}`)
        }
        if (entry.keyPath && !fs.existsSync(entry.keyPath)) add('fail', `ssh host "${name}": keyPath does not exist: ${entry.keyPath}`)
      }
    }
  }

  // --- 3. service reachability (healthz — never burns a login) ---
  for (const [name, svc, port] of [['panel', config.panel, 3210], ['broadcaster', config.broadcaster, 3310], ['reseller', config.reseller, 3330], ['library', config.library, 3320]]) {
    if (!svc) { add('skip', `${name}: not configured — its ${name}_* tools are disabled`); continue }
    let client = null
    let closeTunnel = null
    let via = svc.url
    try {
      if (svc.url) {
        client = makeHttpClient(svc, { dataDir: config.dataDir })
      } else if (sshOk) {
        const lp = await freePort()
        const ssh = makeSsh(config.ssh)
        const t = await ssh.openTunnel({ localPort: lp, remotePort: port, timeoutMs: 12000 })
        closeTunnel = t.close
        via = `ssh tunnel 127.0.0.1:${lp} -> ${config.ssh.host}:${port}`
        client = makeHttpClient(svc, { baseUrl: `http://127.0.0.1:${lp}`, dataDir: config.dataDir })
      } else {
        add('fail', `${name}: no url and ssh is unavailable — it cannot be reached`)
        continue
      }
      const h = await client.healthz()
      const vitals = h && typeof h === 'object' ? Object.entries(h).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ') : ''
      add('ok', `${name}: /healthz answered via ${via}${vitals ? ` (${vitals})` : ''}`)
      if (checkLogin) {
        try { await client.login(); add('ok', `${name}: credentials accepted (user "${svc.username}")`) } catch (err) { add('fail', `${name}: login failed — ${err.message}`) }
      } else {
        add('skip', `${name}: credential check skipped (re-run with --login to spend ONE real login)`)
      }
    } catch (err) {
      add('fail', `${name}: ${err.message}`)
    } finally {
      if (closeTunnel) { try { closeTunnel() } catch {} }
    }
  }

  // --- 4. docs corpus ---
  const docsIndex = buildDocsIndex(config.docsDir)
  if (docsIndex.docs.length) add('ok', `docs: ${docsIndex.docs.length} documents indexed at ${config.docsDir}`)
  else add('warn', `docs: nothing found at ${config.docsDir} — run from a repo checkout or set docsDir; docs_search will be empty`)

  // --- 5. what the AI client will see ---
  const groups = []
  if (config.panel) groups.push('panel_*')
  if (config.broadcaster) groups.push('broadcaster_*')
  if (config.reseller) groups.push('reseller_*')
  if (config.library) groups.push('library_*')
  if (config.ssh) groups.push('server_*', 'repeater_*')
  groups.push('diagnose_*', 'docs_search')
  out('')
  out('Enabled tool groups: ' + groups.join('  '))
  out(`Resources: ${docsIndex.docs.length} docs + mcp://aliran/guide`)
  out(`Prompts: ${PROMPTS.length} guided runbooks (${PROMPTS.map((p) => p.name).join(', ')})`)

  // --- 6. the paste-ready client wiring (the server is client-agnostic: any MCP
  // client that can launch a local stdio server works — these are the big ones) ---
  const entry = path.resolve(fileURLToPath(new URL('./index.js', import.meta.url)))
  const jsonSnippet = JSON.stringify({
    mcpServers: { aliran: { command: 'node', args: [entry, '--config', config.configPath] } }
  }, null, 2)
  // TOML literal (single-quoted) strings: no escape processing, so Windows
  // backslash paths survive verbatim.
  const tq = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  out('')
  out('Wire it into your MCP client — any MCP client works; the server is client-agnostic.')
  out('')
  out('JSON ("mcpServers" shape) — Claude Desktop, Cursor, Windsurf, Cline, Gemini CLI:')
  out(jsonSnippet)
  out('  Claude Desktop : claude_desktop_config.json (Settings -> Developer -> Edit Config)')
  out('  Cursor         : ~/.cursor/mcp.json (or .cursor/mcp.json per project)')
  out('  Windsurf       : ~/.codeium/windsurf/mcp_config.json')
  out('  Cline          : the extension\'s MCP settings (cline_mcp_settings.json)')
  out('  Gemini CLI     : ~/.gemini/settings.json (add the "mcpServers" key)')
  out('')
  out('Codex CLI — ~/.codex/config.toml:')
  out('[mcp_servers.aliran]')
  out('command = "node"')
  out(`args = [${tq(entry)}, '--config', ${tq(config.configPath)}]`)
  out('')
  out('VS Code (Copilot agent mode) — .vscode/mcp.json:')
  out(JSON.stringify({ servers: { aliran: { type: 'stdio', command: 'node', args: [entry, '--config', config.configPath] } } }, null, 2))
  out('')
  out('One-liners:')
  out(`  Claude Code : claude mcp add aliran -- node ${entry} --config ${config.configPath}`)
  out(`  Codex CLI   : codex mcp add aliran -- node ${entry} --config ${config.configPath}`)
  out('')
  out('NOTE: destructive-tool confirmations (MCP destructiveHint) are ADVISORY — clients')
  out('differ in whether they prompt before purge/stop/update tools. Verify yours does,')
  out('or phrase destructive intent explicitly. Secrets are safe regardless (enforced')
  out('server-side: no tool result ever contains a password or private key).')

  const failures = checks.filter((c) => c.level === 'fail').length
  out('')
  if (failures) {
    out(`RESULT: ${failures} check(s) FAILED — fix the [FAIL] lines above and re-run.`)
  } else {
    out('RESULT: all checks passed. Next steps:')
    out('  1. Paste the snippet for YOUR client above, then fully restart that client.')
    out('  2. Look for the tools icon in a new conversation — "aliran" should list its tools.')
    out('  3. Try: "What is the status of my Aliran panel?" or "Search the Aliran docs for backups".')
    out('  4. Fresh box? Say: "Run a preflight check on my server, then install Aliran on it."')
  }
  return { failures, checks }
}
