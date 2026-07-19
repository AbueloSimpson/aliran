// ffmpeg → live HLS → mirror the rolling window into a Hyperdrive.
//
// v0.1 uses MPEG-TS segments (index.m3u8 + segN.ts): simple, universally playable, no
// separate init file to track. CMAF/fMP4 (for DRM) comes later.
//
// S15a: typed inputs (test / file / pull URL / rtmp / srt / udp push listeners) and
// per-channel transcode settings (encoder incl. GPU, resolution/fps/bitrate/preset).
// Everything in this file is a pure argument builder (covered by tools/args-test.mjs);
// input/transcode objects are validated in channel.js before they reach us, and
// encoder/protocol AVAILABILITY is checked against capabilities.js at start().

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

export const TRANSCODE_DEFAULTS = {
  encoder: 'libx264',
  resolution: 'source',
  fps: 'source',
  videoBitrateKbps: null, // null = encoder default rate control (x264 CRF)
  audioBitrateKbps: 128,
  preset: 'fast'
}

const RES_HEIGHT = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 }

// fast/balanced/quality → per-encoder speed/quality flag. vaapi has no preset
// concept (rate control only); amf uses -quality and is the least battle-tested
// of the four hw paths (surface as EXPERIMENTAL in the UI).
const PRESET_FLAGS = {
  libx264: { flag: '-preset', fast: 'veryfast', balanced: 'medium', quality: 'slow' },
  h264_nvenc: { flag: '-preset', fast: 'p2', balanced: 'p4', quality: 'p6' },
  h264_qsv: { flag: '-preset', fast: 'veryfast', balanced: 'medium', quality: 'slow' },
  h264_amf: { flag: '-quality', fast: 'speed', balanced: 'balanced', quality: 'quality' }
}

// Minimal string→typed upgrade so pre-S15a callers (the older e2e harnesses) and
// any stray persisted string keep working. The full upgrade/validation (ports,
// stream keys, the 'rtmp' shorthand) lives in channel.js normalizeInput().
export function upgradeInputString (input) {
  if (typeof input !== 'string') return input
  if (input === 'test') return { kind: 'test' }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return { kind: 'pull', url: input }
  return { kind: 'file', path: input }
}

