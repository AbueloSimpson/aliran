// One-shot VOD ingest (S8a): ffprobe the input → ffmpeg it into an HLS **VOD** rendition
// (#EXT-X-PLAYLIST-TYPE:VOD — the playlist keeps EVERY segment and ends with
// #EXT-X-ENDLIST) → import the files into the title's encrypted Hyperdrive.
//
// This is deliberately NOT the broadcaster's hls.js: a live channel is a rolling window
// with a mirror loop, reclaim and a watchdog; a title is a one-shot burst that ends.
// The only lifecycle here is "the job finishes or it fails" — plus one bound (a stall
// kill) so a wedged input can never park the ingest queue forever.
//
//   probe    — ffprobe -print_format json: duration + codecs. An input without a FINITE
//              duration is refused up front: pointing the library at a live stream would
//              transcode forever and fill the disk (titles keep all segments by design).
//   convert  — `-c copy` remux when the codecs are already HLS/mpegts-compatible
//              (h264/hevc video, aac/mp3/ac3/eac3 audio), else transcode h264/aac.
//              mode 'auto' picks; 'copy'/'transcode' force. Transcodes cut keyframes on
//              hlsTime boundaries (force_key_frames) so segments are cleanly aligned;
//              remuxes split on the source's own keyframes (EXTINF varies — still VOD-valid).
//   import   — segments first (in order), playlist LAST, so a replicated playlist never
//              references a file the drive doesn't hold yet. All segments are kept:
//              disk = title size, reclaimed only by delete-title.
//
// ffmpeg/ffprobe must be on PATH (same contract as the broadcaster).

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import b4a from 'b4a'

// Codecs an mpegts HLS remux can carry as-is. Anything else transcodes.
const COPY_VIDEO = new Set(['h264', 'hevc'])
const COPY_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3'])

// How long ffmpeg may go with ZERO stderr output before the job is killed as stalled.
// A working ffmpeg emits progress lines continuously (several per second); silence this
// long means a wedged input (a URL that connected then hung), and with ingest
// concurrency 1 a wedged job would otherwise block every queued title forever.
export const INGEST_STALL_MS = 120000

function run (cmd, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs)
    proc.stdout.on('data', (d) => { if (out.length < 1048576) out += d })
    proc.stderr.on('data', (d) => { if (err.length < 65536) err += d })
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err, spawnError: e }) })
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err }) })
  })
}

// Probe an input ffmpeg can read (local path or URL). Returns
// { durationSec, video: {codec,width,height} | null, audio: {codec} | null }.
// Throws with an operator-actionable message on anything unusable.
export async function probeInput (input) {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], { timeoutMs: 30000 })
  if (r.spawnError) throw new Error('ffprobe not found on PATH — install ffmpeg (the library needs ffmpeg + ffprobe)')
  if (!r.ok) {
    const line = String(r.err).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
    throw new Error(`input is not readable: ${line || 'ffprobe failed'}`)
  }
  let j
  try { j = JSON.parse(r.out) } catch { throw new Error('ffprobe produced no parseable output for the input') }
  const durationSec = Number(j.format && j.format.duration)
  // A title is a FILE: an input with no finite duration (a live stream, a device) would
  // transcode forever and fill the disk. Refuse it here, before any work starts.
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('input has no finite duration — the library ingests FILES (for live sources, use the broadcaster)')
  }
  const streams = j.streams || []
  const v = streams.find((s) => s.codec_type === 'video')
  const a = streams.find((s) => s.codec_type === 'audio')
  if (!v) throw new Error('input has no video stream')
  return {
    durationSec,
    video: { codec: v.codec_name, width: v.width, height: v.height },
    audio: a ? { codec: a.codec_name } : null
  }
}

// Does this probe qualify for a `-c copy` remux?
export function copyCompatible (probe) {
  if (!probe.video || !COPY_VIDEO.has(probe.video.codec)) return false
  if (probe.audio && !COPY_AUDIO.has(probe.audio.codec)) return false
  return true
}

