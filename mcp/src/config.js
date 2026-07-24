// Config loading for the Aliran MCP server.
//
// The config file is the ONLY place secrets live (panel/broadcaster admin
// passwords, the SSH private-key path). It is read once at startup; the model
// driving this server never sees it — only tool RESULTS. Path comes from
// `--config <path>` or $ALIRAN_MCP_CONFIG. JSON shape (see config.example.json):
//
//   {
//     "panel":       { "url": "...", "user": "...", "pass": "..." },
//     "broadcaster": { "url": "...", "user": "...", "pass": "..." },
//     "ssh":         { "host": "...", "user": "root", "keyPath": "~/.ssh/id", "port": 22 },
//     "install":     { "repoDir": "/opt/aliran", "composeProfiles": [] }
//   }
//
// `url` is optional per service: if omitted, the panel/broadcaster loopback API
// (:3210 / :3310) is reached over an SSH local-forward tunnel opened with the same
// key (index.js). Give an explicit `url` (a Caddy TLS endpoint) to skip the tunnel.
// The file MUST be 0600 — it is the operator's credential store.

import fs from 'fs'
import os from 'os'
import path from 'path'

export class ConfigError extends Error {
  constructor (message) { super(message); this.code = 'config' }
}

// Resolve the config path from argv (`--config <path>`) or $ALIRAN_MCP_CONFIG.
export function resolveConfigPath (argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--config')
  if (i !== -1) {
    if (!argv[i + 1]) throw new ConfigError('--config needs a path argument')
    return path.resolve(expandHome(argv[i + 1]))
  }
  const eq = argv.find((a) => a.startsWith('--config='))
  if (eq) return path.resolve(expandHome(eq.slice('--config='.length)))
  if (env.ALIRAN_MCP_CONFIG) return path.resolve(expandHome(env.ALIRAN_MCP_CONFIG))
  throw new ConfigError('no config: pass --config <path> or set ALIRAN_MCP_CONFIG')
}

function expandHome (p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

// Warn (stderr, never stdout — stdout is the MCP wire) if a POSIX config file is
// readable by group/other. Not fatal: an operator can fix it, and hard-failing
// mid-session is worse UX than a loud warning with the exact fix.
function warnIfLoose (file, logger) {
  if (process.platform === 'win32') return
  let st
  try { st = fs.statSync(file) } catch { return }
  if ((st.mode & 0o077) !== 0) {
    logger(`WARNING: ${file} is group/other-readable (mode ${(st.mode & 0o777).toString(8)}) — it holds admin passwords and the SSH key path. Fix: chmod 600 ${file}`)
  }
}

// Load + normalize. `logger` writes diagnostics to stderr. Returns a normalized
// config; throws ConfigError on a structurally invalid file.
export function loadConfig (file, { logger = (m) => process.stderr.write(m + '\n') } = {}) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (err) {
    throw new ConfigError(`cannot read config ${file}: ${err.message}`)
  }
  warnIfLoose(file, logger)
  let obj
  try { obj = JSON.parse(raw) } catch (err) {
    throw new ConfigError(`config ${file} is not valid JSON: ${err.message}`)
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ConfigError('config must be a JSON object')

  const cfg = {
    configPath: file,
    // Token caches + any local state live beside the config, owner-only.
    dataDir: obj.dataDir ? path.resolve(expandHome(obj.dataDir)) : path.join(path.dirname(file), '.aliran-mcp-state'),
    docsDir: obj.docsDir ? path.resolve(expandHome(obj.docsDir)) : defaultDocsDir(),
    panel: normalizeBearer('panel', obj.panel),
    broadcaster: normalizeBearer('broadcaster', obj.broadcaster),
    ssh: normalizeSsh(obj.ssh),
    install: normalizeInstall(obj.install)
  }

  if (!cfg.panel && !cfg.broadcaster && !cfg.ssh) {
    throw new ConfigError('config enables nothing: give at least one of "panel", "broadcaster", or "ssh"')
  }
  // A service reached by tunnel (no url) needs SSH to open that tunnel.
  for (const svc of ['panel', 'broadcaster']) {
    if (cfg[svc] && !cfg[svc].url && !cfg.ssh) {
      throw new ConfigError(`"${svc}" has no "url" and there is no "ssh" block to tunnel through — add a url (e.g. a Caddy TLS endpoint) or an ssh block`)
    }
  }
  return cfg
}

function normalizeBearer (name, v) {
  if (v == null) return null
  if (typeof v !== 'object' || Array.isArray(v)) throw new ConfigError(`"${name}" must be an object`)
  const username = v.user ?? v.username
  const password = v.pass ?? v.password
  if (!username || !password) throw new ConfigError(`"${name}" needs "user" and "pass"`)
  const url = v.url ? String(v.url).replace(/\/+$/, '') : null
  if (url && !/^https?:\/\//.test(url)) throw new ConfigError(`"${name}.url" must start with http:// or https://`)
  return { name, url, username: String(username), password: String(password), timeoutMs: v.timeoutMs || 15000 }
}

function normalizeSsh (v) {
  if (v == null) return null
  if (typeof v !== 'object' || Array.isArray(v)) throw new ConfigError('"ssh" must be an object')
  if (!v.host || !v.user) throw new ConfigError('"ssh" needs "host" and "user"')
  // sshBin lets a caller (and the test suite) substitute the ssh binary — the
  // command-stub seam. String → one executable; array → [bin, ...prefixArgs].
  let sshBin = v.sshBin || process.env.ALIRAN_MCP_SSH_BIN || 'ssh'
  if (typeof sshBin === 'string' && sshBin.includes('\x00')) throw new ConfigError('"ssh.sshBin" invalid')
  return {
    host: String(v.host),
    user: String(v.user),
    keyPath: v.keyPath ? expandHome(String(v.keyPath)) : null,
    port: v.port ? Number(v.port) : null,
    sshBin
  }
}

function normalizeInstall (v) {
  const repoDir = (v && v.repoDir) ? String(v.repoDir) : '/opt/aliran'
  let composeProfiles = (v && v.composeProfiles) || []
  if (!Array.isArray(composeProfiles)) throw new ConfigError('"install.composeProfiles" must be an array')
  return { repoDir, composeProfiles: composeProfiles.map(String) }
}

// The shipped docs corpus (docs/ + docs/kb/) resolved from this package's location
// (repo checkout: mcp/ is a sibling of docs/). Missing → resources degrade to empty.
function defaultDocsDir () {
  const here = path.dirname(new URL(import.meta.url).pathname)
  // On Windows the URL path is /C:/... — strip the leading slash.
  const dir = process.platform === 'win32' && /^\/[A-Za-z]:/.test(here) ? here.slice(1) : here
  return path.resolve(dir, '..', '..', 'docs')
}
