#!/usr/bin/env node
// Aliran MCP server — stdio bootstrap.
//
// Exposes the panel admin API, the broadcaster control API, an SSH install/
// maintenance executor, and the shipped docs as Model Context Protocol tools/
// resources, so an AI client (Claude Desktop, Claude Code) can install, configure,
// maintain and support an Aliran deployment. It is the SERVER side of MCP — it does
// NOT call the Claude API.
//
//   node src/index.js --config <path>        (or set ALIRAN_MCP_CONFIG)
//
// Transport is local stdio: stdout is the MCP wire, so ALL diagnostics go to stderr.
// Secrets live only in the config file and are never placed in a tool result.

import net from 'net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { resolveConfigPath, loadConfig, ConfigError } from './config.js'
import { makeHttpClient } from './http-client.js'
import { makeSsh } from './ssh.js'
import { buildDocsIndex } from './resources/docs.js'
import { registerDocs } from './resources/docs.js'
import { registerPanelTools } from './tools/panel.js'
import { registerBroadcasterTools } from './tools/broadcaster.js'
import { registerServerTools, upsertEnv } from './tools/server.js'
import { registerDiagnoseTools } from './tools/diagnose.js'

const VERSION = '0.0.1'
const logerr = (m) => process.stderr.write(`[aliran-mcp] ${m}\n`)

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
}

// MCP tool-result helpers + a registration wrapper that turns any thrown error into
// a clean isError result (ApiError/SshError messages are already operator-readable).
function makeHelpers (server) {
  const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] })
  const fail = (msg) => ({ content: [{ type: 'text', text: String(msg) }], isError: true })
  const def = (name, cfg, fn) => {
    server.registerTool(name, cfg, async (args, extra) => {
      try { return await fn(args || {}, extra) } catch (e) { return fail((e && e.message) || String(e)) }
    })
  }
  return { ok, fail, def }
}

async function main () {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stderr.write('Aliran MCP server\n  node src/index.js --config <path>              start (stdio MCP server)\n  node src/index.js --doctor [--login] --config <path>   onboarding self-check\n  (or set ALIRAN_MCP_CONFIG). See mcp/README.md, mcp/config.example.json and docs/mcp-quickstart.md.\n')
    return
  }
  if (process.argv.includes('--version')) { process.stderr.write(VERSION + '\n'); return }

  let config
  try {
    config = loadConfig(resolveConfigPath(), { logger: logerr })
  } catch (err) {
    if (err instanceof ConfigError) {
      // Doctor mode reports on stdout — it is run by a human, not an MCP client.
      const say = process.argv.includes('--doctor') ? (m) => process.stdout.write(m + '\n') : logerr
      say('[FAIL] config error: ' + err.message)
      process.exitCode = 2
      return
    }
    throw err
  }

  // Onboarding self-check: validate + probe, print the client wiring, exit.
  // Never connects the MCP transport, so stdout is safe to use here.
  if (process.argv.includes('--doctor')) {
    const { runDoctor } = await import('./doctor.js')
    const res = await runDoctor(config, { checkLogin: process.argv.includes('--login') })
    process.exitCode = res.failures ? 1 : 0
    return
  }

  const tunnels = []
  const ssh = config.ssh ? makeSsh(config.ssh) : null

  // Resolve reachability: explicit url wins; otherwise open an SSH local-forward
  // tunnel to the loopback API on the box (needs the ssh block). A service whose
  // tunnel can't be opened is left unconfigured (its tools aren't registered).
  async function clientFor (svc, remotePort) {
    if (!svc) return null
    if (svc.url) return makeHttpClient(svc, { dataDir: config.dataDir })
    try {
      const localPort = await freePort()
      const t = await ssh.openTunnel({ localPort, remotePort })
      tunnels.push(t)
      logerr(`opened SSH tunnel 127.0.0.1:${localPort} -> ${config.ssh.host}:${remotePort} for ${svc.name}`)
      return makeHttpClient(svc, { baseUrl: `http://127.0.0.1:${localPort}`, dataDir: config.dataDir })
    } catch (err) {
      logerr(`could not reach ${svc.name} (${err.message}) — its tools are disabled`)
      return null
    }
  }

  const panel = await clientFor(config.panel, 3210)
  const broadcaster = await clientFor(config.broadcaster, 3310)
  const docsIndex = buildDocsIndex(config.docsDir)

  const ctx = {
    config,
    panel,
    broadcaster,
    ssh,
    docsIndex,
    upsertEnv: ssh ? (path, pairs) => upsertEnv(ssh, path, pairs, { cwd: config.install.repoDir }) : null
  }

  const server = new McpServer({ name: 'aliran-mcp', version: VERSION }, {
    instructions: 'Operate an Aliran deployment: panel_* (viewer accounts, grants, channel packages, streams, sources, publishers), broadcaster_* (channels/start/stop/rotate/logs), server_* (SSH install/update/backup/diagnostics), diagnose_*, and docs_search + the mcp://aliran/* resources. Prefer docs_search for usage questions. Secrets stay in the operator config — you only see tool results.'
  })
  const h = makeHelpers(server)

  registerDocs(server, docsIndex, h)
  registerDiagnoseTools(ctx, h)
  if (panel) registerPanelTools(ctx, h); else logerr('panel not configured — panel_* tools disabled')
  if (broadcaster) registerBroadcasterTools(ctx, h); else logerr('broadcaster not configured — broadcaster_* tools disabled')
  if (ssh) registerServerTools(ctx, h); else logerr('ssh not configured — server_* tools disabled')

  const transport = new StdioServerTransport()
  const shutdown = () => { for (const t of tunnels) { try { t.close() } catch {} } }
  transport.onclose = () => { shutdown(); process.exit(0) }
  process.on('SIGINT', () => { shutdown(); process.exit(0) })
  process.on('SIGTERM', () => { shutdown(); process.exit(0) })

  await server.connect(transport)
  logerr(`ready (panel:${!!panel} broadcaster:${!!broadcaster} ssh:${!!ssh} docs:${docsIndex.docs.length})`)
}

main().catch((err) => { logerr('fatal: ' + (err && err.stack || err)); process.exit(1) })