// ffmpeg argv for the VOD conversion (exported pure so tests can assert it).
// mode: 'copy' | 'transcode'. hls_list_size is irrelevant under playlist_type vod
// (every segment stays listed); -hls_flags independent_segments marks each segment
// decodable on its own — what lets a player seek straight to any of them.
export function vodArgs ({ input, mode, hlsTime, outDir }) {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', input]
  if (mode === 'copy') {
    args.push('-c', 'copy')
  } else {
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      // Keyframes exactly on segment boundaries → equal-length, cleanly seekable segments.
      '-force_key_frames', `expr:gte(t,n_forced*${hlsTime})`,
      '-c:a', 'aac', '-b:a', '128k'
    )
  }
  args.push(
    '-f', 'hls',
    '-hls_time', String(hlsTime),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(outDir, 'seg%05d.ts'),
    path.join(outDir, 'index.m3u8')
  )
  return args
}

// Parse ffmpeg's stderr progress ("time=00:01:23.45") into seconds, or null.
export function parseProgressSeconds (line) {
  const m = /time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(line)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

// Run the conversion. onProgress(pct 0..1) from stderr time= vs the probed duration;
// onLine(line) feeds the title's log ring. Resolves when ffmpeg exits 0; rejects with
// the most diagnostic stderr line otherwise. Kills a silent (stalled) ffmpeg.
export function convertToVod ({ input, mode, hlsTime, outDir, onProgress, onLine, stallMs = INGEST_STALL_MS }) {
  fs.mkdirSync(outDir, { recursive: true })
  const args = vodArgs({ input, mode, hlsTime, outDir })
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let lastLine = ''
    let lastOutput = Date.now()
    let pending = ''
    const stall = setInterval(() => {
      if (Date.now() - lastOutput > stallMs) {
        clearInterval(stall)
        try { proc.kill('SIGKILL') } catch {}
      }
    }, 5000)
    if (stall.unref) stall.unref()
    proc.stderr.on('data', (chunk) => {
      lastOutput = Date.now()
      pending += chunk
      // ffmpeg progress uses \r rewrites; split on both.
      const lines = pending.split(/\r\n|\r|\n/)
      pending = lines.pop()
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        lastLine = line
        if (onLine) onLine(line)
        const sec = parseProgressSeconds(line)
        if (sec !== null && onProgress) onProgress(sec)
      }
    })
    proc.on('error', (e) => {
      clearInterval(stall)
      reject(e.code === 'ENOENT' ? new Error('ffmpeg not found on PATH — install ffmpeg (the library needs ffmpeg + ffprobe)') : e)
    })
    proc.on('exit', (code) => {
      clearInterval(stall)
      if (code === 0) return resolve()
      if (Date.now() - lastOutput > stallMs) return reject(new Error(`ingest stalled (no ffmpeg output for ${Math.round(stallMs / 1000)}s) — killed`))
      reject(new Error(`ffmpeg exited ${code}: ${lastLine || 'no diagnostic output'}`))
    })
  })
}

// Import the finished rendition into the (fresh, empty) encrypted drive: every segment
// in order, the playlist LAST. Returns { segments, bytes } for the registry.
export async function importIntoDrive (outDir, drive, { onProgress } = {}) {
  const names = fs.readdirSync(outDir)
  const segs = names.filter((n) => /^seg\d+\.ts$/.test(n)).sort()
  if (!segs.length) throw new Error('conversion produced no segments')
  if (!names.includes('index.m3u8')) throw new Error('conversion produced no playlist')
  let bytes = 0
  for (let i = 0; i < segs.length; i++) {
    const buf = fs.readFileSync(path.join(outDir, segs[i]))
    bytes += buf.length
    await drive.put('/' + segs[i], buf)
    if (onProgress) onProgress((i + 1) / (segs.length + 1))
  }
  const playlist = fs.readFileSync(path.join(outDir, 'index.m3u8'))
  if (!/#EXT-X-ENDLIST/m.test(b4a.toString(playlist))) throw new Error('playlist is not a finished VOD (missing #EXT-X-ENDLIST)')
  await drive.put('/index.m3u8', playlist)
  if (onProgress) onProgress(1)
  return { segments: segs.length, bytes: bytes + playlist.length }
}
