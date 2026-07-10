// ffmpeg → live HLS → mirror the rolling window into a Hyperdrive.
//
// v0.1 uses MPEG-TS segments (index.m3u8 + segN.ts): simple, universally playable, no
// separate init file to track. CMAF/fMP4 (for DRM) comes later.

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

// Build the ffmpeg argument list for the configured input.
export function ffmpegArgs (config, outDir) {
  const input = config.input === 'test'
    // Self-contained test source (no external input needed) — colour bars + tone.
    ? ['-re', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30`,
       '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']
    // A real source: RTSP/HLS URL or a local file (looped).
    : ['-re', ...(isFile(config.input) ? ['-stream_loop', '-1'] : []), '-i', config.input]

  return [
    ...input,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', String(config.hls.time),
    '-hls_list_size', String(config.hls.listSize),
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(outDir, 'seg%d.ts'),
    path.join(outDir, 'index.m3u8')
  ]
}

function isFile (input) {
  return !/^[a-z]+:\/\//i.test(input) && input !== 'test'
}

// Spawn ffmpeg. Returns the child process. ffmpeg must be on PATH.
export function startFfmpeg (config, outDir, { onExit } = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const args = ffmpegArgs(config, outDir)
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  proc.stderr.on('data', () => {}) // ffmpeg is chatty on stderr; ignore unless debugging
  proc.on('exit', (code) => { if (onExit) onExit(code) })
  proc.on('error', (err) => {
    if (err.code === 'ENOENT') console.error('ffmpeg not found on PATH. Install it and retry.')
    else console.error('ffmpeg error:', err.message)
  })
  return proc
}

// Poll a directory and mirror changes into a Hyperdrive: put new/changed files,
// delete files ffmpeg has rotated out. Returns a stop() function.
export function mirrorDirToDrive (dir, drive, { interval = 500 } = {}) {
  const known = new Map() // name -> mtimeMs|size signature
  let stopped = false

  async function tick () {
    if (stopped) return
    let names = []
    try { names = fs.readdirSync(dir) } catch { /* dir not ready yet */ }

    const present = new Set(names)
    // Put new or changed files.
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(dir, name))
        const sig = `${st.mtimeMs}:${st.size}`
        if (known.get(name) !== sig) {
          const buf = fs.readFileSync(path.join(dir, name))
          await drive.put('/' + name, buf)
          known.set(name, sig)
        }
      } catch { /* file may vanish mid-cycle (ffmpeg rotation); skip */ }
    }
    // Delete files ffmpeg removed from the rolling window.
    for (const name of [...known.keys()]) {
      if (!present.has(name)) {
        try { await drive.del('/' + name) } catch {}
        known.delete(name)
      }
    }
    if (!stopped) setTimeout(tick, interval)
  }

  tick()
  return () => { stopped = true }
}
