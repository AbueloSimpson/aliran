// Broadcaster config (env-driven). Mirrors panel/src/config.js style.
import fs from 'fs'
import os from 'os'
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
  // Live window: 8 segments of ~2 s (≈16 s). Short segments cut time-to-first-frame
  // (the player prebuffers ~3 × HLS_TIME before playback); 8 still gives peers a real
  // shareable window for P2P re-seeding. The playlist is the source of truth and
  // everything that rotates out is reclaimed (see hls.js reclaimExpiredBlobs). Deepen
  // HLS_LIST_SIZE (12–16) for large swarms — see docs/kb/feed-buffer.md.
  hls: { time: int(process.env.HLS_TIME, 2), listSize: int(process.env.HLS_LIST_SIZE, 8) },
  // Feed buffer mode. 'disk' (default) = persistent feed identity: the feedKey and its
  // DHT topic stay STABLE across restarts, so returning viewers rejoin a warm topic and
  // resume their on-disk replica — much faster time-to-play and healthier P2P. 'ram' =
  // ephemeral session feeds (fresh feedKey per start, segment data only ever in memory)
  // for hosts that must keep the disk byte-flat. Both stay window-bounded via reclaim.
  // See docs/kb/feed-buffer.md.
  feedBuffer: process.env.FEED_BUFFER === 'ram' ? 'ram' : 'disk',
  // Scratch dir where ffmpeg writes the live HLS window before the mirror copies it into
  // the feed. Defaults to the OS temp dir (disk-backed in a container). Point HLS_WORK_DIR
  // at a tmpfs mount to keep the per-segment write churn off disk — essential at high
  // channel density (see docs/kb/scaling.md). Pair with FEED_BUFFER=ram to take the
  // Hypercore off disk too = zero segment IOPS on disk (the "scale profile").
  workDir: process.env.HLS_WORK_DIR || os.tmpdir(),
  protection: process.env.PROTECTION || 'self',
  // Optional per-channel swarm connection budget (S20a). Every channel owns its OWN
  // Hyperswarm, so this caps EACH channel's fan-out separately (hyperswarm's default of
  // 64 is also per channel). Raise it on a big origin box; lower it to push fan-out onto
  // repeater/seed nodes (S20). Unset = hyperswarm default, no accept gate. If set, leave
  // headroom for non-viewer peers (repeaters, the panel's blobsKey probe) — they take a
  // slot like any viewer.
  swarmMaxPeers: int(process.env.SWARM_MAX_PEERS, 0) || null,
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
