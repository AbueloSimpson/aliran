// EPG service config (env-driven). Mirrors library/src/config.js style: .env loaded
// beside the package, fail-fast validation naming the variable, --check dry-run.
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
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes)$/i.test(v))
const mib = (v, d) => { const n = int(v, d); return Number.isFinite(n) && n > 0 ? n * 1048576 : 0 }

export const config = {
  dataDir: process.env.DATA_DIR || './data',
  panelPubKey: process.env.PANEL_PUBKEY || null,
  // Publisher identity for the ONE panel write this service makes (meta/epgKey).
  // Enroll it in the panel with scope `epg` — the setEpgKey responder demands that
  // scope, so a compromised guide key can never touch a stream registration.
  publisherKey: process.env.PUBLISHER_KEY || null,
  publisherName: process.env.PUBLISHER_NAME || null,
  // Epoch rotation (growth control): the guide drive is append-only internally, so a
  // fresh drive is minted every EPOCH_DAYS and the old one purged after GRACE_HOURS
  // (viewers that were offline across the flip fall back to https until they see the
  // new pointer). See docs/kb/scaling.md for the growth law.
  epochDays: int(process.env.EPOCH_DAYS, 30),
  graceHours: int(process.env.GRACE_HOURS, 48),
  // How many days ahead the published guide covers. Days older than yesterday are
  // dropped at ingest — the drive holds a sliding window, not an archive.
  guideDays: int(process.env.GUIDE_DAYS, 7),
  // Ingest providers: a JSON file, not env — a provider list carries urls/overrides
  // that do not fit env vars. See providers.example.json.
  providersFile: process.env.PROVIDERS_FILE || './providers.json',
  refreshHours: int(process.env.REFRESH_HOURS, 6), // default cadence; per-provider override
  // Ephemeral event channels (panel/src/events.js) are NOT in the panel catalog, so the
  // epgId -> streamId mapping cannot find them by reading catalog/* alone. This is how
  // often the events drive's index is re-read to pick up the ones that are. Deliberately
  // POLLED and not watched: a second bee.watch(range) is a second watcher to go deaf at a
  // panel fork (docs/kb/panel-bee-compaction.md), and the index is one small file. Set 0
  // to switch the whole events mapping off; a panel with no ephemeral source advertises no
  // meta/eventsKey and this costs one bee read per interval either way.
  eventsRefreshMinutes: int(process.env.EVENTS_REFRESH_MINUTES, 10),
  swarmMaxPeers: int(process.env.SWARM_MAX_PEERS, 256),
  swarmRcvBuf: mib(process.env.SWARM_RCVBUF_MB, 4),
  swarmSndBuf: mib(process.env.SWARM_SNDBUF_MB, 4),
  bootstrap: (process.env.BOOTSTRAP || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  status: {
    enabled: bool(process.env.STATUS_ENABLED, false),
    host: process.env.STATUS_HOST || '127.0.0.1',
    port: int(process.env.STATUS_PORT, 3340)
  }
}

// --- Fail-fast validation (library/src/config.js conventions) ---
const problems = []
const chkInt = (name, v, min, max) => {
  if (!Number.isInteger(v)) problems.push(`${name} must be an integer (got "${process.env[name]}")`)
  else if (min !== undefined && v < min) problems.push(`${name} must be >= ${min} (got ${v})`)
  else if (max !== undefined && v > max) problems.push(`${name} must be <= ${max} (got ${v})`)
}
const chkHex = (name, v, lengths) => {
  if (v && !(lengths.includes(v.length) && /^[0-9a-f]+$/i.test(v))) {
    problems.push(`${name} must be ${lengths.join(' or ')} hex chars (got ${v.length} chars)`)
  }
}
chkHex('PANEL_PUBKEY', config.panelPubKey, [64])
chkHex('PUBLISHER_KEY', config.publisherKey, [64, 128])
chkInt('EPOCH_DAYS', config.epochDays, 1)
chkInt('GRACE_HOURS', config.graceHours, 1)
// Exactly ONE retired epoch is grace-served at a time (guide.js keeps a single _prevDrive),
// which holds only while a grace window closes before the next epoch is minted. Let
// GRACE_HOURS reach a whole epoch and a predecessor still inside its window would stop
// being announced the moment the next rotation landed — viewers that missed the pointer
// flip would fall back to https with no sign anything was wrong. It also triples what the
// epoch rotation exists to bound. Reject it here rather than half-honour it at runtime.
if (Number.isInteger(config.epochDays) && Number.isInteger(config.graceHours) && config.graceHours >= config.epochDays * 24) {
  problems.push(`GRACE_HOURS must be less than EPOCH_DAYS x 24 (got GRACE_HOURS=${config.graceHours} with EPOCH_DAYS=${config.epochDays}) — only one retired epoch is grace-served at a time`)
}
chkInt('GUIDE_DAYS', config.guideDays, 1, 30)
chkInt('REFRESH_HOURS', config.refreshHours, 1)
chkInt('EVENTS_REFRESH_MINUTES', config.eventsRefreshMinutes, 0)
chkInt('SWARM_MAX_PEERS', config.swarmMaxPeers, 1)
chkInt('STATUS_PORT', config.status.port, 0, 65535)
for (const e of config.bootstrap) {
  const m = e.match(/^(.+):(\d+)$/)
  if (!m || +m[2] < 1 || +m[2] > 65535) problems.push(`BOOTSTRAP entries must be host:port (got "${e}")`)
}

const checkRun = process.argv.includes('--check') && process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (checkRun) {
  if (problems.length) {
    process.stdout.write('epg: invalid configuration —\n  - ' + problems.join('\n  - ') + '\n')
    process.exit(1)
  }
  process.stdout.write('epg: configuration OK\n')
  process.exit(0)
}
if (problems.length) {
  throw new Error('epg: invalid configuration —\n  - ' + problems.join('\n  - '))
}

export default config
