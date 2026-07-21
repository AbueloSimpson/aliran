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
// An "MB" env knob in bytes. Garbage or a negative value disables that direction rather
// than throwing — socket tuning must never be the reason a broadcaster fails to boot.
const mib = (v, d) => { const n = int(v, d); return Number.isFinite(n) && n > 0 ? n * 1048576 : 0 }

export const config = {
  dataDir: process.env.DATA_DIR || './data',
  panelPubKey: process.env.PANEL_PUBKEY || null,
  publisherKey: process.env.PUBLISHER_KEY || null,
  // Enrolled publisher identity (S26). When set, every register payload carries
  // `publisher:<name>` and the panel verifies it against THAT enrollment's key +
  // channel scopes (`admin-cli add-publisher` prints the matching PUBLISHER_KEY).
  // Unset = legacy shared publisher key from `admin-cli init` (implicit scope *).
  publisherName: process.env.PUBLISHER_NAME || null,
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
  // Periodic feed rotation (disk mode). A disk feed's Corestore is append-only: blob
  // clear() reclaims rotated SEGMENT data (O(window)), but the merkle TREE/metadata is
  // never freed and grows for the feed's whole lifetime (~a couple MB/h per channel).
  // Rotating the feed mints a fresh generation (like a source change) and purges the
  // retired generation's cores, resetting that growth. Viewers follow the new feedKey
  // live over the catalog (no re-login). The cost is a one-time cold DHT topic for
  // viewers returning across the rotation, so keep it INFREQUENT to preserve disk mode's
  // warm-topic benefit. 0 disables (the default — orphan-namespace GC still runs at
  // start; enable this for multi-week 24/7 channels). See docs/kb/feed-buffer.md.
  feedRotate: {
    hours: int(process.env.FEED_ROTATE_HOURS, 0), // rotate a running feed every N hours (0 = off)
    treeMb: int(process.env.FEED_ROTATE_TREE_MB, 0), // ...or once its merkle tree exceeds N MB (0 = off)
    graceMs: int(process.env.FEED_ROTATE_GRACE_MS, 30000) // keep the retired feed serving+announced this long
  },
  // Global entry budget for the per-feed Hyperbee caches (decoded nodes + keys), shared
  // across ALL channels' cores. Unbounded, these grow with every metadata append (~1.5 KB
  // per entry, one entry per append) — the long-uptime RSS leak. 8192 entries ≈ 10-15 MB
  // ceiling and is plenty of working set for 15+ channels; raise it only on a big box.
  feedCacheMax: int(process.env.FEED_CACHE_MAX, 8192),
  // Recycle a channel's RUNNING ffmpeg once its memory (VmRSS+VmSwap from /proc) crosses
  // this cap (MB). Long-running live-HLS pulls slowly accumulate demuxer state on some
  // upstreams (SSAI ad insertion; observed ~100+ MB after days vs the 13–30 MB a fresh one
  // uses) and no ffmpeg input flag bounds it — the S15b watchdog treats the cap like a
  // stalled edge: same backoff/marker machinery, no feed rotation, sub-window viewer blip.
  // 0 disables. Linux-only (/proc); harmlessly inert elsewhere.
  ffmpegMaxRssMb: int(process.env.FFMPEG_MAX_RSS_MB, 150),
  // Offline slate: loop pre-rendered "SOURCE OFFLINE" media when a source is dead, so the
  // channel stays live with a clear message instead of going blank in watchdog backoff.
  // The slate is remuxed with -c copy, so a slated channel costs ~0 CPU and `copy` channels
  // (which have no encoder settings at all) can slate too — see docs/kb/offline-slate.md.
  //   after   — consecutive failed respawns, on the LAST source in the list, before slating.
  //             The url-failover mechanism runs first: with fallbacks configured a channel
  //             works through every url before it gives up and shows bars.
  //   retryMs — a looped file never exits, so nothing would ever re-probe the real source.
  //             The watchdog kills the slate this often to go back and try it again, and this
  //             is ALSO the worst-case extra time a channel keeps showing bars AFTER its source
  //             is already back. Lower = recovery is noticed sooner; higher = the bars glitch
  //             less often during a long outage (each probe restarts ffmpeg = one playlist
  //             discontinuity, and a hung source can hold ~20 s of dead air per probe before
  //             the watchdog gives up). Default 30 s balances the two. Operators who value
  //             smoother bars over fast recovery can raise it (e.g. SLATE_RETRY_MS=60000);
  //             going much below ~20 s is discouraged — it approaches the stall grace, so you
  //             mostly buy glitchier bars. Tunable with no image rebuild: set it in
  //             broadcaster/.env and recreate the container.
  //   dir     — where the rendered .ts files live. Baked into the image at build time by
  //             tools/render-slates.sh; override to serve them off the data volume instead.
  slate: {
    enabled: bool(process.env.SLATE_ENABLED, true),
    dir: process.env.SLATE_DIR || path.join(__dirname, '..', 'slate'),
    after: int(process.env.SLATE_AFTER, 3),
    retryMs: int(process.env.SLATE_RETRY_MS, 30000)
  },
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
  // Swarm UDP socket buffers, in MB (0 = leave that direction alone). UDX carries EVERY
  // peer stream of a swarm over one socket pair, so under fan-out the socket buffer is
  // what overflows first — and an overflow is a silent kernel-side packet drop, not an
  // error. udx already raises recv to 1 MiB but leaves SEND at the OS default (~208 KiB),
  // which is the direction a broadcaster actually uses. See core/net-tune.js; the host
  // must allow it via net.core.{r,w}mem_max (deploy/sysctl/99-aliran.conf) or the request
  // is silently clamped — the broadcaster logs a warning naming the exact sysctl.
  swarmRcvBuf: mib(process.env.SWARM_RCVBUF_MB, 2),
  swarmSndBuf: mib(process.env.SWARM_SNDBUF_MB, 2),
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
