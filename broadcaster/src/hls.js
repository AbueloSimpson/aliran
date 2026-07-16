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
        return /\.m3u8($|\?)/i.test(t.url) ? ['-i', t.url] : ['-re', '-i', t.url]
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

// Free the blob blocks of everything that has rotated OUT of the live window.
// Hypercore is append-only — drive.del() drops the metadata entry but the segment
// bytes stay stored forever (this is what filled a 19 GB disk in a day of streaming).
// The playlist window is strictly rolling, so every block BELOW the lowest offset
// still referenced by a live entry is garbage: clear() it. clear() only frees local
// storage (RAM or disk) — the merkle tree stays valid and replication of the live
// window is untouched; peers simply can't fetch expired segments any more, which is
// the point: the m3u8 defines what exists.
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

// Poll a directory and mirror changes into a Hyperdrive: put new/changed files,
// delete files ffmpeg has rotated out, and reclaim the expired blob storage so the
// feed is an EPHEMERAL rolling buffer instead of an ever-growing log.
// Returns a stop() function.
export function mirrorDirToDrive (dir, drive, { interval = 500 } = {}) {
  const known = new Map() // name -> mtimeMs|size signature
  let stopped = false

  async function tick () {
    if (stopped) return
    let names = []
    try { names = fs.readdirSync(dir) } catch { /* dir not ready yet */ }

    const present = new Set(names)
    let changed = false
    // Put new or changed files.
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(dir, name))
        const sig = `${st.mtimeMs}:${st.size}`
        if (known.get(name) !== sig) {
          const buf = fs.readFileSync(path.join(dir, name))
          await drive.put('/' + name, buf)
          known.set(name, sig)
          changed = true
        }
      } catch { /* file may vanish mid-cycle (ffmpeg rotation); skip */ }
    }
    // Delete files ffmpeg removed from the rolling window.
    for (const name of [...known.keys()]) {
      if (!present.has(name)) {
        try { await drive.del('/' + name) } catch {}
        known.delete(name)
        changed = true
      }
    }
    // Anything below the live window (rotated segments, superseded playlist
    // versions) is unreachable — free it. Keeps storage O(window).
    if (changed) { try { await reclaimExpiredBlobs(drive) } catch {} }
    if (!stopped) setTimeout(tick, interval)
  }

  tick()
  return () => { stopped = true }
}
