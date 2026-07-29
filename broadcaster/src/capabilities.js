// Probe what the host ffmpeg can ACTUALLY do (S15a). Run once per process and
// cached by the ChannelManager; start() consults it and refuses cleanly (no
// silent fallback) when a channel wants an unavailable protocol or encoder.
//
// Two layers, because "listed" only means compiled in:
//   1. parse `ffmpeg -protocols` / `-encoders` — what the build claims
//   2. deep-verify every listed h264 HW encoder by really encoding 8 test frames;
//      without the matching GPU/driver the encoder fails at open time.
//
// The CUDA decode path (hwDecode) gets the same deep verification, and needs it more than
// the encoders do: `-hwaccel cuda` never fails on its own — ffmpeg quietly substitutes the
// software decoder — so only running the WHOLE chain (cuvid → scale_cuda → nvenc) tells
// the truth about whether it works. Hence a real encoded sample rather than lavfi frames.

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export const HW_H264_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_amf']

function runCmd (cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs)
    proc.stdout.on('data', (d) => { if (out.length < 65536) out += d })
    proc.stderr.on('data', (d) => { if (err.length < 65536) err += d })
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err, spawnError: e }) })
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err }) })
  })
}

const runFfmpeg = (args, timeoutMs) => runCmd('ffmpeg', args, timeoutMs)

// The most diagnostic stderr line: the first that looks like an error (e.g.
// "Cannot load nvcuda.dll"), not the generic "[out#0] Nothing was written" tail.
function bestErrorLine (stderr) {
  const lines = String(stderr).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const hit = lines.find((l) => /error|cannot|failed|denied|invalid|no such|not found/i.test(l))
  return (hit || lines[lines.length - 1] || '').slice(0, 200)
}

// → { ffmpeg, version?, error?, protocols: {rtmp,rtmps,srt,udp,rtsp,http,https},
//     encoders: { libx264|h264_*: { listed, verified, error? } } }
export async function probeCapabilities ({ vaapiDevice = '/dev/dri/renderD128', timeoutMs = 10000 } = {}) {
  const ver = await runFfmpeg(['-version'], timeoutMs)
  if (ver.spawnError) {
    return { ffmpeg: false, error: 'ffmpeg not found on PATH', protocols: {}, encoders: {} }
  }
  const version = (ver.out.split(/\r?\n/)[0] || '').trim() || null

  // `-protocols` prints an "Input:" then an "Output:" section, one name per line.
  // Listeners (rtmp -listen / srt mode=listener / udp) are INPUT protocols here.
  const proto = await runFfmpeg(['-hide_banner', '-protocols'], timeoutMs)
  const inputProtos = new Set()
  let section = null
  for (const raw of proto.out.split(/\r?\n/)) {
    const line = raw.trim().toLowerCase()
    if (line === 'input:') { section = 'in'; continue }
    if (line === 'output:') { section = 'out'; continue }
    if (section === 'in' && /^[a-z0-9+._-]+$/.test(line)) inputProtos.add(line)
  }
  const protocols = {}
  for (const p of ['rtmp', 'rtmps', 'srt', 'udp', 'http', 'https']) protocols[p] = inputProtos.has(p)

  // RTSP is a DEMUXER in ffmpeg (it rides on tcp/udp), so it never shows up in
  // -protocols — look for it in -demuxers instead.
  const demux = await runFfmpeg(['-hide_banner', '-demuxers'], timeoutMs)
  protocols.rtsp = demux.out.split(/\r?\n/).some((l) => /^\s*D\s+rtsp(\s|,|$)/.test(l))

  const encList = await runFfmpeg(['-hide_banner', '-encoders'], timeoutMs)
  const listed = new Set()
  for (const line of encList.out.split(/\r?\n/)) {
    const m = line.match(/^\s*V\S{5}\s+(\S+)/) // " V....D h264_nvenc  NVIDIA ..."
    if (m) listed.add(m[1])
  }

  const encoders = {
    // Software encode: if it is compiled in, it works.
    libx264: { listed: listed.has('libx264'), verified: listed.has('libx264') }
  }
  await Promise.all(HW_H264_ENCODERS.map(async (name) => {
    if (!listed.has(name)) {
      encoders[name] = { listed: false, verified: false }
      return
    }
    const args = ['-v', 'error']
    if (name === 'h264_vaapi') args.push('-init_hw_device', `vaapi=va:${vaapiDevice}`, '-filter_hw_device', 'va')
    if (name === 'h264_qsv') args.push('-init_hw_device', 'qsv=qsv:hw')
    args.push('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-frames:v', '8')
    if (name === 'h264_vaapi') args.push('-vf', 'format=nv12,hwupload') // vaapi encodes GPU surfaces only
    args.push('-c:v', name, '-f', 'null', '-')
    const r = await runFfmpeg(args, timeoutMs)
    encoders[name] = r.ok
      ? { listed: true, verified: true }
      : { listed: true, verified: false, error: bestErrorLine(r.err) || 'probe encode failed' }
  }))

  const hwDecode = { cuda: await probeCudaDecode(encoders, listed, timeoutMs) }
  const gpus = listed.has('h264_nvenc') ? await probeGpus(timeoutMs) : []

  return { ffmpeg: true, version, protocols, encoders, hwDecode, gpus }
}

