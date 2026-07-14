// Broadcaster config (env-driven). Mirrors panel/src/config.js style.
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

export const config = {
  dataDir: process.env.DATA_DIR || './data',
  panelPubKey: process.env.PANEL_PUBKEY || null,
  publisherKey: process.env.PUBLISHER_KEY || null,
  streamId: process.env.STREAM_ID || 'default',
  title: process.env.TITLE || null,
  category: process.env.CATEGORY || null,
  input: process.env.INPUT || 'rtmp',
  rtmpPort: int(process.env.RTMP_PORT, 1935),
  hls: { time: int(process.env.HLS_TIME, 2), listSize: int(process.env.HLS_LIST_SIZE, 6) },
  protection: process.env.PROTECTION || 'self',
  bootstrap: (process.env.BOOTSTRAP || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  control: {
    enabled: bool(process.env.CONTROL_ENABLED, false),
    // Loopback by default; 0.0.0.0 only behind a TLS reverse proxy.
    host: process.env.CONTROL_HOST || '127.0.0.1',
    port: int(process.env.CONTROL_PORT, 3310),
    sessionTtlHours: int(process.env.CONTROL_SESSION_TTL_HOURS, 12)
  },
  lockout: {
    threshold: int(process.env.LOCKOUT_THRESHOLD, 10),
    seconds: int(process.env.LOCKOUT_SECONDS, 900)
  },
  // Argon2id cost for control-admin passwords (interactive-grade defaults).
  argon2: {
    memKiB: int(process.env.ARGON2_MEM_KIB, 65536),
    time: int(process.env.ARGON2_TIME, 2)
  }
}

export default config
