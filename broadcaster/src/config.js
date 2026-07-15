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
  // Display-only host for push URLs shown to operators (rtmp://<publicHost>:<port>/…).
  // Never used for binding — listeners bind 0.0.0.0.
  publicHost: process.env.PUBLIC_HOST || null,
  // Port range for auto-allocated push-ingest listeners (rtmp/srt/udp inputs
  // created without an explicit port).
  ingest: {
    portBase: int(process.env.INGEST_PORT_BASE, 5000),
    portMax: int(process.env.INGEST_PORT_MAX, 5999)
  },
  // DRM render node for h264_vaapi (Linux only).
  vaapiDevice: process.env.VAAPI_DEVICE || '/dev/dri/renderD128',
  // Live window: 16 segments of ~4 s (≈64 s) — deep enough that peers hold a real
  // shareable window for P2P delivery; the playlist is the source of truth and
  // everything that rotates out is reclaimed (see hls.js reclaimExpiredBlobs).
  hls: { time: int(process.env.HLS_TIME, 4), listSize: int(process.env.HLS_LIST_SIZE, 16) },
  // 'ram' (default) = ephemeral session feeds — fresh feedKey per start, segment
  // data only ever in memory; 'disk' = persistent feed identity across restarts.
  feedBuffer: process.env.FEED_BUFFER === 'disk' ? 'disk' : 'ram',
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
