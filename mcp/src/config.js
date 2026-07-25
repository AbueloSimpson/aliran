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
//     "reseller":    { "url": "...", "user": "...", "pass": "..." },   // optional (S49b)
//     "library":     { "url": "...", "user": "...", "pass": "..." },   // optional (S49b)
//     "ssh":         { "host": "...", "user": "root", "keyPath": "~/.ssh/id", "port": 22,
//                      "hosts": { "edge-1": { "host": "...", "user": "root", "keyPath": "...", "repoDir": "/opt/aliran" } } },
//     "install":     { "repoDir": "/opt/aliran", "composeProfiles": [] }
//   }
//
// `url` is optional per service: if omitted, that service's loopback API on the box
// (:3210 panel / :3310 broadcaster / :3330 reseller / :3320 library) is reached over
// an SSH local-forward tunnel opened with the same key (index.js). Give an explicit
// `url` (a Caddy TLS endpoint) to skip the tunnel. `reseller`/`library` are for
// deployments actually running those services; the reseller credentials should be
// the ROOT admin principal (the operator-oversight identity).
//
// Multi-host (S49c): `ssh.hosts` optionally names EXTRA boxes — repeater appliances,
// scale-out broadcasters. Each name becomes a valid `host` parameter on the server_*
// tools, repeater_status and panel_add_publisher; the top-level host/user stay the
// DEFAULT box, so a single-host config keeps meaning exactly what it always did.
// Alternatively give ONLY `hosts` plus `default: "<name>"` (implicit with a single
// entry) and the named default is hoisted. A host entry may carry its own `repoDir`
// (falls back to install.repoDir) and `keyPath`/`port`.
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
    reseller: normalizeBearer('reseller', obj.reseller),
    library: normalizeBearer('library', obj.library),
    ssh: normalizeSsh(obj.ssh),
    install: normalizeInstall(obj.install)
  }

  if (!cfg.panel && !cfg.broadcaster && !cfg.reseller && !cfg.library && !cfg.ssh) {
    throw new ConfigError('config enables nothing: give at least one of "panel", "broadcaster", "reseller", "library", or "ssh"')
  }
  // A service reached by tunnel (no url) needs SSH to open that tunnel.
  for (const svc of ['panel', 'broadcaster', 'reseller', 'library']) {
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
  // sshBin lets a caller (and the test suite) substitute the ssh binary — the
  // command-stub seam. String → one executable; array → [bin, ...prefixArgs].
  // Resolvable per host entry (each fake box in the test seam is its own stub state).
  const sshBinOf = (bin) => {
    const sshBin = bin || v.sshBin || process.env.ALIRAN_MCP_SSH_BIN || 'ssh'
    if (typeof sshBin === 'string' && sshBin.includes('\x00')) throw new ConfigError('"ssh.sshBin" invalid')
    return sshBin
  }
  const entryOf = (label, e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new ConfigError(`${label} must be an object`)
    if (!e.host || !e.user) throw new ConfigError(`${label} needs "host" and "user"`)
    return {
      host: String(e.host),
      user: String(e.user),
      keyPath: e.keyPath ? expandHome(String(e.keyPath)) : null,
      port: e.port ? Number(e.port) : null,
      // Per-box checkout dir (repeaters / scale-out boxes may differ); null =
      // fall back to install.repoDir (index.js repoDirFor).
      repoDir: e.repoDir ? String(e.repoDir) : null,
      sshBin: sshBinOf(e.sshBin)
    }
  }

  // Named hosts (multi-host, S49c). Each name is a valid `host` parameter value on
  // the server_* tools, repeater_status and panel_add_publisher.
  let hosts = null
  if (v.hosts != null) {
    if (typeof v.hosts !== 'object' || Array.isArray(v.hosts)) throw new ConfigError('"ssh.hosts" must be an object: {"<name>": {"host": …, "user": …}}')
    hosts = {}
    for (const [name, e] of Object.entries(v.hosts)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(name)) throw new ConfigError(`"ssh.hosts" name "${name}" is invalid — letters/digits/_.- only, max 32 chars, starting with a letter or digit`)
      hosts[name] = { name, ...entryOf(`"ssh.hosts.${name}"`, e) }
    }
    if (!Object.keys(hosts).length) hosts = null
  }

  // The DEFAULT box: the top-level host/user (the original single-host shape), or —
  // in a hosts-only config — the entry `default` names (implicit when there is
  // exactly one). The default is hoisted onto the top level, so every existing
  // consumer keeps reading ssh.host/user/keyPath/port/sshBin unchanged.
  let base
  let defaultName = null
  if (v.host != null || v.user != null) {
    if (v.default != null) throw new ConfigError('"ssh.default" only applies to a hosts-only config — with a top-level "host", the top level IS the default box')
    base = entryOf('"ssh"', v)
  } else {
    if (!hosts) throw new ConfigError('"ssh" needs "host" and "user" (or a "hosts" map of named boxes)')
    const names = Object.keys(hosts)
    defaultName = v.default != null ? String(v.default) : (names.length === 1 ? names[0] : null)
    if (!defaultName) throw new ConfigError(`"ssh.hosts" has ${names.length} entries and no top-level "host" — name the default box with "ssh.default"`)
    if (!hosts[defaultName]) throw new ConfigError(`"ssh.default" names "${defaultName}" but "ssh.hosts" has no such entry (configured: ${names.join(', ')})`)
    base = hosts[defaultName]
  }
  return { ...base, hosts, defaultName }
}

function normalizeInstall (v) {
  const repoDir = (v && v.repoDir) ? String(v.repoDir) : '/opt/aliran'
  let composeProfiles = (v && v.composeProfiles) || []
  if (!Array.isArray(composeProfiles)) throw new ConfigError('"install.composeProfiles" must be an array')
  return { repoDir, composeProfiles: composeProfiles.map(String) }
}

// The shipped docs corpus (docs/ + docs/kb/) resolved from this package's location.
// Chain (S49c, for the published package): a repo checkout's live docs/ first (mcp/
// is a sibling of docs/ — always current), else the docs-bundle/ snapshot that
// `npm pack` bakes into the tarball (mcp/scripts/bundle-docs.mjs). Missing both →
// resources degrade to empty and doctor/docs_search say so.
function defaultDocsDir () {
  const here = path.dirname(new URL(import.meta.url).pathname)
  // On Windows the URL path is /C:/... — strip the leading slash.
  const dir = process.platform === 'win32' && /^\/[A-Za-z]:/.test(here) ? here.slice(1) : here
  const repoDocs = path.resolve(dir, '..', '..', 'docs')
  if (fs.existsSync(repoDocs)) return repoDocs
  const bundled = path.resolve(dir, '..', 'docs-bundle')
  if (fs.existsSync(bundled)) return bundled
  return repoDocs
}
