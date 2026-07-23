// Repeater config (env-driven). Mirrors broadcaster/src/config.js style.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadDotEnv () {
  const envPath = path.join(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}
loadDotEnv()

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10))
// An "MB" env knob in bytes. Garbage or a negative value disables that direction rather
// than throwing — socket tuning must never be the reason the repeater fails to boot.
const mib = (v, d) => { const n = int(v, d); return Number.isFinite(n) && n > 0 ? n * 1048576 : 0 }

export const config = {
  dataDir: process.env.DATA_DIR || './data',
  // The panel whose public catalog names the channels (same key viewers use).
  panelPubKey: process.env.PANEL_PUBKEY || null,
  // Channel selection: 'all' (default), a comma-separated streamId list
  // ('ch1,ch2'), or a category filter ('category:news' / 'category:news,sports').
  channels: process.env.CHANNELS || 'all',
  // How much of each channel's live window to keep, in seconds. MAY be deeper than
  // the origin's own HLS window — a regional blip-recovery buffer. Storage per
  // channel ≈ bitrate × retention (e.g. 3 Mbit/s × 300 s ≈ 110 MB).
  retentionSeconds: int(process.env.RETENTION_SECONDS, 300),
  // Swarm connection budget. A repeater exists to absorb fan-out, so the default is
  // high (hundreds) — the opposite of a viewer. This is the same knob as the
  // broadcaster's SWARM_MAX_PEERS, but here ONE swarm carries every mirrored channel.
  swarmMaxPeers: int(process.env.SWARM_MAX_PEERS, 256),
  // Swarm UDP socket buffers, in MB (0 = leave that direction alone). UDX carries every
  // peer stream over ONE socket pair, so on a box whose entire job is fan-out the send
  // buffer is the first thing to overflow — and an overflow is a silent kernel packet
  // drop. The default is higher than the broadcaster's for that reason. The host must
  // permit it via net.core.{r,w}mem_max (deploy/sysctl/99-aliran.conf) or the request is
  // clamped without error; a warning at startup names the exact sysctl. See net-tune.js.
  swarmRcvBuf: mib(process.env.SWARM_RCVBUF_MB, 4),
  swarmSndBuf: mib(process.env.SWARM_SNDBUF_MB, 4),
  // Periodic one-line status log per channel. 0 disables it.
  statusIntervalSeconds: int(process.env.STATUS_INTERVAL_SECONDS, 60),
  // Opt-in health/metrics HTTP server. Default OFF (0) — a stock repeater opens NO
  // listening sockets, and that property is part of its co-tenancy/trust story. Set
  // STATUS_PORT to serve GET /healthz + /metrics; loopback-only unless STATUS_HOST
  // is widened (do that only on a network you control — the endpoints are unauthenticated).
  statusHost: process.env.STATUS_HOST || '127.0.0.1',
  statusPort: int(process.env.STATUS_PORT, 0),
  bootstrap: (process.env.BOOTSTRAP || '')
    .split(',').map(s => s.trim()).filter(Boolean)
}

// --- Fail-fast validation ---
// A typo'd env var must be a clear boot error naming the variable (the Repeater
// constructor re-validates what it consumes — this catches the rest at boot).
// mib() stays permissive by design (tuning must never stop boot).
const problems = []
const chkInt = (name, v, min, max) => {
  if (!Number.isInteger(v)) problems.push(`${name} must be an integer (got "${process.env[name]}")`)
  else if (min !== undefined && v < min) problems.push(`${name} must be >= ${min} (got ${v})`)
  else if (max !== undefined && v > max) problems.push(`${name} must be <= ${max} (got ${v})`)
}
const chkBootstrap = (name, list) => {
  for (const e of list) {
    const m = e.match(/^(.+):(\d+)$/)
    if (!m || +m[2] < 1 || +m[2] > 65535) problems.push(`${name} entries must be host:port (got "${e}")`)
  }
}
if (config.panelPubKey && !/^[0-9a-f]{64}$/i.test(config.panelPubKey)) {
  problems.push(`PANEL_PUBKEY must be 64 hex chars (got ${config.panelPubKey.length} chars)`)
}
chkInt('RETENTION_SECONDS', config.retentionSeconds, 1)
chkInt('SWARM_MAX_PEERS', config.swarmMaxPeers, 1)
chkInt('STATUS_INTERVAL_SECONDS', config.statusIntervalSeconds, 0)
chkInt('STATUS_PORT', config.statusPort, 0, 65535)
chkBootstrap('BOOTSTRAP', config.bootstrap)
if (problems.length) {
  throw new Error('repeater: invalid configuration —\n  - ' + problems.join('\n  - '))
}

export default config