// Enumerate NVIDIA devices so the operator picks a GPU by NAME instead of guessing an
// index. Purely informational: nvidia-smi missing, failing, or printing something
// unexpected all degrade to [] — a host can transcode perfectly well without it, and the
// device index is validated independently of this list.
//
// Worth having because the realistic deployment is a SHARED box: when another service is
// already encoding on GPU0, "which card am I about to land on" is the operator's most
// important question and the index alone does not answer it.
async function probeGpus (timeoutMs) {
  const r = await runCmd('nvidia-smi', ['--query-gpu=index,name,memory.total', '--format=csv,noheader,nounits'], timeoutMs)
  if (!r.ok) return []
  const gpus = []
  for (const line of r.out.split(/\r?\n/)) {
    const parts = line.split(',').map((s) => s.trim())
    if (parts.length < 2) continue
    const index = parseInt(parts[0], 10)
    if (!Number.isInteger(index)) continue
    const memoryMb = parseInt(parts[2], 10)
    gpus.push({ index, name: parts[1].slice(0, 64), memoryMb: Number.isInteger(memoryMb) ? memoryMb : null })
  }
  return gpus
}

// Deep-verify decode→scale→encode entirely on the GPU, exactly as hls.js builds it.
//
// Two-step because lavfi cannot exercise a decoder: step 1 writes a real ~1 s H.264
// elementary stream to a temp file, step 2 decodes THAT with -hwaccel cuda and pushes the
// GPU frames through scale_cuda into nvenc. A host without CUVID fails at the filter,
// not the decoder (ffmpeg substitutes the software decoder without a word), which is why
// the probe cannot be a simple "-hwaccel cuda -f null -".
//
// Skipped entirely when nvenc did not verify — there is no CUDA path to take without it.
async function probeCudaDecode (encoders, listed, timeoutMs) {
  if (!encoders.h264_nvenc || !encoders.h264_nvenc.verified) {
    return { verified: false, error: 'h264_nvenc not usable on this host' }
  }
  const sample = path.join(os.tmpdir(), `aliran-cuda-probe-${process.pid}-${Date.now()}.h264`)
  try {
    // 640x360 keeps the sample comfortably above NVDEC's minimum raster.
    const mk = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
      '-frames:v', '30', '-c:v', listed.has('libx264') ? 'libx264' : 'h264_nvenc']
    if (listed.has('libx264')) mk.push('-preset', 'ultrafast')
    mk.push('-pix_fmt', 'yuv420p', '-f', 'h264', sample)
    const made = await runFfmpeg(mk, timeoutMs)
    if (!made.ok) return { verified: false, error: bestErrorLine(made.err) || 'could not build probe sample' }

    const r = await runFfmpeg(['-v', 'error', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
      '-i', sample, '-vf', 'scale_cuda=-2:180', '-c:v', 'h264_nvenc', '-frames:v', '10',
      '-f', 'null', '-'], timeoutMs)
    return r.ok ? { verified: true } : { verified: false, error: bestErrorLine(r.err) || 'cuda decode probe failed' }
  } finally {
    try { fs.unlinkSync(sample) } catch {}
  }
}
