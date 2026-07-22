// Library config (env-driven). Mirrors broadcaster/src/config.js style.
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
// An "MB" env knob in bytes. Garbage or a negative value disables that direction rather
// than throwing — socket tuning must never be the reason the library fails to boot.
const mib = (v, d) => { const n = int(v, d); return Number.isFinite(n) && n > 0 ? n * 1048576 : 0 }

export const config = {
  dataDir: process.env.DATA_DIR || './data',
  panelPubKey: process.env.PANEL_PUBKEY || null,
  publisherKey: process.env.PUBLISHER_KEY || null,
  // Enrolled publisher identity (S26). The library should ALWAYS run as its own named
  // publisher (e.g. `library1`), scoped to its title ids — it is a separate deployable
  // with its own trust boundary, and must not share the live fleet's key. Unset falls
  // back to the legacy shared key only while the panel still accepts it.
  publisherName: process.env.PUBLISHER_NAME || null,
  // VOD HLS segmentation. Titles keep ALL segments (#EXT-X-PLAYLIST-TYPE:VOD), so this
  // only sets segment granularity: shorter = finer seek/demand-paging, more per-request
  // overhead. Per-title override via the control API (`hlsTime`).
  hls: { time: int(process.env.HLS_TIME, 4) },
  // How many ingest jobs run CONCURRENTLY. An ingest is a one-shot ffmpeg burst —
  // a remux (`-c copy`) is cheap but a transcode eats 0.5-1 core — so the default is
  // strictly one at a time; queued jobs wait. Raise only on a box with spare cores.
  ingestConcurrency: int(process.env.INGEST_CONCURRENCY, 1),
  // Swarm connection budget. A library exists to seed titles to viewers (and repeater-
  // style mirrors), so the default is high like the repeater's — ONE swarm carries
  // every title on this box.
  swarmMaxPeers: int(process.env.SWARM_MAX_PEERS, 256),
  // Swarm UDP socket buffers, in MB (0 = leave that direction alone). Same rationale as
  // the repeater's 4/4 defaults: UDX carries every peer stream over one socket pair, and
  // a seeder's send buffer is the first thing to overflow under fan-out — silently. The
  // host must permit it via net.core.{r,w}mem_max (deploy/sysctl/99-aliran.conf) or the
  // request is clamped; a startup warning names the exact sysctl. See core/net-tune.js.
  swarmRcvBuf: mib(process.env.SWARM_RCVBUF_MB, 4),
  swarmSndBuf: mib(process.env.SWARM_SNDBUF_MB, 4),
  bootstrap: (process.env.BOOTSTRAP || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  control: {
    enabled: bool(process.env.CONTROL_ENABLED, false),
    // Loopback by default; 0.0.0.0 only behind a TLS reverse proxy.
    host: process.env.CONTROL_HOST || '127.0.0.1',
    port: int(process.env.CONTROL_PORT, 3320),
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
