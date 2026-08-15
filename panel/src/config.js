// Minimal .env loader + typed config for the Aliran panel.
// No external dependency: reads process.env (populate it however you like, e.g. a
// process manager, Docker env, or a tiny dotenv parser below).

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Tiny .env parser (no dependency). Loads panel/.env if present.
function loadDotEnv () {
  const envPath = path.join(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}

loadDotEnv()

const bool = (v, d) => (v === undefined ? d : /^(1|true|yes)$/i.test(v))
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10))
// An "MB" env knob in bytes. Garbage or a negative value disables that direction rather
// than throwing — socket tuning must never be the reason the panel fails to boot.
const mib = (v, d) => { const n = int(v, d); return Number.isFinite(n) && n > 0 ? n * 1048576 : 0 }

export const config = {
  dataDir: process.env.DATA_DIR || './data',
  // Config snapshots + the disaster-recovery archive listing (see
  // docs/kb/backup-and-rotation.md).
  //
  //   backupDir  where deploy/backup.sh writes its archives, AS SEEN FROM THIS SERVICE.
  //              docker-compose bind-mounts the host's ./backups here READ-ONLY, so the
  //              dashboard can LIST them. It is read-only on purpose: making an archive
  //              means stopping this service, which a service cannot do to itself and
  //              still answer the request. A missing directory is reported honestly
  //              rather than shown as "no backups".
  //   snapshotKeep  how many on-box config snapshots to keep. They are taken
  //              automatically before bulk operations, so the directory needs a cap that
  //              somebody chose.
  backupDir: process.env.BACKUP_DIR || './backups',
  snapshotKeep: int(process.env.CONFIG_SNAPSHOT_KEEP, 20),
  relayOnly: bool(process.env.RELAY_ONLY, false),
  // The operator's service name. The panel shows it to a client that pairs with the
  // service pairing code, BEFORE any login — the viewer sees which service the 12
  // characters they typed reached. Public display text, nothing more.
  serviceName: (process.env.SERVICE_NAME || 'Aliran').trim().slice(0, 64),
  // Argon2id cost for VIEWER passwords — stamped into each user record at enrollment /
  // password set, and then GROUND ON THE VIEWER'S DEVICE at every typed login
  // (sdk/login.js verify): the panel's OPRF round is oblivious, so the verifier check
  // runs client-side at the recorded cost. 64 MiB / t=2 (libsodium "interactive") is the
  // ceiling a 1-2 GB 32-bit TV box can pay without seconds of frozen worklet; the old
  // 256 MiB / t=3 default assumed a server was paying it. Existing records keep the cost
  // they were stamped with until the next password set.
  argon2: {
    memKiB: int(process.env.ARGON2_MEM_KIB, 65536),
    time: int(process.env.ARGON2_TIME, 2)
  },
  maxDevicesDefault: int(process.env.MAX_DEVICES_DEFAULT, 2),
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
  // Accept UNNAMED register payloads signed with the shared keys/publisher.json key
  // (pre-S26 broadcasters). Set LEGACY_PUBLISHER=0 once every broadcaster is enrolled
  // as a named publisher (add-publisher) and carries PUBLISHER_NAME.
  legacyPublisher: bool(process.env.LEGACY_PUBLISHER, true),
  pow: { difficulty: int(process.env.POW_DIFFICULTY, 16) },
  lockout: {
    threshold: int(process.env.LOCKOUT_THRESHOLD, 10),
    seconds: int(process.env.LOCKOUT_SECONDS, 900)
  },
  // Swarm UDP socket buffers, in MB (0 = leave that direction alone). Every client
  // replicates the catalog bee over this ONE swarm, so its socket pair carries the whole
  // lineup's fan-out. See core/net-tune.js — the host must permit the size via
  // net.core.{r,w}mem_max or the request is silently clamped (a warning names the sysctl).
  swarmRcvBuf: mib(process.env.SWARM_RCVBUF_MB, 2),
  swarmSndBuf: mib(process.env.SWARM_SNDBUF_MB, 2),
  bootstrap: (process.env.BOOTSTRAP || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  admin: {
    enabled: bool(process.env.ADMIN_ENABLED, false),
    // Bind loopback by default. 0.0.0.0 is for a VPS behind a TLS reverse proxy —
    // the API itself is plain HTTP.
    host: process.env.ADMIN_HOST || '127.0.0.1',
    port: int(process.env.ADMIN_PORT, 3210),
    sessionTtlHours: int(process.env.ADMIN_SESSION_TTL_HOURS, 12),
    // The EPG service's status endpoint (epg/src/status-server.js, STATUS_ENABLED=1).
    // Set it and the dashboard's EPG tab shows the live service state — the panel
    // fetches it SERVER-side, so the URL stays operator config and the status port
    // can keep its loopback binding (same box / host networking reaches it).
    // Empty = the tab explains how to turn it on. The guide pointer half of that
    // tab (meta/epgKey) needs no config — it is this panel's own record.
    epgStatusUrl: process.env.EPG_STATUS_URL || ''
  },
  // Encrypted key escrow — getting DATA_DIR/keys/ off the box (src/escrow.js).
  // ONE flag, and it is OFF. Export over the admin API lowers identity exfiltration
  // from "shell access on the box" to "an authenticated admin session", so a
  // deployment that does not want that endpoint does not have it: the route 404s
  // like any unknown path until ESCROW_EXPORT=1. The CLI export needs shell access
  // already, so it stays available either way and changes no attacker's economics.
  // The Argon2id cost below protects the exported file, which lives outside every
  // control this box has — raise it freely, it is paid once per export. The
  // parameters travel INSIDE each file, so an old file always opens with its own.
  escrow: {
    exportEnabled: bool(process.env.ESCROW_EXPORT, false),
    argon2: {
      memMiB: int(process.env.ESCROW_ARGON2_MEM_MIB, 256), // libsodium MODERATE
      ops: int(process.env.ESCROW_ARGON2_OPS, 3)
    }
  },
  // Privacy-preserving analytics (S48): aggregate-only rollups under
  // DATA_DIR/analytics/, pruned to this many days. 0 disables collection
  // entirely (no files written, endpoints answer empty) — the one knob.
  analytics: {
    retentionDays: int(process.env.ANALYTICS_RETENTION_DAYS, 90)
  },
  // Viewer problem reports (S50): pseudonymous reports over the existing P2P RPC,
  // stored under DATA_DIR/reports/. RETENTION_DAYS=0 is the kill switch — the store
  // becomes a no-op that never touches disk AND the `report` responder is not
  // attached at all, so the method does not exist (a new client sees "unsupported",
  // exactly as against a pre-S50 panel). Defaults: ingest ON, notifications OFF —
  // an empty webhook URL / Telegram token means no notifier is configured (S50b).
  reports: {
    retentionDays: int(process.env.REPORTS_RETENTION_DAYS, 30),
    maxPerWindow: int(process.env.REPORTS_MAX_PER_WINDOW, 5), // per reporter…
    windowSeconds: int(process.env.REPORTS_WINDOW_SECONDS, 600), // …per this window
    alertCount: int(process.env.REPORTS_ALERT_COUNT, 3), // distinct reporters → alert
    alertWindowMin: int(process.env.REPORTS_ALERT_WINDOW_MIN, 10),
    stormSample: int(process.env.REPORTS_STORM_SAMPLE, 20), // records kept per storm
    globalPerMin: int(process.env.REPORTS_GLOBAL_PER_MIN, 120), // panel-wide breaker
    webhookUrl: process.env.REPORTS_WEBHOOK_URL || '',
    telegramBotToken: process.env.REPORTS_TELEGRAM_BOT_TOKEN || '', // SECRET
    telegramChatId: process.env.REPORTS_TELEGRAM_CHAT_ID || ''
  },
  // Remote channel sources (S27): provider JSON feeds and M3U playlists pulled on a
  // schedule.
  sources: {
    // Registry scan cadence — a due-check, never a fetch, so 5 minutes is cheap and it
    // is what makes a sub-hour per-source intervalMs (an event playlist) actually work.
    tickMs: int(process.env.SOURCES_TICK_MS, 300000),
    bootDelayMs: int(process.env.SOURCES_BOOT_DELAY_MS, 15000),
    defaultIntervalMs: int(process.env.SOURCES_SYNC_INTERVAL_MS, 86400000), // daily pull per source
    fetchTimeoutMs: int(process.env.SOURCES_FETCH_TIMEOUT_MS, 30000),
    maxBytes: int(process.env.SOURCES_MAX_BYTES, 5242880),
    maxChannels: int(process.env.SOURCES_MAX_CHANNELS, 500)
  },
  // Redirect-channel liveness probe (src/liveness.js): redirect channels have no
  // broadcaster heartbeat, so the panel probes their urls itself and flips isLive —
  // dead links dim in the viewer's list instead of spinning. 0 minutes disables.
  // Event playlists (dead between events by design) are why the default is 10 min:
  // undim happens on the first sweep after the event starts.
  liveness: {
    intervalMinutes: int(process.env.LIVENESS_INTERVAL_MINUTES, 10),
    timeoutMs: int(process.env.LIVENESS_TIMEOUT_MS, 8000),
    failsToFlip: int(process.env.LIVENESS_FAILS_TO_FLIP, 3),
    bootDelayMs: int(process.env.LIVENESS_BOOT_DELAY_MS, 90000)
  }
}

// --- Fail-fast validation ---
// A typo'd env var must be a clear boot error naming the variable — never a silent
// default, and never a NaN that resurfaces later as a weird timeout or port error.
const problems = []
const chkInt = (name, v, min, max) => {
  if (!Number.isInteger(v)) problems.push(`${name} must be an integer (got "${process.env[name]}")`)
  else if (min !== undefined && v < min) problems.push(`${name} must be >= ${min} (got ${v})`)
  else if (max !== undefined && v > max) problems.push(`${name} must be <= ${max} (got ${v})`)
}
const chkBool = (name) => {
  const v = process.env[name]
  if (v !== undefined && v !== '' && !/^(1|true|yes|0|false|no)$/i.test(v)) {
    problems.push(`${name} must be one of 1/true/yes/0/false/no (got "${v}")`)
  }
}
// An optional outbound URL knob: empty = feature off, otherwise it must be a real
// http(s) URL. A typo'd webhook must fail at boot, not silently never notify.
const chkUrl = (name, v) => {
  if (!v) return
  let u = null
  try { u = new URL(v) } catch {}
  if (!u || !/^https?:$/.test(u.protocol)) problems.push(`${name} must be an http(s) URL (got "${v}")`)
}
const chkBootstrap = (name, list) => {
  for (const e of list) {
    const m = e.match(/^(.+):(\d+)$/)
    if (!m || +m[2] < 1 || +m[2] > 65535) problems.push(`${name} entries must be host:port (got "${e}")`)
  }
}

chkBool('RELAY_ONLY'); chkBool('ADMIN_ENABLED'); chkBool('LEGACY_PUBLISHER'); chkBool('ESCROW_EXPORT')
chkInt('ARGON2_MEM_KIB', config.argon2.memKiB, 8)
chkInt('ARGON2_TIME', config.argon2.time, 1)
chkInt('MAX_DEVICES_DEFAULT', config.maxDevicesDefault, 1)
chkInt('SESSION_TTL_DAYS', config.sessionTtlDays, 1)
chkInt('POW_DIFFICULTY', config.pow.difficulty, 0, 32)
chkInt('LOCKOUT_THRESHOLD', config.lockout.threshold, 1)
chkInt('LOCKOUT_SECONDS', config.lockout.seconds, 1)
chkInt('ADMIN_PORT', config.admin.port, 0, 65535)
// The floor is 8 MiB so a test lane can run the KDF fast. That is FAR below the
// 256 MiB default — anything under it weakens every file the panel exports, so the
// export response and the CLI both print the cost they used.
// The ceiling is libsodium's own (crypto_pwhash_MEMLIMIT_MAX, just under 4 GiB). Past
// it the derivation throws deep inside sodium at export time; a typo belongs here, at
// boot, naming the variable.
chkInt('ESCROW_ARGON2_MEM_MIB', config.escrow.argon2.memMiB, 8, 4095)
chkInt('ESCROW_ARGON2_OPS', config.escrow.argon2.ops, 1, 64)
chkInt('ANALYTICS_RETENTION_DAYS', config.analytics.retentionDays, 0)
chkInt('REPORTS_RETENTION_DAYS', config.reports.retentionDays, 0)
chkInt('REPORTS_MAX_PER_WINDOW', config.reports.maxPerWindow, 1)
chkInt('REPORTS_WINDOW_SECONDS', config.reports.windowSeconds, 1)
chkInt('REPORTS_ALERT_COUNT', config.reports.alertCount, 1)
chkInt('REPORTS_ALERT_WINDOW_MIN', config.reports.alertWindowMin, 1)
chkInt('REPORTS_STORM_SAMPLE', config.reports.stormSample, 1)
chkInt('REPORTS_GLOBAL_PER_MIN', config.reports.globalPerMin, 1)
chkUrl('REPORTS_WEBHOOK_URL', config.reports.webhookUrl)
chkInt('ADMIN_SESSION_TTL_HOURS', config.admin.sessionTtlHours, 1)
chkInt('SOURCES_TICK_MS', config.sources.tickMs, 1000)
chkInt('SOURCES_BOOT_DELAY_MS', config.sources.bootDelayMs, 0)
chkInt('SOURCES_SYNC_INTERVAL_MS', config.sources.defaultIntervalMs, 60000)
chkInt('SOURCES_FETCH_TIMEOUT_MS', config.sources.fetchTimeoutMs, 1000)
chkInt('SOURCES_MAX_BYTES', config.sources.maxBytes, 1024)
chkInt('SOURCES_MAX_CHANNELS', config.sources.maxChannels, 1)
chkInt('LIVENESS_INTERVAL_MINUTES', config.liveness.intervalMinutes, 0)
chkInt('LIVENESS_TIMEOUT_MS', config.liveness.timeoutMs, 1000)
chkInt('LIVENESS_FAILS_TO_FLIP', config.liveness.failsToFlip, 1)
chkInt('LIVENESS_BOOT_DELAY_MS', config.liveness.bootDelayMs, 0)
chkBootstrap('BOOTSTRAP', config.bootstrap)

// --- check-config dry-run (S49a) ---
// `node src/config.js --check` (the file run DIRECTLY, e.g. `docker compose run
// --rm panel node src/config.js --check`) reports the problem list on stdout and
// exits 0/1 instead of throwing. The MCP's server_set_env dry-runs a .env change
// in the built image this way BEFORE restarting — a bad knob otherwise throws at
// boot and the service stays down.
const checkRun = process.argv.includes('--check') && process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (checkRun) {
  if (problems.length) {
    process.stdout.write('panel: invalid configuration —\n  - ' + problems.join('\n  - ') + '\n')
    process.exit(1)
  }
  process.stdout.write('panel: configuration OK\n')
  process.exit(0)
}

if (problems.length) {
  throw new Error('panel: invalid configuration —\n  - ' + problems.join('\n  - '))
}

export default config
