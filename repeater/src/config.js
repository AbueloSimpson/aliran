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
  bootstrap: (process.env.BOOTSTRAP || '')
    .split(',').map(s => s.trim()).filter(Boolean)
}

export default config