export function urlScheme (url) {
  const m = String(url).match(/^([a-z][a-z0-9+.-]*):\/\//i)
  return m ? m[1].toLowerCase() : null
}

// Input half of the command line (up to and including -i). -re paces file-backed
// sources to realtime; live sources (push listeners, rtsp/rtmp/srt/udp pulls and
// live HLS playlists) pace themselves — -re on those starves the reader and adds
// drift, so it is applied ONLY to test/file and plain-http VOD pulls.
export function inputArgs (input) {
  const t = upgradeInputString(input)
  switch (t.kind) {
    case 'test':
      // Self-contained test source — colour bars + tone.
      return ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']
    case 'file':
      return ['-re', '-stream_loop', '-1', '-i', t.path]
    case 'pull': {
      const scheme = urlScheme(t.url)
      if (scheme === 'rtsp') return ['-rtsp_transport', 'tcp', '-i', t.url]
      if (scheme === 'http' || scheme === 'https') {
        // A .m3u8 URL is a live playlist (the demuxer waits for new segments);
        // anything else over http(s) is a VOD file that needs realtime pacing.
        // -allowed_extensions ALL lets the HLS demuxer accept SSAI / ad-beacon segment URLs
        // that don't end in .ts (Amagi/DistroTV and many FAST channels) — without it ffmpeg
        // rejects the playlist ("not in allowed_segment_extensions"). It only RELAXES a filter,
        // so it's harmless for plain .ts feeds, and the operator already trusts the pull URL.
        return /\.m3u8($|\?)/i.test(t.url)
          ? ['-allowed_extensions', 'ALL', '-i', t.url]
          : ['-re', '-i', t.url]
      }
      return ['-i', t.url] // rtmp(s)/srt/udp pulls
    }
    case 'rtmp':
      // Single-client listener; ffmpeg exits when the publisher disconnects (the
      // S15b watchdog re-listens). The stream key is obscurity, not authentication —
      // the real controls are the firewall and SRT passphrases.
      return ['-listen', '1', '-f', 'flv', '-i', `rtmp://0.0.0.0:${t.port}/live/${t.streamKey}`]
    case 'srt': {
      // latency is microseconds on the wire; the passphrase IS enforced by the
      // libsrt handshake (this is the recommended authenticated push).
      let url = `srt://0.0.0.0:${t.port}?mode=listener&latency=${(t.latencyMs ?? 200) * 1000}`
      if (t.passphrase) url += `&passphrase=${t.passphrase}`
      return ['-i', url]
    }
    case 'udp':
      // timeout is microseconds; an idle source becomes an ffmpeg exit instead of
      // a silent hang, so the (S15b) watchdog can cycle the listener.
      return ['-i', `udp://0.0.0.0:${t.port}?fifo_size=5242880&overrun_nonfatal=1&timeout=${(t.timeoutMs ?? 10000) * 1000}`]
    default:
      throw new Error(`unknown input kind: ${t && t.kind}`)
  }
}

// Hardware-device bootstrap — global options, must precede -i.
export function hwDeviceArgs (encoder, vaapiDevice) {
  if (encoder === 'h264_vaapi') {
    return ['-init_hw_device', `vaapi=va:${vaapiDevice || '/dev/dri/renderD128'}`, '-filter_hw_device', 'va']
  }
  if (encoder === 'h264_qsv') return ['-init_hw_device', 'qsv=qsv:hw']
  return []
}

// Output-side codec options. `transcode` may be null/partial; defaults preserve
// pre-S15a behavior except -g 60 → -force_key_frames, which aligns keyframes to
// segment boundaries for every encoder regardless of source fps.
export function encodeArgs (transcode, hls) {
  const t = { ...TRANSCODE_DEFAULTS, ...(transcode || {}) }
  const out = []

  if (t.encoder === 'copy') {
    // Passthrough: segment cuts land on the SOURCE's keyframes — the publisher
    // must send a keyframe every hls.time seconds (OBS: keyframe interval).
    out.push('-c:v', 'copy')
  } else {
    out.push('-c:v', t.encoder)
    const preset = PRESET_FLAGS[t.encoder]
    if (preset) out.push(preset.flag, preset[t.preset])
    if (t.encoder === 'libx264') out.push('-tune', 'zerolatency', '-pix_fmt', 'yuv420p')
    if (t.encoder === 'h264_nvenc') out.push('-tune', 'll')
    out.push('-force_key_frames', `expr:gte(t,n_forced*${hls.time})`)
    if (t.videoBitrateKbps != null) {
      out.push('-b:v', `${t.videoBitrateKbps}k`, '-maxrate', `${t.videoBitrateKbps}k`, '-bufsize', `${t.videoBitrateKbps * 2}k`)
    }
    if (t.fps !== 'source') out.push('-r', String(t.fps))
    const filters = []
    const height = RES_HEIGHT[t.resolution]
    if (height) filters.push(`scale=-2:${height}`)
    if (t.encoder === 'h264_vaapi') filters.push('format=nv12', 'hwupload') // vaapi encodes GPU surfaces only
    if (filters.length) out.push('-vf', filters.join(','))
  }

  out.push('-c:a', 'aac', '-ar', '48000', '-b:a', `${t.audioBitrateKbps}k`)
  return out
}

export function hlsMuxArgs (hls, outDir) {
  return [
    '-f', 'hls',
    '-hls_time', String(hls.time),
    '-hls_list_size', String(hls.listSize),
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(outDir, 'seg%d.ts'),
    path.join(outDir, 'index.m3u8')
  ]
}

// Build the full ffmpeg argument list.
// spec = { input, transcode?, hls, vaapiDevice? } — input may be a typed object
// (see channel.js normalizeInput) or a legacy string.
export function ffmpegArgs (spec, outDir) {
  const encoder = (spec.transcode && spec.transcode.encoder) || TRANSCODE_DEFAULTS.encoder
  return [
    ...hwDeviceArgs(encoder, spec.vaapiDevice),
    ...inputArgs(spec.input),
    ...encodeArgs(spec.transcode, spec.hls),
    ...hlsMuxArgs(spec.hls, outDir)
  ]
}

// Split a byte stream into text lines and hand each to `onLine`. ffmpeg terminates real log
// lines (banner, stream info, warnings, errors) with \n but rewrites its periodic progress
// stats in place with a bare \r; we split on \r?\n so the diagnostics land as clean lines and
// a long progress rewrite that never sees a newline is flushed once it passes the length cap
// (embedded bare CRs are flattened) — bounded memory, no per-frame progress spam in the ring.
function lineSplitter (onLine, maxLen = 500) {
  let pending = ''
  const emit = (raw) => {
    const line = raw.replace(/\r/g, ' ').trimEnd()
    if (line) onLine(line.length > maxLen ? line.slice(0, maxLen) : line)
  }
  return {
    push (chunk) {
      pending += chunk.toString('utf8')
      let m
      while ((m = pending.match(/\r?\n/))) {
        emit(pending.slice(0, m.index))
        pending = pending.slice(m.index + m[0].length)
      }
      if (pending.length > maxLen) { emit(pending); pending = '' }
    },
    end () { if (pending) { emit(pending); pending = '' } }
  }
}

// Spawn ffmpeg. Returns the child process. ffmpeg must be on PATH. `onLine` (S15b) receives
// each stderr log line for the per-channel log ring; without it stderr is just drained.
export function startFfmpeg (spec, outDir, { onExit, onLine } = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const args = ffmpegArgs(spec, outDir)
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  if (onLine) {
    const split = lineSplitter(onLine)
    proc.stderr.on('data', (chunk) => split.push(chunk))
    proc.stderr.on('end', () => split.end())
  } else {
    proc.stderr.on('data', () => {}) // drain so ffmpeg never blocks on a full stderr pipe
  }
  proc.on('exit', (code) => { if (onExit) onExit(code) })
  proc.on('error', (err) => {
    if (err.code === 'ENOENT') console.error('ffmpeg not found on PATH. Install it and retry.')
    else console.error('ffmpeg error:', err.message)
  })
  return proc
}

// Free the blob blocks backing ONE drive entry. Hypercore is append-only — drive.del()
// drops the metadata entry but the segment bytes stay stored forever unless we clear()
// them. clear() only frees LOCAL storage (RAM buffers, or a disk hole-punch via
// random-access-file → fs-native-extensions) — the merkle tree stays valid, so live-window
// replication is untouched; peers simply can't fetch this now-expired segment, which is the
// point: the m3u8 defines what exists. blockLength 0 (dirs/symlinks) and a missing blobs
// core are no-ops.
export async function clearBlob (blobs, blob) {
  if (!blobs || !blob || !(blob.blockLength > 0)) return
  try { await blobs.core.clear(blob.blockOffset, blob.blockOffset + blob.blockLength) } catch {}
}

// Safety-net sweep: free every blob block BELOW the lowest offset still referenced by a
// live entry. This backs up the precise per-entry clears in mirrorDirToDrive (superseded
// playlist versions, anything a desync missed) and does the bulk reclaim of a backlog left
// by a previous run. NOTE: on its own this is NOT sufficient — a single stuck low entry (an
// orphaned segment a crash/respawn stranded in the disk core) pins `min` and leaks the whole
// history above it (this filled a 19 GB VPS disk in a day). Rotation-time clearing is what
// makes reclaim independent of that watermark; reconcileStaleEntries drops the orphan so this
// sweep can then bulk-free everything below the live edge.
export async function reclaimExpiredBlobs (drive) {
  const blobs = await drive.getBlobs()
  let min = blobs.core.length
  for await (const entry of drive.list('/')) {
    const b = entry.value && entry.value.blob
    if (b && b.blockOffset < min) min = b.blockOffset
  }
  if (min > 0) await blobs.core.clear(0, min)
  return min
}

// Drop every drive entry that isn't present in the output dir, freeing its blob. In disk
// mode the core is REOPENED on each start with the previous run's entries still in it, and a
// crash/respawn resets ffmpeg's seg%d counter — stranding the prior run's high-numbered
// segments as entries that never rotate out. Left in place, the lowest such orphan pins the
// reclaim watermark forever. Running this once at mirror start (against the fresh, near-empty
// outDir) clears that backlog so storage returns to O(window). Returns the number dropped.
export async function reconcileStaleEntries (dir, drive, blobs) {
  let present = new Set()
  try { present = new Set(fs.readdirSync(dir)) } catch { /* dir not ready yet */ }
  let dropped = 0
  for await (const entry of drive.list('/')) {
    const name = entry.key.replace(/^\//, '')
    if (present.has(name)) continue
    try {
      await drive.del(entry.key)
      await clearBlob(blobs, entry.value && entry.value.blob)
      dropped++
    } catch { /* entry may already be gone; skip */ }
  }
  return dropped
}

// Allocated bytes of every file under `dir` (st.blocks*512 where the FS reports it, else
// st.size). Used to report how much a namespace purge frees and to size a live feed's
// merkle tree. Best-effort — an unreadable/vanishing entry contributes 0.
function dirAllocBytes (dir) {
  let total = 0
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += dirAllocBytes(p)
    else { try { const st = fs.statSync(p); total += (st.blocks ? st.blocks * 512 : st.size) } catch {} }
  }
  return total
}

const DISCOVERY_HEX_RE = /^[0-9a-f]{64}$/

// hypercore/random-access error codes/messages that mean a core's ON-DISK state is
// UNREADABLE — an unclean broadcaster exit (SIGKILL, OOM, power loss, a `docker stop` that
// outran its grace period) can truncate a core's oplog/tree mid-write. This is NOT a
// transient error: the store will never reopen until it is rotated or wiped. Mirrors
// sdk/recover.js's CORRUPT_CODES (the broadcaster image doesn't vendor the sdk workspace, so
// the check is duplicated here) PLUS `EPARTIALREAD` / "Could not satisfy length" — the
// truncation error a killed store.close() leaves behind, which sdk/recover.js still misses.
const STORE_CORRUPT_CODES = new Set([
  'EPARTIALREAD', 'OPLOG_CORRUPT', 'OPLOG_HEADER_OVERFLOW', 'INVALID_OPLOG_VERSION', 'INVALID_CHECKSUM', 'DECODING_ERROR'
])
export function isStoreCorruption (err) {
  if (!err) return false
  if (STORE_CORRUPT_CODES.has(err.code)) return true
  return /corrupt|could not satisfy length/i.test(String(err.message || err))
}

// Whole-namespace GC — the metadata analog of reconcileStaleEntries (which drops stale
// ENTRIES within one namespace; this drops entire retired NAMESPACES).
//
// A disk-mode channel's Corestore accumulates the metadata+blobs cores of EVERY feed
// generation it has ever run: a source change (or a periodic rotation) bumps feedGen → a
// new Corestore namespace → brand-new cores, orphaning the previous generation's core
// directories on disk. blob clear() only reclaims the CURRENT feed's rotated segment DATA;
// a retired generation's cores — including their append-only merkle TREES, which clear()
// never touches — are dead weight that grows the store for the channel's whole lifetime.
//
// keepDiscoveryKeys = the hex discovery keys of the cores to KEEP (the current generation's
// metadata + blobs cores). Every other 64-hex core directory under <storeDir>/cores/ is a
// retired generation and is removed. Corestore lays cores out at
// cores/<id[0:2]>/<id[2:4]>/<id>/ (see getStorageRoot); we ONLY ever touch that tree —
// never the primary-key / feed.key files alongside it. Returns { removed, bytesFreed }.
//
// SAFETY: with an empty keep set this is a no-op — it refuses to delete cores it cannot
// positively account for, so a caller that fails to resolve the live discovery keys leaks
// (safe, retried next pass) rather than nuking the running feed. Only directories whose
// name is a full 64-char discovery key are ever considered, so stray files are left alone.
export function purgeStaleCores (storeDir, keepDiscoveryKeys) {
  const keep = keepDiscoveryKeys instanceof Set ? keepDiscoveryKeys : new Set(keepDiscoveryKeys || [])
  const out = { removed: 0, bytesFreed: 0 }
  if (keep.size < 1) return out // refuse to run without a positive keep set
  const coresDir = path.join(storeDir, 'cores')
  let l1 = []
  try { l1 = fs.readdirSync(coresDir, { withFileTypes: true }) } catch { return out }
  for (const a of l1) {
    if (!a.isDirectory()) continue
    const aDir = path.join(coresDir, a.name)
    let l2 = []
    try { l2 = fs.readdirSync(aDir, { withFileTypes: true }) } catch { continue }
    for (const b of l2) {
      if (!b.isDirectory()) continue
      const bDir = path.join(aDir, b.name)
      let leaves = []
      try { leaves = fs.readdirSync(bDir, { withFileTypes: true }) } catch { continue }
      for (const leaf of leaves) {
        if (!leaf.isDirectory() || !DISCOVERY_HEX_RE.test(leaf.name) || keep.has(leaf.name)) continue
        const leafDir = path.join(bDir, leaf.name)
        const bytes = dirAllocBytes(leafDir)
        try { fs.rmSync(leafDir, { recursive: true, force: true }); out.removed++; out.bytesFreed += bytes } catch {}
      }
    }
  }
  return out
}

// Allocated bytes of the append-only `tree` files for the given cores — the merkle
// metadata that blob reclaim does NOT free and that grows for a feed's whole lifetime.
// Drives the size-based feed-rotation trigger (FEED_ROTATE_TREE_MB). Only the current
// generation's cores are passed, so this is O(1) file stats, not a tree walk.
export function feedTreeBytes (storeDir, discoveryKeys) {
  const keys = discoveryKeys instanceof Set ? discoveryKeys : new Set(discoveryKeys || [])
  let total = 0
  for (const id of keys) {
    if (!DISCOVERY_HEX_RE.test(id)) continue
    const treePath = path.join(storeDir, 'cores', id.slice(0, 2), id.slice(2, 4), id, 'tree')
    try { const st = fs.statSync(treePath); total += (st.blocks ? st.blocks * 512 : st.size) } catch {}
  }
  return total
}

// Poll a directory and mirror changes into a Hyperdrive: put new/changed files, delete files
// ffmpeg has rotated out, and free each blob's blocks AS IT ROTATES so the feed is an
// EPHEMERAL rolling buffer (O(window) storage) instead of an ever-growing log. Clearing at
// rotation time — rather than only sweeping below a global watermark — is deliberate: it
// keeps reclaim working even when a stuck low entry would otherwise pin the watermark and
// leak the whole history above it. Returns a stop() function.
export function mirrorDirToDrive (dir, drive, { interval = 500 } = {}) {
  const known = new Map() // name -> mtimeMs:size signature
  let stopped = false
  let blobs = null

  async function tick () {
    if (stopped) return
    let names = []
    try { names = fs.readdirSync(dir) } catch { /* dir not ready yet */ }

    const present = new Set(names)
    let changed = false
    // Put new or changed files. A CHANGED file (e.g. index.m3u8, rewritten every segment)
    // supersedes its previous blob — free the old blocks so re-puts don't accumulate.
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(dir, name))
        const sig = `${st.mtimeMs}:${st.size}`
        if (known.get(name) !== sig) {
          const p = '/' + name
          const prev = known.has(name) ? await drive.entry(p) : null
          const buf = fs.readFileSync(path.join(dir, name))
          await drive.put(p, buf)
          known.set(name, sig)
          if (prev) await clearBlob(blobs, prev.value && prev.value.blob)
          changed = true
        }
      } catch { /* file may vanish mid-cycle (ffmpeg rotation); skip */ }
    }
    // Delete files ffmpeg removed from the rolling window, freeing each blob as it goes.
    for (const name of [...known.keys()]) {
      if (!present.has(name)) {
        const p = '/' + name
        try {
          const e = await drive.entry(p)
          await drive.del(p)
          await clearBlob(blobs, e && e.value && e.value.blob)
        } catch {}
        known.delete(name)
        changed = true
      }
    }
    // Safety net below the live window (see reclaimExpiredBlobs). The per-entry clears above
    // already free the churn; this catches superseded remnants and any desync.
    if (changed) { try { await reclaimExpiredBlobs(drive) } catch {} }
    if (!stopped) setTimeout(tick, interval)
  }

  // Resolve the blobs core and drop any prior-run backlog BEFORE the first tick, so an
  // orphaned segment persisted in the disk core can't pin reclaim (see reconcileStaleEntries).
  async function boot () {
    try {
      blobs = await drive.getBlobs()
      if (stopped) return
      await reconcileStaleEntries(dir, drive, blobs)
      if (stopped) return
      try { await reclaimExpiredBlobs(drive) } catch {}
    } catch { /* drive not ready/closed; tick still mirrors, clears become no-ops until set */ }
    if (!stopped) tick()
  }

  boot()
  return () => { stopped = true }
}
