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
  relayOnly: bool(process.env.RELAY_ONLY, false),
  argon2: {
    memKiB: int(process.env.ARGON2_MEM_KIB, 262144),
    time: int(process.env.ARGON2_TIME, 3)
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
    sessionTtlHours: int(process.env.ADMIN_SESSION_TTL_HOURS, 12)
  },
  // Remote channel sources (S27): provider JSON feeds pulled on a schedule.
  sources: {
    tickMs: int(process.env.SOURCES_TICK_MS, 3600000), // registry scan cadence (due-check, not fetch)
    bootDelayMs: int(process.env.SOURCES_BOOT_DELAY_MS, 15000),
    defaultIntervalMs: int(process.env.SOURCES_SYNC_INTERVAL_MS, 86400000), // daily pull per source
    fetchTimeoutMs: int(process.env.SOURCES_FETCH_TIMEOUT_MS, 30000),
    maxBytes: int(process.env.SOURCES_MAX_BYTES, 5242880),
    maxChannels: int(process.env.SOURCES_MAX_CHANNELS, 500)
  }
}

export default config
